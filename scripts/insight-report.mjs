#!/usr/bin/env node
/**
 * The spatial-insight criterion probe (M5-T4).
 *
 * Runs the criterion over the four fixtures and the real `debian2_bot` export,
 * then writes the evidence:
 *
 * | output | what it is |
 * |---|---|
 * | `docs/spatial-insight.md` | the write-up — generated, so its numbers cannot drift |
 * | `docs/spatial-insight.json` | the same reports as data, for a later consumer |
 *
 * It measures and reports; it asserts nothing about the look (jsdom has no GPU
 * and neither does this script — the look is M5-T5's human review). A run that
 * fails the criterion is a finding printed in the doc, not a red build.
 *
 * Usage:
 *   node --experimental-strip-types scripts/insight-report.mjs
 *
 * Note on the real run: `src/fixtures/real/fleetExport.ts` reads its snapshot
 * with Vite's `?raw` import and so cannot be loaded here. The rows are read from
 * the committed JSON instead and handed to `buildFleetRun` (`fleetRows.ts`) — the
 * same adapter → normalizer path the app uses, so the run is identical.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { FIXTURES } from '../src/fixtures/index.ts'
import { buildFleetRun } from '../src/fixtures/real/fleetRows.ts'
import {
  CRITERION_MIN_ROW_RATIO,
  describeInsight,
  evaluateSpatialCriterion,
  renderInsightMarkdown,
} from '../src/insight/index.ts'

/** The committed snapshot the real run is built from. */
const FLEET_SNAPSHOT = 'src/fixtures/real/debian2-fleet.export.json'

/** The runs the PRD criterion is judged on: the two reference shapes. */
const REFERENCE_SHAPES = ['fan-out', 'loop']

/** The rows of the committed export, read as data (no bundler import). */
function fleetRows() {
  return JSON.parse(readFileSync(resolve(FLEET_SNAPSHOT), 'utf8'))
}

/** A sentence naming the loop detector's *rejection*, when it rejected one. */
function loopRejection(report) {
  const loop = report.comparisons.find((comparison) => comparison.kind === 'loop')
  if (loop === undefined || loop.supported) return null
  const busiest = report.facts.facts.find((fact) => fact.kind === 'loop')?.evidence
    .busiestPair
  if (busiest === null || busiest === undefined) return null
  return (
    `The loop detector rejected the busiest two-way channel: \`${busiest.a}\` ⇄ \`${busiest.b}\` ` +
    `runs ${busiest.fromAToB}→ / ${busiest.fromBToA}← (${Math.round(busiest.balance * 100)}% symmetric), ` +
    'which is a hub relationship, not a runaway.'
  )
}

/** Notes derived from one report — every number here comes from the report. */
function notesFor(report) {
  const notes = []
  const fanOut = report.comparisons.find((comparison) => comparison.kind === 'fan-out')
  const imbalance = report.comparisons.find(
    (comparison) => comparison.kind === 'imbalance',
  )

  if (fanOut !== undefined && fanOut.verdict === 'spatial-faster') {
    const evidence =
      report.facts.facts.find((fact) => fact.kind === 'fan-out')?.evidence ?? null
    const top =
      evidence === null
        ? undefined
        : report.facts.fans.find((fan) => fan.agentId === evidence.topAgentId)
    if (evidence !== null && evidence.topBroadcastsSent > 0 && top !== undefined) {
      notes.push(
        `The widest fan is partly a shout: ${evidence.topBroadcastsSent} broadcast ` +
          `${evidence.topBroadcastsSent === 1 ? 'row' : 'rows'} from \`${evidence.topAgentId}\` ` +
          `reach ${evidence.topBroadcastReach} agents, while only ${top.directedReach} are addressed ` +
          `by a directed message. The scene draws the broadcast as a spoke to each — honest, and ` +
          'easy to misread as that many decisions.',
      )
    }
  }

  if (imbalance !== undefined && imbalance.verdict === 'spatial-faster') {
    const evidence = report.facts.facts.find(
      (fact) => fact.kind === 'imbalance',
    )?.evidence
    if (evidence !== null && evidence !== undefined && evidence.basis === 'channel') {
      const top = evidence.channels[0]
      notes.push(
        `Concentration is a *channel* fact, not an agent one: the busiest channel carries ` +
          `${top.volume} of ${evidence.totalMessages} messages (${Math.round(top.share * 100)}%), ` +
          `${evidence.channelRatio}× the next. A per-agent ranking would have shown a tie.`,
      )
    }
  }

  const rejection = loopRejection(report)
  if (rejection !== null) notes.push(rejection)

  if (!report.met && report.demonstrated.length === 0) {
    notes.push(
      'This run is the criterion’s **negative control**: every candidate is either too small to ' +
        `clear ${CRITERION_MIN_ROW_RATIO} rows per mark or not present at all, so the criterion ` +
        'correctly fails here. A report that passed on every run would prove nothing.',
    )
  }

  return notes
}

const reports = [
  ...FIXTURES.map((fixture) => evaluateSpatialCriterion(fixture.run)),
  evaluateSpatialCriterion(buildFleetRun(fleetRows())),
]

const referenceRunIds = reports
  .filter((report) => {
    const fixture = FIXTURES.find((entry) => entry.run.id === report.runId)
    if (fixture === undefined) return false
    return REFERENCE_SHAPES.includes(fixture.shape)
  })
  .map((report) => report.runId)

const notes = {}
for (const report of reports) notes[report.runId] = notesFor(report)

const markdown = renderInsightMarkdown({
  generatedAt: new Date().toISOString().slice(0, 10),
  reports,
  referenceRunIds,
  command: 'node --experimental-strip-types scripts/insight-report.mjs',
  notes,
})

const docs = resolve('docs')
mkdirSync(docs, { recursive: true })
writeFileSync(resolve(docs, 'spatial-insight.md'), markdown)
writeFileSync(
  resolve(docs, 'spatial-insight.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString().slice(0, 10),
      criterion: { minFacts: 2, minRowRatio: CRITERION_MIN_ROW_RATIO },
      referenceRunIds,
      reports,
    },
    null,
    2,
  )}\n`,
)

for (const report of reports) console.log(describeInsight(report))

const references = reports.filter((report) => referenceRunIds.includes(report.runId))
const met = references.filter((report) => report.met).length
console.log(
  `\nreference runs: ${met}/${references.length} met the criterion` +
    (references.length > 0 && met === references.length
      ? ' — demonstrated'
      : ' — NOT demonstrated (report the project as a demo, per PRD §7)'),
)
console.log('wrote docs/spatial-insight.md and docs/spatial-insight.json')
