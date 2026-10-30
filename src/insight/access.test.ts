import { describe, expect, it } from 'vitest'
import { parseAgentMessagesExport } from '../adapter/index.ts'
import type { AgentMessageRow } from '../adapter/index.ts'
import { buildFixture } from '../fixtures/index.ts'
import { buildFleetRun } from '../fixtures/real/fleetRows.ts'
import { FLEET_EXPORT_ROWS } from '../fixtures/real/index.ts'
import { normalizeTrace } from '../model/index.ts'
import type { TraceModel } from '../model/index.ts'
import {
  CRITERION_MIN_FACTS,
  CRITERION_MIN_ROW_RATIO,
  comparisonOf,
  evaluateSpatialCriterion,
} from './index.ts'

/**
 * The criterion comparison (M5-T4).
 *
 * The claim under test is PRD §7's: *at least two structural facts are surfaced
 * faster by the scene than by the transcript*. What can be gated is the
 * comparison's own arithmetic — rows read vs marks read, the 4× bar, and the three
 * verdicts — plus the result on each measured run. The human half (does a person
 * actually read it faster?) is M5-T5's.
 *
 * The runs cover both directions: the two reference shapes must **meet** the
 * criterion, and the two small fixtures must **fail** it, so a passing test cannot
 * be an artefact of always saying yes.
 */

const FAN_OUT = buildFixture('fan-out').run
const LOOP = buildFixture('loop').run
const DEAD_BRANCH = buildFixture('dead-branch').run
const HANDOFF = buildFixture('handoff-chain').run
const FLEET = buildFleetRun(FLEET_EXPORT_ROWS)

/** A synthetic run whose transcript is exactly `count` rows, from one sender. */
function fanOutOf(count: number): TraceModel {
  const rows: AgentMessageRow[] = Array.from({ length: count }, (_, index) => ({
    id: 9100 + index,
    from_agent: 'boss',
    to_agent: `w${index + 1}`,
    subject: `Assign ${index + 1}`,
    body: JSON.stringify({ action: 'assign_task' }),
    created_at: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }))
  return normalizeTrace(parseAgentMessagesExport(rows, { label: `rows:${count}` }))
}

describe('the reference runs meet the criterion (PRD §7, M5-T4)', () => {
  it('surfaces fan-out and imbalance on the fan-out fixture', () => {
    const report = evaluateSpatialCriterion(FAN_OUT)
    expect(report.met).toBe(true)
    expect(report.demonstrated).toEqual(['fan-out', 'imbalance'])
    expect(report.unavailable).toEqual(['loop', 'cost'])
    expect(report.verdictLine).toBe(
      '2 of 4 structural facts read off the scene faster than the transcript',
    )
  })

  it('surfaces the loop and the channel concentration on the loop fixture', () => {
    const report = evaluateSpatialCriterion(LOOP)
    expect(report.met).toBe(true)
    expect(report.demonstrated).toEqual(['loop', 'imbalance'])
    expect(report.unavailable).toEqual(['fan-out', 'cost'])
  })

  it('clears the bar by a real margin, not by rounding', () => {
    for (const run of [FAN_OUT, LOOP]) {
      const report = evaluateSpatialCriterion(run)
      for (const kind of report.demonstrated) {
        const comparison = comparisonOf(report, kind)
        expect(comparison).not.toBe(null)
        expect(comparison?.rowRatio ?? 0).toBeGreaterThanOrEqual(
          CRITERION_MIN_ROW_RATIO,
        )
        expect(comparison?.spatial.marksToRead).toBe(1)
        expect(comparison?.spatial.requiresAggregation).toBe(false)
        expect(comparison?.timeline.requiresAggregation).toBe(true)
        expect(comparison?.timeline.rowsToScan).toBe(run.messages.length)
      }
    }
  })
})

describe('the small runs are the negative control', () => {
  it('fails the criterion on the dead-branch fixture', () => {
    const report = evaluateSpatialCriterion(DEAD_BRANCH)
    expect(report.met).toBe(false)
    expect(report.demonstrated).toEqual([])
    // Both facts it *does* carry are real, and both are too small to count.
    const fanOut = comparisonOf(report, 'fan-out')
    expect(fanOut?.supported).toBe(true)
    expect(fanOut?.verdict).toBe('too-small')
    expect(fanOut?.rowRatio).toBe(3)
    expect(fanOut?.reason).toContain('3 rows')
  })

  it('fails the criterion on the handoff chain (every candidate unavailable)', () => {
    const report = evaluateSpatialCriterion(HANDOFF)
    expect(report.met).toBe(false)
    expect(report.demonstrated).toEqual([])
    expect(report.unavailable).toEqual(['fan-out', 'loop', 'imbalance', 'cost'])
    expect(report.caveats.some((caveat) => caveat.includes('message reach'))).toBe(true)
  })
})

describe('the bar is exactly four rows per mark', () => {
  it('counts four rows as faster and three as too small', () => {
    const four = evaluateSpatialCriterion(fanOutOf(4))
    expect(four.demonstrated).toContain('fan-out')
    expect(comparisonOf(four, 'fan-out')?.rowRatio).toBe(4)

    const three = evaluateSpatialCriterion(fanOutOf(3))
    expect(three.demonstrated).not.toContain('fan-out')
    expect(comparisonOf(three, 'fan-out')?.verdict).toBe('too-small')
    expect(comparisonOf(three, 'fan-out')?.rowRatio).toBe(3)
  })

  it('scales the ratio with the transcript, not with the run’s age', () => {
    const big = evaluateSpatialCriterion(fanOutOf(40))
    expect(comparisonOf(big, 'fan-out')?.rowRatio).toBe(40)
    expect(comparisonOf(big, 'fan-out')?.timeline.keysToHold).toBe(1)
    expect(comparisonOf(big, 'fan-out')?.spatial.keysToHold).toBe(0)
  })
})

describe('the real fleet run (dogfood)', () => {
  const report = evaluateSpatialCriterion(FLEET)

  it('meets the criterion on its two flow facts', () => {
    expect(report.met).toBe(true)
    expect(report.demonstrated).toEqual(['fan-out', 'imbalance'])
    // 158 rows against one mark each: the ratio is the argument.
    expect(comparisonOf(report, 'fan-out')?.rowRatio).toBe(158)
    expect(comparisonOf(report, 'imbalance')?.rowRatio).toBe(158)
  })

  it('states that the hierarchy is not derivable from its vocabulary', () => {
    expect(report.facts.hierarchyDerivable).toBe(false)
    expect(comparisonOf(report, 'fan-out')?.answer).toContain(
      'message reach, not a derived hierarchy',
    )
    expect(report.caveats.some((caveat) => caveat.includes('M5-T3 finding 3'))).toBe(
      true,
    )
  })

  it('does not call the fleet’s busiest channel a loop', () => {
    expect(comparisonOf(report, 'loop')?.verdict).toBe('not-drawn')
    expect(comparisonOf(report, 'loop')?.answer).toContain(
      'hub relationship, not a loop',
    )
  })
})

describe('the comparison is a pure function of the run', () => {
  it('derives an identical report twice', () => {
    expect(JSON.stringify(evaluateSpatialCriterion(LOOP))).toBe(
      JSON.stringify(evaluateSpatialCriterion(LOOP)),
    )
  })

  it('reports an empty run without inventing facts', () => {
    const empty = normalizeTrace(parseAgentMessagesExport([], { label: 'empty' }))
    const report = evaluateSpatialCriterion(empty)
    expect(report.met).toBe(false)
    expect(report.comparisons).toHaveLength(4)
    for (const comparison of report.comparisons) {
      expect(comparison.supported).toBe(false)
      expect(comparison.verdict).toBe('not-drawn')
      expect(comparison.spatial.marksToRead).toBe(0)
      expect(comparison.rowRatio).toBe(null)
    }
    expect(CRITERION_MIN_FACTS).toBe(2)
  })
})
