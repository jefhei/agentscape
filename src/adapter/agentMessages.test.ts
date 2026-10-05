import { describe, expect, expectTypeOf, it } from 'vitest'
import type { MessageEvent, Run, ToolCallEvent } from '../types/index.ts'
import { isMessageEvent, isToolCallEvent } from '../types/index.ts'
import type { AgentMessageRow } from './index.ts'
import {
  agentIdFor,
  decodePayload,
  messageIdFor,
  parseAgentMessagesExport,
  toolCallIdFor,
  TraceParseError,
} from './index.ts'

/**
 * `agent_messages` adapter tests (M1-T4).
 *
 * The adapter is the ONE pure ingest path for v1, so these tests gate it hard
 * (PRD §5): parsing, the row→contract mapping, broadcast handling, tool-call
 * derivation, and — most importantly — *determinism*. Two properties are
 * pinned here that the rest of the app (M1-T5 normalization, M2 layout)
 * depends on:
 *
 *  1. the same export parses to a byte-identical `Run` (JSON-equality across
 *     two parses), and
 *  2. the parse is independent of the order rows appear in (a shuffled export
 *     yields the identical `Run`), because rows are canonically ordered before
 *     anything is derived from them.
 *
 * Fixtures mirror the real `agent_messages` rows the authoring pipeline
 * produces (debian2_bot ⇄ hermes_bot, plus herm_bot and Host_hermes_bot), and
 * intentionally include the awkward cases — a broadcast (`to_agent` NULL), a
 * `body` that is not JSON, a NULL `body`, and the sub-millisecond timestamps
 * Supabase emits — so the mapping is validated against reality, not an ideal.
 *
 * Scope note: this gates the *pure* data layer only. Nothing here says anything
 * about how a run looks once rendered — visuals are human-held (M5-T5) and are
 * never gated in jsdom.
 */

/** Realistic rows in the pipeline's own shape (ascending id here). */
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

const ms = (iso: string): number => Date.parse(iso)

/** The run under test, parsed once from the canonical fixture. */
const run = parseAgentMessagesExport(ROWS)

const agent = (name: string): Run['agents'][number] => {
  const found = run.agents.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`missing agent: ${name}`)
  return found
}

describe('agent_messages adapter (M1-T4)', () => {
  it('returns a fully-formed Run (compile-checked against the contract)', () => {
    expectTypeOf(run).toEqualTypeOf<Run>()
    expect(run.source).toBe('agent_messages')
    expect(typeof run.seed).toBe('number')
    expect(run.id).toMatch(/^run_[0-9a-f]{8}$/)
    expect(run.label).toBe('agent_messages export')
  })

  it('maps every row to a message and counts the run', () => {
    expect(run.messages).toHaveLength(6)
    expect(run.toolCalls).toHaveLength(4)
    expect(run.agents).toHaveLength(4)
    expect(run.meta).toEqual({
      agentCount: 4,
      messageCount: 6,
      toolCallCount: 4,
      eventCount: 12,
      broadcastCount: 1,
      durationMs:
        ms('2026-09-24T11:00:00.000000+00:00') - ms('2026-09-24T07:41:29.379292+00:00'),
      totalTokens: 0,
      totalCostUsd: 0,
    })
  })

  it('decodes a JSON body into a payload, raw body preserved', () => {
    const first = run.messages[0]
    expect(first.id).toBe('m_148')
    expect(first.from).toBe('a_hermes_bot')
    expect(first.to).toBe('a_debian2_bot')
    expect(first.subject).toBe('Research brief ready: kernel_headroom')
    expect(first.action).toBe('research_brief_ready')
    expect(first.payload?.brief_id).toBe(28)
    expect(first.payload?.video_id).toBe(127)
    expect(first.body).toBe(ROWS[0].body)
    expect(first.at).toBe(ms('2026-09-24T07:41:29.379292+00:00'))
    expect(first.status).toBe('read')
  })

  it('models a broadcast (to_agent NULL) as to === null', () => {
    const broadcast = run.messages.find((message) => message.id === 'm_151')
    expect(broadcast?.to).toBeNull()
    expect(broadcast?.action).toBe('broadcast_notice')
    expect(run.meta.broadcastCount).toBe(1)
  })

  it('keeps an unparseable body as raw text with no payload or action', () => {
    const raw = run.messages.find((message) => message.id === 'm_152')
    expect(raw?.body).toBe('not json at all')
    expect(raw?.payload).toBeNull()
    expect(raw?.action).toBeNull()
    // No action ⇒ no derived tool call for that row.
    expect(run.toolCalls.some((call) => call.messageId === 'm_152')).toBe(false)
  })

  it('handles a NULL body and an out-of-enum status deterministically', () => {
    const heartbeat = run.messages.find((message) => message.id === 'm_153')
    expect(heartbeat?.body).toBe('')
    expect(heartbeat?.payload).toBeNull()
    expect(heartbeat?.action).toBeNull()
    expect(heartbeat?.status).toBe('unread')
  })

  it('derives a tool call from each action-bearing message, args minus action', () => {
    expect(run.toolCalls.map((call) => call.name)).toEqual([
      'research_brief_ready',
      'script_ready',
      'review_complete',
      'broadcast_notice',
    ])

    const scriptReady = run.toolCalls.find((call) => call.name === 'script_ready')
    expect(scriptReady?.id).toBe('tc_149')
    expect(scriptReady?.messageId).toBe('m_149')
    expect(scriptReady?.agentId).toBe('a_hermes_bot')
    expect(scriptReady?.at).toBe(ms('2026-09-24T07:41:29.9937+00:00'))
    expect(scriptReady?.durationMs).toBeNull()
    expect(scriptReady?.costUsd).toBe(0)
    expect(scriptReady?.args).toEqual({
      table: 'scripts',
      topic: 'kernel_headroom',
      version: 1,
      video_id: 127,
    })
  })

  it('derives agents from from_agent/to_agent with send/receive counts', () => {
    expect(run.agents.map((candidate) => candidate.name)).toEqual([
      'Host_hermes_bot',
      'debian2_bot',
      'herm_bot',
      'hermes_bot',
    ])

    expect(agent('hermes_bot')).toMatchObject({
      id: 'a_hermes_bot',
      messagesSent: 2,
      messagesReceived: 2, // 1 directed (row 150) + 1 broadcast (row 151)
      tokens: 0,
      costUsd: 0,
      role: 'unknown',
      parentId: null,
    })
    expect(agent('debian2_bot')).toMatchObject({
      messagesSent: 2,
      messagesReceived: 4, // 4 directed; sender of the broadcast, so not a recipient
    })
    expect(agent('herm_bot')).toMatchObject({ messagesSent: 1, messagesReceived: 1 })
    expect(agent('Host_hermes_bot')).toMatchObject({
      messagesSent: 1,
      messagesReceived: 1,
    })
  })

  it('gives every agent a first/last-seen window from its involvement', () => {
    // A message counts for its sender AND its recipient, so a window spans
    // everything the agent took part in — including a broadcast it received.
    expect(agent('hermes_bot').firstSeenAt).toBe(ms('2026-09-24T07:41:29.379292+00:00'))
    expect(agent('hermes_bot').lastSeenAt).toBe(
      ms('2026-09-24T10:00:00.000000+00:00'), // received the fleet broadcast
    )
    expect(agent('Host_hermes_bot').firstSeenAt).toBe(
      ms('2026-09-24T10:00:00.000000+00:00'), // received the fleet broadcast
    )
    expect(agent('Host_hermes_bot').lastSeenAt).toBe(
      ms('2026-09-24T11:00:00.000000+00:00'),
    )
  })

  it('brackets the run with run_start/run_end and a contiguous sequence', () => {
    expect(run.events).toHaveLength(12)
    expect(run.events[0]).toMatchObject({
      kind: 'run_start',
      agentId: null,
      sequence: 0,
      at: run.startedAt,
    })
    expect(run.events[run.events.length - 1]).toMatchObject({
      kind: 'run_end',
      agentId: null,
      sequence: 11,
      at: run.endedAt,
    })
    run.events.forEach((event, index) => expect(event.sequence).toBe(index))
  })

  it('emits a message event and, when present, a tool-call event per row', () => {
    const message = run.events.find(
      (event) => isMessageEvent(event) && event.messageId === 'm_148',
    )
    expect(message).toBeDefined()
    const narrowed = message as MessageEvent
    expect(narrowed).toMatchObject({
      kind: 'message',
      from: 'a_hermes_bot',
      to: 'a_debian2_bot',
      label: 'Research brief ready: kernel_headroom',
      at: ms('2026-09-24T07:41:29.379292+00:00'),
    })

    const toolEvent = run.events.find(
      (event) => isToolCallEvent(event) && event.toolName === 'script_ready',
    )
    const narrowedTool = toolEvent as ToolCallEvent
    expect(narrowedTool).toMatchObject({
      kind: 'tool_call',
      toolCallId: 'tc_149',
      agentId: 'a_hermes_bot',
      label: 'script_ready',
    })
  })

  it('attributes every event to a known agent, or to the run lifecycle', () => {
    const ids = new Set(run.agents.map((candidate) => candidate.id))
    for (const event of run.events) {
      if (event.kind === 'run_start' || event.kind === 'run_end') {
        expect(event.agentId).toBeNull()
      } else {
        expect(event.agentId).not.toBeNull()
        expect(ids.has(event.agentId as string)).toBe(true)
      }
    }
  })

  it('parses from raw JSON text and from a REST-style wrapper object', () => {
    const direct = parseAgentMessagesExport(ROWS)
    expect(parseAgentMessagesExport(JSON.stringify(ROWS))).toEqual(direct)
    expect(parseAgentMessagesExport(JSON.stringify({ data: ROWS }))).toEqual(direct)
    expect(parseAgentMessagesExport(JSON.stringify({ agent_messages: ROWS }))).toEqual(
      direct,
    )
  })

  it('honours label / seed / runId overrides', () => {
    const custom = parseAgentMessagesExport(ROWS, {
      label: 'fleet run',
      seed: 42,
      runId: 'run_custom',
    })
    expect(custom.label).toBe('fleet run')
    expect(custom.seed).toBe(42)
    expect(custom.id).toBe('run_custom')
  })

  it('produces a valid, empty run for an empty export', () => {
    const empty = parseAgentMessagesExport([])
    expect(empty.agents).toEqual([])
    expect(empty.messages).toEqual([])
    expect(empty.toolCalls).toEqual([])
    expect(empty.events).toEqual([])
    expect(empty.startedAt).toBe(0)
    expect(empty.endedAt).toBe(0)
    expect(empty.meta.messageCount).toBe(0)
    expect(typeof empty.seed).toBe('number')
  })
})

describe('agent_messages adapter — determinism (M1-T4)', () => {
  it('parses the same export to a byte-identical Run', () => {
    expect(JSON.stringify(parseAgentMessagesExport(ROWS))).toBe(
      JSON.stringify(parseAgentMessagesExport(ROWS)),
    )
  })

  it('is independent of the order rows arrive in', () => {
    const shuffled = [...ROWS].reverse()
    expect(JSON.stringify(parseAgentMessagesExport(shuffled))).toBe(
      JSON.stringify(parseAgentMessagesExport(ROWS)),
    )
  })

  it('derives a stable id + seed from content, distinct per export', () => {
    const other = parseAgentMessagesExport([ROWS[0]])
    expect(other.id).not.toBe(run.id)
    expect(other.seed).not.toBe(run.seed)
    expect(other.seed).toBe(parseAgentMessagesExport([ROWS[0]]).seed)
  })
})

describe('agent_messages adapter — invalid input (M1-T4)', () => {
  it('rejects text that is not JSON', () => {
    expect(() => parseAgentMessagesExport('{ not json')).toThrow(TraceParseError)
  })

  it('rejects a JSON value that is not a row array', () => {
    expect(() => parseAgentMessagesExport('{"foo":1}')).toThrow(TraceParseError)
    expect(() => parseAgentMessagesExport('42')).toThrow(TraceParseError)
  })

  it('rejects a row that is not an object', () => {
    expect(() => parseAgentMessagesExport([null as never])).toThrow(TraceParseError)
  })

  it('rejects a row missing from_agent or a usable id', () => {
    expect(() =>
      parseAgentMessagesExport([
        { id: 1, created_at: '2026-01-01T00:00:00Z' } as never,
      ]),
    ).toThrow(/missing from_agent/)
    expect(() =>
      parseAgentMessagesExport([
        { from_agent: 'a', created_at: '2026-01-01T00:00:00Z' } as never,
      ]),
    ).toThrow(/missing a numeric\/string id/)
  })

  it('rejects an unparseable created_at', () => {
    expect(() =>
      parseAgentMessagesExport([{ id: 1, from_agent: 'a', created_at: 'yesterday' }]),
    ).toThrow(/invalid created_at/)
  })

  it('rejects duplicate primary keys', () => {
    expect(() =>
      parseAgentMessagesExport([
        { id: 7, from_agent: 'a', created_at: '2026-01-01T00:00:00Z' },
        { id: 7, from_agent: 'b', created_at: '2026-01-02T00:00:00Z' },
      ]),
    ).toThrow(/duplicate row id/)
  })
})

describe('agent_messages adapter — helpers (M1-T4)', () => {
  it('derives stable ids from the trace', () => {
    expect(agentIdFor('debian2_bot')).toBe('a_debian2_bot')
    expect(messageIdFor(149)).toBe('m_149')
    expect(messageIdFor('abc')).toBe('m_abc')
    expect(toolCallIdFor(149)).toBe('tc_149')
  })

  it('decodes only JSON objects into payloads', () => {
    expect(decodePayload('{"action":"x","n":1}')).toEqual({ action: 'x', n: 1 })
    expect(decodePayload('[1,2,3]')).toBeNull()
    expect(decodePayload('42')).toBeNull()
    expect(decodePayload('"a string"')).toBeNull()
    expect(decodePayload('nope')).toBeNull()
    expect(decodePayload('')).toBeNull()
    expect(decodePayload(null)).toBeNull()
    expect(decodePayload(undefined)).toBeNull()
  })
})
