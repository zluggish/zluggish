<script lang="ts">
  import { t } from '../lib/i18n/index';
  import SlowLoading from '../components/SlowLoading.svelte';
  import { onMount } from 'svelte';
  import type { Api } from '../lib/api';
  import { categoryTabs, climbsResponse, clock, day, matchesTab, tabOf } from './climbs';
  import type { CategoryTab, Climb } from './climbs';
  import ClimbDetail from './ClimbDetail.svelte';

  const segment = (id: number) => `https://www.strava.com/segments/${id}`;

  let {
    api,
  }: {
    api: Api;
  } = $props();

  let climbs = $state<Array<Climb> | null>(null);
  let total = $state(0);
  let failure = $state('');
  let activeTab = $state<CategoryTab>('all');
  let expanded = $state<Set<string>>(new Set());
  let tabButtons = $state<Array<HTMLButtonElement | null>>([]);

  const ridden = (climb: Climb) => (climb.lastRide ? Date.parse(climb.lastRide) : Number.NEGATIVE_INFINITY);

  const ordered = $derived([...(climbs ?? [])].sort((a, b) => ridden(b) - ridden(a)));
  const rides = $derived((climbs ?? []).reduce((sum, climb) => sum + climb.rides, 0));

  const gradient = (climb: Climb) =>
    climb.distanceKm && climb.elevationM !== null ? climb.elevationM / (climb.distanceKm * 10) : null;

  const plural = (count: number) => t('ride_count', { value1: count, value2: count === 1 ? t('ride') : t('rides') });

  const tabLabel = (tab: CategoryTab): string => {
    if (tab === 'all') {
      return t('server_logs_all');
    }

    if (tab === 'none') {
      return t('uncategorised');
    }

    if (tab === 'HC') {
      return t('climb_hc');
    }

    return t('climb_category_short', { value1: tab });
  };

  const countForTab = (tab: CategoryTab): number => {
    if (!climbs) {
      return 0;
    }

    return climbs.filter((c) => matchesTab(c, tab)).length;
  };

  const filtered = $derived(ordered.filter((c) => matchesTab(c, activeTab)));

  const selectTab = (tab: CategoryTab) => {
    activeTab = tab;
    const url = new URL(window.location.href);

    if (tab === 'all') {
      url.searchParams.delete('category');
    } else {
      url.searchParams.set('category', tab);
    }

    history.replaceState(null, '', url.toString());
  };

  const onTabKey = (e: KeyboardEvent, index: number) => {
    const tabs = categoryTabs;
    let newIndex: number;

    if (e.key === 'ArrowRight') {
      newIndex = (index + 1) % tabs.length;
    } else if (e.key === 'ArrowLeft') {
      newIndex = (index - 1 + tabs.length) % tabs.length;
    } else if (e.key === 'Home') {
      newIndex = 0;
    } else if (e.key === 'End') {
      newIndex = tabs.length - 1;
    } else {
      return;
    }

    e.preventDefault();
    selectTab(tabs[newIndex]);
    tabButtons[newIndex]?.focus();
  };

  const toggle = (road: string) => {
    const next = new Set(expanded);

    if (next.has(road)) {
      next.delete(road);
    } else {
      next.add(road);
    }

    expanded = next;
  };

  onMount(async () => {
    const param = new URLSearchParams(window.location.search).get('category');
    activeTab = tabOf(param);

    try {
      const body = await api(climbsResponse, '/api/me/climbs');
      total = body.total;
      climbs = body.climbs;
    } catch (error) {
      failure = error instanceof Error ? error.message : t('climbs_load_error');
    }
  });
</script>

{#if failure}<p class="notice failed" role="alert">{failure}</p>{/if}
{#if climbs === null}
  {#if !failure}<SlowLoading />{/if}
{:else if climbs.length === 0}
  <section class="panel narrow">
    <h2>{t('climbs_empty')}</h2>
    <p>
      {t('climbs_empty_hint_prefix')} <strong>{t('climb')}</strong>
      {t('climbs_empty_hint_suffix')}
    </p>
  </section>
{:else}
  <section class="climbs" aria-label={t('climb_portals')}>
    <div class="tabs" role="tablist" aria-label={t('climb_category')}>
      {#each categoryTabs as tab, i (tab)}
        <button
          bind:this={tabButtons[i]}
          role="tab"
          type="button"
          aria-selected={activeTab === tab}
          aria-controls="climb-list"
          tabindex={activeTab === tab ? 0 : -1}
          onclick={() => selectTab(tab)}
          onkeydown={(e) => onTabKey(e, i)}
        >
          {tabLabel(tab)} ({countForTab(tab)})
        </button>
      {/each}
    </div>

    <ul class="panel" id="climb-list">
      {#each filtered as climb (climb.road)}
        {@const grade = gradient(climb)}
        {@const isOpen = expanded.has(climb.road)}
        <li>
          <div class="row">
            <p class="height">
              {#if climb.elevationM !== null}
                <strong
                  >{t('m', { value1: climb.elevationM.toLocaleString() })}<span class="hidden">{t('climbing')}</span
                  ></strong
                >
              {/if}
            </p>

            <div class="name">
              <button
                type="button"
                class="expand-btn"
                aria-expanded={isOpen}
                aria-controls={`detail-${climb.road}`}
                onclick={() => toggle(climb.road)}
              >
                <h3>{climb.name}</h3>
                {#if climb.profileSource === 'imported'}
                  <span class="tag">{t('climb_real_profile')}</span>
                {/if}
                {#if climb.distanceKm !== null && grade !== null}
                  <p>{t('km_at', { value1: climb.distanceKm, value2: grade.toFixed(1) })}</p>
                {/if}
              </button>
            </div>

            <p class="best">
              {#if climb.bestMs !== null}
                <strong>{clock(climb.bestMs)}</strong>
                <span>{t('best_of', { value1: climb.rides })}</span>
              {:else}
                <strong class="none">{t('no_time')}</strong>
              {/if}
            </p>

            <p class="last">
              {#if climb.lastRide}
                <strong><time datetime={climb.lastRide}>{day(climb.lastRide)}</time></strong>
                <span>{t('last_ride')}</span>
              {/if}
            </p>

            {#if climb.strava}
              <p class="strava">
                <span class="links">
                  <a
                    href={segment(climb.strava.watopia)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t('climb_strava_watopia', { value1: climb.name })}>{t('watopia')}</a
                  >
                  <a
                    href={segment(climb.strava.france)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t('climb_strava_france', { value1: climb.name })}>{t('france')}</a
                  >
                </span>
                <span>{t('strava_link_suffix')}</span>
              </p>
            {/if}
          </div>

          {#if isOpen}
            <div id="detail-{climb.road}" class="detail-block">
              <ClimbDetail {climb} />
            </div>
          {/if}
        </li>
      {/each}
    </ul>

    {#if filtered.length === 0}
      <p class="empty-tab">{t('climb_category_empty')}</p>
    {/if}

    <p class="summary">
      {t('of_climb_portals_ridden', { value1: climbs.length, value2: total, value3: plural(rides) })}
    </p>
  </section>
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
  .narrow p {
    margin-bottom: 0;
  }
  .notice.failed {
    color: var(--alarm);
    border-left: 3px solid #ff6b57;
    padding-left: 0.75rem;
  }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-bottom: 0.75rem;
  }
  .tabs button {
    padding: 0.35rem 0.75rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: transparent;
    color: var(--muted);
    font-size: 0.8125rem;
    cursor: pointer;
  }
  .tabs button[aria-selected='true'] {
    background: var(--glass);
    color: inherit;
    border-color: var(--orange);
    font-weight: 700;
  }
  .tabs button:focus-visible {
    outline: 2px solid var(--orange);
    outline-offset: 2px;
  }

  .climbs ul {
    list-style: none;
    margin: 0;
    padding-block: 0.25rem;
  }
  .summary {
    margin: 0.75rem 0 0;
    padding-inline: 0.25rem;
    color: var(--muted);
  }
  .empty-tab {
    padding: 1rem 0.25rem;
    color: var(--muted);
  }

  .climbs li {
    border-bottom: 1px solid var(--line);
  }
  .climbs li:last-child {
    border-bottom: 0;
  }

  .row {
    display: grid;
    grid-template-columns: 8.5rem minmax(0, 1fr) 7rem 8.5rem 8.5rem;
    grid-template-areas: 'height name best last strava';
    align-items: center;
    gap: 0.5rem 1.25rem;
    padding: 0.85rem 0;
  }

  .height {
    grid-area: height;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    margin: 0;
    padding-right: 1.25rem;
    border-right: 3px solid var(--orange);
    white-space: nowrap;
  }
  .height strong {
    font-size: 1.5rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }

  .name {
    grid-area: name;
    min-width: 0;
  }
  .expand-btn {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
    font: inherit;
  }
  .expand-btn:focus-visible {
    outline: 2px solid var(--orange);
    outline-offset: 2px;
    border-radius: 4px;
  }
  .name h3 {
    display: inline;
    margin: 0;
    font-size: 1rem;
    font-weight: 800;
    line-height: 1.25;
  }
  .tag {
    display: inline;
    margin-left: 0.5rem;
    font-size: 0.6875rem;
    font-weight: 600;
    color: #6a9955;
    vertical-align: middle;
  }
  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .name p,
  .best span,
  .last span,
  .strava > span:last-child {
    margin: 0;
    color: var(--muted);
    font-size: 0.8125rem;
  }

  .best,
  .last,
  .strava {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    margin: 0;
    text-align: right;
    white-space: nowrap;
  }
  .best {
    grid-area: best;
  }
  .best strong {
    font-size: 1.125rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    line-height: 1.25;
  }
  .best .none {
    font-size: 0.9375rem;
    color: var(--muted);
  }
  .last {
    grid-area: last;
  }
  .last strong {
    font-weight: 800;
    line-height: 1.45;
  }
  .strava {
    grid-area: strava;
  }
  .strava .links {
    display: flex;
    gap: 0.75rem;
    line-height: 1.45;
  }

  .detail-block {
    padding: 0 0 0.85rem;
  }

  @media (max-width: 44rem) {
    .row {
      grid-template-columns: 4.5rem minmax(0, 1fr) auto;
      grid-template-areas:
        'height name best'
        'height last last'
        'height strava strava';
      align-items: start;
      gap: 0.35rem 0.75rem;
    }
    .height {
      align-self: stretch;
      padding-right: 0.6rem;
    }
    .height strong {
      font-size: 1rem;
    }
    .last,
    .strava {
      flex-direction: row;
      align-items: baseline;
      gap: 0.5rem;
      text-align: left;
    }
    .last strong {
      font-weight: 600;
    }
  }
</style>
