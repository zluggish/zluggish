<script lang="ts">
  import { t } from '../lib/i18n/index';
  import type { Api } from '../lib/api';
  import { onMount } from 'svelte';
  import { megabytes } from './companion';
  import type { AppReleasesStatus, ReleaseApp } from './app-releases';
  import { appReleasesStatus, releaseFor } from './app-releases';

  let {
    api,
    app,
    installed,
    disabled,
    ondownload,
  }: {
    api: Api;
    app: ReleaseApp;
    /** The version riders download now, or null when there is none. */
    installed: string | null;
    /** True while a job runs or the certificate is missing: the download button waits. */
    disabled: boolean;
    ondownload: () => void;
  } = $props();

  let status = $state<AppReleasesStatus | null>(null);
  let checking = $state(false);
  let failure = $state('');

  const release = $derived(releaseFor(status, app, installed));
  const sourceErrors = $derived(
    release.errors
      ? [
          release.errors.apkpure && t('release_source_failed', { value1: 'APKPure', value2: release.errors.apkpure }),
          release.errors.apkmirror &&
            t('release_source_failed', { value1: 'APKMirror', value2: release.errors.apkmirror }),
        ].filter((line) => !!line)
      : [],
  );

  const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  async function check() {
    checking = true;
    failure = '';

    try {
      status = await api(appReleasesStatus, '/api/manage/app-releases/check', 'POST', {});
    } catch (error) {
      failure = error instanceof Error ? error.message : t('request_error');
    } finally {
      checking = false;
    }
  }

  onMount(async () => {
    try {
      status = await api(appReleasesStatus, '/api/manage/app-releases');
    } catch (error) {
      failure = error instanceof Error ? error.message : t('request_error');
    }
  });
</script>

{#if status}
  {#if release.download}
    <!-- The one thing worth reading at a glance: what riders have against what the server can fetch now. -->
    <div class="release" role="group" aria-labelledby="release-{app}">
      <p class="title" id="release-{app}">{installed ? t('release_update_available') : t('release_ready')}</p>
      <div class="jump">
        {#if installed}
          <span class="from"
            ><span class="label">{t('release_installed')}</span><span class="version">{installed}</span></span
          >
          <svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-5-6 6 6-6 6" /></svg>
        {/if}
        <span class="to"
          ><span class="label">{t('release_on_apkpure')}</span><span class="version"
            >{release.download.versionName}</span
          ></span
        >
      </div>
      <p class="detail">
        {release.download.bytes === null
          ? t('release_download_hint')
          : t('release_download_size_hint', { value1: megabytes(release.download.bytes) })}
      </p>
      <button type="button" class="primary" {disabled} onclick={ondownload}
        >{t('release_download_action', { value1: release.download.versionName })}</button
      >
    </div>
  {/if}

  {#if release.mirrorOnly}
    <p class="mirror">
      {t('release_mirror_only', { value1: release.mirrorOnly.versionName })}
      <a href={release.mirrorOnly.url} target="_blank" rel="noopener noreferrer">{t('release_page')}</a>.
    </p>
  {/if}

  <p class="checked">
    <span
      >{status.checkedAt
        ? release.download || release.mirrorOnly
          ? t('release_checked', { value1: when(status.checkedAt) })
          : t('release_up_to_date', { value1: when(status.checkedAt) })
        : t('release_never_checked')}</span
    >
    <button type="button" class="check" disabled={checking || status.checking} onclick={() => void check()}
      >{checking ? t('release_checking') : t('release_check_now')}</button
    >
  </p>
  {#each sourceErrors as line (line)}<p class="source-error">{line}</p>{/each}
{/if}
{#if failure}<p class="source-error" role="alert">{failure}</p>{/if}

<style>
  /* A well inside the panel, set apart by a left edge in orange: the only orange edge on the page. */
  .release {
    margin: 0 0 1.25rem;
    padding: 1rem 1.1rem 1.1rem;
    border-left: 3px solid var(--orange);
    border-radius: 0 10px 10px 0;
    background: var(--well);
  }
  .title {
    margin: 0 0 0.6rem;
    font-weight: 800;
  }
  .jump {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.25rem 1rem;
  }
  .from,
  .to {
    display: grid;
  }
  .label {
    color: var(--muted);
    font-size: 0.8125rem;
  }
  .version {
    font-size: 1.75rem;
    font-weight: 800;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }
  .from .version {
    color: var(--muted);
  }
  .arrow {
    width: 1.6rem;
    height: 1.6rem;
    margin-bottom: 0.2rem;
    fill: none;
    stroke: var(--orange);
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .detail {
    margin: 0.6rem 0 0;
    color: var(--muted);
    font-size: 0.875rem;
  }

  .mirror {
    margin: 0 0 1rem;
    color: var(--muted);
    font-size: 0.875rem;
  }
  .mirror a {
    color: var(--text);
  }

  .checked {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 0.75rem;
    margin: 0 0 1.25rem;
    color: var(--muted);
    font-size: 0.875rem;
  }
  /* A text action, not a second big button beside the upload ones. */
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
  .source-error {
    margin: -0.75rem 0 1.25rem;
    color: var(--alarm);
    font-size: 0.875rem;
  }
</style>
