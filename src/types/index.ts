/**
 * Public entry point for the AgentScape trace contract (M1-T3).
 *
 * Import from `../types` (or `./types`), not from a deep path — this barrel is
 * the seam that lets the contract live in several files later without touching
 * every consumer.
 */
export type {
  Agent,
  AgentId,
  AgentRole,
  Event,
  EventBase,
  EventId,
  EventKind,
  Message,
  MessageEvent,
  MessageId,
  MessagePayload,
  MessageStatus,
  Run,
  RunId,
  RunLifecycleEvent,
  RunMeta,
  ToolCall,
  ToolCallEvent,
  ToolCallId,
  TraceSource,
} from './trace.ts'

export {
  EVENT_KINDS,
  TRACE_SOURCE,
  isLifecycleEvent,
  isMessageEvent,
  isToolCallEvent,
} from './trace.ts'
