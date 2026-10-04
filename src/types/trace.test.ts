import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  Agent,
  Event,
  Message,
  MessageEvent,
  Run,
  RunLifecycleEvent,
  ToolCall,
  ToolCallEvent,
} from './index.ts'
import {
  EVENT_KINDS,
  TRACE_SOURCE,
  isLifecycleEvent,
  isMessageEvent,
  isToolCallEvent,
} from './index.ts'

/**
 * Trace-contract tests (M1-T3).
 *
 * The contract is a *type* module, so half the value is compile-time: the
 * fixtures below are attached to their interfaces with `satisfies`, which
 * means renaming or dropping a required field breaks the build (`typecheck` /
 * `build`) rather than silently drifting. The runtime half pins the small
 * amount of behaviour the contract actually owns — the ingest-format constant,
 * the event-kind list, and the narrowing guards — so consumers can rely on
 * them.
 *
 * Scope note (PRD §5): this gates the *pure* contract only. It says nothing
 * about how any of this looks once rendered — visuals are human-held (M5-T5)
 * and never gated in jsdom.
 *
 * Fixture data mirrors the real `agent_messages` rows the authoring pipeline
 * produces (debian2_bot <-> hermes_bot), so the contract is validated against
 * the shape it will actually ingest in M1-T4.
 */

const coordinator = {
  id: 'a_debian2_bot',
  name: 'debian2_bot',
  role: 'coordinator',
  parentId: null,
  firstSeenAt: 1_000,
  lastSeenAt: 4_000,
  messagesSent: 0,
  messagesReceived: 1,
  tokens: 0,
  costUsd: 0,
} satisfies Agent

const worker = {
  id: 'a_hermes_bot',
  name: 'hermes_bot',
  role: 'worker',
  parentId: 'a_debian2_bot',
  firstSeenAt: 2_000,
  lastSeenAt: 2_000,
  messagesSent: 1,
  messagesReceived: 0,
  tokens: 0,
  costUsd: 0,
} satisfies Agent

const message = {
  id: 'm_1',
  from: 'a_hermes_bot',
  to: 'a_debian2_bot',
  subject: 'Script ready for review: kernel_headroom',
  body: '{"action":"script_ready","video_id":127,"topic":"kernel_headroom"}',
  payload: { action: 'script_ready', video_id: 127, topic: 'kernel_headroom' },
  action: 'script_ready',
  status: 'read',
  at: 2_000,
  tokens: 0,
  costUsd: 0,
} satisfies Message

const toolCall = {
  id: 'tc_1',
  agentId: 'a_hermes_bot',
  name: 'script_ready',
  messageId: 'm_1',
  at: 2_000,
  args: { video_id: 127 },
  durationMs: null,
  costUsd: 0,
} satisfies ToolCall

const runStart = {
  id: 'e_0',
  at: 1_000,
  sequence: 0,
  agentId: null,
  label: 'run start',
  kind: 'run_start',
} satisfies RunLifecycleEvent

const messageEvent = {
  id: 'e_1',
  at: 2_000,
  sequence: 1,
  agentId: 'a_hermes_bot',
  label: 'Script ready for review: kernel_headroom',
  kind: 'message',
  messageId: 'm_1',
  from: 'a_hermes_bot',
  to: 'a_debian2_bot',
} satisfies MessageEvent

const toolCallEvent = {
  id: 'e_2',
  at: 2_000,
  sequence: 2,
  agentId: 'a_hermes_bot',
  label: 'script_ready',
  kind: 'tool_call',
  toolCallId: 'tc_1',
  toolName: 'script_ready',
} satisfies ToolCallEvent

const runEnd = {
  id: 'e_3',
  at: 4_000,
  sequence: 3,
  agentId: null,
  label: 'run end',
  kind: 'run_end',
} satisfies RunLifecycleEvent

const run = {
  id: 'run_1',
  label: 'debian2_bot fleet — daily review',
  source: 'agent_messages',
  seed: 178,
  agents: [coordinator, worker],
  messages: [message],
  toolCalls: [toolCall],
  events: [runStart, messageEvent, toolCallEvent, runEnd],
  startedAt: 1_000,
  endedAt: 4_000,
  meta: {
    agentCount: 2,
    messageCount: 1,
    toolCallCount: 1,
    eventCount: 4,
    broadcastCount: 0,
    durationMs: 3_000,
    totalTokens: 0,
    totalCostUsd: 0,
  },
} satisfies Run

describe('trace contract (M1-T3)', () => {
  it('pins v1 to exactly one ingest format', () => {
    expect(TRACE_SOURCE).toBe('agent_messages')
    expect(EVENT_KINDS).toEqual(['run_start', 'run_end', 'message', 'tool_call'])
  })

  it('models every contract entity as a compile-checked shape', () => {
    // The `satisfies` above is the real assertion — a renamed/removed required
    // field fails compilation. These reads prove the fixtures carry real data.
    expect(coordinator.role).toBe('coordinator')
    expect(worker.parentId).toBe('a_debian2_bot')
    expect(message.action).toBe('script_ready')
    expect(message.payload?.video_id).toBe(127)
    expect(toolCall.name).toBe('script_ready')
    expect(run.events).toHaveLength(4)
    expect(run.meta.durationMs).toBe(run.endedAt - run.startedAt)
  })

  it('represents a broadcast as to === null', () => {
    const broadcast = {
      ...message,
      id: 'm_2',
      to: null,
      action: null,
      payload: null,
    } satisfies Message
    expect(broadcast.to).toBeNull()
  })

  it('lets a tool call stand alone with no source message', () => {
    const standalone = { ...toolCall, id: 'tc_2', messageId: null } satisfies ToolCall
    expect(standalone.messageId).toBeNull()
  })

  it('narrows the event union correctly by kind', () => {
    expect(isMessageEvent(messageEvent)).toBe(true)
    expect(isToolCallEvent(messageEvent)).toBe(false)
    expect(isLifecycleEvent(messageEvent)).toBe(false)

    expect(isToolCallEvent(toolCallEvent)).toBe(true)
    expect(isMessageEvent(toolCallEvent)).toBe(false)
    expect(isLifecycleEvent(toolCallEvent)).toBe(false)

    expect(isLifecycleEvent(runStart)).toBe(true)
    expect(isLifecycleEvent(runEnd)).toBe(true)
    expect(isMessageEvent(runStart)).toBe(false)
    expect(isToolCallEvent(runStart)).toBe(false)
  })

  it('gives each narrowed event its precise member shape', () => {
    const events: Event[] = [messageEvent, toolCallEvent, runStart]
    const [first, second, third] = events

    if (isMessageEvent(first)) {
      expectTypeOf(first.kind).toEqualTypeOf<'message'>()
      expect(first.messageId).toBe('m_1')
    } else {
      throw new Error('expected a message event')
    }

    if (isToolCallEvent(second)) {
      expectTypeOf(second.toolCallId).toEqualTypeOf<string>()
      expect(second.toolName).toBe('script_ready')
    } else {
      throw new Error('expected a tool-call event')
    }

    if (isLifecycleEvent(third)) {
      expectTypeOf(third.agentId).toEqualTypeOf<null>()
      expect(third.kind).toBe('run_start')
    } else {
      throw new Error('expected a lifecycle event')
    }
  })

  it('is exhaustively switchable on kind (no default arm needed)', () => {
    const describe = (event: Event): string => {
      switch (event.kind) {
        case 'run_start':
        case 'run_end':
          return `lifecycle:${event.kind}`
        case 'message':
          return `message:${event.messageId}`
        case 'tool_call':
          return `tool_call:${event.toolCallId}`
      }
    }

    expect(describe(runStart)).toBe('lifecycle:run_start')
    expect(describe(runEnd)).toBe('lifecycle:run_end')
    expect(describe(messageEvent)).toBe('message:m_1')
    expect(describe(toolCallEvent)).toBe('tool_call:tc_1')
  })

  it('keeps ordering fields numeric so the timeline is a total order', () => {
    for (const event of run.events) {
      expect(typeof event.at).toBe('number')
      expect(typeof event.sequence).toBe('number')
      expect(Number.isInteger(event.sequence)).toBe(true)
    }
    expect(typeof run.seed).toBe('number')
  })
})
