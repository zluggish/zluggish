<script lang="ts">
  import { t } from '../lib/i18n/index';
  import SlowLoading from '../components/SlowLoading.svelte';
  import { onMount } from 'svelte';
  import Fingerprint from '../components/Fingerprint.svelte';
  import { tlsStatus } from './tls';
  import type { TlsStatus } from './tls';
  import type { Api } from '../lib/api';
  import { detect } from './device';

  type Confirmation = {
    title: string;
    detail: string;
    label: string;
    destructive: boolean;
    confirm: () => Promise<void>;
  };

  let {
    api,
    path,
    navigate,
    confirm,
  }: {
    api: Api;
    /** `/install` sets up this browser's own system; `/install/windows`, `/install/macos` and `/install/linux` set
    up that system, and `/install/manual` shows the certificate and hosts line for any system. Any other path is the
    Apps page's to show. */
    path: string;
    navigate: (path: string) => Promise<void>;
    confirm: (confirmation: Confirmation) => void;
  } = $props();

  type Platform = 'windows' | 'macos' | 'linux';

  const systems: Array<{ id: Platform; name: string }> = [
    { id: 'windows', name: t('windows') },
    { id: 'macos', name: t('macos') },
    { id: 'linux', name: t('linux') },
  ];

  const here = detect();

  const platform = $derived(
    systems.find((system) => path === `/install/${system.id}` || (path === '/install' && system.id === here)) ?? null,
  );

  const manual = $derived(path === '/install/manual');

  let status = $state<TlsStatus | null>(null);
  let failure = $state('');
  let redirect = $state(true);
  let advanced = $state(false);

  let address = $state('');

  const looksLikeIp = (value: string) =>
    /^(\d{1,3}\.){3}\d{1,3}$/.test(value) || (value.includes(':') && /^[\da-f:.]+$/i.test(value));

  const addressError = $derived(
    !redirect
      ? ''
      : !address.trim()
        ? t('desktop_setup_address_hint')
        : looksLikeIp(address.trim())
          ? ''
          : t('desktop_setup_address_validation_error'),
  );

  /** The rider typed over the address the server advertises, so offer it back. */
  const changed = $derived(!!status?.serverAddress && address.trim() !== status.serverAddress);

  function reset() {
    const server = status?.serverAddress ?? '';

    confirm({
      title: t('desktop_setup_address_reset_action'),
      detail: t('desktop_setup_address_auto_hint', { value1: server }),
      label: t('reset'),
      destructive: false,
      confirm: async () => {
        address = server;
      },
    });
  }

  /** The names the setup script points at the server; keep in step with `zwiftHostNames` in the server. */
  const zwiftHosts = ['us-or-rly101.zwift.com', 'secure.zwift.com', 'cdn.zwift.com', 'launcher.zwift.com'];

  const target = $derived(looksLikeIp(address.trim()) ? address.trim() : (status?.serverAddress ?? ''));
  const hostsLine = $derived(`${target} ${zwiftHosts.join(' ')}`);

  const script = $derived(
    `/api/tls/setup/${platform?.id ?? 'windows'}?${new URLSearchParams({ address: redirect ? address.trim() : '' })}`,
  );

  const installable = $derived(status?.mode === 'managed' || status?.mode === 'custom');

  /** The file name the server gives the shell script, so the page can show the exact command to run. */
  const command = $derived.by(() => {
    const thumbprint = status?.certificate?.thumbprint ?? '';
    const file = `zluggish-zwift-${thumbprint.slice(0, 8).toLowerCase()}.sh`;

    return `sh ~/Downloads/${file}`;
  });

  /** Browsers allow the clipboard only on HTTPS or localhost; elsewhere the command is there to select. */
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard;
  let copied = $state('');

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    copied = text;
    setTimeout(() => (copied = ''), 2000);
  }

  function go(event: MouseEvent, to: string) {
    event.preventDefault();
    void navigate(to);
  }

  const day = (iso: string) => new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });

  onMount(async () => {
    try {
      status = await api(tlsStatus, '/api/tls');
      // The advertised IP as the server is configured, even 127.0.0.1: the web app's own address may differ.
      address = status.serverAddress;
    } catch (error) {
      failure = error instanceof Error ? error.message : t('desktop_setup_certificate_load_error');
    }
  });
</script>

{#if failure}<p class="notice failed" role="alert">{failure}</p>{/if}
{#if status === null}
  {#if !failure}<SlowLoading />{/if}
{:else if status.mode === 'legacy'}
  <section class="panel">
    <p>{t('desktop_setup_certificate_shared_hint')}</p>
  </section>
{/if}

{#if status && installable && status.certificate && manual}
  <section class="panel" aria-label={t('manual_setup')}>
    <p class="lede">{t('desktop_setup_description')}</p>

    <h2>{t('certificate')}</h2>
    <ul class="files">
      <li>
        <a class="file" href="/api/tls/certificate" download>{t('download_crt')}</a>
        <span class="hint">{t('desktop_setup_certificate_pem_format_hint')}</span>
      </li>
      <li>
        <a class="file" href="/api/tls/certificate?format=der" download>{t('download_cer')}</a>
        <span class="hint">{t('desktop_setup_certificate_windows_format_hint')}</span>
      </li>
    </ul>
    <p class="hint">{t('desktop_setup_certificate_verify_hint')}</p>
    <div class="prints">
      <Fingerprint label={t('thumbprint_sha_1')} value={status.certificate.thumbprint} />
      <Fingerprint label={t('fingerprint_sha_256')} value={status.certificate.fingerprint256} />
    </div>
    <p class="hint">{t('valid_until', { value1: day(status.certificate.notAfter) })}</p>

    {#if target}
      <h2>{t('hosts_file')}</h2>
      <p>{t('desktop_setup_hosts_edit_hint')}</p>
      {@render line(hostsLine)}
      <p class="hint">{t('desktop_setup_hosts_path_hint')}</p>
    {/if}
  </section>
{:else if status && installable && status.certificate && platform}
  <section class="panel" aria-label={`${platform.name} setup steps`}>
    <ol class="walk">
      <li>
        <div class="setup-actions">
          {#if addressError}
            <button class="primary" type="button" disabled>{t('download_setup_script')}</button>
          {:else}
            <a class="download" href={script} download>{t('download_setup_script')}</a>
          {/if}
          <button
            class="advanced-toggle"
            type="button"
            aria-expanded={advanced}
            aria-controls="install-advanced"
            onclick={() => (advanced = !advanced)}
            >{advanced ? t('hide_advanced_settings') : t('advanced_settings')}</button
          >
        </div>
        {#if addressError && !advanced}
          <p class="hint failed" role="alert">{addressError}</p>
        {/if}
        <div id="install-advanced" class="advanced-settings" hidden={!advanced}>
          <label class="check"><input type="checkbox" bind:checked={redirect} /> {t('patch_hosts_file')}</label>
          {#if redirect}
            <label for="install-address">{t('server_ip_address')}</label>
            <div class="address">
              <input
                id="install-address"
                bind:value={address}
                inputmode="decimal"
                autocomplete="off"
                spellcheck="false"
                maxlength={45}
                aria-invalid={!!addressError}
                aria-describedby="install-address-hint"
              />
              {#if changed}
                <button type="button" class="reset" aria-haspopup="dialog" onclick={reset}>{t('reset')}</button>
              {/if}
            </div>
            <p id="install-address-hint" class="hint" class:failed={!!addressError}>
              {addressError || t('desktop_setup_address_description')}
            </p>
          {:else}
            <p class="hint">{t('desktop_setup_hosts_description')}</p>
          {/if}
        </div>
      </li>
      <li>
        <h2>{t('setup_script_run_title')}</h2>
        {#if platform.id === 'windows'}
          <p>
            {t('download_open_hint_prefix')} <strong>{t('bat')}</strong>
            {t('desktop_setup_windows_permission_hint_suffix')}
          </p>
          <p class="hint">
            {t('desktop_setup_windows_smart_screen_hint')} <strong>{t('more_info')}</strong>{t('then')}
            <strong>{t('run_anyway')}</strong>.
          </p>
        {:else}
          <p>
            {platform.id === 'macos' ? t('macos_terminal_command_hint') : t('terminal_command_hint')}
          </p>
          {@render line(command)}
          <p class="hint">
            {platform.id === 'macos'
              ? t('desktop_setup_macos_permission_hint')
              : t('desktop_setup_linux_permission_hint')}
          </p>
        {/if}
      </li>
      <li>
        <h2>{t('start_zwift')}</h2>
        <p>
          {t('setup_script_completion_hint')} <strong>{t('done')}</strong>{t('desktop_setup_launch_hint', {
            value1:
              platform.id === 'linux'
                ? t('desktop_setup_linux_close_hint')
                : platform.id === 'macos'
                  ? t('desktop_setup_desktop_close_hint')
                  : '',
          })}
        </p>
      </li>
    </ol>
  </section>
{/if}

{#snippet line(text: string)}
  <div class="command">
    <code>{text}</code>
    {#if canCopy}
      <button type="button" class="copy" onclick={() => copy(text)} aria-live="polite"
        >{copied === text ? t('copied') : t('copy')}</button
      >
    {/if}
  </div>
{/snippet}

<style>
  .panel {
    background: var(--glass);
    border-radius: 12px;
    padding: 1.25rem;
    margin: 0 0 1rem;
    max-width: 44rem;
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
  .hint {
    color: var(--muted);
  }
  .hint {
    margin: 0.4rem 0 0;
    font-size: 0.875rem;
  }
  .hint.failed {
    color: var(--alarm);
  }
  .notice.failed {
    color: var(--alarm);
    border-left: 3px solid #ff6b57;
  }

  label.check {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    margin-top: 1rem;
    color: var(--text);
  }
  input[aria-invalid='true'] {
    border-color: #ff6b57;
  }

  a.download {
    display: inline-block;
    padding: 0.65rem 1.4rem;
    border-radius: 10px;
    background: var(--orange);
    box-shadow: 0 3px 0 var(--orange-deep);
    font-weight: 800;
    font-size: 0.875rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    text-decoration: none;
  }
  a.download:hover {
    background: #f06a1e;
  }
  a.download:active {
    transform: translateY(2px);
    box-shadow: 0 1px 0 var(--orange-deep);
  }
  .setup-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem 1rem;
    margin: 0.75rem 0 0.25rem;
  }
  .setup-actions button {
    margin: 0;
  }
  .setup-actions .advanced-toggle {
    padding: 0.5rem 0;
    border: 0;
    border-radius: 0;
    background: none;
    color: var(--muted);
    font-size: 0.8125rem;
    font-weight: 600;
    text-transform: none;
    letter-spacing: normal;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }
  .advanced-toggle:hover {
    color: var(--text);
  }
  .advanced-settings {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--line);
  }
  .address {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    max-width: 28rem;
  }
  .address input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .address button.reset {
    flex: none;
    margin: 0;
    padding: 0.45rem 0.9rem;
    font-size: 0.75rem;
  }
  /* The way to do it by hand closes the steps, out of the way of riders who just run the script. */
  .elsewhere {
    margin: 1.5rem 0 0;
    padding-top: 1rem;
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: 0.875rem;
  }
  .elsewhere a {
    color: var(--muted);
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }
  .elsewhere a:hover {
    color: var(--text);
  }
  .walk {
    counter-reset: step;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .walk > li {
    counter-increment: step;
    position: relative;
    padding: 0 0 1.5rem 3.25rem;
  }
  .walk > li:last-child {
    padding-bottom: 0;
  }
  .walk > li::before {
    content: counter(step);
    position: absolute;
    left: 0;
    top: -0.2rem;
    display: grid;
    place-items: center;
    width: 2.1rem;
    height: 2.1rem;
    border-radius: 50%;
    background: var(--orange);
    font-weight: 800;
  }
  .walk > li:not(:last-child)::after {
    content: '';
    position: absolute;
    left: calc(1.05rem - 1px);
    top: 2.2rem;
    bottom: 0.3rem;
    border-left: 2px solid var(--line);
  }
  .walk h2 {
    margin-bottom: 0.5rem;
    padding-top: 0.15rem;
  }
  .walk p {
    margin: 0 0 0.4rem;
  }
  .walk label.check:first-of-type {
    margin-top: 0;
  }
  .command {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin: 0.5rem 0;
    padding: 0.55rem 0.55rem 0.55rem 1rem;
    border-radius: 8px;
    background: var(--well);
  }
  .command code {
    flex: 1 1 16rem;
    min-width: 0;
    overflow-wrap: anywhere;
    font:
      600 0.9375rem/1.5 ui-monospace,
      'Cascadia Mono',
      'DejaVu Sans Mono',
      monospace;
    user-select: all;
  }
  button.copy {
    flex: none;
    margin: 0 0 0 auto;
    padding: 0.35rem 0.8rem;
    font-size: 0.75rem;
  }

  .lede {
    margin: 0 0 1.5rem;
    color: var(--muted);
  }
  .prints + .hint {
    margin-bottom: 1.75rem;
  }
  .files {
    display: grid;
    gap: 0.6rem;
    margin: 0 0 1rem;
    padding: 0;
    list-style: none;
  }
  .files li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem 0.9rem;
  }
  .files .hint {
    margin: 0;
  }
  a.file {
    padding: 0.45rem 0.9rem;
    border: 2px solid rgb(255 255 255 / 0.7);
    border-radius: 10px;
    font-weight: 800;
    font-size: 0.8125rem;
    text-decoration: none;
  }
  a.file:hover {
    background: rgb(255 255 255 / 0.12);
  }
  .prints {
    display: grid;
    gap: 1rem;
    margin: 1rem 0 0.5rem;
  }
</style>
