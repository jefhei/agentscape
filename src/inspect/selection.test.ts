import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLICK_SLOP_PX,
  EMPTY_SELECTION,
  SELECTED_NODE_GAIN,
  agentIdForClick,
  agentIdForInstance,
  createSelection,
  isSelected,
  reduceSelection,
  retainSelection,
  selectionGain,
} from './selection.ts'
import type { PickablePlan, SelectionState } from './selection.ts'

/**
 * Tests for the selection model (M4-T4).
 *
 * Every rule the click path depends on is here: the instance → agent mapping
 * (the one thing between a raycast hit and an agent id), the "a drag is not a
 * click" guard, and the toggle/clear/stale-selection rules. The React half
 * (`useSelection.ts`) is gated separately; the rendered scene is not asserted
 * (jsdom has no GPU — the look is human-held, M5-T5).
 */

/** A plan shaped like a node scene's instances, in canonical draw order. */
const PLAN: PickablePlan = {
  instances: [
    { agentId: 'a_orchestrator' },
    { agentId: 'a_worker_alpha' },
    { agentId: 'a_worker_beta' },
  ],
}

describe('selection state (M4-T4)', () => {
  it('starts empty', () => {
    expect(EMPTY_SELECTION).toEqual({ agentId: null })
    expect(createSelection()).toBe(EMPTY_SELECTION)
    expect(createSelection(null)).toBe(EMPTY_SELECTION)
  })

  it('creates a selection for a real id and refuses a blank one', () => {
    expect(createSelection('a_worker_alpha')).toEqual({ agentId: 'a_worker_alpha' })
    expect(createSelection('')).toBe(EMPTY_SELECTION)
  })

  it('selects, switches and clears', () => {
    const first = reduceSelection(EMPTY_SELECTION, { type: 'select', agentId: 'a_one' })
    expect(first.agentId).toBe('a_one')
    const second = reduceSelection(first, { type: 'select', agentId: 'a_two' })
    expect(second.agentId).toBe('a_two')
    expect(reduceSelection(second, { type: 'clear' })).toBe(EMPTY_SELECTION)
  })

  it('toggle opens, then closes the same agent', () => {
    const opened = reduceSelection(EMPTY_SELECTION, {
      type: 'toggle',
      agentId: 'a_one',
    })
    expect(opened.agentId).toBe('a_one')
    const closed = reduceSelection(opened, { type: 'toggle', agentId: 'a_one' })
    expect(closed.agentId).toBeNull()
  })

  it('toggle on another agent switches instead of closing', () => {
    const state = createSelection('a_one')
    expect(reduceSelection(state, { type: 'toggle', agentId: 'a_two' }).agentId).toBe(
      'a_two',
    )
  })

  it('returns the same state object when nothing changes', () => {
    const state = createSelection('a_one')
    expect(reduceSelection(state, { type: 'select', agentId: 'a_one' })).toBe(state)
    expect(reduceSelection(EMPTY_SELECTION, { type: 'clear' })).toBe(EMPTY_SELECTION)
    expect(reduceSelection(EMPTY_SELECTION, { type: 'toggle', agentId: '' })).toBe(
      EMPTY_SELECTION,
    )
  })

  it('treats a blank id as a clear, never as a selection', () => {
    const state = createSelection('a_one')
    expect(reduceSelection(state, { type: 'select', agentId: '' })).toBe(
      EMPTY_SELECTION,
    )
    expect(reduceSelection(state, { type: 'toggle', agentId: '' })).toBe(
      EMPTY_SELECTION,
    )
  })

  it('reports which agent is selected', () => {
    const state: SelectionState = createSelection('a_one')
    expect(isSelected(state, 'a_one')).toBe(true)
    expect(isSelected(state, 'a_two')).toBe(false)
    expect(isSelected(EMPTY_SELECTION, 'a_one')).toBe(false)
  })

  it('retains a selection only while the run still has that agent', () => {
    const state = createSelection('a_one')
    expect(retainSelection(state, ['a_one', 'a_two'])).toBe(state)
    expect(retainSelection(state, ['a_two'])).toBe(EMPTY_SELECTION)
    expect(retainSelection(state, [])).toBe(EMPTY_SELECTION)
    expect(retainSelection(EMPTY_SELECTION, [])).toBe(EMPTY_SELECTION)
  })
})

describe('instance → agent pick (M4-T4)', () => {
  it('maps an instance index to the agent drawn there', () => {
    expect(agentIdForInstance(PLAN, 0)).toBe('a_orchestrator')
    expect(agentIdForInstance(PLAN, 1)).toBe('a_worker_alpha')
    expect(agentIdForInstance(PLAN, 2)).toBe('a_worker_beta')
  })

  it('returns null for an index with no instance', () => {
    expect(agentIdForInstance(PLAN, 3)).toBeNull()
    expect(agentIdForInstance(PLAN, -1)).toBeNull()
    expect(agentIdForInstance(PLAN, 1.5)).toBeNull()
    expect(agentIdForInstance(PLAN, Number.NaN)).toBeNull()
    expect(agentIdForInstance(PLAN, undefined)).toBeNull()
    expect(agentIdForInstance(PLAN, null)).toBeNull()
    expect(agentIdForInstance({ instances: [] }, 0)).toBeNull()
  })

  it('accepts a tap as a click', () => {
    expect(agentIdForClick(PLAN, { instanceId: 1, delta: 0 })).toBe('a_worker_alpha')
    expect(agentIdForClick(PLAN, { instanceId: 2, delta: CLICK_SLOP_PX })).toBe(
      'a_worker_beta',
    )
    // R3F omits `delta` for a synthetic click; that is a tap, not a drag.
    expect(agentIdForClick(PLAN, { instanceId: 0 })).toBe('a_orchestrator')
    expect(agentIdForClick(PLAN, { instanceId: 0, delta: null })).toBe('a_orchestrator')
  })

  it('rejects a drag, however far it went, and whatever it ended over', () => {
    expect(
      agentIdForClick(PLAN, { instanceId: 0, delta: CLICK_SLOP_PX + 0.5 }),
    ).toBeNull()
    expect(agentIdForClick(PLAN, { instanceId: 0, delta: 200 })).toBeNull()
    // A non-finite delta cannot be trusted, so it is not a click either.
    expect(agentIdForClick(PLAN, { instanceId: 0, delta: Number.NaN })).toBeNull()
    expect(
      agentIdForClick(PLAN, { instanceId: 0, delta: Number.POSITIVE_INFINITY }),
    ).toBeNull()
  })

  it('rejects a miss even when the pointer barely moved', () => {
    expect(agentIdForClick(PLAN, { instanceId: undefined, delta: 0 })).toBeNull()
    expect(agentIdForClick(PLAN, { instanceId: 9, delta: 1 })).toBeNull()
  })
})

describe('selected-node highlight (M4-T4)', () => {
  it('brightens exactly the selected node', () => {
    expect(selectionGain('a_worker_alpha', 'a_worker_alpha')).toBe(SELECTED_NODE_GAIN)
    expect(selectionGain('a_worker_alpha', 'a_worker_beta')).toBe(1)
  })

  it('brightens nothing when nothing is selected', () => {
    expect(selectionGain(null, 'a_orchestrator')).toBe(1)
    expect(selectionGain(undefined, 'a_orchestrator')).toBe(1)
    expect(selectionGain('', 'a_orchestrator')).toBe(1)
  })

  it('is a gain above 1 (a highlight that dims would read as a defect)', () => {
    expect(SELECTED_NODE_GAIN).toBeGreaterThan(1)
  })
})

// ── purity scan ─────────────────────────────────────────────────────────────

/** Walk up from cwd until the package manifest is found. */
function findRepoRoot(start: string): string {
  let dir = start
  for (;;) {
    if (existsSync(resolve(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('package.json not found above cwd')
    dir = parent
  }
}

describe('selection — purity (M4-T4)', () => {
  const source = readFileSync(
    resolve(findRepoRoot(process.cwd()), 'src/inspect/selection.ts'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  it('holds no clock and no randomness', () => {
    expect(source).not.toMatch(/\bDate\.now\s*\(/)
    expect(source).not.toMatch(/\bperformance\.now\s*\(/)
    expect(source).not.toMatch(/\bMath\.random\s*\(/)
  })

  it('is a pure data module — no React, no three.js, no DOM', () => {
    expect(source).not.toMatch(/from ['"]react['"]/)
    expect(source).not.toMatch(/from ['"]three['"]/)
    expect(source).not.toMatch(/@react-three/)
    expect(source).not.toMatch(/\bdocument\./)
    expect(source).not.toMatch(/\bwindow\./)
  })
})
