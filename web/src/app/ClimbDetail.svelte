<script lang="ts">
  import type { Climb } from './climbs';
  import ClimbProfile from './ClimbProfile.svelte';

  let { climb }: { climb: Climb } = $props();
</script>

<div class="detail">
  <dl class="facts">
    {#if climb.distanceKm !== null}
      <dt>Distance</dt>
      <dd>{climb.distanceKm} km</dd>
    {/if}
    {#if climb.elevationM !== null}
      <dt>Climbing</dt>
      <dd>{climb.elevationM} m</dd>
    {/if}
    {#if climb.avgGradePct !== null}
      <dt>Average grade</dt>
      <dd>{climb.avgGradePct.toFixed(1)}%</dd>
    {/if}
    {#if climb.maxGradePct !== null}
      <dt>Max grade</dt>
      <dd>{climb.maxGradePct.toFixed(1)}%</dd>
    {/if}
    <dt>Category</dt>
    <dd>{climb.category ?? 'None'}</dd>
    {#if climb.elevationLowM !== null}
      <dt>Lowest</dt>
      <dd>{climb.elevationLowM} m</dd>
    {/if}
    {#if climb.elevationHighM !== null}
      <dt>Highest</dt>
      <dd>{climb.elevationHighM} m</dd>
    {/if}
  </dl>

  <ClimbProfile points={climb.profile} label={`Elevation profile of ${climb.name}`} />

  <p class="source" class:imported={climb.profileSource === 'imported'}>
    {climb.profileSource === 'imported'
      ? 'Profile from the climb data'
      : 'Straight-line estimate, no recorded profile yet'}
  </p>
</div>

<style>
  .detail {
    padding: 1rem 0 0.5rem;
  }

  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 1rem;
    margin: 0 0 1rem;
    font-size: 0.875rem;
  }
  .facts dt {
    color: var(--muted);
    font-weight: 600;
  }
  .facts dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }

  .source {
    margin: 0.5rem 0 0;
    font-size: 0.8125rem;
    color: var(--muted);
  }
  .source.imported {
    color: #6a9955;
  }
</style>
