/**
 * Structural facts — the pure half of the "3D earns its keep" criterion (M5-T4).
 *
 * PRD §7 makes one claim load-bearing: *the scene must surface at least two
 * structural facts faster than a timeline does*. That claim cannot be tested by
 * looking at a picture (jsdom has no GPU, and the look is human-held — M5-T5), so
 * this module does the half that *can* be tested: it **derives the structural
 * facts from the trace** and states, for each one, which drawn channel carries it
 * and what a reader of the raw export would have to do instead.
 *
 * The four candidates are the PRD's own (§7):
 *
 * | kind | the question | drawn because |
 * |---|---|---|
 * | `fan-out` | who puts the most agents to work, and how many? | a node's incident arc fan, animated in the net direction (M3-T2) |
 * | `loop` | is a pair/ring still going round? | the heaviest arc, drawn from both ends, with no net flow to animate |
 * | `imbalance` | where does the traffic concentrate? | node radius + glow (activity, M3-T1/T4) and arc width (volume, M2-T3) |
 * | `cost` | where did the money go? | **nothing** — v1 draws no cost channel, and the export records no cost |
 *
 * ## Derived, never assumed
 *
 * Every number here is re-derived from the trace's own messages — never from a
 * precomputed field that might have drifted, and never from a name heuristic.
 * Two rules follow and are worth stating because they are the product's honesty
 * constraints:
 *
 * - **A fan-out is counted two ways, and the module says which.** M2-T4 derives
 *   `spawn` children from a declared `action` (`assign_task`, `delegate`, …).
 *   When the run's vocabulary supports that ({@link StructuralFacts.hierarchyDerivable}),
 *   the fan-out is the child count. When it does not — the real `debian2_bot`
 *   export records `script_ready` / `review_complete`, so it derives *zero* spawn
 *   edges (M5-T3 finding 3) — the only fan the trace supports is **message
 *   reach**: how many distinct agents a node addressed. The run-level `basis`
 *   says which one was used, so a reader is never told a reach is a hierarchy.
 * - **Reciprocation is not a loop.** Two agents that exchange messages in both
 *   directions are a *channel*, not necessarily a runaway: the real fleet's
 *   busiest channel runs 103:33 one way over 136 days, which is a hub
 *   relationship. A loop is symmetric traffic — each side answering the other
 *   repeatedly — so a pair only qualifies when it also has a balance of at least
 *   {@link DEFAULT_LOOP_MIN_BALANCE}. The rejected pairs are still reported, with
 *   their numbers, because "the busiest channel is asymmetric" is itself the
 *   imbalance fact.
 *
 * ## Purity (PRD §5)
 *
 * Pure: no three.js, no DOM, no clock, no `Math.random`, no mutation. Messages
 * are read in canonical `(at, id)` order and every list is sorted by
 * `compareModelIds`, so the same trace yields a byte-identical
 * {@link StructuralFacts} whatever order its arrays arrive in. Nothing here
 * draws anything — the magnitudes and channels this reports are M2/M3's, and
 * whether they *read* well is M5-T5's question.
 */

import type { AgentId, MessageId } from '../types/index.ts'
import type { TraceModel } from '../model/index.ts'
import { compareModelIds } from '../model/index.ts'
import { deriveEdgeModel } from '../layout/edges.ts'
import type { EdgeKind, EdgeModel } from '../layout/edges.ts'

// ── Public vocabulary ───────────────────────────────────────────────────────

/**
 * The PRD §7 candidates, in the order the criterion lists them. `EventKind`-style:
 * the union is derived from this list so the two can never disagree.
 */
export const INSIGHT_KINDS = ['fan-out', 'loop', 'imbalance', 'cost'] as const

/** One of the {@link INSIGHT_KINDS} tags. */
export type InsightKind = (typeof INSIGHT_KINDS)[number]

/**
 * How much more traffic the top agent / channel must carry than the next one
 * before the run is called *imbalanced*. A 2× gap is the smallest one that reads
 * as a difference rather than a tie, and the fixtures bracket it on both sides:
 * the fan-out fixture is 10× (orchestrator 10 activity vs 1), the loop fixture is
 * a tie between its two workers (7 vs 6, ratio 1.17) and qualifies only on its
 * *channel* (6 messages vs 1).
 */
export const DEFAULT_DOMINANCE_RATIO = 2

/**
 * How many turns each way a pair must exchange before it can be a loop. One turn
 * each way is a request and its reply (the dead-branch fixture's
 * `worker_ok ⇄ orchestrator`); two is the least that repeats.
 */
export const DEFAULT_LOOP_MIN_TURNS = 2

/**
 * How symmetric a reciprocating pair must be, `1 - |a→b − b→a| / (a→b + b→a)`,
 * before it reads as a loop rather than a hub relationship. The loop fixture is
 * exactly `1.0` (3 drafts, 3 revisions); the real fleet's busiest channel is
 * `0.49` (103 vs 33) and is correctly *not* a loop.
 */
export const DEFAULT_LOOP_MIN_BALANCE = 0.8

/** A reciprocating pair must send at least this many messages in total. */
const MIN_CHANNEL_VOLUME = 1

// ── Channels: the drawn arcs, with their direction kept ─────────────────────

/**
 * One undirected communication channel between two agents — exactly what the
 * scene draws as **one arc** (M2-T1's link, M3-T2's tube) — with the traffic in
 * each direction kept, because the arc's animation encodes the *net* direction
 * and the loop detector needs the two counters.
 *
 * `a` is always the canonically-first id, so the pair has one spelling.
 */
export interface MessageChannel {
  /** Canonically-first endpoint. */
  a: AgentId
  /** Canonically-last endpoint. */
  b: AgentId
  /** Messages `a → b`. */
  fromAToB: number
  /** Messages `b → a`. */
  fromBToA: number
  /** `fromAToB + fromBToA` — the drawn arc's width input (M2-T3). */
  volume: number
  /** The backing message ids, in canonical order. */
  messageIds: MessageId[]
  /** Earliest message on the channel, epoch ms. */
  firstAt: number
  /** Latest message on the channel, epoch ms. */
  lastAt: number
}

/** One agent's read off the channel set. */
export interface AgentFan {
  agentId: AgentId
  /**
   * Distinct other agents it **addressed** — the recipients of its own messages,
   * a broadcast counting every other agent. This is the fan the scene draws:
   * a broadcast really is a spoke to each agent, which is why it is counted, and
   * why {@link broadcastReach} is reported beside it (a wide fan made of five
   * shouts is a different fact from one made of nine assignments).
   */
  reach: number
  /** Distinct recipients of its **directed** messages (broadcasts excluded). */
  directedReach: number
  /** Distinct agents its **broadcasts** reached. */
  broadcastReach: number
  /** Broadcast rows it sent — one row, a spoke per other agent. */
  broadcastsSent: number
  /** Channels where it sent more than it received — arcs that flow away from it. */
  netOut: number
  /** Channels where it received more — arcs that flow toward it. */
  netIn: number
  /** Channels with the same traffic each way — arcs with nothing to animate. */
  balanced: number
  /** `netOut + netIn + balanced`: distinct partners, i.e. drawn spokes. */
  spokes: number
  /** Derived spawn children (M2-T4), canonical order; empty when none. */
  childIds: AgentId[]
}

// ── Evidence shapes (one per kind, discriminated by `kind`) ──────────────────

/** How a fan-out was counted, and the ranking behind the answer. */
export type FanOutBasis = 'spawn' | 'reach'

/** Evidence for the `fan-out` fact. */
export interface FanOutEvidence {
  kind: 'fan-out'
  /** `spawn` when M2-T4 derives children for this run, else `reach`. */
  basis: FanOutBasis
  /** Every agent's fan, ranked by this run's basis then by id. */
  ranking: AgentFan[]
  /** The widest fan's agent, or `null` for an empty run. */
  topAgentId: AgentId | null
  /** That agent's fan size under {@link basis} (`0` when nobody fans out). */
  topFanOut: number
  /** That agent's distinct-partner count (what the eye counts as spokes). */
  topSpokes: number
  /** That agent's distinct addressed agents (the fan, broadcasts included). */
  topReach: number
  /** Broadcast rows the top agent sent — one row, a spoke per other agent. */
  topBroadcastsSent: number
  /** Distinct agents the top agent's broadcasts reached. */
  topBroadcastReach: number
  /** Every channel touching the top agent leaves it — a one-way fan. */
  topOneWay: boolean
  /** Agents with at least two children / recipients. */
  fannedAgents: number
}

/** One reciprocating pair: both directions carried traffic. */
export interface ReciprocalPair {
  /** Canonically-first member. */
  a: AgentId
  /** Canonically-last member. */
  b: AgentId
  /** Messages `a → b`. */
  fromAToB: number
  /** Messages `b → a`. */
  fromBToA: number
  /** `min(fromAToB, fromBToA)` — full turns each side answered. */
  turns: number
  /** `1 - |a→b − b→a| / (a→b + b→a)`; `1` is perfectly symmetric. */
  balance: number
  /** Total messages on the pair. */
  volume: number
  /** The backing message ids, canonical order. */
  messageIds: MessageId[]
  /** First / last message on the pair, epoch ms. */
  firstAt: number
  lastAt: number
  /** The run's final message belongs to this pair — nothing concluded it. */
  openAtEnd: boolean
  /** Symmetric enough and repeated enough to read as a loop. */
  loop: boolean
}

/** A directed ring of three or more agents is NOT detected here — see the note below. */

/** Evidence for the `loop` fact. */
export interface LoopEvidence {
  kind: 'loop'
  /** Every pair that exchanged at least {@link DEFAULT_LOOP_MIN_TURNS} each way. */
  pairs: ReciprocalPair[]
  /** Pairs that exchanged messages in both directions at all (turns included). */
  reciprocating: number
  /** How many pairs qualify as loops (symmetric and repeated). */
  loops: number
  /** The run's last message sits inside a qualifying loop. */
  endsInsideLoop: boolean
  /** The pair with the most turns, qualifying or not, or `null`. */
  busiestPair: ReciprocalPair | null
}

/** One agent's share of the run's traffic. */
export interface AgentVolume {
  agentId: AgentId
  /** Messages it sent. */
  sent: number
  /** Messages it received. */
  received: number
  /** Tool calls attributed to it. */
  toolCalls: number
  /** `sent + received + toolCalls` — the node-glow input (M2-T3). */
  activity: number
  /** `activity / total activity`; `0` for an empty run. */
  share: number
}

/** One channel's share of the run's traffic. */
export interface ChannelVolume {
  a: AgentId
  b: AgentId
  /** Messages on the channel. */
  volume: number
  /** `volume / total messages`; `0` for an empty run. */
  share: number
}

/** Which side of the comparison carried the imbalance. */
export type ImbalanceBasis = 'agent' | 'channel'

/** Evidence for the `imbalance` fact. */
export interface ImbalanceEvidence {
  kind: 'imbalance'
  /** Agents by activity, descending (id as the tie-break). */
  agents: AgentVolume[]
  /** Channels by volume, descending (endpoints as the tie-break). */
  channels: ChannelVolume[]
  /** Total messages (the denominator of a channel share). */
  totalMessages: number
  /** Total activity (the denominator of an agent share). */
  totalActivity: number
  /** The busiest agent, or `null` for an empty run. */
  topAgentId: AgentId | null
  /** `top activity / next activity`, `1` when there is nothing to compare. */
  agentRatio: number
  /** `top volume / next volume`, `1` when there is nothing to compare. */
  channelRatio: number
  /** Which comparison cleared {@link DEFAULT_DOMINANCE_RATIO}, or `null`. */
  basis: ImbalanceBasis | null
}

/** One agent's recorded spend. */
export interface AgentCost {
  agentId: AgentId
  costUsd: number
  /** `cost / total cost`; `0` when nothing was recorded. */
  share: number
}

/** Evidence for the `cost` fact. */
export interface CostEvidence {
  kind: 'cost'
  /** Whether the export carried any cost figure at all. */
  recorded: boolean
  /** Agents by cost, descending; empty when nothing was recorded. */
  agents: AgentCost[]
  /** Total recorded spend, USD (`0` when unrecorded — see {@link recorded}). */
  totalCostUsd: number
  /** The largest spend's share, `0` when unrecorded. */
  topShare: number
  /** The largest spender, or `null`. */
  topAgentId: AgentId | null
}

/** What every fact carries regardless of kind. */
export interface FactBase {
  /** The question a reader asks, phrased as the criterion's candidate fact. */
  question: string
  /** The answer, in words, already formatted. */
  answer: string
  /** A one-line form for a compact UI. */
  short: string
  /** The agents the answer points at (the spatial referents), canonical order. */
  agentIds: AgentId[]
  /** Whether the run carries the data this fact needs. */
  supported: boolean
  /** Why it cannot be answered, or `null` when it can. */
  reason: string | null
}

/** The `fan-out` fact: who puts the most agents to work. */
export interface FanOutFact extends FactBase {
  kind: 'fan-out'
  evidence: FanOutEvidence
}

/** The `loop` fact: is something still going round? */
export interface LoopFact extends FactBase {
  kind: 'loop'
  evidence: LoopEvidence
}

/** The `imbalance` fact: where the traffic concentrates. */
export interface ImbalanceFact extends FactBase {
  kind: 'imbalance'
  evidence: ImbalanceEvidence
}

/** The `cost` fact: where the money went. */
export interface CostFact extends FactBase {
  kind: 'cost'
  evidence: CostEvidence
}

/** Any structural fact. Discriminated on `kind`, so a switch is exhaustive. */
export type StructuralFact = FanOutFact | LoopFact | ImbalanceFact | CostFact

/** The full derivation for one run. */
export interface StructuralFacts {
  /** The run id this was derived from. */
  runId: string
  /** The four facts, in {@link INSIGHT_KINDS} order. */
  facts: StructuralFact[]
  /** Every drawn channel, canonical order (the arcs the scene holds). */
  channels: MessageChannel[]
  /** Every agent's channel read, canonical id order. */
  fans: AgentFan[]
  /** Whether M2-T4 derives any `spawn` edge on this run's vocabulary. */
  hierarchyDerivable: boolean
  /** Edge counts per kind, for a caller that wants the vocabulary's verdict. */
  edgeCounts: Record<EdgeKind, number>
  /** Distinct non-self agent pairs that carried traffic. */
  pairCount: number
  /** The run's last message's endpoints, or `null` for an empty run. */
  lastExchange: { from: AgentId; to: AgentId | null } | null
}

/** Optional overrides for {@link buildStructuralFacts}. */
export interface StructuralFactOptions {
  /** Agent/channel dominance multiple; default {@link DEFAULT_DOMINANCE_RATIO}. */
  dominanceRatio?: number
  /** Turns each way before a pair may be a loop; default {@link DEFAULT_LOOP_MIN_TURNS}. */
  loopMinTurns?: number
  /** Symmetry before a pair may be a loop; default {@link DEFAULT_LOOP_MIN_BALANCE}. */
  loopMinBalance?: number
  /** A pre-derived edge model, to avoid deriving it twice (M2-T4 is not cheap). */
  edgeModel?: EdgeModel
}

// ── Numeric helpers ─────────────────────────────────────────────────────────

/** A finite positive override, or its default. */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

/** `numerator / denominator`, or `0` when the denominator is zero. */
function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

/** A share in `[0, 1]`, rounded to four decimals so a printed number is stable. */
function share(part: number, whole: number): number {
  return Math.round(ratio(part, whole) * 10_000) / 10_000
}

/** A multiple, rounded to two decimals. */
function multiple(numerator: number, denominator: number): number {
  return Math.round(ratio(numerator, denominator) * 100) / 100
}

/** `1 agent` / `6 agents`. */
function count(count_: number, singular: string, plural: string): string {
  return `${count_} ${count_ === 1 ? singular : plural}`
}

/** An integer percentage (`86`), for prose. */
function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}

// ── Channel derivation ──────────────────────────────────────────────────────

/**
 * Derive the undirected channels from the messages, keeping each direction.
 *
 * Mirrors {@link deriveLayoutLinks} (M2-T1) in one respect — a broadcast reaches
 * every other agent, so it contributes a spoke to each — and differs in one:
 * the two directions are counted separately, because the drawn arc's animation
 * is derived from the *net* traffic (M3-T2) and the loop detector must see both
 * counters. A self-message adds nothing: it has no channel to draw.
 */
export function deriveMessageChannels(model: TraceModel): MessageChannel[] {
  const agentIds = model.agents.map((agent) => agent.id).sort(compareModelIds)
  const messages = [...model.messages].sort(
    (a, b) => a.at - b.at || compareModelIds(a.id, b.id),
  )
  const byKey = new Map<string, MessageChannel>()

  const record = (from: AgentId, to: AgentId, message: TraceMessage): void => {
    if (from === to) return
    const a = compareModelIds(from, to) <= 0 ? from : to
    const b = a === from ? to : from
    const key = `${a}\u0000${b}`
    let channel = byKey.get(key)
    if (channel === undefined) {
      channel = {
        a,
        b,
        fromAToB: 0,
        fromBToA: 0,
        volume: 0,
        messageIds: [],
        firstAt: message.at,
        lastAt: message.at,
      }
      byKey.set(key, channel)
    }
    if (from === a) channel.fromAToB += 1
    else channel.fromBToA += 1
    channel.volume += 1
    channel.messageIds.push(message.id)
    if (message.at < channel.firstAt) channel.firstAt = message.at
    if (message.at > channel.lastAt) channel.lastAt = message.at
  }

  for (const message of messages) {
    if (message.to !== null) {
      record(message.from, message.to, message)
      continue
    }
    for (const id of agentIds) record(message.from, id, message)
  }

  return [...byKey.values()]
    .map((channel) => ({
      ...channel,
      messageIds: [...channel.messageIds].sort(compareModelIds),
    }))
    .sort((x, y) => compareModelIds(x.a, y.a) || compareModelIds(x.b, y.b))
}

/** The message fields the channel pass reads (a structural narrowing of `Message`). */
type TraceMessage = TraceModel['messages'][number]

// ── Rings of three or more agents: deliberately not detected here ───────────
//
// A multi-agent ring (A → B → C → A) is a real loop shape, but the *cumulative*
// message graph cannot tell a ring from a set of one-off forwards: any cluster of
// agents that has talked in both directions collapses into one strongly connected
// component, and calling that a loop fires on every real fleet that ever replies
// to itself (the M5-T3 export reduced to a single six-agent "ring" on the first
// attempt). Proving a ring went *round* needs a temporal path — a chain of
// messages with increasing timestamps that returns to its origin — which is a
// different algorithm with different failure modes, i.e. post-MVP work (M6-T5),
// not something to fake with a degree count. So v1 detects the loop the PRD
// actually names — an unbounded sub-agent bouncing work with its counterpart
// (a reciprocating pair; see {@link loopFact}) — and says plainly in the M5-T4
// write-up what it does not detect.

// ── The detectors ───────────────────────────────────────────────────────────

/** A phrase for a fan-out's basis, used in the answer text. */
function basisNoun(basis: FanOutBasis): string {
  return basis === 'spawn' ? 'agents put to work' : 'agents addressed'
}

/** Build the `fan-out` fact. */
function fanOutFact(edgeModel: EdgeModel, fans: AgentFan[]): FanOutFact {
  const basis: FanOutBasis = edgeModel.counts.spawn > 0 ? 'spawn' : 'reach'
  const fanOf = (fan: AgentFan): number =>
    basis === 'spawn' ? fan.childIds.length : fan.reach
  const ranking = [...fans].sort(
    (a, b) =>
      fanOf(b) - fanOf(a) || b.reach - a.reach || compareModelIds(a.agentId, b.agentId),
  )
  const top = ranking.length > 0 ? ranking[0] : null
  const topFanOut = top === null ? 0 : fanOf(top)
  const topOneWay = top !== null && top.netIn === 0 && top.balanced === 0
  const fannedAgents = ranking.filter((fan) => fanOf(fan) >= 2).length
  const supported = topFanOut >= 2

  const question =
    basis === 'spawn'
      ? 'Which agent has the widest fan-out, and how many agents does it drive?'
      : 'Which agent addresses the most agents, and how many?'

  const answer =
    supported && top !== null
      ? `${top.agentId} — ${topFanOut} ${basisNoun(basis)}` +
        `, from ${count(top.spokes, 'drawn channel', 'drawn channels')}` +
        (topOneWay
          ? ' (all one-way)'
          : ` (${top.netIn} net-in, ${top.balanced} balanced)`) +
        (top.broadcastsSent > 0
          ? `; ${count(top.broadcastsSent, 'broadcast row reaches', 'broadcast rows reach')} ${top.broadcastReach} of them`
          : '') +
        (basis === 'spawn'
          ? ''
          : ' — message reach, not a derived hierarchy (no spawn edges)')
      : 'No agent fans out: every agent addresses at most one other.'

  const reason = supported
    ? null
    : basis === 'spawn'
      ? `No agent fans out on this run: the widest spawn is ${topFanOut} ${topFanOut === 1 ? 'child' : 'children'}.`
      : `No agent fans out on this run: the widest message reach is ${topFanOut} ${topFanOut === 1 ? 'agent' : 'agents'}.`

  return {
    kind: 'fan-out',
    question,
    answer,
    short: supported && top !== null ? `${top.agentId} · ${topFanOut}` : 'no fan-out',
    agentIds: supported && top !== null ? [top.agentId] : [],
    supported,
    reason,
    evidence: {
      kind: 'fan-out',
      basis,
      ranking,
      topAgentId: supported && top !== null ? top.agentId : null,
      topFanOut,
      topSpokes: top === null ? 0 : top.spokes,
      topReach: top === null ? 0 : top.reach,
      topBroadcastsSent: top === null ? 0 : top.broadcastsSent,
      topBroadcastReach: top === null ? 0 : top.broadcastReach,
      topOneWay,
      fannedAgents,
    },
  }
}

/** Build the `loop` fact. */
function loopFact(
  model: TraceModel,
  channels: MessageChannel[],
  options: Required<Pick<StructuralFactOptions, 'loopMinTurns' | 'loopMinBalance'>>,
): LoopFact {
  const last =
    model.messages.length > 0 ? model.messages[model.messages.length - 1] : null
  const lastKey =
    last === null || last.to === null || last.from === last.to
      ? null
      : (compareModelIds(last.from, last.to) <= 0 ? last.from : last.to) +
        '\u0000' +
        (compareModelIds(last.from, last.to) <= 0 ? last.to : last.from)

  const pairs: ReciprocalPair[] = []
  for (const channel of channels) {
    if (channel.volume < MIN_CHANNEL_VOLUME * 2) continue
    const turns = Math.min(channel.fromAToB, channel.fromBToA)
    if (turns < options.loopMinTurns) continue
    const balance = share(Math.abs(channel.fromAToB - channel.fromBToA), channel.volume)
    const symmetry = Math.round((1 - balance) * 10_000) / 10_000
    const key = `${channel.a}\u0000${channel.b}`
    pairs.push({
      a: channel.a,
      b: channel.b,
      fromAToB: channel.fromAToB,
      fromBToA: channel.fromBToA,
      turns,
      balance: symmetry,
      volume: channel.volume,
      messageIds: [...channel.messageIds],
      firstAt: channel.firstAt,
      lastAt: channel.lastAt,
      openAtEnd: key === lastKey,
      loop: symmetry >= options.loopMinBalance,
    })
  }
  pairs.sort(
    (x, y) =>
      y.turns - x.turns ||
      y.balance - x.balance ||
      compareModelIds(x.a, y.a) ||
      compareModelIds(x.b, y.b),
  )

  // Rings of three or more agents are deliberately not detected — see the
  // section note above the detectors.
  const loops = pairs.filter((pair) => pair.loop).length
  const supported = loops > 0
  const strongest = pairs.find((pair) => pair.loop) ?? null
  const loopPairs = pairs.filter((pair) => pair.loop)
  const endsInsideLoop =
    last === null ? false : loopPairs.some((pair) => pair.openAtEnd)
  const busiestPair = pairs.length > 0 ? pairs[0] : null

  const question = 'Is a pair still going round — a sub-agent loop that never settled?'

  const reciprocating = channels.filter(
    (channel) => channel.fromAToB > 0 && channel.fromBToA > 0,
  ).length

  let answer: string
  if (strongest !== null) {
    answer =
      `${strongest.a} ⇄ ${strongest.b} — ${count(strongest.turns, 'turn', 'turns')} each way` +
      ` (${strongest.fromAToB}→ / ${strongest.fromBToA}←, ${percent(strongest.balance)} symmetric)` +
      (strongest.openAtEnd ? '; the run ends inside the loop' : '')
  } else if (busiestPair !== null) {
    answer =
      `No loop: the busiest two-way channel, ${busiestPair.a} ⇄ ${busiestPair.b}, is asymmetric ` +
      `(${busiestPair.fromAToB}→ / ${busiestPair.fromBToA}←, ${percent(busiestPair.balance)} symmetric) ` +
      '— a hub relationship, not a loop'
  } else if (reciprocating > 0) {
    answer =
      `No loop: ${count(reciprocating, 'pair', 'pairs')} exchange once each way — a request and its ` +
      'reply — and nothing repeats.'
  } else {
    answer = 'No loop: no pair exchanges messages in both directions.'
  }

  const reason = supported
    ? null
    : busiestPair !== null
      ? `No symmetric repeated exchange (busiest two-way channel is ${percent(busiestPair.balance)} symmetric; a loop needs ${Math.round(options.loopMinBalance * 100)}%).`
      : reciprocating > 0
        ? `${count(reciprocating, 'pair', 'pairs')} reciprocate once each way; a loop needs ${options.loopMinTurns} turns.`
        : 'No pair exchanges messages in both directions.'

  return {
    kind: 'loop',
    question,
    answer,
    short:
      strongest !== null
        ? `${strongest.a} ⇄ ${strongest.b} · ${strongest.turns} turns`
        : 'no loop',
    agentIds: strongest !== null ? [strongest.a, strongest.b] : [],
    supported,
    reason,
    evidence: {
      kind: 'loop',
      pairs,
      reciprocating,
      loops,
      endsInsideLoop,
      busiestPair,
    },
  }
}

/** Tool calls per agent, as a lookup (the contract carries no per-agent field). */
function toolCallsByAgent(model: TraceModel): Map<AgentId, number> {
  const counts = new Map<AgentId, number>()
  for (const call of model.toolCalls) {
    counts.set(call.agentId, (counts.get(call.agentId) ?? 0) + 1)
  }
  return counts
}

/** Build the `imbalance` fact. */
function imbalanceFact(
  model: TraceModel,
  channels: MessageChannel[],
  options: Required<Pick<StructuralFactOptions, 'dominanceRatio'>>,
): ImbalanceFact {
  const calls = toolCallsByAgent(model)
  const agents: AgentVolume[] = model.agents
    .map((agent) => {
      const toolCalls = calls.get(agent.id) ?? 0
      return {
        agentId: agent.id,
        sent: agent.messagesSent,
        received: agent.messagesReceived,
        toolCalls,
        activity: agent.messagesSent + agent.messagesReceived + toolCalls,
        share: 0,
      }
    })
    .sort((a, b) => b.activity - a.activity || compareModelIds(a.agentId, b.agentId))

  const totalActivity = agents.reduce((total, agent) => total + agent.activity, 0)
  const rankedAgents = agents.map((agent) => ({
    ...agent,
    share: share(agent.activity, totalActivity),
  }))

  const totalMessages = model.messages.length
  const rankedChannels: ChannelVolume[] = [...channels]
    .sort(
      (x, y) =>
        y.volume - x.volume || compareModelIds(x.a, y.a) || compareModelIds(x.b, y.b),
    )
    .map((channel) => ({
      a: channel.a,
      b: channel.b,
      volume: channel.volume,
      share: share(channel.volume, totalMessages),
    }))

  const agentRatio =
    rankedAgents.length < 2
      ? 1
      : multiple(rankedAgents[0].activity, Math.max(1, rankedAgents[1].activity))
  const channelRatio =
    rankedChannels.length < 2
      ? 1
      : multiple(rankedChannels[0].volume, Math.max(1, rankedChannels[1].volume))

  const agentDominant = agentRatio >= options.dominanceRatio
  const channelDominant =
    channelRatio >= options.dominanceRatio && rankedChannels.length >= 2

  // The stronger of the two comparisons names the fact; a tie goes to the agent,
  // because "one agent carries the run" is the more useful reading.
  const basis: ImbalanceBasis | null = agentDominant
    ? 'agent'
    : channelDominant
      ? 'channel'
      : null

  const topAgent = rankedAgents.length > 0 ? rankedAgents[0] : null
  const topChannel = rankedChannels.length > 0 ? rankedChannels[0] : null

  const question =
    'Where does the run’s traffic concentrate — one agent, or one channel?'

  let answer: string
  if (basis === 'agent' && topAgent !== null) {
    answer =
      `${topAgent.agentId} carries ${percent(topAgent.share)} of the run’s activity ` +
      `(${topAgent.activity} of ${totalActivity}), ${agentRatio}× the next agent`
  } else if (basis === 'channel' && topChannel !== null) {
    answer =
      `one channel carries ${percent(topChannel.share)} of the messages ` +
      `(${topChannel.a} ⇄ ${topChannel.b}, ${topChannel.volume} of ${totalMessages}), ` +
      `${channelRatio}× the next channel`
  } else {
    answer = 'No concentration: traffic is spread evenly across agents and channels.'
  }

  const reason =
    basis === null
      ? `No agent or channel clears ${options.dominanceRatio}× the next one (agents ${agentRatio}×, channels ${channelRatio}×).`
      : null

  const agentIds =
    basis === 'agent' && topAgent !== null
      ? [topAgent.agentId]
      : basis === 'channel' && topChannel !== null
        ? [topChannel.a, topChannel.b]
        : []

  return {
    kind: 'imbalance',
    question,
    answer,
    short:
      basis === 'agent'
        ? `${topAgent?.agentId ?? ''} · ${percent(topAgent?.share ?? 0)} of activity`
        : basis === 'channel'
          ? `${topChannel?.a ?? ''} ⇄ ${topChannel?.b ?? ''} · ${percent(topChannel?.share ?? 0)}`
          : 'even',
    agentIds,
    supported: basis !== null,
    reason,
    evidence: {
      kind: 'imbalance',
      agents: rankedAgents,
      channels: rankedChannels,
      totalMessages,
      totalActivity,
      topAgentId: topAgent === null ? null : topAgent.agentId,
      agentRatio,
      channelRatio,
      basis,
    },
  }
}

/** Build the `cost` fact. */
function costFact(model: TraceModel): CostFact {
  const totals = new Map<AgentId, number>()
  for (const agent of model.agents) totals.set(agent.id, 0)
  for (const message of model.messages) {
    if (message.costUsd > 0)
      totals.set(message.from, (totals.get(message.from) ?? 0) + message.costUsd)
  }
  for (const call of model.toolCalls) {
    if (call.costUsd > 0)
      totals.set(call.agentId, (totals.get(call.agentId) ?? 0) + call.costUsd)
  }
  const totalCostUsd = [...totals.values()].reduce((total, cost) => total + cost, 0)
  const recorded = totalCostUsd > 0 && Number.isFinite(totalCostUsd)

  const agents: AgentCost[] = recorded
    ? [...totals.entries()]
        .filter(([, cost]) => cost > 0)
        .map(([agentId, costUsd]) => ({
          agentId,
          costUsd,
          share: share(costUsd, totalCostUsd),
        }))
        .sort((a, b) => b.costUsd - a.costUsd || compareModelIds(a.agentId, b.agentId))
    : []

  const top = agents.length > 0 ? agents[0] : null

  return {
    kind: 'cost',
    question: 'Where did the run’s spend concentrate?',
    answer:
      recorded && top !== null
        ? `${top.agentId} accounts for ${percent(top.share)} of the recorded spend ($${totalCostUsd.toFixed(4)})`
        : 'Not recorded: this export carries no token or cost column, so no agent can be charged.',
    short:
      recorded && top !== null
        ? `${top.agentId} · ${percent(top.share)} of spend`
        : 'not recorded',
    agentIds: top === null ? [] : [top.agentId],
    supported: recorded && top !== null,
    reason:
      recorded && top !== null
        ? null
        : 'The export records no cost figures (the adapter sets them to 0), and v1 draws no cost channel — PRD §4.2 lists a cost heat overlay as post-MVP.',
    evidence: {
      kind: 'cost',
      recorded,
      agents,
      totalCostUsd: recorded ? totalCostUsd : 0,
      topShare: top === null ? 0 : top.share,
      topAgentId: top === null ? null : top.agentId,
    },
  }
}

// ── The derivation ──────────────────────────────────────────────────────────

/**
 * Derive every structural fact for one normalized run.
 *
 * Pure and deterministic: the same trace yields a byte-identical
 * {@link StructuralFacts} whatever order its arrays arrive in, and the model is
 * never mutated.
 *
 * @param model a normalized trace (M1-T5).
 * @param options detector thresholds and an optional pre-derived edge model.
 */
export function buildStructuralFacts(
  model: TraceModel,
  options: StructuralFactOptions = {},
): StructuralFacts {
  const dominanceRatio = positive(options.dominanceRatio, DEFAULT_DOMINANCE_RATIO)
  const loopMinTurns = positive(options.loopMinTurns, DEFAULT_LOOP_MIN_TURNS)
  const loopMinBalance = positive(options.loopMinBalance, DEFAULT_LOOP_MIN_BALANCE)

  const edgeModel = options.edgeModel ?? deriveEdgeModel(model)
  const channels = deriveMessageChannels(model)
  const childOf = new Map(
    edgeModel.agents.map((lineage) => [lineage.agentId, [...lineage.childIds]]),
  )

  // Per-agent fan read: who it addressed (its own messages — a broadcast
  // counting every other agent) and how its channels lean (canonical id order).
  const agentIds = model.agents.map((agent) => agent.id).sort(compareModelIds)
  const directed = new Map<AgentId, Set<AgentId>>()
  const broadcast = new Map<AgentId, Set<AgentId>>()
  const broadcastsSent = new Map<AgentId, number>()
  for (const message of model.messages) {
    if (message.to !== null) {
      if (message.to === message.from) continue
      const set = directed.get(message.from) ?? new Set<AgentId>()
      set.add(message.to)
      directed.set(message.from, set)
      continue
    }
    broadcastsSent.set(message.from, (broadcastsSent.get(message.from) ?? 0) + 1)
    const set = broadcast.get(message.from) ?? new Set<AgentId>()
    for (const id of agentIds) if (id !== message.from) set.add(id)
    broadcast.set(message.from, set)
  }

  const fans: AgentFan[] = agentIds.map((agentId) => {
    let netOut = 0
    let netIn = 0
    let balanced = 0
    for (const channel of channels) {
      if (channel.a !== agentId && channel.b !== agentId) continue
      const sent = channel.a === agentId ? channel.fromAToB : channel.fromBToA
      const received = channel.a === agentId ? channel.fromBToA : channel.fromAToB
      if (sent > received) netOut += 1
      else if (sent < received) netIn += 1
      else balanced += 1
    }
    const direct = directed.get(agentId) ?? new Set<AgentId>()
    const shouted = broadcast.get(agentId) ?? new Set<AgentId>()
    const addressed = new Set<AgentId>([...direct, ...shouted])
    return {
      agentId,
      reach: addressed.size,
      directedReach: direct.size,
      broadcastReach: shouted.size,
      broadcastsSent: broadcastsSent.get(agentId) ?? 0,
      netOut,
      netIn,
      balanced,
      spokes: netOut + netIn + balanced,
      childIds: childOf.get(agentId) ?? [],
    }
  })

  const last =
    model.messages.length > 0 ? model.messages[model.messages.length - 1] : null

  return {
    runId: model.id,
    facts: [
      fanOutFact(edgeModel, fans),
      loopFact(model, channels, { loopMinTurns, loopMinBalance }),
      imbalanceFact(model, channels, { dominanceRatio }),
      costFact(model),
    ],
    channels,
    fans,
    hierarchyDerivable: edgeModel.counts.spawn > 0,
    edgeCounts: { ...edgeModel.counts },
    pairCount: channels.length,
    lastExchange: last === null ? null : { from: last.from, to: last.to },
  }
}

/** The fact of `kind`, or `null` when the derivation has none (a lookup). */
export function factOf(
  facts: StructuralFacts,
  kind: InsightKind,
): StructuralFact | null {
  for (const fact of facts.facts) {
    if (fact.kind === kind) return fact
  }
  return null
}
