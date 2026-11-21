<script lang="ts">
  import { onMount } from 'svelte';
  import TextField from './TextField.svelte';
  import { z } from 'zod';
  import { ignored } from '../lib/api';
  import type { Api } from '../lib/api';

  let {
    api,
    stravaMethod = $bindable(),
    garminDevice = $bindable(),
    bridgeFolder = $bindable(),
    saved,
    save,
  }: {
    api: Api;
    stravaMethod: string;
    garminDevice: boolean;
    bridgeFolder: string;
    /** The settings the server holds, so a tile does not change before its choice is saved. */
    saved: { stravaMethod: string; garminDevice: boolean; bridgeFolder: string };
    save: () => Promise<void>;
  } = $props();

  type Provider = 'strava' | 'garmin' | 'intervals';

  type Integration = Provider | 'trainingpeaks';

  const connectionSchema = z.object({
    username: z.string(),
    saved: z.boolean(),
    unreadable: z.boolean(),
    authorized: z.boolean().optional(),
    cookie: z.boolean().optional(),
  });

  type Connection = z.infer<typeof connectionSchema>;

  const connectionsResponse = z.object({
    strava: connectionSchema,
    garmin: connectionSchema,
    intervals: connectionSchema,
  });

  const jobsResponse = z.object({
    jobs: z.array(z.object({ activity_id: z.number(), provider: z.string(), state: z.string() })),
  });

  type UploadJob = z.infer<typeof jobsResponse>['jobs'][number];

  type Credential =
    | 'strava/api'
    | 'strava/authorization'
    | 'strava/cookie'
    | 'garmin/credentials'
    | 'garmin/authorization';

  type Stored = { id: Credential; label: string; detail: string; effect: string };

  /** The Edge that the FIT file sent to Garmin Connect says it was recorded on. */
  type Device = { manufacturer: number; product: number; serial: number };

  const garminDevicesSchema = z.object({
    device: z.object({ manufacturer: z.number(), product: z.number(), serial: z.number() }).nullable(),
    devices: z.array(z.object({ product: z.number(), name: z.string() })),
  });

  type GarminDevices = z.infer<typeof garminDevicesSchema>;

  let connections = $state<Record<Provider, Connection> | null>(null);
  let secrets = $state<Record<Provider, string>>({ strava: '', garmin: '', intervals: '' });
  let cookie = $state('');
  let cookieStatus = $state<'unchecked' | 'checking' | 'valid' | 'invalid' | 'error'>('unchecked');

  async function testCookie() {
    cookieStatus = 'checking';

    try {
      const { valid } = await api(z.object({ valid: z.boolean() }), '/api/me/connections/strava/test', 'POST', {});
      cookieStatus = valid ? 'valid' : 'invalid';
    } catch {
      cookieStatus = 'error';
    }
  }

  /** The model chosen in the list, until it is saved; null shows the one that is saved. */
  let deviceProduct = $state<string | null>(null);
  let deviceSerial = $state('');

  let garminDevices = $state<GarminDevices | null>(null);

  const productChosen = $derived(deviceProduct ?? String(garminDevices?.device?.product ?? ''));

  async function loadDevice() {
    garminDevices = await api(garminDevicesSchema, '/api/me/connections/garmin/device');
  }

  const deviceName = (device: Device | null | undefined) =>
    device
      ? `${garminDevices?.devices.find((model) => model.product === device.product)?.name ?? `Product ${device.product}`} · serial number ${device.serial}`
      : 'None';

  function saveDevice() {
    void run(async () => {
      if (productChosen === '') {
        await api(ignored, '/api/me/connections/garmin/device', 'DELETE');
        message = 'Device removed.';
      } else {
        const product = Number(productChosen);

        if (deviceSerial.trim() === '') {
          await api(ignored, '/api/me/connections/garmin/device', 'PUT', { product });
        } else {
          await api(ignored, '/api/me/connections/garmin/device', 'PUT', { product, serial: Number(deviceSerial) });
        }

        message = 'Device saved.';
      }

      await loadDevice();
      deviceProduct = null;
      deviceSerial = '';
    });
  }

  /** The device is opt-in; the chosen model and serial number stay while the setting is off. */
  function saveDeviceSetting() {
    void run(async () => {
      try {
        await save();
      } catch (error) {
        garminDevice = saved.garminDevice;
        throw error;
      }

      message = 'Setting saved.';
    });
  }

  let code = $state('');
  let mfa = $state(false);
  let busy = $state(false);
  let message = $state('');
  let failed = $state(false);
  let where = $state<'integration' | 'uploads'>('integration');
  let jobs = $state<Array<UploadJob>>([]);
  let confirmUnknown = $state(false);
  let open = $state<Integration | null>(null);
  let removing = $state<Credential | null>(null);
  let dialog = $state<HTMLDialogElement>();

  /** Set on press, so dragging a text selection out of a field does not close the dialog on release. */
  let pressedBackdrop = false;

  const integrations: Array<{ name: Integration; title: string }> = [
    { name: 'strava', title: 'Strava' },
    { name: 'garmin', title: 'Garmin' },
    { name: 'intervals', title: 'Intervals.icu' },
    { name: 'trainingpeaks', title: 'TrainingPeaks' },
  ];

  const fields: Record<Provider, { username: string; secret: string }> = {
    strava: { username: 'Client ID', secret: 'Client secret' },
    garmin: { username: 'Email', secret: 'Password' },
    intervals: { username: 'Athlete ID', secret: 'API key' },
  };

  /** Connected means finished rides (or workouts) actually flow, not just that something was typed in. */
  function status(name: Integration, all: Record<Provider, Connection>) {
    if (name === 'trainingpeaks') {
      return saved.bridgeFolder ? { connected: true, text: 'Folder set' } : { connected: false, text: 'No folder set' };
    }

    const connection = all[name];

    const connected =
      name === 'strava'
        ? saved.stravaMethod === 'paid'
          ? Boolean(connection.authorized)
          : Boolean(connection.cookie) && cookieStatus === 'valid'
        : name === 'garmin'
          ? Boolean(connection.authorized)
          : connection.saved;

    return {
      connected,
      text: connected
        ? 'Connected'
        : name === 'strava' && saved.stravaMethod === 'free' && connection.cookie
          ? cookieStatus === 'invalid'
            ? 'Session expired or invalid'
            : 'Session saved · Not verified'
          : connection.unreadable
            ? 'Credentials unreadable · Enter them again'
            : connection.saved
              ? 'Credentials saved'
              : 'Not connected',
    };
  }

  async function run(action: () => Promise<void>, scope: 'integration' | 'uploads' = 'integration') {
    busy = true;
    message = '';
    failed = false;
    where = scope;

    try {
      await action();
      connections = await api(connectionsResponse, '/api/me/connections');
      jobs = (await api(jobsResponse, '/api/me/uploads')).jobs;
    } catch (error) {
      failed = true;
      message = error instanceof Error ? error.message : 'Could not save connection.';
    } finally {
      busy = false;
    }
  }

  function choose(name: Integration) {
    open = name;
    removing = null;
    message = '';
  }

  /** Escape, the close button and the backdrop all end here, so the page never shows a message meant for the dialog. */
  function closed() {
    open = null;
    removing = null;
    message = '';
  }

  // The Strava callback opens the dialog before connections load, so it waits until there is something to show.
  $effect(() => {
    if (open && connections && dialog && !dialog.open) {
      dialog.showModal();
    }
  });

  /** What the server holds for a provider, each removable on its own, and what stops working without it. */
  function stored(name: 'strava' | 'garmin', connection: Connection) {
    const items: Array<Stored> = [];

    if (name === 'strava') {
      if (connection.saved) {
        items.push({
          id: 'strava/api',
          label: 'API application',
          detail: 'Client ID and secret',
          effect: 'Authorizing again needs the client ID and secret.',
        });
      }

      if (connection.authorized) {
        items.push({
          id: 'strava/authorization',
          label: 'Authorization',
          detail: 'Access granted to your API application',
          effect: 'API uploads stop until you authorize again.',
        });
      }

      if (connection.cookie) {
        items.push({
          id: 'strava/cookie',
          label: 'Session cookie',
          detail: '_strava4_session',
          effect: 'Session cookie uploads stop until you save a new cookie.',
        });
      }

      return items;
    }

    if (connection.saved) {
      items.push({
        id: 'garmin/credentials',
        label: 'Email and password',
        detail: 'Garmin Connect sign-in',
        effect: 'Authorizing again needs your email and password.',
      });
    }

    if (connection.authorized) {
      items.push({
        id: 'garmin/authorization',
        label: 'Authorization',
        detail: 'Sign-in tokens from Garmin Connect',
        effect: 'Garmin uploads stop until you authorize again.',
      });
    }

    return items;
  }

  function removeCredential(item: Stored) {
    void run(async () => {
      await api(ignored, `/api/me/connections/${item.id}`, 'DELETE');

      if (item.id === 'strava/cookie') {
        cookieStatus = 'unchecked';
      }
      removing = null;

      if (item.id.startsWith('garmin/')) {
        mfa = false;
        code = '';
      }

      message = `${item.label} removed.`;
    });
  }

  function saveCredentials(name: Provider) {
    const connection = connections?.[name];

    if (!connection) {
      return;
    }
    void run(async () => {
      await api(ignored, `/api/me/connections/${name}`, 'PUT', {
        username: connection.username,
        secret: secrets[name],
      });
      secrets[name] = '';
      message = 'Credentials saved.';
    });
  }

  function saveMethod() {
    void run(async () => {
      try {
        await save();
      } catch (error) {
        stravaMethod = saved.stravaMethod;
        throw error;
      }

      message = 'Upload method saved.';
    });
  }

  function authorize(name: Provider) {
    void run(async () => {
      const result = await api(
        z.object({ url: z.string().optional(), status: z.string().optional() }),
        `/api/me/connections/${name}/authorize`,
        'POST',
        name === 'garmin' && mfa ? { code } : {},
      );

      if (result.url) {
        window.location.assign(result.url);

        return;
      }

      mfa = result.status === 'mfa';
      code = '';
      message = mfa ? 'Enter the verification code from Garmin.' : 'Authorized.';
    });
  }

  function disconnect(name: Provider) {
    void run(async () => {
      await api(ignored, `/api/me/connections/${name}`, 'DELETE');

      if (name === 'strava') {
        cookieStatus = 'unchecked';
      }
      removing = null;

      if (name === 'garmin') {
        mfa = false;
        code = '';
      }

      message = 'Disconnected.';
    });
  }

  function sync(provider: 'intervals' | 'trainingpeaks') {
    void run(async () => {
      message = (await api(z.object({ message: z.string() }), '/api/me/workouts/sync', 'POST', { provider })).message;
    });
  }

  function retry(ambiguous: boolean) {
    void run(async () => {
      await api(ignored, '/api/me/uploads/retry', 'POST', { ambiguous });
      confirmUnknown = false;
      message = 'Retry requested. Check the provider before retrying again.';
    }, 'uploads');
  }

  $effect(() => {
    if (!jobs.some((job) => ['pending', 'sending'].includes(job.state))) {
      return;
    }

    const timer = setInterval(() => {
      if (document.hidden) {
        return;
      }
      api(jobsResponse, '/api/me/uploads').then(
        (body) => (jobs = body.jobs),
        () => {
          /* The next tick tries again. */
        },
      );
    }, 5000);

    return () => clearInterval(timer);
  });

  onMount(() => {
    void run(async () => {
      const query = new URLSearchParams(window.location.search);

      if (query.has('state')) {
        const authorizationCode = query.get('code');
        const state = query.get('state') ?? '';
        history.replaceState(null, '', '/integrations');
        open = 'strava';

        if (!authorizationCode) {
          throw new Error('Strava authorization canceled.');
        }
        await api(ignored, '/api/me/connections/strava/authorize', 'POST', { code: authorizationCode, state });
        message = 'Strava authorized.';
      }
    }).then(() => {
      // Verification is not stored, so a saved session cookie is tested again whenever the page opens.
      if (connections?.strava.cookie && saved.stravaMethod === 'free') {
        void testCookie();
      }
      void loadDevice();
    });
  });
</script>

{#snippet credentials(name: Provider)}
  <form
    onsubmit={(event) => {
      event.preventDefault();
      saveCredentials(name);
    }}
  >
    <TextField
      id={`${name}-username`}
      label={fields[name].username}
      bind:value={connections![name].username}
      required
      maxlength={500}
    />
    <TextField
      id={`${name}-secret`}
      label={fields[name].secret}
      bind:value={secrets[name]}
      password
      required={!connections![name].saved || connections![name].unreadable}
      maxlength={10000}
      hint={connections![name].unreadable
        ? 'The saved credentials cannot be read. Enter them again.'
        : connections![name].saved
          ? 'Leave blank to keep the saved secret.'
          : undefined}
    />
    <button disabled={busy}>Save credentials</button>
  </form>
{/snippet}

{#snippet disconnectButton(name: Provider)}
  <button
    class="quiet"
    disabled={busy || !(connections![name].saved || connections![name].authorized || connections![name].cookie)}
    onclick={() => disconnect(name)}>Disconnect</button
  >
{/snippet}

{#snippet storedList(name: 'strava' | 'garmin')}
  {@const items = stored(name, connections![name])}
  {#if items.length}
    <h4>Saved on this server</h4>
    <ul class="stored">
      {#each items as item (item.id)}
        <li>
          <span class="what"><strong>{item.label}</strong><small>{item.detail}</small></span>
          {#if removing === item.id}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape keeps the credential) -->
            <div
              class="confirm"
              role="group"
              aria-label={`Remove ${item.label}`}
              onkeydown={(event) => {
                if (event.key !== 'Escape') return;
                // Cancelling the keydown stops the dialog closing too, so Escape backs out one step at a time.
                event.preventDefault();
                removing = null;
              }}
            >
              <p>Remove the {item.label.toLowerCase()}? {item.effect}</p>
              <button
                class="danger"
                disabled={busy}
                {@attach (node) => node.focus()}
                onclick={() => removeCredential(item)}>Remove</button
              >
              <button class="quiet" disabled={busy} onclick={() => (removing = null)}>Keep</button>
            </div>
          {:else}
            <button class="quiet" disabled={busy} onclick={() => (removing = item.id)}
              >Remove<span class="visually-hidden"> {item.label.toLowerCase()}</span></button
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

<section class="integrations" aria-labelledby="integrations-title">
  <h2 id="integrations-title">Integrations</h2>
  <p class="lead">Send finished rides to the apps you train with, and bring planned workouts into Zwift.</p>
  {#if message && where === 'integration' && (!open || !connections)}<p
      class="notice"
      class:failed
      role={failed ? 'alert' : 'status'}
    >
      {message}
    </p>{/if}
  {#if connections}
    <div class="tiles">
      {#each integrations as integration (integration.name)}
        {@const current = status(integration.name, connections)}
        <button type="button" class="tile" aria-haspopup="dialog" onclick={() => choose(integration.name)}>
          <span class="box" class:on={current.connected} aria-hidden="true">
            {#if current.connected}<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" /></svg>{/if}
          </span>
          <span class="name">{integration.title}</span>
          <span class="state">{current.text}</span>
        </button>
      {/each}
    </div>
  {/if}
</section>

<dialog
  class="integration"
  aria-labelledby="integration-title"
  bind:this={dialog}
  onclose={closed}
  onpointerdown={(event) => (pressedBackdrop = event.target === dialog)}
  onclick={(event) => {
    if (pressedBackdrop && event.target === dialog) dialog?.close();
  }}
>
  {#if open && connections}
    {@const current = status(open, connections)}
    <header>
      <span class="box" class:on={current.connected} aria-hidden="true">
        {#if current.connected}<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" /></svg>{/if}
      </span>
      <h3 id="integration-title" class="name">{integrations.find((item) => item.name === open)!.title}</h3>
      <span class="state">{current.text}</span>
      <button type="button" class="close" aria-label="Close" onclick={() => dialog?.close()}
        ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg></button
      >
    </header>
    <div class="body">
      {#if message && where === 'integration'}<p class="notice" class:failed role={failed ? 'alert' : 'status'}>
          {message}
        </p>{/if}

      {#if open === 'strava'}
        <p class="muted">Upload finished rides to Strava, through your own API application or a browser session.</p>
        <label for="strava-method">Upload method</label>
        <select id="strava-method" bind:value={stravaMethod} disabled={busy} onchange={saveMethod}>
          <option value="paid">Strava API application</option>
          <option value="free">Browser session cookie</option>
        </select>
        {#if stravaMethod === 'paid'}
          {@render credentials('strava')}
          <p class="muted">Set your Strava API application's callback domain to this website's hostname.</p>
          <div class="actions">
            <button disabled={busy || !connections.strava.saved} onclick={() => authorize('strava')}>Authorize</button>
            {@render disconnectButton('strava')}
          </div>
        {:else}
          <details class="cookie-help">
            <summary>How to get your Strava session cookie</summary>
            <p class="muted">In Chrome or Edge:</p>
            <ol>
              <li>Open <a href="https://www.strava.com" target="_blank" rel="noreferrer">Strava</a> and sign in.</li>
              <li>
                Open Developer Tools with <kbd>⌘⌥I</kbd> on Mac or <kbd>Ctrl+Shift+I</kbd> on Windows/Linux.
              </li>
              <li>Select <strong>Application</strong>. If hidden, look under <strong>»</strong>.</li>
              <li>
                In the sidebar, expand <strong>Storage → Cookies</strong> and select
                <strong>https://www.strava.com</strong>.
              </li>
              <li>
                Find <code>_strava4_session</code> and copy its entire <strong>Value</strong>, without the cookie name
                or quotes.
              </li>
              <li>
                Paste the value below and click <strong>Save session cookie</strong>. We'll test it automatically.
              </li>
            </ol>
            <p class="muted">
              Treat the cookie like a password. Don't share it or paste it into chat. If the session test later fails,
              repeat these steps to replace it.
            </p>
          </details>
          <form
            onsubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await api(ignored, '/api/me/connections/strava/cookie', 'PUT', { cookie });
                cookie = '';
                message = 'Session cookie saved.';
                await testCookie();
              });
            }}
          >
            <TextField
              id="strava-cookie"
              label="_strava4_session"
              bind:value={cookie}
              password
              required
              maxlength={10000}
              hint={connections.strava.cookie
                ? 'A session cookie is saved. Paste a new one to replace it.'
                : 'Copy it from your browser while signed in to Strava. Treat it like a password.'}
            />
            <button disabled={busy}>{cookieStatus === 'checking' ? 'Testing session…' : 'Save session cookie'}</button>
          </form>
          {#if connections.strava.cookie || cookieStatus !== 'unchecked'}
            <div
              class="cookie-status"
              class:valid={cookieStatus === 'valid'}
              class:invalid={cookieStatus === 'invalid' || cookieStatus === 'error'}
              role="status"
              aria-live="polite"
            >
              {#if cookieStatus === 'valid'}
                <span class="cookie-check" aria-hidden="true">✓</span>
                <span
                  ><strong>Strava session verified</strong><br />Your cookie works. Finished rides can upload to Strava.</span
                >
              {:else if cookieStatus === 'checking'}
                <span>Checking your session with Strava…</span>
              {:else if cookieStatus === 'invalid'}
                <span
                  ><strong>Session expired or invalid</strong><br />Copy a fresh cookie from Strava and save it again.</span
                >
              {:else if cookieStatus === 'error'}
                <span
                  ><strong>Couldn't verify your session</strong><br />Your cookie is saved. Try Test session again when
                  Strava is reachable.</span
                >
              {:else}
                <span>Cookie saved. Use Test session to confirm it works with Strava.</span>
              {/if}
            </div>
          {/if}
          <div class="actions">
            <button disabled={busy || !connections.strava.cookie} onclick={() => void run(testCookie)}
              >{cookieStatus === 'checking' ? 'Testing session…' : 'Test session'}</button
            >
            {@render disconnectButton('strava')}
          </div>
        {/if}
        {@render storedList('strava')}
      {:else if open === 'garmin'}
        <p class="muted">Upload finished rides to Garmin Connect.</p>
        {@render credentials('garmin')}
        {#if mfa}<TextField id="garmin-code" label="Verification code" bind:value={code} maxlength={32} />{/if}
        <div class="actions">
          <button disabled={busy || !connections.garmin.saved} onclick={() => authorize('garmin')}
            >{mfa ? 'Verify Garmin' : 'Authorize'}</button
          >
          {@render disconnectButton('garmin')}
        </div>
        {@render storedList('garmin')}
        <h3>Device in the FIT file</h3>
        <label class="check"
          ><input type="checkbox" bind:checked={garminDevice} disabled={busy} onchange={saveDeviceSetting} /> Record rides
          on a Garmin Edge</label
        >
        <p class="muted">Off by default: Garmin then gets the FIT file exactly as the game writes it.</p>
        {#if garminDevice}
          <p class="muted">
            Garmin Connect gets each ride as recorded on this Edge. Strava and the other services get the file of the
            game. Now: {deviceName(garminDevices?.device)}.
          </p>
          <label class="field" for="garmin-device"
            >Model
            <select
              id="garmin-device"
              value={productChosen}
              disabled={busy}
              onchange={(event) => (deviceProduct = event.currentTarget.value)}
            >
              <option value="">None: send the file of the game</option>
              {#each garminDevices?.devices ?? [] as model (model.product)}
                <option value={String(model.product)}>{model.name}</option>
              {/each}
            </select>
          </label>
          <TextField
            id="garmin-serial"
            label="Serial number"
            bind:value={deviceSerial}
            maxlength={10}
            hint="Leave empty to keep the current one, or to get a number of your own."
          />
          <div class="actions">
            <button disabled={busy} onclick={saveDevice}>Save device</button>
          </div>
        {/if}
      {:else if open === 'intervals'}
        <p class="muted">
          Upload finished rides and bring your planned cycling workouts into Zwift. Find the athlete ID and API key
          under Developer Settings on Intervals.icu.
        </p>
        {@render credentials('intervals')}
        <div class="actions">
          <button disabled={busy || !connections.intervals.saved} onclick={() => sync('intervals')}
            >Sync workouts</button
          >
          {@render disconnectButton('intervals')}
        </div>
      {:else}
        <p class="muted">
          Import workouts you export from TrainingPeaks as .zwo files. The server reads them from this folder.
        </p>
        <form
          onsubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await save();
              message = 'Export folder saved.';
            });
          }}
        >
          <TextField id="bridge-folder" label="Export folder" bind:value={bridgeFolder} maxlength={500} />
          <button disabled={busy}>Save folder</button>
        </form>
        <div class="actions">
          <button disabled={busy || !saved.bridgeFolder} onclick={() => sync('trainingpeaks')}>Import workouts</button>
        </div>
      {/if}
    </div>
  {/if}
</dialog>

{#if connections}
  <section class="detail uploads" aria-labelledby="uploads-title">
    <h2 id="uploads-title">Activity uploads</h2>
    {#if message && where === 'uploads'}<p class="notice" class:failed role={failed ? 'alert' : 'status'}>
        {message}
      </p>{/if}
    {#if jobs.length}
      <ul>
        {#each jobs as job (`${job.activity_id}-${job.provider}`)}<li>
            Activity {job.activity_id}: {job.provider} — {job.state}
          </li>{/each}
      </ul>
    {:else}
      <p class="muted">No activity uploads yet.</p>
    {/if}
    <button disabled={busy || !jobs.some((job) => job.state === 'failed')} onclick={() => retry(false)}
      >Retry failed uploads</button
    >
    {#if jobs.some((job) => job.state === 'ambiguous')}
      <p class="muted">The provider may already have activities whose upload result is unknown.</p>
      <label class="check"
        ><input type="checkbox" bind:checked={confirmUnknown} /> I checked the provider and want to upload them again</label
      >
      <button disabled={busy || !confirmUnknown} onclick={() => retry(true)}
        >Retry uploads with an unknown result</button
      >
    {/if}
  </section>
{/if}

<style>
  .cookie-status {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 1rem;
    padding: 0.9rem;
    border: 1px solid var(--line);
    border-radius: 10px;
  }
  .cookie-status.valid {
    color: #a7f3c1;
    border-color: #4ade80;
    background: rgb(34 197 94 / 0.12);
  }
  .cookie-status.invalid {
    color: var(--alarm);
    border-color: var(--alarm);
  }
  .cookie-check {
    display: grid;
    place-items: center;
    flex: none;
    width: 2rem;
    height: 2rem;
    border-radius: 6px;
    background: #15803d;
    color: white;
    font-size: 1.5rem;
    font-weight: 800;
  }
  .cookie-help {
    margin: 1rem 0;
  }
  .cookie-help summary {
    cursor: pointer;
    font-weight: 600;
  }
  .cookie-help ol {
    padding-left: 1.5rem;
  }
  .cookie-help li + li {
    margin-top: 0.5rem;
  }

  /* Panels match the settings panels: 34rem of content plus padding. */
  .detail {
    max-width: 34rem;
  }
  .integrations {
    max-width: 36.5rem;
    margin: 0 0 1rem;
  }
  .lead {
    margin: 0 0 1rem;
  }

  /* Laid out like the game's pairing screen: one tile per service, ticked once it is live. */
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    gap: 0.5rem;
  }
  button.tile {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 0.65rem;
    align-items: center;
    margin: 0;
    padding: 0.8rem 0.9rem;
    border: 2px solid var(--line);
    border-radius: 10px;
    background: var(--glass);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
    text-align: left;
    text-transform: none;
    letter-spacing: 0;
  }
  button.tile:hover {
    border-color: rgb(255 255 255 / 0.45);
    background: var(--glass-raised);
  }
  .box {
    grid-row: span 2;
    display: grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    box-sizing: border-box;
    border: 2px solid rgb(255 255 255 / 0.55);
    border-radius: 4px;
  }
  .box.on {
    border-color: var(--orange);
    background: var(--orange);
  }
  .box svg {
    width: 0.9rem;
    height: 0.9rem;
    fill: none;
    stroke: var(--text);
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .name {
    font-size: 0.9375rem;
    font-weight: 800;
  }
  .state {
    grid-column: 2;
    color: var(--muted);
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .detail {
    margin: 0.75rem 0 1rem;
    padding: 1.25rem;
    border-radius: 12px;
    background: var(--glass);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }

  /* The dialog rises over the dimmed page. Its header repeats the tile, so the tick lands where you are looking. */
  dialog.integration {
    width: min(36rem, calc(100vw - 2rem));
    max-width: none;
    max-height: calc(100dvh - 2rem);
    box-sizing: border-box;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: rgb(26 36 50 / 0.97);
    color: var(--text);
    box-shadow: 0 24px 64px rgb(0 0 0 / 0.5);
    overflow: hidden;
  }
  dialog.integration[open] {
    display: flex;
    flex-direction: column;
    animation: rise 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  dialog.integration::backdrop {
    background: rgb(8 12 18 / 0.6);
    -webkit-backdrop-filter: blur(3px);
    backdrop-filter: blur(3px);
  }
  :global(html:has(dialog.integration[open])) {
    overflow: hidden;
  }
  header {
    flex: none;
    display: grid;
    grid-template-columns: auto 1fr auto;
    column-gap: 0.8rem;
    align-items: center;
    padding: 1rem 1rem 1rem 1.25rem;
    border-bottom: 1px solid var(--line);
    background: rgb(62 78 98 / 0.35);
  }
  header .box {
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 5px;
  }
  header .box svg {
    width: 1.1rem;
    height: 1.1rem;
    animation: tick 260ms cubic-bezier(0.3, 1.6, 0.5, 1);
  }
  header h3 {
    margin: 0;
    font-size: 1.25rem;
    line-height: 1.2;
  }
  button.close {
    grid-column: 3;
    grid-row: 1 / span 2;
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    margin: 0;
    padding: 0;
    border: 2px solid rgb(255 255 255 / 0.7);
    border-radius: 50%;
  }
  button.close:hover {
    border-color: var(--orange);
  }
  button.close svg {
    width: 1.3rem;
    height: 1.3rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.4;
    stroke-linecap: round;
  }
  .body {
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.5rem 1.25rem 1.25rem;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(0.75rem) scale(0.98);
    }
  }
  @keyframes sheet {
    from {
      transform: translateY(100%);
    }
  }
  @keyframes tick {
    from {
      transform: scale(0.4);
    }
  }

  /* Forms sit inside the dialog, so they drop their own glass. */
  .body form {
    margin: 0;
    padding: 0;
    background: none;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.5rem;
    margin-top: 0.75rem;
    padding-top: 0.25rem;
    border-top: 1px solid var(--line);
  }
  .actions button {
    margin-right: 0;
  }
  button.quiet {
    border-color: var(--line);
    color: var(--muted);
  }
  .body h4 {
    margin: 1.25rem 0 0.4rem;
    font-size: 0.9375rem;
    font-weight: 800;
  }

  .stored {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .stored li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0 0.75rem;
    padding: 0.45rem 0;
    border-top: 1px solid var(--line);
  }
  .stored li:last-child {
    border-bottom: 1px solid var(--line);
  }
  .stored .what {
    display: grid;
    min-width: 0;
  }
  .stored small {
    color: var(--muted);
    font-size: 0.8125rem;
  }
  .stored li > button {
    margin: 0;
    padding: 0.3rem 0.8rem;
    font-size: 0.75rem;
  }
  .confirm {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
    padding: 0.6rem 0.75rem;
    border-left: 3px solid #ff6b57;
    border-radius: 0 8px 8px 0;
    background: rgb(255 90 70 / 0.12);
  }
  .confirm p {
    flex: 1 1 100%;
    margin: 0;
  }
  .confirm button {
    margin: 0;
  }
  button.danger {
    border-color: rgb(255 179 166 / 0.75);
    color: var(--alarm);
  }
  button.danger:hover {
    background: rgb(255 90 70 / 0.14);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .uploads {
    margin-top: 2rem;
  }
  .uploads ul {
    padding-left: 1.1rem;
  }
  label.check {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    color: var(--text);
  }
  .muted {
    color: var(--muted);
  }
  .notice.failed {
    color: var(--alarm);
  }

  @media (max-width: 500px) {
    .detail {
      padding: 0.9rem;
    }
    /* On a phone the dialog is a sheet from the bottom edge, in reach of the thumb. */
    dialog.integration {
      width: 100%;
      max-height: 92dvh;
      margin: auto 0 0;
      border-width: 1px 0 0;
      border-radius: 16px 16px 0 0;
    }
    dialog.integration[open] {
      animation-name: sheet;
    }
    .body {
      padding: 0.25rem 1rem calc(1rem + env(safe-area-inset-bottom));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    dialog.integration[open],
    header .box svg {
      animation: none;
    }
  }
</style>
