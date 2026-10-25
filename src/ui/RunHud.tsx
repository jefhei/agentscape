import type { RunSummary } from '../hud/hud.ts'

/**
 * The run HUD (M4-T6) — the render half of the run summary.
 *
 * A deliberately dumb overlay, exactly like the transport, the camera bar, the
 * inspector and the filter bar: it prints the {@link RunSummary} the pure layer
 * handed it — the run's name and provenance, one headline line and the six facts
 * with their already-formatted values — and decides nothing. Not the order of the
 * facts, not how a count reads, not what a figure the export never recorded looks
 * like. All of that is `src/hud/hud.ts`, where it is unit-tested.
 *
 * ## What it is, and what it is not
 *
 * It answers *what is this run* — the trace's fixed totals. The transport answers
 * *where in time are we* and the filter bar answers *what is visible*; the HUD
 * deliberately ignores both, so the three overlays never show the same number
 * twice and a narrowed lens never makes the run look smaller than it is.
 *
 * It is not a dashboard: there are no charts, no per-agent table and no cost
 * breakdown — the inspector (M4-T4) owns one agent's detail, and the spatial view
 * itself is where structure is read. Six figures, one headline, one provenance
 * chip.
 *
 * ## Not gated, by design
 *
 * jsdom has no GPU and no layout, so nothing here is asserted for how it *looks*
 * (that is M5-T5). The tests assert the wiring: the summary reaches the DOM, each
 * fact prints the value the model derived, a missing figure reads as missing
 * rather than zero, and the `data-*` attributes report the raw numbers so a
 * headless probe can check them without parsing text.
 */
export interface RunHudProps {
  /** The run's summary, derived once by the shell (M4-T6, `src/hud/`). */
  summary: RunSummary
}

export default function RunHud({ summary }: RunHudProps) {
  return (
    <section
      className="run-hud"
      data-testid="run-hud"
      aria-label="Run summary"
      data-run-label={summary.label}
      data-agents={summary.counts.agents}
      data-messages={summary.counts.messages}
      data-tool-calls={summary.counts.toolCalls}
      data-duration-ms={summary.durationMs}
      data-tokens={summary.totalTokens}
      data-cost-usd={summary.totalCostUsd}
    >
      <div className="run-hud-head">
        <h2 className="run-hud-title" data-testid="run-hud-title">
          {summary.label}
        </h2>
        <span
          className="run-hud-source"
          data-testid="run-hud-source"
          title={`Ingested from an ${summary.source} export`}
        >
          {summary.source}
        </span>
      </div>

      <p className="run-hud-headline" data-testid="run-hud-headline">
        {summary.headline}
      </p>

      <dl className="run-hud-facts">
        {summary.facts.map((fact) => (
          <div
            key={fact.id}
            className="run-hud-fact"
            data-testid={`run-hud-${fact.id}`}
            data-recorded={fact.recorded}
          >
            <dt>{fact.label}</dt>
            <dd>
              <span className="run-hud-value">{fact.value}</span>
              {fact.detail !== null && (
                <span className="run-hud-detail">{fact.detail}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {summary.attributionNote !== null && (
        <p className="run-hud-note" data-testid="run-hud-note">
          {summary.attributionNote}
        </p>
      )}

      {summary.empty && (
        <p className="run-hud-note" data-testid="run-hud-empty">
          No events recorded in this export.
        </p>
      )}
    </section>
  )
}
