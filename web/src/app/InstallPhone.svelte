<script lang="ts">
  import { t } from '../lib/i18n/index';
  import SlowLoading from '../components/SlowLoading.svelte';
  import { onMount } from 'svelte';
  import Fingerprint from '../components/Fingerprint.svelte';
  import type { Api } from '../lib/api';
  import { megabytes } from './companion';
  import { detect } from './device';
  import { tlsStatus } from './tls';
  import type { TlsStatus } from './tls';
  import { zwiftAndroidStatus } from './zwift-android';
  import type { ZwiftAndroidStatus } from './zwift-android';

  let {
    api,
    path,
    navigate,
    administrator,
  }: {
    api: Api;
    /** `/install/android`, `/install/android-rooted` or `/install/ios`. */
    path: string;
    navigate: (path: string) => Promise<void>;
    administrator: boolean;
  } = $props();

  const platform = $derived(
    path === '/install/android-rooted' ? 'rooted' : path === '/install/ios' ? 'ios' : 'android',
  );

  let status = $state<TlsStatus | null>(null);
  let failure = $state('');

  const address = $derived(status?.serverAddress ?? '<server-ip>');

  /** The name the server gives the certificate download, so the adb commands match the file. */
  const file = $derived(`zluggish-zwift-${(status?.certificate?.thumbprint ?? '').slice(0, 8).toLowerCase()}.crt`);

  let zwift = $state<ZwiftAndroidStatus | null>(null);
  let zwiftFailure = $state('');
  const onAndroid = detect() === 'android';

  const data = '/data/data/com.zwift.zwiftgame/dataES';

  const blocks = $derived({
    hosts: [
      `${address} us-or-rly101.zwift.com`,
      `${address} secure.zwift.com`,
      `${address} cdn.zwift.com`,
      `${address} launcher.zwift.com`,
    ].join('\n'),
    certificate: [
      t('adb_push_zluggish_crt', { value1: file, value2: data }),
      t('phone_setup_rooted_android_append_certificate_command', { value1: data, value2: data }),
    ].join('\n'),
    etcHosts: t('phone_setup_rooted_android_hostnames', { value1: address }),
  });

  /** Browsers allow the clipboard only on HTTPS or localhost; elsewhere the lines are there to select. */
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard;
  let copied = $state('');

  async function copy(key: keyof typeof blocks) {
    await navigator.clipboard.writeText(blocks[key]);
    copied = key;
    setTimeout(() => (copied = ''), 2000);
  }

  function go(event: MouseEvent, to: string) {
    event.preventDefault();
    void navigate(to);
  }

  const day = (iso: string) => new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });

  $effect(() => {
    if (platform === 'android' && status) {
      api(zwiftAndroidStatus, '/api/install/android')
        .then((body) => {
          zwift = body;
        })
        .catch((error: unknown) => {
          zwiftFailure = error instanceof Error ? error.message : t('phone_setup_load_error');
        });
    }
  });

  onMount(async () => {
    try {
      status = await api(tlsStatus, '/api/tls');
    } catch (error) {
      failure = error instanceof Error ? error.message : t('phone_setup_certificate_load_error');
    }
  });
</script>

{#snippet code(key: keyof typeof blocks)}
  <div class="command">
    <code>{blocks[key]}</code>
    {#if canCopy}
      <button type="button" class="copy" onclick={() => copy(key)} aria-live="polite"
        >{copied === key ? t('copied') : t('copy')}</button
      >
    {/if}
  </div>
{/snippet}

{#snippet manageLink()}
  <a href="/manage/zwift-android" onclick={(event) => go(event, '/manage/zwift-android')}
    >{t('manage_zwift_for_android')}</a
  >
{/snippet}

{#if failure}<p class="notice failed" role="alert">{failure}</p>{/if}

{#if platform === 'ios'}
  <section class="panel" aria-labelledby="install-ios">
    <h2 id="install-ios">{t('phone_setup_ios_unsupported')}</h2>
    <p class="lead">{t('phone_setup_ios_description')}</p>
  </section>
{:else if status === null}
  {#if !failure}<SlowLoading />{/if}
{:else if status.mode === 'legacy'}
  <section class="panel">
    <p>{t('phone_setup_certificate_shared_hint')}</p>
  </section>
{:else if platform === 'android'}
  <section class="panel" aria-label={t('android_setup_steps')}>
    {#if zwift?.app && !zwift.app.current}
      <p class="risk" role="status">
        {t('phone_setup_app_stale_certificate_warning')}
        {#if administrator}{t('build_it_again_under')} {@render manageLink()}.{:else}{t(
            'phone_setup_app_rebuild_hint',
          )}{/if}
      </p>
    {/if}

    <ol class="walk">
      <li>
        <h2>{t('download_zwift_for_zluggish')}</h2>
        {#if zwiftFailure}
          <p class="notice failed" role="alert">{zwiftFailure}</p>
        {:else if zwift === null}
          <SlowLoading />
        {:else if zwift.app?.current}
          <p>
            {t('phone_setup_app_coexistence')}
          </p>
          <a class="download" href="/api/install/android/app" download
            >{t('download_zwift', { value1: zwift.app.versionName })}</a
          >
          <p class="hint">
            {t('phone_setup_app_disk_space_hint', {
              value1: megabytes(zwift.app.bytes),
              value2: day(zwift.app.createdAt),
            })}
          </p>
        {:else if !zwift.app}
          <p class="empty">
            {t('phone_setup_app_unavailable')}
            {#if administrator}{t('set_it_up_under')} {@render manageLink()}.{:else}{t(
                'phone_setup_app_unavailable_hint',
              )}{/if}
          </p>
        {/if}
      </li>
      <li>
        <h2>{t('install_it')}</h2>
        <p>
          {t('phone_setup_install_open_file_hint')}
          <strong>{t('install')}</strong>.
        </p>
        <p class="hint">
          {t('phone_setup_install_play_protect_hint_prefix')} <strong>{t('install_anyway')}</strong>.
        </p>
      </li>
      <li>
        <h2>{t('phone_setup_description')}</h2>
        <p>{t('dns_override_alternatives_hint')}</p>
        <p>
          {t('install_virtual_hosts_if_needed')}
          <a href="https://github.com/x-falcon/Virtual-Hosts/releases/latest" target="_blank" rel="noopener noreferrer"
            >{t('virtual_hosts')}</a
          >{t('save_these_lines_as')} <strong>{t('hosts_txt')}</strong>
          {t('phone_setup_hosts_select_file_suffix')}
        </p>
        {@render code('hosts')}
        <p class="hint">
          {t('turn_off')} <strong>{t('private_dns')}</strong>
          {t('android_settings_hint')}
        </p>
      </li>
      <li>
        <h2>{t('phone_setup_ride')}</h2>
        <p>
          {t('phone_setup_hosts_enable_hint')} <strong>{t('zwift_for_zluggish')}</strong>
          {t('phone_setup_install_sign_in_hint')}
        </p>
        <p class="hint">{t('phone_setup_install_first_launch_hint')}</p>
      </li>
    </ol>
  </section>
{:else if status.certificate}
  <section class="panel" aria-label={t('rooted_android_setup_steps')}>
    <ol class="walk">
      <li>
        <h2>{t('start_zwift_once')}</h2>
        <p>{t('phone_setup_rooted_android_initialize_hint')}</p>
      </li>
      <li>
        <h2>{t('certificate_install_title')}</h2>
        <p>
          {t('certificate_append_hint')}
          <strong class="path">{t('cacert_pem', { value1: data })}</strong>{t('with')}
          <code class="inline">{t('adb')}</code>
          {t('as_root')}
        </p>
        <a class="download" href="/api/tls/certificate" download>{t('download_certificate')}</a>
        {@render code('certificate')}
        <p class="hint">{t('phone_setup_rooted_android_permissions_hint')}</p>
      </li>
      <li>
        <h2>{t('phone_setup_description')}</h2>
        <p>{t('append_this_line_to')} <strong>{t('etc_hosts')}</strong>:</p>
        {@render code('etcHosts')}
        <p class="hint">
          {t('phone_setup_rooted_android_edit_hosts_hint')}
          <code class="inline">{t('adb_pull_etc_hosts')}</code>
          {t('and')} <code class="inline">{t('phone_setup_rooted_android_push_hosts_command')}</code>.
        </p>
      </li>
      <li>
        <h2>{t('phone_setup_ride')}</h2>
        <p>{t('phone_setup_rooted_android_launch_hint')}</p>
      </li>
    </ol>
  </section>

  <section class="panel" aria-labelledby="install-rooted-certificate">
    <h2 id="install-rooted-certificate">{t('certificate_verify_title')}</h2>
    <div class="prints">
      <Fingerprint label={t('fingerprint')} value={status.certificate.fingerprint256} />
    </div>
  </section>
{/if}

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
  .lead {
    margin-top: 0;
  }
  .hint {
    margin: 0.4rem 0 0;
    color: var(--muted);
    font-size: 0.875rem;
  }
  .notice.failed {
    color: var(--alarm);
    border-left: 3px solid #ff6b57;
    padding-left: 0.75rem;
  }
  .empty {
    color: var(--muted);
  }
  .risk a {
    color: inherit;
  }
  .risk {
    margin: 0 0 1.25rem;
    padding: 0.75rem 0.9rem;
    border-left: 3px solid #ff6b57;
    border-radius: 0 8px 8px 0;
    background: rgb(255 90 70 / 0.12);
    color: var(--alarm);
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

  a.download {
    display: inline-block;
    margin: 0.5rem 0 0.25rem;
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
    overflow-x: auto;
    white-space: pre;
    font:
      600 0.875rem/1.5 ui-monospace,
      'Cascadia Mono',
      'DejaVu Sans Mono',
      monospace;
    user-select: all;
  }
  .path {
    overflow-wrap: anywhere;
  }
  code.inline {
    font:
      600 0.875em ui-monospace,
      'Cascadia Mono',
      'DejaVu Sans Mono',
      monospace;
  }
  button.copy {
    flex: none;
    margin: 0 0 0 auto;
    padding: 0.35rem 0.8rem;
    font-size: 0.75rem;
  }

  .prints {
    display: grid;
    gap: 1rem;
    margin: 1rem 0 0;
  }
</style>
