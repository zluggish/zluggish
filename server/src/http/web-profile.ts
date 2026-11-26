import { t } from '#src/i18n/index';
import { AccountsService } from '#src/services/auth.service';
import { WebSessionsService } from '#src/services/web-session.service';
import { ManagementService } from '#src/services/management.service';
import { UploadsService } from '#src/services/uploads.service';
import { ActivitiesService } from '#src/services/activities.service';
import { ImportsService } from '#src/services/profile-import.service';
import { ConnectionsService } from '#src/services/connections.service';
import { IntegrationsService } from '#src/services/integrations.service';
import { DocumentsService } from '#src/services/documents.service';
import { effectRoutes } from '#src/http/effect';
import { SettingsService } from '#src/services/settings.service';
import { Effect, Schema } from 'effect';
import { Strict, withDefault } from '#src/schema';
import { DownloadFile } from '#src/enum';
import type { Hono, Context } from 'hono';
import { ApplicationError } from '#src/errors';
import { importFilenameSchema } from '#src/dtos/profile-import.dto';
import type { ImportFiles } from '#src/dtos/profile-import.dto';
import type { HttpRuntime } from '#src/http/runtime';
import { asProviderFailure } from '#src/http/web-connections';
import type { WebEnv } from '#src/http/web-app';

export function webProfileRoutes(app: Hono<WebEnv>, runtime: HttpRuntime) {
  const appRoutes = effectRoutes(app, runtime);

  const accounts = runtime.effects.runSync(AccountsService);
  const imports = runtime.effects.runSync(ImportsService);
  const sessions = runtime.effects.runSync(WebSessionsService);

  function context(c: Context<WebEnv>) {
    const id = c.get('sessionId');
    const user = runtime.effects.runSync(sessions.require(id));
    const session = runtime.effects.runSync(sessions.session(id));

    return { id, user, session };
  }

  function review(c: Context<WebEnv>) {
    const { user, session } = context(c);
    const stage = session.pendingImport;

    if (!stage) {
      return null;
    }
    const manifest = runtime.effects.runSync(imports.inspect(user, stage));

    const confirmSource =
      !manifest.sourceId ||
      Boolean(user.official_player_id && user.official_player_id !== manifest.sourceId) ||
      accounts
        .list()
        .some((other) => other.player_id !== user.player_id && other.official_player_id === manifest.sourceId);

    return {
      stage,
      firstName: manifest.firstName,
      lastName: manifest.lastName,
      sourceId: manifest.sourceId,
      files: manifest.files,
      confirmSource,
    };
  }

  function stageFiles(c: Context<WebEnv>, identity: string, files: ImportFiles) {
    const { id, user, session } = context(c);

    if (!runtime.effects.runSync(sessions.current(id, identity))) {
      throw new ApplicationError({ status: 401, message: t('web_profile_session_changed') });
    }

    if (runtime.world.active(user.player_id)) {
      throw new ApplicationError({ status: 409, message: t('web_profile_active_ride_blocked') });
    }
    let stage: string;

    try {
      stage = runtime.effects.runSync(imports.prepare(user, files));
    } catch {
      throw new ApplicationError({
        status: 400,
        message: t('web_profile_import_failed'),
      });
    }

    if (session.pendingImport) {
      runtime.effects.runSync(imports.cancel(user, session.pendingImport));
    }
    session.pendingImport = stage;

    return c.json({ review: review(c) });
  }

  appRoutes.get('/api/me/export', (c) =>
    Effect.gen(function* () {
      const documentsService = yield* DocumentsService;

      const { user } = context(c);

      return c.json({
        filenames: yield* Effect.filter(Object.values(DownloadFile), (name) =>
          documentsService.has(user.player_id, name),
        ),
      });
    }),
  );
  appRoutes.get('/api/me/export/:filename', (c) =>
    Effect.gen(function* () {
      const documentsService = yield* DocumentsService;

      const { user } = context(c);
      const filename = Schema.decodeUnknownSync(Schema.Enum(DownloadFile))(c.req.param('filename'));
      const data = yield* documentsService.get(user.player_id, filename);

      if (!data) {
        throw new ApplicationError({ status: 404, message: t('file_not_found') });
      }

      return c.body(new Uint8Array(data), 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });
    }),
  );
  appRoutes.post('/api/me/power-curves', (c) =>
    Effect.gen(function* () {
      const activitiesService = yield* ActivitiesService;

      const integrationsService = yield* IntegrationsService;

      const { user } = context(c);

      const input = Schema.decodeUnknownSync(Schema.Struct({ confirm: Schema.Literal(true), create: Schema.Boolean }))(
        yield* Effect.promise(() => c.req.json()),
      );

      if (input.create) {
        yield* activitiesService.rebuildPowerCurves(user.player_id);
      } else {
        yield* integrationsService.deletePowerCurve(user.player_id);
      }

      return c.json({
        message: input.create ? t('power_curves_rebuild_queued') : t('power_curves_deleted'),
      });
    }),
  );

  app.get('/api/me/import', (c) => {
    context(c);

    return c.json({ filenames: Object.values(importFilenameSchema.enums), review: review(c) });
  });
  app.post('/api/me/import', async (c) => {
    const { user } = context(c);
    const identity = accounts.identityOf(user);
    const form = await c.req.parseBody();
    const files: ImportFiles = {};

    for (const name of Object.values(importFilenameSchema.enums)) {
      const upload = form[name];

      if (upload instanceof File && upload.name) {
        files[name] = new Uint8Array(await upload.arrayBuffer());
      }
    }

    return stageFiles(c, identity, files);
  });
  appRoutes.post('/api/me/import/confirm', (c) =>
    Effect.gen(function* () {
      const managementService = yield* ManagementService;

      const input = Schema.decodeUnknownSync(
        Strict({
          stage: Schema.String,
          cancel: Schema.Boolean.pipe(withDefault(false)),
          keepName: Schema.Boolean.pipe(withDefault(false)),
          confirmSource: Schema.Boolean.pipe(withDefault(false)),
        }),
      )(yield* Effect.promise(() => c.req.json()));

      const { user, session } = context(c);
      const current = review(c);

      if (!current || current.stage !== input.stage) {
        throw new ApplicationError({
          status: 409,
          message: t('web_profile_import_conflict'),
        });
      }

      if (input.cancel) {
        runtime.effects.runSync(imports.cancel(user, current.stage));
      } else {
        if (current.confirmSource && !input.confirmSource) {
          throw new ApplicationError({ status: 400, message: t('web_profile_import_confirmation_required') });
        }

        if (runtime.world.active(user.player_id)) {
          throw new ApplicationError({
            status: 409,
            message: t('web_profile_active_ride_blocked'),
          });
        }
        runtime.effects.runSync(imports.publish(user, current.stage, input.keepName));
      }

      delete session.pendingImport;

      const updated = accounts.get(user.player_id);

      if (!updated) {
        throw new ApplicationError({ status: 404, message: t('user_not_found_error') });
      }

      return c.json({ user: yield* managementService.publicUser(updated), review: null });
    }),
  );

  const connection = (c: Context<WebEnv>) =>
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      const { user } = context(c);

      const resolved = SettingsService.resolveRiderSettings(
        runtime.config.riderDefaults,
        yield* settings.read(user.player_id),
      );

      return c.json({
        connected: yield* (yield* ConnectionsService).has(user.player_id, 'zwift'),
        upload: resolved.uploads.zwift.enabled,
        click: resolved.devices.zwiftClick.enabled,
      });
    });

  appRoutes.get('/api/me/zwift', connection);
  appRoutes.put('/api/me/zwift', (c) =>
    Effect.gen(function* () {
      const connectionsService = yield* ConnectionsService;

      const settingsService = yield* SettingsService;

      const input = Schema.decodeUnknownSync(
        Strict({
          username: Schema.String.check(Schema.isMaxLength(500)),
          password: Schema.String.check(Schema.isMaxLength(1000)),
          upload: Schema.Boolean,
          click: Schema.Boolean,
        }),
      )(yield* Effect.promise(() => c.req.json()));

      const { user } = context(c);
      const username = input.username.trim();

      if (Boolean(username) !== Boolean(input.password)) {
        throw new ApplicationError({ status: 400, message: t('web_profile_credentials_required') });
      }

      if (!username && !(yield* connectionsService.has(user.player_id, 'zwift')) && (input.upload || input.click)) {
        throw new ApplicationError({
          status: 400,
          message: t('web_profile_credentials_required_for_uploads'),
        });
      }

      if (username) {
        yield* connectionsService.save(user.player_id, 'zwift', [username, input.password]);
      }
      yield* settingsService.save(user.player_id, {
        ...(yield* settingsService.read(user.player_id)),
        'uploads.zwift.enabled': input.upload,
        'devices.zwiftClick.enabled': input.click,
      });

      return yield* connection(c);
    }),
  );
  appRoutes.delete('/api/me/zwift', (c) => {
    const { user } = context(c);
    runtime.effects.runSync(
      UploadsService.use((service) => service.disconnect(user.player_id, 'zwift_credentials.bin')),
    );

    return connection(c);
  });
  appRoutes.post('/api/me/zwift/import', (c) =>
    Effect.gen(function* () {
      const connectionsService = yield* ConnectionsService;

      const integrationsService = yield* IntegrationsService;

      const input = Schema.decodeUnknownSync(Strict({ profile: Schema.Boolean, achievements: Schema.Boolean }))(
        yield* Effect.promise(() => c.req.json()),
      );

      const { user } = context(c);
      const identity = accounts.identityOf(user);
      const credentials = yield* connectionsService.read(user.player_id, 'zwift');

      if (!credentials || (!input.profile && !input.achievements)) {
        throw new ApplicationError({
          status: 400,
          message: t('web_profile_download_configuration_required'),
        });
      }

      if (runtime.world.active(user.player_id)) {
        throw new ApplicationError({ status: 409, message: t('web_profile_active_ride_blocked') });
      }

      const files: ImportFiles = yield* integrationsService
        .downloadOfficialData(credentials[0], credentials[1], input.profile, input.achievements)
        .pipe(asProviderFailure(runtime, 400, t('web_profile_download_failed')));

      return stageFiles(c, identity, files);
    }),
  );
}
