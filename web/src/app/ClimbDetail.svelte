<script lang="ts">
  import { t } from '../lib/i18n/index';
  import type { Climb } from './climbs';
  import ClimbProfile from './ClimbProfile.svelte';

  let { climb }: { climb: Climb } = $props();
</script>

<div class="detail">
  <dl class="facts">
    {#if climb.distanceKm !== null}
      <dt>{t('distance')}</dt>
      <dd>{t('km', { value1: climb.distanceKm })}</dd>
    {/if}
    {#if climb.elevationM !== null}
      <dt>{t('climb_ascent')}</dt>
      <dd>{t('m', { value1: climb.elevationM })}</dd>
    {/if}
    {#if climb.avgGradePct !== null}
      <dt>{t('climb_average_grade')}</dt>
      <dd>{climb.avgGradePct.toFixed(1)}%</dd>
    {/if}
    {#if climb.maxGradePct !== null}
      <dt>{t('climb_max_grade')}</dt>
      <dd>{climb.maxGradePct.toFixed(1)}%</dd>
    {/if}
    <dt>{t('category')}</dt>
    <dd>{climb.category ?? t('none')}</dd>
    {#if climb.elevationLowM !== null}
      <dt>{t('lowest')}</dt>
      <dd>{t('m', { value1: climb.elevationLowM })}</dd>
    {/if}
    {#if climb.elevationHighM !== null}
      <dt>{t('highest')}</dt>
      <dd>{t('m', { value1: climb.elevationHighM })}</dd>
    {/if}
  </dl>

  <ClimbProfile points={climb.profile} label={t('climb_elevation_profile', { value1: climb.name })} />

  <p class="source" class:imported={climb.profileSource === 'imported'}>
    {climb.profileSource === 'imported' ? t('climb_profile_imported') : t('climb_profile_estimated')}
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
