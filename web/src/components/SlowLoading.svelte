<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../lib/i18n/index';
  import { connection } from '../lib/connection';

  let slow = $state(false);

  onMount(() => {
    const timer = setTimeout(() => (slow = true), 400);
    return () => clearTimeout(timer);
  });
</script>

{#if slow && !$connection.unavailable}
  <div role="status">
    <p>{t('loading_taking_longer')}</p>
    <button type="button" onclick={() => location.reload()}>{t('reload_this_page')}</button>
  </div>
{/if}
