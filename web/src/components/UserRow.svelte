<script lang="ts">
  import Avatar from './Avatar.svelte';
  import { t } from '../lib/i18n/index';

  let {
    initials,
    photo = null,
    name,
    detail = null,
    workout = null,
  }: {
    initials: string;
    photo?: string | null | undefined;
    name: string;
    detail?: string | null | undefined;
    workout?: { name: string; minutes: number } | null | undefined;
  } = $props();

  function minutes(m: number) {
    return m < 60 ? t('min', { value1: m }) : t('h_min', { value1: Math.floor(m / 60), value2: m % 60 });
  }

  const badge = $derived(
    workout ? t('workout_today_badge', { value1: `${workout.name} · ${minutes(workout.minutes)}` }) : '',
  );
</script>

<Avatar {initials} {photo} /><span class="who"
  ><span>{name}</span>{#if detail}<small title={detail}>{detail}</small>{/if}{#if workout}
    <small class="workout" title={badge}
      ><svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
        ><circle cx="5.5" cy="17.5" r="3.5" /><circle cx="18.5" cy="17.5" r="3.5" /><path
          d="M5.5 17.5 9 9h5l3 8.5M9 9 7.5 6h3"
        /></svg
      ><span>{badge}</span></small
    >{/if}</span
>

<style>
  /* The badge wraps instead of being cut off: the tile is narrow and the workout name can be long. */
  .workout {
    display: flex;
    align-items: flex-start;
    gap: 0.3rem;
    color: var(--orange);
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
    line-height: 1.25;
  }

  .workout svg {
    flex: none;
    margin-top: 0.12em;
  }
</style>
