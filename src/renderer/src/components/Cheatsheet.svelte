<script lang="ts">
  const MAPPING: { button: string; action: string; accent?: string }[] = [
    { button: 'L2', action: 'Claude agent', accent: 'text-orange-400' },
    { button: 'R2', action: 'Codex agent', accent: 'text-sky-400' },
    { button: 'L1', action: 'Previous session' },
    { button: 'R1', action: 'Next session' },
    { button: 'Mic', action: 'Hold to talk' },
    { button: 'Touchpad', action: 'Rescan' },
    { button: 'Share', action: 'Announce again' },
    { button: '←/→', action: 'Agent (keyboard)' },
    { button: '↑/↓', action: 'Session (keyboard)' }
  ]
</script>

<section class="rounded-xl border bg-card/40 p-3">
  <h2 class="mb-2 text-xs font-semibold tracking-wide uppercase">Controls</h2>
  <div class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
    {#each MAPPING as row (row.button)}
      <div class="flex items-center gap-2">
        <span
          class="w-14 shrink-0 rounded border bg-secondary px-1 py-0.5 text-center font-mono text-[10px] font-semibold"
        >
          {row.button}
        </span>
        <span class="truncate text-muted-foreground {row.accent ?? ''}">{row.action}</span>
      </div>
    {/each}
  </div>
</section>
