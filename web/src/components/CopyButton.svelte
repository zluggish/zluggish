<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '../lib/i18n/index';

  let {
    text,
    label = t('copy'),
    disabled = false,
    class: buttonClass = 'copy',
  }: { text: string; label?: string; disabled?: boolean; class?: string } = $props();

  let field: HTMLTextAreaElement | undefined;
  let result = $state<{ text: string; copied: boolean }>();
  let clear: ReturnType<typeof setTimeout> | undefined;
  const manual = $derived(result?.text === text && !result.copied);

  function copySelection(field: HTMLTextAreaElement) {
    const focused = document.activeElement;
    field.hidden = false;
    field.focus({ preventScroll: true });
    field.select();

    try {
      // A user-triggered copy command also works on HTTP origins without navigator.clipboard.
      if (document.execCommand('copy')) {
        field.hidden = true;
        if (focused instanceof HTMLElement) {
          focused.focus({ preventScroll: true });
        }

        return true;
      }
    } catch {
      // Leave the text selected so the user can copy it manually.
    }

    return false;
  }

  async function copy() {
    const value = text;
    let copied = false;

    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(value);
        copied = true;
      } catch {
        // Embedded browsers and clipboard permissions can block writes.
      }
    }

    if (value !== text || !field?.isConnected) {
      return;
    }

    copied ||= copySelection(field);
    clearTimeout(clear);
    result = { text: value, copied };

    if (copied) {
      clear = setTimeout(() => (result = undefined), 2000);
    }
  }

  onDestroy(() => clearTimeout(clear));
</script>

<button type="button" class={buttonClass} {disabled} onclick={copy} aria-live="polite">
  {manual ? t('copy_manually') : result?.text === text && result.copied ? t('copied') : label}
</button>
<textarea
  bind:this={field}
  class:copy-source={!manual}
  hidden={!manual}
  readonly
  rows="2"
  value={text}
  aria-label={t('copy_manually')}></textarea>

<style>
  textarea {
    max-width: 100%;
  }

  .copy-source {
    position: fixed;
    top: 0;
    left: 0;
    opacity: 0;
    pointer-events: none;
  }
</style>
