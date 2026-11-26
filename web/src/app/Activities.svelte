<script lang="ts">
  import { t } from '../lib/i18n/index';
  import SlowLoading from '../components/SlowLoading.svelte';
  import ActivityChart from './ActivityChart.svelte';
  import TodayWorkout from './TodayWorkout.svelte';
  import { tick } from 'svelte';
  import { slide } from 'svelte/transition';
  import { ignored } from '../lib/api';
  import { z } from 'zod';
  import type { Api } from '../lib/api';

  const summarySchema = z.object({
    id: z.string(),
    name: z.string(),
    world: z.number(),
    sport: z.enum(['cycling', 'running']),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    distanceInMeters: z.number(),
    totalElevation: z.number(),
    movingTimeInMs: z.number(),
    calories: z.number(),
    avgWatts: z.number(),
    maxWatts: z.number(),
    normalizedPower: z.number(),
    tss: z.number(),
    avgHeartRate: z.number(),
    maxHeartRate: z.number(),
    avgCadence: z.number(),
    maxCadence: z.number(),
    avgSpeed: z.number(),
    maxSpeed: z.number(),
    fit: z.boolean(),
  });

  type Summary = z.infer<typeof summarySchema>;

  const series = z.array(z.number());

  const detailResponse = summarySchema.extend({
    imageIds: z.array(z.number()),
    chart: z
      .object({
        powerInWatts: series,
        cadencePerMin: series,
        heartRate: series,
        distanceInCm: series,
        speedInCmPerSec: series,
        timeInSec: series,
        altitudeInCm: series,
        latlng: z.array(z.tuple([z.number(), z.number()])),
      })
      .nullable(),
    chartPending: z.boolean(),
  });

  type Detail = z.infer<typeof detailResponse>;

  const provider = z.enum(['strava', 'freeStrava', 'garmin', 'runalyze', 'intervals', 'zwift']);

  type Provider = z.infer<typeof provider>;

  const uploadsResponse = z.object({
    uploads: z.array(
      z.object({
        provider,
        state: z.enum(['pending', 'sending', 'sent', 'failed', 'ambiguous', 'cancelled']).nullable(),
        error: z.string().nullable(),
      }),
    ),
  });

  type Upload = z.infer<typeof uploadsResponse>['uploads'][number];

  const listResponse = z.object({ activities: z.array(summarySchema), hasMore: z.boolean() });

  let {
    path,
    api,
    go,
  }: {
    path: string;
    api: Api;
    go: (next: string) => void;
  } = $props();

  const worlds = new Map([
    [2, t('richmond')],
    [6, t('watopia')],
    [7, t('london')],
    [8, t('new_york')],
    [9, t('innsbruck')],
    [10, t('bologna')],
    [11, t('yorkshire')],
    [12, t('crit_city')],
    [13, t('makuri_islands')],
    [14, t('france')],
    [15, t('paris')],
    [16, t('gravel_mountain')],
    [17, t('scotland')],
  ]);

  let activities = $state<Array<Summary> | null>(null);
  let detail = $state<Detail | null>(null);
  let failure = $state('');
  let chartWaitExpired = $state(false);

  let uploads = $state<{ id: string; list: Array<Upload> } | null>(null);
  let chooser = $state(false);
  let chosen = $state<Array<Provider>>([]);
  let sending = $state(false);
  let uploadFailure = $state('');

  let page = $state(0);
  let showList = $state(false);

  /** Deleting asks first, below the panel's actions. */
  let confirming = $state(false);
  let deleting = $state(false);
  let deleteFailure = $state('');
  let leaving = $state<string | null>(null);
  let announcement = $state('');
  let log = $state<HTMLElement>();
  let panel = $state<HTMLElement>();

  const ordered = $derived(
    [...(activities ?? [])].sort((a, b) => (started(b)?.getTime() ?? -Infinity) - (started(a)?.getTime() ?? -Infinity)),
  );

  const selectedId = $derived(/^\/activities\/(\d+)$/.exec(path)?.[1] ?? (showList ? null : (ordered[0]?.id ?? null)));

  /** The previous activity stays on screen until the next one arrives, so switching does not flicker. */
  const loading = $derived(selectedId !== null && detail?.id !== selectedId && !failure);

  let hasMore = $state(false);
  let requestVersion = 0;

  const started = (a: Summary) => {
    const time = Date.parse(a.startDate ?? '');

    return Number.isFinite(time) ? new Date(time) : null;
  };

  const months = $derived.by(() => {
    const groups: Array<{ key: string; label: string; activities: Array<Summary>; distance: number; time: number }> =
      [];

    for (const activity of ordered) {
      const date = started(activity);
      const key = date ? `${date.getFullYear()}-${date.getMonth()}` : 'undated';
      let group = groups.at(-1);

      if (group?.key !== key) {
        group = {
          key,
          label: date
            ? date.toLocaleDateString([], { month: 'long', year: 'numeric' })
            : t('activities_detail_missing_start_date'),
          activities: [],
          distance: 0,
          time: 0,
        };
        groups.push(group);
      }

      group.activities.push(activity);
      group.distance += activity.distanceInMeters;
      group.time += activity.movingTimeInMs;
    }

    return groups;
  });

  const km = (m: number) =>
    t('km', {
      value1: (m / 1000).toLocaleString([], { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    });

  const clock = (ms: number) => {
    const s = Math.round(ms / 1000);

    return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  const hours = (ms: number) => {
    const minutes = Math.round(ms / 60_000);

    return minutes < 60
      ? t('min', { value1: minutes })
      : t('h_min', { value1: Math.floor(minutes / 60), value2: minutes % 60 });
  };

  const speed = (a: Summary) =>
    a.avgSpeed > 0 ? a.avgSpeed : a.movingTimeInMs > 0 ? a.distanceInMeters / (a.movingTimeInMs / 1000) : 0;

  const pace = (mps: number) => {
    const s = Math.round(1000 / mps);

    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} /km`;
  };

  const pacing = (a: Summary, mps: number) =>
    mps <= 0 ? '' : a.sport === 'running' ? pace(mps) : t('km_h', { value1: (mps * 3.6).toFixed(1) });

  const world = (a: Summary) => worlds.get(a.world) ?? (a.world ? t('world', { value1: a.world }) : '');
  const title = (a: Summary) => a.name.trim() || t('untitled_activity');

  /** Average and maximum side by side. A measure the activity did not record is left out. */
  const measures = (a: Detail) =>
    (
      [
        [
          t('power'),
          a.sport === 'running' ? 0 : a.avgWatts,
          a.sport === 'running' ? 0 : a.maxWatts,
          (v: number) => t('w', { value1: Math.round(v) }),
        ],
        [t('heart_rate'), a.avgHeartRate, a.maxHeartRate, (v: number) => t('bpm', { value1: Math.round(v) })],
        [
          a.sport === 'running' ? t('cadence') : t('cadence'),
          a.avgCadence,
          a.maxCadence,
          (v: number) => `${Math.round(v)} ${a.sport === 'running' ? 'spm' : 'rpm'}`,
        ],
        [a.sport === 'running' ? t('pace') : t('speed'), speed(a), a.maxSpeed, (v: number) => pacing(a, v)],
      ] as const
    ).filter(([, avg, max]) => avg > 0 || max > 0);

  const extras = (a: Detail) =>
    (
      [
        [t('normalized_power'), a.normalizedPower, t('w', { value1: Math.round(a.normalizedPower) })],
        [t('training_stress_score'), a.tss, `${Math.round(a.tss)}`],
        [t('calories'), a.calories, t('kcal', { value1: Math.round(a.calories) })],
      ] as const
    ).filter(([, value]) => value > 0);

  const services: Record<Provider, string> = {
    strava: t('strava'),
    freeStrava: t('strava'),
    garmin: t('garmin_connect'),
    runalyze: t('runalyze'),
    intervals: t('intervals_icu'),
    zwift: t('zwift'),
  };

  /** Only the Strava session cookie can attach images; every other service takes the FIT file alone. */
  const contents = (provider: Provider, images: number) =>
    images === 0
      ? t('fit_file')
      : provider === 'freeStrava'
        ? t('activities_upload_contents', {
            value1: images,
            value2: images === 1 ? t('activities_upload_image_singular') : t('activities_upload_image_plural'),
          })
        : t('activities_upload_fit_only');

  const inFlight = (u: Upload) => u.state === 'pending' || u.state === 'sending';
  const uploaded = (u: Upload) => u.state === 'sent' || u.state === 'ambiguous';

  function progress(u: Upload) {
    switch (u.state) {
      case 'pending':
        return t('waiting');
      case 'sending':
        return t('uploading');
      case 'sent':
        return t('uploaded');
      case 'ambiguous':
        return t('result_unknown');
      case 'failed':
        return u.error?.startsWith('strava_session') ? t('session_expired') : t('failed');
      case 'cancelled':
        return t('cancelled');
      default:
        return t('not_uploaded');
    }
  }

  /** One sentence for the closed section, so the state is visible without opening the chooser. */
  function summary(list: Array<Upload>) {
    const names = (match: (u: Upload) => boolean) => {
      const found = [...new Set(list.flatMap((u) => (match(u) ? [services[u.provider]] : [])))];

      return found.length > 1 ? `${found.slice(0, -1).join(', ')} and ${found.at(-1)}` : found[0];
    };

    return [
      names((u) => u.state === 'sent') && t('uploaded_to', { value1: names((u) => u.state === 'sent') }),
      names(inFlight) && t('uploading_to', { value1: names(inFlight) }),
      names((u) => u.state === 'failed') && t('upload_to_failed', { value1: names((u) => u.state === 'failed') }),
      names((u) => u.state === 'ambiguous') &&
        t('activities_upload_provider_duplicate_warning', { value1: names((u) => u.state === 'ambiguous') }),
    ]
      .filter(Boolean)
      .join(' ');
  }

  async function loadUploads(id: string) {
    try {
      const body = await api(uploadsResponse, `/api/me/activities/${id}/uploads`);

      if (detail?.id === id) {
        uploads = { id, list: body.uploads };
      }
    } catch {
      /* The section stays as it was; the next open or poll tries again. */
    }
  }

  function toggleChooser(list: Array<Upload>) {
    chooser = !chooser;
    confirming = false;
    uploadFailure = '';

    // Services that do not have the activity yet start ticked; uploading again is a deliberate choice.
    if (chooser) {
      chosen = list.flatMap((u) => (uploaded(u) || inFlight(u) ? [] : [u.provider]));
    }
  }

  async function upload(id: string, list: Array<Upload>) {
    sending = true;
    uploadFailure = '';
    const failures: Array<string> = [];

    for (const provider of chosen) {
      const again = list.some((u) => u.provider === provider && uploaded(u));

      try {
        const body = await api(uploadsResponse, `/api/me/activities/${id}/uploads`, 'POST', {
          provider,
          again,
        });

        if (detail?.id === id) {
          uploads = { id, list: body.uploads };
        }
      } catch (error) {
        failures.push(
          t('provider_failure', {
            value1: services[provider],
            value2: error instanceof Error ? error.message : t('activities_upload_start_error'),
          }),
        );
      }
    }

    sending = false;
    uploadFailure = failures.join(' ');

    // The chooser stays open, so each row shows its upload on the way.
    if (!failures.length) {
      chosen = [];
    }
  }

  async function loadList(currentPage: number) {
    const version = ++requestVersion;

    try {
      const body = await api(listResponse, `/api/me/activities?page=${currentPage}`);

      if (version !== requestVersion) {
        return;
      }
      activities = body.activities;
      hasMore = body.hasMore;
    } catch (error) {
      if (version === requestVersion) {
        failure = error instanceof Error ? error.message : t('activities_list_load_error');
      }
    }
  }

  /** The chart is made by a job after the activity is saved; ask again a few times while it runs. */
  async function loadDetail(id: string, attempt = 0) {
    try {
      const body = await api(detailResponse, `/api/me/activities/${id}`);

      if (selectedId !== id) {
        return;
      }
      const retry = body.chartPending && attempt < 8;
      detail = body;
      chartWaitExpired = body.chartPending && !retry;

      if (retry) {
        setTimeout(() => void loadDetail(id, attempt + 1), 1500 * (attempt + 1));
      }
    } catch (error) {
      if (selectedId !== id) {
        return;
      }
      detail = null;
      failure = error instanceof Error ? error.message : t('activities_detail_load_error');
    }
  }

  $effect(() => {
    void loadList(page);
  });

  /** The upload button shares its row with delete; without it, delete stands alone at the bottom. */
  const uploadButton = (a: Detail) => a.fit && a.endDate && uploads?.id === a.id && uploads.list.length > 0;

  /** Derived, so the chart polls that replace `detail` do not close the chooser. */
  const uploadable = $derived(detail?.fit ? detail.id : null);

  $effect(() => {
    const id = uploadable;
    chooser = false;
    uploadFailure = '';

    if (id) {
      void loadUploads(id);
    }
  });

  $effect(() => {
    const id = uploads?.id;

    if (!id || !uploads?.list.some(inFlight)) {
      return;
    }

    const timer = setInterval(() => {
      if (!document.hidden) {
        void loadUploads(id);
      }
    }, 3000);

    return () => clearInterval(timer);
  });

  $effect(() => {
    const id = selectedId;
    failure = '';
    confirming = false;
    deleteFailure = '';

    if (id) {
      void loadDetail(id);
    }
  });

  async function ask() {
    confirming = true;
    chooser = false;
    deleteFailure = '';
    await tick();
    panel?.querySelector<HTMLElement>('[data-keep]')?.focus();
  }

  async function keep() {
    confirming = false;
    deleteFailure = '';
    await tick();
    panel?.querySelector<HTMLElement>('[data-delete]')?.focus();
  }

  function escape(event: KeyboardEvent) {
    if (event.key === 'Escape' && !deleting) {
      void keep();
    }
  }

  async function remove(a: Detail) {
    deleting = true;
    deleteFailure = '';

    try {
      await api(ignored, `/api/me/activities/${a.id}`, 'DELETE');
    } catch (error) {
      deleting = false;
      deleteFailure = error instanceof Error && error.message ? error.message : t('activity_delete_error');

      return;
    }

    leaving = a.id;
    deleting = false;
    confirming = false;
    detail = null;
    uploads = null;
    activities = (activities ?? []).filter((item) => item.id !== a.id);
    announcement = t('activity_deleted', { value1: title(a) });

    // Beside the list the newest activity opens in its place; on a phone the list comes back.
    const narrow = matchMedia('(max-width: 61.99rem)').matches;
    showList = narrow;
    go('/activities');
    await tick();
    (narrow ? log : panel)?.focus();

    // The next page moves up by one; an emptied last page steps back.
    if (activities.length === 0 && page > 0) {
      page--;
    } else {
      void loadList(page);
    }
  }

  /** Only the deleted row folds away; rows that leave because the page changed go at once. */
  function fold(node: Element, { id }: { id: string }) {
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

    return id === leaving && !still ? slide(node, { duration: 220 }) : { duration: 0 };
  }

  function open(event: MouseEvent, href: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    showList = href === '/activities';
    go(href);
  }
</script>

{#snippet deleteButton()}
  <button
    type="button"
    class="delete"
    data-delete
    aria-label={t('delete_activity')}
    aria-expanded={confirming}
    aria-controls="delete-activity"
    disabled={deleting}
    onclick={() => (confirming ? void keep() : void ask())}
    ><svg viewBox="0 0 20 20" aria-hidden="true"
      ><path d="M3.5 5.5h13M8 5.5V3.5h4v2M5 5.5l.8 11h8.4l.8-11M8.5 8.5v5.5M11.5 8.5v5.5" /></svg
    >{t('delete')}</button
  >
{/snippet}

{#snippet deleteQuestion(a: Detail)}
  {#if confirming}
    <div
      id="delete-activity"
      class="question"
      role="group"
      aria-labelledby="delete-question"
      aria-describedby="delete-detail"
    >
      <p id="delete-question"><strong>{t('activity_delete_question')}</strong></p>
      <p id="delete-detail" class="muted">{t('activity_delete_detail')}</p>
      {#if deleteFailure}<p class="error" role="alert">{deleteFailure}</p>{/if}
      <div class="choices">
        <button type="button" data-keep disabled={deleting} onclick={() => void keep()} onkeydown={escape}
          >{t('keep')}</button
        >
        <button type="button" class="danger" disabled={deleting} onclick={() => void remove(a)} onkeydown={escape}
          >{deleting ? t('deleting') : t('delete')}</button
        >
      </div>
    </div>
  {/if}
{/snippet}

{#snippet uploader(a: Detail)}
  <div class="inset upload">
    <h3>{t('upload')}</h3>
    {#if !a.endDate}
      <p class="muted">{t('activities_upload_unfinished_hint')}</p>
    {:else if uploads?.id !== a.id}
      <p class="muted">{t('activities_upload_loading_services')}</p>
    {:else if uploads.list.length === 0}
      <p class="muted">
        {t('activities_upload_connect_service_prefix')}
        <a href="/integrations" onclick={(e) => open(e, '/integrations')}>{t('integrations')}</a>
        {t('activities_upload_connect_service_suffix')}
      </p>
    {:else}
      {@const list = uploads.list}
      <p class="muted" aria-live="polite">
        {summary(list) ||
          t('activities_upload_description', {
            value1: a.imageIds.length ? t('activities_upload_images_suffix') : '',
          })}
      </p>
      <div class="actions">
        <button
          type="button"
          class="toggle"
          aria-expanded={chooser}
          aria-controls="upload-chooser"
          onclick={() => toggleChooser(list)}>{chooser ? t('close') : t('upload_to_integrations')}</button
        >
        {@render deleteButton()}
      </div>
      {@render deleteQuestion(a)}
      {#if chooser}
        <form
          id="upload-chooser"
          class="chooser"
          onsubmit={(event) => {
            event.preventDefault();
            void upload(a.id, list);
          }}
        >
          <fieldset>
            <legend class="visually-hidden">{t('activities_upload_services_label')}</legend>
            <ul class="plain services">
              {#each list as u (u.provider)}
                <li class="service" class:sending={inFlight(u)} data-state={u.state ?? 'none'}>
                  <label>
                    <input type="checkbox" value={u.provider} bind:group={chosen} disabled={sending || inFlight(u)} />
                    <span class="name">
                      <strong>{services[u.provider]}</strong>
                      <small>{contents(u.provider, a.imageIds.length)}</small>
                    </span>
                    <span class="state">{progress(u)}</span>
                  </label>
                  {#if inFlight(u)}<span class="bar" aria-hidden="true"></span>{/if}
                </li>
              {/each}
            </ul>
          </fieldset>
          {#each list.filter((u) => chosen.includes(u.provider) && uploaded(u)) as u (u.provider)}
            <p class="caution">
              {t('activities_upload_duplicate_warning', {
                value1: services[u.provider],
                value2:
                  u.state === 'sent' ? t('activities_upload_duplicate') : t('activities_upload_possible_duplicate'),
              })}
            </p>
          {/each}
          {#if list.some((u) => u.state === 'failed' && u.error?.startsWith('strava_session'))}
            <p class="caution">
              {t('activities_upload_session_rejected_prefix')}
              <a href="/integrations" onclick={(e) => open(e, '/integrations')}>{t('integrations')}</a>{t(
                'activities_upload_retry_suffix',
              )}
            </p>
          {/if}
          {#if uploadFailure}<p class="error" role="alert">{uploadFailure}</p>{/if}
          {#if chosen.length}
            <button class="primary" disabled={sending}
              >{sending
                ? t('starting_upload')
                : chosen.length === 1
                  ? t('upload_to', { value1: services[chosen[0]!] })
                  : t('upload_to_services', { value1: chosen.length })}</button
            >
          {/if}
          {#if a.imageIds.length && !list.some((u) => u.provider === 'freeStrava')}
            <p class="muted note">{t('activities_upload_images_hint')}</p>
          {/if}
        </form>
      {/if}
    {/if}
  </div>
{/snippet}

{#if failure}<p class="notice failed" role="alert">{failure}</p>{/if}
<p class="visually-hidden" role="status">{announcement}</p>

<TodayWorkout {api} />

{#if activities === null}
  {#if !failure}<SlowLoading />{/if}
{:else if activities.length === 0 && page === 0}
  <section class="panel narrow">
    <p>{t('activities_list_empty')}</p>
  </section>
{:else}
  <div class="activities" class:open={selectedId !== null}>
    <div class="log" bind:this={log} tabindex="-1">
      {#each months as month (month.key)}
        <section class="month" aria-labelledby="month-{month.key}">
          <div class="month-head">
            <h2 id="month-{month.key}">{month.label}</h2>
            <p class="totals">
              {month.activities.length}
              {month.activities.length === 1 ? 'activity' : 'activities'}, {km(month.distance)}, {hours(
                month.time,
              )}{#if page > 0 || hasMore}
                {t('page_scope_hint')}{/if}
            </p>
          </div>
          <ul class="plain">
            {#each month.activities as a (a.id)}
              {@const date = started(a)}
              <li out:fold={{ id: a.id }}>
                <a
                  class="activity"
                  href="/activities/{a.id}"
                  aria-current={selectedId === a.id ? 'page' : undefined}
                  onclick={(e) => open(e, `/activities/${a.id}`)}
                >
                  <span class="day" aria-hidden={date ? 'true' : undefined}
                    >{#if date}<small>{date.toLocaleDateString([], { weekday: 'short' })}</small
                      >{date.getDate()}{:else}<small>{t('no_date')}</small>{/if}</span
                  >
                  <span class="what">
                    <strong>{title(a)}</strong>
                    <small
                      >{#if date}<span class="visually-hidden"
                          >{date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })},
                        </span>{/if}{world(a)}{#if a.sport === 'running'}{world(a)
                          ? ', run'
                          : t('run')}{/if}{#if !a.endDate}<span class="unfinished"
                          >{t('not_finished', {
                            value1: world(a) || a.sport === 'running' ? ', ' : '',
                          })}</span
                        >{/if}</small
                    >
                  </span>
                  <span class="how">
                    <strong>{km(a.distanceInMeters)}</strong>
                    <small>{clock(a.movingTimeInMs)}</small>
                  </span>
                </a>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
      {#if page > 0 || hasMore}
        <nav class="pagination" aria-label={t('activity_pages')}>
          <button type="button" disabled={page === 0} onclick={() => page--}>{t('previous')}</button>
          <span>{t('page', { value1: page + 1 })}</span>
          <button type="button" disabled={!hasMore} onclick={() => page++}>{t('next')}</button>
        </nav>
      {/if}
    </div>

    <div class="detail">
      <section
        class="panel"
        class:stale={loading && detail}
        id="activity-detail"
        bind:this={panel}
        tabindex="-1"
        aria-labelledby="activity-name"
        aria-busy={loading}
      >
        {#if selectedId}
          <a class="back" href="/activities" onclick={(e) => open(e, '/activities')}>{t('all_activities')}</a>
        {/if}
        {#if loading}
          <div class="loading"><SlowLoading /></div>
        {/if}
        {#if !selectedId}
          <p class="muted">{t('activities_detail_empty')}</p>
        {:else if detail}
          {@const date = started(detail)}
          <h2 id="activity-name">{title(detail)}</h2>
          <p class="when">
            {#if date}{date.toLocaleDateString([], {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}, {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{/if}{#if world(detail)}{date
                ? ' in '
                : ''}{world(detail)}{/if}
          </p>

          {#if detail.chart && detail.chart.timeInSec.length > 1}
            {#key detail.id}<ActivityChart chart={detail.chart} running={detail.sport === 'running'} />{/key}
          {:else if detail.chartPending}
            <p class="pending" role="status">
              {chartWaitExpired ? t('activities_detail_timeout') : t('activities_detail_loading_route')}
            </p>
          {/if}

          <dl class="headline">
            <div>
              <dt>{t('distance')}</dt>
              <dd>{km(detail.distanceInMeters)}</dd>
            </div>
            <div>
              <dt>{t('moving_time')}</dt>
              <dd>{clock(detail.movingTimeInMs)}</dd>
            </div>
            <div>
              <dt>{t('elevation_gain')}</dt>
              <dd>{t('m', { value1: Math.round(detail.totalElevation) })}</dd>
            </div>
          </dl>

          {#if measures(detail).length}
            <table class="measures">
              <caption class="visually-hidden">{t('averages_and_maximums')}</caption>
              <thead>
                <tr><td></td><th scope="col">{t('average')}</th><th scope="col">{t('max')}</th></tr>
              </thead>
              <tbody>
                {#each measures(detail) as [label, avg, max, format] (label)}
                  <tr>
                    <th scope="row">{label}</th>
                    <td>{avg > 0 ? format(avg) : '–'}</td>
                    <td>{max > 0 ? format(max) : '–'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}

          {#if extras(detail).length}
            <dl class="config">
              {#each extras(detail) as [label, , text] (label)}<div>
                  <dt>{label}</dt>
                  <dd class="num">{text}</dd>
                </div>{/each}
            </dl>
          {/if}

          <div class="inset">
            <h3>{t('fit_file')}</h3>
            {#if detail.fit}
              <a class="button primary" href="/api/me/activities/{detail.id}/fit" download>{t('download_fit_file')}</a>
            {:else}
              <p class="muted">{t('activities_detail_missing_fit')}</p>
            {/if}
          </div>

          {#if detail.imageIds.length}
            <div class="inset">
              <h3>{t('images')}</h3>
              <ul class="plain images">
                {#each detail.imageIds as image, index (image)}
                  <li>
                    <a href="/api/me/activities/{detail.id}/images/{image}" target="_blank" rel="noopener">
                      <img
                        src="/api/me/activities/{detail.id}/images/{image}"
                        alt="Image {index + 1} of {detail.imageIds.length} from {title(detail)}"
                        loading="lazy"
                      />
                    </a>
                    <a class="download" href="/api/me/activities/{detail.id}/images/{image}?download" download
                      >{t('download')}<span class="visually-hidden"> {t('image', { value1: index + 1 })}</span></a
                    >
                  </li>
                {/each}
              </ul>
            </div>
          {/if}

          {#if detail.fit}{@render uploader(detail)}{/if}
          {#if !uploadButton(detail)}
            <div class="actions">{@render deleteButton()}</div>
            {@render deleteQuestion(detail)}
          {/if}
        {/if}
      </section>
    </div>
  </div>
{/if}

<style>
  .activities {
    display: grid;
    gap: 1rem;
    align-items: start;
  }
  @media (min-width: 62rem) {
    .activities {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
    }
    .detail {
      position: sticky;
      top: 1rem;
    }
    .detail .back {
      display: none;
    }
    /* Beside the list, the previous activity fades back under the bar; the words are for screen readers. */
    .detail .stale > :not(.loading) {
      opacity: 0.45;
      transition: opacity 200ms 400ms;
    }
  }
  /* On a phone, an open activity takes the screen; the list is one link away. */
  @media (max-width: 61.99rem) {
    .open .log,
    .activities:not(.open) .detail {
      display: none;
    }
    .stale > :not(.back, .loading) {
      display: none;
    }
  }

  .detail .panel {
    position: relative;
  }
  .detail .panel > * {
    transition: opacity 100ms;
  }
  .bar {
    position: absolute;
    top: 0;
    left: 12px;
    right: 12px;
    height: 3px;
    overflow: hidden;
    border-radius: 0 0 3px 3px;
  }
  .bar::after {
    content: '';
    position: absolute;
    inset: 0 auto 0 0;
    width: 35%;
    border-radius: inherit;
    background: var(--orange);
    animation: sweep 1.1s ease-in-out infinite;
  }
  @keyframes sweep {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(290%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bar::after {
      width: 100%;
      opacity: 0.6;
      animation: none;
    }
    .question {
      animation: none;
    }
  }

  .panel {
    background: var(--glass);
    border-radius: 12px;
    padding: 1.25rem;
    margin: 0 0 1rem;
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
  .panel:focus {
    outline: none;
  }
  .narrow {
    max-width: 34rem;
  }
  .plain {
    list-style: none;
    margin: 0;
    padding: 0;
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

  .pagination {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    margin-top: 1.5rem;
  }

  .month + .month {
    margin-top: 1.5rem;
  }
  .month-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 1rem;
    margin: 0 0 0.5rem;
    padding: 0 0.25rem;
  }
  .month-head h2 {
    margin: 0;
    font-size: 1.125rem;
    text-transform: none;
    letter-spacing: 0;
  }
  .totals {
    margin: 0;
    color: var(--muted);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  li + li {
    margin-top: 0.4rem;
  }
  .activity {
    display: grid;
    grid-template-columns: 2.75rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.85rem;
    padding: 0.55rem 0.85rem 0.55rem 0.6rem;
    border: 2px solid transparent;
    border-radius: 12px;
    background: var(--glass);
    text-decoration: none;
  }
  .activity:hover {
    background: var(--glass-raised);
    border-color: var(--orange);
  }
  .activity[aria-current] {
    background: var(--glass-raised);
    border-color: var(--text);
  }
  .activity small {
    display: block;
    color: var(--muted);
    font-size: 0.8125rem;
  }
  .day {
    display: grid;
    justify-items: center;
    font-size: 1.375rem;
    font-weight: 800;
    line-height: 1.05;
    font-variant-numeric: tabular-nums;
  }
  .day small {
    font-size: 0.6875rem;
  }
  .what {
    min-width: 0;
  }
  .what strong {
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .what small {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .how {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .back {
    display: inline-block;
    margin-bottom: 0.75rem;
    font-size: 0.8125rem;
    font-weight: 800;
  }
  .back::before {
    content: '‹ ';
  }
  .detail h2 {
    margin: 0 0 0.25rem;
    font-size: 1.375rem;
    text-transform: none;
    letter-spacing: 0;
    overflow-wrap: anywhere;
  }
  .when {
    margin: 0 0 1rem;
    color: var(--muted);
  }
  .pending {
    padding: 0.75rem 0.9rem;
    border-radius: 10px;
    background: var(--well);
    color: var(--muted);
  }

  .headline {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
    margin: 0 0 1rem;
  }
  .headline dt {
    color: var(--muted);
    font-size: 0.8125rem;
  }
  .headline dd {
    margin: 0.1rem 0 0;
    font-size: 1.375rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .measures {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  .measures th,
  .measures td {
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--line);
    text-align: right;
    font-weight: 600;
  }
  .measures thead th {
    color: var(--muted);
    font-size: 0.8125rem;
  }
  .measures tbody th {
    text-align: left;
    color: var(--muted);
  }
  .measures tbody td {
    font-weight: 800;
  }

  .config {
    display: grid;
    gap: 0;
    margin: 0;
  }
  .config div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.75rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--line);
  }
  .config dt {
    color: var(--muted);
  }
  .config dd {
    margin: 0;
    font-weight: 800;
  }

  .inset {
    padding: 1rem 0 0;
    margin: 1rem 0 0;
    border-top: 1px solid var(--line);
  }
  .config + .inset,
  .measures + .inset {
    border-top: 0;
  }
  h3 {
    margin: 0 0 0.25rem;
    font-size: 0.9375rem;
    font-weight: 800;
  }
  .inset p {
    margin: 0 0 0.75rem;
  }
  a.button {
    display: inline-block;
    padding: 0.65rem 1.4rem;
    border-radius: 10px;
    background: var(--orange);
    box-shadow: 0 3px 0 var(--orange-deep);
    font-size: 0.875rem;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    text-decoration: none;
  }
  a.button:hover {
    background: #f06a1e;
  }
  a.button:active {
    transform: translateY(2px);
    box-shadow: 0 1px 0 var(--orange-deep);
  }

  .images {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
    gap: 0.75rem;
    margin-top: 0.5rem;
  }
  .images li + li {
    margin: 0;
  }
  .images img {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: 8px;
    background: var(--well);
  }
  .images a:first-child:hover img {
    outline: 2px solid var(--orange);
    outline-offset: 2px;
  }
  .download {
    display: inline-block;
    margin-top: 0.3rem;
    font-size: 0.8125rem;
  }

  /* Upload is the everyday action; delete is rare, so it sits quietly at the far end of the same row. */
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-top: 1rem;
  }
  .upload .actions {
    margin-top: 0;
  }
  .actions button {
    margin: 0;
  }
  .actions .delete {
    margin-left: auto;
  }
  .delete {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding-inline: 0.6rem;
    border-color: transparent;
    color: var(--muted);
  }
  .delete svg {
    width: 1.05rem;
    height: 1.05rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .delete:hover,
  .delete[aria-expanded='true'] {
    color: var(--alarm);
    background: rgb(255 90 70 / 0.12);
  }

  /* The question opens under the button that asked it, tinted so it cannot pass for the upload chooser. */
  .question {
    margin: 0.85rem 0 0;
    padding: 0.85rem 0.95rem;
    border: 2px solid rgb(255 179 166 / 0.6);
    border-radius: 10px;
    background: rgb(120 40 34 / 0.38);
    animation: arm 180ms ease-out;
  }
  @keyframes arm {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
  .question p {
    margin: 0;
  }
  .question .muted {
    margin-top: 0.2rem;
    font-size: 0.875rem;
  }
  .question .error {
    margin-top: 0.6rem;
    font-size: 0.875rem;
  }
  .choices {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .choices button {
    margin: 0;
  }
  button.danger {
    border-color: rgb(255 179 166 / 0.75);
    color: var(--alarm);
  }
  button.danger:hover {
    background: rgb(255 90 70 / 0.14);
  }
  .upload .toggle[aria-expanded='true'] {
    border-color: var(--line);
  }
  .chooser {
    margin: 0.85rem 0 0;
    padding: 0;
    background: none;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  .chooser fieldset {
    margin: 0;
    padding: 0;
    border: 0;
  }
  .services {
    border-radius: 10px;
    background: var(--well);
    overflow: hidden;
  }
  .services li + li {
    margin: 0;
    border-top: 1px solid var(--line);
  }
  .service {
    position: relative;
  }
  .service label {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.85rem;
    margin: 0;
    padding: 0.7rem 0.9rem;
    color: var(--text);
    cursor: pointer;
  }
  .service label:has(:disabled) {
    cursor: default;
  }
  .service label:hover:not(:has(:disabled)) {
    background: rgb(255 255 255 / 0.06);
  }
  .service .name small {
    display: block;
    color: var(--muted);
    font-size: 0.8125rem;
  }
  .service .state {
    color: var(--muted);
    font-size: 0.8125rem;
    white-space: nowrap;
  }
  .service[data-state='sent'] .state {
    color: #a7f3c1;
  }
  .service[data-state='sent'] .state::before {
    content: '✓ ';
  }
  .service[data-state='failed'] .state,
  .service[data-state='ambiguous'] .state {
    color: var(--alarm);
  }
  .service.sending .state {
    color: var(--text);
  }
  .service .bar {
    top: auto;
    bottom: 0;
    left: 0;
    right: 0;
    border-radius: 0;
  }
  .chooser .caution {
    margin: 0.75rem 0 0;
    padding: 0.5rem 0.75rem;
    border-left: 3px solid var(--orange);
    border-radius: 0 6px 6px 0;
    background: rgb(226 86 12 / 0.12);
    font-size: 0.875rem;
  }
  .chooser .error {
    margin: 0.75rem 0 0;
  }
  .chooser .note {
    margin: 0.75rem 0 0;
    font-size: 0.8125rem;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  @media (max-width: 500px) {
    .panel {
      padding: 0.9rem;
    }
    .service label {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .service .state {
      grid-column: 2;
    }
    .headline dd {
      font-size: 1.125rem;
    }
  }
</style>
