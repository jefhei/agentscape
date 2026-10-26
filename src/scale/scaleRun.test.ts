import { describe, expect, it } from 'vitest'
import { agentIdFor } from '../adapter/index.ts'
import {
  FAN_OUT,
  SCALE_EPOCH_MS,
  buildScaleRun,
  scaleAgentId,
  scaleHubIndex,
} from './index.ts'

/**
 * Scaled-run builder tests (M5-T1).
 *
 * The builder feeds the scale probes, so the properties that matter are the
 * fixture rules applied at size: it goes through the **real** ingest path (never a
 * hand-built `Run`), it is deterministic from its options alone (no clock, no
 * randomness), and the topology it claims — hubs with fan-out, workers reporting
 * back — is actually present in the graph the layout will relax.
 */

describe('buildScaleRun (M5-T1)', () => {
  it('builds the requested number of agents through the real ingest path', () => {
    const { run, rows, agents } = buildScaleRun({ agents: 120, messagesPerAgent: 2 })

    expect(agents).toBe(120)
    expect(run.meta.agentCount).toBe(120)
    expect(run.agents).toHaveLength(120)
    expect(rows.length).toBe(run.messages.length)
    expect(run.id).toMatch(/^run_/)
  })

  it('is deterministic — same options, byte-identical run', () => {
    const first = buildScaleRun({ agents: 60, messagesPerAgent: 3 })
    const second = buildScaleRun({ agents: 60, messagesPerAgent: 3 })

    expect(JSON.stringify(second.rows)).toBe(JSON.stringify(first.rows))
    expect(JSON.stringify(second.run)).toBe(JSON.stringify(first.run))
    expect(second.run.id).toBe(first.run.id)
  })

  it('changes with the options', () => {
    const small = buildScaleRun({ agents: 20 })
    const large = buildScaleRun({ agents: 40 })

    expect(small.run.id).not.toBe(large.run.id)
    expect(large.run.meta.agentCount).toBeGreaterThan(small.run.meta.agentCount)
  })

  it('times every message from the fixed epoch, never the clock', () => {
    const { run } = buildScaleRun({ agents: 12 })

    expect(run.startedAt).toBe(SCALE_EPOCH_MS + 250)
    expect(run.endedAt).toBeGreaterThan(run.startedAt)
  })

  it('contains the hub fan-out the layout is supposed to make legible', () => {
    const { run } = buildScaleRun({ agents: FAN_OUT * 4, messagesPerAgent: 1 })
    // Agent ids are derived by the adapter (`a_<name>`), never the raw row name.
    const hub = agentIdFor(scaleAgentId(0))
    const assigns = run.toolCalls.filter(
      (call) => call.agentId === hub && call.name === 'assign_task',
    )

    // The first hub addresses its FAN_OUT - 1 workers.
    expect(assigns).toHaveLength(FAN_OUT - 1)
    // …and each of those workers reports back to it.
    for (let worker = 1; worker < FAN_OUT; worker += 1) {
      const id = agentIdFor(scaleAgentId(worker))
      expect(
        run.messages.some((message) => message.from === id && message.to === hub),
      ).toBe(true)
    }
  })

  it('gives hubs more traffic than leaves — the volume imbalance of a fleet', () => {
    const { run } = buildScaleRun({ agents: FAN_OUT * 2, messagesPerAgent: 1 })
    const busiest = [...run.agents].sort(
      (a, b) =>
        b.messagesSent + b.messagesReceived - (a.messagesSent + a.messagesReceived),
    )[0]
    const quietest = [...run.agents].sort(
      (a, b) =>
        a.messagesSent + a.messagesReceived - (b.messagesSent + b.messagesReceived),
    )[0]

    expect(busiest.messagesReceived).toBeGreaterThan(quietest.messagesReceived)
  })

  it('builds an empty run for a degenerate request', () => {
    const { run, rows } = buildScaleRun({ agents: 0 })

    expect(rows).toEqual([])
    expect(run.meta.agentCount).toBe(0)
    expect(run.messages).toEqual([])
  })
})

describe('scale id helpers (M5-T1)', () => {
  it('pads ids so canonical order is numeric order', () => {
    expect(scaleAgentId(0)).toBe('agent_0000')
    expect(scaleAgentId(9999)).toBe('agent_9999')
    const ids = [10, 2, 100].map(scaleAgentId).sort()
    expect(ids).toEqual(['agent_0002', 'agent_0010', 'agent_0100'])
  })

  it('maps every agent to the hub that owns it', () => {
    expect(scaleHubIndex(0)).toBe(0)
    expect(scaleHubIndex(FAN_OUT - 1)).toBe(0)
    expect(scaleHubIndex(FAN_OUT)).toBe(FAN_OUT)
    expect(scaleHubIndex(FAN_OUT * 3 + 5)).toBe(FAN_OUT * 3)
  })
})
