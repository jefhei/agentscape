import { useEffect, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { AgentId } from '../types/index.ts'
import type { TraceModel } from '../model/index.ts'
import {
  DETAIL_ROW_LIMIT,
  buildAgentDetail,
  describeAgentTiming,
  describeMessageDirection,
  formatCost,
  formatShare,
  formatTokens,
} from '../inspect/index.ts'
import type {
  AgentDetail,
  AgentMessageEntry,
  AgentToolCallEntry,
} from '../inspect/index.ts'
import { formatDuration } from '../playback/index.ts'
import { isTypingTarget } from './keyboard.ts'

/**
 * The node inspector panel (M4-T4) — the render half.
 *
 * A deliberately dumb component: {@link buildAgentDetail} (`src/inspect/`) has
 * already decided *what* belongs to the agent, in what direction, at what offset
 * and at what cost, and this file only lays that out. Nothing is derived here —
 * not a sum, not a share, not an ordering — for the same reason the scene layers
 * take finished plans: a second derivation in a component drifts, and a panel
 * that disagrees with the scene it describes is worse than no panel.
 *
 * ## What it shows, and in what order
 *
 * Identity first (name, derived role, who spawned it and what it spawned), then
 * the numbers a viewer actually asks about — activity window, tokens, spend,
 * traffic, tool time — and only then the itemised lists: messages (both
 * directions, one row each) and tool calls. Rows the playhead has not reached are
 * dimmed rather than hidden (`data-fired="false"`): the panel describes the
 * agent's whole footprint in the run, and the transport decides how much of it
 * has *happened* yet.
 *
 * ## Why the close button and Escape, and nothing else, dismiss it
 *
 * The scene's background is also the camera's drag surface, so a
 * "click empty space to close" rule would dismiss the panel whenever a viewer
 * let go of an orbit. Clicking the selected node again toggles it (M4-T4's
 * selection rule); this panel's close button and Escape are the explicit
 * dismissals — the button is a real `<button>`, so it is reachable by keyboard
 * and announced by a screen reader, and Escape is the gesture a detail surface
 * is expected to answer.
 *
 * ## Not gated, by design
 *
 * jsdom has no layout, so nothing about how this looks is asserted (that is
 * M5-T5, human-held). The tests assert the wiring and the numbers: the panel
 * appears for a selection, prints the pure model's own values, caps its lists,
 * flags pending rows, and dispatches close.
 */
export interface AgentDetailPanelProps {
  /** The normalized run the selection is about. */
  run: TraceModel
  /** The selected agent, or `null` (nothing selected → nothing rendered). */
  agentId: AgentId | null
  /**
   * Playhead position from the run's start, ms (M4-T1). Rows after it are shown
   * pending. Omit to show the agent's whole footprint as fired.
   */
  elapsedMs?: number
  /** Close the inspector. */
  onClose: () => void
}

/** Arrow glyph per row kind — decoration only; the row's words carry the meaning. */
const DIRECTION_GLYPH = { sent: '→', received: '←' } as const

/** One message row. */
function MessageRow({ entry }: { entry: AgentMessageEntry }) {
  return (
    <li
      className="detail-row"
      data-fired={entry.fired}
      data-direction={entry.direction}
      title={entry.fired ? undefined : 'Not reached yet at the playhead'}
    >
      <span className="detail-glyph" aria-hidden="true">
        {DIRECTION_GLYPH[entry.direction]}
      </span>
      <span className="detail-who">{describeMessageDirection(entry)}</span>
      <span className="detail-meta">
        +{formatDuration(entry.offsetMs)}
        {entry.action === null ? null : (
          <code className="detail-action">{entry.action}</code>
        )}
        {entry.tokens > 0 ? <span>{formatTokens(entry.tokens)} tok</span> : null}
        {entry.costUsd > 0 ? <span>{formatCost(entry.costUsd)}</span> : null}
      </span>
      <span className="detail-subject">{entry.subject}</span>
    </li>
  )
}

/** One tool-call row. */
function ToolCallRow({ entry }: { entry: AgentToolCallEntry }) {
  return (
    <li
      className="detail-row"
      data-fired={entry.fired}
      data-direction="tool"
      title={entry.fired ? undefined : 'Not reached yet at the playhead'}
    >
      <span className="detail-glyph" aria-hidden="true">
        ⚙
      </span>
      <span className="detail-who">{entry.name}</span>
      <span className="detail-meta">
        +{formatDuration(entry.offsetMs)}
        {entry.durationMs === null ? null : (
          <span>{formatDuration(entry.durationMs)}</span>
        )}
        {entry.costUsd > 0 ? <span>{formatCost(entry.costUsd)}</span> : null}
      </span>
      <span className="detail-subject">
        {entry.argSummary === '' ? 'no arguments recorded' : entry.argSummary}
      </span>
    </li>
  )
}

/** One labelled fact. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** The whole panel, given a built detail. */
function PanelBody({ detail, onClose }: { detail: AgentDetail; onClose: () => void }) {
  const { relations, timing, attribution, counts } = detail
  const pendingMessages = detail.messages.filter((entry) => !entry.fired).length
  const pendingCalls = detail.toolCalls.filter((entry) => !entry.fired).length
  const activity = describeAgentTiming(timing)

  return (
    <>
      <header className="detail-header">
        <div className="detail-title">
          <h2 className="detail-name" data-testid="detail-name">
            {detail.name}
          </h2>
          <span
            className="detail-role"
            data-testid="detail-role"
            data-role={relations.role}
          >
            {relations.role}
          </span>
        </div>
        <button
          type="button"
          className="detail-close"
          data-testid="detail-close"
          aria-label="Close agent details"
          title="Close details (Esc)"
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      <dl className="detail-facts" data-testid="detail-facts">
        <Fact label="Id">{detail.agent.id}</Fact>
        <Fact label="Spawned by">{relations.parentName ?? 'root of the run'}</Fact>
        {relations.fanOut > 0 ? (
          <Fact label={`Children (${relations.fanOut})`}>
            {relations.childNames.join(', ')}
          </Fact>
        ) : null}
        {relations.peerNames.length > 0 ? (
          <Fact label="Talks to">
            {relations.peerNames.slice(0, 6).join(', ')}
            {relations.peerNames.length > 6
              ? ` +${relations.peerNames.length - 6} more`
              : ''}
          </Fact>
        ) : null}
        <Fact label="Activity">{activity ?? 'no activity recorded'}</Fact>
        <Fact label="Tokens">
          <span data-testid="detail-tokens">{formatTokens(attribution.tokens)}</span>
          <span className="detail-share">
            {' '}
            · {formatShare(attribution.tokenShare)} of the run
          </span>
        </Fact>
        <Fact label="Cost">
          <span data-testid="detail-cost">{formatCost(attribution.costUsd)}</span>
          <span className="detail-share">
            {' '}
            · {formatShare(attribution.costShare)} of the run
          </span>
          <span className="detail-split">
            messages {formatCost(attribution.messageCostUsd)} · tool calls{' '}
            {formatCost(attribution.toolCallCostUsd)}
          </span>
        </Fact>
        <Fact label="Traffic">
          {counts.sent} sent · {counts.received} received
          {counts.broadcastsHeard > 0
            ? ` (${counts.broadcastsHeard} heard as broadcast)`
            : ''}
        </Fact>
        <Fact label="Tool calls">
          {counts.toolCalls}
          {timing.toolTimeMs > 0
            ? ` · ${formatDuration(timing.toolTimeMs)} recorded`
            : ''}
          {timing.longestToolMs === null
            ? ''
            : ` · longest ${formatDuration(timing.longestToolMs)}`}
        </Fact>
      </dl>

      <section className="detail-section" aria-label="Messages">
        <h3 className="detail-heading">
          Messages
          <span className="detail-count" data-testid="detail-message-count">
            {counts.sent} sent · {counts.received} received
            {pendingMessages > 0 ? ` · ${pendingMessages} pending` : ''}
          </span>
        </h3>
        {detail.messages.length === 0 ? (
          <p className="detail-empty" data-testid="detail-empty-messages">
            No messages in or out.
          </p>
        ) : (
          <ul className="detail-list" data-testid="detail-messages">
            {detail.messages.slice(0, DETAIL_ROW_LIMIT).map((entry) => (
              <MessageRow key={entry.messageId} entry={entry} />
            ))}
          </ul>
        )}
        {detail.messages.length > DETAIL_ROW_LIMIT ? (
          <p className="detail-more" data-testid="detail-more-messages">
            +{detail.messages.length - DETAIL_ROW_LIMIT} more messages not listed
          </p>
        ) : null}
      </section>

      <section className="detail-section" aria-label="Tool calls">
        <h3 className="detail-heading">
          Tool calls
          <span className="detail-count" data-testid="detail-tool-call-count">
            {counts.toolCalls}
            {pendingCalls > 0 ? ` · ${pendingCalls} pending` : ''}
          </span>
        </h3>
        {detail.toolCalls.length === 0 ? (
          <p className="detail-empty" data-testid="detail-empty-tool-calls">
            No tool calls.
          </p>
        ) : (
          <ul className="detail-list" data-testid="detail-tool-calls">
            {detail.toolCalls.slice(0, DETAIL_ROW_LIMIT).map((entry) => (
              <ToolCallRow key={entry.toolCallId} entry={entry} />
            ))}
          </ul>
        )}
        {detail.toolCalls.length > DETAIL_ROW_LIMIT ? (
          <p className="detail-more" data-testid="detail-more-tool-calls">
            +{detail.toolCalls.length - DETAIL_ROW_LIMIT} more tool calls not listed
          </p>
        ) : null}
      </section>
    </>
  )
}

export default function AgentDetailPanel({
  run,
  agentId,
  elapsedMs,
  onClose,
}: AgentDetailPanelProps) {
  // The pure model, built once per (run, agent, playhead). `buildAgentDetail`
  // returns null for an agent this run does not have, so a selection that
  // outlived its run renders nothing rather than a ghost.
  const detail = useMemo(
    () => (agentId === null ? null : buildAgentDetail(run, agentId, { elapsedMs })),
    [run, agentId, elapsedMs],
  )

  // Escape closes the inspector — the one keyboard gesture a detail surface is
  // expected to answer, and none of the transport's keys (space, arrows,
  // Home/End) use it. Bound only while the panel is open, so a closed inspector
  // holds no listener.
  useEffect(() => {
    if (detail === null) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || isTypingTarget(event.target)) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [detail, onClose])

  if (detail === null) return null

  return (
    <aside
      className="detail-panel"
      data-testid="detail-panel"
      data-agent-id={detail.agent.id}
      aria-label={`Agent details: ${detail.name}`}
    >
      <PanelBody detail={detail} onClose={onClose} />
    </aside>
  )
}
