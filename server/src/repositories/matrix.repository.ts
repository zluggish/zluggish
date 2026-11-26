import { t } from '#src/i18n/index';
import type { RepositoryContext as Runtime } from '#src/context';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import { parse } from 'ini';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Option, Schema } from 'effect';
import { orElse, withDefault } from '#src/schema';

export interface MatrixHandlers {
  receive(author: string, content: string): void;
  onlineCount(): number;
  encrypted(): void;
  connectionFailed(): void;
  loginFailed(): void;
}

export interface MatrixTransport {
  send(content: string): Promise<void>;
  presence(count: number): void;
  close(): Promise<void>;
}

class MatrixError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string,
  ) {
    super(t('matrix_request_failed', { value1: status, value2: errcode }));
  }
}

const session = Schema.Struct({
  homeserver: Schema.String,
  userId: Schema.String,
  deviceId: Schema.String,
  accessToken: Schema.String,
});

const event = Schema.Struct({
  type: Schema.String,
  sender: Schema.String.pipe(withDefault('')),
  state_key: Schema.optional(Schema.String),
  content: Schema.Record(Schema.String, Schema.Unknown).pipe(withDefault({})),
});

const sync = Schema.Struct({
  next_batch: Schema.String,
  rooms: Schema.optional(
    Schema.Struct({
      join: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            state: Schema.optional(Schema.Struct({ events: Schema.Array(event) })),
            timeline: Schema.optional(Schema.Struct({ events: Schema.Array(event) })),
          }),
        ),
      ),
    }),
  ),
});

const text = Schema.Struct({
  msgtype: Schema.Literal('m.text'),
  body: Schema.String.check(Schema.isMinLength(1)), // Edits repeat the message with a "* " prefix; relaying them would duplicate chat.
  'm.relates_to': Schema.optional(Schema.Struct({ rel_type: Schema.optional(Schema.String) })),
});

const member = Schema.Struct({
  displayname: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMinLength(1)))),
});

const whoami = Schema.Struct({ user_id: Schema.String });

type MatrixBody = Record<string, typeof Schema.Json.Type>;

function localpart(user: string) {
  return user.replace(/^@/, '').replace(/:.*$/, '');
}

export class MatrixRepository {
  openMatrixTransport(
    settings: Runtime['config']['integrations']['matrix'],
    storageDir: string,
    handlers: MatrixHandlers,
  ) {
    const credentials = Schema.decodeUnknownSync(
      Schema.Struct({
        matrix: Schema.Union([
          Schema.Struct({ access_token: Schema.String.check(Schema.isMinLength(1)) }),
          Schema.Struct({ password: Schema.String.check(Schema.isMinLength(1)) }),
        ]),
      }),
    )(parse(readFileSync(settings.credentialsFile, 'utf8'))).matrix;

    const homeserver = settings.homeserver.replace(/\/+$/, '');
    const sessionFile = resolve(storageDir, 'matrix-session.json');
    const closing = new AbortController();
    const names = new Map<string, string>();
    let token = 'access_token' in credentials ? credentials.access_token : '';
    let userId = '';
    let room = '';
    // Set after the first sync, once the room's encryption state is known.
    let connected = false;
    let encrypted = false;
    let warned = false;

    const request = async <T extends Schema.ConstraintDecoder<unknown>>(
      schema: T,
      method: string,
      path: string,
      body?: MatrixBody,
      timeout = 30_000,
    ): Promise<T['Type']> => {
      const response = await fetch(`${homeserver}/_matrix/client/v3${path}`, {
        method,
        headers: {
          ...(token && { Authorization: t('matrix_bearer', { value1: token }) }),
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.any([closing.signal, AbortSignal.timeout(timeout)]),
      });

      if (!response.ok) {
        const error = Schema.decodeUnknownSync(Schema.Struct({ errcode: Schema.String }).pipe(orElse({ errcode: '' })))(
          await response.json().catch(() => ({})),
        );

        throw new MatrixError(response.status, error.errcode);
      }

      return Schema.decodeUnknownSync(schema)(await response.json());
    };

    const restore = () => {
      let saved;

      try {
        saved = Schema.decodeUnknownSync(session)(JSON.parse(readFileSync(sessionFile, 'utf8')));
      } catch {
        return;
      }

      if (saved.homeserver === homeserver && localpart(saved.userId) === localpart(settings.user)) {
        return saved;
      }
    };

    const identify = async () => {
      const response = await request(whoami, 'GET', '/account/whoami');

      userId = response.user_id;
    };

    // A stored session keeps one device; logging in on every start would add a new device each time.
    const login = async () => {
      if (!('password' in credentials)) {
        await identify();

        return;
      }

      const saved = restore();

      if (saved) {
        token = saved.accessToken;

        try {
          await identify();

          return;
        } catch (error) {
          if (!(error instanceof MatrixError && error.status === 401)) {
            throw error;
          }
          rmSync(sessionFile, { force: true });
        }
      }

      token = '';

      const response = await request(
        Schema.Struct({ user_id: Schema.String, device_id: Schema.String, access_token: Schema.String }),
        'POST',
        '/login',
        {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: settings.user },
          password: credentials.password,
          initial_device_display_name: t('zluggish_title'),
          ...(saved && { device_id: saved.deviceId }),
        },
      );

      token = response.access_token;
      userId = response.user_id;
      new AssetFiles().writeDurable(
        sessionFile,
        JSON.stringify({
          homeserver,
          userId,
          deviceId: response.device_id,
          accessToken: token,
        } satisfies (typeof session)['Type']),
        true,
      );
    };

    const poll = async (since: string) => {
      const query = new URLSearchParams({
        // Filters only accept room IDs, so this follows the join that resolves an alias.
        filter: JSON.stringify({
          presence: { not_types: ['*'] },
          account_data: { not_types: ['*'] },
          room: {
            rooms: [room],
            account_data: { not_types: ['*'] },
            ephemeral: { not_types: ['*'] },
            state: { lazy_load_members: true },
            timeline: { limit: 50 },
          },
        }),
        timeout: since ? '30000' : '0',
      });

      if (since) {
        query.set('since', since);
      }
      const response = await request(sync, 'GET', `/sync?${query}`, undefined, 60_000);
      const joined = response.rooms?.join?.[room];

      for (const item of [...(joined?.state?.events ?? []), ...(joined?.timeline?.events ?? [])]) {
        if (item.type === 'm.room.member' && item.state_key) {
          const name = Option.getOrUndefined(Schema.decodeUnknownOption(member)(item.content))?.displayname;

          if (name) {
            names.set(item.state_key, name);
          } else {
            names.delete(item.state_key);
          }
        } else if (item.type === 'm.room.encryption' || item.type === 'm.room.encrypted') {
          encrypted = true;
        }

        // The first sync replays history; only newer messages are chat.
        if (!since || item.type !== 'm.room.message' || item.sender === userId) {
          continue;
        }
        const message = Schema.decodeUnknownOption(text)(item.content);

        if (Option.isSome(message) && message.value['m.relates_to']?.rel_type !== 'm.replace') {
          handlers.receive(names.get(item.sender) ?? localpart(item.sender), message.value.body);
        }
      }

      if (encrypted && !warned) {
        warned = true;
        handlers.encrypted();
      }

      return response.next_batch;
    };

    const presence = (count: number) => {
      if (!connected) {
        return;
      }
      // Many homeservers disable presence; a refused update changes nothing for riders.
      void request(Schema.Unknown, 'PUT', `/presence/${encodeURIComponent(userId)}/status`, {
        presence: 'online',
        status_msg: count ? t('rider_online', { value1: count, value2: count === 1 ? '' : 's' }) : t('riders_offline'),
      }).catch(() => {});
    };

    const run = async () => {
      while (!closing.signal.aborted) {
        let authenticated = false;

        try {
          await login();
          authenticated = true;

          // Joining also accepts an invite and resolves a room alias.
          const joined = await request(
            Schema.Struct({ room_id: Schema.String }),
            'POST',
            `/join/${encodeURIComponent(settings.room)}`,
            {},
          );

          room = joined.room_id;
          let since = await poll('');
          connected = true;
          presence(handlers.onlineCount());

          while (!closing.signal.aborted) {
            since = await poll(since);
          }
        } catch (error) {
          connected = false;

          if (closing.signal.aborted) {
            return;
          }

          if (!authenticated && error instanceof MatrixError && (error.status === 401 || error.status === 403)) {
            handlers.loginFailed();
          } else {
            handlers.connectionFailed();
          }
          await sleep(30_000, undefined, { signal: closing.signal }).catch(() => {});
        }
      }
    };

    const running = run();

    return {
      send: async (content) => {
        if (!connected) {
          throw new Error(t('matrix_disconnected'));
        }

        // The bridge has no end-to-end encryption, so it never posts plain text into an encrypted room.
        if (encrypted) {
          throw new Error(t('matrix_room_encrypted'));
        }

        await request(
          Schema.Unknown,
          'PUT',
          `/rooms/${encodeURIComponent(room)}/send/m.room.message/${new CryptoRepository().randomUUID()}`,
          { msgtype: 'm.text', body: content },
        );
      },
      presence,
      close: async () => {
        closing.abort();
        await running;
      },
    } satisfies MatrixTransport;
  }
}
