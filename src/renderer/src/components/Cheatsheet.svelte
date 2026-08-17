<script lang="ts">
  const MAPPING: { button: string; action: string; accent?: string }[] = [
    { button: 'L2', action: 'Agente Claude', accent: 'text-orange-400' },
    { button: 'R2', action: 'Agente Codex', accent: 'text-sky-400' },
    { button: 'L1', action: 'Sessione precedente' },
    { button: 'R1', action: 'Sessione successiva' },
    { button: 'Mic', action: 'Tieni premuto: parla' },
    { button: 'Touchpad', action: 'Riscansiona' },
    { button: 'Share', action: 'Riannuncia' },
    { button: '←/→', action: 'Agente (tastiera)' },
    { button: '↑/↓', action: 'Sessione (tastiera)' }
  ]
</script>

<section class="rounded-xl border bg-card/40 p-3">
  <h2 class="mb-2 text-xs font-semibold tracking-wide uppercase">Comandi</h2>
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
