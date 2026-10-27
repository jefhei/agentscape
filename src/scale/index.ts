/**
 * The scale layer's barrel (M5-T1): the level-of-detail policy, the per-frame
 * work measurement, and the large synthetic run the scale probes are built from.
 *
 * Kept as one entry point so a consumer (the scene plans, a probe, M5-T2's
 * report) imports "the scale policy" rather than four sibling paths.
 */

export {
  DETAIL_TIERS,
  DETAIL_TIER_RANK,
  NODE_SEGMENT_RUNGS,
  ARC_TESSELLATION_RUNGS,
  GLYPH_CAP_RUNGS,
  SETTLE_RUNGS,
  SETTLE_PAIR_BUDGET,
  MIN_SETTLE_ITERATIONS,
  relaxationPairs,
  settleIterationsFor,
  resolveDetailPlan,
  settlementWithDetail,
  glyphKeepCount,
  describeDetail,
} from './lod.ts'
export type {
  DetailTier,
  DetailCounts,
  DetailOptions,
  DetailPlan,
  NodeDetail,
  ArcDetail,
  GlyphDetail,
  SettlementDetail,
} from './lod.ts'

export {
  FRAME_CPU_BUDGET_MS,
  FRAME_RATE,
  FRAME_WRITE_COST_NS,
  measureFrameWork,
} from './frameWork.ts'
export type { FrameCounts, FrameScene, FrameWork } from './frameWork.ts'

export {
  SCALE_EPOCH_MS,
  FAN_OUT,
  buildScaleRun,
  scaleAgentId,
  scaleHubIndex,
} from './scaleRun.ts'
export type { ScaleRun, ScaleRunOptions } from './scaleRun.ts'

export {
  SCALE_TRACE_SCHEME,
  SCALE_TRACE_PARAM,
  SCALE_MESSAGES_PARAM,
  DEFAULT_MESSAGES_PER_AGENT,
  MAX_SCALE_AGENTS,
  MAX_MESSAGES_PER_AGENT,
  parseScaleTrace,
  scaleTraceRun,
} from './scaleQuery.ts'
export type { ScaleTraceRequest } from './scaleQuery.ts'

export {
  PROFILE_FRAME_BUDGET_MS,
  PROFILE_VERDICT_PERCENTILE,
  ProfileError,
  summarizeFrameSamples,
  medianCost,
  measuredFrameCostMs,
  costBreakdownMs,
  buildProfileReport,
  renderProfileMarkdown,
  describeProfile,
} from './profile.ts'
export type {
  FrameStats,
  WriteLoop,
  ProfileCosts,
  ProfileDetail,
  ProfileReport,
  ProfileReportInput,
  ProfileScene,
  ProfileSceneCounts,
  ProfileSceneReading,
  ProfileTarget,
} from './profile.ts'
