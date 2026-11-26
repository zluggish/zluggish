<script lang="ts" module>
  export type Chart = {
    powerInWatts: Array<number>;
    cadencePerMin: Array<number>;
    heartRate: Array<number>;
    distanceInCm: Array<number>;
    speedInCmPerSec: Array<number>;
    timeInSec: Array<number>;
    altitudeInCm: Array<number>;
    latlng: Array<[number, number]>;
  };
</script>

<script lang="ts">
  import { t } from '../lib/i18n/index';
  let { chart, running }: { chart: Chart; running: boolean } = $props();

  const width = 600;
  const height = 140;
  const count = $derived(chart.timeInSec.length);

  const along = $derived(chart.distanceInCm.some((d) => d > 0) ? chart.distanceInCm : chart.timeInSec);
  const end = $derived(Math.max(1, along.at(-1) ?? 1));

  const metres = $derived(chart.altitudeInCm.map((a) => a / 100));
  const low = $derived(Math.min(...metres));
  const high = $derived(Math.max(...metres));

  // A flat activity still gets a band, so the line sits mid-height instead of on an edge.
  const floor = $derived(high - low < 10 ? (low + high) / 2 - 5 : low);
  const span = $derived(high - low < 10 ? 10 : high - low);

  const xAt = (i: number) => ((along[i] ?? 0) / end) * width;
  const yAt = (i: number) => height - 8 - (((metres[i] ?? floor) - floor) / span) * (height - 24);

  const line = $derived(
    Array.from({ length: count }, (_, i) => `${xAt(i).toFixed(1)},${yAt(i).toFixed(1)}`).join(' L'),
  );

  const area = $derived(`M0,${height} L${line} L${width},${height} Z`);

  /** Zwift worlds report real coordinates. Longitude shrinks with latitude, so scale it to keep the shape true. */
  const route = $derived.by(() => {
    const points = chart.latlng.map(([lat, lng], i) => ({ i, lat, lng })).filter((p) => p.lat !== 0 || p.lng !== 0);

    if (points.length < 2) {
      return null;
    }
    const scale = Math.cos((points.reduce((sum, p) => sum + p.lat, 0) / points.length) * (Math.PI / 180));
    const xy = points.map((p) => ({ i: p.i, x: p.lng * scale, y: -p.lat }));
    const minX = Math.min(...xy.map((p) => p.x));
    const minY = Math.min(...xy.map((p) => p.y));
    const size = Math.max(Math.max(...xy.map((p) => p.x)) - minX, Math.max(...xy.map((p) => p.y)) - minY, 1e-6);
    // Normalize to a 1000-unit box so stroke widths and markers are the same on every activity.
    const unit = 1000 / size;
    const placed = xy.map((p) => ({ i: p.i, x: (p.x - minX) * unit, y: (p.y - minY) * unit }));
    const w = Math.max(...placed.map((p) => p.x));
    const h = Math.max(...placed.map((p) => p.y));

    return {
      points: placed,
      d: `M${placed.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L')}`,
      box: `-40 -40 ${(w + 80).toFixed(0)} ${(h + 80).toFixed(0)}`,
      tall: h > w,
    };
  });

  let active = $state<number | null>(null);

  const marker = $derived.by(() => {
    if (active === null || !route) {
      return null;
    }
    const index = active;

    return route.points.reduce((best, p) => (Math.abs(p.i - index) < Math.abs(best.i - index) ? p : best));
  });

  function nearest(target: number) {
    let lo = 0;
    let hi = count - 1;

    while (lo < hi) {
      const mid = (lo + hi) >> 1;

      if ((along[mid] ?? 0) < target) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    return lo > 0 && target - (along[lo - 1] ?? 0) < (along[lo] ?? 0) - target ? lo - 1 : lo;
  }

  function point(event: PointerEvent & { currentTarget: HTMLElement }) {
    const box = event.currentTarget.getBoundingClientRect();
    active = nearest((Math.min(Math.max(event.clientX - box.left, 0), box.width) / box.width) * end);
  }

  function key(event: KeyboardEvent) {
    const step = Math.max(1, Math.round(count / 100));
    const now = active ?? 0;

    const next = {
      ArrowRight: now + step,
      ArrowUp: now + step,
      ArrowLeft: now - step,
      ArrowDown: now - step,
      PageUp: now + step * 10,
      PageDown: now - step * 10,
      Home: 0,
      End: count - 1,
    }[event.key];

    if (next === undefined) {
      return;
    }
    event.preventDefault();
    active = Math.min(Math.max(next, 0), count - 1);
  }

  const km = (cm: number) =>
    t('km', {
      value1: (cm / 100_000).toLocaleString([], { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    });

  const clock = (s: number) =>
    `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  /** What the rider saw at one moment. Series the activity did not record stay out. */
  const moment = $derived.by(() => {
    if (active === null) {
      return null;
    }
    const i = active;
    const rows: Array<[string, string]> = [];

    if (chart.distanceInCm.some((d) => d > 0)) {
      rows.push([t('distance'), km(chart.distanceInCm[i] ?? 0)]);
    }
    rows.push([t('time'), clock(chart.timeInSec[i] ?? 0)]);
    rows.push([t('elevation'), t('m', { value1: Math.round(metres[i] ?? 0) })]);

    if (!running && chart.powerInWatts.some((v) => v > 0)) {
      rows.push([t('power'), t('w', { value1: chart.powerInWatts[i] ?? 0 })]);
    }

    if (chart.heartRate.some((v) => v > 0)) {
      rows.push([t('heart_rate'), t('bpm', { value1: chart.heartRate[i] ?? 0 })]);
    }

    return rows;
  });
</script>

<figure class="activity">
  {#if route}
    <svg
      class="route"
      class:tall={route.tall}
      viewBox={route.box}
      role="img"
      aria-label={t('activity_chart_route_label')}
    >
      <path class="trace" d={route.d} pathLength="1" />
      <circle class="start" cx={route.points[0]!.x} cy={route.points[0]!.y} r="14"><title>{t('start')}</title></circle>
      <circle class="finish" cx={route.points.at(-1)!.x} cy={route.points.at(-1)!.y} r="14"
        ><title>{t('finish')}</title></circle
      >
      {#if marker}<circle class="here" cx={marker.x} cy={marker.y} r="20" />{/if}
    </svg>
  {/if}

  <!-- The readout keeps its height, so the profile does not jump while scrubbing. -->
  <dl class="readout" aria-live="off">
    {#if moment}
      {#each moment as [label, value] (label)}<div>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>{/each}
    {:else}
      <div>
        <dt>{t('lowest')}</dt>
        <dd>{t('m', { value1: Math.round(low) })}</dd>
      </div>
      <div>
        <dt>{t('highest')}</dt>
        <dd>{t('m', { value1: Math.round(high) })}</dd>
      </div>
    {/if}
  </dl>

  <div
    class="profile"
    role="slider"
    tabindex="0"
    aria-label={t('activity_chart_position_label')}
    aria-valuemin={0}
    aria-valuemax={count - 1}
    aria-valuenow={active ?? 0}
    aria-valuetext={moment ? moment.map(([label, value]) => `${label} ${value}`).join(', ') : 'Start'}
    onpointermove={point}
    onpointerdown={point}
    onpointerleave={(e) => {
      if (e.pointerType === 'mouse') active = null;
    }}
    onkeydown={key}
    onblur={() => (active = null)}
  >
    <svg viewBox="0 0 {width} {height}" preserveAspectRatio="none" aria-hidden="true">
      <path class="fill" d={area} />
      <path class="edge" d="M{line}" />
      {#if active !== null}<line class="cross" x1={xAt(active)} x2={xAt(active)} y1="0" y2={height} />{/if}
    </svg>
    {#if active !== null}<span
        class="dot"
        style:left="{(xAt(active) / width) * 100}%"
        style:top="{(yAt(active) / height) * 100}%"
      ></span>{/if}
  </div>
  <figcaption class="axis">
    <span
      >{t('activity_chart_elevation_description', {
        value1: chart.distanceInCm.some((d) => d > 0) ? 'distance' : 'time',
      })}</span
    >
    <span>{chart.distanceInCm.some((d) => d > 0) ? km(end) : clock(end)}</span>
  </figcaption>
</figure>

<style>
  .activity {
    margin: 0 0 1.25rem;
  }

  /* The one bold thing on the page: the shape of the activity, drawn in once when it opens. */
  .route {
    display: block;
    width: 100%;
    height: 15rem;
    margin-bottom: 0.75rem;
    border-radius: 10px;
    background: var(--well);
  }
  .route.tall {
    height: 19rem;
  }
  .trace {
    fill: none;
    stroke: var(--orange);
    stroke-width: 9;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 1;
    animation: draw 1.1s cubic-bezier(0.3, 0.6, 0.2, 1) both;
  }
  @keyframes draw {
    from {
      stroke-dashoffset: 1;
    }
  }
  .start {
    fill: var(--world);
    stroke: var(--text);
    stroke-width: 6;
  }
  .finish {
    fill: var(--text);
  }
  .here {
    fill: var(--text);
    stroke: var(--orange);
    stroke-width: 9;
  }

  .readout {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1.25rem;
    min-height: 2.6rem;
    margin: 0 0 0.35rem;
  }
  .readout div {
    display: grid;
  }
  .readout dt {
    color: var(--muted);
    font-size: 0.75rem;
  }
  .readout dd {
    margin: 0;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }

  .profile {
    position: relative;
    height: 7.5rem;
    touch-action: pan-y;
    cursor: crosshair;
    border-bottom: 1px solid var(--line);
  }
  .profile svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  .fill {
    fill: rgb(255 255 255 / 0.14);
  }
  .edge {
    fill: none;
    stroke: rgb(255 255 255 / 0.75);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  .cross {
    stroke: var(--text);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .dot {
    position: absolute;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 50%;
    background: var(--orange);
    box-shadow: 0 0 0 2px var(--world);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }
  .axis {
    display: flex;
    justify-content: space-between;
    margin-top: 0.3rem;
    color: var(--muted);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
</style>
