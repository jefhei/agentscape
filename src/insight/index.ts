/**
 * Public entry point for the spatial-insight layer (M5-T4).
 *
 * Three modules, one question — *does the scene earn its keep?*
 *
 * - {@link buildStructuralFacts} (`facts.ts`) derives the PRD §7 candidate facts
 *   from the trace and names the drawn channel that carries each one;
 * - {@link evaluateSpatialCriterion} (`access.ts`) prices each fact on both paths
 *   — rows read on a timeline vs marks read in the scene — and returns the
 *   criterion's verdict;
 * - {@link renderInsightMarkdown} (`report.ts`) renders the evidence document
 *   from those reports, so the committed doc cannot drift from the code.
 *
 * Everything here is pure and jsdom-testable (PRD §5). Nothing draws anything.
 */

export {
  DEFAULT_DOMINANCE_RATIO,
  DEFAULT_LOOP_MIN_BALANCE,
  DEFAULT_LOOP_MIN_TURNS,
  INSIGHT_KINDS,
  buildStructuralFacts,
  deriveMessageChannels,
  factOf,
} from './facts.ts'

export type {
  AgentCost,
  AgentFan,
  AgentVolume,
  ChannelVolume,
  CostEvidence,
  CostFact,
  FactBase,
  FanOutBasis,
  FanOutEvidence,
  FanOutFact,
  ImbalanceBasis,
  ImbalanceEvidence,
  ImbalanceFact,
  InsightKind,
  LoopEvidence,
  LoopFact,
  MessageChannel,
  ReciprocalPair,
  StructuralFact,
  StructuralFactOptions,
  StructuralFacts,
} from './facts.ts'

export {
  ACCESS_CHANNELS,
  CRITERION_MIN_FACTS,
  CRITERION_MIN_ROW_RATIO,
  FACT_VERDICTS,
  comparisonOf,
  evaluateSpatialCriterion,
} from './access.ts'

export type {
  AccessChannel,
  AccessPath,
  FactComparison,
  FactVerdict,
  InsightReport,
} from './access.ts'

export { describeInsight, renderInsightMarkdown } from './report.ts'

export type { InsightReportInput } from './report.ts'
