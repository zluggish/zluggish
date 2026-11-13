import { parseProtobuf } from '#src/http/protobuf';
import type { Hono, Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { html } from 'hono/html';
import { z } from 'zod';
import { create, toBinary } from '@bufbuild/protobuf';
import {
  PlayerProfileSchema,
  ProfileEntitlementsSchema,
  ProfileEntitlementSchema,
  ProfileEntitlement_EntitlementType,
  ProfileEntitlement_ProfileEntitlementStatus,
} from '#src/protocol/generated/profile_pb';
import type { Runtime, RuntimeEnv } from '#src/http/runtime';
import { companionProfile } from '#src/domain/profiles/json';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { page, authenticated, csrf } from '#src/http/routes/accounts';
import { ProfileImports, importFilenameSchema } from '#src/domain/profiles/imports';
import type { ImportFiles } from '#src/domain/profiles/imports';

export function profileRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const imports = new ProfileImports(runtime.accounts, runtime.world);
  imports.recover();

  function entitlements(profile: ReturnType<typeof create<typeof PlayerProfileSchema>>) {
    profile.entitlements = profile.entitlements.filter((item) => item.type !== ProfileEntitlement_EntitlementType.RIDE);
    profile.entitlements.push(
      create(ProfileEntitlementSchema, {
        type: ProfileEntitlement_EntitlementType.RIDE,
        id: -1n,
        status: ProfileEntitlement_ProfileEntitlementStatus.ACTIVE,
      }),
    );

    if (runtime.config.equipment.unlockAll || runtime.config.equipment.unlockEntitlements) {
      const range = z
        .object({ first: z.number().int(), last: z.number().int() })
        .parse(JSON.parse(readFileSync(resolve(runtime.assets, 'data/entitlements.txt'), 'utf8')));

      const owned = new Set(profile.entitlements.map((item) => item.id));

      for (let id = runtime.config.equipment.unlockAll ? 1 : range.first; id <= range.last; id++)
        if (!owned.has(BigInt(id)))
          profile.entitlements.push(
            create(ProfileEntitlementSchema, {
              id: BigInt(id),
              type: ProfileEntitlement_EntitlementType.USE,
              status: ProfileEntitlement_ProfileEntitlementStatus.ACTIVE,
            }),
          );
    }

    return profile;
  }

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
      runtime.accounts
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
    const profile = entitlements(runtime.profiles.get(id));

    return c.req.header('Accept')?.includes('application/json')
      ? c.json(companionProfile(profile, avatar(id)))
      : c.body(toBinary(PlayerProfileSchema, profile));
  }

  function avatar(id: number) {
    return existsSync(resolve(runtime.profiles.folder(id), 'avatarLarge.jpg'))
      ? `https://us-or-rly101.zwift.com/download/${id}/avatarLarge.jpg`
      : null;
  }

  app.on('GET', ['/api/profiles/me', '/api/profiles/me/'], (c) => profileResponse(c, authenticated(c).player_id));
  app.get('/api/profiles/me/entitlements', (c) => {
    const user = authenticated(c);
    const profile = entitlements(runtime.profiles.get(user.player_id));

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
    authenticated(c);

    const id = z.coerce.number().int().positive().safe().parse(c.req.param('id'));

    if (
      !runtime.accounts.get(id) &&
      !runtime.profiles.synthetic.has(BigInt(id)) &&
      !existsSync(resolve(runtime.profiles.folder(id), 'profile.bin'))
    )
      throw new HTTPException(404);
    const profile = runtime.profiles.get(id);

    return c.json(
      companionProfile(
        profile,
        existsSync(resolve(runtime.profiles.folder(Number(profile.id)), 'avatarLarge.jpg'))
          ? `https://us-or-rly101.zwift.com/download/${profile.id}/avatarLarge.jpg`
          : null,
      ),
    );
  });
  app.put('/api/profiles/me/:id', async (c) => {
    const user = authenticated(c);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    const update = z
      .object({
        countryCode: z.number().int().optional(),
        dob: z.string().optional(),
        emailAddress: z.string().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        height: z.number().int().positive().optional(),
        male: z.boolean().optional(),
        useMetric: z.boolean().optional(),
        weight: z.number().int().positive().optional(),
      })
      .parse(await c.req.json());

    const profile = runtime.profiles.get(user.player_id);

    if (update.countryCode !== undefined) profile.countryCode = update.countryCode;

    if (update.dob !== undefined) profile.dob = update.dob;

    if (update.emailAddress !== undefined) profile.email = update.emailAddress;

    if (update.firstName !== undefined) profile.firstName = update.firstName;

    if (update.lastName !== undefined) profile.lastName = update.lastName;

    if (update.height !== undefined) profile.heightInMillimeters = update.height;

    if (update.male !== undefined) profile.isMale = update.male;

    if (update.useMetric !== undefined) profile.useMetric = update.useMetric;

    if (update.weight !== undefined) profile.weightInGrams = update.weight;
    runtime.profiles.save(user.player_id, profile);

    return profileResponse(c, user.player_id);
  });
  app.on(['PUT'], ['/api/profiles/:id', '/api/profiles/:id/in-game-fields'], async (c) => {
    const user = authenticated(c);

    if (c.req.param('id') === '0') throw new HTTPException(400);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    const profile = parseProtobuf(PlayerProfileSchema, new Uint8Array(await c.req.arrayBuffer()));

    runtime.profiles.save(user.player_id, profile);

    return c.body(null, 204);
  });
}
