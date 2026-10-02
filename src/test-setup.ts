import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// RTL's auto-cleanup relies on a global afterEach; vitest runs with
// globals disabled, so register it explicitly here.
afterEach(() => {
  cleanup()
})

// jsdom ships no canvas 2D implementation: calling getContext('2d') returns
// null AND emits a noisy "Not implemented" jsdomError per call. Return null
// silently instead — M5-T1 procedural textures degrade to flat materials in
// tests (their pixel generators are tested directly, and material tests
// inject stub canvas factories). Editor tests re-stub getContext per test
// via vi.spyOn, which layers on top of this.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return null
  } as typeof HTMLCanvasElement.prototype.getContext
}
