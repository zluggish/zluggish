<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../lib/i18n/index';
  import { ignored } from '../lib/api';
  import { z } from 'zod';
  import type { Api } from '../lib/api';

  const segmentSchema = z.object({
    start: z.number(),
    duration: z.number(),
    from: z.number(),
    to: z.number(),
    range: z.object({ low: z.number(), high: z.number() }).optional(),
    label: z.string().optional(),
    cadence: z.number().optional(),
    interval: z.object({ index: z.number(), count: z.number() }).optional(),
  });

  const summarySchema = z.object({
    name: z.string(),
    durationSeconds: z.number(),
    segments: z.array(segmentSchema),
    avgFraction: z.number(),
    normalizedFraction: z.number(),
    intensityFactor: z.number(),
    variabilityIndex: z.number(),
    zoneSeconds: z.array(z.number()),
    approximate: z.boolean(),
  });

  const workoutSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    plannedAt: z.string().nullable(),
    load: z.number().nullable(),
    summary: summarySchema,
  });

  type Segment = z.infer<typeof segmentSchema>;
  type Summary = z.infer<typeof summarySchema>;
  type Workout = z.infer<typeof workoutSchema>;

  const response = z.object({
    day: z.string(),
    connected: z.boolean(),
    ftp: z.number(),
    ftpSource: z.enum(['intervals', 'profile', 'none']).optional(),
    zoneLimits: z.array(z.number()).optional(),
    syncedAt: z.string().nullable(),
    workouts: z.array(workoutSchema),
    otherDays: z.array(z.string()),
  });

  type Today = z.infer<typeof response>;

  let {
    api,
  }: {
    api: Api;
  } = $props();

  let today = $state<Today | undefined>();
  let syncing = $state(false);
  let syncFailure = $state('');

  /** The segment the pointer or the keyboard picked on each chart, and where the cursor line stands. */
  let hovered = $state<Record<string, number | undefined>>({});
  let cursorX = $state<Record<string, number | undefined>>({});

  const zoneColours = ['#0d9e80', '#199e00', '#dbac00', '#ff7e0f', '#dd0347', '#6633cc', '#504861'];

  /** Coggan power zones as fractions of FTP: below the first limit is index 0, at or above the last is index 6. */
  const defaultZoneLimits = [0.55, 0.75, 0.9, 1.05, 1.2, 1.5];

  const zoneOf = (fraction: number, limits: Array<number>) => limits.filter((limit) => fraction >= limit).length;

  /** Segments that cross a zone boundary are drawn as their mean zone. */
  const meanFraction = (segment: Segment) => (segment.from + segment.to) / 2;

  const steps = (description: string) =>
    description
      .split('\n')
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter((line) => line.length > 0);

  const clock = (seconds: number) => {
    const s = Math.round(seconds);

    return s >= 3600
      ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
      : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const hours = (seconds: number) => {
    const minutes = Math.round(seconds / 60);

    return minutes < 60
      ? t('min', { value1: minutes })
      : t('h_min', { value1: Math.floor(minutes / 60), value2: minutes % 60 });
  };

  const when = (plannedAt: string | null) =>
    plannedAt && Number.isFinite(Date.parse(plannedAt))
      ? new Date(Date.parse(plannedAt)).toLocaleString([], {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })
      : t('no_time');

  const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

  const power = (fraction: number, ftp: number) =>
    ftp > 0 ? t('w', { value1: Math.round(fraction * ftp) }) : percent(fraction);

  const axisLabel = (fraction: number, ftp: number) => (ftp > 0 ? `${Math.round(fraction * ftp)}` : percent(fraction));

  /** Compact duration: '30m', '40s', '1h5m'. */
  const compact = (seconds: number) => {
    const whole = Math.round(seconds);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;

    return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s > 0 ? `${s}s` : ''}` : `${s}s`;
  };

  /** Rounded watts of one fraction, or its percent when the FTP is unknown. */
  /** The power of a segment as the chart describes it: a band, a flat step or a ramp, in watts and % of FTP. */
  const segmentPower = (segment: Segment, ftp: number) => {
    const low = segment.range ? segment.range.low : segment.from;
    const high = segment.range ? segment.range.high : segment.to;
    const share = low === high ? `${Math.round(low * 100)}%` : `${Math.round(low * 100)}-${Math.round(high * 100)}%`;

    if (ftp <= 0) {
      return share;
    }
    const power = low === high ? `${Math.floor(low * ftp)}w` : `${Math.floor(low * ftp)}-${Math.floor(high * ftp)}w`;

    return `${power} (${share})`;
  };

  /** The line above the chart: label, duration, power, work and cadence of the hovered segment. */
  const describe = (segment: Segment, ftp: number) => {
    const mean = segment.range ? (segment.range.low + segment.range.high) / 2 : (segment.from + segment.to) / 2;

    return [
      {
        text:
          segment.label ??
          (segment.interval
            ? t('today_workout_interval', { value1: segment.interval.index, value2: segment.interval.count })
            : ''),
        tone: '',
      },
      { text: compact(segment.duration), tone: '' },
      { text: segmentPower(segment, ftp), tone: 'power' },
      ...(ftp > 0
        ? [{ text: t('kj', { value1: ((mean * ftp * segment.duration) / 1000).toFixed(1) }), tone: 'power' }]
        : []),
      ...(segment.cadence === undefined
        ? []
        : [{ text: t('today_workout_cadence', { value1: segment.cadence }), tone: 'cadence' }]),
    ];
  };

  /** The chart in words: the zones and how long the workout spends in each. */
  const chartLabel = (workout: Workout) => {
    const zones = workout.summary.zoneSeconds
      .map((seconds, index) => (seconds > 0 ? `Z${index + 1} ${clock(seconds)}` : ''))
      .filter(Boolean);

    return `${workout.name}, ${hours(workout.summary.durationSeconds)}${zones.length ? `, ${zones.join(', ')}` : ''}`;
  };

  /** The plot area, the same numbers the markup draws with. */
  const frame = 600;
  const margin = 44;
  const edge = 8;

  /** The x of a cursor line: clamped to the plot area, in view-box units. */
  const clampX = (x: number) => Math.min(Math.max(x, margin), frame - edge);

  /** Pointer over the chart: the hovered segment and the x of the cursor line. */
  function brush(workoutId: string, row: Array<Segment>, longest: number, event: PointerEvent) {
    const box = (event.currentTarget as Element).getBoundingClientRect();
    const x = clampX(((Math.min(Math.max(event.clientX - box.left, 0), box.width) / box.width) * frame + 0.5) | 0);
    const at = (x * longest) / frame;
    const ends = row.map((segment) => segment.start + segment.duration);
    let index = 0;

    while (index < row.length - 1 && (ends[index] ?? 0) <= at) {
      index += 1;
    }
    hovered = { ...hovered, [workoutId]: index };
    cursorX = { ...cursorX, [workoutId]: x };
  }

  /** Keyboard over the chart: one segment per arrow key, first and last on Home and End. */
  function walk(workoutId: string, row: Array<Segment>, longest: number, movement: number) {
    const chosen = hovered[workoutId];
    const index =
      movement < 0
        ? 0
        : movement > row.length - 1
          ? row.length - 1
          : Math.min(Math.max((chosen ?? 0) + movement, 0), row.length - 1);
    const middle = ((row[index]?.start ?? 0) + (row[index]?.duration ?? 0)) / 2;

    hovered = { ...hovered, [workoutId]: index };
    cursorX = { ...cursorX, [workoutId]: clampX(margin + (frame * middle) / longest) };
  }

  /** Arrow keys step through the segments; Escape clears the readout. */
  function keyboard(workoutId: string, row: Array<Segment>, longest: number, event: KeyboardEvent) {
    const movement = { ArrowRight: 1, ArrowLeft: -1, Home: 0, End: row.length - 1 }[event.key];

    if (movement === undefined) {
      if (event.key === 'Escape') {
        release(workoutId);
      }

      return;
    }
    event.preventDefault();
    walk(workoutId, row, longest, movement);
  }

  function release(workoutId: string) {
    hovered = { ...hovered, [workoutId]: undefined };
    cursorX = { ...cursorX, [workoutId]: undefined };
  }

  async function load() {
    try {
      today = await api(response, '/api/me/workouts/today');
    } catch {
      /* The card stays hidden; the page has its own notice for a lost session. */
    }
  }

  async function sync() {
    syncing = true;
    syncFailure = '';

    try {
      await api(ignored, '/api/me/workouts/sync', 'POST', { provider: 'intervals' });
      await load();
    } catch (error) {
      syncFailure = error instanceof Error ? error.message : t('intervals_icu_sync_failed');
    }

    syncing = false;
  }

  onMount(() => {
    void load();
  });
</script>

{#if today?.connected}
  {@const data = today}
  {#snippet syncRow()}
    <div class="sync">
      {#if data.syncedAt}
        <span class="muted num"
          >{t('today_workout_last_sync')}: {new Date(Date.parse(data.syncedAt)).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}</span
        >
      {/if}
      <button type="button" class="text" disabled={syncing} onclick={() => void sync()}
        >{syncing ? t('syncing') : t('sync_now')}</button
      >
      {#if syncFailure}<span class="error" role="alert">{syncFailure}</span>{/if}
    </div>
  {/snippet}
  {#if data.workouts.length === 0}
    <section class="panel narrow" aria-labelledby="today-workout-empty">
      <h2 id="today-workout-empty">{t('today_workout_empty')}</h2>
      {#if data.otherDays.length > 0}
        <p class="muted">{t('today_workout_other_days', { value1: data.otherDays.join(', ') })}</p>
      {/if}
      {@render syncRow()}
    </section>
  {:else}
    {#each data.workouts as workout (workout.id)}
      {@const summary = workout.summary}
      {@const segments = summary.segments}
      {@const stepsList = steps(workout.description)}
      {@const zones = summary.zoneSeconds
        .map((seconds, index) => ({ label: `Z${index + 1}`, seconds, colour: zoneColours[index]! }))
        .filter((zone) => zone.seconds > 0)}
      {@const longest = Math.max(1, ...segments.map((segment) => segment.start + segment.duration))}
      {@const top = Math.max(
        0.2,
        ...segments.map((segment) => Math.max(segment.from, segment.to, segment.range?.high ?? 0)),
      )}
      {@const limits = data.zoneLimits?.length === 6 ? data.zoneLimits : defaultZoneLimits}
      {@const chartWidth = 600}
      {@const chartHeight = 160}
      {@const baseline = chartHeight - 22}
      {@const left = 44}
      {@const chart = (scale: number) => left + (scale * (chartWidth - left - 8)) / longest}
      {@const level = (fraction: number) => baseline - (Math.min(fraction, top) * (baseline - 12)) / top}
      {@const gridlines = top > 1 ? [1, top] : [0.5, 1].filter((fraction) => fraction < top)}
      {@const stepMinutes = summary.durationSeconds < 1800 ? 5 : 10}
      {@const ticks = Array.from(
        { length: Math.floor(longest / (stepMinutes * 60)) + 1 },
        (_, index) => index * stepMinutes * 60,
      )}
      <section class="panel workout" aria-labelledby="workout-{workout.id}">
        <div class="head">
          <span class="kicker">{t('today_workout_kicker')}</span>
          <svg class="bike" viewBox="0 0 24 24" aria-hidden="true"
            ><circle cx="5.5" cy="16.5" r="3.5" /><circle cx="18.5" cy="16.5" r="3.5" /><path
              d="M5.5 16.5 9.5 9h5l3.5 7.5M9.5 9 8 6.5h3M12.5 6.5h2.5M12 16.5h-6.5"
            /></svg
          >
          <h2 id="workout-{workout.id}">{workout.name}</h2>
          <dl class="stats">
            <div>
              <dt>{t('today_workout_planned')}</dt>
              <dd class="num">{when(workout.plannedAt)}</dd>
            </div>
            <div>
              <dt>{t('moving_time')}</dt>
              <dd class="num">{hours(summary.durationSeconds)}</dd>
            </div>
            <div>
              <dt>{t('today_workout_load')}</dt>
              <dd class="num">{workout.load ?? '-'}</dd>
            </div>
            <div>
              <dt>{t('today_workout_intensity')}</dt>
              <dd class="num">{percent(summary.intensityFactor)}</dd>
            </div>
          </dl>
        </div>

        <div class="columns">
          <div class="left">
            {#if stepsList.length > 0}
              <ul class="steps">
                {#each stepsList as step (step)}
                  <li>{step}</li>
                {/each}
              </ul>
            {/if}
            {#if summary.approximate}
              <p class="muted note">{t('today_workout_approximate')}</p>
            {/if}
          </div>
          <div class="right">
            {#if zones.length > 0}
              <table class="zones">
                <caption class="visually-hidden">{t('today_workout_zones')}</caption>
                <tbody>
                  {#each zones as zone (zone.label)}
                    {@const share = zone.seconds / summary.durationSeconds}
                    <tr>
                      <th scope="row" style:color={zone.colour}>{zone.label}</th>
                      <td class="bar-cell">
                        <span class="bar" aria-hidden="true"
                          ><span style:width="max({share * 100}%, 3px)" style:background={zone.colour}></span></span
                        >
                      </td>
                      <td class="num">{clock(zone.seconds)}</td>
                      <td class="num">{(share * 100).toFixed(1)}%</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
            <dl class="config">
              {#if data.ftp > 0}
                <div>
                  <dt>{t('today_workout_ftp')}</dt>
                  <dd class="num">
                    {t('w', { value1: data.ftp })}
                    {#if data.ftpSource === 'profile'}
                      <span class="muted note">{t('today_workout_ftp_profile_note')}</span>
                    {/if}
                  </dd>
                </div>
              {/if}
              <div>
                <dt>{t('today_workout_normalized')}</dt>
                <dd class="num">{power(summary.normalizedFraction, data.ftp)}</dd>
              </div>
              <div>
                <dt>{t('average')}</dt>
                <dd class="num">{power(summary.avgFraction, data.ftp)}</dd>
              </div>
              <div>
                <dt>{t('today_workout_variability')}</dt>
                <dd class="num">{summary.variabilityIndex.toFixed(2)}</dd>
              </div>
              {#if data.ftp > 0}
                <div>
                  <dt>{t('today_workout_work')}</dt>
                  <dd class="num">
                    {t('kj', {
                      value1: Math.round((summary.avgFraction * data.ftp * summary.durationSeconds) / 1000),
                    })}
                  </dd>
                </div>
              {/if}
            </dl>
          </div>
        </div>

        {#if segments.length > 0}
          {@const picked = hovered[workout.id] ?? -1}
          {@const shown = segments[picked] === undefined ? [] : describe(segments[picked]!, data.ftp)}
          <p class="readout" aria-live="polite">
            {#each shown as part (part.text)}
              <span class={part.tone === '' ? 'plain' : part.tone}>{part.text}</span>
            {/each}
          </p>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex (the chart is explored with the keyboard: arrows step through the segments) -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions (pointer and keys show the segment under the cursor) -->
          <svg
            class="profile"
            viewBox="0 0 {chartWidth} {chartHeight}"
            role="group"
            tabindex="0"
            aria-label={chartLabel(workout)}
            onpointermove={(event) => brush(workout.id, segments, longest, event)}
            onpointerdown={(event) => brush(workout.id, segments, longest, event)}
            onpointerleave={(event) => {
              if (event.pointerType === 'mouse') {
                release(workout.id);
              }
            }}
            onkeydown={(event) => keyboard(workout.id, segments, longest, event)}
            onblur={() => release(workout.id)}
          >
            {#each gridlines as fraction (fraction)}
              <line class="grid" x1={left} x2={chartWidth - 8} y1={level(fraction)} y2={level(fraction)} />
              <text class="tick" x={left - 6} y={level(fraction) + 4} text-anchor="end">
                {axisLabel(fraction, data.ftp)}
              </text>
            {/each}
            {#each segments.entries() as [position, segment] (segment.start)}
              {@const fromX = chart(segment.start)}
              {@const toX = chart(segment.start + segment.duration)}
              {#if segment.range}
                {@const band = segment.range}
                <polygon
                  class="step"
                  points={`${fromX},${level(band.low)} ${toX},${level(band.low)} ${toX},${baseline} ${fromX},${baseline}`}
                  fill={zoneColours[zoneOf((band.low + band.high) / 2, limits)]}
                  fill-opacity={position === picked ? 0.95 : 0.8}
                />
                <polygon
                  class="step"
                  points={`${fromX},${level(band.high)} ${toX},${level(band.high)} ${toX},${level(band.low)} ${fromX},${level(band.low)}`}
                  fill={zoneColours[zoneOf((band.low + band.high) / 2, limits)]}
                  fill-opacity={position === picked ? 0.5 : 0.35}
                />
              {:else}
                <polygon
                  class="step"
                  points={`${fromX},${level(segment.from)} ${toX},${level(segment.to)} ${toX},${baseline} ${fromX},${baseline}`}
                  fill={zoneColours[zoneOf(meanFraction(segment), limits)]}
                  fill-opacity={position === picked ? 0.95 : 0.8}
                />
              {/if}
            {/each}
            {#if cursorX[workout.id] !== undefined}
              <line class="cursor" x1={cursorX[workout.id]} x2={cursorX[workout.id]} y1="10" y2={baseline} />
            {/if}
            <line class="axis" x1={left} x2={chartWidth - 8} y1={baseline} y2={baseline} />
            {#each ticks as tick (tick)}
              <text class="tick" x={chart(tick)} y={baseline + 16} text-anchor="middle">{tick / 60}</text>
            {/each}
          </svg>
        {/if}

        {@render syncRow()}
      </section>
    {/each}
  {/if}
{/if}

<style>
  .panel {
    background: var(--glass);
    border-radius: 12px;
    padding: 1.25rem;
    margin: 0 0 1rem;
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
  .narrow {
    max-width: 34rem;
  }
  .muted {
    color: var(--muted);
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .error {
    color: var(--alarm);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  .head {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.5rem 0.75rem;
    align-items: center;
  }
  .kicker {
    grid-column: 1 / -1;
    color: var(--muted);
    font-size: 0.7rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .bike {
    width: 1.5rem;
    height: 1.5rem;
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.6;
    stroke-linecap: round;
  }
  .head h2 {
    margin: 0;
    font-size: 1.375rem;
    text-transform: none;
    letter-spacing: 0;
    overflow-wrap: anywhere;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(6.5rem, auto));
    gap: 0.25rem 1.25rem;
    margin: 0.5rem 0 0;
    grid-column: 1 / -1;
    text-align: right;
  }
  .stats dt {
    color: var(--muted);
    font-size: 0.75rem;
  }
  .stats dd {
    margin: 0.1rem 0 0;
    font-size: 1rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .columns {
    display: grid;
    gap: 1rem;
    margin-top: 1rem;
  }
  @media (min-width: 48rem) {
    .columns {
      grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    }
  }

  .steps {
    margin: 0;
    padding-left: 1.1rem;
  }
  .steps li {
    padding: 0.1rem 0;
  }
  .note {
    margin: 0.75rem 0 0;
    font-size: 0.8125rem;
  }

  .zones {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  .zones th,
  .zones td {
    padding: 0.3rem 0.4rem 0.3rem 0;
    border-bottom: 1px solid var(--line);
    font-weight: 700;
    vertical-align: middle;
  }
  .zones th {
    text-align: left;
    white-space: nowrap;
  }
  .zones td {
    text-align: right;
    white-space: nowrap;
  }
  .zones .bar-cell {
    width: 45%;
    padding-right: 0.75rem;
  }
  .zones .bar {
    display: block;
    width: 100%;
    height: 8px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.12);
    overflow: hidden;
  }
  .zones .bar > span {
    display: block;
    height: 100%;
    border-radius: 4px;
  }

  .config {
    display: grid;
    gap: 0;
    margin: 0.75rem 0 0;
  }
  .config div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.75rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--line);
  }
  .config dt {
    color: var(--muted);
  }
  .config dd {
    margin: 0;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }
  .config dd .note {
    display: block;
    margin-top: 0.15rem;
    font-size: 0.75rem;
    font-weight: 400;
    white-space: normal;
  }

  .profile {
    display: block;
    width: 100%;
    height: auto;
    margin-top: 1rem;
  }
  .readout {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    min-height: 1.5rem;
    margin: 0.75rem 0 0;
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }
  .readout .power {
    color: #c77dff;
  }
  .readout .cadence {
    color: #ff3df0;
  }
  .profile:focus-visible {
    outline: 2px solid var(--orange);
    outline-offset: 2px;
  }
  .profile .cursor {
    stroke: var(--muted);
    stroke-width: 1;
  }
  .profile .grid {
    stroke: var(--line);
    stroke-width: 1;
  }
  .profile .axis {
    stroke: var(--muted);
    stroke-width: 1.5;
  }
  .profile .tick {
    fill: var(--muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .sync {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-top: 1rem;
    font-size: 0.8125rem;
  }
  .text {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    font-weight: 800;
    text-decoration: underline;
    cursor: pointer;
  }
  .text:disabled {
    color: var(--muted);
    cursor: default;
  }
  .text:focus-visible {
    outline: 2px solid var(--orange);
    outline-offset: 2px;
  }
</style>
