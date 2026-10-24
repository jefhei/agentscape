import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { buildFixture } from '../fixtures/index.ts'
import { useFilter } from './useFilter.ts'

/**
 * Wiring tests for the filter controller hook (M4-T5).
 *
 * The hook owns what the pure model cannot: the React state, the resolved agent
 * facet for the chip row, and the prune when a run no longer supports the lens. The
 * rules themselves are gated in `filter.test.ts`; what is asserted here is that a
 * control really changes what the app reports, that the derived view follows it, and
 * that a swap of runs cannot leave a lens naming a ghost.
 */

const FAN_OUT = buildFixture('fan-out').run
const HANDOFF = buildFixture('handoff-chain').run

/** The hook, for one run. */
function filterHook(model = FAN_OUT) {
  return renderHook(({ run }) => useFilter(run), { initialProps: { run: model } })
}

describe('useFilter (M4-T5)', () => {
  it('starts on the identity filter', () => {
    const { result } = filterHook()
    expect(result.current.active).toBe(false)
    expect(result.current.filter).toEqual({
      agentIds: [],
      kinds: ['message', 'tool_call'],
      window: null,
    })
    expect(result.current.view.messages).toEqual({ kept: 5, total: 5 })
    expect(result.current.view.agentIds).toHaveLength(6)
  })

  it('toggles an agent out of the resolved facet', () => {
    const { result } = filterHook()
    act(() => {
      result.current.toggleAgent('a_orchestrator')
    })
    expect(result.current.active).toBe(true)
    expect(result.current.filter.agentIds).not.toContain('a_orchestrator')
    expect(result.current.filter.agentIds).toHaveLength(5)
    expect(result.current.view.agentIds).not.toContain('a_orchestrator')
    // Every message is addressed *to* one of the workers, so the assignments stay
    // in view — but the orchestrator's tool calls go with the orchestrator.
    expect(result.current.view.messages.kept).toBe(5)
    expect(result.current.view.toolCalls.kept).toBe(0)
    expect(result.current.view.empty).toBe(false)
  })

  it('toggles an agent back in and back to the identity filter', () => {
    const { result } = filterHook()
    act(() => {
      result.current.toggleAgent('a_orchestrator')
    })
    act(() => {
      result.current.toggleAgent('a_orchestrator')
    })
    expect(result.current.filter.agentIds).toEqual([])
    expect(result.current.active).toBe(false)
    expect(result.current.view.messages.kept).toBe(5)
  })

  it('toggles an event kind', () => {
    const { result } = filterHook()
    act(() => {
      result.current.toggleKind('message')
    })
    expect(result.current.filter.kinds).toEqual(['tool_call'])
    expect(result.current.active).toBe(true)
    expect(result.current.view.messages.kept).toBe(0)
    expect(result.current.view.toolCalls.kept).toBe(5)
    act(() => {
      result.current.toggleKind('tool_call')
    })
    expect(result.current.view.empty).toBe(true)
  })

  it('sets and clears the time window', () => {
    const { result } = filterHook()
    act(() => {
      result.current.setWindow({ startMs: 60_000, endMs: 120_000 })
    })
    expect(result.current.view.windowLabel).toBe('1:00 → 2:00')
    expect(result.current.view.messages.kept).toBe(2)
    act(() => {
      result.current.setWindow(null)
    })
    expect(result.current.view.window).toBeNull()
    expect(result.current.active).toBe(false)
  })

  it('isolates one agent from the whole run', () => {
    const { result } = filterHook()
    act(() => {
      result.current.isolateAgent('a_worker_alpha')
    })
    expect(result.current.filter.agentIds).toEqual(['a_worker_alpha'])
    expect(result.current.view.messages).toEqual({ kept: 1, total: 5 })
    expect(result.current.view.agents).toEqual({ kept: 2, total: 6 })
    expect(result.current.view.toolCalls.kept).toBe(0)
  })

  it('leaves the facet off for an agent the run does not have', () => {
    const { result } = filterHook()
    act(() => {
      result.current.isolateAgent('a_ghost')
    })
    expect(result.current.filter.agentIds).toEqual([])
    expect(result.current.active).toBe(false)
  })

  it('clears every facet at once', () => {
    const { result } = filterHook()
    act(() => {
      result.current.toggleKind('message')
    })
    act(() => {
      result.current.toggleAgent('a_worker_alpha')
    })
    act(() => {
      result.current.setWindow({ startMs: 0, endMs: 60_000 })
    })
    expect(result.current.active).toBe(true)
    expect(result.current.filter.agentIds).toHaveLength(5)
    act(() => {
      result.current.clear()
    })
    expect(result.current.active).toBe(false)
    expect(result.current.filter).toEqual({
      agentIds: [],
      kinds: ['message', 'tool_call'],
      window: null,
    })
    expect(result.current.view.messages.kept).toBe(5)
  })

  it('prunes agents the new run does not have, on the same commit', () => {
    const { result, rerender } = filterHook()
    act(() => {
      result.current.toggleAgent('a_worker_gamma')
    })
    // Toggling a chip off an unfiltered run selects the other five.
    expect(result.current.filter.agentIds).toHaveLength(5)
    expect(result.current.filter.agentIds).not.toContain('a_worker_gamma')
    rerender({ run: HANDOFF })
    expect(result.current.filter.agentIds).toEqual([])
    // The handoff run has no gamma, so the lens cannot name one.
    expect(result.current.view.agentIds).not.toContain('a_worker_gamma')
  })

  it('clamps a window past the new run’s end', () => {
    const { result, rerender } = filterHook()
    act(() => {
      result.current.setWindow({ startMs: 0, endMs: 240_000 })
    })
    expect(result.current.view.windowLabel).toBe('0.0s → 4:00')
    rerender({ run: HANDOFF })
    expect(result.current.view.windowLabel).toBe('0.0s → 2:00')
  })

  it('keeps a lens the new run does support', () => {
    const { result, rerender } = filterHook()
    act(() => {
      result.current.toggleKind('message')
    })
    rerender({ run: HANDOFF })
    expect(result.current.filter.kinds).toEqual(['tool_call'])
  })

  it('dispatches a raw action through the escape hatch', () => {
    const { result } = filterHook()
    act(() => {
      result.current.dispatch({ type: 'setAgents', agentIds: ['a_worker_alpha'] })
    })
    expect(result.current.filter.agentIds).toEqual(['a_worker_alpha'])
    expect(result.current.view.messages.kept).toBe(1)
    expect(result.current.view.toolCalls.kept).toBe(0)
  })
})
