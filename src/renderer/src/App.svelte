<script lang="ts">
  import { onMount } from 'svelte'
  import Badge from '$lib/components/ui/badge/badge.svelte'
  import Button from '$lib/components/ui/button/button.svelte'
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle
  } from '$lib/components/ui/card/index.js'
  import Separator from '$lib/components/ui/separator/separator.svelte'
  import { AGENTS } from '@shared/contracts'
  import type { AgentId, AppSnapshot } from '@shared/contracts'

  let snapshot = $state<AppSnapshot | null>(null)

  const stateLabel: Record<'working' | 'waiting' | 'offline' | 'unknown', string> = {
    working: 'Lavorando',
    waiting: 'In attesa',
    offline: 'Offline',
    unknown: 'Sconosciuto'
  }

  const stateTone = (state: 'working' | 'waiting' | 'offline' | 'unknown' | null): string => {
    if (state === 'working') return 'default'
    if (state === 'waiting') return 'outline'
    return 'secondary'
  }

  const surfaceLabel = {
    terminal: 'Terminale',
    vscode: 'VS Code',
    desktop: 'Desktop',
    unknown: 'Sconosciuta'
  } as const

  const agent = $derived(
    snapshot ? AGENTS[snapshot.agent] : { id: 'claude' as AgentId, name: '—', color: '#f97316' }
  )
  const activeSession = $derived(
    snapshot && snapshot.sessionIndex >= 0 ? snapshot.sessions[snapshot.sessionIndex] : null
  )

  const questions = $derived.by(
    () => snapshot?.sessions.filter((session) => session.question != null) ?? []
  )

  const controllerConnected = $derived(snapshot?.controller.connected ?? false)
  const isUsb = $derived(snapshot?.controller.transport === 'USB')
  const audioReady = $derived(
    (snapshot?.audio.speaker.available ?? false) && (snapshot?.audio.microphone.available ?? false)
  )

  onMount(() => {
    const unsubscribe = window.api.onSnapshot((value) => {
      snapshot = value
    })
    void window.api.ensureMicPermission()
    return unsubscribe
  })
</script>

<div class="min-h-screen bg-background p-6 text-sm">
  <header class="app-region-drag mb-5 flex items-baseline justify-between pl-2">
    <div>
      <h1 class="text-lg font-semibold tracking-tight">Agent Controller</h1>
      <p class="text-xs text-muted-foreground">Orchestratore DualSense per Claude e Codex</p>
    </div>
    <div class="app-region-no-drag flex gap-2">
      <Button variant="outline" size="sm" onclick={() => window.api.rescan()}>Riscansiona</Button>
      <Button variant="outline" size="sm" onclick={() => window.api.reannounce()}>
        Riannuncia
      </Button>
      <Button
        variant={snapshot?.recording ? 'default' : 'outline'}
        size="sm"
        onclick={() => window.api.toggleRecording()}
      >
        {snapshot?.recording ? '■ Stop mic' : '● Mic'}
      </Button>
    </div>
  </header>

  <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
    <div class="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Agente</CardTitle>
          <CardDescription>Selezionato con L2 / R2</CardDescription>
        </CardHeader>
        <CardContent class="flex items-center gap-4">
          <div
            class="h-14 w-14 rounded-full"
            style="background: {agent.color}; box-shadow: 0 0 24px {agent.color}"
          ></div>
          <div class="flex flex-col gap-1">
            <div class="flex items-center gap-2">
              <span class="text-2xl font-bold">{agent.name}</span>
              {#if snapshot?.agent === 'claude'}
                <Badge class="border-orange-500/40 bg-orange-500/15 text-orange-400">L2</Badge>
              {:else}
                <Badge class="border-sky-500/40 bg-sky-500/15 text-sky-400">R2</Badge>
              {/if}
            </div>
            <span class="text-xs text-muted-foreground">
              Luce controller: {agent.color} · pulsa mentre lavora
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sessione attiva</CardTitle>
          <CardDescription
            >L1 / R1 per cambiare · {activeSession
              ? `${snapshot!.sessionIndex + 1} di ${snapshot!.sessions.length}`
              : 'nessuna'}</CardDescription
          >
        </CardHeader>
        <CardContent class="flex flex-col gap-3">
          {#if activeSession}
            <div class="flex items-center justify-between gap-2">
              <span class="line-clamp-2 font-medium">{activeSession.title}</span>
              <Badge variant={stateTone(activeSession.state)}
                >{stateLabel[activeSession.state]}</Badge
              >
            </div>
            <div class="flex flex-col gap-1 text-xs text-muted-foreground">
              <span class="line-clamp-1">id: {activeSession.id}</span>
              <span>superficie: {surfaceLabel[activeSession.surface]}</span>
              {#if activeSession.cwd}
                <span class="line-clamp-1">cwd: {activeSession.cwd}</span>
              {/if}
            </div>
            {#if activeSession.question}
              <Separator />
              <div class="rounded-lg border border-orange-500/30 bg-orange-500/10 p-2 text-xs">
                <span class="font-semibold text-orange-400">Domanda aperta · </span>
                <span class="line-clamp-3">{activeSession.question}</span>
              </div>
            {/if}
          {:else}
            <p class="text-xs text-muted-foreground">
              Nessuna sessione {agent.name} trovata. Avvia una sessione CLI (<code>claude</code> o
              <code>codex</code>) e premi Riscansiona.
            </p>
          {/if}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Attività</CardTitle>
          <CardDescription>Feedback del controller</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-2 text-xs">
          {#if snapshot?.recording}
            <div
              class="rounded-lg border border-red-500/40 bg-red-500/10 p-2 font-medium text-red-400"
            >
              ● In registrazione dal mic del controller — rilascia per inviare
            </div>
          {/if}
          {#if snapshot?.announcing}
            <div
              class="rounded-lg border border-sky-500/40 bg-sky-500/10 p-2 font-medium text-sky-400"
            >
              🔊 Annuncio in cassa…
            </div>
          {/if}
          {#if snapshot?.lastTranscription}
            <div>
              <span class="text-muted-foreground">Ultimo parlato inviato: </span>
              <span class="line-clamp-2">{snapshot.lastTranscription}</span>
            </div>
          {/if}
          {#if snapshot?.lastAnnouncement}
            <div>
              <span class="text-muted-foreground">Ultimo annuncio: </span>
              <span class="line-clamp-2">{snapshot.lastAnnouncement}</span>
            </div>
          {/if}
          {#if snapshot?.lastError}
            <div
              class="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-destructive"
            >
              {snapshot.lastError}
            </div>
          {/if}
        </CardContent>
      </Card>
    </div>

    <div class="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Controller</CardTitle>
          <CardDescription>Cosa vede il controller in questo momento</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-2">
          <div class="flex flex-wrap gap-2">
            <Badge variant={controllerConnected ? 'default' : 'secondary'}>
              {controllerConnected ? 'Connesso' : 'Disconnesso'}
            </Badge>
            {#if controllerConnected}
              <Badge variant={isUsb ? 'default' : 'secondary'}
                >{snapshot!.controller.transport}</Badge
              >
              {#if snapshot!.controller.batteryLevel != null}
                <Badge variant="secondary">
                  Batteria {Math.round(snapshot!.controller.batteryLevel * 100)}%
                </Badge>
              {/if}
            {/if}
          </div>
          <Separator />
          <div class="flex flex-col gap-2">
            {@render CapabilityRow({
              label: 'Cassa (annunci)',
              ok: snapshot?.audio.speaker.available ?? false,
              detail: snapshot?.audio.speaker.reason ?? ''
            })}
            {@render CapabilityRow({
              label: 'Microfono (parla alla sessione)',
              ok: snapshot?.audio.microphone.available ?? false,
              detail: snapshot?.audio.microphone.reason ?? ''
            })}
            {@render CapabilityRow({
              label: 'Luce',
              ok: snapshot?.controller.supportsLight ?? false,
              detail: snapshot?.controller.supportsLight ? 'Disponibile' : 'Non disponibile'
            })}
            {@render CapabilityRow({
              label: 'Vibrazione',
              ok: snapshot?.controller.supportsHaptics ?? false,
              detail: snapshot?.controller.supportsHaptics ? 'Disponibile' : 'Non disponibile'
            })}
            {@render CapabilityRow({
              label: 'Bridge nativo',
              ok: snapshot?.bridgeAvailable ?? false,
              detail: snapshot?.bridgeAvailable ? 'Swift helper attivo' : 'Helper non in esecuzione'
            })}
          </div>
          {#if controllerConnected && !isUsb && audioReady === false}
            <p class="mt-1 text-xs text-muted-foreground">
              In Bluetooth cassa e microfono del controller non sono disponibili: collega il cavo
              USB per gli annunci e la voce.
            </p>
          {/if}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Domande aperte</CardTitle>
          <CardDescription>Sessione che aspetta un tuo input</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-2 text-xs">
          {#if questions.length > 0}
            {#each questions as session (session.id)}
              <div class="rounded-lg border border-orange-500/30 bg-orange-500/10 p-2">
                <span class="font-semibold text-orange-400"
                  >{AGENTS[snapshot!.agent].name} · {session.title}</span
                >
                <p class="mt-1 line-clamp-3 text-muted-foreground">{session.question}</p>
              </div>
            {/each}
          {:else}
            <p class="text-muted-foreground">Nessuna domanda in sospeso.</p>
          {/if}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cheatsheet</CardTitle>
          <CardDescription>Mapping fisso, nessuna configurazione</CardDescription>
        </CardHeader>
        <CardContent>
          <div class="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
            {@render MappingRow({
              button: 'L2',
              action: 'Agente Claude',
              accent: 'text-orange-400'
            })}
            {@render MappingRow({ button: 'R2', action: 'Agente Codex', accent: 'text-sky-400' })}
            {@render MappingRow({ button: 'L1', action: 'Sessione precedente' })}
            {@render MappingRow({ button: 'R1', action: 'Sessione successiva' })}
            {@render MappingRow({ button: 'Mic', action: 'Tieni premuto: parla alla sessione' })}
            {@render MappingRow({ button: 'Touchpad', action: 'Riscansiona sessioni' })}
            {@render MappingRow({ button: 'Share', action: 'Riannuncia agente e sessione' })}
            {@render MappingRow({ button: 'Luce', action: 'Colore agente · pulse = lavorando' })}
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</div>

{#snippet CapabilityRow(props: { label: string; ok: boolean; detail: string })}
  <div class="flex items-start justify-between gap-4">
    <span class="text-muted-foreground">{props.label}</span>
    <span class="flex items-center gap-2 text-right">
      <span class="text-muted-foreground">{props.detail}</span>
      <span class="h-2.5 w-2.5 shrink-0 rounded-full {props.ok ? 'bg-emerald-500' : 'bg-red-500'}"
      ></span>
    </span>
  </div>
{/snippet}

{#snippet MappingRow(props: { button: string; action: string; accent?: string })}
  <div class="flex items-center gap-2">
    <span
      class="w-16 shrink-0 rounded-md border bg-secondary px-2 py-1 text-center font-mono text-[11px] font-semibold"
      >{props.button}</span
    >
    <span class="text-muted-foreground {props.accent ?? ''}">{props.action}</span>
  </div>
{/snippet}
