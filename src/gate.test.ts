import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Build-gate integrity test (M1-T2).
 *
 * The whole automated loop rests on one promise: `npm run verify` runs every
 * check. If a step is dropped from the `verify` chain — or `test` is left in
 * watch mode, or lint stops failing on warnings — the gate silently weakens
 * and later tasks can land "green" without actually being verified. This test
 * makes the gate itself a gated artefact: it reads `package.json` off disk and
 * asserts the wiring, so a regression fails the suite instead of hiding.
 *
 * Scope note (PRD §5): this guards the *pure* tooling half only. It says
 * nothing about the rendered look — visuals are human-held (M5-T5) and are
 * never gated in jsdom.
 */

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

const pkg = JSON.parse(
  readFileSync(resolve(findRepoRoot(process.cwd()), 'package.json'), 'utf8'),
) as { scripts: Record<string, string>; engines?: { node?: string } }

/** The five checks the gate's name promises, in the order `verify` runs them. */
const GATE_STEPS = ['lint', 'format:check', 'typecheck', 'test', 'build'] as const

describe('build gate (M1-T2)', () => {
  it('exposes each gate step as its own runnable script', () => {
    for (const step of GATE_STEPS) {
      expect(pkg.scripts[step], `missing script: ${step}`).toBeTruthy()
    }
  })

  it('runs every gate step from the single `verify` entrypoint', () => {
    const verify = pkg.scripts.verify
    expect(verify).toBeTruthy()
    for (const step of GATE_STEPS) {
      expect(verify, `verify does not run: ${step}`).toContain(`npm run ${step}`)
    }
  })

  it('orders `verify` lint → format → typecheck → test → build', () => {
    const verify = pkg.scripts.verify ?? ''
    const positions = GATE_STEPS.map((step) => verify.indexOf(`npm run ${step}`))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('runs tests once (vitest run), and keeps watch mode separate', () => {
    expect(pkg.scripts.test).toMatch(/vitest run/)
    expect(pkg.scripts['test:watch']).toMatch(/vitest/)
    expect(pkg.scripts['test:watch']).not.toMatch(/vitest run/)
  })

  it('makes lint fail on warnings, not just errors', () => {
    expect(pkg.scripts.lint).toContain('--deny-warnings')
  })

  it('pins a Node engine floor so the gate runs on the intended runtime', () => {
    expect(pkg.engines?.node).toBeTruthy()
  })
})
