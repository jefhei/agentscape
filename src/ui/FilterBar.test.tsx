import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { buildFixture } from '../fixtures/index.ts'
import { FILTER_KINDS, buildFilterView } from '../filter/filter.ts'
import type { FilterState } from '../filter/filter.ts'
import FilterBar from './FilterBar.tsx'
import type { FilterBarProps } from './FilterBar.tsx'

/**
 * Wiring tests for the filter bar (M4-T5).
 *
 * The bar decides nothing: it renders the resolved view the pure layer handed it and
 * calls one callback per control. jsdom has no layout, so nothing here is asserted
 * for how it *looks* (M5-T5); what is asserted is that every facet is reachable,
 * that each control reports the value it claims (including which edge of the window
 * it kept), that the pressed state mirrors the view, and that an empty kind
 * selection is announced instead of silently showing everything.
 */

const FAN_OUT = buildFixture('fan-out').run
const MINUTE = 60_000

afterEach(() => {
  cleanup()
})

function filterOf(partial: Partial<FilterState>): FilterState {
  return {
    agentIds: partial.agentIds ?? [],
    kinds: partial.kinds ?? FILTER_KINDS,
    window: partial.window ?? null,
  }
}

function renderBar(
  partial: Partial<FilterState> = {},
  overrides: Partial<FilterBarProps> = {},
) {
  const filter = filterOf(partial)
  const onToggleAgent = vi.fn()
  const onIsolateAgent = vi.fn()
  const onToggleKind = vi.fn()
  const onWindow = vi.fn()
  const onClear = vi.fn()
  render(
    <FilterBar
      agents={FAN_OUT.agents}
      view={buildFilterView(FAN_OUT, filter)}
      onToggleAgent={onToggleAgent}
      onIsolateAgent={onIsolateAgent}
      onToggleKind={onToggleKind}
      onWindow={onWindow}
      onClear={onClear}
      {...overrides}
    />,
  )
  return { onToggleAgent, onIsolateAgent, onToggleKind, onWindow, onClear }
}

describe('FilterBar — the facets (M4-T5)', () => {
  it('renders one chip per agent, all pressed on the identity filter', () => {
    renderBar()
    expect(screen.getByTestId('filter-bar')).toBeInTheDocument()
    for (const agent of FAN_OUT.agents) {
      const chip = screen.getByTestId(`filter-agent-${agent.id}`)
      expect(chip).toHaveTextContent(agent.name)
      expect(chip).toHaveAttribute('aria-pressed', 'true')
    }
  })

  it('unpresses the agents outside the facet', () => {
    renderBar({ agentIds: ['a_worker_alpha'] })
    expect(screen.getByTestId('filter-agent-a_worker_alpha')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByTestId('filter-agent-a_orchestrator')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('reports the agent a chip click means', () => {
    const { onToggleAgent } = renderBar()
    fireEvent.click(screen.getByTestId('filter-agent-a_worker_beta'))
    expect(onToggleAgent).toHaveBeenCalledTimes(1)
    expect(onToggleAgent).toHaveBeenCalledWith('a_worker_beta')
  })

  it('focuses on one agent on double-click', () => {
    const { onIsolateAgent } = renderBar()
    fireEvent.doubleClick(screen.getByTestId('filter-agent-a_worker_beta'))
    expect(onIsolateAgent).toHaveBeenCalledTimes(1)
    expect(onIsolateAgent).toHaveBeenCalledWith('a_worker_beta')
    // The gesture is announced, not hidden.
    expect(screen.getByTestId('filter-agent-a_worker_beta')).toHaveAttribute(
      'title',
      'Toggle worker_beta · double-click to show only worker_beta',
    )
  })

  it('renders both event kinds, pressed on the identity filter', () => {
    renderBar()
    expect(screen.getByRole('button', { name: 'Messages' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Tool calls' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('reports the kind a chip click means', () => {
    const { onToggleKind } = renderBar()
    fireEvent.click(screen.getByRole('button', { name: 'Tool calls' }))
    expect(onToggleKind).toHaveBeenCalledWith('tool_call')
  })

  it('mirrors a kind that has been switched off', () => {
    renderBar({ kinds: ['tool_call'] })
    expect(screen.getByRole('button', { name: 'Messages' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.getByRole('button', { name: 'Tool calls' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('announces an empty kind selection instead of showing everything', () => {
    renderBar({ kinds: [] })
    expect(screen.getByTestId('filter-empty')).toHaveTextContent(
      'No event types selected — nothing matches.',
    )
  })

  it('has no empty note while a kind is kept', () => {
    renderBar()
    expect(screen.queryByTestId('filter-empty')).toBeNull()
  })
})

describe('FilterBar — the summary', () => {
  it('prints the pure view’s own line', () => {
    renderBar()
    expect(screen.getByTestId('filter-summary')).toHaveTextContent(
      '6 of 6 agents · 5 of 5 messages · 5 of 5 tool calls',
    )
  })

  it('prints what survives a narrowed lens', () => {
    renderBar({ agentIds: ['a_worker_alpha'] })
    expect(screen.getByTestId('filter-summary')).toHaveTextContent(
      '2 of 6 agents · 1 of 5 messages · 0 of 5 tool calls',
    )
  })
})

describe('FilterBar — the time window', () => {
  it('opens on the whole run', () => {
    renderBar()
    expect(screen.getByLabelText('Window start')).toHaveValue('0')
    expect(screen.getByLabelText('Window end')).toHaveValue(String(4 * MINUTE))
    expect(screen.getByTestId('filter-window-label')).toHaveTextContent('whole run')
    expect(screen.queryByTestId('filter-window-reset')).toBeNull()
  })

  it('bounds the sliders by the run’s span', () => {
    renderBar()
    expect(screen.getByLabelText('Window start')).toHaveAttribute(
      'max',
      String(4 * MINUTE),
    )
    expect(screen.getByLabelText('Window end')).toHaveAttribute(
      'max',
      String(4 * MINUTE),
    )
  })

  it('moves the start edge, keeping the end', () => {
    const { onWindow } = renderBar({ window: { startMs: 0, endMs: MINUTE } })
    fireEvent.change(screen.getByLabelText('Window start'), {
      target: { value: '30000' },
    })
    expect(onWindow).toHaveBeenCalledWith({ startMs: 30000, endMs: MINUTE })
  })

  it('moves the end edge, keeping the start', () => {
    const { onWindow } = renderBar({ window: { startMs: MINUTE, endMs: 2 * MINUTE } })
    fireEvent.change(screen.getByLabelText('Window end'), {
      target: { value: '180000' },
    })
    expect(onWindow).toHaveBeenCalledWith({ startMs: MINUTE, endMs: 180000 })
  })

  it('labels an active window with its range', () => {
    renderBar({ window: { startMs: MINUTE, endMs: 2 * MINUTE } })
    expect(screen.getByTestId('filter-window-label')).toHaveTextContent('1:00 → 2:00')
  })

  it('offers a reset back to the whole run', () => {
    const { onWindow } = renderBar({ window: { startMs: MINUTE, endMs: 2 * MINUTE } })
    const reset = screen.getByTestId('filter-window-reset')
    expect(reset).toHaveAccessibleName('Show the whole run')
    fireEvent.click(reset)
    expect(onWindow).toHaveBeenCalledWith(null)
  })

  it('gives a zero-span run a usable slider', () => {
    const track = buildFixture('dead-branch').run
    const zeroSpan: typeof track = { ...track, endedAt: track.startedAt }
    render(
      <FilterBar
        agents={zeroSpan.agents}
        view={buildFilterView(zeroSpan, filterOf({}))}
        onToggleAgent={vi.fn()}
        onIsolateAgent={vi.fn()}
        onToggleKind={vi.fn()}
        onWindow={vi.fn()}
        onClear={vi.fn()}
      />,
    )
    // A range input rejects max === min, so the bar pins it at 1 rather than
    // rendering a dead control.
    expect(screen.getByLabelText('Window start')).toHaveAttribute('max', '1')
    expect(screen.getByLabelText('Window start')).toHaveValue('0')
  })
})

describe('FilterBar — clearing', () => {
  it('disables the reset on the identity filter', () => {
    renderBar()
    expect(screen.getByTestId('filter-clear')).toBeDisabled()
  })

  it('enables it once the lens narrows, and reports the click', () => {
    const { onClear } = renderBar({ kinds: ['message'] })
    const clear = screen.getByTestId('filter-clear')
    expect(clear).not.toBeDisabled()
    expect(clear).toHaveAccessibleName('Clear filters')
    fireEvent.click(clear)
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
