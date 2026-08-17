<script lang="ts">
  import { AGENTS } from '@shared/contracts'
  import type { AgentId, SessionInfo } from '@shared/contracts'
  import { preview, projectName, relativeTime, shortId, toneOf } from '$lib/session-view'

  let {
    agent,
    sessions,
    index,
    activeId,
    now,
    onselect,
    onstep
  }: {
    agent: AgentId
    sessions: SessionInfo[]
    index: number
    activeId: string | null
    now: number
    onselect: (id: string) => void
    onstep: (delta: -1 | 1) => void
  } = $props()

  const color = $derived(AGENTS[agent].color)

  let listElement = $state<HTMLDivElement | null>(null)

  // L1/R1 move the selection without touching the HUD, so the list has to
  // follow the controller and bring the selected row into view itself.
  $effect(() => {
    const id = activeId
    if (!id || !listElement) return
    const row = listElement.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  })
</script>

<section class="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card/40">
  <header class="flex items-center justify-between gap-2 border-b px-3 py-2">
    <div class="flex items-center gap-2">
      <h2 class="text-xs font-semibold tracking-wide uppercase">Sessioni</h2>
      <span class="text-[11px] text-muted-foreground">
        {sessions.length > 0 ? `${index + 1} di ${sessions.length}` : 'nessuna'}
      </span>
    </div>
    <div class="flex items-center gap-1">
      <button
        type="button"
        title="Sessione precedente (L1)"
        aria-label="Sessione precedente"
        class="rounded-md border bg-secondary px-2 py-1 font-mono text-[10px] font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
        disabled={index <= 0}
        onclick={() => onstep(-1)}
      >
        L1 ↑
      </button>
      <button
        type="button"
        title="Sessione successiva (R1)"
        aria-label="Sessione successiva"
        class="rounded-md border bg-secondary px-2 py-1 font-mono text-[10px] font-semibold text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
        disabled={index < 0 || index >= sessions.length - 1}
        onclick={() => onstep(1)}
      >
        R1 ↓
      </button>
    </div>
  </header>

  <div
    bind:this={listElement}
    role="tablist"
    aria-orientation="vertical"
    aria-label="Sessioni {AGENTS[agent].name}"
    class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2"
  >
    {#each sessions as session (session.id)}
      {@const selected = session.id === activeId}
      {@const tone = toneOf(session, now)}
      <button
        role="tab"
        type="button"
        data-session-id={session.id}
        aria-selected={selected}
        class="relative flex w-full flex-col gap-1 rounded-lg border py-2 pr-2 pl-3 text-left transition-colors
          {selected ? 'bg-foreground/[0.06]' : 'border-transparent hover:bg-foreground/[0.03]'}"
        style={selected
          ? `border-color: ${color}80; background-color: ${color}1f; box-shadow: inset 3px 0 0 0 ${color}`
          : ''}
        onclick={() => onselect(session.id)}
      >
        <div class="flex items-start gap-2">
          <span
            class="mt-1.5 h-2 w-2 shrink-0 rounded-full {tone.dot} {tone.pulsing
              ? 'animate-pulse'
              : ''}"
          ></span>
          <span
            class="line-clamp-2 flex-1 text-[13px] leading-snug {selected
              ? 'font-semibold'
              : 'font-medium text-foreground/80'}"
          >
            {session.title}
          </span>
          {#if selected}
            <span
              class="shrink-0 rounded px-1.5 py-px text-[9px] font-bold tracking-wider uppercase"
              style="background: {color}; color: #0d0f14"
            >
              Attiva
            </span>
          {/if}
        </div>

        {#if preview(session, 70)}
          <p class="line-clamp-1 pl-4 text-[11px] text-muted-foreground">
            {session.question ? '❓ ' : '↩ '}{preview(session, 70)}
          </p>
        {/if}

        <div class="flex flex-wrap items-center gap-1.5 pl-4 text-[10px] text-muted-foreground">
          <span class="rounded border px-1 py-px {tone.chip}">{tone.label}</span>
          <span>{relativeTime(session.updatedAt, now)}</span>
          {#if projectName(session.cwd)}
            <span class="truncate">· {projectName(session.cwd)}</span>
          {/if}
          <span class="ml-auto font-mono opacity-60">#{shortId(session.id)}</span>
        </div>
      </button>
    {:else}
      <p class="p-3 text-xs text-muted-foreground">
        Nessuna sessione {AGENTS[agent].name}. Avvia una sessione CLI e premi Riscansiona.
      </p>
    {/each}
  </div>
</section>
