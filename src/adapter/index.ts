/**
 * Public entry point for the `agent_messages` ingest adapter (M1-T4).
 *
 * Import from `../adapter` (or `./adapter`), not from the deep module path —
 * this barrel is the seam that keeps the adapter's internals free to move while
 * the rest of the app depends only on `parseAgentMessagesExport`.
 */
export {
  agentIdFor,
  decodePayload,
  messageIdFor,
  parseAgentMessagesExport,
  toolCallIdFor,
  TraceParseError,
} from './agentMessages.ts'

export type { AdapterOptions, AgentMessageRow } from './agentMessages.ts'
