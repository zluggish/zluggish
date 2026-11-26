import { t } from '#src/i18n/index';
import { RuntimeContext } from '#src/context';
import { resolve } from 'node:path';
import { configSchema } from '#src/config/schema';
import { EventsService } from '#src/services/events.service';
import { decodeMeetup, decodeMeetupInput } from '#src/dtos/meetup.dto';
import {
  eventRequest,
  worldRequest,
  editUserRequest,
  ownProfileRequest,
  settingsRequest,
  newUser,
  setupRequest,
  mutationRequest,
  serverRequest,
} from '#src/dtos/management.dto';
import { UploadsService } from '#src/services/uploads.service';
import type { JsonValue } from '#src/dtos/management.dto';
import { Context, Effect, Layer, Schema } from 'effect';
import { RideCompletionService } from '#src/services/ride-completion.service';
import type { User } from '#src/repositories/accounts.repository';
import { ManagementRepository } from '#src/repositories/management.repository';
import { ApplicationError } from '#src/errors';
import { WebSessionsService } from '#src/services/web-session.service';

const isFailure = Schema.is(Schema.Struct({ error: Schema.String }));

const isString = Schema.is(Schema.String);

const isNumber = Schema.is(Schema.Finite);

const isBoolean = Schema.is(Schema.Boolean);

const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

const isJsonArray = Schema.is(Schema.Array(Schema.Json));

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/** The browser gets a parsed outcome: a failure message, a bot reply, or plain success. */
function outcome(status: string, result: JsonValue) {
  if (status !== 'complete') {
    return { status, ok: false, message: t('management_result_unknown') };
  }

  if (isFailure(result)) {
    return { status, ok: false, message: result.error };
  }

  return {
    status,
    ok: true,
    message: isString(result) ? result : result === false ? t('nothing_to_change') : null,
  };
}

/** Operator configuration as read-only rows. The browser never receives secrets: paths only. */
function configuration(value: JsonValue, prefix = ''): Array<[string, string]> {
  if (isJsonObject(value) && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, item]) => configuration(item, prefix ? `${prefix}.${key}` : key));
  }

  return [[prefix, isJsonArray(value) ? value.join(', ') : String(value ?? '')]];
}

/** The result a completed operation recorded, returned again when its request is retried. */
function recorded(prior: { result: string | null }) {
  if (prior.result === null) {
    throw new ApplicationError({ status: 409, message: t('operation_changed') });
  }

  return JSON.parse(prior.result);
}

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const repositories = context.accounts.repositories;
  const completion = yield* RideCompletionService;
  const uploadsService = yield* UploadsService;
  const eventsService = yield* EventsService;

  const store = new ManagementRepository(context.accounts.db);

  const sessions = yield* WebSessionsService;

  let setupDigest: Buffer | null = null;

  let passwordWork = 0;

  function account(player: number) {
    const user = context.accounts.get(player);

    if (!user) {
      throw new ApplicationError({ status: 404, message: t('user_not_found_error') });
    }

    return user;
  }

  function publicUser(user: User) {
    const { pass_hash, auth_version: _authVersion, ...safe } = user;

    return {
      ...safe,
      has_password: !!pass_hash,
      connected: context.world.active(user.player_id),
      avatar: avatarVersion(user.player_id),
    };
  }

  function issueSetupKey() {
    if (store.complete()) {
      return null;
    }
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const bits = [...repositories.cryptoRepository.randomBytes(32)].map((v) => v.toString(2).padStart(8, '0')).join('');
    let key = '';

    for (let i = 0; i < bits.length; i += 5) {
      key += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
    }
    setupDigest = Buffer.from(repositories.cryptoRepository.sha256(key), 'hex');

    return (key.match(/.{1,4}/g) ?? []).join('-');
  }

  function keyValid(key: string) {
    const digest = Buffer.from(repositories.cryptoRepository.sha256(key.toUpperCase().replaceAll(/[-\s]/g, '')), 'hex');

    return setupDigest !== null && repositories.cryptoRepository.timingSafeEqual(digest, setupDigest);
  }

  /** Lets the setup form check the key before asking for account details. */
  function checkSetupKey(key: string) {
    if (store.complete() || !keyValid(key)) {
      throw new ApplicationError({ status: 403, message: t('setup_refused') });
    }
  }

  async function passwordTask<T>(work: () => Promise<T>) {
    if (passwordWork >= 4) {
      throw new ApplicationError({ status: 503, message: t('management_retry_later') });
    }
    passwordWork++;

    try {
      return await work();
    } finally {
      passwordWork--;
    }
  }

  function insert(input: (typeof newUser)['Type'], hash: string) {
    if (context.accounts.loginNameTaken(input.username)) {
      throw new ApplicationError({ status: 409, message: t('login_name_already_exists') });
    }

    const occupied = [
      ...context.accounts.list().map((r) => r.player_id),
      ...repositories.filesRepository
        .readdirSync(context.accounts.storage)
        .filter((v) => /^\d+$/.test(v))
        .map(Number),
    ];

    const id = Math.max(0, ...occupied) + 1;

    if (!Number.isSafeInteger(id) || id > 2_147_483_647) {
      throw new ApplicationError({ status: 409, message: t('user_id_space_exhausted') });
    }
    repositories.accountsRepository.insert({
      player_id: id,
      username: input.username,
      first_name: input.first_name,
      last_name: input.last_name,
      pass_hash: hash,
    });

    return account(id);
  }

  async function setup(raw: unknown, live: () => boolean = () => true) {
    const input = Schema.decodeUnknownSync(setupRequest)(raw);

    if (store.complete() || !keyValid(input.key)) {
      throw new ApplicationError({ status: 403, message: t('setup_refused') });
    }

    const existing =
      input.mode === 'existing'
        ? 'player_id' in input
          ? context.accounts.get(input.player_id)
          : context.accounts.byUsername(input.username)
        : null;

    if (input.mode === 'existing' && existing && !existing.pass_hash) {
      throw new ApplicationError({
        status: 400,
        message: t('management_user_password_missing'),
      });
    }

    const hash = await passwordTask(async () => {
      if (input.mode === 'new') {
        return repositories.cryptoRepository.hashPassword(input.password);
      }

      if (!existing || !(await context.accounts.verify(existing, input.password))) {
        throw new ApplicationError({ status: 403, message: t('setup_refused') });
      }

      return null;
    });

    const user = store.transaction(() => {
      if (!live() || store.complete() || !keyValid(input.key)) {
        throw new ApplicationError({ status: 409, message: t('setup_refused') });
      }
      let target: User;

      if (input.mode === 'new') {
        if (hash === null) {
          throw new ApplicationError({ status: 409, message: t('setup_refused') });
        }
        target = insert(input, hash);
      } else {
        const current = existing && context.accounts.get(existing.player_id);

        if (
          !existing ||
          !current ||
          !current.enabled ||
          current.auth_version !== existing.auth_version ||
          current.pass_hash !== existing.pass_hash ||
          current.username !== existing.username
        ) {
          throw new ApplicationError({ status: 409, message: t('account_changed_retry') });
        }
        target = current;
      }

      store.update(target.player_id, { role: 'administrator' });
      store.finish();
      return account(target.player_id);
    });

    setupDigest = null;

    return user;
  }

  async function signIn(username: string, password: string) {
    const user = context.accounts.byUsername(username);

    const valid = await passwordTask(() =>
      user
        ? context.accounts.verify(user, password)
        : repositories.cryptoRepository.hashPassword(password).then(() => false),
    );

    const current = user && context.accounts.get(user.player_id);

    if (
      !user ||
      !valid ||
      !current?.enabled ||
      current.auth_version !== user.auth_version ||
      current.pass_hash !== user.pass_hash ||
      current.username !== user.username
    ) {
      throw new ApplicationError({ status: 401, message: t('management_credentials_invalid') });
    }

    return user;
  }

  async function confirm(id: string, password: string) {
    const user = Effect.runSync(sessions.require(id, true, false));
    const identity = context.accounts.identityOf(user);

    if (
      !(await passwordTask(() => context.accounts.verify(user, password))) ||
      !Effect.runSync(sessions.current(id, identity))
    ) {
      throw new ApplicationError({ status: 401, message: t('confirmation_refused') });
    }
    Effect.runSync(sessions.require(id, true, false));
    Effect.runSync(sessions.session(id)).confirmedUntil = Date.now() + 900_000;
  }

  /** Administrators can already set any password, so they skip the current one. */
  async function changeOwnPassword(id: string, current: string | undefined, password: string) {
    const user = Effect.runSync(sessions.require(id));
    const identity = context.accounts.identityOf(user);

    const hash = await passwordTask(async () => {
      if (user.role !== 'administrator' && !(await context.accounts.verify(user, current ?? ''))) {
        throw new ApplicationError({ status: 403, message: t('password_incorrect') });
      }

      return repositories.cryptoRepository.hashPassword(password);
    });

    store.transaction(() => {
      if (!Effect.runSync(sessions.current(id, identity))) {
        throw new ApplicationError({ status: 401, message: t('session_changed') });
      }
      store.update(user.player_id, { pass_hash: hash });
    });
    Effect.runSync(completion.cancel(user.player_id));
  }

  function fingerprintNow(value: JsonValue) {
    const signed = repositories.cryptoRepository.signIdentity(JSON.stringify(value), context.sessions.secret);

    return signed.slice(signed.lastIndexOf('|') + 1);
  }

  async function create(id: string, raw: unknown, operation: string) {
    const input = Schema.decodeUnknownSync(newUser)(raw);
    Effect.runSync(sessions.require(id, true));
    const hash = await passwordTask(() => repositories.cryptoRepository.hashPassword(input.password));

    return store.transaction(() => {
      const actor = Effect.runSync(sessions.require(id, true));
      const fingerprint = fingerprintNow(input);
      const prior = store.operation(actor.player_id, operation);

      if (prior) {
        if (prior.action !== 'create' || prior.fingerprint !== fingerprint) {
          throw new ApplicationError({ status: 409, message: t('operation_changed') });
        }

        return recorded(prior);
      }

      const user = insert(input, hash);
      const result = publicUser(user);
      store.record(actor.player_id, operation, 'create', user.player_id, fingerprint, result);

      return result;
    });
  }

  async function mutate(id: string, targetId: number, action: string, raw: unknown) {
    const input = Schema.decodeUnknownSync(mutationRequest)(raw);
    Effect.runSync(sessions.require(id, true));

    const password = action === 'password' ? input.password : undefined;
    const hash = password ? await passwordTask(() => repositories.cryptoRepository.hashPassword(password)) : undefined;

    let permission: Effect.Success<ReturnType<RideCompletionService['Service']['capture']>> = null;
    let committed = false;

    const result = store.transaction(() => {
      const actor = Effect.runSync(sessions.require(id, true));

      if (actor.player_id === targetId && action === 'password') {
        throw new ApplicationError({
          status: 403,
          message: t('management_own_password_reset_blocked'),
        });
      }
      const target = context.accounts.get(targetId);

      if (!target) {
        throw new ApplicationError({ status: 404, message: t('user_not_found_error') });
      }
      const fingerprint = fingerprintNow({ action, targetId, input });
      const prior = store.operation(actor.player_id, input.operation);

      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw new ApplicationError({ status: 409, message: t('operation_changed') });
        }

        return recorded(prior);
      }

      if (target.revision !== input.revision) {
        throw new ApplicationError({ status: 409, message: t('management_user_conflict') });
      }

      if (
        target.enabled &&
        target.role === 'administrator' &&
        (action === 'disable' || (action === 'role' && input.role === 'rider')) &&
        store.administrators() <= 1
      ) {
        throw new ApplicationError({
          status: 409,
          message: t('management_last_admin_protected'),
        });
      }

      if (action === 'disable') {
        permission = Effect.runSync(completion.capture(targetId));
      }

      const values =
        action === 'password' && hash
          ? { pass_hash: hash }
          : action === 'role' && input.role
            ? { role: input.role }
            : action === 'disable'
              ? { enabled: 0 }
              : action === 'enable'
                ? { enabled: 1 }
                : action === 'revoke-sessions'
                  ? {}
                  : null;

      if (!values) {
        throw new ApplicationError({ status: 400, message: t('invalid_action') });
      }
      store.update(targetId, values);
      committed = true;

      const after = {
        ...publicUser(account(targetId)),
        completion_deadline: permission?.deadline ?? null,
      };

      store.record(actor.player_id, input.operation, action, targetId, fingerprint, after);

      return after;
    });

    if (committed) {
      if (action === 'disable') {
        Effect.runSync(completion.grant(targetId, permission));
      } else {
        Effect.runSync(completion.cancel(targetId));
      }
    }

    return result;
  }

  function edit(id: string, player: number, raw: unknown) {
    const input = Schema.decodeUnknownSync(editUserRequest)(raw);

    return store.transaction(() => {
      const actor = Effect.runSync(sessions.require(id, true));
      const target = context.accounts.get(player);

      if (!target) {
        throw new ApplicationError({ status: 404, message: t('user_not_found_error') });
      }
      const fingerprint = fingerprintNow(input);
      const prior = store.operation(actor.player_id, input.operation);

      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.action !== 'edit') {
          throw new ApplicationError({ status: 409, message: t('operation_changed') });
        }

        return recorded(prior);
      }

      if (context.world.active(player)) {
        throw new ApplicationError({
          status: 409,
          message: t('management_active_user_rename_blocked'),
        });
      }

      if (target.revision !== input.revision) {
        throw new ApplicationError({ status: 409, message: t('management_user_conflict') });
      }

      if (context.accounts.loginNameTaken(input.username, player)) {
        throw new ApplicationError({ status: 409, message: t('login_name_already_exists') });
      }

      const profile = context.profiles.get(player);
      profile.firstName = input.first_name;
      profile.lastName = input.last_name;
      profile.email = input.username;
      context.profiles.save(player, profile);
      store.update(player, { username: input.username }, false);
      const result = publicUser(account(player));
      store.record(actor.player_id, input.operation, 'edit', player, fingerprint, result);

      return result;
    });
  }

  function ownProfile(id: string, player?: number) {
    const actor = Effect.runSync(sessions.require(id, player !== undefined));
    const user = player === undefined ? actor : context.accounts.get(player);

    if (!user) {
      throw new ApplicationError({ status: 404, message: t('user_not_found_error') });
    }
    const [month, day, year] = context.profiles.get(user.player_id).dob.split('/', 3);

    return {
      user: publicUser(account(user.player_id)),
      birthday: year && month && day ? `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}` : '',
      avatar: avatarVersion(user.player_id),
    };
  }

  /** The game and the Companion app read the same file. */
  function avatarPath(player: number) {
    return resolve(context.profiles.folder(player), 'avatarLarge.jpg');
  }

  /** Changes with each upload, so the browser does not show a cached photo. */
  function avatarVersion(player: number) {
    const path = avatarPath(player);

    return repositories.filesRepository.existsSync(path)
      ? Math.trunc(repositories.filesRepository.statSync(path).mtimeMs)
      : null;
  }

  function saveAvatar(id: string, image: Uint8Array, player?: number) {
    const actor = Effect.runSync(sessions.require(id, player !== undefined));
    const user = player === undefined ? actor : context.accounts.get(player);

    if (!user) {
      throw new ApplicationError({ status: 404, message: t('user_not_found_error') });
    }

    if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8 || image.at(-2) !== 0xff || image.at(-1) !== 0xd9) {
      throw new ApplicationError({ status: 400, message: t('management_avatar_format_invalid') });
    }
    repositories.filesRepository.write(avatarPath(user.player_id), image);

    return { avatar: avatarVersion(user.player_id) };
  }

  function removeAvatar(id: string, player?: number) {
    const actor = Effect.runSync(sessions.require(id, player !== undefined));
    const user = player === undefined ? actor : context.accounts.get(player);

    if (!user) {
      throw new ApplicationError({ status: 404, message: t('user_not_found_error') });
    }
    const path = avatarPath(user.player_id);

    if (repositories.filesRepository.existsSync(path)) {
      repositories.filesRepository.unlinkSync(path);
    }

    return { avatar: null };
  }

  function editOwnProfile(id: string, raw: unknown, targetPlayer?: number) {
    const input = Schema.decodeUnknownSync(ownProfileRequest)(raw);

    return store.transaction(() => {
      const actor = Effect.runSync(sessions.require(id, targetPlayer !== undefined));
      const player = targetPlayer ?? actor.player_id;
      const target = context.accounts.get(player);

      if (!target) {
        throw new ApplicationError({ status: 404, message: t('user_not_found_error') });
      }
      const fingerprint = fingerprintNow({ ...input, player });
      const prior = store.operation(actor.player_id, input.operation);

      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.action !== 'profile') {
          throw new ApplicationError({ status: 409, message: t('operation_changed') });
        }

        return recorded(prior);
      }

      if (context.world.active(player)) {
        throw new ApplicationError({
          status: 409,
          message: t('management_active_profile_edit_blocked'),
        });
      }

      if (target.revision !== input.revision) {
        throw new ApplicationError({ status: 409, message: t('management_profile_conflict') });
      }

      if (context.accounts.loginNameTaken(input.username, player)) {
        throw new ApplicationError({ status: 409, message: t('management_email_conflict') });
      }

      const profile = context.profiles.get(player);
      profile.firstName = input.first_name;
      profile.lastName = input.last_name;
      profile.email = input.username;
      profile.dob = input.birthday.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2/$3/$1');
      context.profiles.save(player, profile);
      store.update(player, { username: input.username }, false);
      const result = ownProfile(id, targetPlayer);
      store.record(actor.player_id, input.operation, 'profile', player, fingerprint, result);

      return result;
    });
  }

  function settings(player: number) {
    return {
      revision: context.settings.revision(player),
      overrides: context.settings.read(player),
      defaults: context.config.riderDefaults,
    };
  }

  function saveSettings(id: string, player: number, raw: unknown, manage = false) {
    const input = Schema.decodeUnknownSync(settingsRequest)(raw);

    return store.transaction(() => {
      const actor = Effect.runSync(sessions.require(id, manage));

      if ((manage && actor.player_id === player) || (!manage && actor.player_id !== player)) {
        throw new ApplicationError({ status: 403, message: t('own_settings_only') });
      }

      if (!context.accounts.get(player)) {
        throw new ApplicationError({ status: 404, message: t('user_not_found_error') });
      }
      const fingerprint = fingerprintNow({ player, input });
      const prior = store.operation(actor.player_id, input.operation);

      if (prior) {
        if (prior.action !== 'settings' || prior.fingerprint !== fingerprint) {
          throw new ApplicationError({ status: 409, message: t('operation_changed') });
        }

        return recorded(prior);
      }

      context.settings.save(player, input.overrides, input.revision);
      Effect.runSync(uploadsService.revoke(player));
      const after = settings(player);
      store.record(actor.player_id, input.operation, 'settings', player, fingerprint, after);

      return after;
    });
  }

  async function serverOperation(
    id: string,
    action: string,
    raw: unknown,
    flush: () => Promise<void>,
    dispatch: { reload: () => Promise<void>; bots: (user: number, command: string) => string },
  ) {
    const input = Schema.decodeUnknownSync(serverRequest)(raw);

    if (action === 'bots' && (!input.user || !input.command)) {
      throw new ApplicationError({ status: 400, message: t('management_bot_command_required') });
    }
    const fingerprint = fingerprintNow({ action, input });

    // The retry check and the intent share one transaction, so a duplicate request never dispatches twice.
    const { actor, prior } = store.transaction(() => {
      const actor = Effect.runSync(sessions.require(id, true));
      const prior = store.operation(actor.player_id, input.operation);

      if (prior) {
        if (prior.action !== action || prior.fingerprint !== fingerprint) {
          throw new ApplicationError({ status: 409, message: t('operation_changed') });
        }

        return { actor, prior };
      }

      if (action === 'bots' && input.user !== undefined && !context.world.active(input.user)) {
        throw new ApplicationError({ status: 409, message: t('management_active_rider_required') });
      }
      store.intent(actor.player_id, input.operation, action, fingerprint);

      return { actor, prior: null };
    });

    if (prior) {
      return outcome(prior.status, prior.result ? decodeJson(prior.result) : null);
    }
    await flush();
    let result: JsonValue;

    try {
      Effect.runSync(sessions.require(id, true));
    } catch (error) {
      // A known result: the operation did not run. A retry returns it and never dispatches.
      store.finishOperation(actor.player_id, input.operation, {
        error: t('management_confirmation_required'),
      });

      throw error;
    }

    try {
      switch (action) {
        case 'reload-bots': {
          await dispatch.reload();
          result = true;
          break;
        }

        case 'bots': {
          if (input.user === undefined) {
            throw new ApplicationError({
              status: 400,
              message: t('management_bot_command_required'),
            });
          }
          result = dispatch.bots(input.user, [input.command, input.argument].filter(Boolean).join(' '));
          break;
        }

        default: {
          throw new ApplicationError({ status: 400, message: t('unknown_server_operation') });
        }
      }
    } catch {
      result = { error: t('operation_failed') };
    }

    store.finishOperation(actor.player_id, input.operation, result);

    return outcome('complete', result);
  }

  function eventsNow() {
    return repositories.eventsRepository.listPrivateEvent().map((row) => decodeMeetup(JSON.parse(row.json)));
  }

  function editEvent(session: string, eventId: number, action: string, raw: unknown) {
    const input = Schema.decodeUnknownSync(eventRequest)(raw);
    const actor = Effect.runSync(sessions.require(session, true));
    const fingerprint = fingerprintNow({ eventId, action, input });
    const prior = store.operation(actor.player_id, input.operation);

    if (prior) {
      if (prior.action !== action || prior.fingerprint !== fingerprint) {
        throw new ApplicationError({ status: 409, message: t('operation_changed') });
      }

      return recorded(prior);
    }

    const event = Effect.runSync(eventsService.read(String(eventId)));

    if (event.updateDate !== input.revision) {
      throw new ApplicationError({ status: 409, message: t('management_event_conflict') });
    }
    const result = { id: eventId, action };

    const commit = () => {
      Effect.runSync(sessions.require(session, true));
      store.record(actor.player_id, input.operation, action, eventId, fingerprint, result);
    };

    Effect.runSync(
      action === 'delete-event'
        ? eventsService.deleteMeetup(event, commit)
        : eventsService.updateMeetup(event, decodeMeetupInput({ ...event, ...input.changes }), commit),
    );

    return result;
  }

  function worldSettings() {
    const keys = new Set([
      ...context.settings.worldIds(),
      ...context.config.pelotons.map((value) => `peloton:${value.id}`),
    ]);

    return [...keys].map((id) => {
      const overrides = context.settings.world(id);

      const effective = id.startsWith('peloton:')
        ? { ...context.config.pelotons.find((value) => value.id === id.slice(8)), ...overrides }
        : { ...context.config.soloBlob, ...overrides };

      type WorldField = { name: string; kind: 'boolean' | 'number' | 'string'; value: boolean | number | string };

      const fields: Array<WorldField> = [];

      for (const [name, value] of Object.entries(effective)) {
        if (isBoolean(value)) {
          fields.push({ name, kind: 'boolean', value });
        } else if (isNumber(value)) {
          fields.push({ name, kind: 'number', value });
        } else if (isString(value)) {
          fields.push({ name, kind: 'string', value });
        }
      }

      return { id, revision: context.settings.worldRevision(id), overrides, fields };
    });
  }

  function saveWorld(session: string, raw: unknown) {
    const input = Schema.decodeUnknownSync(worldRequest)(raw);

    return store.transaction(() => {
      const actor = Effect.runSync(sessions.require(session, true));
      const fingerprint = fingerprintNow(input);
      const prior = store.operation(actor.player_id, input.operation);

      if (prior) {
        if (prior.action !== 'world-settings' || prior.fingerprint !== fingerprint) {
          throw new ApplicationError({ status: 409, message: t('operation_changed') });
        }

        return recorded(prior);
      }

      if (input.id.startsWith('peloton:')) {
        const id = input.id.slice(8);
        const base = context.config.pelotons.find((value) => value.id === id);

        if (!base) {
          throw new ApplicationError({ status: 404, message: t('unknown_peloton') });
        }
        Schema.decodeUnknownSync(configSchema)({ pelotons: [{ ...base, ...input.values, id }] });
      } else if (input.id.startsWith('blob:') && context.accounts.get(Number(input.id.slice(5)))) {
        Schema.decodeUnknownSync(configSchema)({ soloBlob: { ...context.config.soloBlob, ...input.values } });
      } else {
        throw new ApplicationError({ status: 400, message: t('unknown_world_settings') });
      }
      context.settings.saveWorld(input.id, input.values, input.revision);

      const after = {
        id: input.id,
        revision: context.settings.worldRevision(input.id),
        overrides: context.settings.world(input.id),
      };

      store.record(actor.player_id, input.operation, 'world-settings', 0, fingerprint, after);

      return after;
    });
  }

  return {
    store,

    sessions,

    publicUser: Effect.fn('ManagementService.publicUser')(function* (user: User) {
      return publicUser(user);
    }),

    issueSetupKey: Effect.fn('ManagementService.issueSetupKey')(function* () {
      return issueSetupKey();
    }),
    /** Lets the setup form check the key before asking for account details. */
    checkSetupKey: Effect.fn('ManagementService.checkSetupKey')(function* (key: string) {
      return checkSetupKey(key);
    }),

    passwordTask: Effect.fn('ManagementService.passwordTask')(function* <T>(work: () => Promise<T>) {
      return yield* Effect.promise(() => passwordTask(work));
    }),

    setup: Effect.fn('ManagementService.setup')(function* (raw: unknown, live: () => boolean = () => true) {
      return yield* Effect.promise(() => setup(raw, live));
    }),

    signIn: Effect.fn('ManagementService.signIn')(function* (username: string, password: string) {
      return yield* Effect.promise(() => signIn(username, password));
    }),

    confirm: Effect.fn('ManagementService.confirm')(function* (id: string, password: string) {
      return yield* Effect.promise(() => confirm(id, password));
    }),
    /** Administrators can already set any password, so they skip the current one. */
    changeOwnPassword: Effect.fn('ManagementService.changeOwnPassword')(function* (
      id: string,
      current: string | undefined,
      password: string,
    ) {
      return yield* Effect.promise(() => changeOwnPassword(id, current, password));
    }),

    create: Effect.fn('ManagementService.create')(function* (id: string, raw: unknown, operation: string) {
      return yield* Effect.promise(() => create(id, raw, operation));
    }),

    mutate: Effect.fn('ManagementService.mutate')(function* (
      id: string,
      targetId: number,
      action: string,
      raw: unknown,
    ) {
      return yield* Effect.promise(() => mutate(id, targetId, action, raw));
    }),

    edit: Effect.fn('ManagementService.edit')(function* (id: string, player: number, raw: unknown) {
      return edit(id, player, raw);
    }),

    ownProfile: Effect.fn('ManagementService.ownProfile')(function* (id: string, player?: number) {
      return ownProfile(id, player);
    }),
    /** The game and the Companion app read the same file. */
    avatarPath: Effect.fn('ManagementService.avatarPath')(function* (player: number) {
      return avatarPath(player);
    }),
    /** Changes with each upload, so the browser does not show a cached photo. */
    avatarVersion: Effect.fn('ManagementService.avatarVersion')(function* (player: number) {
      return avatarVersion(player);
    }),

    saveAvatar: Effect.fn('ManagementService.saveAvatar')(function* (id: string, image: Uint8Array, player?: number) {
      return saveAvatar(id, image, player);
    }),

    removeAvatar: Effect.fn('ManagementService.removeAvatar')(function* (id: string, player?: number) {
      return removeAvatar(id, player);
    }),

    editOwnProfile: Effect.fn('ManagementService.editOwnProfile')(function* (
      id: string,
      raw: unknown,
      targetPlayer?: number,
    ) {
      return editOwnProfile(id, raw, targetPlayer);
    }),

    settings: Effect.fn('ManagementService.settings')(function* (player: number) {
      return settings(player);
    }),

    saveSettings: Effect.fn('ManagementService.saveSettings')(function* (
      id: string,
      player: number,
      raw: unknown,
      manage: boolean = false,
    ) {
      return saveSettings(id, player, raw, manage);
    }),

    serverOperation: Effect.fn('ManagementService.serverOperation')(function* (
      id: string,
      action: string,
      raw: unknown,
      flush: () => Promise<void>,
      dispatch: { reload: () => Promise<void>; bots: (user: number, command: string) => string },
    ) {
      return yield* Effect.promise(() => serverOperation(id, action, raw, flush, dispatch));
    }),
    /** Operator configuration as read-only rows. The browser never receives secrets: paths only. */
    configuration: Effect.fn('ManagementService.configuration')(function* (value: JsonValue, prefix: string = '') {
      return configuration(value, prefix);
    }),

    events: Effect.fn('ManagementService.events')(function* () {
      return eventsNow();
    }),

    editEvent: Effect.fn('ManagementService.editEvent')(function* (
      session: string,
      eventId: number,
      action: string,
      raw: unknown,
    ) {
      return editEvent(session, eventId, action, raw);
    }),

    worldSettings: Effect.fn('ManagementService.worldSettings')(function* () {
      return worldSettings();
    }),

    saveWorld: Effect.fn('ManagementService.saveWorld')(function* (session: string, raw: unknown) {
      return saveWorld(session, raw);
    }),
  };
});

export class ManagementService extends Context.Service<ManagementService, Effect.Success<typeof make>>()(
  'zluggish/ManagementService',
) {
  static readonly layer = Layer.effect(ManagementService, make);
}
