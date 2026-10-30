import type { AgentId } from '../types/index.ts'
import type { FactComparison, InsightReport } from '../insight/index.ts'

/**
 * The structural readout (M5-T4) — the render half of the insight layer.
 *
 * A deliberately dumb overlay: it prints the {@link InsightReport} the pure layer
 * derived and decides nothing — not which facts exist, not what they say, not
 * which agent they point at. It is the *caption* for the scene, not a chart of
 * it: each row names a structural fact the scene already draws (a node's arc fan,
 * the heaviest two-way arc, node glow) so a reader who cannot yet read the
 * encoding can still name it — and clicking a row selects the referenced node,
 * which is a spatial action, not a jump in a timeline.
 *
 * ## What it must not become
 *
 * This is not a replay list, a search box or a per-message table: those already
 * exist in the pipeline's backlog and the spatial view IS the product (BUILD_PLAN
 * rule 3). Four rows at most — one per PRD §7 candidate — and only the ones the
 * run actually supports. A run with no structure prints one line saying so.
 *
 * ## Not gated, by design
 *
 * jsdom has no GPU and no layout, so nothing here asserts how it *looks* (that is
 * M5-T5's human review). The tests assert the wiring: every supported fact reaches
 * the DOM with the answer the model derived, a click selects the fact's agent,
 * and the `data-*` attributes report the raw facts so a headless probe can read
 * them without parsing prose.
 */
export interface InsightRailProps {
  /** The criterion report for the mounted run (derived once by the shell). */
  report: InsightReport
  /**
   * Called with the agent a row points at. Omitted leaves the rows inert
   * (a report with no selection surface is still readable).
   */
  onSelectAgent?: (agentId: AgentId) => void
}

/** The rail's label for a fact kind — short enough to read at a glance. */
const KIND_LABEL: Record<FactComparison['kind'], string> = {
  'fan-out': 'Fan-out',
  loop: 'Loop',
  imbalance: 'Imbalance',
  cost: 'Cost',
}

/** The rows the rail prints: the facts the run actually supports. */
function rowsOf(report: InsightReport): FactComparison[] {
  const order: FactComparison['kind'][] = ['fan-out', 'loop', 'imbalance', 'cost']
  return order
    .map((kind) => report.comparisons.find((comparison) => comparison.kind === kind))
    .filter((comparison): comparison is FactComparison => comparison !== undefined)
    .filter((comparison) => comparison.supported)
}

export default function InsightRail({ report, onSelectAgent }: InsightRailProps) {
  const rows = rowsOf(report)
  const focus = onSelectAgent

  return (
    <section
      className="insight-rail"
      data-testid="insight-rail"
      aria-label="Structural readout"
      data-run-id={report.runId}
      data-criterion-met={report.met}
      data-demonstrated={report.demonstrated.join(',')}
      data-unavailable={report.unavailable.join(',')}
      data-facts={rows.length}
    >
      <div className="insight-rail-head">
        <h2 className="insight-rail-title">Structure</h2>
        <span
          className="insight-rail-count"
          data-testid="insight-count"
          title={`${report.demonstrated.length} of ${report.comparisons.length} structural facts read off the scene`}
        >
          {rows.length}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="insight-rail-note" data-testid="insight-empty">
          No structural concentration in this run.
        </p>
      ) : (
        <ul className="insight-rail-list">
          {rows.map((row) => {
            const target = row.agentIds.length > 0 ? row.agentIds[0] : null
            const label = KIND_LABEL[row.kind]
            return (
              <li
                key={row.kind}
                className="insight-rail-item"
                data-testid={`insight-${row.kind}`}
                data-verdict={row.verdict}
                data-agents={row.agentIds.join(',')}
              >
                {focus === undefined || target === null ? (
                  <span className="insight-rail-label">{label}</span>
                ) : (
                  <button
                    type="button"
                    className="insight-rail-label insight-rail-focus"
                    data-testid={`insight-focus-${row.kind}`}
                    title={`Select ${target}`}
                    onClick={() => focus(target)}
                  >
                    {label}
                  </button>
                )}
                <span className="insight-rail-answer">{row.answer}</span>
              </li>
            )
          })}
        </ul>
      )}

      {report.demonstrated.length > 0 && (
        <p className="insight-rail-note" data-testid="insight-verdict">
          {report.verdictLine}
        </p>
      )}
    </section>
  )
}
