<script lang="ts">
  import { AGENTS, announceSessionText } from '@shared/contracts'
  import type { AgentId, SessionInfo } from '@shared/contracts'
  import { projectName, relativeTime, shortId, SURFACE_LABELS, toneOf } from '$lib/session-view'

  let {
    agent,
    session,
    now,
    position,
    total,
    announcing
  }: {
    agent: AgentId
    session: SessionInfo | null
    now: number
    position: number
    total: number
    announcing: boolean
  } = $props()

  const meta = $derived(AGENTS[agent])
  const tone = $derived(session ? toneOf(session, now) : null)
  // The exact sentence the speaker pronounces for this session, built by the
  // same shared helper the orchestrator calls.
  const spoken = $derived(session ? announceSessionText(agent, session, now) : null)
</script>

<section
  class="hero-panel flex flex-col gap-3 rounded-xl border p-4"
  style="--agent-color: {meta.color}; border-color: {meta.color}55; box-shadow: 0 18px 55px -34px {meta.color}"
>
  <div class="flex items-center justify-between gap-2">
    <span class="flex items-center gap-2 text-xs font-semibold tracking-wide uppercase">
      <span class="h-2.5 w-2.5 rounded-full" style="background: {meta.color}"></span>
      Selected session
    </span>
    <span class="text-[11px] text-muted-foreground">
      {total > 0 ? `${position + 1} / ${total}` : '—'} · L1 / R1
    </span>
  </div>

  {#if session && tone}
    <div class="flex items-start gap-3">
      <span
        class="mt-1.5 h-3 w-3 shrink-0 rounded-full {tone.dot} {tone.pulsing
          ? 'animate-pulse'
          : ''}"
      ></span>
      <h2 class="flex-1 text-[22px] leading-tight font-bold tracking-tight">{session.title}</h2>
    </div>

    <div class="flex flex-wrap items-center gap-2 text-[11px]">
      <span class="rounded-full border px-2 py-0.5 font-medium {tone.chip}">{tone.label}</span>
      <span class="rounded-full border bg-secondary px-2 py-0.5 text-muted-foreground">
        {SURFACE_LABELS[session.surface]}
      </span>
      {#if session.live}
        <span
          class="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-emerald-300"
        >
          live
        </span>
      {/if}
      <span class="text-muted-foreground">
        updated {relativeTime(session.updatedAt, now)}
      </span>
      <span class="ml-auto font-mono text-muted-foreground opacity-70">
        #{shortId(session.id)}
      </span>
    </div>

    <!-- What the controller speaker says for this exact row. -->
    <div
      class="flex items-start gap-2 rounded-lg border bg-background/60 px-3 py-2 text-xs {announcing
        ? 'border-sky-500/50'
        : ''}"
    >
      <span class="{announcing ? 'animate-pulse' : 'opacity-60'} shrink-0">🔊</span>
      <span class="italic text-muted-foreground">"{spoken}"</span>
    </div>

    {#if session.question}
      <div class="rounded-lg border border-orange-500/40 bg-orange-500/10 p-3 text-xs">
        <p class="mb-1 font-semibold text-orange-400">Open question</p>
        <p class="line-clamp-4 leading-relaxed">{session.question}</p>
      </div>
    {:else if session.lastMessage}
      <div class="rounded-lg border bg-background/40 p-3 text-xs">
        <p class="mb-1 font-semibold text-muted-foreground">Last message</p>
        <p class="line-clamp-4 leading-relaxed">{session.lastMessage}</p>
      </div>
    {:else}
      <p class="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        No closing message recorded.
      </p>
    {/if}

    {#if session.cwd}
      <p class="truncate text-[11px] text-muted-foreground">
        <span class="font-medium text-foreground/70">{projectName(session.cwd)}</span>
        · {session.cwd}
      </p>
    {/if}
  {:else}
    <p class="py-6 text-center text-xs text-muted-foreground">
      No {meta.name} session selected.
    </p>
  {/if}
</section>
