import { describe, expect, expectTypeOf, it } from 'vitest'
import type { AgentMessageRow } from '../adapter/index.ts'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import type { Event, Run } from '../types/index.ts'
import { isMessageEvent } from '../types/index.ts'
import type { TraceModel } from './index.ts'
import { compareModelIds, normalizeTrace, TraceModelError } from './index.ts'

/**
 * TraceModel normalization pass tests (M1-T5).
 *
 * The normalizer is the single place that pins the contract's structural
 * invariants, so these tests gate them hard — the whole point of the pure data
 * layer (PRD §5):
 *
 *  1. **Canonical order** — every collection is sorted into a deterministic
 *     total order, independent of the order the arrays arrived in.
 *  2. **Determinism** — the same facts in ⇒ byte-identical model out, even
 *     when the input arrays are shuffled and its `sequence` values are garbage.
 *  3. **Recomputation** — derived/precomputed fields (per-agent counts, the
 *     span, the whole `RunMeta`) are rebuilt from the facts, so a stale value
 *     cannot survive.
 *  4. **Integrity** — a dangling reference or a mis-attributed lifecycle event
 *     throws `TraceModelError`, loudly, rather than rendering a wrong scene.
 *
 * No visuals are asserted here — jsdom has no GPU, and the look is human-held
 * (M5-T5). Only the pure half is gated.
 */

/** Realistic `agent_messages` rows in the pipeline's own shape. */
const ROWS: AgentMessageRow[] = [
  {
    id: 148,
    from_agent: 'hermes_bot',
    to_agent: 'debian2_bot',
    subject: 'Research brief ready: kernel_headroom',
    body: '{"action":"research_brief_ready","brief_id":28,"topic":"kernel_headroom","video_id":127}',
    status: 'read',
    created_at: '2026-09-24T07:41:29.379292+00:00',
  },
  {
    id: 149,
    from_agent: 'hermes_bot',
    to_agent: 'debian2_bot',
    subject: 'Script ready for review: kernel_headroom',
    body: '{"action":"script_ready","table":"scripts","topic":"kernel_headroom","version":1,"video_id":127}',
    status: 'read',
    created_at: '2026-09-24T07:41:29.9937+00:00',
  },
  {
    id: 150,
    from_agent: 'debian2_bot',
    to_agent: 'hermes_bot',
    subject: 'Re: Script ready for review: kernel_headroom',
    body: '{"action":"review_complete","verdict":"approved_for_jeff_review_gate","video_id":127,"script_id":28}',
    status: 'read',
    created_at: '2026-09-24T09:43:16.79584+00:00',
  },
  {
    id: 151,
    from_agent: 'debian2_bot',
    to_agent: null,
    subject: 'Fleet notice: research queue drained',
    body: '{"action":"broadcast_notice","message":"queue drained"}',
    status: 'unread',
    created_at: '2026-09-24T10:00:00.000000+00:00',
  },
  {
    id: 152,
    from_agent: 'herm_bot',
    to_agent: 'debian2_bot',
    subject: 'Tool output (unstructured)',
    body: 'not json at all',
    status: 'read',
    created_at: '2026-09-24T10:05:00.000000+00:00',
  },
  {
    id: 153,
    from_agent: 'Host_hermes_bot',
    to_agent: 'debian2_bot',
    subject: 'VPS heartbeat',
    body: null,
    status: null,
    created_at: '2026-09-24T11:00:00.000000+00:00',
  },
]

/** A run as the adapter (M1-T4) emits it — already canonically ordered. */
const run: Run = parseAgentMessagesExport(ROWS)

describe('normalizeTrace — canonical shape (M1-T5)', () => {
  it('returns a fully-formed TraceModel (compile-checked against the contract)', () => {
    const model = normalizeTrace(run)
    expectTypeOf(model).toEqualTypeOf<TraceModel>()
    expectTypeOf(model).toEqualTypeOf<Run>()
    expect(model.source).toBe('agent_messages')
    expect(typeof model.seed).toBe('number')
    expect(model.id).toBe(run.id)
    expect(model.label).toBe(run.label)
  })

  it('does not disturb a canonically-ordered adapter Run', () => {
    // Strongest composition check: recomputing every derived field from the
    // facts must land on exactly what the adapter already produced.
    expect(JSON.stringify(normalizeTrace(run))).toBe(JSON.stringify(run))
  })

  it('is a fixed point — normalizing twice changes nothing', () => {
    expect(JSON.stringify(normalizeTrace(normalizeTrace(run)))).toBe(
      JSON.stringify(normalizeTrace(run)),
    )
  })

  it('assigns a contiguous 0-based sequence in canonical event order', () => {
    const model = normalizeTrace(run)
    model.events.forEach((event, index) => expect(event.sequence).toBe(index))
    expect(model.events[0].kind).toBe('run_start')
    expect(model.events[model.events.length - 1].kind).toBe('run_end')
  })

  it('orders agents by id and messages / tool calls by time then id', () => {
    const model = normalizeTrace(run)

    const agentIds = model.agents.map((agent) => agent.id)
    expect(agentIds).toEqual([...agentIds].sort(compareModelIds))

    for (const list of [model.messages, model.toolCalls]) {
      for (let i = 1; i < list.length; i += 1) {
        const prev = list[i - 1]
        const curr = list[i]
        expect(prev.at <= curr.at).toBe(true)
        if (prev.at === curr.at) {
          expect(compareModelIds(prev.id, curr.id)).toBeLessThan(0)
        }
      }
    }
  })

  it('recomputes every derived field from the facts', () => {
    const corrupt: Run = {
      ...run,
      startedAt: -1,
      endedAt: -1,
      agents: run.agents.map((agent) => ({
        ...agent,
        messagesSent: 99,
        messagesReceived: 99,
        tokens: 12345,
        costUsd: 42,
        firstSeenAt: 0,
        lastSeenAt: 0,
      })),
      meta: {
        ...run.meta,
        agentCount: 0,
        messageCount: 999,
        eventCount: 999,
        durationMs: -5,
      },
    }

    const model = normalizeTrace(corrupt)
    expect(model).toEqual(run)
    expect(JSON.stringify(model)).toBe(JSON.stringify(run))
  })

  it('preserves role and parentId (the M2-T4 edge model owns them)', () => {
    const annotated: Run = {
      ...run,
      agents: run.agents.map((agent) => ({
        ...agent,
        role: agent.name === 'debian2_bot' ? 'coordinator' : agent.role,
        parentId: agent.name === 'hermes_bot' ? 'a_debian2_bot' : null,
      })),
    }

    const model = normalizeTrace(annotated)
    const coordinator = model.agents.find((agent) => agent.name === 'debian2_bot')
    expect(coordinator?.role).toBe('coordinator')
    expect(model.agents.find((agent) => agent.name === 'hermes_bot')?.parentId).toBe(
      'a_debian2_bot',
    )
  })

  it('normalizes an empty run to itself', () => {
    const empty = parseAgentMessagesExport([])
    expect(normalizeTrace(empty)).toEqual(empty)
    expect(normalizeTrace(empty).meta.messageCount).toBe(0)
    expect(normalizeTrace(empty).startedAt).toBe(0)
  })

  it('does not mutate its input', () => {
    const before = JSON.stringify(run)
    normalizeTrace(run)
    expect(JSON.stringify(run)).toBe(before)
  })
})

describe('normalizeTrace — determinism (M1-T5)', () => {
  it('produces a byte-identical model across calls', () => {
    expect(JSON.stringify(normalizeTrace(run))).toBe(
      JSON.stringify(normalizeTrace(run)),
    )
  })

  it('is independent of array order and of the input sequence values', () => {
    const scrambled: Run = {
      ...run,
      agents: [...run.agents].reverse(),
      messages: [...run.messages].reverse(),
      toolCalls: [...run.toolCalls].reverse(),
      // Reverse the events AND throw away the ordering hint entirely.
      events: [...run.events].reverse().map((event) => ({ ...event, sequence: 0 })),
    }

    expect(JSON.stringify(normalizeTrace(scrambled))).toBe(
      JSON.stringify(normalizeTrace(run)),
    )
  })

  it('sorts ids naturally, so m_9 precedes m_10', () => {
    const twoRows = parseAgentMessagesExport([
      { id: 10, from_agent: 'a', created_at: '2026-01-01T00:00:00Z' },
      { id: 9, from_agent: 'a', created_at: '2026-01-01T00:00:00Z' },
    ])
    const shuffled: Run = { ...twoRows, messages: [...twoRows.messages].reverse() }
    const model = normalizeTrace(shuffled)
    expect(model.messages.map((message) => message.id)).toEqual(['m_9', 'm_10'])
    expect(model.events.filter(isMessageEvent).map((event) => event.messageId)).toEqual(
      ['m_9', 'm_10'],
    )
  })
})

describe('compareModelIds (M1-T5)', () => {
  it('compares digit runs numerically and the rest lexically', () => {
    expect(compareModelIds('m_9', 'm_10')).toBeLessThan(0)
    expect(compareModelIds('m_10', 'm_9')).toBeGreaterThan(0)
    expect(compareModelIds('m_148', 'm_148')).toBe(0)
    expect(compareModelIds('a_debian2_bot', 'a_hermes_bot')).toBeLessThan(0)
    expect(compareModelIds('e_run_start', 'e_tool_call_1')).toBeLessThan(0)
  })
})

describe('normalizeTrace — integrity (M1-T5)', () => {
  const withMessages = (messages: Run['messages']): Run => ({ ...run, messages })

  it('rejects a message with an unknown sender', () => {
    const bad = withMessages([
      { ...run.messages[0], from: 'a_ghost' },
      ...run.messages.slice(1),
    ])
    expect(() => normalizeTrace(bad)).toThrow(TraceModelError)
    expect(() => normalizeTrace(bad)).toThrow(/unknown sender/)
  })

  it('rejects a message with an unknown recipient', () => {
    const bad = withMessages([
      { ...run.messages[0], to: 'a_ghost' },
      ...run.messages.slice(1),
    ])
    expect(() => normalizeTrace(bad)).toThrow(/unknown recipient/)
  })

  it('rejects a tool call attributed to an unknown agent', () => {
    const bad: Run = {
      ...run,
      toolCalls: [
        { ...run.toolCalls[0], agentId: 'a_ghost' },
        ...run.toolCalls.slice(1),
      ],
    }
    expect(() => normalizeTrace(bad)).toThrow(/unknown agent/)
  })

  it('rejects a tool call referencing an unknown message', () => {
    const bad: Run = {
      ...run,
      toolCalls: [
        { ...run.toolCalls[0], messageId: 'm_ghost' },
        ...run.toolCalls.slice(1),
      ],
    }
    expect(() => normalizeTrace(bad)).toThrow(/unknown message/)
  })

  it('rejects a lifecycle event that carries an agent', () => {
    const start = run.events.find((event) => event.kind === 'run_start')!
    const bad: Run = {
      ...run,
      events: run.events.map((event) =>
        event.id === start.id
          ? ({ ...event, agentId: 'a_hermes_bot' } as unknown as Event)
          : event,
      ),
    }
    expect(() => normalizeTrace(bad)).toThrow(/must not be agent-attributed/)
  })

  it('rejects a message event whose agent is unknown or absent', () => {
    const messageEvent = run.events.find(
      (event) => isMessageEvent(event) && event.messageId === 'm_148',
    )!
    const unknown: Run = {
      ...run,
      events: run.events.map((event) =>
        event.id === messageEvent.id
          ? ({ ...event, agentId: 'a_ghost' } as unknown as Event)
          : event,
      ),
    }
    expect(() => normalizeTrace(unknown)).toThrow(/known agent/)

    const nulled: Run = {
      ...run,
      events: run.events.map((event) =>
        event.id === messageEvent.id
          ? ({ ...event, agentId: null } as unknown as Event)
          : event,
      ),
    }
    expect(() => normalizeTrace(nulled)).toThrow(TraceModelError)
  })

  it('rejects a message event that disagrees with its message', () => {
    const messageEvent = run.events.find(
      (event) => isMessageEvent(event) && event.messageId === 'm_148',
    )!
    const bad: Run = {
      ...run,
      events: run.events.map((event) =>
        event.id === messageEvent.id && isMessageEvent(event)
          ? { ...event, to: null }
          : event,
      ),
    }
    expect(() => normalizeTrace(bad)).toThrow(/mirror disagrees/)
  })

  it('rejects duplicate ids in every collection', () => {
    expect(() =>
      normalizeTrace({ ...run, agents: [...run.agents, run.agents[0]] }),
    ).toThrow(/duplicate agent id/)
    expect(() =>
      normalizeTrace(withMessages([...run.messages, run.messages[0]])),
    ).toThrow(/duplicate message id/)
    expect(() =>
      normalizeTrace({ ...run, toolCalls: [...run.toolCalls, run.toolCalls[0]] }),
    ).toThrow(/duplicate tool call id/)
    expect(() =>
      normalizeTrace({ ...run, events: [...run.events, run.events[0]] }),
    ).toThrow(/duplicate event id/)
  })

  it('rejects a non-finite timestamp', () => {
    const bad = withMessages([
      { ...run.messages[0], at: Number.NaN },
      ...run.messages.slice(1),
    ])
    expect(() => normalizeTrace(bad)).toThrow(/not a finite number/)
  })
})
