import type { ChangeEvent } from 'react'
import type { AgentId } from '../types/index.ts'
import { FILTER_KIND_LABELS, FILTER_KINDS } from '../filter/filter.ts'
import type { FilterKind, FilterView, FilterWindow } from '../filter/filter.ts'

/**
 * The filter bar (M4-T5) — the render half of the lens.
 *
 * A deliberately dumb component: it renders the {@link FilterView} the pure layer
 * handed it (which agents are in the facet, which kinds, the window and its
 * labels, how much survives) and calls one callback per control. It decides no
 * rule — not what toggling an agent means, not what an empty kind selection means,
 * not whether the filter is active — because all of those are the reducer's and
 * the reducer is unit-tested.
 *
 * ## What it controls
 *
 * Three facets, in the order the reducer declares them: **event types** (messages,
 * tool calls), **agents** (one chip per participant, pressed when in the facet) and
 * the **time window** (two sliders over the run's span, plus a "whole run" reset).
 * The bar also carries the one-line summary of what survives the lens, so a viewer
 * can see the filter's effect as a number rather than by squinting at a dimmed
 * scene.
 *
 * ## Focus, not search
 *
 * There is no text box: this narrows the *spatial* view by structure, and a
 * transcript search is a different product (PRD §8). Selecting an agent here is not
 * the same gesture as clicking its node (M4-T4, which opens the inspector) — one
 * filters the population, the other asks about one agent — so the chips are plain
 * toggles, not a selection.
 *
 * ## Not gated, by design
 *
 * jsdom has no GPU and no layout, so nothing here is asserted for how it *looks*
 * (that is M5-T5). The tests assert the wiring: every facet is reachable, each
 * control calls back with the value it claims, the pressed state mirrors the view,
 * and an empty kind selection is announced instead of silently showing everything.
 */
export interface FilterAgentOption {
  id: AgentId
  /** Display name, as it appears in the trace. */
  name: string
}

export interface FilterBarProps {
  /** Every agent in the run, canonical order — one chip each. */
  agents: readonly FilterAgentOption[]
  /** The filter resolved against the run. */
  view: FilterView
  /** Keep / drop one agent from the facet. */
  onToggleAgent: (agentId: AgentId) => void
  /**
   * Keep only one agent (the chip's double-click). One click cannot express it:
   * toggling a chip off an unfiltered run keeps the other N-1, so "show me just
   * this agent" would otherwise cost N-1 clicks on a real fleet trace.
   */
  onIsolateAgent: (agentId: AgentId) => void
  /** Keep / drop one event kind. */
  onToggleKind: (kind: FilterKind) => void
  /** Replace the time window (`null` for the whole run). */
  onWindow: (window: FilterWindow | null) => void
  /** Back to the identity filter. */
  onClear: () => void
}

/** The slider's integer value for an offset. */
function sliderMs(value: number, spanMs: number): number {
  const rounded = Math.round(Number.isFinite(value) ? value : 0)
  return Math.min(Math.max(rounded, 0), Math.round(spanMs))
}

export default function FilterBar({
  agents,
  view,
  onToggleAgent,
  onIsolateAgent,
  onToggleKind,
  onWindow,
  onClear,
}: FilterBarProps) {
  // A range input rejects max === min, so a zero-span run gets a 1 ms track with
  // both thumbs at 0 — the labels still read the true window.
  const max = Math.max(1, Math.round(view.spanMs))
  const start = sliderMs(view.window?.startMs ?? 0, view.spanMs)
  const end = sliderMs(view.window?.endMs ?? view.spanMs, view.spanMs)

  const onStart = (event: ChangeEvent<HTMLInputElement>): void => {
    onWindow({ startMs: Number(event.currentTarget.value), endMs: end })
  }
  const onEnd = (event: ChangeEvent<HTMLInputElement>): void => {
    onWindow({ startMs: start, endMs: Number(event.currentTarget.value) })
  }

  return (
    <section className="filter-bar" data-testid="filter-bar" aria-label="Filter scene">
      <div className="filter-head">
        <h2 className="filter-title">Filter</h2>
        <button
          type="button"
          className="filter-button"
          data-testid="filter-clear"
          aria-label="Clear filters"
          title="Clear filters"
          disabled={!view.active}
          onClick={onClear}
        >
          ↺
        </button>
      </div>

      <span className="filter-summary" data-testid="filter-summary">
        {view.label}
      </span>

      <div className="filter-row" role="group" aria-label="Event types">
        {FILTER_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="filter-chip"
            data-testid={`filter-kind-${kind}`}
            data-kind={kind}
            aria-pressed={view.kinds.includes(kind)}
            onClick={() => onToggleKind(kind)}
          >
            {FILTER_KIND_LABELS[kind]}
          </button>
        ))}
      </div>

      <div className="filter-row filter-agents" role="group" aria-label="Agents">
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className="filter-chip filter-agent"
            data-testid={`filter-agent-${agent.id}`}
            aria-pressed={view.agentIds.includes(agent.id)}
            title={`Toggle ${agent.name} · double-click to show only ${agent.name}`}
            onClick={() => onToggleAgent(agent.id)}
            onDoubleClick={() => onIsolateAgent(agent.id)}
          >
            {agent.name}
          </button>
        ))}
      </div>

      <div className="filter-window">
        <label className="filter-slider">
          <span className="filter-slider-label">From</span>
          <input
            type="range"
            className="filter-range"
            data-testid="filter-window-start"
            aria-label="Window start"
            min={0}
            max={max}
            step={1}
            value={start}
            onChange={onStart}
          />
        </label>
        <label className="filter-slider">
          <span className="filter-slider-label">To</span>
          <input
            type="range"
            className="filter-range"
            data-testid="filter-window-end"
            aria-label="Window end"
            min={0}
            max={max}
            step={1}
            value={end}
            onChange={onEnd}
          />
        </label>
        <span className="filter-window-label" data-testid="filter-window-label">
          {view.windowLabel ?? 'whole run'}
        </span>
        {view.window !== null && (
          <button
            type="button"
            className="filter-button"
            data-testid="filter-window-reset"
            aria-label="Show the whole run"
            title="Show the whole run"
            onClick={() => onWindow(null)}
          >
            ⤢
          </button>
        )}
      </div>

      {view.kinds.length === 0 && (
        <p className="filter-note" data-testid="filter-empty">
          No event types selected — nothing matches.
        </p>
      )}
    </section>
  )
}
