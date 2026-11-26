<script lang="ts">
  import { t } from '../lib/i18n/index';
  import { onDestroy, onMount, tick } from 'svelte';
  import { z } from 'zod';
  import type { Api } from '../lib/api';
  import type { CompanionAdminStatus, CompanionStep } from './companion';
  import { companionAdminStatus, megabytes } from './companion';
  import JobProgress from './JobProgress.svelte';
  import ReleaseNotice from './ReleaseNotice.svelte';

  let {
    api,
    navigate,
    csrf,
  }: {
    api: Api;
    navigate: (path: string) => Promise<void>;
    /** The current CSRF token, for the upload that bypasses the JSON helper to report progress. */
    csrf: () => string;
  } = $props();

  let admin = $state<CompanionAdminStatus | null>(null);
  let failure = $state('');
  let slowLoading = $state(false);
  let notice = $state('');
  let working = $state(false);

  /** The upload, before the server's job takes over. Its bytes per second are a smoothed average. */
  let upload = $state<{
    name: string;
    size: number;
    sent: number;
    rate: number | null;
    startedAt: number;
  } | null>(null);
  let uploadError = $state('');
  let dragging = $state(false);
  let fileInput = $state<HTMLInputElement>();
  /** Asked for a new upload while a published app is in place. */
  let replacing = $state(false);
  let request: XMLHttpRequest | null = null;

  const accepted = '.apk,.apks,.xapk,.apkm';
  const failureMessage = z.object({ message: z.string() });
  const certificateReady = $derived(admin?.tlsMode === 'managed' || admin?.tlsMode === 'custom');

  const labels: Record<CompanionStep, string> = {
    upload: t('companion_build_uploading'),
    download: t('release_downloading'),
    runtime: t('downloading_java'),
    editor: t('downloading_apkeditor'),
    inspect: t('file_validation_progress'),
    merge: t('apk_merge_progress'),
    decode: t('resources_unpack_progress'),
    patch: t('companion_build_build_retargeting'),
    build: t('app_rebuild_progress'),
    sign: t('app_sign_progress'),
    publish: t('publishing'),
  };

  /** Rough shares of the whole job, for the width of each stretch of the bar. Rebuilding the app dominates. */
  const weights: Record<CompanionStep, number> = {
    upload: 4,
    download: 4,
    runtime: 4,
    editor: 1,
    inspect: 1,
    merge: 2,
    decode: 3,
    patch: 1,
    build: 4,
    sign: 2,
    publish: 1,
  };

  const day = (iso: string) =>
    new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

  /** One job from the first uploaded byte to the published app: the upload in flight, or the server's job. */
  const job = $derived.by(() => {
    if (upload) {
      // The server picks the steps once it has the file. A full rebuild is the usual case.
      const bundle = !/\.apk$/i.test(upload.name);

      return {
        kind: 'patch' as const,
        state: 'running' as const,
        steps: [
          'upload',
          'inspect',
          ...(bundle ? (['merge'] as const) : []),
          'decode',
          'patch',
          'build',
          'sign',
          'publish',
        ] as Array<CompanionStep>,
        step: 'upload' as CompanionStep,
        progress: upload.size ? upload.sent / upload.size : 0,
        message: null,
        startedAt: upload.startedAt,
        finishedAt: null,
      };
    }

    const activity = admin?.activity;

    if (!activity) {
      return null;
    }

    return {
      ...activity,
      steps: activity.kind === 'patch' ? (['upload', ...activity.steps] as Array<CompanionStep>) : activity.steps,
      startedAt: Date.parse(activity.startedAt),
      finishedAt: activity.finishedAt ? Date.parse(activity.finishedAt) : null,
    };
  });

  const headline = $derived.by(() => {
    if (!job) {
      return '';
    }

    const tools = job.kind === 'toolchain';

    switch (job.state) {
      case 'waiting':
        return t('companion_build_toolchain_pending');
      case 'done':
        return tools
          ? t('companion_build_toolchain_ready')
          : t('published_companion', { value1: admin?.app?.versionName ?? '' });
      case 'failed':
        return tools ? t('download_stopped') : t('patch_stopped');
      default:
        if (upload) {
          return t('companion_build_upload_progress', { value1: upload.name });
        }

        return tools
          ? t('java_tools_download_progress')
          : job.kind === 'rekey'
            ? t('certificate_install_progress')
            : t('companion_build_build_progress');
    }
  });

  const detail = $derived.by(() => {
    if (!job) {
      return '';
    }

    const tools = job.kind === 'toolchain';

    switch (job.state) {
      case 'waiting':
        return t('companion_build_toolchain_resume_hint');
      case 'done':
        return tools ? t('ready_to_rebuild_apps') : t('companion_build_build_ready_hint');
      case 'failed':
        return tools ? t('download_error') : t('patch_error');
      default:
        return upload ? t('companion_build_upload_keep_open_hint') : `${labels[job.step]}…`;
    }
  });

  async function refresh() {
    try {
      admin = await api(companionAdminStatus, '/api/manage/companion');
      failure = '';
    } catch (error) {
      failure = error instanceof Error ? error.message : t('companion_build_load_error');
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    const running = admin?.activity?.state === 'running';

    if (running && !timer) {
      timer = setInterval(() => void refresh(), 1000);
    } else if (!running && timer) {
      clearInterval(timer);
      timer = null;
    }
  });

  async function act(work: () => Promise<CompanionAdminStatus>, done = '') {
    if (working) {
      return;
    }
    working = true;
    notice = '';
    failure = '';

    try {
      admin = await work();
      notice = done;
    } catch (error) {
      failure = error instanceof Error ? error.message : t('request_error');
    } finally {
      working = false;
    }
  }

  const installTools = () => act(() => api(companionAdminStatus, '/api/manage/companion/toolchain', 'POST', {}));

  let sample = { at: 0, bytes: 0 };

  function sent(bytes: number) {
    if (!upload) {
      return;
    }

    const at = performance.now();
    const seconds = (at - sample.at) / 1000;
    let { rate } = upload;

    if (seconds >= 0.5) {
      const measured = (bytes - sample.bytes) / seconds;
      rate = rate === null ? measured : rate * 0.8 + measured * 0.2;
      sample = { at, bytes };
    }

    upload = { ...upload, sent: Math.max(upload.sent, bytes), rate };
  }

  /** Send the file as raw bytes, so the server streams it to disk, with progress from the upload events. */
  function send(file: File) {
    uploadError = '';
    notice = '';

    if (!/\.(apk|apks|xapk|apkm)$/i.test(file.name)) {
      uploadError = t('companion_build_upload_file_required');

      return;
    }

    if (admin && file.size > admin.uploadLimit) {
      uploadError = t('companion_build_upload_size_error', { value1: megabytes(admin.uploadLimit) });

      return;
    }

    upload = { name: file.name, size: file.size, sent: 0, rate: null, startedAt: Date.now() };
    sample = { at: performance.now(), bytes: 0 };
    const xhr = new XMLHttpRequest();
    request = xhr;
    xhr.open('PUT', `/api/manage/companion/app?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-CSRF-Token', csrf());
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => sent(event.loaded);

    xhr.onload = () => {
      upload = null;
      request = null;

      // The job started, or waits for the Java tools: the next status shows which.
      if (xhr.status === 202) {
        replacing = false;
        void refresh();
      } else {
        uploadError =
          failureMessage.safeParse(xhr.response).data?.message ?? t('upload_error_detail', { value1: xhr.status });
      }
    };

    xhr.onerror = () => {
      upload = null;
      request = null;
      uploadError = t('companion_build_upload_interrupted');
    };

    xhr.onabort = () => {
      upload = null;
      request = null;
    };

    xhr.send(file);
  }

  const busy = $derived(!!upload || admin?.activity?.state === 'running');
  /** Whether a job ran during this visit. One that finished before it has nothing new to say: the facts show its app. */
  let watched = $state(false);

  $effect(() => {
    if (job && job.state !== 'done' && job.state !== 'failed') {
      watched = true;
    }
  });
  /** A published app keeps the upload behind a button, unless uploading is the only way to bring it up to date. */
  const uploadOpen = $derived(!admin?.app || !admin.app.current || replacing || !!uploadError);

  async function openUpload() {
    replacing = true;
    await tick();
    fileInput?.focus();
  }

  function closeUpload() {
    replacing = false;
    uploadError = '';
  }

  function dropped(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    const file = event.dataTransfer?.files[0];

    if (file && !busy) {
      send(file);
    }
  }

  function go(event: MouseEvent, to: string) {
    event.preventDefault();
    void navigate(to);
  }

  onMount(() => {
    const timeout = setTimeout(() => (slowLoading = true), 4000);
    void refresh();

    return () => clearTimeout(timeout);
  });

  onDestroy(() => {
    if (timer) {
      clearInterval(timer);
    }
    request?.abort();
  });
</script>

{#if failure}<p class="notice failed" role="alert">{failure}</p>
  {#if admin === null}<button type="button" onclick={() => void refresh()}>{t('retry_now')}</button>{/if}
{/if}

{#if admin === null}
  {#if !failure && slowLoading}
    <div role="status">
      <p>{t('loading_taking_longer')}</p>
      <button type="button" onclick={() => location.reload()}>{t('reload_this_page')}</button>
    </div>
  {/if}
{:else}
  <section class="panel">
    <p class="lead">
      {t('companion_build_description')}
      <a href="/apps" onclick={(event) => go(event, '/apps')}>{t('apps')}</a>.
    </p>

    {#if !certificateReady}
      <p class="stale">
        {#if admin.tlsMode === 'legacy'}
          {t('companion_build_certificate_shared_warning')}
        {:else}
          {t('companion_build_certificate_missing')}
        {/if}
      </p>
    {/if}

    {#if admin.app}
      <dl class="facts">
        <div>
          <dt>{t('version')}</dt>
          <dd>{admin.app.versionName}</dd>
        </div>
        <div>
          <dt>{t('size')}</dt>
          <dd>{megabytes(admin.app.bytes)}</dd>
        </div>
        <div>
          <dt>{t('patched')}</dt>
          <dd>{day(admin.app.createdAt)}</dd>
        </div>
        <div>
          <dt>{t('certificate')}</dt>
          <dd class:alarm={!admin.app.current}>
            {admin.app.current ? t('current') : t('outdated')}
          </dd>
        </div>
      </dl>
    {/if}

    {#if !busy && !admin.pending}
      <ReleaseNotice
        {api}
        app="companion"
        installed={admin.app?.versionName ?? null}
        disabled={working || !certificateReady}
        ondownload={() => act(() => api(companionAdminStatus, '/api/manage/companion/download', 'POST', {}))}
      />
    {/if}

    {#if job && (job.state !== 'done' || watched)}
      <JobProgress id="companion-job" {job} {labels} {weights} {headline} {detail} {upload}>
        {#if upload}
          <button type="button" onclick={() => request?.abort()}>{t('stop_upload')}</button>
        {:else if job.state === 'running'}
          {#if job.kind === 'toolchain' && admin.pending}
            <p class="hint">{t('companion_build_upload_resume_hint')}</p>
          {/if}
          <button
            type="button"
            disabled={working}
            onclick={() => act(() => api(companionAdminStatus, '/api/manage/companion/cancel', 'POST', {}))}
            >{t('stop')}</button
          >
          <p class="hint">{t('companion_build_build_background_hint')}</p>
        {:else if admin.pending}
          {#if admin.toolchain.supported}
            <p class="ask">
              {t('companion_build_build_automatic_rebuild_hint', {
                value1: admin.toolchain.java ? 'APKEditor' : t('java_and_apkeditor'),
                value2: megabytes(admin.toolchain.downloadBytes),
              })}
            </p>
            <button type="button" class="primary" disabled={working} onclick={installTools}
              >{t('companion_build_toolchain_download_action')}</button
            >
          {:else}
            <p class="ask">{t('companion_build_build_manual_rebuild_hint')}</p>
          {/if}
          <button
            type="button"
            disabled={working}
            onclick={() =>
              act(() => api(companionAdminStatus, '/api/manage/companion/pending', 'DELETE', {}), 'Upload discarded.')}
            >{t('discard_upload')}</button
          >
        {/if}
      </JobProgress>
    {/if}

    {#if !busy && !admin.pending && uploadOpen}
      <label
        class="drop"
        class:dragging
        class:disabled={!certificateReady}
        ondragover={(event) => {
          event.preventDefault();
          dragging = certificateReady;
        }}
        ondragleave={() => (dragging = false)}
        ondrop={dropped}
      >
        <input
          bind:this={fileInput}
          type="file"
          accept={accepted}
          disabled={!certificateReady}
          onchange={() => {
            const file = fileInput?.files?.[0];

            if (file) send(file);

            if (fileInput) fileInput.value = '';
          }}
        />
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-5 5m5-5 5 5M5 20h14" /></svg>
        <span class="title">{admin.app ? t('upload_a_newer_companion') : t('upload_companion')}</span>
        <span class="detail"
          >{t('companion_build_upload_dropzone', {
            value1: megabytes(admin.uploadLimit),
          })}</span
        >
      </label>
      <p class="hint">
        {t('companion_build_upload_toolchain_hint', { size: megabytes(admin.toolchain.downloadBytes) })}
      </p>
    {/if}
    {#if uploadError}<p class="notice failed" role="alert">{uploadError}</p>{/if}

    {#if admin.app && !busy && !admin.pending && !uploadOpen}
      <button type="button" class="replace" disabled={!certificateReady} onclick={() => void openUpload()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-5 5m5-5 5 5M5 20h14" /></svg>
        {t('upload_a_newer_companion')}
      </button>
    {:else if admin.app && !busy && !admin.pending && replacing}
      <button type="button" onclick={closeUpload}>{t('cancel')}</button>
    {/if}
    {#if notice}<p class="hint" role="status">{notice}</p>{/if}
  </section>

  {#if admin.original || admin.app}
    <section class="panel" aria-labelledby="companion-saved">
      <h2 id="companion-saved">{t('saved_upload')}</h2>
      {#if admin.original}
        <p class="file">
          <span class="name">{admin.original.name}</span>
          <span class="meta"
            >{t('companion_build_uploaded', {
              value1: megabytes(admin.original.bytes),
              value2: day(admin.original.uploadedAt),
            })}</span
          >
        </p>
        <p class="hint">{t('companion_build_upload_retention_hint')}</p>
      {:else}
        <p class="hint">{t('companion_build_upload_missing_hint')}</p>
      {/if}
      <div class="actions">
        {#if admin.original}
          <button
            type="button"
            class:primary={!!admin.app && !admin.app.current}
            disabled={working || busy || !certificateReady}
            onclick={() => act(() => api(companionAdminStatus, '/api/manage/companion/rebuild', 'POST', {}))}
            >{t('build_again')}</button
          >
        {/if}
        {#if admin.app}
          <button
            type="button"
            disabled={working || busy}
            onclick={() =>
              act(() => api(companionAdminStatus, '/api/manage/companion/app', 'DELETE', {}), 'App removed.')}
            >{t('app_remove_action')}</button
          >
        {/if}
      </div>
    </section>
  {/if}
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
    margin: 0 0 1.25rem;
  }
  .lead a {
    color: inherit;
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
  .stale {
    margin: 0 0 1.25rem;
    padding: 0.75rem 0.9rem;
    border-left: 3px solid #ff6b57;
    border-radius: 0 8px 8px 0;
    background: rgb(255 90 70 / 0.12);
    color: var(--alarm);
  }

  /* The way to a new upload once an app is published: one quiet action under the facts. */
  button.replace {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }
  button.replace svg {
    width: 1.1rem;
    height: 1.1rem;
    fill: none;
    stroke: var(--orange);
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  button.replace:disabled svg {
    stroke: currentColor;
  }
  .file {
    display: grid;
    gap: 0.1rem;
    margin: 0;
  }
  .file .name {
    font-weight: 800;
    overflow-wrap: anywhere;
  }
  .file .meta {
    color: var(--muted);
    font-size: 0.875rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
    gap: 0.75rem 1rem;
    margin: 0 0 1.25rem;
  }
  .facts dt {
    color: var(--muted);
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .facts dd {
    margin: 0.1rem 0 0;
    font-size: 1.125rem;
    font-weight: 800;
  }
  .facts dd.alarm {
    color: var(--alarm);
  }

  .drop {
    position: relative;
    display: grid;
    justify-items: center;
    gap: 0.3rem;
    padding: 1.5rem 1rem;
    border: 2px dashed var(--line);
    border-radius: 12px;
    background: var(--well);
    text-align: center;
    cursor: pointer;
  }
  .drop input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
  .drop:hover,
  .drop.dragging,
  .drop:focus-within {
    border-color: var(--orange);
  }
  .drop:focus-within {
    outline: 2px solid var(--orange);
    outline-offset: 2px;
  }
  .drop.disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .drop.disabled input {
    cursor: not-allowed;
  }
  .drop svg {
    width: 2rem;
    height: 2rem;
    fill: none;
    stroke: var(--orange);
    stroke-width: 2.25;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .drop .title {
    color: var(--text);
    font-weight: 800;
    font-size: 1.0625rem;
  }
  .drop .detail {
    color: var(--muted);
    font-size: 0.875rem;
  }

  .ask {
    margin: 1rem 0 0;
  }
</style>
