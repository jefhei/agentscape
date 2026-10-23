import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import type { AgentMessageRow } from '../adapter/index.ts'
import { buildFixture } from '../fixtures/index.ts'
import { normalizeTrace } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'
import type { Agent, Message, Run, ToolCall } from '../types/index.ts'
import { deriveEdgeModel } from '../layout/index.ts'
import type { EdgeModel } from '../layout/index.ts'
import {
  ARG_SUMMARY_LIMIT,
  InspectError,
  buildAgentDetail,
  describeAgentTiming,
  describeMessageDirection,
  formatCost,
  formatShare,
  formatTokens,
  summarizeArgs,
} from './inspect.ts'
import type { AgentDetail } from './inspect.ts'

/**
 * Tests for the agent detail model (M4-T4) — the pure half of the node
 * inspector.
 *
 * Two kinds of fixture are used deliberately:
 *
 * - the **reference fixtures** (M1-T6), fed through the real ingest path, for
 *   everything about structure: which messages belong to an agent, direction,
 *   counterparts, lineage, ordering;
 * - a **hand-built costed run** for money and time, because the `agent_messages`
 *   adapter attributes `0` tokens and `0` cost by design (the export has no
 *   columns for them). Building a `Run` and normalizing it is the only way to
 *   exercise the itemised attribution at non-zero values — and it also proves the
 *   detail's sums are checked against the model's.
 *
 * Nothing about how the panel *looks* is asserted (jsdom has no GPU/layout; the
 * look is human-held, M5-T5).
 */

const FAN_OUT = buildFixture('fan-out').run
const DEAD_BRANCH = buildFixture('dead-branch').run

const BASE = Date.parse('2026-01-01T00:00:00.000Z')
const SECOND = 1_000

/** A run from explicit rows, through the real ingest path. */
function modelFrom(rows: readonly AgentMessageRow[]): TraceModel {
  return normalizeTrace(parseAgentMessagesExport(rows))
}

/** A minimal agent record; normalization recomputes every count. */
function agent(id: string, name = id): Agent {
  return {
    id,
    name,
    role: 'unknown',
    parentId: null,
    firstSeenAt: 0,
    lastSeenAt: 0,
    messagesSent: 0,
    messagesReceived: 0,
    tokens: 0,
    costUsd: 0,
  }
}

/** A message with the fields the detail model reads. */
function message(
  id: string,
  from: string,
  to: string | null,
  at: number,
  extras: Partial<Message> = {},
): Message {
  return {
    id,
    from,
    to,
    subject: `${from} → ${to ?? 'all'}`,
    body: '',
    payload: null,
    action: null,
    status: 'unread',
    at,
    tokens: 0,
    costUsd: 0,
    ...extras,
  }
}

/** A tool call attributed to one agent. */
function toolCall(
  id: string,
  agentId: string,
  at: number,
  extras: Partial<ToolCall> = {},
): ToolCall {
  return {
    id,
    agentId,
    name: 'fetch',
    messageId: null,
    at,
    args: {},
    durationMs: null,
    costUsd: 0,
    ...extras,
  }
}

/**
 * A two-agent run with real money in it:
 *
 * - `orchestrator` sends `m1` (120 tok, $0.0012) and a broadcast `m3`
 *   (10 tok, $0.0001) at +120s, and receives `m2`;
 * - `worker` sends `m2` (30 tok, $0.0003) at +60s and makes two tool calls
 *   (`tc1`, 1200 ms, $0.0009 at +30s; `tc2`, unknown duration, free at +90s);
 * - `ghost` is a participant with no activity at all.
 */
function costedModel(): TraceModel {
  const run: Run = {
    id: 'r_costed',
    label: 'costed',
    source: 'agent_messages',
    seed: 11,
    agents: [agent('a_orchestrator'), agent('a_worker'), agent('a_ghost')],
    messages: [
      message('m1', 'a_orchestrator', 'a_worker', BASE, {
        subject: 'kickoff',
        action: 'assign_task',
        tokens: 120,
        costUsd: 0.0012,
      }),
      message('m2', 'a_worker', 'a_orchestrator', BASE + 60 * SECOND, {
        subject: 'done',
        action: 'task_complete',
        tokens: 30,
        costUsd: 0.0003,
      }),
      message('m3', 'a_orchestrator', null, BASE + 120 * SECOND, {
        subject: 'ship it',
        tokens: 10,
        costUsd: 0.0001,
      }),
    ],
    toolCalls: [
      toolCall('tc1', 'a_worker', BASE + 30 * SECOND, {
        name: 'fetch',
        messageId: 'm1',
        args: { url: 'https://example.test/a', retries: 2 },
        durationMs: 1200,
        costUsd: 0.0009,
      }),
      toolCall('tc2', 'a_worker', BASE + 90 * SECOND, { name: 'summarize' }),
    ],
    events: [
      {
        id: 'e1',
        kind: 'run_start',
        at: BASE,
        sequence: 0,
        agentId: null,
        label: 'start',
      },
      {
        id: 'e2',
        kind: 'run_end',
        at: BASE + 120 * SECOND,
        sequence: 1,
        agentId: null,
        label: 'end',
      },
    ],
    startedAt: BASE,
    endedAt: BASE + 120 * SECOND,
    meta: {
      agentCount: 3,
      messageCount: 3,
      toolCallCount: 2,
      eventCount: 2,
      broadcastCount: 1,
      durationMs: 120 * SECOND,
      totalTokens: 0,
      totalCostUsd: 0,
    },
  }
  return normalizeTrace(run)
}

const COSTED = costedModel()

/**
 * A three-message run from the real ingest path, shaped so one agent clearly
 * stops before the run ends: the worker receives at +0s and replies at +60s,
 * while the orchestrator is still assigning at +120s.
 */
function timingModel(): TraceModel {
  return modelFrom([
    {
      id: 1,
      from_agent: 'orchestrator',
      to_agent: 'worker',
      created_at: '2026-01-01T00:00:00.000Z',
      subject: 'assign',
    },
    {
      id: 2,
      from_agent: 'worker',
      to_agent: 'orchestrator',
      created_at: '2026-01-01T00:01:00.000Z',
      subject: 'done',
    },
    {
      id: 3,
      from_agent: 'orchestrator',
      to_agent: 'other',
      created_at: '2026-01-01T00:02:00.000Z',
      subject: 'assign to someone else',
    },
  ])
}

/**
 * A run with a participant that is never mentioned: no message, no tool call,
 * and (deliberately) no broadcast, because a broadcast is heard by everyone and
 * would give the silent agent activity.
 */
function inactiveModel(): TraceModel {
  const run: Run = {
    id: 'r_inactive',
    label: 'inactive',
    source: 'agent_messages',
    seed: 5,
    agents: [agent('a_busy'), agent('a_silent')],
    messages: [message('m1', 'a_busy', 'a_busy', BASE)],
    toolCalls: [],
    events: [],
    startedAt: BASE,
    endedAt: BASE,
    meta: {
      agentCount: 2,
      messageCount: 1,
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

/** The detail for one agent, asserted present. */
function detailOf(model: TraceModel, agentId: string, elapsedMs?: number): AgentDetail {
  const detail = buildAgentDetail(model, agentId, { elapsedMs })
  expect(detail).not.toBeNull()
  return detail as AgentDetail
}

// ── identity + lineage ──────────────────────────────────────────────────────

describe('buildAgentDetail — identity and derived lineage (M4-T4)', () => {
  it('returns null for an agent the run does not have', () => {
    expect(buildAgentDetail(FAN_OUT, 'a_ghost')).toBeNull()
    expect(buildAgentDetail(FAN_OUT, '')).toBeNull()
    expect(buildAgentDetail(modelFrom([]), 'a_anyone')).toBeNull()
  })

  it('describes the coordinator: root of the run, five children', () => {
    const detail = detailOf(FAN_OUT, 'a_orchestrator')
    expect(detail.name).toBe('orchestrator')
    expect(detail.agent.id).toBe('a_orchestrator')
    // The role and parent are the *derived* ones (M2-T4), not the contract's
    // placeholder `unknown` / `null`.
    expect(detail.relations.role).toBe('coordinator')
    expect(detail.relations.parentId).toBeNull()
    expect(detail.relations.parentName).toBeNull()
    expect(detail.relations.fanOut).toBe(5)
    expect(detail.relations.childNames).toEqual([
      'worker_alpha',
      'worker_beta',
      'worker_delta',
      'worker_epsilon',
      'worker_gamma',
    ])
    // Every one of those spawns is an outgoing spawn edge; nothing points back.
    expect(detail.relations.outgoing.spawn).toBe(5)
    expect(detail.relations.incoming.spawn).toBe(0)
    expect(detail.relations.peerIds).toHaveLength(5)
  })

  it('describes a worker: spawned by the coordinator, no children', () => {
    const detail = detailOf(FAN_OUT, 'a_worker_alpha')
    expect(detail.relations.role).toBe('worker')
    expect(detail.relations.parentId).toBe('a_orchestrator')
    expect(detail.relations.parentName).toBe('orchestrator')
    expect(detail.relations.childIds).toEqual([])
    expect(detail.relations.fanOut).toBe(0)
    expect(detail.relations.incoming.spawn).toBe(1)
    expect(detail.relations.peerNames).toEqual(['orchestrator'])
  })

  it('carries the model’s own agent record through unchanged', () => {
    const detail = detailOf(FAN_OUT, 'a_orchestrator')
    const fromModel = FAN_OUT.agents.find((entry) => entry.id === 'a_orchestrator')
    expect(detail.agent).toEqual(fromModel)
    expect(detail.name).toBe(fromModel?.name)
  })

  it('is typed as a nullable detail, so a caller must handle the miss', () => {
    expectTypeOf(
      buildAgentDetail(FAN_OUT, 'a_orchestrator'),
    ).toEqualTypeOf<AgentDetail | null>()
  })
})

// ── messages ────────────────────────────────────────────────────────────────

describe('buildAgentDetail — messages (M4-T4)', () => {
  it('lists only this agent’s messages, one entry each, in canonical order', () => {
    const detail = detailOf(FAN_OUT, 'a_orchestrator')
    expect(detail.messages.map((entry) => entry.messageId)).toEqual([
      'm_1001',
      'm_1002',
      'm_1003',
      'm_1004',
      'm_1005',
    ])
    expect(detail.messages.every((entry) => entry.direction === 'sent')).toBe(true)
    expect(detail.messages.map((entry) => entry.offsetMs)).toEqual([
      0, 60_000, 120_000, 180_000, 240_000,
    ])
    expect(detail.counts.sent).toBe(5)
    expect(detail.counts.received).toBe(0)
  })

  it('a received message names its sender as the counterpart', () => {
    const detail = detailOf(FAN_OUT, 'a_worker_alpha')
    expect(detail.messages).toHaveLength(1)
    const [entry] = detail.messages
    expect(entry.messageId).toBe('m_1001')
    expect(entry.direction).toBe('received')
    expect(entry.broadcast).toBe(false)
    expect(entry.counterpartId).toBe('a_orchestrator')
    expect(entry.counterpartName).toBe('orchestrator')
    expect(entry.subject).toBe('Assign task: alpha')
    expect(entry.action).toBe('assign_task')
    expect(describeMessageDirection(entry)).toBe('from orchestrator')
    expect(detail.counts.received).toBe(1)
    expect(detail.counts.sent).toBe(0)
  })

  it('counts an unseen worker’s assignment without inventing a reply', () => {
    // The dead branch: worker_dead receives one assignment and is never heard
    // from again — the panel must say exactly that.
    const detail = detailOf(DEAD_BRANCH, 'a_worker_dead')
    expect(detail.counts.sent).toBe(0)
    expect(detail.counts.received).toBe(1)
    expect(detail.messages[0].subject).toBe('Assign task: dead')
    expect(detail.timing.elapsedStartMs).toBe(120_000)
    expect(detail.timing.quietAfterMs).toBe(0)
  })

  it('a broadcast is heard by every other agent, and named as one', () => {
    const model = modelFrom([
      {
        id: 1,
        from_agent: 'orchestrator',
        to_agent: 'worker',
        created_at: '2026-01-01T00:00:00.000Z',
        subject: 'hello',
      },
      {
        id: 2,
        from_agent: 'orchestrator',
        to_agent: null,
        created_at: '2026-01-01T00:01:00.000Z',
        subject: 'all hands',
      },
    ])
    const heard = detailOf(model, 'a_worker')
    expect(heard.counts.received).toBe(2)
    expect(heard.counts.broadcastsHeard).toBe(1)
    expect(heard.counts.broadcastsSent).toBe(0)
    const broadcast = heard.messages.find((entry) => entry.messageId === 'm_2')
    expect(broadcast?.broadcast).toBe(true)
    expect(broadcast?.counterpartId).toBe('a_orchestrator')
    expect(describeMessageDirection(broadcast!)).toBe('from orchestrator (broadcast)')

    // And the sender of that broadcast sent it — it is not one of its listeners.
    const sender = detailOf(model, 'a_orchestrator')
    expect(sender.counts.broadcastsSent).toBe(1)
    expect(sender.counts.broadcastsHeard).toBe(0)
    expect(
      sender.messages.find((entry) => entry.messageId === 'm_2')?.counterpartId,
    ).toBeNull()
    expect(describeMessageDirection(sender.messages[1])).toBe('to all agents')
  })

  it('a self-message appears once, as sent', () => {
    const model = modelFrom([
      {
        id: 1,
        from_agent: 'solo',
        to_agent: 'solo',
        created_at: '2026-01-01T00:00:00.000Z',
        subject: 'note to self',
      },
    ])
    const detail = detailOf(model, 'a_solo')
    expect(detail.messages).toHaveLength(1)
    expect(detail.messages[0].direction).toBe('sent')
    expect(detail.counts.sent).toBe(1)
    expect(detail.counts.received).toBe(0)
  })

  it('keeps the payload, status, tokens and cost of each message', () => {
    const detail = detailOf(COSTED, 'a_worker')
    const first = detail.messages[0]
    expect(first.status).toBe('unread')
    expect(first.tokens).toBe(120)
    expect(first.costUsd).toBe(0.0012)
    expect(first.subject).toBe('kickoff')
    expect(first.action).toBe('assign_task')
  })
})

// ── tool calls ──────────────────────────────────────────────────────────────

describe('buildAgentDetail — tool calls (M4-T4)', () => {
  it('lists only the agent’s own calls, with time, duration and cost', () => {
    const detail = detailOf(COSTED, 'a_worker')
    expect(detail.toolCalls.map((entry) => entry.toolCallId)).toEqual(['tc1', 'tc2'])
    expect(detail.counts.toolCalls).toBe(2)
    const [first, second] = detail.toolCalls
    expect(first.name).toBe('fetch')
    expect(first.messageId).toBe('m1')
    expect(first.offsetMs).toBe(30_000)
    expect(first.durationMs).toBe(1200)
    expect(first.costUsd).toBe(0.0009)
    expect(second.durationMs).toBeNull()
    expect(detail.timing.toolTimeMs).toBe(1200)
    expect(detail.timing.longestToolMs).toBe(1200)
  })

  it('summarizes the arguments deterministically', () => {
    const detail = detailOf(COSTED, 'a_worker')
    expect(detail.toolCalls[0].argSummary).toBe('url=https://example.test/a, retries=2')
    expect(detail.toolCalls[1].argSummary).toBe('')
  })

  it('shows no tool time when no duration was recorded', () => {
    const detail = detailOf(COSTED, 'a_orchestrator')
    expect(detail.toolCalls).toEqual([])
    expect(detail.timing.toolTimeMs).toBe(0)
    expect(detail.timing.longestToolMs).toBeNull()
  })

  it('derives the agent’s action-named calls from the real ingest path', () => {
    // The adapter mints one tool call per action-bearing message: the panel is
    // showing the same calls the glyph layer draws (M3-T3).
    const detail = detailOf(FAN_OUT, 'a_orchestrator')
    expect(detail.toolCalls).toHaveLength(5)
    expect(detail.toolCalls.map((entry) => entry.name)).toEqual([
      'assign_task',
      'assign_task',
      'assign_task',
      'assign_task',
      'assign_task',
    ])
    expect(detail.toolCalls[0].messageId).toBe('m_1001')
  })
})

// ── timing ──────────────────────────────────────────────────────────────────

describe('buildAgentDetail — timing (M4-T4)', () => {
  it('reports the activity window, its share of the run and the quiet tail', () => {
    const model = timingModel()
    const detail = detailOf(model, 'a_worker')
    expect(detail.timing.active).toBe(true)
    expect(detail.timing.runSpanMs).toBe(120 * SECOND)
    expect(detail.timing.elapsedStartMs).toBe(0)
    expect(detail.timing.elapsedEndMs).toBe(60 * SECOND)
    expect(detail.timing.activeMs).toBe(60 * SECOND)
    expect(detail.timing.share).toBe(0.5)
    expect(detail.timing.quietAfterMs).toBe(60 * SECOND)
    expect(detail.timing.firstAt).toBe(BASE)
    expect(detail.timing.lastAt).toBe(BASE + 60 * SECOND)

    // The orchestrator was still working at the end: no quiet tail.
    const orchestrator = detailOf(model, 'a_orchestrator')
    expect(orchestrator.timing.elapsedEndMs).toBe(120 * SECOND)
    expect(orchestrator.timing.share).toBe(1)
    expect(orchestrator.timing.quietAfterMs).toBe(0)
  })

  it('counts a heard broadcast as activity (it is part of the run)', () => {
    // The costed run ends with a broadcast from the orchestrator, which the
    // worker hears — so the worker is active right to the end of the run.
    const detail = detailOf(COSTED, 'a_worker')
    expect(detail.timing.elapsedEndMs).toBe(120 * SECOND)
    expect(detail.timing.share).toBe(1)
    expect(detail.messages.at(-1)?.broadcast).toBe(true)
  })

  it('reports an agent with no activity as inactive, with null times (not epoch 0)', () => {
    const detail = detailOf(inactiveModel(), 'a_silent')
    expect(detail.timing.active).toBe(false)
    expect(detail.timing.firstAt).toBeNull()
    expect(detail.timing.lastAt).toBeNull()
    expect(detail.timing.elapsedStartMs).toBeNull()
    expect(detail.timing.elapsedEndMs).toBeNull()
    expect(detail.timing.quietAfterMs).toBeNull()
    expect(detail.timing.activeMs).toBe(0)
    expect(detail.timing.share).toBe(0)
    expect(describeAgentTiming(detail.timing)).toBeNull()
  })

  it('is IEEE-finite on a zero-span run (every event at one instant)', () => {
    const model = modelFrom([
      {
        id: 1,
        from_agent: 'orchestrator',
        to_agent: 'worker',
        created_at: '2026-01-01T00:00:00.000Z',
        subject: 'one shot',
      },
    ])
    const detail = detailOf(model, 'a_worker')
    expect(detail.timing.runSpanMs).toBe(0)
    expect(detail.timing.share).toBe(0)
    expect(detail.timing.activeMs).toBe(0)
    expect(Number.isFinite(detail.timing.share)).toBe(true)
  })

  it('formats its own summary line from the pure numbers', () => {
    const detail = detailOf(timingModel(), 'a_worker')
    expect(describeAgentTiming(detail.timing)).toBe(
      '0.0s → 1:00 · active 1:00 (50% of the run)',
    )
  })
})

// ── attribution ─────────────────────────────────────────────────────────────

describe('buildAgentDetail — attribution (M4-T4)', () => {
  it('items tokens and spend, split between messages sent and calls made', () => {
    const orchestrator = detailOf(COSTED, 'a_orchestrator')
    expect(orchestrator.attribution.tokens).toBe(130)
    expect(orchestrator.attribution.messageCostUsd).toBeCloseTo(0.0013, 12)
    expect(orchestrator.attribution.toolCallCostUsd).toBe(0)
    expect(orchestrator.attribution.costUsd).toBeCloseTo(0.0013, 12)
    // 130 of the run's 160 tokens; 1.3 of its 2.5 milli-dollars.
    expect(orchestrator.attribution.tokenShare).toBeCloseTo(130 / 160, 12)
    expect(orchestrator.attribution.costShare).toBeCloseTo(0.52, 12)
    expect(orchestrator.attribution.tokensPerSentMessage).toBeCloseTo(130 / 2, 12)

    const worker = detailOf(COSTED, 'a_worker')
    expect(worker.attribution.tokens).toBe(30)
    expect(worker.attribution.messageCostUsd).toBeCloseTo(0.0003, 12)
    expect(worker.attribution.toolCallCostUsd).toBeCloseTo(0.0009, 12)
    expect(worker.attribution.costUsd).toBeCloseTo(0.0012, 12)
    expect(worker.attribution.tokenShare).toBeCloseTo(30 / 160, 12)
    expect(worker.attribution.costShare).toBeCloseTo(0.0012 / 0.0025, 12)
  })

  it('agrees with the model’s own per-agent totals', () => {
    for (const record of COSTED.agents) {
      const detail = detailOf(COSTED, record.id)
      expect(detail.attribution.tokens, record.id).toBe(record.tokens)
      expect(detail.attribution.costUsd, record.id).toBeCloseTo(record.costUsd, 12)
    }
  })

  it('reports no per-message figure for an agent that sent nothing', () => {
    const ghost = detailOf(COSTED, 'a_ghost')
    expect(ghost.attribution.tokensPerSentMessage).toBeNull()
    expect(ghost.attribution.tokens).toBe(0)
    expect(ghost.attribution.costUsd).toBe(0)
    expect(ghost.attribution.tokenShare).toBe(0)
    expect(ghost.attribution.costShare).toBe(0)
  })

  it('never divides by a zero run total', () => {
    // The fixture adapter reports 0 tokens and $0 cost for every run, so this is
    // the common case, not an edge case.
    const detail = detailOf(FAN_OUT, 'a_orchestrator')
    expect(detail.attribution.tokens).toBe(0)
    expect(detail.attribution.costUsd).toBe(0)
    expect(detail.attribution.tokenShare).toBe(0)
    expect(detail.attribution.costShare).toBe(0)
    expect(Number.isFinite(detail.attribution.tokensPerSentMessage ?? 0)).toBe(true)
    expect(detail.attribution.tokensPerSentMessage).toBe(0)
  })

  it('throws when the itemised attribution cannot reproduce the model’s total', () => {
    const broken: TraceModel = {
      ...COSTED,
      agents: COSTED.agents.map((record) =>
        record.id === 'a_worker'
          ? { ...record, costUsd: record.costUsd + 0.01 }
          : record,
      ),
    }
    expect(() => buildAgentDetail(broken, 'a_worker')).toThrow(InspectError)
    expect(() => buildAgentDetail(broken, 'a_worker')).toThrow(/cost attribution drift/)

    const wrongTokens: TraceModel = {
      ...COSTED,
      agents: COSTED.agents.map((record) =>
        record.id === 'a_worker' ? { ...record, tokens: record.tokens + 5 } : record,
      ),
    }
    expect(() => buildAgentDetail(wrongTokens, 'a_worker')).toThrow(
      /token attribution drift/,
    )
    // ...and the other agents are unaffected by a broken sibling's numbers.
    expect(() => buildAgentDetail(broken, 'a_orchestrator')).not.toThrow()
  })

  it('throws when the edge model has no lineage for the agent', () => {
    const emptyEdges: EdgeModel = {
      ...deriveEdgeModel(COSTED),
      agents: [],
    }
    expect(() =>
      buildAgentDetail(COSTED, 'a_worker', { edgeModel: emptyEdges }),
    ).toThrow(InspectError)
  })
})

// ── playhead ────────────────────────────────────────────────────────────────

describe('buildAgentDetail — the playhead (M4-T4)', () => {
  it('marks rows the run has not reached as pending', () => {
    const detail = detailOf(COSTED, 'a_worker', 45 * SECOND)
    expect(detail.elapsedMs).toBe(45 * SECOND)
    // Received at +0s, sent at +60s, heard the broadcast at +120s.
    expect(detail.messages.map((entry) => entry.fired)).toEqual([true, false, false])
    expect(detail.toolCalls.map((entry) => entry.fired)).toEqual([true, false])
  })

  it('treats everything as fired with no playhead, and says so', () => {
    const detail = detailOf(COSTED, 'a_worker')
    expect(detail.elapsedMs).toBeNull()
    expect(detail.messages.every((entry) => entry.fired)).toBe(true)
    expect(detail.toolCalls.every((entry) => entry.fired)).toBe(true)
  })

  it('marks an event exactly at the playhead as fired (inclusive)', () => {
    const detail = detailOf(COSTED, 'a_worker', 60 * SECOND)
    expect(detail.messages.find((entry) => entry.messageId === 'm2')?.fired).toBe(true)
    expect(detail.toolCalls.find((entry) => entry.toolCallId === 'tc2')?.fired).toBe(
      false,
    )
  })

  it('ignores a negative or non-finite playhead rather than poisoning the flags', () => {
    for (const elapsedMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const detail = detailOf(COSTED, 'a_worker', elapsedMs)
      expect(detail.elapsedMs).toBeNull()
      expect(detail.messages.every((entry) => entry.fired)).toBe(true)
    }
  })
})

// ── determinism + purity ────────────────────────────────────────────────────

describe('buildAgentDetail — determinism and purity (M4-T4)', () => {
  it('is byte-identical across two builds', () => {
    for (const id of ['a_orchestrator', 'a_worker', 'a_ghost']) {
      const first = JSON.stringify(buildAgentDetail(COSTED, id, { elapsedMs: 30_000 }))
      const second = JSON.stringify(buildAgentDetail(COSTED, id, { elapsedMs: 30_000 }))
      expect(second, id).toBe(first)
    }
  })

  it('does not depend on the order of the model’s arrays', () => {
    const scrambled: TraceModel = {
      ...COSTED,
      agents: [...COSTED.agents].reverse(),
      messages: [...COSTED.messages].reverse(),
      toolCalls: [...COSTED.toolCalls].reverse(),
    }
    for (const id of ['a_orchestrator', 'a_worker']) {
      expect(JSON.stringify(buildAgentDetail(scrambled, id)), id).toBe(
        JSON.stringify(buildAgentDetail(COSTED, id)),
      )
    }
  })

  it('does not mutate the model', () => {
    const before = JSON.stringify(COSTED)
    buildAgentDetail(COSTED, 'a_worker', { elapsedMs: 1 })
    expect(JSON.stringify(COSTED)).toBe(before)
  })

  it('gives each call its own entry objects (no shared identity)', () => {
    const first = detailOf(COSTED, 'a_worker')
    const second = detailOf(COSTED, 'a_worker')
    expect(first.messages[0]).not.toBe(second.messages[0])
    expect(first.messages[0]).toEqual(second.messages[0])
  })

  it('reuses a supplied edge model instead of deriving its own', () => {
    const edges = deriveEdgeModel(COSTED)
    const withEdges = buildAgentDetail(COSTED, 'a_worker', { edgeModel: edges })
    expect(withEdges).toEqual(buildAgentDetail(COSTED, 'a_worker'))
    // The supplied model is the one that was read: break its lineage and the
    // detail follows the broken input, proving it was not re-derived.
    const noChildren: EdgeModel = {
      ...edges,
      agents: edges.agents.map((lineage) =>
        lineage.agentId === 'a_worker' ? { ...lineage, role: 'external' } : lineage,
      ),
    }
    expect(
      buildAgentDetail(COSTED, 'a_worker', { edgeModel: noChildren })?.relations.role,
    ).toBe('external')
  })
})

// ── formatters ──────────────────────────────────────────────────────────────

describe('inspect formatters (M4-T4)', () => {
  it('formats token counts with thousands separators', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(912)).toBe('912')
    expect(formatTokens(12_480)).toBe('12,480')
    expect(formatTokens(1_234_567)).toBe('1,234,567')
    expect(formatTokens(-5)).toBe('0')
    expect(formatTokens(Number.NaN)).toBe('0')
  })

  it('formats money at a precision that is honest for LLM bills', () => {
    expect(formatCost(0)).toBe('$0.00')
    expect(formatCost(0.0042)).toBe('$0.0042')
    expect(formatCost(0.009)).toBe('$0.0090')
    expect(formatCost(1.5)).toBe('$1.50')
    expect(formatCost(1234.567)).toBe('$1,234.57')
    expect(formatCost(-1)).toBe('$0.00')
    expect(formatCost(Number.NaN)).toBe('$0.00')
  })

  it('formats shares as percentages, distinguishing "tiny" from "none"', () => {
    expect(formatShare(0)).toBe('0%')
    expect(formatShare(0.001)).toBe('<1%')
    expect(formatShare(0.37)).toBe('37%')
    expect(formatShare(1)).toBe('100%')
    expect(formatShare(1.5)).toBe('100%')
    expect(formatShare(Number.NaN)).toBe('0%')
  })

  it('summarizes tool arguments, capped and deterministic', () => {
    expect(summarizeArgs({})).toBe('')
    expect(summarizeArgs(null)).toBe('')
    expect(summarizeArgs(undefined)).toBe('')
    expect(summarizeArgs({ cycle: 2, verdict: 'revise' })).toBe(
      'cycle=2, verdict=revise',
    )
    expect(summarizeArgs({ a: 1, b: 2, c: 3, d: 4 })).toBe(`a=1, b=2, c=3, +1 more`)
    expect(ARG_SUMMARY_LIMIT).toBe(3)
    expect(summarizeArgs({ a: 1, b: 2 }, 1)).toBe('a=1, +1 more')
    expect(summarizeArgs({ a: { nested: true } })).toBe('a={"nested":true}')
    expect(summarizeArgs({ a: null, b: true })).toBe('a=null, b=true')
    // A long value is elided, and the elision is deterministic.
    const long = summarizeArgs({ url: 'x'.repeat(60) })
    expect(long.startsWith('url=xxxxxxxx')).toBe(true)
    expect(long.endsWith('…')).toBe(true)
    expect(long.length).toBeLessThan(60)
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

describe('inspect — purity (M4-T4)', () => {
  const root = findRepoRoot(process.cwd())
  const source = readFileSync(resolve(root, 'src/inspect/inspect.ts'), 'utf8')
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

  it('imports the pure clock-formatter, not the React barrel', () => {
    expect(source).toMatch(/from '\.\.\/playback\/playback\.ts'/)
    expect(source).not.toMatch(/from '\.\.\/playback\/index\.ts'/)
  })
})
