<script lang="ts">
  import { t } from '../lib/i18n/index';
  import { onMount } from 'svelte';
  import Avatar from '../components/Avatar.svelte';
  import SlowLoading from '../components/SlowLoading.svelte';
  import type { Api } from '../lib/api';
  import type { User } from './schemas';
  import { accessOverview, createdGroup } from './access';
  import type { AccessOverview } from './access';

  type Confirmation = {
    title: string;
    detail: string;
    label: string;
    destructive: boolean;
    confirm: () => Promise<void>;
  };

  let {
    api,
    users,
    confirm,
    done,
    onoverview,
  }: {
    api: Api;
    users: Array<User>;
    confirm: (confirmation: Confirmation) => void;
    done: (message: string) => void;
    onoverview?: ((overview: AccessOverview) => void) | undefined;
  } = $props();

  let overview = $state<AccessOverview | null>(null);
  let failure = $state('');
  let saving = $state(false);
  let newName = $state('');
  let renaming = $state<number | null>(null);
  let renameValue = $state('');
  let emailDrafts = $state<Record<number, string>>({});
  let riderDrafts = $state<Record<number, string>>({});
  /** The group picked beside an unmatched email or an unreachable rider, keyed by that row. */
  let targets = $state<Record<string, string>>({});

  const enabled = $derived(users.filter((user) => user.enabled));
  const byId = $derived(new Map(users.map((user) => [user.player_id, user])));
  const name = (user: User) => `${user.first_name} ${user.last_name}`.trim() || user.username;
  const initials = (user: User) => `${user.first_name.charAt(0)}${user.last_name.charAt(0)}`.toUpperCase();
  const photo = (user: User) =>
    user.avatar !== null ? `/api/manage/users/${user.player_id}/avatar?v=${user.avatar}` : null;
  const riderName = (player: number) => {
    const user = byId.get(player);

    return user ? name(user) : t('player_id', { value1: player });
  };

  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  function ago(at: number) {
    const minutes = Math.round((at - Date.now()) / 60_000);

    if (Math.abs(minutes) < 60) {
      return relative.format(minutes, 'minute');
    }

    const hours = Math.round(minutes / 60);

    return Math.abs(hours) < 24 ? relative.format(hours, 'hour') : relative.format(Math.round(hours / 24), 'day');
  }

  /** Riders who would no longer appear in any launcher if this group went away. */
  function strandedBy(id: number) {
    if (!overview) {
      return [];
    }

    const elsewhere = new Set(overview.groups.filter((group) => group.id !== id).flatMap((group) => group.riders));
    const own = new Set(overview.ownEmail.map((row) => row.playerId));
    const group = overview.groups.find((item) => item.id === id);

    return (group?.riders ?? []).filter((player) => !elsewhere.has(player) && !own.has(player));
  }

  async function change(work: () => Promise<AccessOverview>, message = '') {
    saving = true;
    failure = '';

    try {
      overview = await work();
      onoverview?.(overview);

      if (message) {
        done(message);
      }

      return true;
    } catch (error) {
      failure = error instanceof Error ? error.message : t('request_error');

      return false;
    } finally {
      saving = false;
    }
  }

  const path = (id: number, rest = '') => `/api/manage/access/groups/${id}${rest}`;

  const addEmail = (id: number, email: string) =>
    change(() => api(accessOverview, path(id, `/emails/${encodeURIComponent(email.trim())}`), 'PUT'));

  const addRider = (id: number, player: number) =>
    change(() => api(accessOverview, path(id, `/riders/${player}`), 'PUT'));

  async function create(event: SubmitEvent) {
    event.preventDefault();

    if (
      await change(
        () => api(createdGroup, '/api/manage/access/groups', 'POST', { name: newName }),
        t('access_group_created', { value1: newName.trim() }),
      )
    ) {
      newName = '';
    }
  }

  async function rename(event: SubmitEvent, id: number) {
    event.preventDefault();

    if (await change(() => api(accessOverview, path(id), 'PATCH', { name: renameValue }))) {
      renaming = null;
    }
  }

  function remove(group: AccessOverview['groups'][number]) {
    const stranded = strandedBy(group.id).map(riderName);

    confirm({
      title: t('access_delete_confirm_title', { value1: group.name }),
      detail: stranded.length
        ? t('access_delete_confirm_stranded', { value1: stranded.join(', ') })
        : t('access_delete_confirm_safe'),
      label: t('access_delete_group'),
      destructive: true,
      confirm: async () => {
        await change(() => api(accessOverview, path(group.id), 'DELETE'), t('access_group_deleted'));
      },
    });
  }

  onMount(async () => {
    try {
      overview = await api(accessOverview, '/api/manage/access');
      onoverview?.(overview);
    } catch (error) {
      failure = error instanceof Error ? error.message : t('request_error');
    }
  });
</script>

{#snippet addToGroup(key: string, label: string, add: (group: number) => Promise<boolean>)}
  {#if overview && overview.groups.length}
    <form
      class="inline"
      onsubmit={async (event) => {
        event.preventDefault();
        const chosen = Number(targets[key] ?? overview?.groups[0]?.id);

        if (chosen) {
          await add(chosen);
        }
      }}
    >
      <select
        aria-label={label}
        bind:value={() => targets[key] ?? String(overview?.groups[0]?.id), (v) => (targets[key] = v)}
      >
        {#each overview.groups as group (group.id)}<option value={String(group.id)}>{group.name}</option>{/each}
      </select>
      <button type="submit" disabled={saving}>{t('access_add_to_group')}</button>
    </form>
  {/if}
{/snippet}

<div class="access">
  <p class="intro">{t('access_intro')}</p>

  {#if failure}<p class="error" role="alert">{failure}</p>{/if}

  {#if !overview}
    {#if !failure}<SlowLoading />{/if}
  {:else}
    {#if !overview.configured}<p class="note">{t('access_not_configured')}</p>{/if}

    {#if overview.unreachable.length}
      <section class="unreachable" aria-labelledby="access-unreachable">
        <h2 id="access-unreachable">{t('access_unreachable_title')}</h2>
        <p class="hint">{t('access_unreachable_hint')}</p>
        <ul class="rows">
          {#each overview.unreachable as player (player)}
            {@const user = byId.get(player)}
            <li>
              <span class="who">
                {#if user}<Avatar initials={initials(user)} photo={photo(user)} />{/if}
                <span>{riderName(player)}</span>
              </span>
              {@render addToGroup(
                `rider-${player}`,
                t('access_add_rider_to_group', { value1: riderName(player) }),
                (group) => addRider(group, player),
              )}
            </li>
          {/each}
        </ul>
        {#if !overview.groups.length}<p class="hint">{t('access_create_group_first')}</p>{/if}
      </section>
    {/if}

    {#if !overview.groups.length}
      <p class="empty">{t('access_empty')}</p>
    {/if}

    {#each overview.groups as group (group.id)}
      {@const candidates = enabled.filter((user) => !group.riders.includes(user.player_id))}
      <section class="panel group" aria-labelledby={`access-group-${group.id}`}>
        <header>
          {#if renaming === group.id}
            <form class="inline rename" onsubmit={(event) => rename(event, group.id)}>
              <!-- svelte-ignore a11y_autofocus (the field the person just asked to edit) -->
              <input aria-label={t('access_group_name')} bind:value={renameValue} maxlength="80" required autofocus />
              <button type="submit" disabled={saving}>{t('access_save_name')}</button>
              <button type="button" onclick={() => (renaming = null)}>{t('cancel')}</button>
            </form>
          {:else}
            <h2 id={`access-group-${group.id}`}>{group.name}</h2>
            <div class="tools">
              <button
                type="button"
                disabled={saving}
                onclick={() => {
                  renaming = group.id;
                  renameValue = group.name;
                }}>{t('access_rename')}</button
              >
              <button type="button" disabled={saving} onclick={() => remove(group)}>{t('access_delete_group')}</button>
            </div>
          {/if}
        </header>

        <div class="columns">
          <div>
            <h3>{t('access_emails')}</h3>
            {#if group.emails.length}
              <ul class="rows">
                {#each group.emails as email (email)}
                  <li>
                    <span class="value">{email}</span>
                    <button
                      type="button"
                      class="remove"
                      disabled={saving}
                      aria-label={t('access_remove_from', { value1: email, value2: group.name })}
                      title={t('access_remove_from', { value1: email, value2: group.name })}
                      onclick={() =>
                        change(() =>
                          api(accessOverview, path(group.id, `/emails/${encodeURIComponent(email)}`), 'DELETE'),
                        )}>×</button
                    >
                  </li>
                {/each}
              </ul>
            {:else}<p class="hint">{t('access_no_emails')}</p>{/if}
            <form
              class="inline"
              onsubmit={async (event) => {
                event.preventDefault();

                if (await addEmail(group.id, emailDrafts[group.id] ?? '')) {
                  emailDrafts[group.id] = '';
                }
              }}
            >
              <input
                type="email"
                aria-label={t('access_add_email_to', { value1: group.name })}
                placeholder={t('access_email_placeholder')}
                autocomplete="off"
                required
                bind:value={() => emailDrafts[group.id] ?? '', (v) => (emailDrafts[group.id] = v)}
              />
              <button type="submit" disabled={saving}>{t('access_add_email')}</button>
            </form>
          </div>

          <div>
            <h3>{t('access_riders')}</h3>
            {#if group.riders.length}
              <ul class="rows">
                {#each group.riders as player (player)}
                  {@const user = byId.get(player)}
                  <li>
                    <span class="who">
                      {#if user}<Avatar initials={initials(user)} photo={photo(user)} />{/if}
                      <span>{riderName(player)}</span>
                      {#if user && !user.enabled}<span class="hint">{t('user_disabled_status')}</span>{/if}
                    </span>
                    <button
                      type="button"
                      class="remove"
                      disabled={saving}
                      aria-label={t('access_remove_from', { value1: riderName(player), value2: group.name })}
                      title={t('access_remove_from', { value1: riderName(player), value2: group.name })}
                      onclick={() => change(() => api(accessOverview, path(group.id, `/riders/${player}`), 'DELETE'))}
                      >×</button
                    >
                  </li>
                {/each}
              </ul>
            {:else}<p class="hint">{t('access_no_riders')}</p>{/if}
            {#if candidates.length}
              <form
                class="inline"
                onsubmit={async (event) => {
                  event.preventDefault();
                  const player = Number(riderDrafts[group.id] ?? candidates[0]?.player_id);

                  if (player) {
                    await addRider(group.id, player);
                  }
                }}
              >
                <select
                  aria-label={t('access_add_rider_to', { value1: group.name })}
                  bind:value={
                    () => riderDrafts[group.id] ?? String(candidates[0]?.player_id), (v) => (riderDrafts[group.id] = v)
                  }
                >
                  {#each candidates as user (user.player_id)}<option value={String(user.player_id)}>{name(user)}</option
                    >{/each}
                </select>
                <button type="submit" disabled={saving}>{t('access_add_rider')}</button>
              </form>
            {/if}
          </div>
        </div>
      </section>
    {/each}

    <form class="inline create" onsubmit={create}>
      <input
        aria-label={t('access_group_name')}
        placeholder={t('access_group_name')}
        maxlength="80"
        required
        bind:value={newName}
      />
      <button type="submit" disabled={saving}>{t('access_new_group')}</button>
    </form>

    {#if overview.seen.length}
      <section class="quiet" aria-labelledby="access-waiting">
        <h2 id="access-waiting">{t('access_waiting_title')}</h2>
        <p class="hint">{t('access_waiting_hint')}</p>
        <ul class="rows">
          {#each overview.seen as row (row.email)}
            <li>
              <span class="value"
                >{row.email} <span class="hint">{t('access_seen', { value1: ago(row.lastSeen) })}</span></span
              >
              {@render addToGroup(
                `email-${row.email}`,
                t('access_add_email_to_group', { value1: row.email }),
                (group) => addEmail(group, row.email),
              )}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if overview.ownEmail.length}
      <section class="quiet" aria-labelledby="access-own">
        <h2 id="access-own">{t('access_own_email_title')}</h2>
        <p class="hint">{t('access_own_email_hint')}</p>
        <ul class="rows">
          {#each overview.ownEmail as row (row.playerId)}
            {@const user = byId.get(row.playerId)}
            <li>
              <span class="who">
                {#if user}<Avatar initials={initials(user)} photo={photo(user)} />{/if}
                <span>{riderName(row.playerId)} <span class="hint">{row.email}</span></span>
              </span>
              {@render addToGroup(
                `own-${row.playerId}`,
                t('access_add_rider_to_group', { value1: riderName(row.playerId) }),
                (group) => addRider(group, row.playerId),
              )}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/if}
</div>

<style>
  .access {
    max-width: 56rem;
  }
  .intro {
    margin: 0 0 1.25rem;
    color: var(--muted);
  }
  .note,
  .empty {
    margin: 0 0 1rem;
  }
  .hint {
    margin: 0.25rem 0 0.5rem;
    color: var(--muted);
    font-size: 0.8125rem;
  }
  span.hint {
    margin: 0 0 0 0.35rem;
  }
  h3 {
    margin: 0 0 0.4rem;
    color: var(--muted);
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .panel {
    margin: 0 0 1rem;
    padding: 1.1rem 1.25rem 1.25rem;
    border-radius: 12px;
    background: var(--glass);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
  .group header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    margin-bottom: 0.9rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--line);
  }
  /* A group's name is the administrator's own words: shown as typed, not in the section heading's capitals. */
  .group h2 {
    margin: 0;
    font-size: 1.125rem;
    text-transform: none;
    letter-spacing: 0;
    overflow-wrap: anywhere;
  }
  .tools {
    display: flex;
    gap: 0.5rem;
  }
  .tools button,
  .inline button {
    flex: none;
    margin: 0;
    white-space: nowrap;
  }
  .columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: 1.25rem 2rem;
  }
  .rows {
    margin: 0 0 0.6rem;
    padding: 0;
    list-style: none;
  }
  .rows li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem 0.75rem;
    min-height: 2.5rem;
    padding: 0.3rem 0;
    border-bottom: 1px solid var(--line);
  }
  .rows li:last-child {
    border-bottom: 0;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    min-width: 0;
  }
  .who :global(.avatar) {
    width: 1.75rem;
    height: 1.75rem;
    font-size: 0.6875rem;
    box-shadow: 0 0 0 2px var(--orange);
  }
  .value {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  /* An email or rider and its remove button stay on one line however long the email. */
  .rows li:has(> button.remove) {
    flex-wrap: nowrap;
  }
  button.remove {
    flex: none;
    width: 2rem;
    height: 2rem;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 50%;
    color: var(--muted);
    font-size: 1.1rem;
    line-height: 1;
  }
  button.remove:hover {
    border-color: var(--text);
    color: var(--text);
  }
  /* The web app draws every form as a panel; these sit inside a row or a group instead. */
  .inline {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    margin: 0;
    padding: 0;
    border-radius: 0;
    background: none;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  .inline input,
  .inline select {
    flex: 1 1 11rem;
    width: auto;
    min-width: 0;
  }
  .rows .inline {
    flex: 0 1 auto;
    flex-wrap: nowrap;
  }
  .rows .inline select {
    flex: 0 1 11rem;
  }
  .rename {
    flex: 1;
  }
  .create {
    max-width: 30rem;
    margin: 0 0 2rem;
  }
  /* Riders no launcher can pick get an orange edge: they are the only list here that needs action. */
  .unreachable {
    margin: 0 0 1.5rem;
    padding: 1rem 1.25rem;
    border-left: 4px solid var(--orange);
    border-radius: 0 12px 12px 0;
    background: var(--glass);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
  .unreachable h2,
  .quiet h2 {
    margin-bottom: 0.25rem;
  }
  .quiet {
    margin: 0 0 1.5rem;
  }
  @media (max-width: 30rem) {
    .panel,
    .unreachable {
      padding-inline: 1rem;
    }
    .rows .inline {
      flex: 1 1 100%;
    }
    .rows .inline select {
      flex: 1 1 6rem;
    }
  }
</style>
