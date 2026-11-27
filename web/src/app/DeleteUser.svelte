<script lang="ts">
  import Avatar from '../components/Avatar.svelte';
  import { t } from '../lib/i18n/index';
  import type { DeletionFootprint, User } from './schemas';

  let {
    who,
    name,
    initials,
    photo,
    footprint,
    busy,
    error,
    onconfirm,
    oncancel,
    ondisable,
  }: {
    who: User;
    name: string;
    initials: string;
    photo: string | null;
    footprint: DeletionFootprint;
    busy: boolean;
    error: string;
    onconfirm: (username: string) => void;
    oncancel: () => void;
    ondisable: () => void;
  } = $props();

  let typed = $state('');

  /** The server compares the same way: surrounding spaces and letter case do not matter. */
  const armed = $derived(typed.trim().toLowerCase() === who.username.toLowerCase());

  const distance = $derived(
    t('km', {
      value1: (footprint.distance_m / 1000).toLocaleString([], { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    }),
  );

  const moving = $derived.by(() => {
    const minutes = Math.round(footprint.moving_ms / 60_000);

    return minutes < 60
      ? t('min', { value1: minutes })
      : t('h_min', { value1: Math.floor(minutes / 60).toLocaleString(), value2: minutes % 60 });
  });

  const since = $derived(
    footprint.first_ride && !Number.isNaN(Date.parse(footprint.first_ride))
      ? new Date(footprint.first_ride).toLocaleDateString([], { month: 'long', year: 'numeric' })
      : null,
  );

  function focus(node: HTMLElement) {
    node.focus();
  }
</script>

<div
  class="dialog removal"
  role="alertdialog"
  aria-modal="true"
  aria-labelledby="delete-title"
  aria-describedby="delete-detail"
>
  <header>
    <Avatar {initials} {photo} />
    <div>
      <h2 id="delete-title">{t('user_delete_confirm', { value1: name })}</h2>
      <p class="muted login">{who.username}</p>
    </div>
  </header>

  <div id="delete-detail">
    {#if footprint.activities > 0}
      <dl class="ledger" class:struck={armed && !footprint.connected}>
        <div>
          <dt>{t('activities')}</dt>
          <dd>{footprint.activities.toLocaleString()}</dd>
        </div>
        <div>
          <dt>{t('distance')}</dt>
          <dd>{distance}</dd>
        </div>
        <div>
          <dt>{t('moving_time')}</dt>
          <dd>{moving}</dd>
        </div>
        {#if since}
          <div>
            <dt>{t('user_delete_since')}</dt>
            <dd>{since}</dd>
          </div>
        {/if}
      </dl>
    {:else}
      <p class="none">{t('user_delete_no_activities', { value1: name })}</p>
    {/if}
    <p>{t('user_delete_also')}</p>
  </div>

  {#if who.enabled}
    <p class="keep">
      <span class="muted">{t('user_delete_keep_hint')}</span>
      <button type="button" class="link" disabled={busy} onclick={ondisable}>{t('user_delete_disable_instead')}</button>
    </p>
  {/if}

  {#if error}<p class="notice failed" role="alert">{error}</p>{/if}

  {#if footprint.connected}
    <p class="riding" role="status">{t('user_delete_riding', { value1: name })}</p>
    <div class="actions">
      <button type="button" disabled={busy} onclick={oncancel} use:focus>{t('cancel')}</button>
      <button type="button" class="danger" disabled>{t('user_delete_action')}</button>
    </div>
  {:else}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        if (armed) onconfirm(typed);
      }}
    >
      <label for="delete-login">{t('user_delete_type_label')}</label>
      <input
        id="delete-login"
        bind:value={typed}
        placeholder={who.username}
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        use:focus
      />
      <div class="actions">
        <button type="button" disabled={busy} onclick={oncancel}>{t('cancel')}</button>
        <button class="danger" class:busy disabled={busy || !armed}>{t('user_delete_action')}</button>
      </div>
    </form>
  {/if}
</div>

<style>
  .removal {
    width: min(32rem, 100%);
    max-height: calc(100dvh - 2rem);
    overflow-y: auto;
    box-sizing: border-box;
    padding: 1.25rem 1.25rem 1rem;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: rgb(36 47 62 / 0.97);
    box-shadow: 0 18px 48px rgb(0 0 0 / 0.45);
    animation: rise 160ms ease-out;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }

  header {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    margin-bottom: 1rem;
  }
  header :global(.avatar) {
    flex: none;
    width: 3rem;
    height: 3rem;
    font-size: 1rem;
  }
  header h2 {
    margin: 0;
    text-transform: none;
    letter-spacing: 0;
    font-size: 1.125rem;
    overflow-wrap: anywhere;
  }
  .login {
    margin: 0.15rem 0 0;
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }

  /* The rider's history reads like the ride summary in the game: big figures, small names under them. */
  .ledger {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem 1rem;
    margin: 0 0 0.85rem;
    padding: 0.9rem 1rem;
    border-radius: 10px;
    background: var(--well);
  }
  .ledger div {
    display: flex;
    flex-direction: column-reverse;
    min-width: 0;
  }
  .ledger dt {
    color: var(--muted);
    font-size: 0.75rem;
  }
  .ledger dd {
    margin: 0;
    font-size: 1.3rem;
    font-weight: 800;
    line-height: 1.15;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
    transition: color 200ms ease-out;
  }

  /* Once the login name matches, a line crosses out each figure the delete removes. */
  .ledger dd {
    position: relative;
    width: fit-content;
    max-width: 100%;
  }
  .ledger dd::after {
    content: '';
    position: absolute;
    left: -0.15rem;
    right: -0.15rem;
    top: 55%;
    height: 2px;
    border-radius: 1px;
    background: var(--alarm);
    transform: scaleX(0);
    transform-origin: left center;
    transition: transform 220ms ease-out;
    pointer-events: none;
  }
  .ledger div:nth-child(2) dd::after {
    transition-delay: 50ms;
  }
  .ledger div:nth-child(3) dd::after {
    transition-delay: 100ms;
  }
  .ledger div:nth-child(4) dd::after {
    transition-delay: 150ms;
  }
  .ledger.struck dd::after {
    transform: scaleX(1);
  }
  .ledger.struck dd {
    color: var(--muted);
  }

  .none {
    margin: 0 0 0.85rem;
    padding: 0.75rem 1rem;
    border-radius: 10px;
    background: var(--well);
  }
  #delete-detail p:last-child {
    margin: 0;
  }

  .keep {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.15rem 0.5rem;
    margin: 0.75rem 0 0;
    font-size: 0.875rem;
  }
  button.link {
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    text-transform: none;
    letter-spacing: 0;
    text-decoration: underline;
    text-underline-offset: 0.2em;
    cursor: pointer;
  }
  button.link:hover:not(:disabled) {
    background: none;
    text-decoration-color: var(--orange);
  }

  form {
    margin: 1.1rem 0 0;
    padding: 0;
    border-radius: 0;
    background: none;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  label {
    margin: 0 0 0.35rem;
  }
  input {
    max-width: none;
  }

  .riding {
    margin: 1rem 0 0;
    padding: 0.6rem 0.8rem;
    border-left: 3px solid var(--orange);
    background: var(--well);
  }

  .notice.failed {
    margin: 0.9rem 0 0;
    padding: 0.5rem 0.75rem;
    color: var(--alarm);
    border-left: 3px solid #ff6b57;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .actions button {
    margin: 0.75rem 0 0;
  }
  button.danger {
    border-color: rgb(255 179 166 / 0.75);
    color: var(--alarm);
  }
  button.danger:hover:not(:disabled) {
    background: rgb(255 90 70 / 0.14);
  }
  /* Disabled until the name matches, which is not a wait. */
  button.danger:disabled:not(.busy) {
    cursor: not-allowed;
  }

  @media (prefers-reduced-motion: reduce) {
    .removal {
      animation: none;
    }
    .ledger dd,
    .ledger dd::after {
      transition: none;
    }
  }
</style>
