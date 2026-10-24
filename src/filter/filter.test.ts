import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentMessageRow } from '../adapter/index.ts'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import { buildFixture } from '../fixtures/index.ts'
import { normalizeTrace } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'
import {
  FILTER_KINDS,
  IDENTITY_FILTER,
  buildFilterView,
  createFilter,
  formatFilterWindow,
  inWindow,
  isFilterActive,
  isIdentity,
  isolateAgentSelection,
  keepsKind,
  matchesMessage,
  matchesToolCall,
  messageTouchesSelection,
  normalizeAgentIds,
  normalizeKinds,
  normalizeWindow,
  reduceFilter,
  resolveAgentIds,
  retainFilter,
  sameFilter,
  toggleAgentSelection,
} from './filter.ts'
import type { FilterState } from './filter.ts'

/**
 * The filter (M4-T5) is the pure half of "narrow the scene": three facets, one
 * reducer, three predicates and one resolved view. These tests pin the *rules* —
 * what an empty facet means, what an empty kind selection means, what a window
 * keeps at its edges — and the properties a UI and the scene rely on (canonical
 * values, immutable updates, deterministic views, agreement with the model's own
 * counts).
 *
 * Nothing here asserts the rendered look (jsdom has no GPU; M5-T5 holds that).
 * What it does assert is that the numbers a dimmed scene is drawn from are the
 * run's own facts.
 */

const MINUTE = 60_000
const FAN_OUT = buildFixture('fan-out').run
const DEAD_BRANCH = buildFixture('dead-branch').run
const LOOP = buildFixture('loop').run

/** The fan-out fixture's agents, in canonical (id) order. */
const FAN_OUT_AGENTS = normalizeAgentIds(FAN_OUT.agents.map((agent) => agent.id))

/** A filter value for tests, normalized the way the reducer would leave it. */
function filterOf(partial: Partial<FilterState>): FilterState {
  return {
    agentIds: partial.agentIds ?? [],
    kinds: partial.kinds ?? FILTER_KINDS,
    window: partial.window ?? null,
  }
}

/** A run built through the real ingest path from raw rows. */
function runOf(rows: AgentMessageRow[]): TraceModel {
  return normalizeTrace(parseAgentMessagesExport(rows))
}

describe('filter — the identity filter (M4-T5)', () => {
  it('is the zero value: no agent restriction, both kinds, the whole run', () => {
    const filter = createFilter()
    expect(filter).toEqual({
      agentIds: [],
      kinds: ['message', 'tool_call'],
      window: null,
    })
    expect(filter).toBe(IDENTITY_FILTER)
    expect(isIdentity(filter)).toBe(true)
    expect(isFilterActive(filter)).toBe(false)
  })

  it('keeps every event of every fixture', () => {
    for (const shape of ['fan-out', 'loop', 'dead-branch', 'handoff-chain'] as const) {
      const model = buildFixture(shape).run
      for (const message of model.messages) {
        expect(matchesMessage(model, IDENTITY_FILTER, message), shape).toBe(true)
      }
      for (const call of model.toolCalls) {
        expect(matchesToolCall(model, IDENTITY_FILTER, call), shape).toBe(true)
      }
    }
  })

  it('resolves to every agent, every event, and no window', () => {
    const view = buildFilterView(FAN_OUT, IDENTITY_FILTER)
    expect(view.active).toBe(false)
    expect(view.empty).toBe(false)
    expect(view.agentIds).toEqual(FAN_OUT_AGENTS)
    expect(view.agentIds).toHaveLength(6)
    expect(view.kinds).toEqual(['message', 'tool_call'])
    expect(view.window).toBeNull()
    expect(view.windowLabel).toBeNull()
    expect(view.spanMs).toBe(4 * MINUTE)
    expect(view.agents).toEqual({ kept: 6, total: 6 })
    expect(view.messages).toEqual({ kept: 5, total: 5 })
    expect(view.toolCalls).toEqual({ kept: 5, total: 5 })
    expect(view.label).toBe('6 of 6 agents · 5 of 5 messages · 5 of 5 tool calls')
  })

  it('is reachable as a value, not only by identity', () => {
    // A persisted/deserialized filter is a different object with the same shape.
    expect(isIdentity(filterOf({}))).toBe(true)
    expect(sameFilter(filterOf({}), IDENTITY_FILTER)).toBe(true)
    expect(isFilterActive(filterOf({ kinds: ['message'] }))).toBe(true)
    expect(isFilterActive(filterOf({ agentIds: ['a_orchestrator'] }))).toBe(true)
    expect(isFilterActive(filterOf({ window: { startMs: 0, endMs: 1 } }))).toBe(true)
  })
})

describe('filter — normalization', () => {
  it('dedupes, drops blanks and sorts agent ids canonically', () => {
    expect(
      normalizeAgentIds(['a_worker_gamma', '', 'a_orchestrator', 'a_worker_gamma']),
    ).toEqual(['a_orchestrator', 'a_worker_gamma'])
  })

  it('sorts digit runs numerically, not lexically', () => {
    expect(normalizeAgentIds(['a_worker_10', 'a_worker_2'])).toEqual([
      'a_worker_2',
      'a_worker_10',
    ])
  })

  it('keeps kinds in the declared order and drops unknown ones', () => {
    expect(normalizeKinds(['tool_call', 'message', 'tool_call'])).toEqual([
      'message',
      'tool_call',
    ])
    expect(
      normalizeKinds(['message', 'run_start'] as unknown as Parameters<
        typeof normalizeKinds
      >[0]),
    ).toEqual(['message'])
  })

  it('makes a window well-formed: rounded, non-negative, ordered', () => {
    expect(normalizeWindow({ startMs: 1200.6, endMs: 500 })).toEqual({
      startMs: 500,
      endMs: 1201,
    })
    expect(normalizeWindow({ startMs: -50, endMs: -10 })).toEqual({
      startMs: 0,
      endMs: 0,
    })
    expect(normalizeWindow(null)).toBeNull()
    expect(normalizeWindow(undefined)).toBeNull()
    expect(normalizeWindow({ startMs: Number.NaN, endMs: 5 })).toBeNull()
  })

  it('formats a window as a range of offsets', () => {
    expect(formatFilterWindow({ startMs: 0, endMs: 120_000 })).toBe('0.0s → 2:00')
  })
})

describe('filter — the reducer', () => {
  it('sets the agent facet from any order', () => {
    const next = reduceFilter(IDENTITY_FILTER, {
      type: 'setAgents',
      agentIds: ['a_worker_beta', 'a_orchestrator', 'a_worker_beta'],
    })
    expect(next.agentIds).toEqual(['a_orchestrator', 'a_worker_beta'])
    expect(isFilterActive(next)).toBe(true)
  })

  it('treats an empty agent selection as the facet being off', () => {
    const one = reduceFilter(IDENTITY_FILTER, {
      type: 'setAgents',
      agentIds: ['a_orchestrator'],
    })
    const all = reduceFilter(one, { type: 'setAgents', agentIds: [] })
    expect(all).toBe(IDENTITY_FILTER)
    expect(isIdentity(all)).toBe(true)
  })

  it('returns the same state object when an action changes nothing', () => {
    const filtered = reduceFilter(IDENTITY_FILTER, {
      type: 'toggleKind',
      kind: 'message',
    })
    expect(reduceFilter(filtered, { type: 'setAgents', agentIds: [] })).toBe(filtered)
    expect(reduceFilter(filtered, { type: 'setKinds', kinds: ['tool_call'] })).toBe(
      filtered,
    )
    expect(reduceFilter(filtered, { type: 'clearWindow' })).toBe(filtered)
    expect(reduceFilter(IDENTITY_FILTER, { type: 'clear' })).toBe(IDENTITY_FILTER)
    expect(reduceFilter(IDENTITY_FILTER, { type: 'setAgents', agentIds: [] })).toBe(
      IDENTITY_FILTER,
    )
  })

  it('toggles a kind out and back in, keeping the declared order', () => {
    const noMessages = reduceFilter(IDENTITY_FILTER, {
      type: 'toggleKind',
      kind: 'message',
    })
    expect(noMessages.kinds).toEqual(['tool_call'])
    const both = reduceFilter(noMessages, { type: 'toggleKind', kind: 'message' })
    expect(both.kinds).toEqual(['message', 'tool_call'])
    expect(both).toBe(IDENTITY_FILTER)
  })

  it('allows an empty kind selection (nothing matches)', () => {
    const none = reduceFilter(
      reduceFilter(IDENTITY_FILTER, { type: 'toggleKind', kind: 'message' }),
      { type: 'toggleKind', kind: 'tool_call' },
    )
    expect(none.kinds).toEqual([])
    expect(buildFilterView(FAN_OUT, none).empty).toBe(true)
  })

  it('sets, clamps and clears the window', () => {
    const windowed = reduceFilter(IDENTITY_FILTER, {
      type: 'setWindow',
      window: { startMs: -10, endMs: 60_000.4 },
    })
    expect(windowed.window).toEqual({ startMs: 0, endMs: 60000 })
    const cleared = reduceFilter(windowed, { type: 'clearWindow' })
    expect(cleared.window).toBeNull()
    expect(cleared).toBe(IDENTITY_FILTER)
    expect(reduceFilter(windowed, { type: 'setWindow', window: null })).toBe(
      IDENTITY_FILTER,
    )
  })

  it('clears back to the identity filter', () => {
    const filtered = reduceFilter(
      reduceFilter(IDENTITY_FILTER, {
        type: 'setAgents',
        agentIds: ['a_orchestrator'],
      }),
      { type: 'setWindow', window: { startMs: 0, endMs: 1000 } },
    )
    expect(reduceFilter(filtered, { type: 'clear' })).toBe(IDENTITY_FILTER)
  })

  it('replaces with a normalized copy of a hand-built filter', () => {
    const next = reduceFilter(IDENTITY_FILTER, {
      type: 'replace',
      filter: filterOf({
        agentIds: ['a_orchestrator', 'a_orchestrator'],
        kinds: ['tool_call'],
        window: { startMs: 500, endMs: 100 },
      }),
    })
    expect(next.agentIds).toEqual(['a_orchestrator'])
    expect(next.kinds).toEqual(['tool_call'])
    expect(next.window).toEqual({ startMs: 100, endMs: 500 })
  })

  it('does not mutate the filter it is given', () => {
    const state = Object.freeze(
      filterOf({ agentIds: Object.freeze(['a_orchestrator']) }),
    )
    const next = reduceFilter(state, {
      type: 'setAgents',
      agentIds: ['a_orchestrator', 'a_worker_alpha'],
    })
    expect(next.agentIds).toEqual(['a_orchestrator', 'a_worker_alpha'])
    expect(state.agentIds).toEqual(['a_orchestrator'])
  })

  it('folds a session of actions deterministically', () => {
    const actions = [
      { type: 'toggleKind', kind: 'message' },
      { type: 'setAgents', agentIds: ['a_worker_alpha', 'a_orchestrator'] },
      { type: 'setWindow', window: { startMs: 0, endMs: 120_000 } },
    ] as const
    const once = actions.reduce(reduceFilter, IDENTITY_FILTER)
    const twice = actions.reduce(reduceFilter, IDENTITY_FILTER)
    expect(once).toEqual(twice)
    expect(once.agentIds).toEqual(['a_orchestrator', 'a_worker_alpha'])
    expect(once.kinds).toEqual(['tool_call'])
    expect(once.window).toEqual({ startMs: 0, endMs: 120_000 })
  })
})

describe('filter — the agent selection (needs the run)', () => {
  it('resolves an empty selection to every agent, canonically', () => {
    expect(resolveAgentIds(IDENTITY_FILTER, FAN_OUT_AGENTS.slice().reverse())).toEqual(
      FAN_OUT_AGENTS,
    )
  })

  it('resolves a selection to itself, canonically', () => {
    const filter = filterOf({ agentIds: ['a_worker_beta', 'a_orchestrator'] })
    expect(resolveAgentIds(filter, FAN_OUT_AGENTS)).toEqual([
      'a_orchestrator',
      'a_worker_beta',
    ])
  })

  it('toggles one agent off an unfiltered run, meaning "everyone but this one"', () => {
    const ids = toggleAgentSelection(IDENTITY_FILTER, 'a_orchestrator', FAN_OUT_AGENTS)
    expect(ids).toHaveLength(5)
    expect(ids).not.toContain('a_orchestrator')
    expect(ids).toEqual(FAN_OUT_AGENTS.filter((id) => id !== 'a_orchestrator'))
  })

  it('collapses back to the facet being off when the last agent is re-added', () => {
    const without = toggleAgentSelection(
      IDENTITY_FILTER,
      'a_orchestrator',
      FAN_OUT_AGENTS,
    )
    const filter = filterOf({ agentIds: without })
    expect(toggleAgentSelection(filter, 'a_orchestrator', FAN_OUT_AGENTS)).toEqual([])
  })

  it('adds a second agent to a one-agent selection', () => {
    const filter = filterOf({ agentIds: ['a_worker_gamma'] })
    expect(toggleAgentSelection(filter, 'a_worker_alpha', FAN_OUT_AGENTS)).toEqual([
      'a_worker_alpha',
      'a_worker_gamma',
    ])
  })

  it('ignores an agent the run does not have', () => {
    expect(toggleAgentSelection(IDENTITY_FILTER, 'a_ghost', FAN_OUT_AGENTS)).toEqual([])
    const filter = filterOf({ agentIds: ['a_worker_gamma'] })
    expect(toggleAgentSelection(filter, 'a_ghost', FAN_OUT_AGENTS)).toEqual([
      'a_worker_gamma',
    ])
  })

  it('isolates one agent, and refuses a ghost', () => {
    expect(isolateAgentSelection('a_worker_gamma', FAN_OUT_AGENTS)).toEqual([
      'a_worker_gamma',
    ])
    // A ghost cannot narrow the scene to an agent it does not have, so the facet
    // stays off.
    expect(isolateAgentSelection('a_ghost', FAN_OUT_AGENTS)).toEqual([])
  })
})

describe('filter — retaining a lens across a run swap', () => {
  it('drops selected agents the new run does not have', () => {
    const filter = filterOf({ agentIds: ['a_orchestrator', 'a_researcher'] })
    const retained = retainFilter(filter, FAN_OUT_AGENTS, 4 * MINUTE)
    expect(retained.agentIds).toEqual(['a_orchestrator'])
  })

  it('collapses a selection that still covers every agent', () => {
    const filter = filterOf({ agentIds: ['a_orchestrator', 'a_worker_ok'] })
    const retained = retainFilter(filter, ['a_orchestrator', 'a_worker_ok'], MINUTE)
    expect(retained.agentIds).toEqual([])
  })

  it('clamps a window past the new run’s end', () => {
    const filter = filterOf({ window: { startMs: MINUTE, endMs: 10 * MINUTE } })
    const retained = retainFilter(filter, FAN_OUT_AGENTS, 2 * MINUTE)
    expect(retained.window).toEqual({ startMs: MINUTE, endMs: 2 * MINUTE })
  })

  it('returns the same object when nothing had to change', () => {
    const filter = filterOf({
      agentIds: ['a_orchestrator'],
      window: { startMs: 0, endMs: MINUTE },
    })
    expect(retainFilter(filter, FAN_OUT_AGENTS, 4 * MINUTE)).toBe(filter)
    expect(retainFilter(IDENTITY_FILTER, FAN_OUT_AGENTS, 4 * MINUTE)).toBe(
      IDENTITY_FILTER,
    )
  })

  it('clamps a window to a zero-span run', () => {
    const filter = filterOf({ window: { startMs: 0, endMs: 5 * MINUTE } })
    expect(retainFilter(filter, ['a_orchestrator'], 0).window).toEqual({
      startMs: 0,
      endMs: 0,
    })
  })
})

describe('filter — predicates (M4-T5)', () => {
  it('keeps a message that touches a selected agent, from either side', () => {
    const filter = filterOf({ agentIds: ['a_worker_alpha'] })
    const assignment = FAN_OUT.messages.find(
      (message) => message.to === 'a_worker_alpha',
    )
    expect(assignment).toBeDefined()
    if (assignment === undefined) return
    expect(messageTouchesSelection(filter, assignment)).toBe(true)
    expect(matchesMessage(FAN_OUT, filter, assignment)).toBe(true)
  })

  it('drops a message between agents that are not selected', () => {
    const filter = filterOf({ agentIds: ['a_worker_alpha'] })
    const beta = FAN_OUT.messages.find((message) => message.to === 'a_worker_beta')
    expect(beta).toBeDefined()
    if (beta === undefined) return
    expect(messageTouchesSelection(filter, beta)).toBe(false)
    expect(matchesMessage(FAN_OUT, filter, beta)).toBe(false)
  })

  it('credits a broadcast to a selected agent other than its sender', () => {
    // A broadcast reaches every other agent, so a lens on a receiver keeps it —
    // and a lens on the sender alone keeps it too.
    const model = runOf([
      {
        id: 1,
        from_agent: 'orchestrator',
        to_agent: null,
        subject: 'all hands',
        body: JSON.stringify({ action: 'kickoff' }),
        status: 'unread',
        created_at: '2026-10-01T09:00:00.000Z',
      },
      {
        id: 2,
        from_agent: 'worker_a',
        to_agent: 'orchestrator',
        subject: 'ack',
        body: null,
        status: 'unread',
        created_at: '2026-10-01T09:01:00.000Z',
      },
    ])
    const broadcast = model.messages[0]
    expect(
      messageTouchesSelection(filterOf({ agentIds: ['a_worker_a'] }), broadcast),
    ).toBe(true)
    expect(
      messageTouchesSelection(filterOf({ agentIds: ['a_orchestrator'] }), broadcast),
    ).toBe(true)
    expect(
      matchesMessage(model, filterOf({ agentIds: ['a_worker_a'] }), broadcast),
    ).toBe(true)
  })

  it('drops every tool call when the kind facet excludes them', () => {
    const filter = filterOf({ kinds: ['message'] })
    for (const call of LOOP.toolCalls) {
      expect(matchesToolCall(LOOP, filter, call)).toBe(false)
    }
    // ...while the messages are untouched.
    expect(buildFilterView(LOOP, filter).messages.kept).toBe(7)
  })

  it('attributes a tool call to the agent that made it', () => {
    const filter = filterOf({ agentIds: ['a_worker_alpha'] })
    const orchestratorsCall = FAN_OUT.toolCalls[0]
    expect(orchestratorsCall.agentId).toBe('a_orchestrator')
    expect(matchesToolCall(FAN_OUT, filter, orchestratorsCall)).toBe(false)
    const ownFilter = filterOf({ agentIds: ['a_orchestrator'] })
    expect(matchesToolCall(FAN_OUT, ownFilter, orchestratorsCall)).toBe(true)
  })

  it('keeps the window’s edges inclusively and nothing outside', () => {
    const filter = filterOf({ window: { startMs: MINUTE, endMs: 2 * MINUTE } })
    const offsets = FAN_OUT.messages.map((message) =>
      inWindow(FAN_OUT, filter, message.at),
    )
    expect(offsets).toEqual([false, true, true, false, false])
    const view = buildFilterView(FAN_OUT, filter)
    expect(view.messages.kept).toBe(2)
    expect(view.toolCalls.kept).toBe(2)
  })

  it('keeps everything when the window is the whole run', () => {
    const filter = filterOf({ window: { startMs: 0, endMs: 4 * MINUTE } })
    expect(buildFilterView(FAN_OUT, filter).messages.kept).toBe(5)
    expect(buildFilterView(FAN_OUT, filter).active).toBe(true)
  })

  it('reports keepsKind for each facet member', () => {
    const filter = filterOf({ kinds: ['tool_call'] })
    expect(keepsKind(filter, 'tool_call')).toBe(true)
    expect(keepsKind(filter, 'message')).toBe(false)
  })
})

describe('filter — the view', () => {
  it('narrows to one agent’s subgraph without inventing a call for it', () => {
    const view = buildFilterView(FAN_OUT, filterOf({ agentIds: ['a_worker_alpha'] }))
    expect(view.messages).toEqual({ kept: 1, total: 5 })
    // The assignment's tool call belongs to the sender, not the recipient.
    expect(view.toolCalls).toEqual({ kept: 0, total: 5 })
    expect(view.agents).toEqual({ kept: 2, total: 6 })
    expect(view.empty).toBe(false)
    expect(view.label).toBe('2 of 6 agents · 1 of 5 messages · 0 of 5 tool calls')
  })

  it('keeps a terminal leaf’s inbound work when that leaf is selected', () => {
    const view = buildFilterView(
      DEAD_BRANCH,
      filterOf({ agentIds: ['a_worker_dead'], kinds: ['message'] }),
    )
    expect(view.messages).toEqual({ kept: 1, total: 3 })
    expect(view.agents.kept).toBe(2)
  })

  it('keeps the agents, drops the calls, when only messages are kept', () => {
    const view = buildFilterView(FAN_OUT, filterOf({ kinds: ['message'] }))
    expect(view.agents).toEqual({ kept: 6, total: 6 })
    expect(view.messages.kept).toBe(5)
    expect(view.toolCalls.kept).toBe(0)
  })

  it('narrows the loop to the critic’s own traffic when only the critic is selected', () => {
    const view = buildFilterView(LOOP, filterOf({ agentIds: ['a_critic'] }))
    // Three drafts in, three revisions out; the orchestrator's kickoff to the
    // researcher does not touch the critic, so it falls outside the lens.
    expect(view.messages).toEqual({ kept: 6, total: 7 })
    expect(view.agents).toEqual({ kept: 2, total: 3 })
  })

  it('reports an empty view when no event type is kept', () => {
    const view = buildFilterView(FAN_OUT, filterOf({ kinds: [] }))
    expect(view.empty).toBe(true)
    expect(view.messages).toEqual({ kept: 0, total: 5 })
    expect(view.toolCalls).toEqual({ kept: 0, total: 5 })
    expect(view.agents).toEqual({ kept: 0, total: 6 })
  })

  it('clamps the window to the run and labels it', () => {
    const view = buildFilterView(
      FAN_OUT,
      filterOf({ window: { startMs: 0, endMs: 10 * MINUTE } }),
    )
    expect(view.window).toEqual({ startMs: 0, endMs: 4 * MINUTE })
    expect(view.windowLabel).toBe('0.0s → 4:00')
    expect(view.messages.kept).toBe(5)
  })

  it('ignores a selection naming only agents the run does not have', () => {
    const view = buildFilterView(FAN_OUT, filterOf({ agentIds: ['a_ghost'] }))
    expect(view.agentIds).toEqual(FAN_OUT_AGENTS)
    expect(view.messages.kept).toBe(5)
    expect(view.active).toBe(false)
  })

  it('is well-formed for an empty run', () => {
    const empty = runOf([])
    const view = buildFilterView(empty, IDENTITY_FILTER)
    expect(view.empty).toBe(true)
    expect(view.agents).toEqual({ kept: 0, total: 0 })
    expect(view.spanMs).toBe(0)
    expect(view.label).toBe('0 of 0 agents · 0 of 0 messages · 0 of 0 tool calls')
  })

  it('is deterministic and does not mutate the model', () => {
    const before = JSON.stringify(FAN_OUT)
    const filter = filterOf({
      agentIds: ['a_orchestrator'],
      window: { startMs: MINUTE, endMs: 3 * MINUTE },
    })
    const once = buildFilterView(FAN_OUT, filter)
    const twice = buildFilterView(FAN_OUT, filter)
    expect(once).toEqual(twice)
    expect(JSON.stringify(FAN_OUT)).toBe(before)
  })

  it('is independent of the order the model’s arrays arrive in', () => {
    const shuffled: TraceModel = {
      ...FAN_OUT,
      agents: [...FAN_OUT.agents].reverse(),
      messages: [...FAN_OUT.messages].reverse(),
      toolCalls: [...FAN_OUT.toolCalls].reverse(),
    }
    const filter = filterOf({ kinds: ['tool_call'] })
    expect(buildFilterView(shuffled, filter)).toEqual(buildFilterView(FAN_OUT, filter))
  })
})

describe('filter — purity (PRD §5)', () => {
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

  const source = readFileSync(
    resolve(findRepoRoot(process.cwd()), 'src/filter/filter.ts'),
    'utf8',
  )
    // Drop comments so the module's own prose cannot trip the scan.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  it('reads no clock and no randomness', () => {
    expect(source).not.toMatch(/\bDate\.now\s*\(/)
    expect(source).not.toMatch(/\bperformance\.now\s*\(/)
    expect(source).not.toMatch(/\bMath\.random\s*\(/)
    expect(source).not.toMatch(/\bnew Date\s*\(/)
  })

  it('imports no React, no three.js and touches no DOM', () => {
    expect(source).not.toMatch(/from\s+['"]react['"]/)
    expect(source).not.toMatch(/from\s+['"]three['"]/)
    expect(source).not.toMatch(/\bdocument\./)
    expect(source).not.toMatch(/\baddEventListener\b/)
  })
})
