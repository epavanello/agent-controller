<script lang="ts">
  import { onMount } from 'svelte'
  import ActiveSession from './components/ActiveSession.svelte'
  import AgentTabs from './components/AgentTabs.svelte'
  import Cheatsheet from './components/Cheatsheet.svelte'
  import ControllerPanel from './components/ControllerPanel.svelte'
  import SessionList from './components/SessionList.svelte'
  import { AGENTS } from '@shared/contracts'
  import type { AgentId, AppSnapshot } from '@shared/contracts'

  let snapshot = $state<AppSnapshot | null>(null)
  /** Ticks so relative times and the stale threshold stay honest between polls. */
  let now = $state(Date.now())

  const agent = $derived<AgentId>(snapshot?.agent ?? 'claude')
  const meta = $derived(AGENTS[agent])
  const current = $derived(snapshot?.byAgent[agent] ?? null)
  const sessions = $derived(current?.sessions ?? [])
  const activeSession = $derived(
    current && current.index >= 0 ? (current.sessions[current.index] ?? null) : null
  )

  const selectAgent = (value: AgentId): void => window.api.selectAgent(value)
  const selectSession = (delta: -1 | 1): void => window.api.selectSession(delta)
  const selectSessionId = (id: string): void => window.api.selectSessionId(agent, id)

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'ArrowUp') selectSession(-1)
    else if (event.key === 'ArrowDown') selectSession(1)
    else if (event.key === 'ArrowLeft') selectAgent('claude')
    else if (event.key === 'ArrowRight') selectAgent('codex')
    else return
    event.preventDefault()
  }

  onMount(() => {
    const unsubscribe = window.api.onSnapshot((value) => {
      snapshot = value
    })
    const clock = setInterval(() => (now = Date.now()), 15_000)
    void window.api.ensureMicPermission()
    return () => {
      unsubscribe()
      clearInterval(clock)
    }
  })
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-screen flex-col gap-3 bg-background p-4 text-sm">
  <header class="app-region-drag flex items-center justify-between gap-3 pt-2 pl-18">
    <div class="min-w-0">
      <h1 class="text-base leading-tight font-semibold tracking-tight">Agent Controller</h1>
      <p class="truncate text-[11px] text-muted-foreground">
        DualSense · {sessions.length}
        {sessions.length === 1 ? 'session' : 'sessions'}
        {meta.name}
      </p>
    </div>
    <div class="app-region-no-drag flex shrink-0 gap-2">
      <button
        type="button"
        class="rounded-md border bg-card px-2.5 py-1.5 text-xs transition-colors hover:bg-secondary"
        onclick={() => window.api.rescan()}
      >
        Rescan
      </button>
      <button
        type="button"
        class="rounded-md border bg-card px-2.5 py-1.5 text-xs transition-colors hover:bg-secondary"
        onclick={() => window.api.reannounce()}
      >
        Announce
      </button>
      <button
        type="button"
        class="rounded-md border px-2.5 py-1.5 text-xs transition-colors {snapshot?.recording
          ? 'border-red-500/50 bg-red-500/20 text-red-300'
          : 'bg-card hover:bg-secondary'}"
        onclick={() => window.api.toggleRecording()}
      >
        {snapshot?.recording ? '■ Stop mic' : '● Mic'}
      </button>
    </div>
  </header>

  {#if snapshot}
    <AgentTabs {snapshot} {now} onselect={selectAgent} />

    <main class="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(300px,360px)_1fr]">
      <SessionList
        {agent}
        {sessions}
        {now}
        index={current?.index ?? -1}
        activeId={current?.activeSessionId ?? null}
        onselect={selectSessionId}
        onstep={selectSession}
      />

      <div class="flex min-h-0 flex-col gap-3">
        <!-- Pinned: the selected session must never scroll out of sight. -->
        <ActiveSession
          {agent}
          {now}
          session={activeSession}
          position={current?.index ?? -1}
          total={sessions.length}
          announcing={snapshot.announcing}
        />

        <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          {#if snapshot.recording || snapshot.lastError || snapshot.lastTranscription}
            <section class="flex flex-col gap-2 rounded-xl border bg-card/40 p-3 text-xs">
              {#if snapshot.recording}
                <p class="font-medium text-red-400">
                  ● Recording from the controller mic — release to send
                </p>
              {/if}
              {#if snapshot.lastTranscription}
                <p class="line-clamp-2">
                  <span class="text-muted-foreground">Last speech sent: </span>
                  {snapshot.lastTranscription}
                </p>
              {/if}
              {#if snapshot.lastError}
                <p
                  class="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-destructive"
                >
                  {snapshot.lastError}
                </p>
              {/if}
            </section>
          {/if}

          <ControllerPanel {snapshot} />
          <Cheatsheet />
        </div>
      </div>
    </main>
  {:else}
    <div class="flex flex-1 items-center justify-center text-xs text-muted-foreground">
      Starting the orchestrator…
    </div>
  {/if}
</div>
