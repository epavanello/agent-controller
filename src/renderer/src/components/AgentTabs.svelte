<script lang="ts">
  import { AGENTS } from '@shared/contracts'
  import type { AgentId, AppSnapshot } from '@shared/contracts'
  import { displayState } from '$lib/session-view'

  let {
    snapshot,
    now,
    onselect
  }: {
    snapshot: AppSnapshot
    now: number
    onselect: (agent: AgentId) => void
  } = $props()

  const ORDER: { id: AgentId; hint: string }[] = [
    { id: 'claude', hint: 'L2' },
    { id: 'codex', hint: 'R2' }
  ]

  /** Per-tab counters, so the agent you are not looking at still reports. */
  const summaryOf = (
    agent: AgentId
  ): { total: number; working: number; waiting: number; questions: number } => {
    const sessions = snapshot.byAgent[agent].sessions
    let working = 0
    let waiting = 0
    let questions = 0
    for (const session of sessions) {
      const state = displayState(session, now)
      if (state === 'working') working += 1
      if (state === 'waiting') waiting += 1
      if (session.question) questions += 1
    }
    return { total: sessions.length, working, waiting, questions }
  }
</script>

<div role="tablist" aria-label="Agent" class="grid grid-cols-2 gap-3">
  {#each ORDER as tab (tab.id)}
    {@const meta = AGENTS[tab.id]}
    {@const active = snapshot.agent === tab.id}
    {@const summary = summaryOf(tab.id)}
    <button
      role="tab"
      type="button"
      aria-selected={active}
      class="group relative flex items-center gap-3 overflow-hidden rounded-xl border px-4 py-3 text-left transition-all
        {active
        ? 'border-transparent shadow-lg'
        : 'border-border bg-card/45 hover:-translate-y-0.5 hover:bg-card/70'}"
      style={active
        ? `border-color: ${meta.color}70; background: linear-gradient(115deg, ${meta.color}26, rgba(24, 28, 43, .94) 48%); box-shadow: inset 0 0 0 1px ${meta.color}55, 0 12px 36px -20px ${meta.color}`
        : ''}
      onclick={() => onselect(tab.id)}
    >
      {#if active}
        <span class="absolute inset-x-0 top-0 h-0.5" style="background: {meta.color}"></span>
      {/if}
      <span
        class="agent-orb h-9 w-9 shrink-0 rounded-full transition-all {active
          ? ''
          : 'opacity-40 grayscale'}"
        style="--agent-color: {meta.color}; background: {meta.color}; box-shadow: {active
          ? `0 0 22px ${meta.color}99`
          : 'none'}"
      ></span>
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="flex items-center gap-2">
          <span class="text-base font-semibold {active ? '' : 'text-muted-foreground'}">
            {meta.name}
          </span>
          <span
            class="rounded border bg-secondary px-1.5 py-px font-mono text-[10px] font-semibold text-muted-foreground"
          >
            {tab.hint}
          </span>
        </span>
        <span class="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
          <span>{summary.total} {summary.total === 1 ? 'session' : 'sessions'}</span>
          {#if summary.working > 0}
            <span class="text-emerald-400">● {summary.working} active</span>
          {/if}
          {#if summary.questions > 0}
            <span class="text-orange-400">
              ? {summary.questions}
              {summary.questions === 1 ? 'question' : 'questions'}
            </span>
          {:else if summary.waiting > 0}
            <span class="text-amber-400">◐ {summary.waiting} waiting</span>
          {/if}
        </span>
      </span>
    </button>
  {/each}
</div>
