import { describe, expect, it } from 'vitest'
import { parseAgentMessagesExport } from '../../adapter/index.ts'
import { normalizeTrace } from '../../model/index.ts'
import { buildScenePlan, DRAW_CALL_CEILING } from '../../scene/index.ts'
import {
  FLEET_EXPORT_CAPTURED_AT,
  FLEET_EXPORT_DATASET,
  FLEET_EXPORT_REDACTIONS,
  FLEET_EXPORT_ROWS,
  FLEET_EXPORT_TABLE,
  FLEET_RUN,
  FLEET_RUN_LABEL,
  buildFleetRun,
  summarizeFleetExport,
} from './fleetExport.ts'

/**
 * The real `debian2_bot` fleet run (M5-T3, the dogfood).
 *
 * Two different promises are pinned here, and they must not be confused:
 *
 * 1. **The snapshot is what it claims to be** — a real `agent_messages` export:
 *    every row parses, the facts match the table, and it carries no secrets into
 *    a public repo. These tests read the export, not the run.
 * 2. **The run renders** — the real rows go through the real ingest path and come
 *    out byte-identical every time, and the scene plan the app would mount is
 *    within the draw-call budget with finite, distinct node positions. This is
 *    the pure half of "render the real fleet run": the *look* is still human-held
 *    (M5-T5), so nothing here asserts how it appears.
 */

const SUMMARY = summarizeFleetExport()

/** The rows the export carries, as the adapter sees them. */
const ROWS = [...FLEET_EXPORT_ROWS]

describe('fleet export — the snapshot (M5-T3)', () => {
  it('is a real agent_messages export, not a fixture', () => {
    expect(FLEET_EXPORT_TABLE).toBe('agent_messages')
    expect(FLEET_EXPORT_DATASET).toBe('debian2_bot')
    expect(FLEET_EXPORT_CAPTURED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // A dogfood run has to be big enough to be a run, not a sample.
    expect(FLEET_EXPORT_ROWS.length).toBeGreaterThan(100)
    expect(SUMMARY.rows).toBe(FLEET_EXPORT_ROWS.length)
  })

  it('keeps the table’s own row shape', () => {
    for (const row of ROWS) {
      expect(typeof row.id).toBe('number')
      expect(typeof row.from_agent).toBe('string')
      expect(row.from_agent.length).toBeGreaterThan(0)
      expect(Number.isFinite(Date.parse(row.created_at))).toBe(true)
      expect(typeof row.body).toBe('string')
    }
    // Ids are unique and the snapshot is in capture (ascending) order.
    const ids = ROWS.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...ids].sort((a, b) => Number(a) - Number(b)))
  })

  it('reports the facts the fleet actually produced', () => {
    expect(SUMMARY.agents).toEqual([
      'Host_hermes_bot',
      'Rpi4_bot',
      'debian2_bot',
      'herm_bot',
      'hermes_bot',
      'hermes_host2',
      'hermes_research',
      'local',
      'rpi4_bot',
      'video_producer',
    ])
    expect(SUMMARY.rows).toBe(158)
    expect(SUMMARY.broadcasts).toBe(5)
    // 118 of the 158 bodies are JSON objects with a string `action` ⇒ one tool
    // call each; the other 40 are JSON without an action (24) or free text (16).
    expect(SUMMARY.actionBodies).toBe(118)
    expect(SUMMARY.plainBodies).toBe(40)
    expect(SUMMARY.actionBodies + SUMMARY.plainBodies).toBe(SUMMARY.rows)
    expect(SUMMARY.actions.length).toBe(34)
    expect(SUMMARY.actions[0]).toEqual({ action: 'script_ready', count: 27 })
    // The snapshot is the whole table so far: 2026-06-07 → 2026-10-21.
    expect(SUMMARY.firstAt).toBe(Date.parse('2026-06-07T01:58:00.050688+00:00'))
    expect(SUMMARY.lastAt).toBe(Date.parse('2026-10-21T09:54:28.559073+00:00'))
    expect(SUMMARY.spanMs / 86_400_000).toBeCloseTo(136.33, 1)
  })

  it('is frozen, so a test cannot corrupt the shared run', () => {
    expect(Object.isFrozen(FLEET_EXPORT_ROWS)).toBe(true)
  })

  it('summarizes an empty export as all-zero instead of NaN', () => {
    expect(summarizeFleetExport([])).toEqual({
      rows: 0,
      agents: [],
      broadcasts: 0,
      actionBodies: 0,
      plainBodies: 0,
      redactedRows: 0,
      actions: [],
      firstAt: 0,
      lastAt: 0,
      spanMs: 0,
    })
  })
})

describe('fleet export — redaction (the repo is public)', () => {
  /** Every text column of every row, as one haystack. */
  const TEXT = ROWS.map((row) => `${row.subject ?? ''}\n${row.body ?? ''}`).join('\n')

  it('documents the transformations it went through', () => {
    expect(FLEET_EXPORT_REDACTIONS.length).toBe(3)
    expect(FLEET_EXPORT_REDACTIONS.join(' ')).toMatch(/credential/)
    expect(FLEET_EXPORT_REDACTIONS.join(' ')).toMatch(/home paths/)
  })

  it('carries no credential value', () => {
    // The real table has exactly one credential handoff (row 26). Its NAME is
    // kept — the interesting fact is which secret changed hands — and its value
    // must be gone.
    const handoff = ROWS.find((row) => row.id === 26)
    expect(handoff).toBeDefined()
    const payload = JSON.parse(handoff?.body ?? '{}') as Record<string, unknown>
    expect(payload.action).toBe('credential_delivery')
    expect(payload.credential_name).toBe('ANTHROPIC_API_KEY')
    expect(payload.credential_value).toBe('[redacted]')
    expect(SUMMARY.redactedRows).toBeGreaterThanOrEqual(1)
  })

  it('carries no key-shaped string and no home path', () => {
    // Non-vacuous: if the capture script's rules stopped firing, the raw key or
    // `/home/<account>/…` would reappear here and this fails.
    expect(TEXT).not.toMatch(/\/home\/[A-Za-z0-9._-]+\//)
    expect(TEXT).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}/)
    expect(TEXT).not.toMatch(/\bsbp_[A-Za-z0-9]{8,}/)
    expect(TEXT).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/)
    expect(TEXT).not.toMatch(/\beyJ[A-Za-z0-9_-]{20,}/)
    // The redaction is visible, not silent: the paths it touched read `~/…`.
    expect(TEXT).toMatch(/~\/Projects\//)
  })
})

describe('buildFleetRun (M5-T3)', () => {
  it('builds the run through the real ingest path', () => {
    expect(FLEET_RUN.label).toBe(FLEET_RUN_LABEL)
    expect(FLEET_RUN.source).toBe('agent_messages')
    expect(FLEET_RUN.meta.agentCount).toBe(SUMMARY.agents.length)
    expect(FLEET_RUN.meta.messageCount).toBe(SUMMARY.rows)
    expect(FLEET_RUN.meta.toolCallCount).toBe(SUMMARY.actionBodies)
    expect(FLEET_RUN.startedAt).toBe(SUMMARY.firstAt)
    expect(FLEET_RUN.endedAt).toBe(SUMMARY.lastAt)
    expect(FLEET_RUN.meta.durationMs).toBe(SUMMARY.spanMs)
  })

  it('derives the fleet’s communication counts from the rows', () => {
    const byName = new Map(FLEET_RUN.agents.map((agent) => [agent.name, agent]))
    // hermes_bot does the talking; debian2_bot receives the most.
    expect(byName.get('hermes_bot')?.messagesSent).toBe(106)
    expect(byName.get('debian2_bot')?.messagesReceived).toBe(108)
    expect(byName.get('debian2_bot')?.messagesSent).toBe(39)
    // A broadcast counts for every recipient, so the received totals exceed the
    // direct rows by the broadcast fan-out.
    const received = FLEET_RUN.agents.reduce(
      (a, agent) => a + agent.messagesReceived,
      0,
    )
    expect(received).toBe(158 - SUMMARY.broadcasts + SUMMARY.broadcasts * 9)
    // The export has no token or cost columns, so nothing is invented.
    expect(FLEET_RUN.meta.totalTokens).toBe(0)
    expect(FLEET_RUN.meta.totalCostUsd).toBe(0)
  })

  it('is deterministic — byte-identical across calls', () => {
    const first = buildFleetRun()
    const second = buildFleetRun()
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(JSON.stringify(first)).toBe(JSON.stringify(FLEET_RUN))
  })

  it('is independent of the export’s row order', () => {
    const normal = buildFleetRun(ROWS)
    const reversed = buildFleetRun([...ROWS].reverse())
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(normal))
  })

  it('is a fixed point of the normalizer', () => {
    expect(JSON.stringify(normalizeTrace(FLEET_RUN))).toBe(JSON.stringify(FLEET_RUN))
  })

  it('agrees with the adapter’s own parse of the same rows', () => {
    const parsed = normalizeTrace(
      parseAgentMessagesExport(ROWS, { label: FLEET_RUN_LABEL }),
    )
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(FLEET_RUN))
  })

  it('pins a stable, content-derived layout seed', () => {
    expect(FLEET_RUN.seed).toBe(buildFleetRun().seed)
    expect(Number.isInteger(FLEET_RUN.seed)).toBe(true)
    expect(FLEET_RUN.seed).toBeGreaterThanOrEqual(0)
    // A different export must not inherit the same shape.
    const shortened = buildFleetRun(ROWS.slice(0, 100))
    expect(shortened.seed).not.toBe(FLEET_RUN.seed)
  })
})

describe('the real run renders (pure half — the look is M5-T5)', () => {
  const plan = buildScenePlan(FLEET_RUN)

  it('composes a scene from the real facts', () => {
    expect(plan.runId).toBe(FLEET_RUN.id)
    expect(plan.counts.agents).toBe(10)
    expect(plan.counts.messages).toBe(158)
    expect(plan.counts.toolCalls).toBe(118)
    // One node per agent, one arc per derived link, one glyph per tool call.
    expect(plan.counts.nodes).toBe(10)
    expect(plan.counts.arcs).toBe(plan.counts.links)
    expect(plan.counts.glyphs).toBe(118)
    expect(plan.counts.elements).toBe(
      plan.counts.nodes + plan.counts.arcs + plan.counts.glyphs,
    )
  })

  it('stays inside the draw-call budget', () => {
    expect(plan.drawCalls).toBe(DRAW_CALL_CEILING)
    expect(plan.ceiling).toBe(DRAW_CALL_CEILING)
    expect(plan.withinBudget).toBe(true)
  })

  it('settles every node somewhere finite and distinct', () => {
    expect(plan.nodes.instances.length).toBe(10)
    expect(new Set(plan.nodes.instances.map((node) => node.agentId)).size).toBe(10)
    for (const node of plan.nodes.instances) {
      expect(Number.isFinite(node.position.x)).toBe(true)
      expect(Number.isFinite(node.position.y)).toBe(true)
      expect(Number.isFinite(node.position.z)).toBe(true)
      expect(Number.isFinite(node.radius)).toBe(true)
      expect(node.radius).toBeGreaterThan(0)
    }
    const positions = new Set(
      plan.nodes.instances.map((node) =>
        [node.position.x, node.position.y, node.position.z]
          .map((v) => v.toFixed(6))
          .join(','),
      ),
    )
    expect(positions.size).toBe(10)
    expect(Number.isFinite(plan.camera.distance)).toBe(true)
    expect(plan.camera.distance).toBeGreaterThan(0)
    expect(plan.camera.near).toBeLessThan(plan.camera.far)
  })

  it('frames the settled cloud, not the origin', () => {
    // The real run's centre of mass is nowhere near the origin (the fleet is a
    // lopsided two-agent hub), so a camera aimed at 0,0,0 would miss it.
    const { center, radius } = plan.nodes.bounds
    expect(Number.isFinite(radius)).toBe(true)
    expect(radius).toBeGreaterThan(0)
    expect([center.x, center.y, center.z].every(Number.isFinite)).toBe(true)
    expect(Math.hypot(center.x, center.y, center.z)).toBeGreaterThan(0.01)
  })
})
