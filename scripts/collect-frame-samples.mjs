#!/usr/bin/env node
/**
 * Browser frame-time collector (M5-T2).
 *
 * Samples `requestAnimationFrame` deltas from the **built app** in a real
 * browser, for the scenes the frame-budget report prices. It is the half of
 * M5-T2 that a jsdom test cannot do (no GPU, no compositor) and that a pure
 * module cannot do (no browser), so it lives outside the gate as a probe.
 *
 * Expects a preview server already running on the built app:
 *
 *   npm run build
 *   npx vite preview --port 4173 --strictPort
 *   node scripts/collect-frame-samples.mjs --out docs/frame-samples.json
 *   node --experimental-strip-types scripts/profile-frame-budget.mjs --frames docs/frame-samples.json
 *
 * Chrome is launched headless with **SwiftShader** (software WebGL2): the
 * numbers are a pessimistic floor, not a mid-range GPU claim. The report says
 * so; this script only measures.
 *
 * Every scene navigates to `/?trace=scale:<n>` — the URL seam M5-T2 added
 * (`src/scale/scaleQuery.ts`) — so what is measured is the real app mounting a
 * real 1–2k-node scene, not a benchmark harness that merely resembles it.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** The scenes to sample — labels must match `scripts/profile-frame-budget.mjs`. */
const SCENES = [
  { label: 'fixture: Fan-out', url: '/' },
  { label: 'scale:250 agents', url: '/?trace=scale:250' },
  { label: 'scale:1000 agents', url: '/?trace=scale:1000' },
  { label: 'scale:2000 agents', url: '/?trace=scale:2000' },
  {
    label: 'scale:2000 agents, dense (4 reports each)',
    url: '/?trace=scale:2000&mpa=4',
  },
]

const argv = process.argv.slice(2)
/** `--flag value`, or `fallback`. */
function arg(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index < 0 ? fallback : argv[index + 1]
}

const BASE = arg('base', 'http://localhost:4173')
const PORT = Number(arg('port', '9222'))
const OUT = resolve(arg('out', 'docs/frame-samples.json'))
/** Seconds of frame sampling per scene (after warmup). */
const SECONDS = Number(arg('seconds', '10'))
/** Seconds to wait after the scene mounts before sampling (JIT, shader compile, bloom). */
const WARMUP = Number(arg('warmup', '3'))
/** Seconds to wait for the scene plan to appear — a 2k-run settles for seconds. */
const MOUNT_TIMEOUT = Number(arg('mount-timeout', '60'))

/** `sleep(ms)`. */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** A minimal CDP client over one WebSocket. */
class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url)
    this.nextId = 1
    this.pending = new Map()
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined)
        entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    })
  }

  /** Resolve once the socket is open. */
  open() {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve()
    return new Promise((done, fail) => {
      this.socket.addEventListener('open', () => done(), { once: true })
      this.socket.addEventListener('error', () => fail(new Error('CDP socket error')), {
        once: true,
      })
    })
  }

  /** Send one command. */
  send(method, params = {}) {
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params })
    return new Promise((done, fail) => {
      this.pending.set(id, { resolve: done, reject: fail })
      this.socket.send(payload)
    })
  }

  /** Evaluate an async expression in the page and return its value. */
  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.text ?? 'page exception')
    }
    return result.result?.value
  }

  close() {
    try {
      this.socket.close()
    } catch {
      // Already closed — nothing to do.
    }
  }
}

/** Launch headless Chrome with software WebGL2 and return the child. */
function launchChrome() {
  return spawn(
    'google-chrome',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      `--remote-debugging-port=${PORT}`,
      '--window-size=1280,800',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  )
}

/** Wait for the debugging endpoint and return the page's WebSocket URL. */
async function debuggerUrl() {
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl
    } catch {
      // Chrome is still starting.
    }
    if (Date.now() > deadline) throw new Error('Chrome did not open its debugger port')
    await sleep(250)
  }
}

/** Navigate and wait until the app has a scene plan mounted. */
async function mount(cdp, url) {
  await cdp.send('Page.navigate', { url })
  const deadline = Date.now() + MOUNT_TIMEOUT * 1000
  for (;;) {
    const state = await cdp.evaluate(`(() => {
      const viewport = document.querySelector('[data-testid="viewport"]')
      if (viewport === null) return null
      return {
        runId: viewport.getAttribute('data-run-id') ?? '',
        drawCalls: viewport.getAttribute('data-draw-calls') ?? '',
        canvas: document.querySelector('canvas') !== null,
      }
    })()`)
    if (state !== null && state.runId !== '' && state.canvas) return state
    if (Date.now() > deadline) throw new Error(`scene never mounted for ${url}`)
    await sleep(500)
  }
}

/** Sample rAF deltas in the page for `seconds`, returning the deltas in ms. */
async function sampleFrames(cdp, seconds) {
  return cdp.evaluate(`(async () => {
    const deltas = []
    const stopAt = performance.now() + ${Math.round(seconds * 1000)}
    let last = await new Promise((done) => requestAnimationFrame(done))
    while (performance.now() < stopAt) {
      const now = await new Promise((done) => requestAnimationFrame(done))
      deltas.push(now - last)
      last = now
    }
    return deltas
  })()`)
}

/** The renderer the browser actually made — reported, never assumed. */
async function browserMeta(cdp) {
  return cdp.evaluate(`(() => {
    const canvas = document.querySelector('canvas')
    const gl = canvas?.getContext('webgl2')
    let renderer = 'no webgl2 context'
    let vendor = ''
    if (gl !== null && gl !== undefined) {
      const info = gl.getExtension('WEBGL_debug_renderer_info')
      renderer = info === null ? 'renderer info hidden' : gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
      vendor = info === null ? '' : gl.getParameter(info.UNMASKED_VENDOR_WEBGL)
    }
    return {
      userAgent: navigator.userAgent,
      renderer,
      vendor,
      devicePixelRatio: window.devicePixelRatio,
      canvas: canvas === null ? null : { width: canvas.width, height: canvas.height },
    }
  })()`)
}

// ── Main ────────────────────────────────────────────────────────────────────

const chrome = launchChrome()
const samples = {}
let meta = null
let exitCode = 0
try {
  const cdp = new Cdp(await debuggerUrl())
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  for (const scene of SCENES) {
    const mounted = await mount(cdp, `${BASE}${scene.url}`)
    if (meta === null) meta = await browserMeta(cdp)
    await sleep(WARMUP * 1000)
    const deltas = await sampleFrames(cdp, SECONDS)
    samples[scene.label] = deltas
    const sorted = [...deltas].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0
    console.log(
      `${scene.label.padEnd(46)} run ${mounted.runId.slice(0, 12)}  draw calls ${mounted.drawCalls}  ` +
        `${deltas.length} frames  p50 ${median.toFixed(1)} ms`,
    )
  }
  cdp.close()
} catch (error) {
  console.error(`collector failed: ${error.message}`)
  exitCode = 1
} finally {
  try {
    process.kill(-chrome.pid, 'SIGTERM')
  } catch {
    chrome.kill('SIGTERM')
  }
}

if (exitCode === 0) {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, `${JSON.stringify({ _meta: meta, ...samples }, null, 2)}\n`)
  console.log(`renderer: ${meta?.renderer ?? 'unknown'}`)
  console.log(`wrote ${OUT}`)
}
process.exit(exitCode)
