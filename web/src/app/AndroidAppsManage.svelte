<script lang="ts">
  import { t } from '../lib/i18n/index';
  import SlowLoading from '../components/SlowLoading.svelte';
  import type { Api } from '../lib/api';
  import { onMount } from 'svelte';
  import { companionStatus } from './companion';
  import { zwiftAndroidStatus } from './zwift-android';
  import type { AppReleasesStatus, ReleaseApp } from './app-releases';
  import { appReleasesStatus, releaseFor } from './app-releases';

  let {
    api,
    navigate,
  }: {
    api: Api;
    navigate: (path: string) => Promise<void>;
  } = $props();

  type App = { versionName: string; current: boolean } | null;
  type Choice = {
    to: string;
    release: ReleaseApp;
    name: string;
    device: 'tablet' | 'phone';
    app: App;
    failure: string;
  };

  let zwift = $state<Choice | null>(null);
  let companion = $state<Choice | null>(null);
  let releases = $state<AppReleasesStatus | null>(null);
  let releaseFailure = $state('');
  let checking = $state(false);
  let saving = $state(false);

  /** What a tile says about new versions: one the server can fetch, or one to get from APKMirror by hand. */
  const update = (choice: Choice) => {
    const found = releaseFor(releases, choice.release, choice.app?.versionName ?? null);
    const version = found.download?.versionName ?? found.mirrorOnly?.versionName;

    if (!version) {
      return '';
    }

    return choice.app ? t('release_tile_update', { value1: version }) : t('release_tile_ready', { value1: version });
  };

  const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  async function releaseAction(work: () => Promise<AppReleasesStatus>) {
    releaseFailure = '';

    try {
      releases = await work();
    } catch (error) {
      releaseFailure = error instanceof Error ? error.message : t('request_error');
    }
  }

  async function check() {
    checking = true;
    await releaseAction(() => api(appReleasesStatus, '/api/manage/app-releases/check', 'POST', {}));
    checking = false;
  }

  async function setEnabled(enabled: boolean) {
    saving = true;
    await releaseAction(() => api(appReleasesStatus, '/api/manage/app-releases/settings', 'PUT', { enabled }));
    saving = false;
  }

  /** Riders can only use a build that trusts this server's current certificate. */
  const ready = (choice: Choice) => !!choice.app?.current;

  const detail = (choice: Choice) =>
    choice.failure ||
    (!choice.app
      ? t('not_added_yet')
      : choice.app.current
        ? t('version_value', { value1: choice.app.versionName })
        : t('version_needs_rebuild', { value1: choice.app.versionName }));

  const reason = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

  function go(event: MouseEvent, to: string) {
    event.preventDefault();
    void navigate(to);
  }

  onMount(async () => {
    const [android, phone, found] = await Promise.allSettled([
      api(zwiftAndroidStatus, '/api/install/android'),
      api(companionStatus, '/api/companion'),
      api(appReleasesStatus, '/api/manage/app-releases'),
    ]);

    if (found.status === 'fulfilled') {
      releases = found.value;
    } else {
      releaseFailure = reason(found.reason, t('request_error'));
    }

    zwift = {
      to: '/manage/zwift-android',
      release: 'zwift',
      name: t('zwift_for_android'),
      device: 'tablet',
      app: android.status === 'fulfilled' ? android.value.app : null,
      failure: android.status === 'rejected' ? reason(android.reason, t('zwift_android_build_load_error')) : '',
    };
    companion = {
      to: '/manage/companion',
      release: 'companion',
      name: t('companion_for_android'),
      device: 'phone',
      app: phone.status === 'fulfilled' ? phone.value.app : null,
      failure: phone.status === 'rejected' ? reason(phone.reason, t('companion_build_load_error')) : '',
    };
  });
</script>

<section class="panel" aria-labelledby="android-apps">
  <h2 id="android-apps">{t('android_apps')}</h2>
  <p class="lead">
    {t('android_apps_description')}
    <a href="/apps" onclick={(event) => go(event, '/apps')}>{t('apps')}</a>.
  </p>

  {#if !zwift || !companion}
    <SlowLoading />
  {:else}
    <ul class="choices">
      {#each [zwift, companion] as choice (choice.to)}
        <li>
          <a class="choice" class:ready={ready(choice)} href={choice.to} onclick={(event) => go(event, choice.to)}>
            <svg class="device" viewBox="0 0 48 40" aria-hidden="true">
              {#if choice.device === 'tablet'}
                <rect class="body" x="3" y="6" width="42" height="28" rx="4" />
                <rect class="screen" x="7" y="10" width="34" height="20" rx="1.5" />
              {:else}
                <rect class="body" x="13" y="1" width="22" height="38" rx="4.5" />
                <rect class="screen" x="16.5" y="5" width="15" height="27" rx="1.5" />
                <path class="body" d="M21.5 35.5h5" />
              {/if}
            </svg>
            <span class="status">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                {#if ready(choice)}<path d="m6.5 12.5 3.5 3.5 7.5-8" />{:else}<path d="m8 8 8 8M16 8l-8 8" />{/if}
              </svg>
              <span class="visually-hidden"
                >{ready(choice) ? t('android_app_available') : t('android_app_unavailable')}</span
              >
            </span>
            <span class="name">{choice.name}</span>
            <span class="detail" class:failed={!!choice.failure}>{detail(choice)}</span>
            <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            {#if update(choice)}<span class="update">{update(choice)}</span>{/if}
          </a>
        </li>
      {/each}
    </ul>

    {#if releases}
      <div class="releases">
        <label class="toggle">
          <input
            type="checkbox"
            checked={releases.enabled}
            disabled={saving}
            onchange={(event) => void setEnabled(event.currentTarget.checked)}
          />
          {t('release_daily_check')}
        </label>
        <p class="checked">
          <span
            >{releases.checkedAt
              ? t('release_last_checked', { value1: when(releases.checkedAt) })
              : t('release_never_checked')}</span
          >
          <button type="button" class="check" disabled={checking || releases.checking} onclick={() => void check()}
            >{checking ? t('release_checking') : t('release_check_now')}</button
          >
        </p>
      </div>
    {/if}
    {#if releaseFailure}<p class="release-failure" role="alert">{releaseFailure}</p>{/if}
  {/if}
</section>

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
    margin: 0 0 1.25rem;
  }
  .lead a {
    color: inherit;
  }

  .choices {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* A pressable plate like Zwift's buttons: a ledge underneath that it sinks into when clicked. */
  a.choice {
    position: relative;
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-areas:
      'device status'
      'name name'
      'detail chevron'
      'update update';
    align-items: end;
    gap: 0.15rem 1rem;
    height: 100%;
    box-sizing: border-box;
    padding: 1.1rem 1rem 1rem 1.2rem;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--well);
    box-shadow: 0 3px 0 rgb(0 0 0 / 0.35);
    color: var(--text);
    text-decoration: none;
  }
  a.choice:hover {
    background: var(--glass-raised);
  }
  a.choice:active {
    transform: translateY(2px);
    box-shadow: 0 1px 0 rgb(0 0 0 / 0.35);
  }
  a.choice:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: 3px;
  }

  .device {
    grid-area: device;
    align-self: start;
    width: 3rem;
    height: auto;
    margin-bottom: 1.25rem;
  }
  .device .body {
    fill: none;
    stroke: var(--text);
    stroke-width: 2.25;
    stroke-linecap: round;
  }
  .device .screen {
    fill: rgb(255 255 255 / 0.1);
  }
  .ready .device .screen {
    fill: var(--orange);
  }

  /* The answer to "can riders get it?" sits in the corner, readable at a glance and by shape as well as colour. */
  .status {
    grid-area: status;
    align-self: start;
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    background: #e5483a;
    box-shadow: 0 0 0 4px rgb(229 72 58 / 0.22);
  }
  .ready .status {
    background: #23a05a;
    box-shadow: 0 0 0 4px rgb(35 160 90 / 0.25);
  }
  .status svg {
    width: 1.3rem;
    height: 1.3rem;
    fill: none;
    stroke: #fff;
    stroke-width: 3;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .name {
    grid-area: name;
    font-size: 1.125rem;
    font-weight: 800;
    line-height: 1.2;
  }
  .detail {
    grid-area: detail;
    color: var(--muted);
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
  }
  .detail.failed {
    color: var(--alarm);
  }
  .chevron {
    grid-area: chevron;
    width: 1.25rem;
    height: 1.25rem;
    fill: none;
    stroke: var(--muted);
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  a.choice:hover .chevron {
    stroke: var(--orange);
  }

  /* A new version is news, not a fault: it reads in orange under the version, never in the status colours. */
  .update {
    grid-area: update;
    justify-self: start;
    margin-top: 0.6rem;
    padding: 0.1rem 0.55rem;
    border: 1px solid var(--orange);
    border-radius: 999px;
    font-size: 0.8125rem;
  }

  .releases {
    display: grid;
    gap: 0.4rem;
    margin-top: 1.25rem;
    padding-top: 1rem;
    border-top: 1px solid var(--line);
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    cursor: pointer;
  }
  .toggle input {
    width: 1.1rem;
    height: 1.1rem;
    margin: 0;
    accent-color: var(--orange);
  }
  .checked {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 0.75rem;
    margin: 0;
    padding-left: 1.7rem;
    color: var(--muted);
    font-size: 0.875rem;
  }
  button.check {
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text);
    font-size: 0.875rem;
    text-transform: none;
    letter-spacing: 0;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }
  button.check:hover {
    background: none;
    color: var(--orange);
  }
  button.check:disabled {
    color: var(--muted);
    text-decoration: none;
    cursor: default;
  }
  .release-failure {
    margin: 0.75rem 0 0;
    color: var(--alarm);
    font-size: 0.875rem;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    a.choice:active {
      transform: none;
    }
  }
</style>
