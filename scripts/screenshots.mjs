#!/usr/bin/env node
/**
 * Capture clean staged screenshots of MarshallCam for docs/screenshots/.
 *
 * Starts a local throwaway LiveKit dev server (native binary or Docker),
 * a local mock Roku ECP responder, and the MarshallCam server with fake
 * demo credentials, then drives Chromium via Playwright using fake media
 * devices so video tiles display test patterns instead of black frames.
 *
 * Usage:
 *   npm run build
 *   node scripts/screenshots.mjs
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots')

const DEMO_PORT = Number.parseInt(process.env.SCREENSHOT_PORT || '3000', 10)
const LIVEKIT_PORT = Number.parseInt(process.env.SCREENSHOT_LIVEKIT_PORT || '7880', 10)
const DEMO_PIN = '1234'
const DEMO_ADMIN_PASSWORD = 'demo-admin-password'
const DEMO_LIVEKIT_KEY = 'devkey'
const DEMO_LIVEKIT_SECRET = 'demo-secret-000000000000000000000000'
const VIEWPORT = { width: 1280, height: 720 }

function log(msg) {
  console.log(`[screenshots] ${msg}`)
}

function commandExists(cmd) {
  const res = spawnSync('which', [cmd], { stdio: 'ignore' })
  return res.status === 0
}

async function loadPlaywright() {
  const candidates = []
  if (process.env.PLAYWRIGHT_PATH) {
    candidates.push(process.env.PLAYWRIGHT_PATH)
  }
  const home = os.homedir()
  candidates.push(
    path.join(home, '.local/share/mise/installs/npm-playwright/latest/node_modules/playwright/index.mjs'),
    path.join(home, '.local/share/mise/installs/npm-playwright/latest/node_modules/playwright/index.js'),
  )

  try {
    return await import('playwright')
  } catch {
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const mod = await import(pathToFileURL(candidate).href)
        return mod.default ?? mod
      }
    }
  }
  throw new Error(
    'Playwright not found. Install playwright or set PLAYWRIGHT_PATH to its entry module.',
  )
}

function resolveChromiumPath(chromium) {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH
  }
  try {
    const bundled = chromium.executablePath()
    if (bundled && fs.existsSync(bundled)) return bundled
  } catch {
    /* ignore */
  }
  for (const bin of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (fs.existsSync(bin)) return bin
  }
  return undefined
}

async function waitForHttp(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (res.status < 500) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function startMockEcpServer() {
  return new Promise((resolve, reject) => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<device-info>',
      '  <power-mode>PowerOn</power-mode>',
      '  <model-name>Living Room Demo TV</model-name>',
      '  <software-version>14.0.0</software-version>',
      '</device-info>',
    ].join('\n')

    const server = http.createServer((req, res) => {
      if (req.url === '/query/device-info') {
        res.writeHead(200, { 'Content-Type': 'application/xml' })
        res.end(xml)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK')
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : 0,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

async function ensureLiveKit() {
  const healthUrl = `http://127.0.0.1:${LIVEKIT_PORT}`
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) })
    if (res.status < 500) {
      log(`Using existing LiveKit server on port ${LIVEKIT_PORT}`)
      return { stop: async () => {} }
    }
  } catch {
    /* start one */
  }

  const keysArg = `${DEMO_LIVEKIT_KEY}: ${DEMO_LIVEKIT_SECRET}`
  if (commandExists('livekit-server')) {
    log(`Starting local livekit-server --dev on port ${LIVEKIT_PORT}`)
    const proc = spawn(
      'livekit-server',
      ['--dev', '--bind', '127.0.0.1', '--port', String(LIVEKIT_PORT), '--keys', keysArg],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    await waitForHttp(healthUrl, 20_000)
    return {
      stop: async () => {
        try { proc.kill('SIGTERM') } catch { /* noop */ }
      },
    }
  }

  if (commandExists('docker')) {
    const containerName = `marshallcam-demo-livekit-${process.pid}`
    log(`Starting LiveKit Docker container (${containerName}) on port ${LIVEKIT_PORT}`)
    const proc = spawn(
      'docker',
      [
        'run', '--rm', '--name', containerName, '--network', 'host',
        'livekit/livekit-server:latest',
        '--dev', '--bind', '127.0.0.1', '--port', String(LIVEKIT_PORT), '--keys', keysArg,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderr = ''
    proc.stderr?.on('data', (d) => { stderr += d.toString() })
    try {
      await waitForHttp(healthUrl, 25_000)
    } catch (err) {
      try { spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' }) } catch { /* noop */ }
      throw new Error(`LiveKit Docker failed to start: ${err.message}\n${stderr}`)
    }
    return {
      stop: async () => {
        spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' })
        try { proc.kill('SIGTERM') } catch { /* noop */ }
      },
    }
  }

  throw new Error('Neither livekit-server nor docker is installed. Start a LiveKit dev server on port 7880 first.')
}

function generateTestPattern(outPath, filter, vf) {
  if (!commandExists('ffmpeg')) return null
  const args = ['-y', '-f', 'lavfi', '-i', filter]
  if (vf) args.push('-vf', vf)
  args.push('-t', '3', '-pix_fmt', 'yuv420p', outPath)
  let res = spawnSync('ffmpeg', args, { stdio: 'pipe', encoding: 'utf8' })
  if (res.status !== 0 && vf) {
    // Retry without drawtext in case ffmpeg was built without libfreetype.
    res = spawnSync(
      'ffmpeg',
      ['-y', '-f', 'lavfi', '-i', filter, '-t', '3', '-pix_fmt', 'yuv420p', outPath],
      { stdio: 'pipe', encoding: 'utf8' },
    )
  }
  if (res.status !== 0) {
    log(`ffmpeg test pattern failed (${filter}), falling back to Chromium default fake camera`)
    return null
  }
  return outPath
}

async function startDemoServer(tmpDir, ecpPort) {
  const tsxBin = path.join(ROOT, 'node_modules', '.bin', 'tsx')
  const serverEntry = path.join(ROOT, 'src', 'MarshallCamServer.ts')
  const env = {
    ...process.env,
    PORT: String(DEMO_PORT),
    LISTEN_HOST: '127.0.0.1',
    STATION_PIN: DEMO_PIN,
    ADMIN_PASSWORD: DEMO_ADMIN_PASSWORD,
    APP_NAME: 'MarshallCam',
    APP_TAGLINE: 'Demo Station - Living Room',
    LIVEKIT_API_KEY: DEMO_LIVEKIT_KEY,
    LIVEKIT_API_SECRET: DEMO_LIVEKIT_SECRET,
    LIVEKIT_URL_LOCAL: `ws://127.0.0.1:${LIVEKIT_PORT}`,
    LIVEKIT_URL_LAN: '',
    LIVEKIT_URL_PUBLIC: '',
    PUBLIC_HOSTNAMES: 'cam.example.com,livekit.example.com',
    SERVER_LAN_IP: '',
    TV_IP: '127.0.0.1',
    TV_ECP_PORT: String(ecpPort),
    ADMIN_AI_URL: '',
    DATA_DIR: path.join(tmpDir, 'data'),
    LOG_DIR: path.join(tmpDir, 'logs'),
    ICE_SERVERS_JSON: JSON.stringify([{ urls: 'stun:stun.example.com:3478' }]),
  }

  log(`Starting MarshallCam server on http://127.0.0.1:${DEMO_PORT}`)
  const proc = spawn(tsxBin, [serverEntry], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  proc.stdout?.on('data', (d) => { output += d.toString() })
  proc.stderr?.on('data', (d) => { output += d.toString() })

  try {
    await waitForHttp(`http://127.0.0.1:${DEMO_PORT}/healthz`, 15_000)
  } catch (err) {
    try { proc.kill('SIGTERM') } catch { /* noop */ }
    throw new Error(`MarshallCam server failed to start: ${err.message}\n${output}`)
  }

  return {
    stop: async () => {
      try { proc.kill('SIGTERM') } catch { /* noop */ }
    },
  }
}

async function launchBrowser(chromium, executablePath, fakeVideoFile) {
  const args = [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ]
  if (fakeVideoFile) {
    args.push(`--use-file-for-fake-video-capture=${fakeVideoFile}`)
  }
  const browserEnv = { ...process.env }
  // Chromium creates a Unix domain socket under TMPDIR (max ~108 bytes).
  if ((browserEnv.TMPDIR || '').length > 40 && fs.existsSync('/tmp')) {
    browserEnv.TMPDIR = '/tmp'
  }
  return chromium.launch({
    headless: true,
    executablePath,
    args,
    env: browserEnv,
  })
}

async function main() {
  const clientIndex = path.join(ROOT, 'public', 'client', 'index.html')
  const maxIndex = path.join(ROOT, 'public', 'max', 'index.html')
  if (!fs.existsSync(clientIndex) || !fs.existsSync(maxIndex)) {
    throw new Error('Clients are not built. Run `npm run build` first.')
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marshallcam-shots-'))

  const { chromium } = await loadPlaywright()
  const executablePath = resolveChromiumPath(chromium)
  log(`Using Chromium: ${executablePath || 'Playwright bundled'}`)

  const stationVideo = generateTestPattern(
    path.join(tmpDir, 'station.y4m'),
    'testsrc2=size=1280x720:rate=15',
    "drawbox=x=0:y=ih-72:w=iw:h=72:color=black@0.65:t=fill,drawtext=text='Living Room  |  Demo Station':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=h-48",
  )
  const remoteVideo = generateTestPattern(
    path.join(tmpDir, 'remote.y4m'),
    'smptehdbars=size=480x640:rate=15',
  )

  const ecp = await startMockEcpServer()
  let livekit = null
  let server = null
  let stationBrowser = null
  let remoteBrowser = null
  let adminBrowser = null

  const cleanup = async () => {
    await stationBrowser?.close().catch(() => {})
    await remoteBrowser?.close().catch(() => {})
    await adminBrowser?.close().catch(() => {})
    await server?.stop().catch(() => {})
    await livekit?.stop().catch(() => {})
    await ecp?.close().catch(() => {})
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  try {
    livekit = await ensureLiveKit()
    server = await startDemoServer(tmpDir, ecp.port)
    const baseUrl = `http://127.0.0.1:${DEMO_PORT}`

    // 1. Station standby view
    stationBrowser = await launchBrowser(chromium, executablePath, stationVideo)
    const stationContext = await stationBrowser.newContext({
      viewport: VIEWPORT,
      permissions: ['camera', 'microphone'],
    })
    const stationPage = await stationContext.newPage()
    stationPage.on('console', (m) => {
      if (m.type() === 'error') log(`[station console.error] ${m.text()}`)
    })

    log('Opening station standby view...')
    await stationPage.goto(`${baseUrl}/?role=station`, { waitUntil: 'networkidle' })
    await stationPage.waitForSelector('.station-status-badge.connected', { timeout: 25_000 })
    await stationPage.waitForTimeout(800)

    const stationShot = path.join(OUT_DIR, 'station.png')
    await stationPage.screenshot({ path: stationShot, type: 'png' })
    log(`Saved ${stationShot}`)

    // 2. Remote active call view (with station publishing fake camera)
    remoteBrowser = await launchBrowser(chromium, executablePath, remoteVideo)
    const remoteContext = await remoteBrowser.newContext({
      viewport: VIEWPORT,
      permissions: ['camera', 'microphone'],
    })
    const remotePage = await remoteContext.newPage()
    remotePage.on('console', (m) => {
      if (m.type() === 'error') log(`[remote console.error] ${m.text()}`)
    })

    log('Opening remote client and entering demo PIN...')
    await remotePage.goto(`${baseUrl}/?role=remote`, { waitUntil: 'networkidle' })
    await remotePage.waitForSelector('.pin-keypad', { timeout: 15_000 })
    for (const digit of DEMO_PIN) {
      await remotePage.locator('.key.digit', { hasText: new RegExp(`^${digit}$`) }).click()
    }

    const callBtn = remotePage.locator('button[aria-label="Call dogs"]')
    await callBtn.waitFor({ state: 'visible', timeout: 15_000 })
    await callBtn.click()

    log('Waiting for live WebRTC video streams on remote call view...')
    await remotePage.waitForSelector('.live-indicator', { timeout: 25_000 })
    await remotePage.waitForFunction(
      () => {
        const main = document.querySelector('video.main-canvas')
        const self = document.querySelector('#caller-vid-self')
        const mainReady = Boolean(main && main.readyState >= 2 && main.videoWidth > 0)
        const selfReady = Boolean(self && self.readyState >= 2 && self.videoWidth > 0)
        return mainReady && selfReady
      },
      null,
      { timeout: 25_000 },
    )
    // Allow LiveKit adaptiveStream to ramp up to high resolution before capture.
    await remotePage
      .waitForFunction(
        () => {
          const main = document.querySelector('video.main-canvas')
          return Boolean(main && main.videoWidth >= 640)
        },
        null,
        { timeout: 6_000 },
      )
      .catch(() => {})
    await remotePage.waitForTimeout(1500)

    const remoteShot = path.join(OUT_DIR, 'remote.png')
    await remotePage.screenshot({ path: remoteShot, type: 'png' })
    log(`Saved ${remoteShot}`)

    // 3. Admin dashboard view (/max)
    adminBrowser = await launchBrowser(chromium, executablePath, null)
    const adminContext = await adminBrowser.newContext({ viewport: VIEWPORT })
    const adminPage = await adminContext.newPage()

    log('Opening admin dashboard...')
    await adminPage.goto(`${baseUrl}/max/`, { waitUntil: 'networkidle' })
    await adminPage.locator('input[placeholder="Password"]').fill(DEMO_ADMIN_PASSWORD)
    await adminPage.locator('button[type="submit"]').click()

    const systemsTab = adminPage.locator('button[role="tab"]', { hasText: 'Systems' })
    await systemsTab.waitFor({ state: 'visible', timeout: 15_000 })
    await systemsTab.click()

    await adminPage.getByText('Living Room Demo TV').waitFor({ state: 'visible', timeout: 15_000 })
    await adminPage.waitForTimeout(500)

    const adminShot = path.join(OUT_DIR, 'admin.png')
    await adminPage.screenshot({ path: adminShot, type: 'png' })
    log(`Saved ${adminShot}`)

    for (const file of [stationShot, remoteShot, adminShot]) {
      const kb = (fs.statSync(file).size / 1024).toFixed(1)
      log(`${path.basename(file)}: ${kb} KB`)
    }
  } finally {
    await cleanup()
  }
}

main().catch((err) => {
  console.error('[screenshots] FAILED:', err)
  process.exit(1)
})
