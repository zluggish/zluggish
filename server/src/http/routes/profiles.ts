import { profileUpdateSchema } from '#src/dtos/profiles.dto';
import { importFilenameSchema } from '#src/dtos/profile-import.dto';
import { parseProtobuf } from '#src/http/protobuf';
import { authenticated, csrf, page } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import { PlayerProfileSchema, ProfileEntitlementsSchema } from '#src/protocol/generated/profile_pb';
import type { ImportFiles } from '#src/dtos/profile-import.dto';
import { create, toBinary } from '@bufbuild/protobuf';
import type { Context, Hono } from 'hono';
import { html } from 'hono/html';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { z } from 'zod';

export function profileRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const imports = runtime.services.imports;
  imports.recover();

  app.on(['GET', 'POST'], '/profile/:username/', async (c) => {
    const rider = authenticated(c);

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);
      const files: ImportFiles = {};

      for (const name of importFilenameSchema.options) {
        const upload = form[name];

        if (!(upload instanceof File && upload.name)) continue;

        const key = importFilenameSchema.parse(name);

        files[key] = new Uint8Array(await upload.arrayBuffer());
      }

      const stage = imports.prepare(rider, files);
      const browser = c.get('browser');

      if (browser.pendingImport) imports.cancel(rider, browser.pendingImport);

      browser.pendingImport = stage;

      return c.redirect(`/profile/${rider.username}/confirm/`);
    }

    return c.html(
      page(
        'Import profile data',
        html`<p>Your local rider ID and password remain unchanged.</p>
          <p><a href="/zwift/${rider.username}/">Download from Zwift or manage connection</a></p>
          <form method="post" enctype="multipart/form-data">
            <input type="hidden" name="csrf_token" value="${c.get('browser').csrf}" /><input
              type="hidden"
              name="source"
              value="files"
            /><label>Profile<input type="file" name="profile.bin" /></label
            ><label>Achievements<input type="file" name="achievements.bin" /></label
            ><label>Economy<input type="file" name="economy_config.txt" /></label
            ><label>Game storage<input type="file" name="user_storage.bin" /></label
            ><label>Streaks<input type="file" name="streaks.bin" /></label><button>Review import</button>
          </form>`,
      ),
    );
  });

  app.on(['GET', 'POST'], '/profile/:username/confirm/', async (c) => {
    const rider = authenticated(c);
    const stage = c.get('browser').pendingImport;

    if (!stage) return c.redirect(`/profile/${rider.username}/`);
    const manifest = imports.inspect(rider, stage);

    const duplicate =
      manifest.sourceId &&
      runtime.services.accounts
        .list()
        .some((user) => user.player_id !== rider.player_id && user.official_player_id === manifest.sourceId);

    const mixed = !manifest.sourceId || (rider.official_player_id && rider.official_player_id !== manifest.sourceId);

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);

      if (form.cancel) imports.cancel(rider, stage);
      else {
        if (!form.confirm || ((duplicate || mixed) && !form.confirm_source)) throw new HTTPException(400);

        imports.publish(rider, stage, form.keep_name === 'on');
      }

      c.get('browser').pendingImport = null;

      return c.redirect(`/user/${rider.username}/`);
    }

    return c.html(
      page(
        'Confirm profile import',
        html`<p>${manifest.firstName} ${manifest.lastName} (${manifest.sourceId ?? 'unknown source'})</p>
          <p>Replace: ${manifest.files.join(', ')}</p>
          <form method="post">
            <input type="hidden" name="csrf_token" value="${c.get('browser').csrf}" />${duplicate || mixed
              ? html`<label
                  ><input type="checkbox" name="confirm_source" required />Confirm this source may differ or be shared
                  with another rider</label
                >`
              : ''}<label><input type="checkbox" name="keep_name" />Keep local name</label
            ><button name="confirm" value="1">Confirm import</button><button name="cancel" value="1">Cancel</button>
          </form>`,
      ),
    );
  });

  function profileResponse(c: Context<RuntimeEnv>, id: number) {
    const profile = runtime.services.profiles.entitlements(runtime.services.profiles.get(id));

    return c.req.header('Accept')?.includes('application/json')
      ? c.json(runtime.services.profiles.companionProfile(profile, avatar(id)))
      : c.body(toBinary(PlayerProfileSchema, profile));
  }

  function avatar(id: number) {
    return runtime.services.files.exists(resolve(runtime.services.profiles.folder(id), 'avatarLarge.jpg'))
      ? `https://us-or-rly101.zwift.com/download/${id}/avatarLarge.jpg`
      : null;
  }

  app.on('GET', ['/api/profiles/me', '/api/profiles/me/'], (c) => profileResponse(c, authenticated(c).player_id));
  app.get('/api/profiles/me/entitlements', (c) => {
    const user = authenticated(c);
    const profile = runtime.services.profiles.entitlements(runtime.services.profiles.get(user.player_id));

    return c.body(
      toBinary(
        ProfileEntitlementsSchema,
        create(ProfileEntitlementsSchema, {
          entitlements: profile.entitlements,
        }),
      ),
    );
  });
  app.get('/api/profiles/:id', (c) => {
    const viewer = authenticated(c);

    const id = z.coerce.number().int().positive().safe().parse(c.req.param('id'));

    if (
      !runtime.services.accounts.get(id) &&
      !runtime.services.profiles.synthetic.has(BigInt(id)) &&
      !runtime.services.files.exists(resolve(runtime.services.profiles.folder(id), 'profile.bin'))
    )
      throw new HTTPException(404);
    const profile = runtime.services.profiles.forViewer(runtime.services.profiles.get(id), viewer.player_id);

    return c.json(
      runtime.services.profiles.companionProfile(
        profile,
        runtime.services.files.exists(resolve(runtime.services.profiles.folder(Number(profile.id)), 'avatarLarge.jpg'))
          ? `https://us-or-rly101.zwift.com/download/${profile.id}/avatarLarge.jpg`
          : null,
      ),
    );
  });
  app.put('/api/profiles/me/:id', async (c) => {
    const user = authenticated(c);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    const update = profileUpdateSchema.parse(await c.req.json());

    const profile = runtime.services.profiles.get(user.player_id);

    if (update.countryCode !== undefined) profile.countryCode = update.countryCode;

    if (update.dob !== undefined) profile.dob = update.dob;

    if (update.emailAddress !== undefined) profile.email = update.emailAddress;

    if (update.firstName !== undefined) profile.firstName = update.firstName;

    if (update.lastName !== undefined) profile.lastName = update.lastName;

    if (update.height !== undefined) profile.heightInMillimeters = update.height;

    if (update.male !== undefined) profile.isMale = update.male;

    if (update.useMetric !== undefined) profile.useMetric = update.useMetric;

    if (update.weight !== undefined) profile.weightInGrams = update.weight;
    runtime.services.profiles.save(user.player_id, profile);

    return profileResponse(c, user.player_id);
  });
  app.on(['PUT'], ['/api/profiles/:id', '/api/profiles/:id/in-game-fields'], async (c) => {
    const user = authenticated(c);

    if (c.req.param('id') === '0') throw new HTTPException(400);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    const profile = parseProtobuf(PlayerProfileSchema, new Uint8Array(await c.req.arrayBuffer()));

    runtime.services.profiles.save(user.player_id, profile);

    return c.body(null, 204);
  });
}
