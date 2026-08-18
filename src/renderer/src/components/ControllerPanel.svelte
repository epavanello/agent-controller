<script lang="ts">
  import { onMount } from 'svelte'
  import type { AppSnapshot, SpeechLanguage } from '@shared/contracts'

  let { snapshot }: { snapshot: AppSnapshot } = $props()

  const connected = $derived(snapshot.controller.connected)
  const isUsb = $derived(snapshot.controller.transport === 'USB')

  /** Only the languages this Mac has a voice for; read once, they never change. */
  let languages = $state<SpeechLanguage[]>([])
  // A language set by hand in config.json may not be in the list: keep it
  // selectable rather than silently showing a different one.
  const options = $derived(
    languages.some((language) => language.tag === snapshot.speechLanguage)
      ? languages
      : [{ tag: snapshot.speechLanguage, label: snapshot.speechLanguage }, ...languages]
  )

  onMount(async () => {
    languages = await window.api.speechLanguages()
  })

  const pick = (event: Event & { currentTarget: HTMLSelectElement }): void => {
    void window.api.setSpeechLanguage(event.currentTarget.value)
  }
</script>

<section class="flex flex-col gap-2 rounded-xl border bg-card/40 p-3 text-xs">
  <div class="flex items-center justify-between gap-2">
    <h2 class="text-xs font-semibold tracking-wide uppercase">Controller</h2>
    <div class="flex items-center gap-1.5 text-[11px]">
      <span
        class="h-2 w-2 rounded-full {connected ? 'bg-emerald-500' : 'bg-red-500'}"
        aria-hidden="true"
      ></span>
      <span class="text-muted-foreground">
        {connected ? snapshot.controller.transport : 'Disconnected'}
      </span>
      {#if connected && snapshot.controller.batteryLevel != null}
        <span class="text-muted-foreground">
          · {Math.round(snapshot.controller.batteryLevel * 100)}%
        </span>
      {/if}
    </div>
  </div>

  <div class="grid grid-cols-2 gap-x-4 gap-y-1">
    {@render Capability('Speaker', snapshot.audio.speaker.available, snapshot.audio.speaker.reason)}
    {@render Capability(
      'Microphone',
      snapshot.audio.microphone.available,
      snapshot.audio.microphone.reason
    )}
    {@render Capability('Light', snapshot.controller.supportsLight, '')}
    {@render Capability('Haptics', snapshot.controller.supportsHaptics, '')}
    {@render Capability(
      'Native bridge',
      snapshot.bridgeAvailable,
      snapshot.bridgeAvailable ? '' : 'Helper not running'
    )}
  </div>

  {#if connected && !isUsb}
    <p class="text-[11px] text-muted-foreground">
      Over Bluetooth the speaker and mic are unavailable: plug in USB for announcements and voice.
    </p>
  {/if}

  <label class="flex items-center gap-2 border-t pt-2 text-[11px]">
    <span class="shrink-0 text-muted-foreground" title="Announcements and dictation">
      Voice language
    </span>
    <select
      class="min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 text-[11px] text-foreground"
      value={snapshot.speechLanguage}
      onchange={pick}
    >
      {#each options as language (language.tag)}
        <option value={language.tag}>{language.label}</option>
      {/each}
    </select>
  </label>
</section>

{#snippet Capability(label: string, ok: boolean, reason: string)}
  <div class="flex items-center gap-1.5" title={reason}>
    <span class="h-1.5 w-1.5 shrink-0 rounded-full {ok ? 'bg-emerald-500' : 'bg-red-500'}"></span>
    <span class="truncate {ok ? 'text-muted-foreground' : 'text-muted-foreground/60'}">
      {label}
    </span>
  </div>
{/snippet}
