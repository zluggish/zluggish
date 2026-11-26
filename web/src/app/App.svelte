<script lang="ts">
  import { randomUUID } from '../lib/uuid';
  import { t } from '../lib/i18n/index';
  import { onMount } from 'svelte';
  import { requestJson, ConnectionError, connection } from '../lib/connection';
  import { get } from 'svelte/store';
  import ProfileData from './ProfileData.svelte';
  import Connections from './Connections.svelte';
  import Activities from './Activities.svelte';
  import Climbs from './Climbs.svelte';
  import Layout from '../components/Layout.svelte';
  import UserRow from '../components/UserRow.svelte';
  import Avatar from '../components/Avatar.svelte';
  import TextField from './TextField.svelte';
  import ServerLogs from './ServerLogs.svelte';
  import Apps from './Apps.svelte';
  import { detect, isComputer, isPhone } from './device';
  import Install from './Install.svelte';
  import InstallPhone from './InstallPhone.svelte';
  import Companion from './Companion.svelte';
  import CompanionManage from './CompanionManage.svelte';
  import ZwiftAndroidManage from './ZwiftAndroidManage.svelte';
  import AndroidAppsManage from './AndroidAppsManage.svelte';
  import ServerCertificate from './ServerCertificate.svelte';
  import { tlsStatus } from './tls';
  import { decode, ignored, responseFields } from '../lib/api';
  import type { ApiPayload } from '../lib/api';
  import type { z } from 'zod';
  import {
    avatarResponse,
    backupResponse,
    eventsResponse,
    outcomeResponse,
    profileResponse,
    savedWorldSettingResponse,
    serverLogsResponse,
    serverSettingsResponse,
    setupKeyResponse,
    setupResponse,
    signedInResponse,
    userSchema,
    userSettingsSchema,
    usersResponse,
  } from './schemas';
  import type { ManagedEvent, SetupUser, User, UserSettings, WorldSetting } from './schemas';
  import type { TlsStatus } from './tls';

  type Pending = { title: string; detail: string; label: string; destructive: boolean; confirm: () => Promise<void> };

  const botCommands = [
    ['group', t('bots_group')],
    ['groupall', t('bots_group_all')],
    ['autogroup', t('bots_keep_grouped')],
    ['autogroupall', t('bots_keep_all_grouped')],
    ['stopautogroup', t('stop_automatic_grouping')],
    ['disperse', t('bots_spread_action')],
    ['peloton', t('bots_peloton_size_action')],
  ] as const;

  const pageSize = 25;

  let path = $state(location.pathname);
  let csrf = '';
  let version = $state('');
  let zwiftVersion = $state('');
  let user = $state<User | null>(null);
  let users = $state<Array<User>>([]);
  let complete = $state(true);
  let loading = $state(true);
  let slowLoading = $state(false);
  let busy = $state(false);
  let message = $state('');
  let failed = $state(false);
  let errorScope = $state('');
  let fieldErrors = $state<Record<string, Array<string>>>({});
  let conflict = $state<User | null>(null);
  let pending = $state<Pending | null>(null);
  let operation = randomUUID();

  let mode = $state<'new' | 'existing'>('new');
  let key = $state('');
  let keyAccepted = $state(false);
  let setupUsers = $state<Array<SetupUser>>([]);
  let setupUserId = $state<number | null>(null);
  let username = $state('');
  let password = $state('');
  let confirmPassword = $state('');
  let first = $state('');
  let last = $state('');

  const profileId = $derived(Number(/^\/profile\/(\d+)$/.exec(path)?.[1] ?? 0));
  const profileBase = $derived(profileId ? `/api/manage/users/${profileId}` : '/api/me');
  let profileUser = $state<User | null>(null);
  let profileAvatar = $state<number | null>(null);

  let birthday = $state('');

  // Undefined until loaded: the side menu shows the photo on every page.
  let avatar = $state<number | null | undefined>(undefined);
  let avatarInput = $state<HTMLInputElement>();
  let dropping = $state(false);
  let currentPassword = $state('');
  let changing = $state(false);
  let changeButton = $state<HTMLButtonElement>();
  let settings = $state<UserSettings | null>(null);
  let regenerating = $state(false);
  let rebuild = $state(true);
  let regenerateButton = $state<HTMLButtonElement>();
  let ghosts = $state(false);
  let stravaMethod = $state('paid');
  let garminPhotos = $state(false);
  let garminDevice = $state(false);
  let intervalsUpload = $state(true);
  let bridgeFolder = $state('');

  let search = $state('');
  let page = $state(0);
  let newFirst = $state('');
  let newLast = $state('');
  let newLogin = $state('');
  let newPassword = $state('');
  let newConfirm = $state('');
  let targetPassword = $state('');
  let targetConfirm = $state('');

  /** The Zwift certificate's source, for the administrator's warning on every page. */
  let certificateMode = $state<TlsStatus['mode'] | null>(null);
  let backingUp = $state(false);
  let backupMessage = $state('');
  let backupOperation = randomUUID();
  let serverConfig = $state<{ rows: Array<[string, string]> } | null>(null);
  let worldSettings = $state<Array<WorldSetting>>([]);
  let worldSetting = $state<WorldSetting | null>(null);
  let worldValues = $state<Record<string, string | number | boolean>>({});
  let events = $state<Array<ManagedEvent>>([]);
  let event = $state<ManagedEvent | null>(null);
  let eventDescription = $state('');
  let eventStart = $state('');
  let botUser = $state<number | null>(null);
  let botCommand = $state<(typeof botCommands)[number][0]>('group');
  let botArgument = $state('');

  const manage = $derived(path === '/manage' || path.startsWith('/manage/'));
  const installing = $derived(path === '/install' || path.startsWith('/install/'));
  const companion = $derived(path === '/companion' || path.startsWith('/companion/'));
  const installingPhone = $derived(/^\/install\/(android|android-rooted|ios)$/.test(path));
  const here = detect();
  /** Install and Companion open a setup only for a system they know; every other path under them is the choice. */
  const apps = $derived(
    path === '/apps' ||
      (installing &&
        !installingPhone &&
        !/^\/install\/(windows|macos|linux|manual)$/.test(path) &&
        !(path === '/install' && isComputer(here))) ||
      (companion && !/^\/companion\/(android|ios)$/.test(path) && !(path === '/companion' && isPhone(here))),
  );

  const back = $derived(
    manage && path.startsWith('/manage/users/') ? { href: '/manage', label: t('all_users') } : undefined,
  );

  /** Setup pages name the app and system in a visible heading, under a link back to Apps. */
  const setups = new Map([
    ['/install/windows', t('setup_zwift_windows')],
    ['/install/macos', t('setup_zwift_macos')],
    ['/install/linux', t('setup_zwift_linux')],
    ['/install/manual', t('setup_zwift_manual')],
    ['/install/android', t('setup_zwift_android')],
    ['/install/android-rooted', t('setup_zwift_rooted_android')],
    ['/install/ios', t('setup_zwift_ios')],
    ['/companion/android', t('setup_companion_android')],
    ['/companion/ios', t('setup_companion_ios')],
  ]);
  // Bare `/install` and `/companion` set up this browser's own system.
  const setup = $derived(
    apps ? undefined : setups.get(path === '/install' || path === '/companion' ? `${path}/${here}` : path),
  );
  /** The patched Android apps are managed one at a time, under a page that shows whether each is ready. */
  const androidApps = ['/manage/android', '/manage/zwift-android', '/manage/companion'];
  const crumb = $derived(
    setup
      ? { href: '/apps', label: t('apps_breadcrumb') }
      : path === '/manage/zwift-android' || path === '/manage/companion'
        ? { href: '/manage/android', label: t('android_apps') }
        : undefined,
  );

  const administrator = $derived(user?.role === 'administrator');
  const selectedId = $derived(Number(/^\/manage\/users\/(\d+)$/.exec(path)?.[1] ?? 0));
  const selected = $derived(users.find((r) => r.player_id === selectedId) ?? null);
  const connected = $derived(users.filter((r) => r.connected));

  const filtered = $derived(
    users.filter((r) =>
      `${r.player_id} ${r.username} ${r.first_name} ${r.last_name}`.toLowerCase().includes(search.toLowerCase()),
    ),
  );

  // Asked once per sign-in; the Server page reports later changes.
  let certificateRequested = false;

  $effect(() => {
    if (!user) {
      certificateRequested = false;
      certificateMode = null;

      return;
    }

    if (certificateRequested) {
      return;
    }
    certificateRequested = true;
    api(tlsStatus, '/api/tls')
      .then((body) => {
        certificateMode = body.mode;
      })
      .catch(() => {
        certificateRequested = false;
      });
  });

  const name = (r: User) => `${r.first_name} ${r.last_name}`.trim();
  const label = (r: User) => name(r) || r.username;

  const pages = $derived(Math.max(1, Math.ceil(filtered.length / pageSize)));

  const title = $derived(
    loading
      ? t('loading')
      : !user
        ? complete
          ? t('sign_in')
          : t('first_administrator')
        : path === '/manage/server'
          ? t('server')
          : path === '/manage/android'
            ? t('android_apps')
            : path === '/manage/companion'
              ? t('companion_for_android')
              : path === '/manage/zwift-android'
                ? t('zwift_for_android')
                : path === '/manage/users/new'
                  ? t('create_user')
                  : selected
                    ? label(selected)
                    : manage
                      ? t('users')
                      : path === '/' || path === '/activities' || path.startsWith('/activities/')
                        ? t('activities')
                        : path === '/profile-data/local'
                          ? t('import_local_files')
                          : path === '/profile-data'
                            ? 'Import / Export'
                            : path === '/zwift'
                              ? t('zwift_connection')
                              : path === '/integrations'
                                ? t('integrations')
                                : path === '/settings'
                                  ? t('settings')
                                  : path === '/climbs'
                                    ? t('climbs')
                                    : apps
                                      ? t('apps')
                                      : (setup ?? t('profile')),
  );

  const initials = (r: User) => `${r.first_name.charAt(0)}${r.last_name.charAt(0)}`.toUpperCase();
  const time = (value: number) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const errors = (scope: string, field: string) => (errorScope === scope ? (fieldErrors[field] ?? []) : []);

  async function api<Schema extends z.ZodType>(
    schema: Schema,
    url: string,
    method = 'GET',
    data?: ApiPayload | FormData | Blob,
  ): Promise<z.output<Schema>> {
    const headers = new Headers({ 'X-CSRF-Token': csrf });

    if (data instanceof Blob) {
      headers.set('Content-Type', data.type);
    } else if (!(data instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }

    const { response, body } = await requestJson(url, {
      method,
      headers,
      ...(data !== undefined && {
        body: data instanceof FormData || data instanceof Blob ? data : JSON.stringify(data),
      }),
    });

    const fields = responseFields(body);

    if (fields.csrf) {
      csrf = fields.csrf;
    }

    if (!response.ok) {
      // The server answered, so a retry is a new operation. A lost response keeps the ID for a safe retry.
      if (method !== 'GET') {
        operation = randomUUID();
      }
      fieldErrors = fields.fieldErrors ?? {};
      const scope = selected && `/api/manage/users/${selected.player_id}`;

      if (response.status === 409 && scope && (url === scope || url.startsWith(`${scope}/`))) {
        conflict = await api(userSchema, scope);
      }

      if (response.status === 401 && user) {
        user = null;
        avatar = undefined;
        avatar = undefined;
        go('/sign-in');
        await api(ignored, '/api/setup');
        throw new Error(t('session_expired_notice'));
      }

      throw new Error(fields.message || t('request_failed'));
    }

    if (method !== 'GET') {
      operation = randomUUID();
    }

    return decode(schema, body);
  }

  let destination: string | null = null;

  function go(next: string) {
    // An operation may redirect, but a newer navigation owns the browser URL.
    if (destination === null && next !== location.pathname) {
      history.pushState({}, '', next);
    }
    path = next;
  }

  async function navigate(next: string) {
    if (next !== location.pathname) {
      history.pushState({}, '', next);
    }
    destination = next;
    await loadDestination();
  }

  async function loadDestination() {
    if (busy || destination === null) {
      return;
    }

    const next = destination;
    await run(async () => {
      path = next;
      destination = null;
      await enter();
    });
  }

  async function run(work: () => Promise<void>, scope = '', suppressConnectionError = false) {
    if (busy) {
      return;
    }
    busy = true;
    message = '';
    failed = false;
    errorScope = scope;
    fieldErrors = {};

    try {
      await work();
    } catch (error) {
      failed = true;
      message =
        suppressConnectionError && error instanceof ConnectionError
          ? ''
          : error instanceof Error
            ? error.message
            : t('request_failed');
    } finally {
      busy = false;
      // Keep route-dependent mutations and loads serial. Only the latest requested
      // destination is loaded after the active operation (including failures).
      await loadDestination();
    }
  }

  function done(text: string) {
    failed = false;
    message = text;
  }

  /** Loads what the current route shows. Direct navigation to any route works. */
  async function enter() {
    if (!user) {
      return;
    }

    if (title === 'Profile' || avatar === undefined) {
      await loadProfile();
    }

    if (!manage) {
      // Integrations reads the saved Strava method and TrainingPeaks folder from the same settings.
      if (path === '/settings' || path === '/integrations') {
        await loadSettings();
      }

      return;
    }

    if (!administrator) {
      return;
    }
    await loadUsers();

    if (path === '/manage/server') {
      await loadServer();
    }

    if (selected) {
      select();
    }
  }

  async function loadUsers() {
    users = (await api(usersResponse, '/api/manage/users')).users;
  }

  async function loadServer() {
    const body = await api(serverSettingsResponse, '/api/manage/settings');
    worldSettings = body.worldSettings;
    serverConfig = { rows: body.configuration };
    events = (await api(eventsResponse, '/api/manage/events')).events;
  }

  async function createBackup() {
    backingUp = true;
    backupMessage = t('requesting_backup');

    try {
      let result = await api(backupResponse, '/api/manage/server/backups', 'POST', { operation: backupOperation });

      while (result.state === 'queued' || result.state === 'running') {
        backupMessage = result.state === 'queued' ? t('backup_queued') : t('creating_backup');
        await new Promise((resolve) => {
          setTimeout(resolve, 1000);
        });
        result = await api(backupResponse, `/api/manage/server/backups/${backupOperation}`);
      }

      backupOperation = randomUUID();
      backupMessage = result.state === 'done' ? t('backup_success', { value1: result.name }) : t('backup_failure');
    } catch (error) {
      backupMessage = error instanceof Error ? error.message : t('backup_request_failed');
    } finally {
      backingUp = false;
    }
  }

  function preferences(body: UserSettings) {
    return {
      ghosts: Boolean(body.overrides['ghosts.enabled'] ?? body.defaults.ghosts.enabled),
      stravaMethod: String(body.overrides['uploads.strava.method'] ?? body.defaults.uploads.strava.method),
      garminPhotos: Boolean(
        body.overrides['uploads.garmin.photos.enabled'] ?? body.defaults.uploads.garmin.photos.enabled,
      ),
      garminDevice: Boolean(
        body.overrides['uploads.garmin.device.enabled'] ?? body.defaults.uploads.garmin.device.enabled,
      ),
      intervalsUpload: Boolean(body.overrides['uploads.intervals.enabled'] ?? body.defaults.uploads.intervals.enabled),
      bridgeFolder: String(
        body.overrides['workouts.trainingpeaks.bridgeFolder'] ?? body.defaults.workouts.trainingpeaks.bridgeFolder,
      ),
    };
  }

  function applySettings(body: UserSettings) {
    ({ ghosts, stravaMethod, garminPhotos, garminDevice, intervalsUpload, bridgeFolder } = preferences(body));
  }

  async function saveSettings() {
    if (!settings) {
      return;
    }
    settings = await api(userSettingsSchema, '/api/me/settings', 'PATCH', settingsBody(settings));
  }

  /** A single switch saves as soon as it changes, and flips back if the server refuses it. */
  function saveGhosts() {
    void run(async () => {
      try {
        await saveSettings();
      } catch (error) {
        ghosts = !ghosts;
        throw error;
      }

      done(ghosts ? t('ghosts_turned_on') : t('ghosts_turned_off'));
    }, 'settings');
  }

  function applyProfile(body: { user: User; birthday: string; avatar: number | null }) {
    profileUser = body.user;
    profileAvatar = body.avatar;

    if (!profileId) {
      user = body.user;
      avatar = body.avatar;
    }

    first = body.user.first_name;
    last = body.user.last_name;
    username = body.user.username;
    birthday = body.birthday;
  }

  /** Zwift shows a square photo in a circle: crop the middle and keep the file small. */
  async function squarePhoto(file: File) {
    let bitmap: ImageBitmap;

    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error(t('avatar_format_error'));
    }

    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.min(side, 512);
    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error(t('avatar_process_error'));
    }
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    bitmap.close();

    return new Promise<Blob>((done, fail) => {
      canvas.toBlob((blob) => (blob ? done(blob) : fail(new Error(t('avatar_read_error')))), 'image/jpeg', 0.9);
    });
  }

  function uploadPhoto(file: File | undefined) {
    if (!file) {
      return;
    }
    void run(async () => {
      profileAvatar = (await api(avatarResponse, `${profileBase}/avatar`, 'PUT', await squarePhoto(file))).avatar;

      if (!profileId) {
        avatar = profileAvatar;
      }
      done(t('profile_restart_hint'));
    });
  }

  async function loadProfile() {
    applyProfile(await api(profileResponse, `${profileBase}/profile`));
  }

  async function loadSettings() {
    const loaded = await api(userSettingsSchema, '/api/me/settings');
    settings = loaded;
    applySettings(loaded);
  }

  function select() {
    targetPassword = '';
    targetConfirm = '';
    conflict = null;
  }

  async function openUser(target: User) {
    go(`/manage/users/${target.player_id}`);
    select();
    window.scrollTo(0, 0);
  }

  function settingsBody(current: UserSettings) {
    return {
      revision: current.revision,
      operation,
      overrides: {
        ...current.overrides,
        'ghosts.enabled': ghosts,
        'uploads.strava.method': stravaMethod,
        'uploads.garmin.photos.enabled': garminPhotos,
        'uploads.garmin.device.enabled': garminDevice,
        'uploads.intervals.enabled': intervalsUpload,
        'workouts.trainingpeaks.bridgeFolder': bridgeFolder,
      },
    };
  }

  /** Checks the setup key alone, so a wrong key costs one field instead of the whole form. */
  async function checkKey() {
    try {
      const body = await api(setupKeyResponse, '/api/setup/key', 'POST', { key });
      setupUsers = body.users;
      setupUserId = null;
      mode = setupUsers.length ? 'existing' : 'new';
      keyAccepted = true;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== t('setup_refused')) {
        throw error;
      }
      fieldErrors = { key: [t('setup_key_mismatch')] };
    }
  }

  async function signIn() {
    if (!complete && mode === 'new' && password !== confirmPassword) {
      fieldErrors = { confirm: [t('password_mismatch')] };
      throw new Error(t('form_validation_error'));
    }

    const body = complete
      ? await api(signedInResponse, '/api/session', 'POST', { username, password })
      : await api(signedInResponse, '/api/setup', 'POST', {
          mode,
          key,
          password,
          ...(mode === 'new' ? { username, first_name: first, last_name: last } : { player_id: setupUserId }),
        }).catch((error) => {
          // The key stops working when the server restarts, so ask for the new one.
          if (error instanceof Error && error.message === t('setup_refused') && mode === 'new') {
            keyAccepted = false;
            fieldErrors = { key: [t('setup_key_expired')] };
          }

          throw error;
        });

    const setup = !complete;
    user = body.user;
    password = '';
    confirmPassword = '';
    key = '';
    complete = true;

    go(setup ? '/manage' : '/');
    await enter();
  }

  async function signOut() {
    await api(ignored, '/api/session', 'DELETE', {});
    await api(ignored, '/api/setup');
    user = null;
    users = [];
    go('/sign-in');
  }

  type UserAction = 'disable' | 'enable' | 'role' | 'revoke-sessions' | 'password';

  function ask(action: UserAction) {
    if (!selected) {
      return;
    }
    const who = name(selected);
    const progress = selected.connected ? t('user_active_ride_warning', { value1: who }) : '';

    const choices = {
      disable: {
        title: t('user_disable_confirm', { value1: who }),
        detail: t('user_disabled_detail', { value1: who }),
        label: t('user_disable_action'),
        destructive: true,
      },
      enable: {
        title: t('user_enable_confirm', { value1: who }),
        detail: t('user_enabled_detail', { value1: who }),
        label: t('user_enable_action'),
        destructive: false,
      },
      role:
        selected.role === 'administrator'
          ? {
              title: t('admin_revoke_confirm', { value1: who }),
              detail: t('admin_revoked_detail', { value1: who, value2: progress }),
              label: t('remove_administrator'),
              destructive: true,
            }
          : {
              title: t('admin_grant_confirm', { value1: who }),
              detail: t('admin_granted_detail', { value1: who, value2: progress }),
              label: t('make_administrator'),
              destructive: false,
            },
      'revoke-sessions': {
        title: t('sign_out_confirm', { value1: who }),
        detail: t('user_stop_ride_warning', { value1: progress }),
        label: t('sign_out_action'),
        destructive: true,
      },
      password: {
        title: t('password_reset_confirm', { value1: who }),
        detail: t('sign_out_detail', { value1: who, value2: progress }),
        label: t('set_password'),
        destructive: false,
      },
    } satisfies Record<UserAction, Omit<Pending, 'confirm'>>;

    pending = { ...choices[action], confirm: () => mutate(action) };
  }

  async function mutate(action: UserAction) {
    if (!selected) {
      return;
    }

    if (action === 'password' && targetPassword !== targetConfirm) {
      fieldErrors = { confirm: [t('password_mismatch')] };
      throw new Error(t('form_validation_error'));
    }

    const result = await api(
      userSchema,
      `/api/manage/users/${selected.player_id}/${action}`,
      action === 'role' ? 'PUT' : 'POST',
      {
        revision: selected.revision,
        operation,
        ...(action === 'password' && { password: targetPassword }),
        ...(action === 'role' && { role: selected.role === 'administrator' ? 'rider' : 'administrator' }),
      },
    );

    targetPassword = '';
    targetConfirm = '';
    await loadUsers();
    users = users.map((r) => (r.player_id === result.player_id ? { ...r, ...result } : r));

    const messages = {
      disable: result.completion_deadline ? t('user_disabled_ride_hint') : t('user_disabled_notice'),
      enable: t('user_enabled_notice'),
      role: result.role === 'administrator' ? t('administrator_role_given') : t('administrator_role_removed'),
      'revoke-sessions': t('signed_out_everywhere'),
      password: t('password_set'),
    } satisfies Record<UserAction, string>;

    done(messages[action]);
  }

  async function create() {
    if (newPassword !== newConfirm) {
      fieldErrors = { confirm: [t('password_mismatch')] };
      throw new Error(t('form_validation_error'));
    }

    const created = await api(userSchema, '/api/manage/users', 'POST', {
      operation,
      user: { username: newLogin, password: newPassword, first_name: newFirst, last_name: newLast },
    });

    newFirst = '';
    newLast = '';
    newLogin = '';
    newPassword = '';
    newConfirm = '';
    await loadUsers();
    await openUser(created);
    done(t('setup_user_enabled', { value1: name(created) }));
  }

  function openPassword() {
    currentPassword = '';
    password = '';
    confirmPassword = '';
    message = '';
    fieldErrors = {};
    changing = true;
  }

  function closePassword() {
    changing = false;
    message = '';
    changeButton?.focus();
  }

  /** Changing the password ends every session, this one too. */
  async function changePassword() {
    if (password !== confirmPassword) {
      fieldErrors = { confirm: [t('password_mismatch')] };
      throw new Error(t('form_validation_error'));
    }

    await api(ignored, '/api/me/password', 'POST', {
      ...(!administrator && { current_password: currentPassword }),
      password,
    });
    await api(ignored, '/api/setup');
    changing = false;
    user = null;
    avatar = undefined;
    currentPassword = '';
    password = '';
    confirmPassword = '';
    go('/sign-in');
    done(t('password_changed_notice'));
  }

  function closeRegenerate() {
    regenerating = false;
    regenerateButton?.focus();
  }

  async function regenerate() {
    regenerating = false;
    await api(ignored, '/api/me/power-curves', 'POST', { confirm: true, create: rebuild });
    done(rebuild ? t('regenerating_power_curves') : t('power_curves_deleted_notice'));
  }

  function focusFirst(node: HTMLElement) {
    node.querySelector('input')?.focus();
  }

  type ServerAction = 'reload-bots';

  function serverOperation(
    action: ServerAction,
    label: string,
    detail: string,
    finished: string,
    destructive: boolean,
  ) {
    pending = {
      title: t('operation_confirm', { value1: label }),
      detail,
      label,
      destructive,
      confirm: async () => {
        const body = await api(outcomeResponse, `/api/manage/server/${action}`, 'POST', {
          operation,
        });

        if (!body.ok) {
          throw new Error(body.message ?? t('operation_failed'));
        }
        done(body.message ?? finished);
      },
    };
  }

  async function sendBots() {
    if (botUser === null) {
      throw new Error(t('bots_rider_hint'));
    }

    const body = await api(outcomeResponse, '/api/manage/server/bots', 'POST', {
      operation,
      user: botUser,
      command: botCommand,
      ...(botCommand === 'peloton' && botArgument && { argument: botArgument }),
    });

    if (!body.ok) {
      throw new Error(body.message ?? t('operation_failed'));
    }
    done(body.message ?? t('bot_command_success'));
  }

  onMount(() => {
    const slowTimer = window.setTimeout(() => {
      slowLoading = true;
    }, 400);
    const pop = () => {
      void navigate(location.pathname);
    };

    window.addEventListener('popstate', pop);
    let retryStartup = false;
    let alive = true;
    const start = async () => {
      retryStartup = false;
      loading = true;
      await run(
        async () => {
          try {
            const setup = await api(setupResponse, '/api/setup');
            complete = setup.complete;
            version = setup.version;
            zwiftVersion = setup.zwiftVersion;

            if (!complete) {
              go('/setup');

              return;
            }

            try {
              user = (await api(signedInResponse, '/api/me')).user;
            } catch (error) {
              if (error instanceof ConnectionError) {
                throw error;
              }

              if (!['/sign-in', '/setup'].includes(path)) {
                go('/sign-in');
              }

              return;
            }

            if (['/sign-in', '/setup'].includes(path)) {
              go('/');
            }

            if (manage && !administrator) {
              go('/');
            }
            await enter();
          } catch (error) {
            if (error instanceof ConnectionError) {
              retryStartup = true;
            }
            throw error;
          }
        },
        '',
        true,
      );
      if (!alive) {
        return;
      }
      loading = retryStartup;
      if (retryStartup && !get(connection).unavailable) {
        void start();
      }
    };
    const unsubscribe = connection.subscribe((state) => {
      if (alive && retryStartup && !state.unavailable && !busy) {
        void start();
      }
    });
    void start();

    return () => {
      alive = false;
      clearTimeout(slowTimer);
      unsubscribe();
      window.removeEventListener('popstate', pop);
    };
  });
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key !== 'Escape' || busy) return;

    if (pending) pending = null;
    else if (changing) closePassword();
    else if (regenerating) closeRegenerate();
  }}
/>

{#snippet link(href: string, label: string, current: boolean)}<a
    {href}
    aria-current={current ? 'page' : undefined}
    onclick={(e) => {
      e.preventDefault();
      void navigate(href);
    }}>{label}</a
  >{/snippet}

{#snippet chips(r: User)}
  {#if r.role === 'administrator'}<span class="chip admin">{t('administrator')}</span>{/if}
  {#if !r.enabled}<span class="chip muted">{t('user_disabled_status')}</span>{/if}
  {#if !r.has_password}<span class="chip alarm">{t('no_password')}</span>{/if}
  {#if r.connected}<span class="chip riding">{t('riding_now')}</span>{/if}
{/snippet}

{#snippet menu()}
  {#if user}
    <div class="me">
      <UserRow
        initials={initials(user)}
        photo={avatar ? `/api/me/avatar?v=${avatar}` : null}
        name={name(user)}
        detail={user.username}
      />
    </div>
    <nav class="menu" aria-label={t('main')}>
      {@render link('/activities', 'Activities', title === 'Activities')}
      {@render link('/profile', 'Profile', !manage && title === 'Profile')}
      {@render link('/climbs', 'Climbs', title === 'Climbs')}
      {@render link('/integrations', 'Integrations', path === '/integrations')}
      {@render link('/settings', 'Settings', path === '/settings')}
      {@render link('/apps', 'Apps', apps || installing || companion)}
      {#if administrator}
        <p class="group">{t('manage')}</p>
        {@render link('/manage', 'Users', manage && path !== '/manage/server' && !androidApps.includes(path))}
        {@render link('/manage/android', t('android_apps'), androidApps.includes(path))}
        {@render link('/manage/server', 'Server', path === '/manage/server')}
      {/if}
    </nav>
    <button class="sign-out" disabled={busy} onclick={() => run(signOut)}>{t('sign_out')}</button>
  {/if}
{/snippet}

<svelte:head><title>{loading ? t('zluggish') : t('document_title', { value1: title })}</title></svelte:head>

{#if loading && slowLoading && !$connection.unavailable}
  <div class="slow-loading" role="status">
    <p>{t('loading_taking_longer')}</p>
    <button type="button" onclick={() => location.reload()}>{t('reload_this_page')}</button>
  </div>
{/if}
<div class="app" class:initializing={loading && !$connection.unavailable}>
  <Layout
    {title}
    heading={!loading && !user && title !== 'Profile' && title !== 'Activities'}
    page={manage ? 'manage' : 'account'}
    back={loading ? undefined : back}
    crumb={loading ? undefined : crumb}
    onback={() => {
      const to = back ?? crumb;
      if (to) void navigate(to.href);
    }}
    {version}
    {zwiftVersion}
    menu={user ? menu : undefined}
    onhome={() => {
      void navigate('/');
    }}
  >
    {#if certificateMode === 'legacy'}
      <aside class="unsafe-banner" aria-label={t('unsafe_zwift_certificate')}>
        <p>
          <strong>{t('certificate_unsafe_notice')}</strong>
          {t('certificate_shared_warning')}
        </p>
        {#if administrator && path !== '/manage/server'}
          {@render link('/manage/server', 'Fix it on the Server page', false)}
        {/if}
      </aside>
    {/if}
    {#if message && !changing}<p class="notice" class:failed role={failed ? 'alert' : 'status'}>{message}</p>{/if}

    {#if loading}<span class="loading-status" role="status">{t('loading')}</span>
    {:else if !user}
      {#if path === '/setup' && complete}
        <section class="panel narrow">
          <p>{t('setup_complete')}</p>
          <button class="primary" onclick={() => navigate('/sign-in')}>{t('go_to_sign_in')}</button>
        </section>
      {:else}
        <form
          class="narrow"
          onsubmit={(e) => {
            e.preventDefault();
            void run(complete || keyAccepted ? signIn : checkKey, 'sign-in');
          }}
        >
          {#if !complete}
            <p class="lead">{t('setup_description')}</p>
            {#if keyAccepted}
              <div class="accepted" role="status">
                <span><span class="tick" aria-hidden="true">✓</span> {t('setup_key_accepted')}</span>
              </div>
              {#if setupUsers.length}
                <div
                  class="choice"
                  role="radiogroup"
                  aria-label={t('setup_method')}
                  onchange={() => {
                    password = '';
                    confirmPassword = '';
                  }}
                >
                  <label class:checked={mode === 'new'}
                    ><input type="radio" bind:group={mode} value="new" /> {t('create_a_new_user')}</label
                  >
                  <label class:checked={mode === 'existing'}
                    ><input type="radio" bind:group={mode} value="existing" /> {t('setup_existing_user_action')}</label
                  >
                </div>
              {/if}
            {:else}
              <TextField
                id="setup-key"
                label={t('setup_key')}
                bind:value={key}
                required
                maxlength={200}
                autocomplete="off"
                hint="Find it in the server console."
                errors={errors('sign-in', 'key')}
              />
            {/if}
            {#if keyAccepted && mode === 'new'}
              <TextField
                id="setup-first"
                label={t('first_name')}
                bind:value={first}
                required
                maxlength={50}
                errors={errors('sign-in', 'first_name')}
              />
              <TextField
                id="setup-last"
                label={t('last_name')}
                bind:value={last}
                maxlength={50}
                errors={errors('sign-in', 'last_name')}
              />
            {/if}
          {/if}
          {#if !complete && keyAccepted && mode === 'existing'}
            <div class="setup-picker">
              <label for="setup-user">{t('user_to_make_administrator')}</label>
              <select
                id="setup-user"
                bind:value={setupUserId}
                required
                onchange={() => {
                  password = '';
                }}
              >
                <option value={null} disabled>{t('user_select_placeholder')}</option>
                {#each setupUsers as r (r.player_id)}
                  <option value={r.player_id} disabled={!r.enabled || !r.has_password}>
                    {`${r.first_name} ${r.last_name}`.trim() || r.username} (#{r.player_id}, {r.username}){!r.enabled
                      ? ' — Disabled'
                      : !r.has_password
                        ? t('user_password_missing_suffix')
                        : ''}
                  </option>
                {/each}
              </select>
              {#if setupUsers.some((r) => !r.has_password)}
                <p class="muted">{t('setup_password_required_hint')}</p>
              {/if}
              {#if !setupUsers.some((r) => r.enabled && r.has_password)}
                <p class="muted">{t('setup_no_eligible_users')}</p>
              {/if}
            </div>
          {/if}
          {#if complete || keyAccepted}
            {#if complete || mode === 'new'}
              <TextField
                id="sign-in-login"
                label={t('login_name')}
                bind:value={username}
                autocomplete="username"
                required
                maxlength={254}
                errors={errors('sign-in', 'username')}
              />
            {/if}
            <TextField
              id="sign-in-password"
              label={!complete && mode === 'existing' ? 'User’s password' : 'Password'}
              password
              bind:value={password}
              autocomplete={complete || mode === 'existing' ? 'current-password' : 'new-password'}
              required
              maxlength={1024}
              errors={errors('sign-in', 'password')}
            />
            {#if !complete && mode === 'new'}
              <TextField
                id="setup-confirm"
                label={t('confirm_password')}
                password
                bind:value={confirmPassword}
                autocomplete="new-password"
                required
                errors={errors('sign-in', 'confirm')}
              />
            {/if}
          {/if}
          <button
            class="primary"
            disabled={busy || (!complete && keyAccepted && mode === 'existing' && setupUserId === null)}
            >{complete ? t('sign_in') : keyAccepted ? t('complete_setup') : t('check_key')}</button
          >
        </form>
      {/if}
    {:else if manage && administrator}
      <div>
        {#if path === '/manage/android'}
          <AndroidAppsManage {api} {navigate} />
        {:else if path === '/manage/companion'}
          <CompanionManage {api} {navigate} csrf={() => csrf} />
        {:else if path === '/manage/zwift-android'}
          <ZwiftAndroidManage {api} {navigate} csrf={() => csrf} />
        {:else if path === '/manage/server'}
          <ServerCertificate
            {api}
            {busy}
            {done}
            onstatus={(status) => {
              certificateMode = status.mode;
            }}
            confirm={(confirmation) => {
              pending = confirmation;
            }}
          />

          <section class="panel">
            <h2>{t('backups')}</h2>
            <p class="muted">{t('backup_retention_hint')}</p>
            <button disabled={busy || backingUp} onclick={() => void createBackup()}>{t('create_backup')}</button>
            {#if backupMessage}<p role="status">{backupMessage}</p>{/if}
          </section>

          <div class="columns">
            <section class="panel">
              <h2>{t('bots')}</h2>
              <div class="actions">
                <button
                  disabled={busy}
                  onclick={() =>
                    serverOperation(
                      'reload-bots',
                      'Reload bots',
                      'Bots restart with the current world settings.',
                      'Bots reloaded.',
                      false,
                    )}>{t('reload_bots')}</button
                >
              </div>
            </section>

            <form
              class="panel"
              onsubmit={(e) => {
                e.preventDefault();
                void run(sendBots, 'bots');
              }}
            >
              <h2>{t('bots')}</h2>
              {#if connected.length === 0}
                <p class="muted">{t('bots_no_active_riders')}</p>
              {:else}
                <label for="bot-user">{t('user')}</label>
                <select id="bot-user" bind:value={botUser} required>
                  <option value={null} disabled>{t('user_select_placeholder')}</option>
                  {#each connected as r (r.player_id)}<option value={r.player_id}>{name(r)}</option>{/each}
                </select>
                <label for="bot-command">{t('command')}</label>
                <select id="bot-command" bind:value={botCommand}>
                  {#each botCommands as [value, label] (value)}<option {value}>{label}</option>{/each}
                </select>
                {#if botCommand === 'peloton'}
                  <TextField
                    id="bot-argument"
                    label={t('peloton_size')}
                    bind:value={botArgument}
                    maxlength={3}
                    hint="0 to 200 bots, or off. Leave empty to see the current size."
                    errors={errors('bots', 'argument')}
                  />
                {/if}
                <button disabled={busy}>{t('send_to_bots')}</button>
              {/if}
            </form>
          </div>

          <section class="panel">
            <h2>{t('server_logs')}</h2>
            <ServerLogs load={() => api(serverLogsResponse, '/api/manage/server/logs')} />
          </section>

          <section class="panel">
            <h2>{t('world_settings')}</h2>
            {#if worldSettings.length === 0}
              <p class="muted">{t('worlds_empty')}</p>
            {:else}
              <div class="pills" role="group" aria-label={t('world_settings')}>
                {#each worldSettings as item (item.id)}<button
                    aria-pressed={worldSetting?.id === item.id}
                    onclick={() => {
                      worldSetting = item;
                      worldValues = Object.fromEntries(item.fields.map((f) => [f.name, f.value]));
                    }}>{item.id}</button
                  >{/each}
              </div>
            {/if}
            {#if worldSetting}
              <form
                class="inset"
                onsubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const result = await api(savedWorldSettingResponse, '/api/manage/settings', 'PATCH', {
                      id: worldSetting!.id,
                      revision: worldSetting!.revision,
                      operation,
                      values: worldValues,
                    });
                    worldSetting = { ...worldSetting!, ...result };
                    done('World settings saved. Reload bots to apply them.');
                  }, 'world');
                }}
              >
                <div class="grid">
                  {#each worldSetting.fields as { name: field, kind, value } (field)}
                    {#if kind === 'boolean'}<label class="check"
                        ><input
                          type="checkbox"
                          checked={value === true}
                          onchange={(e) => {
                            worldValues[field] = e.currentTarget.checked;
                          }}
                        />
                        {field}</label
                      >
                    {:else}<div>
                        <label for={`world-${field}`}>{field}</label><input
                          id={`world-${field}`}
                          type={kind === 'number' ? 'number' : 'text'}
                          step="any"
                          {value}
                          onchange={(e) => {
                            worldValues[field] =
                              kind === 'number' ? e.currentTarget.valueAsNumber : e.currentTarget.value;
                          }}
                        />
                      </div>{/if}
                  {/each}
                </div>
                <button disabled={busy}>{t('save_world_settings')}</button>
              </form>
            {/if}
          </section>

          <section class="panel">
            <h2>{t('events')}</h2>
            {#if events.length === 0}
              <p class="muted">{t('events_empty')}</p>
            {:else}
              <ul class="plain">
                {#each events as item (item.id)}<li>
                    <button
                      class="row"
                      aria-pressed={event?.id === item.id}
                      onclick={() => {
                        event = item;
                        eventDescription = item.description;
                        eventStart = item.eventStart;
                      }}
                      ><span>{item.name}</span><span class="num muted"
                        >{new Date(item.eventStart).toLocaleString()}</span
                      ></button
                    >
                  </li>{/each}
              </ul>
            {/if}
            {#if event}
              <form
                class="inset"
                onsubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await api(ignored, `/api/manage/events/${event!.id}`, 'PATCH', {
                      operation,
                      revision: event!.updateDate,
                      changes: { description: eventDescription, eventStart },
                    });
                    event = null;
                    events = (await api(eventsResponse, '/api/manage/events')).events;
                    done('Event saved.');
                  }, 'event');
                }}
              >
                <TextField id="event-description" label={t('description')} bind:value={eventDescription} />
                <TextField
                  id="event-start"
                  label={t('start_time_utc')}
                  bind:value={eventStart}
                  required
                  hint="For example 2026-11-20T18:00:00.000Z"
                  errors={errors('event', 'changes')}
                />
                <div class="actions">
                  <button disabled={busy}>{t('save_event')}</button>
                  <button
                    type="button"
                    class="danger"
                    disabled={busy}
                    onclick={() => {
                      const target = event!;
                      pending = {
                        title: `Delete ${target.name}?`,
                        detail: 'Invited users lose the event. This cannot be undone.',
                        label: 'Delete event',
                        destructive: true,
                        confirm: async () => {
                          await api(ignored, `/api/manage/events/${target.id}`, 'DELETE', {
                            operation,
                            revision: target.updateDate,
                          });
                          event = null;
                          events = (await api(eventsResponse, '/api/manage/events')).events;
                          done('Event deleted.');
                        },
                      };
                    }}>{t('delete_event')}</button
                  >
                </div>
              </form>
            {/if}
          </section>

          {#if serverConfig}
            <section class="panel">
              <h2>{t('configuration')}</h2>
              <dl class="config">
                {#each serverConfig.rows as [field, value] (field)}<div>
                    <dt>{field}</dt>
                    <dd class="num" class:muted={!value}>{value || t('not_set')}</dd>
                  </div>{/each}
              </dl>
            </section>
          {/if}
        {:else if path === '/manage/users/new'}
          <form
            class="panel wide"
            onsubmit={(e) => {
              e.preventDefault();
              void run(create, 'create');
            }}
          >
            <div class="pair">
              <TextField
                id="new-first"
                label={t('first_name')}
                bind:value={newFirst}
                required
                maxlength={50}
                errors={errors('create', 'first_name')}
              />
              <TextField
                id="new-last"
                label={t('last_name')}
                bind:value={newLast}
                maxlength={50}
                errors={errors('create', 'last_name')}
              />
            </div>
            <TextField
              id="new-login"
              label={t('login_name')}
              bind:value={newLogin}
              required
              maxlength={254}
              errors={errors('create', 'username')}
            />
            <div class="pair">
              <TextField
                id="new-password"
                label={t('password')}
                password
                bind:value={newPassword}
                autocomplete="new-password"
                required
                errors={errors('create', 'password')}
              />
              <TextField
                id="new-confirm"
                label={t('confirm_password')}
                password
                bind:value={newConfirm}
                autocomplete="new-password"
                required
                errors={errors('create', 'confirm')}
              />
            </div>
            <div class="actions">
              <button class="primary" disabled={busy}>{t('create_user')}</button>
              <button type="button" disabled={busy} onclick={() => navigate('/manage')}>{t('cancel')}</button>
            </div>
          </form>
        {:else if selectedId}
          {#if selected}
            <section class="panel summary" aria-label={t('account')}>
              <Avatar
                initials={initials(selected)}
                photo={selected.avatar ? `/api/manage/users/${selected.player_id}/avatar?v=${selected.avatar}` : null}
              />
              <div>
                <p class="login">{name(selected)}</p>
                <p>{selected.username}</p>
                <button type="button" disabled={busy} onclick={() => navigate(`/profile/${selected.player_id}`)}
                  >{t('edit_profile')}</button
                >
                <p class="facts">
                  <span class="chip muted num">{t('player_id', { value1: selected.player_id })}</span>
                  {@render chips(selected)}
                </p>
                {#if selected.completion_deadline}
                  <p class="muted">
                    {t('user_ride_save_deadline')}
                    <span class="num">{time(selected.completion_deadline)}</span>.
                  </p>
                {/if}
              </div>
            </section>

            {#if conflict}
              <div class="conflict" role="alert">
                <p>{t('user_conflict_notice')}</p>
                <dl class="config">
                  <div>
                    <dt>{t('name')}</dt>
                    <dd>{name(conflict)}</dd>
                  </div>
                  <div>
                    <dt>{t('login_name')}</dt>
                    <dd>{conflict.username}</dd>
                  </div>
                  <div>
                    <dt>{t('role')}</dt>
                    <dd>{conflict.role === 'administrator' ? t('administrator') : t('user')}</dd>
                  </div>
                  <div>
                    <dt>{t('account')}</dt>
                    <dd>{conflict.enabled ? t('user_enabled_status') : t('user_disabled_status')}</dd>
                  </div>
                </dl>
                <button
                  onclick={() => {
                    users = users.map((r) => (r.player_id === conflict!.player_id ? conflict! : r));
                    conflict = null;
                  }}>{t('user_conflict_resolve_action')}</button
                >
              </div>
            {/if}

            <div class="columns">
              {#if selected.player_id !== user.player_id}
                <form
                  class="panel"
                  class:password-needed={!selected.has_password}
                  onsubmit={(e) => {
                    e.preventDefault();
                    ask('password');
                  }}
                >
                  <h2>{selected.has_password ? t('password') : t('set_a_password')}</h2>
                  {#if !selected.has_password}<p class="muted">{t('password_required_hint')}</p>{/if}
                  <TextField
                    id="target-password"
                    label={t('new_password')}
                    password
                    bind:value={targetPassword}
                    autocomplete="new-password"
                    required
                    errors={errors('password', 'password')}
                  />
                  <TextField
                    id="target-confirm"
                    label={t('confirm_password')}
                    password
                    bind:value={targetConfirm}
                    autocomplete="new-password"
                    required
                    errors={errors('password', 'confirm')}
                  />
                  <button disabled={busy}>{t('set_password')}</button>
                </form>
              {:else}
                <section class="panel">
                  <h2>{t('password')}</h2>
                  <p class="muted">
                    {t('password_own_account_hint')}
                    {@render link('/profile', 'your profile', false)}.
                  </p>
                </section>
              {/if}

              <section class="panel">
                <h2>{t('access')}</h2>
                <ul class="plain access">
                  <li>
                    <div>
                      <h3>{t('sign_in_title')}</h3>
                      <p class="muted">
                        {selected.enabled ? t('user_enabled_status') : t('user_disabled_status')}
                      </p>
                    </div>
                    {#if selected.enabled}<button class="danger" disabled={busy} onclick={() => ask('disable')}
                        >{t('user_disable_action')}</button
                      >{:else}<button disabled={busy} onclick={() => ask('enable')}>{t('user_enable_action')}</button
                      >{/if}
                  </li>
                  <li>
                    <div>
                      <h3>{t('role')}</h3>
                      <p class="muted">
                        {selected.role === 'administrator' ? t('administrator') : t('user')}
                      </p>
                    </div>
                    <button class:danger={selected.role === 'administrator'} disabled={busy} onclick={() => ask('role')}
                      >{selected.role === 'administrator' ? t('remove_administrator') : t('make_administrator')}</button
                    >
                  </li>
                  <li>
                    <div>
                      <h3>{t('sessions')}</h3>
                      <p class="muted">{t('sign_out_scope_hint')}</p>
                    </div>
                    <button class="danger" disabled={busy} onclick={() => ask('revoke-sessions')}
                      >{t('sign_out_action')}</button
                    >
                  </li>
                </ul>
              </section>
            </div>
          {:else if !busy}
            <p class="empty">{t('user_not_found')} {@render link('/manage', 'Show all users', false)}</p>
          {/if}
        {:else}
          <div class="users-head">
            <div class="search">
              <label for="user-search">{t('search_users')}</label>
              <input
                id="user-search"
                type="search"
                bind:value={search}
                oninput={() => {
                  page = 0;
                }}
                placeholder={t('users_search_placeholder')}
              />
            </div>
            <button class="primary" disabled={busy} onclick={() => navigate('/manage/users/new')}
              >{t('create_user')}</button
            >
          </div>
          {#if users.length <= 1}
            <p class="empty">{t('users_empty')}</p>
          {/if}
          {#if filtered.length === 0 && users.length > 1}
            <p class="empty">{t('users_no_search_results')}</p>
          {/if}
          <ul class="plain list">
            {#each filtered.slice(page * pageSize, page * pageSize + pageSize) as r (r.player_id)}<li>
                <a
                  class="user"
                  href={`/manage/users/${r.player_id}`}
                  onclick={(e) => {
                    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    void run(() => openUser(r));
                  }}
                  ><span class="identity"
                    ><UserRow
                      initials={initials(r)}
                      photo={r.avatar !== null ? `/api/manage/users/${r.player_id}/avatar?v=${r.avatar}` : null}
                      name={label(r)}
                      detail={r.username}
                    /></span
                  ><span class="facts">{@render chips(r)}</span><span class="num muted id">#{r.player_id}</span><svg
                    class="go"
                    viewBox="0 0 24 24"
                    aria-hidden="true"><path d="M9.5 5.5 16 12l-6.5 6.5" /></svg
                  ></a
                >
              </li>{/each}
          </ul>
          {#if pages > 1}
            <div class="pager">
              <button disabled={page === 0} onclick={() => page--}>{t('previous')}</button>
              <span class="num muted">{t('page_of', { value1: page + 1, value2: pages })}</span>
              <button disabled={page + 1 >= pages} onclick={() => page++}>{t('next')}</button>
            </div>
          {/if}
        {/if}
      </div>
    {:else}
      {#if path === '/profile-data' || path === '/profile-data/local' || path === '/zwift'}
        {#key path}<ProfileData
            {path}
            request={api}
            {navigate}
            onuser={async () => {
              user = (await api(signedInResponse, '/api/me')).user;
            }}
          />{/key}
      {:else if path === '/' || path === '/activities' || path.startsWith('/activities/')}
        <Activities {path} {api} {go} />
      {:else if path === '/climbs'}
        <Climbs {api} />
      {:else if apps}
        <Apps {api} {navigate} {administrator} />
      {:else if installingPhone}
        <InstallPhone {api} {path} {navigate} {administrator} />
      {:else if installing}
        <Install
          {api}
          {path}
          {navigate}
          confirm={(confirmation) => {
            pending = confirmation;
          }}
        />
      {:else if companion}
        <Companion {api} {path} {navigate} {administrator} />
      {:else if path === '/settings'}
        {#if settings}
          <section class="panel narrow ghosts" aria-labelledby="ghosts-title">
            <h2 id="ghosts-title">{t('ghosts')}</h2>
            <label class="check"
              ><input type="checkbox" bind:checked={ghosts} disabled={busy} onchange={saveGhosts} />
              {t('ride_with_ghosts')}</label
            >
            <p class="muted">
              {t('ghosts_description_prefix')} <kbd>{t('regroup')}</kbd>
              {t('ghosts_regroup_hint_suffix')}
            </p>
          </section>
          <section class="panel narrow curves" aria-labelledby="curves-title">
            <h2 id="curves-title">{t('power_curves')}</h2>
            <p class="muted">{t('power_curves_rebuild_hint')}</p>
            <button
              type="button"
              bind:this={regenerateButton}
              disabled={busy}
              onclick={() => {
                rebuild = true;
                regenerating = true;
              }}>{t('regenerate_power_curves')}</button
            >
          </section>
        {/if}
      {:else if path === '/integrations'}
        {#if settings}
          <Connections
            {api}
            bind:stravaMethod
            bind:garminPhotos
            bind:garminDevice
            bind:intervalsUpload
            bind:bridgeFolder
            saved={preferences(settings)}
            save={saveSettings}
          />
        {/if}
      {:else}
        <form
          class="panel narrow"
          onsubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              applyProfile(
                await api(profileResponse, `${profileBase}/profile`, 'PATCH', {
                  revision: profileUser!.revision,
                  operation,
                  username,
                  first_name: first,
                  last_name: last,
                  birthday,
                }),
              );
              done('Profile saved. Restart Zwift for the changes to take effect.');
            }, 'profile');
          }}
        >
          <div class="photo">
            <button
              type="button"
              class="portrait"
              class:dropping
              aria-label={profileAvatar ? 'Change avatar' : 'Choose an avatar'}
              disabled={busy}
              onclick={() => avatarInput?.click()}
              ondragover={(e) => {
                e.preventDefault();
                dropping = true;
              }}
              ondragleave={() => (dropping = false)}
              ondrop={(e) => {
                e.preventDefault();
                dropping = false;
                uploadPhoto(e.dataTransfer?.files[0]);
              }}
              ><Avatar
                initials={initials(profileUser ?? user)}
                photo={profileAvatar ? `${profileBase}/avatar?v=${profileAvatar}` : null}
              /><span class="change" aria-hidden="true">{profileAvatar ? t('change') : t('choose')}</span></button
            >
            <div>
              <button type="button" disabled={busy} onclick={() => avatarInput?.click()}
                >{t('avatar_select_action')}</button
              >{#if profileAvatar}<button
                  type="button"
                  class="danger"
                  disabled={busy}
                  onclick={() =>
                    void run(async () => {
                      profileAvatar = (await api(avatarResponse, `${profileBase}/avatar`, 'DELETE')).avatar;
                      if (!profileId) avatar = profileAvatar;
                      done('Restart Zwift for the changes to take effect.');
                    })}>{t('remove')}</button
                >{/if}
            </div>
            <input
              bind:this={avatarInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              onchange={(e) => {
                uploadPhoto(e.currentTarget.files?.[0]);
                e.currentTarget.value = '';
              }}
            />
          </div>
          <div class="grid">
            <TextField
              id="profile-first"
              label={t('first_name')}
              bind:value={first}
              autocomplete="given-name"
              required
              maxlength={50}
              errors={errors('profile', 'first_name')}
            />
            <TextField
              id="profile-last"
              label={t('last_name')}
              bind:value={last}
              autocomplete="family-name"
              maxlength={50}
              errors={errors('profile', 'last_name')}
            />
          </div>
          <TextField
            id="profile-email"
            label={t('email')}
            bind:value={username}
            autocomplete="email"
            required
            maxlength={254}
            hint="You sign in with this in the game, the Companion app and here."
            errors={errors('profile', 'username')}
          />
          <TextField
            id="profile-birthday"
            label={t('birthday')}
            type="date"
            bind:value={birthday}
            errors={errors('profile', 'birthday')}
          />
          <div class="actions">
            <button class="primary" disabled={busy}>{t('save_profile')}</button>
            {#if !profileId}<button type="button" bind:this={changeButton} disabled={busy} onclick={openPassword}
                >{t('change_password')}</button
              >{/if}
            {#if profileId}<button type="button" onclick={() => navigate(`/manage/users/${profileId}`)}
                >{t('back_to_user_settings')}</button
              >{/if}
          </div>
        </form>
        {#if !profileId}
          <div class="actions">
            <button type="button" onclick={() => navigate('/profile-data')}>{t('import_export')}</button>
          </div>
        {/if}
      {/if}
    {/if}
  </Layout>
</div>

{#if changing && user}
  <div class="scrim">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="password-title"
      aria-describedby="password-detail"
      use:focusFirst
    >
      <h2 id="password-title">{t('change_password')}</h2>
      <p id="password-detail" class="muted">{t('password_sign_out_warning')}</p>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void run(changePassword, 'password');
        }}
      >
        {#if message && failed}<p class="notice failed" role="alert">{message}</p>{/if}
        {#if !administrator}
          <TextField
            id="own-current"
            label={t('current_password')}
            password
            bind:value={currentPassword}
            autocomplete="current-password"
            required
            errors={errors('password', 'current_password')}
          />
        {/if}
        <TextField
          id="own-new"
          label={t('new_password')}
          password
          bind:value={password}
          autocomplete="new-password"
          required
          errors={errors('password', 'password')}
        />
        <TextField
          id="own-confirm"
          label={t('confirm_new_password')}
          password
          bind:value={confirmPassword}
          autocomplete="new-password"
          required
          errors={errors('password', 'confirm')}
        />
        <div class="actions">
          <button type="button" disabled={busy} onclick={closePassword}>{t('cancel')}</button>
          <button class="primary" disabled={busy}>{t('change_password')}</button>
        </div>
      </form>
    </div>
  </div>
{/if}

{#if regenerating}
  <div class="scrim">
    <div
      class="dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="curves-dialog-title"
      aria-describedby="curves-dialog-detail"
    >
      <h2 id="curves-dialog-title">{t('power_curves_rebuild_confirm')}</h2>
      <p id="curves-dialog-detail">
        {#if rebuild}
          {t('power_curves_rebuild_description')}
        {:else}
          {t('power_curves_delete_warning')}
        {/if}
      </p>
      <label class="check"><input type="checkbox" bind:checked={rebuild} /> {t('power_curves_rebuild_source')}</label>
      <div class="actions">
        <!-- svelte-ignore a11y_autofocus (the safe choice takes focus when the dialog opens) -->
        <button autofocus disabled={busy} onclick={closeRegenerate}>{t('cancel')}</button>
        <button class="danger" disabled={busy} onclick={() => run(regenerate)}
          >{rebuild ? t('regenerate_power_curves') : t('delete_power_curves')}</button
        >
      </div>
    </div>
  </div>
{/if}

{#if pending}
  <div class="scrim">
    <div
      class="dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
      aria-describedby="dialog-detail"
    >
      <h2 id="dialog-title">{pending.title}</h2>
      <p id="dialog-detail">{pending.detail}</p>
      <div class="actions">
        <!-- svelte-ignore a11y_autofocus (the safe choice takes focus when the dialog opens) -->
        <button autofocus disabled={busy} onclick={() => (pending = null)}>{t('cancel')}</button>
        <button
          class={pending.destructive ? 'danger' : 'primary'}
          disabled={busy}
          onclick={() => {
            const chosen = pending!;
            pending = null;
            void run(chosen.confirm, chosen.label === 'Set password' ? 'password' : '');
          }}>{pending.label}</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .initializing {
    visibility: hidden;
  }
  .slow-loading {
    position: fixed;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 1rem;
    padding: 1.5rem;
    text-align: center;
  }
  .loading-status {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .me {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    min-width: 0;
    padding: 0.2rem 4rem 1.1rem 1.25rem;
    border-bottom: 1px solid var(--line);
  }
  .me :global(.who > span) {
    font-weight: 800;
  }
  .menu {
    flex-direction: column;
    flex-wrap: nowrap;
    gap: 0;
    margin: 0.75rem 0 0;
  }
  .menu :global(a),
  button.sign-out {
    display: block;
    width: 100%;
    margin: 0;
    padding: 0.85rem 1.25rem 0.85rem 1.5rem;
    border: 0;
    border-left: 4px solid transparent;
    border-radius: 0;
    font-size: 0.9375rem;
    text-align: left;
  }
  .menu :global(a:hover),
  button.sign-out:hover {
    background: rgb(255 255 255 / 0.08);
    text-decoration: none;
  }
  .menu :global(a[aria-current]) {
    border-left-color: var(--orange);
    background: var(--glass-raised);
  }
  .group {
    margin: 1.25rem 0 0.3rem 1.75rem;
    color: var(--muted);
    font-size: 0.8125rem;
  }
  button.sign-out {
    margin-top: auto;
    border-top: 1px solid var(--line);
    color: var(--muted);
  }

  .unsafe-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1.25rem;
    margin: 0 0 1rem;
    padding: 0.7rem 1rem;
    border-left: 4px solid #ff6b57;
    border-radius: 0 10px 10px 0;
    background: rgb(255 90 70 / 0.16);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
  .unsafe-banner p {
    margin: 0;
    color: var(--alarm);
  }
  .unsafe-banner strong {
    color: var(--text);
    font-weight: 800;
  }
  .unsafe-banner :global(a) {
    flex: none;
    font-weight: 800;
    white-space: nowrap;
    text-decoration-color: #ff6b57;
  }

  .panel {
    background: var(--glass);
    border-radius: 12px;
    padding: 1.25rem;
    margin: 0 0 1rem;
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
  .password-needed {
    outline: 2px solid var(--orange);
  }
  .narrow {
    max-width: 34rem;
  }

  .photo {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    margin-bottom: 1.25rem;
    padding-bottom: 1.25rem;
    border-bottom: 1px solid var(--line);
  }
  .photo button {
    margin-top: 0;
  }
  /* The user's circle, at the size the game shows it on the profile card. */
  button.portrait {
    position: relative;
    flex: none;
    margin: 6px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: none;
  }
  .portrait :global(.avatar) {
    width: 6.5rem;
    height: 6.5rem;
    font-size: 1.9rem;
    box-shadow: 0 0 0 5px var(--orange);
  }
  .change {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: rgb(12 18 26 / 0.62);
    font-size: 0.75rem;
    opacity: 0;
    transition: opacity 0.15s;
  }
  button.portrait:hover .change,
  button.portrait:focus-visible .change,
  button.portrait.dropping .change {
    opacity: 1;
  }
  button.portrait:hover {
    background: none;
  }
  button.portrait.dropping :global(.avatar) {
    box-shadow:
      0 0 0 5px var(--orange),
      0 0 0 11px rgb(226 86 12 / 0.35);
  }
  @media (max-width: 30rem) {
    .photo {
      flex-direction: column;
      align-items: flex-start;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .change {
      transition: none;
    }
  }
  .inset {
    background: none;
    padding: 1rem 0 0;
    margin: 1rem 0 0;
    border-top: 1px solid var(--line);
    border-radius: 0;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  h3 {
    margin: 0 0 0.25rem;
    font-size: 0.9375rem;
    font-weight: 800;
  }
  .lead {
    margin-top: 0;
  }
  .muted {
    color: var(--muted);
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .notice.failed {
    color: var(--alarm);
    border-left: 3px solid #ff6b57;
  }
  .empty {
    color: var(--muted);
    padding: 1rem 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .actions button {
    margin: 0.75rem 0 0;
  }
  button.danger {
    border-color: rgb(255 179 166 / 0.75);
    color: var(--alarm);
  }
  button.danger:hover {
    background: rgb(255 90 70 / 0.14);
  }

  .accepted {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 1rem;
    margin-bottom: 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--line);
  }
  .setup-picker {
    margin: 1rem 0;
  }
  .setup-picker p {
    margin: 0.35rem 0 0.75rem;
    font-size: 0.875rem;
  }
  .tick {
    color: var(--orange);
    font-weight: 700;
  }
  .choice {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .choice label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    padding: 0.65rem 0.8rem;
    border: 2px solid var(--line);
    border-radius: 10px;
    color: var(--text);
    cursor: pointer;
  }
  .choice label.checked {
    border-color: var(--orange);
    background: var(--glass-raised);
  }
  .choice input {
    flex: none;
    width: auto;
    margin: 0;
    accent-color: var(--orange);
  }
  label.check {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    color: var(--text);
  }
  .ghosts label.check {
    margin-top: 0;
  }
  .ghosts p {
    margin-bottom: 0;
  }
  .curves p {
    margin-top: 0;
  }
  .curves button {
    margin-top: 0.25rem;
  }
  .dialog label.check {
    margin: 1rem 0 0.25rem;
    cursor: pointer;
  }
  kbd {
    padding: 0.05rem 0.35rem;
    border: 1px solid var(--line);
    border-radius: 5px;
    background: var(--well);
    color: var(--text);
    font: inherit;
  }

  .users-head {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }
  .users-head .primary {
    margin: 0;
  }
  .search {
    flex: 0 1 28rem;
  }
  .search label {
    margin-top: 0;
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.9rem 0 1rem;
  }
  .pills button {
    margin: 0;
    padding: 0.35rem 0.85rem;
    border-width: 1px;
    border-color: var(--line);
    border-radius: 999px;
    font-size: 0.8125rem;
    text-transform: none;
    letter-spacing: 0;
    background: rgb(36 47 62 / 0.6);
  }
  .pills button[aria-pressed='true'] {
    border-color: var(--text);
    background: var(--glass-raised);
  }

  .plain {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .list li + li {
    margin-top: 0.4rem;
  }
  a.user,
  button.row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    margin: 0;
    padding: 0.5rem 0.75rem 0.5rem 0.6rem;
    border: 2px solid transparent;
    border-radius: 12px;
    background: var(--glass);
    box-sizing: border-box;
    color: var(--text);
    font-size: 0.9375rem;
    text-decoration: none;
    text-transform: none;
    letter-spacing: 0;
    text-align: left;
  }
  button.row {
    margin-top: 0.4rem;
    font-weight: 600;
  }
  a.user:hover,
  button.row:hover {
    background: var(--glass-raised);
    border-color: var(--orange);
  }
  a.user:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: 2px;
  }
  a.user .identity {
    flex: 1 1 auto;
  }
  a.user .id {
    flex: none;
    min-width: 3rem;
    font-size: 0.8125rem;
    text-align: right;
  }
  .go {
    flex: none;
    width: 1.25rem;
    height: 1.25rem;
    fill: none;
    stroke: var(--muted);
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  a.user:hover .go {
    stroke: var(--orange);
  }
  button.row[aria-pressed='true'] {
    background: var(--glass-raised);
    border-color: var(--text);
  }
  .identity {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    min-width: 0;
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    max-width: none;
  }
  /* The user page opens like the profile card in the game: the circle in Zwift orange, then who they are. */
  .summary {
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }
  .summary :global(.avatar) {
    flex: none;
    width: 5.5rem;
    height: 5.5rem;
    margin: 5px;
    font-size: 1.6rem;
    box-shadow: 0 0 0 5px var(--orange);
  }
  .summary p {
    margin: 0;
  }
  .summary .login {
    font-size: 1.0625rem;
    font-weight: 800;
    overflow-wrap: anywhere;
  }
  .summary .facts {
    justify-content: flex-start;
    margin: 0.5rem 0 0;
  }
  .summary .facts + p {
    margin-top: 0.6rem;
  }
  .pair {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: 0 1rem;
  }
  .wide {
    max-width: 44rem;
  }
  .columns > .panel {
    margin-bottom: 1rem;
  }
  .columns h2 + p {
    margin-top: 0;
  }
  .access li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.5rem 1rem;
    padding: 0.75rem 0;
    border-top: 1px solid var(--line);
  }
  .access li:first-child {
    padding-top: 0;
    border-top: 0;
  }
  .access p {
    margin: 0.1rem 0 0;
    font-size: 0.875rem;
  }
  .access button {
    margin: 0;
  }

  /* Status uses text and color together, never color alone. */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.1rem 0.55rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 800;
    white-space: nowrap;
  }
  .chip.admin {
    border-color: rgb(255 255 255 / 0.6);
  }
  .chip.muted {
    color: var(--muted);
  }
  .chip.alarm {
    border-color: rgb(255 179 166 / 0.6);
    color: var(--alarm);
  }
  .chip.alarm::before {
    content: '';
    width: 0.7rem;
    height: 0.6rem;
    background: currentColor;
    clip-path: polygon(50% 0, 100% 100%, 0 100%);
  }
  .chip.riding::before {
    content: '';
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--orange);
  }

  .pager {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .pager button {
    margin: 0;
  }

  .columns {
    display: grid;
    gap: 0 1rem;
  }
  @media (min-width: 52rem) {
    .columns {
      grid-template-columns: 1fr 1fr;
    }
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    gap: 0 1rem;
  }
  .config {
    display: grid;
    gap: 0.35rem;
    margin: 0.5rem 0 0;
  }
  .config div {
    display: grid;
    grid-template-columns: minmax(8rem, 1fr) minmax(0, 1.4fr);
    gap: 0.75rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--line);
  }
  .config dt {
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .config dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .conflict {
    margin: 0.75rem 0;
    padding: 0.75rem 0.9rem;
    border-left: 3px solid var(--text);
    background: var(--glass-raised);
    border-radius: 0 10px 10px 0;
  }
  .conflict p {
    margin-top: 0;
  }

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 10;
    display: grid;
    place-items: center;
    padding: 1rem;
    background: rgb(8 12 18 / 0.6);
  }
  .dialog {
    width: min(30rem, 100%);
    box-sizing: border-box;
    padding: 1.25rem 1.25rem 1rem;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: rgb(36 47 62 / 0.97);
    box-shadow: 0 18px 48px rgb(0 0 0 / 0.45);
    animation: rise 160ms ease-out;
  }
  .dialog h2 {
    text-transform: none;
    letter-spacing: 0;
    font-size: 1.125rem;
  }
  .dialog .actions {
    justify-content: flex-end;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }

  @media (max-width: 500px) {
    a.user .identity {
      flex: 1 0 100%;
    }
    a.user .id,
    .go {
      display: none;
    }
    .summary {
      flex-direction: column;
      align-items: flex-start;
      gap: 1rem;
    }
    .summary .facts {
      padding-left: 0;
    }
    .access li {
      grid-template-columns: 1fr;
    }
    .access button {
      justify-self: start;
    }
    .panel {
      padding: 0.9rem;
    }
    a.user {
      flex-wrap: wrap;
    }
    .facts {
      justify-content: flex-start;
      padding-left: 3.25rem;
    }
    .config div {
      grid-template-columns: 1fr;
      gap: 0.1rem;
    }
  }
</style>
