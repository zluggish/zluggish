<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { checkLauncherHosts } from '../health';
  import { request } from '../../lib/connection';
  import Layout from '../../components/Layout.svelte';
  import Form from '../../components/Form.svelte';
  import type { GamePageModel } from '../../lib/game-app.dto';

  let { page }: { page: GamePageModel } = $props();
  let current = $state(untrack(() => page));
  let locked = $state(false);
  let checking = $state(untrack(() => !!page.healthHosts));
  let failedHosts = $state<Array<string>>([]);

  onMount(() => {
    const hosts = current.healthHosts;
    if (!hosts) {
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3000);
    let active = true;
    void checkLauncherHosts(hosts, controller.signal).then((failures) => {
      window.clearTimeout(timeout);
      if (!active) {
        return;
      }
      failedHosts = failures;
      checking = false;
    });

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  });

  // Counts failures handed up from the user list, so the same message twice is shown and announced again.
  let failures = $state(0);

  function expire() {
    locked = true;
  }

  $effect(() => {
    // The launcher's public loading screen has no rider session to monitor.
    if (!current.csrf) {
      return;
    }

    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('zluggish-session-change') : undefined;
    let controller: AbortController | undefined;
    let alive = true;
    channel?.addEventListener('message', expire);

    async function check() {
      if (document.hidden || locked) {
        return;
      }
      controller?.abort();
      controller = new AbortController();

      try {
        const response = await request('/ui/status/session', {
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'X-Game-Context': current.csrf },
          signal: controller.signal,
        });

        if (alive && [401, 409].includes(response.status)) {
          expire();
        }
      } catch {
        /* A network error is not proof that the session expired. */
      }
    }

    const focus = () => {
      void check();
    };

    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);

    return () => {
      alive = false;
      controller?.abort();
      channel?.close();
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  });
</script>

{#snippet warning(title: string, message: string)}
  <p class="security" role="alert">
    <strong>{title}</strong>
    {message}
  </p>
{/snippet}

<svelte:head><title>{current.title}</title></svelte:head>

<Layout
  title={current.title}
  page={current.kind}
  back={current.back}
  version={current.version}
  zwiftVersion={current.zwiftVersion}
>
  {#snippet aside()}
    {#if current.webApp && (current.kind === 'dashboard' || current.kind === 'login')}
      <a class="web-app" href={current.webApp} target="_blank" rel="noopener noreferrer">
        Manage your account
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 4 12" /></svg>
        <span class="visually-hidden">(opens the web app in your browser)</span>
      </a>
    {/if}
  {/snippet}
  {#if current.warning}{@render warning('Unsafe connection.', current.warning)}{/if}
  {#if (current.kind === 'login' || current.kind === 'unlock') && failedHosts.length}
    {@render warning('Connection check failed.', `The launcher could not verify ${failedHosts.join(', ')}.`)}
  {/if}
  {#if checking}<p class="checking-status" role="status">Checking connections…</p>{/if}
  <div class:checking>
    {#key failures}{#if current.message}<p class="notice" role={current.failed ? 'alert' : 'status'}>
          {current.message}
        </p>{/if}{/key}
    {#if locked}<p class="error" role="alert">
        Your session or user changed. <a href="/login/">Sign in</a> or
        <button type="button" onclick={() => location.reload()}>Reload this page</button>.
      </p>{/if}
    {#each current.forms as model (model.id)}
      <div hidden={current.kind === 'dashboard' && model.id === 'switch'}>
        <Form
          {model}
          csrf={current.csrf}
          {locked}
          onpage={(value) => {
            if (value.kind !== 'message') current = value;
          }}
          onexpire={expire}
          onfail={model.user
            ? (message) => {
                current = { ...current, message, failed: true };
                failures++;
              }
            : undefined}
        >
          {#snippet actions()}
            {#if current.kind === 'dashboard' && model.id === 'launch'}
              <button type="submit" form="game-form-switch" disabled={locked}>Switch rider</button>
            {/if}
          {/snippet}
        </Form>
      </div>
    {/each}
  </div>
</Layout>

<style>
  .checking-status {
    display: none;
  }
  @media (scripting: enabled) {
    .checking-status {
      display: block;
    }
    .checking {
      display: none;
    }
  }
  .web-app {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    margin-left: 0.4rem;
    padding: 0.3rem 0.7rem 0.3rem 0.8rem;
    border: 1.5px solid rgb(255 255 255 / 0.35);
    border-radius: 999px;
    color: var(--text);
    font-size: 0.8125rem;
    font-weight: 700;
    white-space: nowrap;
    text-decoration: none;
  }
  .web-app svg {
    width: 0.8rem;
    height: 0.8rem;
    fill: none;
    stroke: var(--orange);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .web-app:hover {
    border-color: var(--orange);
    background: rgb(255 255 255 / 0.08);
  }
  .web-app:focus-visible {
    outline: 2px solid var(--orange);
    outline-offset: 2px;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  /* Sized for the small launcher window: one compact strip above the page. */
  .security {
    max-width: none;
    margin: 0 0 0.75rem;
    padding: 0.5rem 0.75rem;
    border-left: 3px solid #ff6b57;
    border-radius: 0 8px 8px 0;
    background: rgb(255 90 70 / 0.16);
    color: var(--alarm);
    font-size: 0.8125rem;
    line-height: 1.35;
  }
  .security strong {
    color: var(--text);
    font-weight: 800;
  }
</style>
