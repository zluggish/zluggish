<script lang="ts">
  import { t } from '../lib/i18n/shared';
  import { untrack } from 'svelte';
  import { requestJson } from '../lib/connection';
  import type { Snippet } from 'svelte';
  import { decode } from '../lib/api';
  import { savedFormResult } from '../lib/game-app';
  import type { GameForm, GamePageModel } from '../lib/game-app.dto';
  import { safeNavigation, validation, values, visible } from '../lib/forms.js';
  import UserRow from './UserRow.svelte';

  let {
    model,
    csrf,
    locked,
    onpage,
    onchange,
    onexpire,
    onfail,
    actions,
  }: {
    model: GameForm;
    csrf: string;
    locked: boolean;
    onpage: (page: GamePageModel) => void;
    onchange?: ((name: string, value: string) => void) | undefined;
    onexpire: () => void;
    onfail?: ((message: string) => void) | undefined;
    actions?: Snippet;
  } = $props();

  let draft = $state(untrack(() => values(model)));
  let baseline = $state(untrack(() => values(model)));
  let touched = $state<Record<string, boolean>>({});
  let submitted = $state(false);
  let pending = $state(false);
  let message = $state('');
  let serverErrors = $state<Record<string, Array<string>>>({});
  let failed = $state(false);
  let form: HTMLFormElement;
  let controller: AbortController | undefined;
  let alive = true;
  const dirty = $derived(JSON.stringify(draft) !== JSON.stringify(baseline));
  const errors = $derived({ ...validation(model, draft), ...serverErrors });

  const formState = $derived(
    pending ? 'submitting' : failed ? 'error' : message ? 'success' : dirty ? 'dirty' : 'idle',
  );

  $effect(() => {
    const leave = () => {
      alive = false;
      controller?.abort();
      clearSecrets();
    };

    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) {
        location.reload();
      }
    };

    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', restore);

    return () => {
      leave();
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', restore);
    };
  });

  $effect(() => {
    if (locked) {
      untrack(() => {
        controller?.abort();
        draft = values(model);
        clearSecrets();
      });
    }
  });

  function clearSecrets() {
    for (const field of model.fields) {
      if (field.type === 'password') {
        draft[field.name] = '';
      }
    }
  }

  function fail(text: string) {
    failed = true;
    message = text;
    onfail?.(text);
  }

  function clearMessage() {
    failed = false;
    message = '';
  }

  function focusError() {
    const first =
      form.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      form.querySelector<HTMLElement>('input:not([type=hidden]), select');

    first?.focus();
  }

  async function submit(event: SubmitEvent) {
    if (pending || locked) {
      event.preventDefault();

      return;
    }

    // Native navigation is required for the Zwift protocol handoff.
    if (model.navigation) {
      pending = true;

      return;
    }

    event.preventDefault();
    const button = event.submitter instanceof HTMLButtonElement ? event.submitter : null;
    const skip = button?.formNoValidate ?? false;
    submitted = true;
    serverErrors = {};

    if (!skip && Object.keys(errors).length) {
      fail(t('form_fields_hint'));
      queueMicrotask(focusError);

      return;
    }

    const body = new FormData(form);

    if (button?.name) {
      body.set(button.name, button.value);
    }
    pending = true;
    failed = false;
    message = t('submitting');
    controller = new AbortController();

    try {
      const { response, body: resultBody } = await requestJson(form.action, {
        method: 'POST',
        body,
        credentials: 'same-origin',
        redirect: 'error',
        headers: { Accept: 'application/json', 'X-Game-Context': csrf },
        signal: controller.signal,
      });

      const result = decode(savedFormResult, resultBody);

      if (!alive || controller.signal.aborted || locked) {
        return;
      }

      if (!result.ok) {
        fail(result.message);
        serverErrors = result.fieldErrors ?? {};

        if (result.reload || response.status === 401) {
          clearSecrets();
          onexpire();
        }

        queueMicrotask(focusError);

        return;
      }

      clearSecrets();

      if ('confirm_action' in draft) {
        draft.confirm_action = false;
      }

      if (result.redirectTo) {
        if (!safeNavigation(result.redirectTo)) {
          throw new Error(t('unsafe_navigation'));
        }

        if (['/login/', '/riders/switch/'].includes(model.action)) {
          const channel = 'BroadcastChannel' in window ? new BroadcastChannel('zluggish-session-change') : undefined;
          channel?.postMessage('changed');
          channel?.close();
        }

        location.assign(result.redirectTo);

        return;
      }

      const saved = result.data.page?.forms.find((item) => item.id === model.id);

      if (saved) {
        draft = values(saved);
        baseline = values(saved);
      } else {
        baseline = { ...draft };
      }

      if (result.data.page) {
        onpage(result.data.page);
      }
      message = result.message ?? t('saved');
      touched = {};
      submitted = false;
    } catch {
      if (alive && !controller.signal.aborted) {
        fail(t('form_submit_error'));
      }
    } finally {
      if (alive) {
        pending = false;
      }
    }
  }
</script>

<form
  id={`game-form-${model.id}`}
  bind:this={form}
  method="post"
  action={model.action}
  onsubmit={submit}
  data-state={formState}
  novalidate
>
  {#if model.title}<h2>{model.title}</h2>{/if}
  <input type="hidden" name="csrf_token" value={csrf} />
  {#if failed && !onfail}<p class="error" role="alert">{message}</p>{/if}
  <fieldset disabled={(pending && !model.navigation) || locked}>
    {#each model.fields as field (field.name)}
      {@const id = `${model.id}-${field.name.replaceAll('.', '-')}`}
      {@const error = touched[field.name] || submitted ? errors[field.name]?.join(' ') : undefined}
      {#if field.type === 'hidden'}
        <input type="hidden" name={field.name} value={String(draft[field.name] ?? '')} />
      {:else}
        <div hidden={!visible(field, draft)}>
          <label for={id}>{field.label}</label>
          {#if field.type === 'select'}
            <select
              name={field.name}
              {id}
              bind:value={draft[field.name]}
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-error` : undefined}
              onblur={() => (touched[field.name] = true)}
              onchange={() => {
                serverErrors = {};
                clearMessage();
                onchange?.(field.name, String(draft[field.name]));
              }}
            >
              {#each field.options ?? [] as option (option.value)}<option value={option.value}>{option.label}</option
                >{/each}
            </select>
          {:else if field.type === 'checkbox'}
            <input
              type="checkbox"
              {id}
              name={field.name}
              bind:checked={() => Boolean(draft[field.name]), (value) => (draft[field.name] = value)}
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-error` : undefined}
              onchange={() => {
                touched[field.name] = true;
                serverErrors = {};
                clearMessage();
              }}
            />
          {:else}
            <!-- svelte-ignore a11y_autofocus (only set on single-field steps such as the user password) -->
            <input
              type={field.type ?? 'text'}
              {id}
              name={field.name}
              bind:value={draft[field.name]}
              placeholder={field.placeholder}
              required={field.required && visible(field, draft)}
              maxlength={field.maxLength}
              pattern={field.pattern}
              autocomplete={field.autocomplete}
              autofocus={field.autofocus}
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-error` : undefined}
              onblur={() => (touched[field.name] = true)}
              oninput={() => {
                delete serverErrors[field.name];
                clearMessage();
              }}
            />
          {/if}
          {#if error}<p id={`${id}-error`} class="error">{error}</p>{/if}
        </div>
      {/if}
    {/each}
    {#each model.buttons as button (button.label)}
      <button
        type="submit"
        class:primary={model.primary}
        name={button.name}
        value={button.value}
        formnovalidate={button.skipValidation}
        >{#if model.user}<UserRow
            initials={model.user.initials}
            photo={model.user.photo}
            name={pending ? 'Submitting…' : button.label}
            detail={model.user.email}
            workout={model.user.workout ?? null}
          />{:else}{pending ? t('submitting') : button.label}{/if}</button
      >
    {/each}
    {@render actions?.()}
  </fieldset>
  <p aria-live="polite">{failed ? '' : message || (dirty && !model.transient ? t('unsaved_changes') : '')}</p>
</form>

<style>
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
</style>
