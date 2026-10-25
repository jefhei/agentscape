import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { buildFixture } from '../fixtures/index.ts'
import { MISSING_FIGURE, buildRunSummary, hudFact } from '../hud/hud.ts'
import RunHud from './RunHud.tsx'

/**
 * Wiring tests for the run HUD (M4-T6).
 *
 * The overlay decides nothing: it prints the summary the pure layer derived. So
 * what is asserted is that the summary reaches the DOM unmangled — the run's name
 * and provenance, the headline, one row per fact printing the model's own value,
 * a figure the export never recorded reading as missing rather than zero, and the
 * raw numbers exposed as `data-*` attributes for headless probes. Nothing here is
 * asserted for how it *looks* (M5-T5).
 */

const FAN_OUT = buildFixture('fan-out').run

afterEach(() => {
  cleanup()
})

describe('RunHud — the summary reaches the DOM (M4-T6)', () => {
  it('mounts as a labelled overlay named for the run', () => {
    render(<RunHud summary={buildRunSummary(FAN_OUT)} />)
    const hud = screen.getByTestId('run-hud')
    expect(hud).toHaveAccessibleName('Run summary')
    expect(screen.getByTestId('run-hud-title')).toHaveTextContent('fixture: Fan-out')
  })

  it('reports the ingest format it came from', () => {
    render(<RunHud summary={buildRunSummary(FAN_OUT)} />)
    expect(screen.getByTestId('run-hud-source')).toHaveTextContent('agent_messages')
  })

  it('prints the pure headline', () => {
    render(<RunHud summary={buildRunSummary(FAN_OUT)} />)
    expect(screen.getByTestId('run-hud-headline')).toHaveTextContent(
      '6 agents · 5 messages · 5 tool calls · 4:00',
    )
  })

  it('renders one row per fact, in the model’s order', () => {
    const summary = buildRunSummary(FAN_OUT)
    render(<RunHud summary={summary} />)
    for (const fact of summary.facts) {
      expect(screen.getByTestId(`run-hud-${fact.id}`)).toBeInTheDocument()
    }
    const huds = screen
      .getAllByTestId(/^run-hud-(agents|messages|toolCalls|duration|tokens|cost)$/)
      .map((node) => node.getAttribute('data-testid'))
    expect(huds).toEqual([
      'run-hud-agents',
      'run-hud-messages',
      'run-hud-toolCalls',
      'run-hud-duration',
      'run-hud-tokens',
      'run-hud-cost',
    ])
  })

  it('prints the model’s own values and labels', () => {
    const summary = buildRunSummary(FAN_OUT)
    render(<RunHud summary={summary} />)
    for (const fact of summary.facts) {
      const row = screen.getByTestId(`run-hud-${fact.id}`)
      expect(row).toHaveTextContent(fact.label)
      expect(row).toHaveTextContent(fact.value)
    }
    expect(screen.getByTestId('run-hud-agents')).toHaveTextContent('6')
    expect(screen.getByTestId('run-hud-duration')).toHaveTextContent('4:00')
  })

  it('shows a figure the export never recorded as missing, not as zero', () => {
    const summary = buildRunSummary(FAN_OUT)
    render(<RunHud summary={summary} />)
    const tokens = screen.getByTestId('run-hud-tokens')
    expect(tokens).toHaveTextContent(MISSING_FIGURE)
    expect(tokens).toHaveTextContent('not recorded')
    expect(tokens).toHaveAttribute('data-recorded', 'false')
    expect(tokens).not.toHaveTextContent('0')
  })

  it('prints the missing-data note the model carries', () => {
    render(<RunHud summary={buildRunSummary(FAN_OUT)} />)
    expect(screen.getByTestId('run-hud-note')).toHaveTextContent(
      'This export records no token or cost data.',
    )
  })

  it('prints no note when the run recorded its spend', () => {
    const summary = {
      ...buildRunSummary(FAN_OUT),
      attributionNote: null,
      tokensRecorded: true,
      costRecorded: true,
    }
    render(<RunHud summary={summary} />)
    expect(screen.queryByTestId('run-hud-note')).toBeNull()
  })

  it('exposes the raw numbers for a headless probe', () => {
    const summary = buildRunSummary(FAN_OUT)
    render(<RunHud summary={summary} />)
    const hud = screen.getByTestId('run-hud')
    expect(hud).toHaveAttribute('data-agents', '6')
    expect(hud).toHaveAttribute('data-messages', '5')
    expect(hud).toHaveAttribute('data-tool-calls', '5')
    expect(hud).toHaveAttribute('data-duration-ms', String(4 * 60_000))
    expect(hud).toHaveAttribute('data-tokens', '0')
    expect(hud).toHaveAttribute('data-cost-usd', '0')
  })

  it('qualifies a message total with its broadcast subset', () => {
    const summary = buildRunSummary(FAN_OUT)
    const withBroadcast = {
      ...summary,
      counts: { ...summary.counts, broadcasts: 1 },
      facts: summary.facts.map((fact) =>
        fact.id === 'messages' ? { ...fact, detail: '1 broadcast' } : fact,
      ),
    }
    render(<RunHud summary={withBroadcast} />)
    expect(screen.getByTestId('run-hud-messages')).toHaveTextContent('1 broadcast')
    expect(hudFact(withBroadcast, 'messages')?.detail).toBe('1 broadcast')
  })

  it('says so when the run is empty', () => {
    const summary = buildRunSummary(FAN_OUT)
    const empty = {
      ...summary,
      empty: true,
      attributionNote: null,
    }
    render(<RunHud summary={empty} />)
    expect(screen.getByTestId('run-hud-empty')).toHaveTextContent(
      'No events recorded in this export.',
    )
  })

  it('renders nothing interactive — it is a readout, not a control', () => {
    render(<RunHud summary={buildRunSummary(FAN_OUT)} />)
    const hud = screen.getByTestId('run-hud')
    expect(hud.querySelectorAll('button, input, a, select, textarea')).toHaveLength(0)
  })
})
