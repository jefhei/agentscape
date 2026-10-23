import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { buildFixture } from '../fixtures/index.ts'
import { useSelection } from './useSelection.ts'

/**
 * Wiring tests for the selection controller hook (M4-T4).
 *
 * The hook owns what the pure model cannot: the React state, stable callback
 * identities for the scene's click handler and the panel's close button, and the
 * prune when a run no longer contains the selected agent. The rules themselves
 * are gated in `selection.test.ts`; what is asserted here is that a click really
 * changes what the app reports, and that a swap of runs cannot keep a ghost
 * selected.
 */

const FAN_OUT = buildFixture('fan-out').run
const HANDOFF = buildFixture('handoff-chain').run

/** The hook, for one run. */
function selectionHook(model = FAN_OUT) {
  return renderHook(({ run }) => useSelection(run), {
    initialProps: { run: model },
  })
}

describe('useSelection (M4-T4)', () => {
  it('starts with nothing selected', () => {
    const { result } = selectionHook()
    expect(result.current.agentId).toBeNull()
    expect(result.current.agent).toBeNull()
    expect(result.current.isSelected('a_orchestrator')).toBe(false)
  })

  it('selects an agent and exposes its record', () => {
    const { result } = selectionHook()
    act(() => {
      result.current.select('a_worker_alpha')
    })
    expect(result.current.agentId).toBe('a_worker_alpha')
    expect(result.current.agent?.name).toBe('worker_alpha')
    expect(result.current.isSelected('a_worker_alpha')).toBe(true)
    expect(result.current.isSelected('a_orchestrator')).toBe(false)
  })

  it('toggles the same agent closed and another agent across', () => {
    const { result } = selectionHook()
    act(() => {
      result.current.toggle('a_worker_alpha')
    })
    expect(result.current.agentId).toBe('a_worker_alpha')
    act(() => {
      result.current.toggle('a_worker_alpha')
    })
    expect(result.current.agentId).toBeNull()
    act(() => {
      result.current.toggle('a_orchestrator')
    })
    act(() => {
      result.current.toggle('a_worker_beta')
    })
    expect(result.current.agentId).toBe('a_worker_beta')
  })

  it('clears', () => {
    const { result } = selectionHook()
    act(() => {
      result.current.select('a_orchestrator')
    })
    act(() => {
      result.current.clear()
    })
    expect(result.current.agentId).toBeNull()
    expect(result.current.agent).toBeNull()
  })

  it('prunes a selection the run does not contain', () => {
    const { result } = selectionHook()
    act(() => {
      result.current.select('a_nobody')
    })
    // Selecting an absent agent does not open a panel on nothing: the prune is
    // derived from the model, so it lands on the same commit.
    expect(result.current.agentId).toBeNull()
    expect(result.current.agent).toBeNull()
  })

  it('drops the selection when a different run loads', () => {
    const { result, rerender } = selectionHook()
    act(() => {
      result.current.select('a_orchestrator')
    })
    expect(result.current.agentId).toBe('a_orchestrator')

    rerender({ run: HANDOFF })
    // The handoff chain has no orchestrator: the panel cannot describe a ghost.
    expect(result.current.agentId).toBeNull()
    expect(result.current.agent).toBeNull()
  })

  it('keeps the selection when the new run has the same agent', () => {
    const { result, rerender } = selectionHook()
    act(() => {
      result.current.select('a_worker_alpha')
    })
    // A re-normalized copy of the same run (a re-loaded export) still has it.
    rerender({ run: { ...FAN_OUT } })
    expect(result.current.agentId).toBe('a_worker_alpha')
    expect(result.current.agent?.name).toBe('worker_alpha')
  })

  it('hands out stable callbacks across renders', () => {
    const { result, rerender } = selectionHook()
    const first = {
      select: result.current.select,
      toggle: result.current.toggle,
      clear: result.current.clear,
    }
    act(() => {
      result.current.select('a_orchestrator')
    })
    rerender({ run: FAN_OUT })
    expect(result.current.select).toBe(first.select)
    expect(result.current.toggle).toBe(first.toggle)
    expect(result.current.clear).toBe(first.clear)
  })
})
