<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '../lib/i18n/index';
  import SlowLoading from '../components/SlowLoading.svelte';
  import { parseLogEntry, rank } from './server-logs';
  import type { LogEntry, LogSeverity } from './server-logs';

  let { load }: { load: () => Promise<{ entries: Array<string> }> } = $props();

  type Filter = 'all' | 'warnings' | 'errors';

  let open = $state(false);
  let loading = $state(false);
  let errorMessage = $state('');
  let entries = $state<Array<LogEntry>>([]);
  let updated = $state<Date | null>(null);
  let filter = $state<Filter>('all');
  let query = $state('');
  let flashed = $state(-1);
  let list = $state<HTMLOListElement>();

  /** Browsers allow the clipboard only on HTTPS or localhost; elsewhere the entries are there to select. */
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard;
  let copied = $state(false);

  const floor: Record<Filter, number> = { all: 0, warnings: rank.warning, errors: rank.error };

  const counts = $derived({
    all: entries.length,
    warnings: entries.filter((entry) => rank[entry.severity] >= rank.warning).length,
    errors: entries.filter((entry) => rank[entry.severity] >= rank.error).length,
  });

  const needle = $derived(query.trim().toLowerCase());

  function matches(entry: LogEntry) {
    return rank[entry.severity] >= floor[filter] && (!needle || entry.raw.toLowerCase().includes(needle));
  }

  const shown = $derived(entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => matches(entry)));

  const levelName: Record<LogSeverity, string> = $derived({
    verbose: t('server_logs_level_verbose'),
    info: t('server_logs_level_info'),
    warning: t('server_logs_level_warning'),
    error: t('server_logs_level_error'),
    critical: t('server_logs_level_critical'),
  });

  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

  function clock(time: Date) {
    return time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  }

  function day(time: Date) {
    return time.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  /** Long or multi-line values, such as stack traces, fold away under their name. */
  const folded = (value: string) => value.includes('\n') || value.length > 140;

  async function refresh() {
    loading = true;
    errorMessage = '';

    try {
      entries = (await load()).entries.map(parseLogEntry);
      updated = new Date();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : t('server_logs_load_error');
    } finally {
      loading = false;
    }
  }

  function toggle() {
    open = !open;

    if (open && !loading) {
      void refresh();
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(shown.map(({ entry }) => entry.raw).join('\n'));
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  function showAll() {
    filter = 'all';
    query = '';
  }

  /** Pointer shortcut from the bar to its entry; the filters and search are the keyboard route. */
  async function reveal(index: number) {
    if (!shown.some((item) => item.index === index)) {
      showAll();
      await tick();
    }

    const row = list?.querySelector<HTMLElement>(`[data-index="${index}"]`);

    if (!row) {
      return;
    }

    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
    flashed = index;
    setTimeout(() => {
      if (flashed === index) {
        flashed = -1;
      }
    }, 1600);
  }
</script>

<div class="actions">
  <button type="button" aria-expanded={open} aria-controls="server-log-output" onclick={toggle}>
    {open ? t('hide_logs') : t('view_logs')}
  </button>
  {#if open}
    <button type="button" disabled={loading} onclick={refresh}>{t('refresh_logs')}</button>
  {/if}
</div>

<div id="server-log-output" class="logs" hidden={!open}>
  {#if open}
    {#if updated}
      <p class="meta">{t('server_logs_updated', { time: clock(updated) })}</p>
    {/if}
    {#if loading && !entries.length}<SlowLoading />{/if}
    {#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}

    {#if entries.length}
      <!-- Every entry as a bar, newest on the left: taller and warmer for warnings and errors. -->
      <div class="profile" aria-hidden="true">
        {#each entries as entry, index (index)}
          <button
            type="button"
            tabindex="-1"
            class="bar"
            data-severity={entry.severity}
            class:dim={!matches(entry)}
            style:--rank={rank[entry.severity]}
            title="{entry.time ? clock(entry.time) : ''} {entry.message}"
            onclick={() => reveal(index)}
          ></button>
        {/each}
      </div>

      <div class="toolbar">
        <div class="filters" role="group" aria-label={t('server_logs_filter')}>
          <button type="button" aria-pressed={filter === 'all'} onclick={() => (filter = 'all')}>
            {t('server_logs_all')}<span class="count">{counts.all}</span>
          </button>
          <button type="button" aria-pressed={filter === 'warnings'} onclick={() => (filter = 'warnings')}>
            <i class="dot" data-severity="warning"></i>{t('server_logs_warnings')}<span class="count"
              >{counts.warnings}</span
            >
          </button>
          <button type="button" aria-pressed={filter === 'errors'} onclick={() => (filter = 'errors')}>
            <i class="dot" data-severity="error"></i>{t('server_logs_errors')}<span class="count">{counts.errors}</span>
          </button>
        </div>
        <input
          type="search"
          bind:value={query}
          aria-label={t('server_logs_search')}
          placeholder={t('server_logs_search')}
          autocomplete="off"
          spellcheck="false"
        />
        {#if canCopy}
          <button type="button" class="copy" disabled={!shown.length} onclick={copy}>
            {copied ? t('copied') : t('server_logs_copy')}
          </button>
        {/if}
      </div>

      {#if shown.length}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (the scroll region needs keyboard focus) -->
        <div class="output" role="region" tabindex="0" aria-label={t('server_log_entries')}>
          <ol bind:this={list}>
            {#each shown as { entry, index } (index)}
              <li data-severity={entry.severity} class:flash={flashed === index} data-index={index}>
                {#if entry.time}
                  <time datetime={entry.time.toISOString()} title={entry.time.toISOString()}>
                    {#if updated && !sameDay(entry.time, updated)}<span class="day">{day(entry.time)}</span>{/if}
                    {clock(entry.time)}
                  </time>
                {:else}
                  <span class="time-missing"></span>
                {/if}
                <div class="body">
                  <p class="line">
                    {#if rank[entry.severity] >= rank.warning}
                      <span class="level">{levelName[entry.severity]}</span>
                    {:else}
                      <span class="visually-hidden">{levelName[entry.severity]}: </span>
                    {/if}
                    <span class="message">{entry.message}</span>
                    {#if entry.event}<code class="event">{entry.event}</code>{/if}
                  </p>
                  {#if entry.fields.some((item) => !folded(item.value))}
                    <dl class="fields">
                      {#each entry.fields.filter((item) => !folded(item.value)) as item, position (position)}
                        <div>
                          <dt>{item.key}</dt>
                          <dd>{item.value}</dd>
                        </div>
                      {/each}
                    </dl>
                  {/if}
                  {#each entry.fields.filter((item) => folded(item.value)) as item, position (position)}
                    <details>
                      <summary>{item.key}</summary>
                      <pre>{item.value}</pre>
                    </details>
                  {/each}
                  {#if entry.truncated}<p class="cut">{t('server_logs_truncated')}</p>{/if}
                </div>
              </li>
            {/each}
          </ol>
        </div>
      {:else}
        <div class="none">
          <p>{t('server_logs_no_match')}</p>
          <button type="button" onclick={showAll}>{t('server_logs_show_all')}</button>
        </div>
      {/if}
    {:else if !loading && !errorMessage}
      <p class="meta">{t('server_logs_empty')}</p>
    {/if}
  {/if}
</div>

<style>
  /* Severity borrows the training-zone ramp: grey and blue are routine, yellow and red ask for a look. */
  .logs {
    --verbose: #7f8ca0;
    --info: #5aa9ff;
    --warning: #ffc83d;
    --error: #ff6b57;
    --critical: #ff3d6e;
    --mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    margin-top: 0.75rem;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .actions button {
    margin: 0;
  }

  .meta {
    margin: 0 0 0.6rem;
    color: var(--muted);
    font-size: 0.8125rem;
  }

  .error {
    margin: 0 0 0.75rem;
  }

  /* The profile: one bar per entry, like a workout's interval chart. */
  .profile {
    display: flex;
    align-items: flex-end;
    gap: 1px;
    height: 2.25rem;
    padding: 0 0 0.25rem;
    border-bottom: 1px solid var(--line);
  }

  .bar {
    flex: 1 1 0;
    min-width: 1px;
    max-width: 0.75rem;
    height: calc(20% + var(--rank) * 20%);
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 2px 2px 0 0;
    background: var(--info);
    opacity: 0.85;
    cursor: pointer;
  }

  .bar:hover {
    opacity: 1;
    background: var(--text);
  }

  .bar[data-severity='verbose'] {
    background: var(--verbose);
  }

  .bar[data-severity='warning'] {
    background: var(--warning);
  }

  .bar[data-severity='error'] {
    background: var(--error);
  }

  .bar[data-severity='critical'] {
    background: var(--critical);
  }

  .bar.dim {
    opacity: 0.2;
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    margin: 0.75rem 0;
  }

  .filters {
    display: inline-flex;
    flex-wrap: wrap;
    max-width: 100%;
    padding: 3px;
    border-radius: 10px;
    background: var(--well);
  }

  .filters button {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    padding: 0.35rem 0.75rem;
    border: 0;
    border-radius: 7px;
    color: var(--muted);
    font-size: 0.8125rem;
    text-transform: none;
    letter-spacing: 0;
  }

  .filters button[aria-pressed='true'] {
    background: var(--glass-raised);
    color: var(--text);
    box-shadow: inset 0 -2px 0 var(--orange);
  }

  .count {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    font-weight: 600;
  }

  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
  }

  .dot[data-severity='warning'] {
    background: var(--warning);
  }

  .dot[data-severity='error'] {
    background: var(--error);
  }

  .toolbar input {
    flex: 1 1 12rem;
    min-width: 0;
    max-width: none;
    padding: 0.4rem 0.7rem;
    font-size: 0.875rem;
  }

  .copy {
    margin: 0;
    padding: 0.4rem 0.9rem;
    font-size: 0.8125rem;
  }

  .output {
    max-height: 30rem;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--well);
    overscroll-behavior: contain;
  }

  ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: 5.25rem minmax(0, 1fr);
    gap: 0 0.9rem;
    padding: 0.5rem 0.9rem 0.5rem 0;
    border-left: 3px solid var(--info);
    transition: background-color 600ms ease-out;
  }

  li + li {
    border-top: 1px solid rgb(255 255 255 / 0.06);
  }

  li[data-severity='verbose'] {
    border-left-color: var(--verbose);
  }

  li[data-severity='verbose'] .message {
    color: var(--muted);
  }

  li[data-severity='warning'] {
    border-left-color: var(--warning);
    background: rgb(255 200 61 / 0.06);
  }

  li[data-severity='error'],
  li[data-severity='critical'] {
    border-left-color: var(--error);
    background: rgb(255 107 87 / 0.09);
  }

  li[data-severity='critical'] {
    border-left-color: var(--critical);
  }

  li.flash {
    background: rgb(255 255 255 / 0.14);
    transition: none;
  }

  time,
  .time-missing {
    padding-left: 0.75rem;
    color: var(--muted);
    font: 600 0.8125rem/1.6 var(--mono);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .day {
    display: block;
    font-size: 0.75rem;
  }

  .body {
    min-width: 0;
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.15rem 0.6rem;
    max-width: none;
    margin: 0;
    line-height: 1.4;
  }

  .message {
    flex: 1 1 16rem;
    font-size: 0.9rem;
    overflow-wrap: anywhere;
  }

  .level {
    flex: none;
    padding: 0.05rem 0.4rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 800;
    color: var(--world);
  }

  li[data-severity='warning'] .level {
    background: var(--warning);
  }

  li[data-severity='error'] .level {
    background: var(--error);
  }

  li[data-severity='critical'] .level {
    background: var(--critical);
  }

  .event {
    flex: none;
    margin-left: auto;
    color: var(--muted);
    font: 0.75rem/1.6 var(--mono);
  }

  .fields {
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem 1rem;
    margin: 0.3rem 0 0;
    font: 0.75rem/1.5 var(--mono);
  }

  .fields div {
    display: flex;
    gap: 0.35rem;
    min-width: 0;
  }

  .fields dt {
    color: var(--muted);
  }

  .fields dd {
    margin: 0;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  details {
    margin-top: 0.4rem;
  }

  summary {
    width: fit-content;
    color: var(--muted);
    font: 0.75rem/1.5 var(--mono);
    cursor: pointer;
  }

  summary:hover {
    color: var(--text);
  }

  pre {
    max-height: 16rem;
    overflow: auto;
    margin: 0.35rem 0 0;
    padding: 0.6rem 0.75rem;
    border-radius: 6px;
    background: rgb(0 0 0 / 0.3);
    font: 0.75rem/1.5 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .cut {
    margin: 0.3rem 0 0;
    color: var(--muted);
    font-size: 0.75rem;
  }

  .none {
    padding: 1rem;
    border: 1px dashed var(--line);
    border-radius: 10px;
  }

  .none p {
    margin: 0;
    color: var(--muted);
  }

  .none button {
    margin: 0.6rem 0 0;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  /* Phone width: time sits above the message instead of beside it, and the filters take a row of their own. */
  @media (max-width: 560px) {
    .filters {
      display: flex;
      width: 100%;
    }

    .filters button {
      flex: 1 1 auto;
      justify-content: center;
    }

    li {
      grid-template-columns: minmax(0, 1fr);
      padding-left: 0.75rem;
    }

    time,
    .time-missing {
      padding-left: 0;
    }

    .day {
      display: inline;
      margin-right: 0.4rem;
    }

    .event {
      margin-left: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    li {
      transition: none;
    }
  }
</style>
