import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MESSAGES_PER_AGENT,
  MAX_MESSAGES_PER_AGENT,
  MAX_SCALE_AGENTS,
  parseScaleTrace,
  scaleTraceRun,
} from './scaleQuery.ts'

/**
 * The URL-selected scale run (M5-T2).
 *
 * This is the one seam that lets the *real app* draw a 1–2k-node scene, which is
 * what the profiling report measures in the browser. The rules worth pinning are
 * the defensive ones: a URL is untrusted input, so the parse must never throw,
 * must never exceed its bound, and must return `null` (the default mount) rather
 * than something half-understood for every input it does not recognise.
 */

describe('parseScaleTrace (M5-T2)', () => {
  it('reads a scale run out of the trace parameter', () => {
    expect(parseScaleTrace('?trace=scale:2000')).toEqual({
      agents: 2000,
      messagesPerAgent: DEFAULT_MESSAGES_PER_AGENT,
      label: 'scale:2000 agents',
    })
  })

  it('accepts a query string without the leading question mark', () => {
    expect(parseScaleTrace('trace=scale:250')?.agents).toBe(250)
  })

  it('accepts a full URL', () => {
    expect(parseScaleTrace('http://localhost:4173/?trace=scale:1500')?.agents).toBe(
      1500,
    )
  })

  it('does not care about parameter order or extra parameters', () => {
    expect(parseScaleTrace('?foo=1&trace=scale:100&bar=2')?.agents).toBe(100)
    expect(parseScaleTrace('?trace=scale:100&mpa=3')?.messagesPerAgent).toBe(3)
  })

  it('ignores a fragment', () => {
    expect(parseScaleTrace('?trace=scale:100#agents')?.agents).toBe(100)
  })

  it('reads the messages-per-agent knob, bounded', () => {
    expect(parseScaleTrace('?trace=scale:10&mpa=2')?.messagesPerAgent).toBe(2)
    // Nonsense and out-of-range values fall back rather than failing the mount.
    expect(parseScaleTrace('?trace=scale:10&mpa=0')?.messagesPerAgent).toBe(
      DEFAULT_MESSAGES_PER_AGENT,
    )
    expect(parseScaleTrace('?trace=scale:10&mpa=x')?.messagesPerAgent).toBe(
      DEFAULT_MESSAGES_PER_AGENT,
    )
    expect(parseScaleTrace('?trace=scale:10&mpa=99')?.messagesPerAgent).toBe(
      MAX_MESSAGES_PER_AGENT,
    )
  })

  it('clamps the agent count to its bound instead of trusting the URL', () => {
    expect(parseScaleTrace('?trace=scale:999999')?.agents).toBe(MAX_SCALE_AGENTS)
    expect(MAX_SCALE_AGENTS).toBeGreaterThanOrEqual(2000)
  })

  it('returns null when the URL asks for no scale run', () => {
    expect(parseScaleTrace('')).toBeNull()
    expect(parseScaleTrace('?')).toBeNull()
    expect(parseScaleTrace('?trace=')).toBeNull()
    expect(parseScaleTrace('?other=1')).toBeNull()
    expect(parseScaleTrace('?trace=')).toBeNull()
  })

  it('returns null for anything that is not the scale scheme', () => {
    expect(parseScaleTrace('?trace=file:run.json')).toBeNull()
    expect(parseScaleTrace('?trace=scale')).toBeNull()
    expect(parseScaleTrace('?trace=Scale:100')).toBeNull()
  })

  it('returns null for an agent count that is not a positive whole number', () => {
    expect(parseScaleTrace('?trace=scale:0')).toBeNull()
    expect(parseScaleTrace('?trace=scale:-12')).toBeNull()
    expect(parseScaleTrace('?trace=scale:1.5')).toBeNull()
    expect(parseScaleTrace('?trace=scale:abc')).toBeNull()
    expect(parseScaleTrace('?trace=scale:%2010')).toBeNull()
  })

  it('never throws on a malformed escape', () => {
    expect(() => parseScaleTrace('?trace=scale:%E0%A4%A')).not.toThrow()
    expect(parseScaleTrace('?trace=scale:%E0%A4%A')).toBeNull()
  })

  it('is a pure function of the string', () => {
    const first = parseScaleTrace('?trace=scale:42&mpa=2')
    const second = parseScaleTrace('?trace=scale:42&mpa=2')
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
  })
})

describe('scaleTraceRun (M5-T2)', () => {
  it('builds the run through the real ingest path', () => {
    const built = scaleTraceRun('?trace=scale:12')
    expect(built).not.toBeNull()
    expect(built?.run.meta.agentCount).toBe(12)
    expect(built?.run.meta.messageCount).toBeGreaterThan(0)
    expect(built?.rows.length).toBe(built?.run.meta.messageCount)
    expect(built?.run.label).toBe('scale:12 agents')
  })

  it('honours the messages-per-agent knob', () => {
    const one = scaleTraceRun('?trace=scale:12')
    const three = scaleTraceRun('?trace=scale:12&mpa=3')
    expect(three?.run.meta.messageCount).toBeGreaterThan(
      one?.run.meta.messageCount ?? 0,
    )
  })

  it('returns null when no scale run was asked for', () => {
    expect(scaleTraceRun('')).toBeNull()
    expect(scaleTraceRun('?trace=other')).toBeNull()
  })
})

// ── purity scan ─────────────────────────────────────────────────────────────

/** Walk up from cwd until the package manifest is found. */
function findRepoRoot(start: string): string {
  let dir = start
  for (;;) {
    if (existsSync(resolve(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('package.json not found above cwd')
    dir = parent
  }
}

describe('scaleQuery — purity (PRD §5)', () => {
  const root = findRepoRoot(process.cwd())
  const source = readFileSync(resolve(root, 'src/scale/scaleQuery.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  it('parses its own string — no browser API, no clock, no randomness', () => {
    expect(source).not.toMatch(/URLSearchParams/)
    expect(source).not.toMatch(/\bwindow\./)
    expect(source).not.toMatch(/\bdocument\./)
    expect(source).not.toMatch(/\bDate\.now\s*\(/)
    expect(source).not.toMatch(/\bMath\.random\s*\(/)
  })

  it('builds runs with the one scale builder, not a second one', () => {
    expect(source).toMatch(/from '\.\/scaleRun\.ts'/)
    expect(source).not.toMatch(/agent_messages/)
  })
})
