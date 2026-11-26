<script lang="ts" generics="Step extends string">
  import { t } from '../lib/i18n/index';
  import type { Snippet } from 'svelte';
  import { onDestroy } from 'svelte';
  import { megabytes } from './companion';

  /** A server job, or the upload that leads into one, read like a ride: one big number, a few figures, the route. */
  let {
    id,
    job,
    labels,
    weights,
    headline,
    detail,
    upload = null,
    children,
  }: {
    /** The heading's ID, which labels the whole readout. */
    id: string;
    job: {
      state: 'running' | 'waiting' | 'done' | 'failed';
      steps: ReadonlyArray<Step>;
      step: Step;
      progress: number | null;
      message: string | null;
      startedAt: number;
      finishedAt: number | null;
    };
    labels: Record<Step, string>;
    /** Rough shares of the whole job, for the width of each stretch of the bar. */
    weights: Record<Step, number>;
    headline: string;
    /** The line under the headline, or a failed job's message when the server gave none. */
    detail: string;
    /** The bytes of an upload in flight, for its speed and time left. */
    upload?: { size: number; sent: number; rate: number | null } | null;
    /** The job's buttons and notes. */
    children?: Snippet;
  } = $props();

  let now = $state(Date.now());
  let tick: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    const running = job.state === 'running';

    if (running && !tick) {
      now = Date.now();
      tick = setInterval(() => (now = Date.now()), 1000);
    } else if (!running && tick) {
      clearInterval(tick);
      tick = null;
    }
  });

  onDestroy(() => {
    if (tick) {
      clearInterval(tick);
    }
  });

  const position = $derived(job.steps.indexOf(job.step));

  function stateOf(index: number) {
    if (job.state === 'done' || index < position) {
      return 'done';
    }

    if (index > position || job.state === 'waiting') {
      return 'pending';
    }

    return job.state === 'failed' ? 'failed' : 'current';
  }

  /** The share of the whole job that is done, weighting each step by how long it usually takes. */
  const overall = $derived.by(() => {
    if (job.state === 'done') {
      return 1;
    }

    const total = job.steps.reduce((sum, step) => sum + weights[step], 0);
    const done = job.steps.slice(0, position).reduce((sum, step) => sum + weights[step], 0);
    const current = job.state === 'running' ? weights[job.step] * (job.progress ?? 0) : 0;

    return total ? (done + current) / total : 0;
  });

  const elapsed = $derived(Math.max(0, (job.finishedAt ?? now) - job.startedAt));
  const remaining = $derived(upload?.rate ? Math.max(0, (upload.size - upload.sent) / upload.rate) * 1000 : null);

  function duration(ms: number) {
    const seconds = Math.round(ms / 1000);
    const minutes = Math.floor(seconds / 60);

    return minutes >= 60
      ? t('h_min', { value1: Math.floor(minutes / 60), value2: minutes % 60 })
      : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }
</script>

<div
  class="job"
  class:failed={job.state === 'failed'}
  class:done={job.state === 'done'}
  role="group"
  aria-labelledby={id}
>
  <div class="readout">
    <div class="headline">
      <h3 {id}>{headline}</h3>
      {#if job.state === 'failed'}
        <p class="why" role="alert">{job.message ?? detail}</p>
      {:else if job.state === 'done'}
        <p class="sub">{t('job_duration_summary', { value1: detail, value2: duration(elapsed) })}</p>
      {:else}
        <p class="sub">{detail}</p>
      {/if}
    </div>
    {#if job.state === 'running'}
      <p class="figure" aria-hidden="true">
        {Math.floor(overall * 100)}<span class="unit">%</span>
      </p>
    {/if}
  </div>

  <div
    class="rail"
    role="progressbar"
    aria-label={t('progress')}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.floor(overall * 100)}
  >
    {#each job.steps as step, index (step)}
      {@const state = stateOf(index)}
      <span class="leg {state}" style:flex-grow={weights[step]}>
        <span
          class="fill"
          class:sweep={state === 'current' && job.progress === null}
          style:width={state === 'current' && job.progress !== null ? `${(job.progress * 100).toFixed(1)}%` : undefined}
        ></span>
      </span>
    {/each}
  </div>

  {#if job.state === 'running'}
    <dl class="stats">
      <div>
        <dt>{t('elapsed')}</dt>
        <dd>{duration(elapsed)}</dd>
      </div>
      {#if upload}
        <div>
          <dt>{t('sent')}</dt>
          <dd>
            {megabytes(upload.sent)} <span class="of">{t('of', { value1: megabytes(upload.size) })}</span>
          </dd>
        </div>
        <div>
          <dt>{t('speed')}</dt>
          <dd>{upload.rate ? `${megabytes(upload.rate)}/s` : '…'}</dd>
        </div>
        <div>
          <dt>{t('upload_left')}</dt>
          <dd>{remaining === null ? '…' : duration(remaining)}</dd>
        </div>
      {:else}
        <div>
          <dt>{t('step')}</dt>
          <dd>{position + 1} <span class="of">{t('of', { value1: job.steps.length })}</span></dd>
        </div>
      {/if}
    </dl>
  {/if}

  {#if job.state !== 'done'}
    <ol class="steps">
      {#each job.steps as step, index (step)}
        {@const state = stateOf(index)}
        <li class={state}>
          <span class="mark" aria-hidden="true">
            {#if state === 'done'}
              <svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7" /></svg>
            {:else if state === 'failed'}
              <svg viewBox="0 0 16 16"><path d="m4.5 4.5 7 7m0-7-7 7" /></svg>
            {/if}
          </span>
          <span class="label">{labels[step]}</span>
          <span class="visually-hidden">: {state}</span>
          {#if state === 'current' && job.progress !== null}
            <span class="amount">{Math.floor(job.progress * 100)}%</span>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}

  {@render children?.()}
</div>

<style>
  .job {
    margin: 0 0 1.25rem;
    padding: 1.1rem 1.15rem 1.15rem;
    border-radius: 12px;
    background: var(--well);
    box-shadow: inset 0 0 0 1px var(--line);
  }
  .job:last-child {
    margin-bottom: 0;
  }
  .job.failed {
    box-shadow: inset 0 0 0 1px rgb(255 107 87 / 0.6);
  }
  .readout {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 1rem;
  }
  .headline {
    min-width: 0;
  }
  .headline h3 {
    margin: 0;
    font-size: 1.0625rem;
    overflow-wrap: anywhere;
  }
  .sub,
  .why {
    margin: 0.2rem 0 0;
    font-size: 0.9375rem;
  }
  .sub {
    color: var(--muted);
  }
  .why {
    color: var(--alarm);
  }
  .figure {
    flex: none;
    margin: 0 0 -0.35rem;
    font-size: 3.25rem;
    font-weight: 800;
    line-height: 1;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
  }
  .figure .unit {
    margin-left: 0.1em;
    color: var(--muted);
    font-size: 0.4em;
    font-weight: 700;
    letter-spacing: 0;
  }

  .rail {
    display: flex;
    gap: 3px;
    margin: 0.9rem 0 0;
  }
  .leg {
    position: relative;
    flex-basis: 0;
    height: 0.625rem;
    overflow: hidden;
    border-radius: 2px;
    background: var(--line);
  }
  .leg:first-child {
    border-radius: 999px 2px 2px 999px;
  }
  .leg:last-child {
    border-radius: 2px 999px 999px 2px;
  }
  .leg:only-child {
    border-radius: 999px;
  }
  .leg .fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: 0;
    background: var(--orange);
    transition: width 0.5s ease-out;
  }
  .leg.done .fill {
    width: 100%;
  }
  .leg.failed {
    background: #ff6b57;
  }
  .leg .fill.sweep {
    width: 45%;
    animation: sweep 1.4s ease-in-out infinite;
  }
  @keyframes sweep {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(225%);
    }
  }

  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.75rem;
    margin: 0.85rem 0 0;
  }
  .stats dt {
    color: var(--muted);
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .stats dd {
    margin: 0.05rem 0 0;
    font-size: 1.0625rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }
  .stats .of {
    color: var(--muted);
    font-size: 0.875rem;
    font-weight: 600;
  }

  .steps {
    display: grid;
    gap: 0.15rem;
    margin: 1rem 0 0;
    padding: 0.85rem 0 0;
    border-top: 1px solid var(--line);
    list-style: none;
    font-size: 0.875rem;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-height: 1.6rem;
    color: var(--muted);
  }
  .steps li.done {
    color: var(--text);
  }
  .steps li.current {
    color: var(--text);
    font-weight: 700;
  }
  .steps li.failed {
    color: var(--alarm);
    font-weight: 700;
  }
  .mark {
    display: grid;
    flex: none;
    place-items: center;
    width: 1.1rem;
    height: 1.1rem;
    border: 2px solid var(--line);
    border-radius: 50%;
    box-sizing: border-box;
  }
  .steps li.done .mark {
    border-color: var(--orange);
    background: var(--orange);
  }
  .steps li.current .mark {
    border-color: var(--orange);
    box-shadow:
      inset 0 0 0 2px var(--well),
      inset 0 0 0 6px var(--orange);
  }
  .steps li.failed .mark {
    border-color: #ff6b57;
    background: #ff6b57;
  }
  .mark svg {
    width: 0.8rem;
    height: 0.8rem;
    fill: none;
    stroke: var(--text);
    stroke-width: 2.25;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .steps .amount {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }
  .job :global(button) {
    margin-top: 1rem;
  }
  .job :global(.hint) {
    margin-top: 0.5rem;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (max-width: 30rem) {
    .figure {
      font-size: 2.5rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .leg .fill {
      transition: none;
    }
    .leg .fill.sweep {
      width: 50%;
      animation: none;
    }
  }
</style>
