import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { buildFixture, FIXTURE_SHAPES } from '../fixtures/index.ts'
import type { FixtureShape } from '../fixtures/index.ts'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import type { AgentMessageRow } from '../adapter/index.ts'
import { normalizeTrace } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'
import type { Run } from '../types/index.ts'
import {
  HUD_FACT_IDS,
  HudError,
  MISSING_FIGURE,
  buildRunSummary,
  hudFact,
} from './hud.ts'
import type { HudFact, HudFactId, RunSummary } from './hud.ts'

/**
 * Tests for the run-summary / HUD model (M4-T6).
 *
 * The HUD is a reading of the run's fixed facts, so what is pinned here is: the
 * numbers are the run's own (per fixture, cross-checked against `RunMeta`), the
 * lines are formatted by the shared rules rather than re-invented, absent
 * token/cost figures are *reported* instead of printed as zero, and a model whose
 * arrays contradict its own meta fails loudly instead of rendering a summary that
 * disagrees with the scene behind it.
 *
 * The look of the overlay is not asserted (jsdom has no GPU and no layout) — that
 * is the human review's job (M5-T5).
 */

const MINUTE = 60_000

/** Each fixture with the counts its message rows imply. */
const EXPECTED: Readonly<
  Record<
    FixtureShape,
    { agents: number; messages: number; toolCalls: number; spanMs: number }
  >
> = {
  'fan-out': { agents: 6, messages: 5, toolCalls: 5, spanMs: 4 * MINUTE },
  loop: { agents: 3, messages: 7, toolCalls: 7, spanMs: 6 * MINUTE },
  'dead-branch': { agents: 3, messages: 3, toolCalls: 3, spanMs: 2 * MINUTE },
  'handoff-chain': { agents: 4, messages: 3, toolCalls: 3, spanMs: 2 * MINUTE },
}

const FAN_OUT = buildFixture('fan-out').run

/**
 * A run that really records spend, built through the real path: attach token and
 * cost figures to a fixture's messages and re-normalize, so `RunMeta` is
 * recomputed from them (the v1 export carries none, so this is the only way a
 * recorded-spend summary can be exercised).
 */
function runWithSpend(
  shape: FixtureShape,
  options: {
    tokens?: number
    messageCostUsd?: number
    toolCallCostUsd?: number
  } = {},
): TraceModel {
  const run = buildFixture(shape).run
  const messages = run.messages.map((message, index) => ({
    ...message,
    tokens: index === 0 ? (options.tokens ?? 0) : 0,
    costUsd: index === 0 ? (options.messageCostUsd ?? 0) : 0,
  }))
  const toolCalls = run.toolCalls.map((call, index) => ({
    ...call,
    costUsd: index === 0 ? (options.toolCallCostUsd ?? 0) : 0,
  }))
  return normalizeTrace({ ...run, messages, toolCalls })
}

/**
 * A run built from a fixture's own row list with some messages made broadcasts
 * (`to_agent: null`), pushed back through the real ingest path — the event
 * mirrors are then the adapter's, not hand-edited.
 */
function runWithBroadcasts(
  shape: FixtureShape,
  broadcastRowIds: readonly AgentMessageRow['id'][],
): TraceModel {
  const rows = buildFixture(shape).rows.map((row) =>
    broadcastRowIds.includes(row.id) ? { ...row, to_agent: null } : row,
  )
  return normalizeTrace(parseAgentMessagesExport(rows))
}

/** An empty, fully-formed run — normalization of nothing. */
function emptyRun(): TraceModel {
  const run: Run = {
    id: 'run_empty',
    label: 'empty export',
    source: 'agent_messages',
    seed: 0,
    agents: [],
    messages: [],
    toolCalls: [],
    events: [],
    startedAt: 0,
    endedAt: 0,
    meta: {
      agentCount: 0,
      messageCount: 0,
      toolCallCount: 0,
      eventCount: 0,
      broadcastCount: 0,
      durationMs: 0,
      totalTokens: 0,
      totalCostUsd: 0,
    },
  }
  return normalizeTrace(run)
}

/** A copy of `model` with a hand-edited meta — the drift the gate must catch. */
function withMeta(model: TraceModel, patch: Partial<TraceModel['meta']>): TraceModel {
  return { ...model, meta: { ...model.meta, ...patch } }
}

describe('buildRunSummary — shape', () => {
  it('returns a fully-formed summary (expectTypeOf)', () => {
    const summary = buildRunSummary(FAN_OUT)
    expectTypeOf(summary).toEqualTypeOf<RunSummary>()
    expectTypeOf(summary.counts.agents).toEqualTypeOf<number>()
    expectTypeOf(summary.facts).toEqualTypeOf<HudFact[]>()
    expectTypeOf(summary.attributionNote).toEqualTypeOf<string | null>()
  })

  it('carries the run’s identity and provenance', () => {
    const summary = buildRunSummary(FAN_OUT)
    expect(summary.runId).toBe(FAN_OUT.id)
    expect(summary.label).toBe('fixture: Fan-out')
    // v1's one ingest format, printed as provenance rather than assumed.
    expect(summary.source).toBe('agent_messages')
  })

  it('prints exactly the six facts, in the declared order', () => {
    const summary = buildRunSummary(FAN_OUT)
    expect(summary.facts.map((fact) => fact.id)).toEqual([...HUD_FACT_IDS])
    expect(HUD_FACT_IDS).toEqual([
      'agents',
      'messages',
      'toolCalls',
      'duration',
      'tokens',
      'cost',
    ])
  })

  it('labels every fact and gives each a printable value', () => {
    for (const fact of buildRunSummary(FAN_OUT).facts) {
      expect(fact.label.length).toBeGreaterThan(0)
      expect(fact.value.length).toBeGreaterThan(0)
      expect(fact.value).not.toBe('NaN')
    }
  })

  it('exposes a fact by id, and null for one it does not have', () => {
    const summary = buildRunSummary(FAN_OUT)
    expect(hudFact(summary, 'agents')?.value).toBe('6')
    expect(hudFact(summary, 'cost')?.recorded).toBe(false)
    expect(hudFact(summary, 'nope' as HudFactId)).toBeNull()
  })
})

describe('buildRunSummary — the run’s own numbers', () => {
  it.each(FIXTURE_SHAPES)('reads %s back exactly', (shape) => {
    const summary = buildRunSummary(buildFixture(shape).run)
    const expected = EXPECTED[shape]
    expect(summary.counts.agents).toBe(expected.agents)
    expect(summary.counts.messages).toBe(expected.messages)
    expect(summary.counts.toolCalls).toBe(expected.toolCalls)
    expect(summary.durationMs).toBe(expected.spanMs)
    // The unified stream is every message, every call and the run bracket.
    expect(summary.counts.events).toBe(expected.messages + expected.toolCalls + 2)
    expect(summary.empty).toBe(false)
  })

  it('agrees with the model’s own RunMeta on every fixture', () => {
    for (const shape of FIXTURE_SHAPES) {
      const run = buildFixture(shape).run
      const summary = buildRunSummary(run)
      expect(summary.counts.agents).toBe(run.meta.agentCount)
      expect(summary.counts.messages).toBe(run.meta.messageCount)
      expect(summary.counts.toolCalls).toBe(run.meta.toolCallCount)
      expect(summary.counts.events).toBe(run.meta.eventCount)
      expect(summary.durationMs).toBe(run.meta.durationMs)
      expect(summary.totalTokens).toBe(run.meta.totalTokens)
      expect(summary.totalCostUsd).toBe(run.meta.totalCostUsd)
    }
  })

  it('reports no broadcasts and no qualifier for the fan-out', () => {
    const summary = buildRunSummary(FAN_OUT)
    expect(summary.counts.broadcasts).toBe(0)
    expect(hudFact(summary, 'messages')?.detail).toBeNull()
  })

  it('qualifies a message total with its broadcast subset', () => {
    // One fixture row made a broadcast, through the real ingest path: the message
    // total is unchanged, the qualifier is not.
    const summary = buildRunSummary(runWithBroadcasts('dead-branch', [3001]))
    expect(summary.counts.messages).toBe(3)
    expect(summary.counts.broadcasts).toBe(1)
    expect(hudFact(summary, 'messages')?.detail).toBe('1 broadcast')
  })

  it('pluralizes the broadcast qualifier', () => {
    const summary = buildRunSummary(
      runWithBroadcasts('dead-branch', [3001, 3002, 3003]),
    )
    expect(summary.counts.broadcasts).toBe(3)
    expect(hudFact(summary, 'messages')?.detail).toBe('3 broadcasts')
  })

  it('formats the run’s duration with the shared duration rule', () => {
    expect(hudFact(buildRunSummary(FAN_OUT), 'duration')?.value).toBe('4:00')
    expect(hudFact(buildRunSummary(buildFixture('loop').run), 'duration')?.value).toBe(
      '6:00',
    )
  })

  it('prints the one-line headline from the same numbers', () => {
    expect(buildRunSummary(FAN_OUT).headline).toBe(
      '6 agents · 5 messages · 5 tool calls · 4:00',
    )
    expect(buildRunSummary(buildFixture('handoff-chain').run).headline).toBe(
      '4 agents · 3 messages · 3 tool calls · 2:00',
    )
  })
})

describe('buildRunSummary — tokens and cost', () => {
  it('reports absent figures as missing, never as zero', () => {
    // The v1 export carries no token or cost columns: every fixture is in this
    // state, and printing "$0.00" would misreport an unrecorded run as free.
    const summary = buildRunSummary(FAN_OUT)
    expect(summary.totalTokens).toBe(0)
    expect(summary.totalCostUsd).toBe(0)
    expect(summary.tokensRecorded).toBe(false)
    expect(summary.costRecorded).toBe(false)
    expect(hudFact(summary, 'tokens')).toMatchObject({
      value: MISSING_FIGURE,
      detail: 'not recorded',
      recorded: false,
    })
    expect(hudFact(summary, 'cost')).toMatchObject({
      value: MISSING_FIGURE,
      detail: 'not recorded',
      recorded: false,
    })
    expect(summary.attributionNote).toBe('This export records no token or cost data.')
  })

  it('prints recorded figures with the shared token and cost formats', () => {
    const run = runWithSpend('fan-out', { tokens: 12480, messageCostUsd: 0.0042 })
    const summary = buildRunSummary(run)
    expect(summary.tokensRecorded).toBe(true)
    expect(summary.costRecorded).toBe(true)
    expect(hudFact(summary, 'tokens')).toMatchObject({
      value: '12,480',
      detail: null,
      recorded: true,
    })
    expect(hudFact(summary, 'cost')).toMatchObject({
      value: '$0.0042',
      detail: null,
      recorded: true,
    })
    expect(summary.attributionNote).toBeNull()
  })

  it('formats a larger spend above a cent at two decimals', () => {
    const run = runWithSpend('loop', { tokens: 1250000, messageCostUsd: 12.345 })
    expect(hudFact(buildRunSummary(run), 'cost')?.value).toBe('$12.35')
    expect(hudFact(buildRunSummary(run), 'tokens')?.value).toBe('1,250,000')
  })

  it('counts tool-call spend in the cost total', () => {
    // Normalization attributes cost from messages a sender sent plus its calls
    // (M1-T5); the HUD must report the same total, not just the message half.
    const run = runWithSpend('fan-out', {
      tokens: 100,
      messageCostUsd: 0.5,
      toolCallCostUsd: 0.25,
    })
    const summary = buildRunSummary(run)
    expect(summary.totalCostUsd).toBeCloseTo(0.75, 12)
    expect(summary.totalCostUsd).toBe(run.meta.totalCostUsd)
    expect(hudFact(summary, 'cost')?.value).toBe('$0.75')
  })

  it('says which figure is missing when only one was recorded', () => {
    const tokensOnly = buildRunSummary(runWithSpend('fan-out', { tokens: 900 }))
    expect(tokensOnly.tokensRecorded).toBe(true)
    expect(tokensOnly.costRecorded).toBe(false)
    expect(tokensOnly.attributionNote).toBe('This export records no cost data.')

    const costOnly = buildRunSummary(runWithSpend('fan-out', { messageCostUsd: 0.02 }))
    expect(costOnly.tokensRecorded).toBe(false)
    expect(costOnly.costRecorded).toBe(true)
    expect(costOnly.attributionNote).toBe('This export records no token counts.')
  })
})

describe('buildRunSummary — the empty run', () => {
  it('is well-formed and says it is empty', () => {
    const summary = buildRunSummary(emptyRun())
    expect(summary.empty).toBe(true)
    expect(summary.counts).toEqual({
      agents: 0,
      messages: 0,
      broadcasts: 0,
      toolCalls: 0,
      events: 0,
    })
    expect(summary.durationMs).toBe(0)
    expect(summary.headline).toBe('0 agents · 0 messages · 0 tool calls · 0.0s')
    for (const fact of summary.facts) {
      expect(fact.value).not.toBe('NaN')
    }
    expect(hudFact(summary, 'duration')?.value).toBe('0.0s')
    expect(hudFact(summary, 'tokens')?.value).toBe(MISSING_FIGURE)
  })

  it('carries no missing-data note — an empty run records nothing because there is nothing', () => {
    expect(buildRunSummary(emptyRun()).attributionNote).toBeNull()
  })
})

describe('buildRunSummary — integrity', () => {
  it('throws when the meta’s agent count disagrees with the run', () => {
    expect(() => buildRunSummary(withMeta(FAN_OUT, { agentCount: 99 }))).toThrow(
      HudError,
    )
    expect(() => buildRunSummary(withMeta(FAN_OUT, { agentCount: 99 }))).toThrow(
      /drift on agent count/,
    )
  })

  it('throws on a message, broadcast, tool-call or event count drift', () => {
    expect(() => buildRunSummary(withMeta(FAN_OUT, { messageCount: 4 }))).toThrow(
      /drift on message count/,
    )
    expect(() => buildRunSummary(withMeta(FAN_OUT, { broadcastCount: 1 }))).toThrow(
      /drift on broadcast count/,
    )
    expect(() => buildRunSummary(withMeta(FAN_OUT, { toolCallCount: 0 }))).toThrow(
      /drift on tool call count/,
    )
    expect(() => buildRunSummary(withMeta(FAN_OUT, { eventCount: 0 }))).toThrow(
      /drift on event count/,
    )
  })

  it('throws on a duration that does not match the run’s own span', () => {
    expect(() => buildRunSummary(withMeta(FAN_OUT, { durationMs: 1 }))).toThrow(
      /drift on duration/,
    )
  })

  it('throws on token or cost totals the run does not support', () => {
    expect(() => buildRunSummary(withMeta(FAN_OUT, { totalTokens: 42 }))).toThrow(
      /drift on token total/,
    )
    expect(() => buildRunSummary(withMeta(FAN_OUT, { totalCostUsd: 1 }))).toThrow(
      /drift on cost total/,
    )
  })

  it('tolerates float noise between the two derivations', () => {
    const run = withMeta(FAN_OUT, { totalCostUsd: 1e-12 })
    expect(() => buildRunSummary(run)).not.toThrow()
  })

  it('refuses to total a run whose tokens are not finite', () => {
    const run = buildFixture('fan-out').run
    const messages = run.messages.map((message, index) =>
      index === 0 ? { ...message, tokens: Number.NaN } : message,
    )
    const broken = normalizeTrace({ ...run, messages })
    expect(() => buildRunSummary(broken)).toThrow(HudError)
    expect(() => buildRunSummary(broken)).toThrow(/token total is not a finite number/)
  })
})

describe('buildRunSummary — determinism', () => {
  it('is byte-identical across calls, on every fixture', () => {
    for (const shape of FIXTURE_SHAPES) {
      const run = buildFixture(shape).run
      expect(JSON.stringify(buildRunSummary(run))).toBe(
        JSON.stringify(buildRunSummary(run)),
      )
    }
  })

  it('is independent of the order the run’s arrays arrive in', () => {
    const reversed = normalizeTrace({
      ...FAN_OUT,
      agents: [...FAN_OUT.agents].reverse(),
      messages: [...FAN_OUT.messages].reverse(),
      toolCalls: [...FAN_OUT.toolCalls].reverse(),
      events: [...FAN_OUT.events].reverse(),
    })
    expect(JSON.stringify(buildRunSummary(reversed))).toBe(
      JSON.stringify(buildRunSummary(FAN_OUT)),
    )
  })

  it('does not mutate the run', () => {
    const before = JSON.stringify(FAN_OUT)
    buildRunSummary(FAN_OUT)
    expect(JSON.stringify(FAN_OUT)).toBe(before)
  })

  it('hands out fresh fact objects', () => {
    const first = buildRunSummary(FAN_OUT)
    const second = buildRunSummary(FAN_OUT)
    expect(first.facts).not.toBe(second.facts)
    expect(first.facts[0]).not.toBe(second.facts[0])
    expect(first.facts).toEqual(second.facts)
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

describe('hud — purity (PRD §5)', () => {
  const root = findRepoRoot(process.cwd())
  const source = readFileSync(resolve(root, 'src/hud/hud.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  it('reads no clock and no randomness', () => {
    expect(source).not.toMatch(/\bDate\.now\s*\(/)
    expect(source).not.toMatch(/\bperformance\.now\s*\(/)
    expect(source).not.toMatch(/\bMath\.random\s*\(/)
    expect(source).not.toMatch(/\bnew Date\s*\(/)
  })

  it('is a data-layer module — no React, no three.js, no DOM', () => {
    expect(source).not.toMatch(/from ['"]react['"]/)
    expect(source).not.toMatch(/from ['"]three['"]/)
    expect(source).not.toMatch(/@react-three/)
    expect(source).not.toMatch(/\bdocument\./)
    expect(source).not.toMatch(/\bwindow\./)
  })

  it('reuses the shared formatters instead of re-implementing them', () => {
    expect(source).toMatch(/from '\.\.\/playback\/playback\.ts'/)
    expect(source).toMatch(/from '\.\.\/inspect\/inspect\.ts'/)
    // Barrels would pull React in (usePlayback / useSelection) — stay on the
    // pure module paths.
    expect(source).not.toMatch(/from '\.\.\/playback\/index\.ts'/)
    expect(source).not.toMatch(/from '\.\.\/inspect\/index\.ts'/)
    // One formatting rule for durations: no local toFixed/padStart clock format.
    expect(source).not.toMatch(/padStart/)
  })
})
