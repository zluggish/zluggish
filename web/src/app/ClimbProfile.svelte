<script lang="ts">
  import { gradeBand } from './climbs';

  let { points, label }: { points: Array<[number, number]>; label: string } = $props();

  const profileData = $derived.by(() => {
    if (points.length < 2) {
      return null;
    }

    const lastDist = points.at(-1)?.[0] ?? 0;

    if (lastDist === 0) {
      return null;
    }

    const elevations = points.map((p) => p[1]);
    const minElev = Math.min(...elevations);
    const maxElev = Math.max(...elevations);
    const elevRange = maxElev - minElev || 1;

    const padL = 55;
    const padR = 55;
    const padT = 15;
    const padB = 25;
    const drawW = 800 - padL - padR;
    const drawH = 400 - padT - padB;
    const baseline = padT + drawH;

    const toX = (dist: number) => padL + (dist / lastDist) * drawW;
    const toY = (elev: number) => padT + (1 - (elev - minElev) / elevRange) * drawH;

    const segs: Array<{ points: string; band: string }> = [];

    for (let i = 0; i < points.length - 1; i++) {
      const [d1, e1] = points[i];
      const [d2, e2] = points[i + 1];
      const run = d2 - d1;
      const rise = e2 - e1;
      const gradPct = run > 0 ? (rise / run) * 100 : 0;
      const band = gradeBand(gradPct);
      const x1 = toX(d1);
      const x2 = toX(d2);
      const y1 = toY(e1);
      const y2 = toY(e2);

      segs.push({
        points: `${x1},${y1} ${x2},${y2} ${x2},${baseline} ${x1},${baseline}`,
        band,
      });
    }

    return { segs, minElev, maxElev, totalKm: lastDist / 1000, baseline, padL, padR, padT };
  });
</script>

{#if profileData}
  <div class="profile">
    <svg viewBox="0 0 800 400" role="img" aria-label={label}>
      {#each profileData.segs as seg, segIndex (segIndex)}
        <polygon points={seg.points} class="band-{seg.band}" />
      {/each}

      <line
        x1={profileData.padL}
        y1={profileData.baseline}
        x2={800 - profileData.padR}
        y2={profileData.baseline}
        stroke="var(--line)"
        stroke-width="1"
      />

      <text x="5" y={profileData.baseline - 4} class="label">{profileData.minElev} m</text>
      <text x="5" y={profileData.padT + 12} class="label">{profileData.maxElev} m</text>
      <text x="795" y={profileData.baseline - 4} text-anchor="end" class="label">
        {profileData.totalKm.toFixed(1)} km
      </text>
    </svg>
  </div>
{/if}

<style>
  .profile {
    --band-flat: #2d8a4e;
    --band-easy: #c9a020;
    --band-steady: #d47020;
    --band-steep: #c03030;
  }

  @media (prefers-color-scheme: dark) {
    .profile {
      --band-flat: #4caf50;
      --band-easy: #ffd54f;
      --band-steady: #ff9800;
      --band-steep: #f44336;
    }
  }

  .profile svg {
    display: block;
    width: 100%;
    height: auto;
  }

  .band-flat {
    fill: var(--band-flat);
  }
  .band-easy {
    fill: var(--band-easy);
  }
  .band-steady {
    fill: var(--band-steady);
  }
  .band-steep {
    fill: var(--band-steep);
  }

  .label {
    font-size: 11px;
    fill: var(--muted);
  }
</style>
