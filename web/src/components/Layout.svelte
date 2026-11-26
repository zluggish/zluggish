<script lang="ts">
  import { t } from '../lib/i18n/shared';
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import ConnectionBanner from './ConnectionBanner.svelte';

  let {
    title,
    heading = true,
    page,
    back,
    crumb,
    version,
    zwiftVersion,
    menu,
    aside,
    onhome,
    onback,
    children,
  }: {
    title: string;
    /** False keeps the title for screen readers only, when the page is already named elsewhere. */
    heading?: boolean;
    page: string;
    back?: { href: string; label: string } | undefined;
    /** A small link above the heading to the page this one sits under, such as Apps above a setup. */
    crumb?: { href: string; label: string } | undefined;
    version: string;
    zwiftVersion?: string | undefined;
    /** Contents of the side menu behind the bar's menu button. The game app has none. */
    menu?: Snippet | undefined;
    /** Sits beside the logo in the bar, such as the launcher's link out to the web app. */
    aside?: Snippet | undefined;
    onhome?: (() => void) | undefined;
    /** Follows the back link or crumb inside the page instead of loading it again. */
    onback?: (() => void) | undefined;
    children: Snippet;
  } = $props();

  let about = $state<HTMLDialogElement>();

  let drawer = $state<HTMLDialogElement>();
  let open = $state(false);

  let desktop = $state(false);

  onMount(() => {
    const viewport = window.matchMedia('(min-width: 1100px)');

    const update = () => {
      if (viewport.matches) {
        drawer?.close();
        open = false;
      }

      desktop = viewport.matches;
    };

    update();
    viewport.addEventListener('change', update);

    return () => viewport.removeEventListener('change', update);
  });

  function openMenu() {
    drawer?.showModal();
    open = true;
    drawer?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  }
</script>

<div class="bar" class:has-menu={!!menu}>
  {#if menu && !desktop}<button
      class="round"
      aria-label={t('menu')}
      aria-haspopup="dialog"
      aria-controls="menu"
      aria-expanded={open}
      onclick={openMenu}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" /></svg></button
    >{/if}
  <a
    class="brand"
    href="/"
    aria-label={t('zluggish_home')}
    onclick={(event) => {
      if (onhome && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        onhome();
      }
    }}
  >
    <span class="logo" aria-hidden="true"></span>
    <span class="wordmark">{t('zluggish')}</span>
  </a>
  {@render aside?.()}
  {#if !menu && version}<button
      class="version"
      aria-label={`About Zluggish v${version}`}
      aria-haspopup="dialog"
      onclick={() => about?.showModal()}>{t('v', { value1: version })}</button
    >{/if}
</div>
{#if menu && desktop}
  <aside class="sidebar" aria-label={t('menu')}>
    <div class="sheet">
      {@render menu()}
      {#if version}<button
          class="version"
          aria-label={`About Zluggish v${version}`}
          aria-haspopup="dialog"
          onclick={() => about?.showModal()}>{t('v', { value1: version })}</button
        >{/if}
    </div>
  </aside>
{:else if menu}
  <dialog
    id="menu"
    class="drawer"
    aria-label={t('menu')}
    bind:this={drawer}
    onclose={() => (open = false)}
    onclick={(event) => {
      if (event.target === drawer || (event.target as Element).closest('a, button')) drawer?.close();
    }}
  >
    <div class="sheet">
      <button class="round close" aria-label={t('close_menu')}
        ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg></button
      >
      {@render menu()}
      {#if version}<button
          class="version"
          aria-label={`About Zluggish v${version}`}
          aria-haspopup="dialog"
          onclick={() => about?.showModal()}>{t('v', { value1: version })}</button
        >{/if}
    </div>
  </dialog>
{/if}
<dialog
  class="about"
  aria-labelledby="about-title"
  bind:this={about}
  onclick={(event) => {
    if (event.target === about) about?.close();
  }}
>
  <div class="about-content">
    <button class="round about-close" aria-label={t('close_about')} onclick={() => about?.close()}
      ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg></button
    >
    <h2 id="about-title">{t('about_zluggish')}</h2>
    <dl>
      <dt>{t('version')}</dt>
      <dd>{version}</dd>
      <dt>{t('supports_zwift')}</dt>
      <dd>{zwiftVersion || t('unknown')}</dd>
    </dl>
    <p class="star">
      <a href="https://github.com/zluggish/zluggish" target="_blank" rel="noopener noreferrer"
        >{t('source_on_github')}</a
      >
    </p>
  </div>
</dialog>
<main data-page={page} class:has-menu={!!menu}>
  {#if heading || back || crumb}<header class:crumbed={!!crumb}>
      {#if crumb}<a
          class="crumb"
          href={crumb.href}
          onclick={(event) => {
            if (onback && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
              event.preventDefault();
              onback();
            }
          }}>{crumb.label}</a
        >{/if}
      {#if back}<a
          class="back"
          href={back.href}
          aria-label={back.label}
          title={back.label}
          onclick={(event) => {
            if (onback && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
              event.preventDefault();
              onback();
            }
          }}
        ></a>{/if}
      <h1>{title}</h1>
    </header>{:else}<h1 class="hidden-heading">{title}</h1>{/if}
  <ConnectionBanner />
  {@render children()}
</main>

<style>
  .hidden-heading {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.75rem max(1.5rem, calc((100% - 57rem) / 2));
    background: rgb(26 36 50 / 0.82);
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
  }
  /* Round outlined controls like Zwift's header buttons: the menu button, its close button and back. */
  .round {
    flex: none;
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    margin: 0 0.4rem 0 0;
    padding: 0;
    border: 2px solid rgb(255 255 255 / 0.7);
    border-radius: 50%;
  }
  .round:hover {
    border-color: var(--orange);
  }
  .round svg {
    width: 1.3rem;
    height: 1.3rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.4;
    stroke-linecap: round;
  }

  .drawer {
    position: fixed;
    inset: 0 auto 0 0;
    width: min(19rem, 86vw);
    max-width: none;
    height: 100dvh;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    background: rgb(26 36 50 / 0.97);
    color: var(--text);
    box-shadow: 16px 0 48px rgb(0 0 0 / 0.45);
    transform: translateX(-100%);
    transition:
      transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
      overlay 220ms allow-discrete,
      display 220ms allow-discrete;
  }
  .drawer[open] {
    transform: none;
  }
  @starting-style {
    .drawer[open] {
      transform: translateX(-100%);
    }
  }
  .drawer::backdrop {
    background: rgb(8 12 18 / 0.6);
  }
  :global(html:has(dialog.drawer[open])) {
    overflow: hidden;
  }
  @media (prefers-reduced-motion: reduce) {
    .drawer {
      transition: none;
    }
  }
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    width: 19rem;
    overflow-y: auto;
    background: rgb(26 36 50 / 0.97);
    border-right: 1px solid var(--line);
  }
  @media (min-width: 1100px) {
    .bar.has-menu {
      margin-left: 19rem;
      padding-inline: max(1.5rem, calc((100% - 19rem - 57rem) / 2));
    }
    main.has-menu {
      margin-left: calc(19rem + max(0px, (100% - 19rem - 60rem) / 2));
      margin-right: auto;
    }
    .sidebar :global(.me) {
      padding-right: 1.25rem;
    }
  }
  .sheet {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 100%;
    box-sizing: border-box;
    padding: 1.1rem 0 1rem;
  }
  .close {
    position: absolute;
    top: 0.85rem;
    right: 0.85rem;
    margin: 0;
  }
  .sheet .version {
    margin: 0.75rem 0 0 1.75rem;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    text-decoration: none;
  }
  .logo {
    width: 3rem;
    height: 1.9rem;
    background: var(--orange);
    -webkit-mask: url('../../../media/zluggish.svg') center / contain no-repeat;
    mask: url('../../../media/zluggish.svg') center / contain no-repeat;
  }
  .wordmark {
    font-size: 1.125rem;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .version {
    padding: 0;
    border: 0;
    background: none;
    align-self: flex-start;
    cursor: pointer;
    color: var(--muted);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
    text-transform: none;
  }
  .version:hover {
    color: var(--text);
  }
  .about {
    width: min(23rem, calc(100vw - 2rem));
    box-sizing: border-box;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 1rem;
    background: #1a2432;
    color: var(--text);
    box-shadow: 0 16px 48px rgb(0 0 0 / 0.45);
  }
  .about::backdrop {
    background: rgb(8 12 18 / 0.6);
  }
  .about-content {
    padding: 1.5rem;
  }
  .about h2 {
    margin: 0 3rem 1.5rem 0;
    font-size: 1.15rem;
  }
  .about-close {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    margin: 0;
  }
  .about dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.75rem 1rem;
    margin-bottom: 1.5rem;
  }
  .about dt {
    color: var(--muted);
  }
  .about dd {
    margin: 0;
  }
  main {
    max-width: 57rem;
    margin: 0 auto;
    padding: 1.25rem 1.5rem 2rem;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  header h1 {
    margin: 0;
  }
  header.crumbed {
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
  }
  /* The way up stays quiet beside the heading: the back button's chevron, small, turning orange like it does. */
  .crumb {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    margin-left: -0.3rem;
    padding: 0.35rem 0.5rem 0.35rem 0.1rem;
    border-radius: 6px;
    color: var(--muted);
    font-size: 0.875rem;
    font-weight: 600;
    text-decoration: none;
  }
  .crumb::before {
    content: '';
    width: 1rem;
    height: 1rem;
    background: currentColor;
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M14.5 5.5 8 12l6.5 6.5' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
      center / contain no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M14.5 5.5 8 12l6.5 6.5' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
      center / contain no-repeat;
  }
  .crumb:hover {
    color: var(--text);
  }
  .crumb:hover::before {
    background: var(--orange);
  }
  /* A round outlined button like Zwift's header controls, holding a left chevron. */
  .bar .version {
    margin-left: auto;
  }
  .back {
    flex: none;
    position: relative;
    width: 2.5rem;
    height: 2.5rem;
    box-sizing: border-box;
    border: 2px solid rgb(255 255 255 / 0.7);
    border-radius: 50%;
  }
  .back::before {
    content: '';
    position: absolute;
    inset: 0;
    background: currentColor;
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M14.5 5.5 8 12l6.5 6.5' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
      center / 1.3rem no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M14.5 5.5 8 12l6.5 6.5' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
      center / 1.3rem no-repeat;
  }
  .back:hover {
    background: rgb(255 255 255 / 0.12);
    border-color: var(--orange);
  }
  @media (max-width: 500px) {
    .bar,
    .version:hover {
      color: var(--text);
    }
    .about {
      width: min(23rem, calc(100vw - 2rem));
      box-sizing: border-box;
      padding: 0;
      border: 1px solid var(--line);
      border-radius: 1rem;
      background: #1a2432;
      color: var(--text);
      box-shadow: 0 16px 48px rgb(0 0 0 / 0.45);
    }
    .about::backdrop {
      background: rgb(8 12 18 / 0.6);
    }
    .about-content {
      padding: 1.5rem;
    }
    .about h2 {
      margin: 0 3rem 1.5rem 0;
      font-size: 1.15rem;
    }
    .about-close {
      position: absolute;
      top: 0.75rem;
      right: 0.75rem;
      margin: 0;
    }
    .about dl {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.75rem 1rem;
      margin-bottom: 1.5rem;
    }
    .about dt {
      color: var(--muted);
    }
    .about dd {
      margin: 0;
    }
    main {
      padding-inline: 1rem;
    }
  }
</style>
