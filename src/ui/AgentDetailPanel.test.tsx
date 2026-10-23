import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { buildFixture } from '../fixtures/index.ts'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import type { AgentMessageRow } from '../adapter/index.ts'
import { normalizeTrace } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'
import type { Agent, Message, Run } from '../types/index.ts'
import { DETAIL_ROW_LIMIT, buildAgentDetail } from '../inspect/index.ts'
import AgentDetailPanel from './AgentDetailPanel.tsx'

/**
 * Wiring tests for the inspector panel (M4-T4).
 *
 * The panel decides nothing: `buildAgentDetail` (`src/inspect/`) has already
 * chosen and shaped every row, and these tests assert that the component *shows
 * what the pure model says* — the same values, the same counts, the same pending
 * flags — plus the two dismissals (close button, Escape) and the row cap. Nothing
 * about the look is asserted: jsdom has no layout, and the look is human-held
 * (M5-T5).
 */

const FAN_OUT = buildFixture('fan-out').run

/** A run whose only message is between two agents, plus a silent third agent. */
function silentAgentModel(): TraceModel {
  const at = Date.parse('2026-02-01T00:00:00.000Z')
  const agent = (id: string): Agent => ({
    id,
    name: id.replace(/^a_/, ''),
    role: 'unknown',
    parentId: null,
    firstSeenAt: 0,
    lastSeenAt: 0,
    messagesSent: 0,
    messagesReceived: 0,
    tokens: 0,
    costUsd: 0,
  })
  const message: Message = {
    id: 'm_1',
    from: 'a_orchestrator',
    to: 'a_worker',
    subject: 'hello',
    body: '',
    payload: null,
    action: null,
    status: 'unread',
    at,
    tokens: 0,
    costUsd: 0,
  }
  const run: Run = {
    id: 'r_silent',
    label: 'silent',
    source: 'agent_messages',
    seed: 3,
    agents: [agent('a_orchestrator'), agent('a_worker'), agent('a_silent')],
    messages: [message],
    toolCalls: [],
    events: [],
    startedAt: at,
    endedAt: at,
    meta: {
      agentCount: 3,
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

/** A run where one agent has more messages than the panel will list. */
function chattyModel(count: number): TraceModel {
  const at = Date.parse('2026-03-01T00:00:00.000Z')
  const rows: AgentMessageRow[] = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    from_agent: 'orchestrator',
    to_agent: 'worker',
    subject: `message ${index + 1}`,
    created_at: new Date(at + index * 1000).toISOString(),
  }))
  return normalizeTrace(parseAgentMessagesExport(rows))
}

describe('AgentDetailPanel (M4-T4)', () => {
  it('renders nothing when nothing is selected', () => {
    const { container } = render(
      <AgentDetailPanel run={FAN_OUT} agentId={null} onClose={() => undefined} />,
    )
    expect(container.innerHTML).toBe('')
    expect(screen.queryByTestId('detail-panel')).toBeNull()
  })

  it('renders nothing for an agent the run does not have', () => {
    render(
      <AgentDetailPanel run={FAN_OUT} agentId="a_nobody" onClose={() => undefined} />,
    )
    expect(screen.queryByTestId('detail-panel')).toBeNull()
  })

  it('shows the agent’s identity, role and lineage', () => {
    render(
      <AgentDetailPanel
        run={FAN_OUT}
        agentId="a_orchestrator"
        onClose={() => undefined}
      />,
    )
    const panel = screen.getByTestId('detail-panel')
    expect(panel).toHaveAttribute('data-agent-id', 'a_orchestrator')
    expect(screen.getByTestId('detail-name')).toHaveTextContent('orchestrator')
    expect(screen.getByTestId('detail-role')).toHaveTextContent('coordinator')
    expect(screen.getByTestId('detail-role')).toHaveAttribute(
      'data-role',
      'coordinator',
    )
    // Root of the run, five children, named.
    expect(panel).toHaveTextContent('root of the run')
    expect(panel).toHaveTextContent('Children (5)')
    expect(panel).toHaveTextContent('worker_alpha')
  })

  it('shows a worker’s parent and peers', () => {
    render(
      <AgentDetailPanel
        run={FAN_OUT}
        agentId="a_worker_alpha"
        onClose={() => undefined}
      />,
    )
    const panel = screen.getByTestId('detail-panel')
    expect(screen.getByTestId('detail-role')).toHaveTextContent('worker')
    expect(panel).toHaveTextContent('orchestrator')
    expect(panel).toHaveTextContent('Talks to')
  })

  it('prints the pure model’s numbers, not its own', () => {
    const detail = buildAgentDetail(FAN_OUT, 'a_orchestrator')!
    render(
      <AgentDetailPanel
        run={FAN_OUT}
        agentId="a_orchestrator"
        onClose={() => undefined}
      />,
    )
    expect(screen.getByTestId('detail-tokens')).toHaveTextContent(
      String(detail.attribution.tokens),
    )
    expect(screen.getByTestId('detail-cost')).toHaveTextContent('$0.00')
    // The traffic line is the model's own counts.
    expect(screen.getByTestId('detail-message-count')).toHaveTextContent(
      `${detail.counts.sent} sent · ${detail.counts.received} received`,
    )
    expect(screen.getByTestId('detail-tool-call-count')).toHaveTextContent(
      String(detail.counts.toolCalls),
    )
  })

  it('lists each message with its direction, counterpart and subject', () => {
    render(
      <AgentDetailPanel
        run={FAN_OUT}
        agentId="a_worker_alpha"
        onClose={() => undefined}
      />,
    )
    const rows = screen.getByTestId('detail-messages').querySelectorAll('li')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveAttribute('data-direction', 'received')
    expect(rows[0]).toHaveTextContent('from orchestrator')
    expect(rows[0]).toHaveTextContent('Assign task: alpha')
    // The action rides along as a chip, and the offset is relative to the run.
    expect(rows[0]).toHaveTextContent('assign_task')
    expect(rows[0]).toHaveTextContent('+0.0s')
  })

  it('lists the agent’s tool calls', () => {
    render(
      <AgentDetailPanel
        run={FAN_OUT}
        agentId="a_orchestrator"
        onClose={() => undefined}
      />,
    )
    const rows = screen.getByTestId('detail-tool-calls').querySelectorAll('li')
    expect(rows).toHaveLength(5)
    expect(rows[0]).toHaveTextContent('assign_task')
    expect(rows[0]).toHaveTextContent('worker=alpha')
  })

  it('says so when there is no activity to show', () => {
    const model = silentAgentModel()
    render(
      <AgentDetailPanel run={model} agentId="a_silent" onClose={() => undefined} />,
    )
    expect(screen.getByTestId('detail-panel')).toHaveTextContent('no activity recorded')
    expect(screen.getByTestId('detail-empty-messages')).toBeInTheDocument()
    expect(screen.getByTestId('detail-empty-tool-calls')).toBeInTheDocument()
  })

  it('dims rows the playhead has not reached, and counts them', () => {
    render(
      <AgentDetailPanel
        run={FAN_OUT}
        agentId="a_orchestrator"
        elapsedMs={0}
        onClose={() => undefined}
      />,
    )
    const rows = screen.getByTestId('detail-messages').querySelectorAll('li')
    expect(rows[0]).toHaveAttribute('data-fired', 'true')
    const pending = [...rows].filter(
      (row) => row.getAttribute('data-fired') === 'false',
    )
    expect(pending).toHaveLength(4)
    expect(screen.getByTestId('detail-message-count')).toHaveTextContent('4 pending')
  })

  it('shows every row as fired with no playhead', () => {
    render(
      <AgentDetailPanel
        run={FAN_OUT}
        agentId="a_orchestrator"
        onClose={() => undefined}
      />,
    )
    const rows = screen.getByTestId('detail-messages').querySelectorAll('li')
    expect([...rows].every((row) => row.getAttribute('data-fired') === 'true')).toBe(
      true,
    )
    expect(screen.getByTestId('detail-message-count')).not.toHaveTextContent('pending')
  })

  it('caps its lists and says how many it did not list', () => {
    const model = chattyModel(DETAIL_ROW_LIMIT + 10)
    render(
      <AgentDetailPanel
        run={model}
        agentId="a_orchestrator"
        onClose={() => undefined}
      />,
    )
    expect(screen.getByTestId('detail-messages').querySelectorAll('li')).toHaveLength(
      DETAIL_ROW_LIMIT,
    )
    expect(screen.getByTestId('detail-more-messages')).toHaveTextContent(
      '+10 more messages not listed',
    )
  })

  it('closes from its close button', () => {
    const onClose = vi.fn()
    render(
      <AgentDetailPanel run={FAN_OUT} agentId="a_orchestrator" onClose={onClose} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close agent details' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(
      <AgentDetailPanel run={FAN_OUT} agentId="a_orchestrator" onClose={onClose} />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores other keys and Escape while typing', () => {
    const onClose = vi.fn()
    render(
      <AgentDetailPanel run={FAN_OUT} agentId="a_orchestrator" onClose={onClose} />,
    )
    fireEvent.keyDown(window, { key: 'a' })
    const input = document.createElement('input')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    input.remove()
  })

  it('binds no key listener while closed', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <AgentDetailPanel run={FAN_OUT} agentId={null} onClose={onClose} />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    // ...and the listener is removed again when the panel closes.
    rerender(
      <AgentDetailPanel run={FAN_OUT} agentId="a_orchestrator" onClose={onClose} />,
    )
    rerender(<AgentDetailPanel run={FAN_OUT} agentId={null} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
