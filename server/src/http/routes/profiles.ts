import { t } from '#src/i18n/index';
import { AccountsService } from '#src/services/auth.service';
import { ImportsService } from '#src/services/profile-import.service';
import { FilesService } from '#src/services/files.service';
import { effectRoutes } from '#src/http/effect';
import { fileResponse } from '#src/http/file-response';
import { ProfilesService } from '#src/services/profile.service';
import { profileUpdateSchema } from '#src/dtos/profiles.dto';
import { parseProtobuf } from '#src/http/protobuf';
import { authenticated } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import { PlayerProfileSchema, ProfileEntitlementsSchema } from '#src/protocol/generated/profile_pb';
import { create, toBinary } from '@bufbuild/protobuf';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { Effect, Schema } from 'effect';
import { NumberFromInput } from '#src/schema';

export function profileRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const appRoutes = effectRoutes(app, runtime);

  runtime.effects.runSync(ImportsService.use((service) => service.recover()));

  appRoutes.get('/download/:id/avatarLarge.jpg', (c) =>
    Effect.gen(function* () {
      const filesService = yield* FilesService;

      const profilesService = yield* ProfilesService;

      const id = Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(
        c.req.param('id'),
      );

      const path = resolve(yield* profilesService.folder(id), 'avatarLarge.jpg');

      if (!(yield* filesService.isFile(path))) {
        throw new HTTPException(404);
      }

      return yield* fileResponse(c, path, { 'Content-Type': 'image/jpeg' });
    }),
  );

  const avatar = Effect.fn('profiles.avatar')(function* (id: number) {
    const profiles = yield* ProfilesService;
    const files = yield* FilesService;

    return (yield* files.exists(resolve(yield* profiles.folder(id), 'avatarLarge.jpg')))
      ? `https://us-or-rly101.zwift.com/download/${id}/avatarLarge.jpg`
      : null;
  });

  const profileResponse = Effect.fn('profiles.profileResponse')(function* (c: Context<RuntimeEnv>, id: number) {
    const profiles = yield* ProfilesService;
    const profile = yield* profiles.entitlements(yield* profiles.get(id));

    return c.req.header('Accept')?.includes('application/json')
      ? c.json(yield* profiles.companionProfile(profile, yield* avatar(id)))
      : c.body(toBinary(PlayerProfileSchema, profile));
  });

  appRoutes.on('GET', ['/api/profiles/me', '/api/profiles/me/'], (c) => profileResponse(c, authenticated(c).player_id));
  appRoutes.get('/api/profiles/me/entitlements', (c) =>
    Effect.gen(function* () {
      const profilesService = yield* ProfilesService;

      const user = authenticated(c);
      const profile = yield* profilesService.entitlements(yield* profilesService.get(user.player_id));

      return c.body(
        toBinary(
          ProfileEntitlementsSchema,
          create(ProfileEntitlementsSchema, {
            entitlements: profile.entitlements,
          }),
        ),
      );
    }),
  );
  appRoutes.get('/api/profiles/:id', (c) =>
    Effect.gen(function* () {
      const filesService = yield* FilesService;

      const profilesService = yield* ProfilesService;

      const viewer = authenticated(c);

      const id = Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(
        c.req.param('id'),
      );

      if (
        !runtime.effects.runSync(AccountsService).get(id) &&
        !profilesService.synthetic.has(BigInt(id)) &&
        !(yield* profilesService.exists(id))
      ) {
        throw new HTTPException(404);
      }
      const profile = yield* profilesService.forViewer(yield* profilesService.get(id), viewer.player_id);

      return c.json(
        yield* profilesService.companionProfile(
          profile,
          (yield* filesService.exists(resolve(yield* profilesService.folder(Number(profile.id)), 'avatarLarge.jpg')))
            ? `https://us-or-rly101.zwift.com/download/${profile.id}/avatarLarge.jpg`
            : null,
        ),
      );
    }),
  );
  appRoutes.put('/api/profiles/me/:id', (c) =>
    Effect.gen(function* () {
      const profilesService = yield* ProfilesService;

      const user = authenticated(c);

      if (String(user.player_id) !== c.req.param('id')) {
        throw new HTTPException(401);
      }

      const update = Schema.decodeUnknownSync(profileUpdateSchema)(yield* Effect.promise(() => c.req.json()));

      const profile = yield* profilesService.get(user.player_id);

      if (update.countryCode !== undefined) {
        profile.countryCode = update.countryCode;
      }

      if (update.dob !== undefined) {
        profile.dob = update.dob;
      }

      if (update.emailAddress !== undefined) {
        profile.email = update.emailAddress;
      }

      if (update.firstName !== undefined) {
        profile.firstName = update.firstName;
      }

      if (update.lastName !== undefined) {
        profile.lastName = update.lastName;
      }

      if (update.height !== undefined) {
        profile.heightInMillimeters = update.height;
      }

      if (update.male !== undefined) {
        profile.isMale = update.male;
      }

      if (update.useMetric !== undefined) {
        profile.useMetric = update.useMetric;
      }

      if (update.weight !== undefined) {
        profile.weightInGrams = update.weight;
      }
      const current = runtime.effects.runSync(AccountsService).get(user.player_id);

      if (!current?.enabled || current.auth_version !== user.auth_version || current.revision !== user.revision) {
        throw new HTTPException(409, { message: t('profiles_user_conflict') });
      }
      yield* profilesService.save(user.player_id, profile);

      return yield* profileResponse(c, user.player_id);
    }),
  );
  appRoutes.on(['PUT'], ['/api/profiles/:id', '/api/profiles/:id/in-game-fields'], (c) =>
    Effect.gen(function* () {
      const profilesService = yield* ProfilesService;

      const user = authenticated(c);

      if (c.req.param('id') === '0') {
        throw new HTTPException(400);
      }

      if (String(user.player_id) !== c.req.param('id')) {
        throw new HTTPException(401);
      }

      const profile = parseProtobuf(
        PlayerProfileSchema,
        new Uint8Array(yield* Effect.promise(() => c.req.arrayBuffer())),
      );

      const current = runtime.effects.runSync(AccountsService).get(user.player_id);

      if (!current?.enabled || current.auth_version !== user.auth_version || current.revision !== user.revision) {
        throw new HTTPException(409, { message: t('profiles_user_conflict') });
      }
      yield* profilesService.save(user.player_id, profile);

      return c.body(null, 204);
    }),
  );
}
