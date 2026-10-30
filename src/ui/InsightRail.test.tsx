import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { buildFixture } from '../fixtures/index.ts'
import { evaluateSpatialCriterion } from '../insight/index.ts'
import InsightRail from './InsightRail.tsx'

/**
 * Wiring tests for the structural readout (M5-T4).
 *
 * The rail decides nothing: it prints the criterion report the pure layer derived
 * and reports the raw facts as `data-*` attributes. So what is asserted is that
 * the report reaches the DOM — one row per supported fact, the answer text as
 * derived, the unavailable facts absent from the rows but named in the attributes,
 * a click selecting the fact's agent — and nothing about how it looks (M5-T5).
 */

const FAN_OUT = evaluateSpatialCriterion(buildFixture('fan-out').run)
const HANDOFF = evaluateSpatialCriterion(buildFixture('handoff-chain').run)

afterEach(() => {
  cleanup()
})

describe('InsightRail — the report reaches the DOM (M5-T4)', () => {
  it('mounts as a labelled overlay for the run', () => {
    render(<InsightRail report={FAN_OUT} />)
    const rail = screen.getByTestId('insight-rail')
    expect(rail).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Structural readout' })).toBe(rail)
    expect(rail).toHaveAttribute('data-run-id', FAN_OUT.runId)
    expect(rail).toHaveAttribute('data-criterion-met', 'true')
    expect(rail).toHaveAttribute('data-demonstrated', 'fan-out,imbalance')
    expect(rail).toHaveAttribute('data-unavailable', 'loop,cost')
    expect(rail).toHaveAttribute('data-facts', '2')
  })

  it('prints one row per supported fact, with the derived answer', () => {
    render(<InsightRail report={FAN_OUT} />)
    // Fan-out and imbalance are supported; loop and cost are not on this run.
    expect(screen.getByTestId('insight-fan-out')).toBeInTheDocument()
    expect(screen.getByTestId('insight-imbalance')).toBeInTheDocument()
    expect(screen.queryByTestId('insight-loop')).toBeNull()
    expect(screen.queryByTestId('insight-cost')).toBeNull()

    const fanOut = screen.getByTestId('insight-fan-out')
    expect(fanOut).toHaveTextContent('Fan-out')
    expect(fanOut).toHaveTextContent('a_orchestrator — 5 agents put to work')
    expect(fanOut).toHaveAttribute('data-verdict', 'spatial-faster')
    expect(fanOut).toHaveAttribute('data-agents', 'a_orchestrator')

    expect(screen.getByTestId('insight-count')).toHaveTextContent('2')
    expect(screen.getByTestId('insight-verdict')).toHaveTextContent(
      '2 of 4 structural facts read off the scene faster than the transcript',
    )
  })

  it('selects the referenced agent when a row is clicked', () => {
    const onSelectAgent = vi.fn()
    render(<InsightRail report={FAN_OUT} onSelectAgent={onSelectAgent} />)
    fireEvent.click(screen.getByTestId('insight-focus-fan-out'))
    expect(onSelectAgent).toHaveBeenCalledWith('a_orchestrator')
  })

  it('leaves the rows inert without a selection handler', () => {
    render(<InsightRail report={FAN_OUT} />)
    expect(screen.queryByTestId('insight-focus-fan-out')).toBeNull()
    expect(screen.getByTestId('insight-fan-out')).toHaveTextContent('Fan-out')
  })

  it('says so plainly when the run has no structure to show', () => {
    render(<InsightRail report={HANDOFF} />)
    expect(screen.getByTestId('insight-rail')).toHaveAttribute('data-facts', '0')
    expect(screen.getByTestId('insight-empty')).toHaveTextContent(
      'No structural concentration in this run.',
    )
    expect(screen.queryByTestId('insight-verdict')).toBeNull()
  })
})
