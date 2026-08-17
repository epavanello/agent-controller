import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, systemPreferences } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { AgentIdSchema, SelectSessionRequestSchema } from '../shared/contracts'
import type { AppSnapshot } from '../shared/contracts'
import { NativeBridge } from './nativeBridge'
import { Orchestrator } from './orchestrator'
import { SessionStore } from './sessions'
import { Speaker } from './speaker'

// Device-access switches must be registered before Electron becomes ready.
app.commandLine.appendSwitch('disable-hid-blocklist')
app.setName('Agent Controller')

const hasSingleInstanceLock = app.requestSingleInstanceLock()

let mainWindow: BrowserWindow | null = null

const nativeBridge = new NativeBridge()
const sessionStore = new SessionStore()
const speaker = new Speaker(nativeBridge, () => orchestrator?.publishSnapshot())
let orchestrator: Orchestrator | null = null

const createWindow = (): void => {
  const window = new BrowserWindow({
    width: 1060,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#0d0f14',
    title: 'Agent Controller',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow = window
  window.on('ready-to-show', () => window.show())
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  // Renderer diagnostics land in the main-process console: the window is a
  // black box otherwise.
  window.webContents.on('console-message', (event) => {
    console.log(`[renderer] ${event.message} (${event.sourceId ?? '?'}:${event.lineNumber})`)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer] process gone: ${details.reason}`)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const publishSnapshot = (snapshot: AppSnapshot): void => {
  mainWindow?.webContents.send('app:snapshot', snapshot)
}

const registerIpc = (): void => {
  ipcMain.on('app:select-agent', (_event, value: unknown) => {
    const parsed = AgentIdSchema.safeParse(value)
    if (parsed.success) orchestrator?.selectAgent(parsed.data)
  })
  ipcMain.on('app:select-session', (_event, delta: unknown) => {
    if (delta === 1 || delta === -1) orchestrator?.selectSession(delta)
  })
  ipcMain.on('app:select-session-id', (_event, value: unknown) => {
    const parsed = SelectSessionRequestSchema.safeParse(value)
    if (parsed.success) orchestrator?.selectSessionById(parsed.data.agent, parsed.data.id)
  })
  ipcMain.on('app:toggle-recording', () => orchestrator?.toggleRecording())
  ipcMain.on('app:rescan', () => orchestrator?.rescan())
  ipcMain.on('app:reannounce', () => orchestrator?.reannounce())
  ipcMain.handle('app:ensure-mic-permission', async (): Promise<boolean> => {
    return systemPreferences.askForMediaAccess('microphone')
  })
}

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    } else {
      createWindow()
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.agentcontroller.app')
    nativeTheme.themeSource = 'dark'
    Menu.setApplicationMenu(null)

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    registerIpc()
    createWindow()

    orchestrator = new Orchestrator(nativeBridge, sessionStore, speaker, publishSnapshot)
    orchestrator.start()
    void nativeBridge.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  orchestrator?.stop()
  nativeBridge.stop()
})
