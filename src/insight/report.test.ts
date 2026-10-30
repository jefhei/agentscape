import { describe, expect, it } from 'vitest'
import { buildFixture } from '../fixtures/index.ts'
import {
  describeInsight,
  evaluateSpatialCriterion,
  renderInsightMarkdown,
} from './index.ts'
import type { InsightReport, InsightReportInput } from './index.ts'

/**
 * The M5-T4 write-up renderer.
 *
 * The doc is generated, so the tests are about the generator: every figure in it
 * comes from a report (nothing is typed by hand), the verdict follows the numbers
 * in both directions, and the output never carries an `undefined`/`NaN` — the two
 * ways a generated document silently lies.
 */

const FAN_OUT = evaluateSpatialCriterion(buildFixture('fan-out').run)
const LOOP = evaluateSpatialCriterion(buildFixture('loop').run)
const DEAD_BRANCH = evaluateSpatialCriterion(buildFixture('dead-branch').run)

/** A report input with `reference` runs named by id. */
function inputOf(
  reports: InsightReport[],
  referenceRunIds: string[],
  notes?: Record<string, string[]>,
): InsightReportInput {
  return {
    generatedAt: '2026-10-29',
    reports,
    referenceRunIds,
    command: 'node --experimental-strip-types scripts/insight-report.mjs',
    ...(notes === undefined ? {} : { notes }),
  }
}

describe('renderInsightMarkdown — the evidence document (M5-T4)', () => {
  const markdown = renderInsightMarkdown(
    inputOf([FAN_OUT, LOOP, DEAD_BRANCH], [FAN_OUT.runId, LOOP.runId]),
  )

  it('states the claim and how it is measured', () => {
    expect(markdown).toContain(
      '# AgentScape — the spatial-insight criterion, demonstrated (M5-T4)',
    )
    expect(markdown).toContain('PRD §7')
    expect(markdown).toContain('at least two structural facts')
    // The effort model is declared as counted work, not a stopwatch.
    expect(markdown).toContain('reader work, counted')
    expect(markdown).toContain('not a stopwatch')
    expect(markdown).toContain('M5-T5')
  })

  it('reports the verdict the numbers give it', () => {
    expect(markdown).toContain('**The criterion holds on 2 of 2 reference runs**')
    expect(markdown).toContain('fixture: Fan-out')
    expect(markdown).toContain('fixture: Loop')
    // The negative control is in the table and visibly not met.
    expect(markdown).toContain('| fixture: Dead branch | 3 | 3 | none | not met |')
  })

  it('prints a row per fact per run, with the derived answers', () => {
    expect(markdown).toContain(
      '| fact | verdict | timeline path | scene path | answer |',
    )
    for (const report of [FAN_OUT, LOOP, DEAD_BRANCH]) {
      for (const comparison of report.comparisons) {
        expect(markdown).toContain(comparison.answer)
      }
    }
    expect(markdown).toContain('5 rows · 1 key · aggregate')
    expect(markdown).toContain('1 mark · one node')
    expect(markdown).toContain('(5×)')
    expect(markdown).toContain('(7×)')
  })

  it('never prints a placeholder or a NaN', () => {
    expect(markdown).not.toContain('undefined')
    expect(markdown).not.toContain('NaN')
    expect(markdown).not.toContain('null')
  })

  it('carries the caller’s notes for a run', () => {
    const noted = renderInsightMarkdown(
      inputOf([FAN_OUT], [FAN_OUT.runId], {
        [FAN_OUT.runId]: ['A note the probe derived from the numbers.'],
      }),
    )
    expect(noted).toContain('- A note the probe derived from the numbers.')
  })

  it('fails loudly when a reference run does not meet the criterion', () => {
    const failed = renderInsightMarkdown(inputOf([DEAD_BRANCH], [DEAD_BRANCH.runId]))
    expect(failed).toContain('**The criterion does NOT hold**')
    expect(failed).toContain('ships as a **demo**')
  })

  it('says the criterion was not judged when no reference run is supplied', () => {
    const unreferenced = renderInsightMarkdown(inputOf([FAN_OUT], []))
    expect(unreferenced).toContain('**No reference run was supplied**')
    expect(unreferenced).not.toContain('does NOT hold')
  })

  it('is deterministic: the same input renders the same bytes', () => {
    const again = renderInsightMarkdown(
      inputOf([FAN_OUT, LOOP, DEAD_BRANCH], [FAN_OUT.runId, LOOP.runId]),
    )
    expect(again).toBe(markdown)
  })
})

describe('describeInsight — one line per run', () => {
  it('names the verdict and the facts that carry it', () => {
    expect(describeInsight(FAN_OUT)).toContain('met')
    expect(describeInsight(FAN_OUT)).toContain('(Fan-out, Imbalance)')
    expect(describeInsight(DEAD_BRANCH)).toContain('MISS')
    expect(describeInsight(DEAD_BRANCH)).toContain('(none)')
  })
})
