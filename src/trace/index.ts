/**
 * The trace-selection seam (M5-T3): which run a URL asks the app to mount.
 *
 * One module, one parser, both schemes — `?trace=scale:<n>` (synthetic, for the
 * frame-budget measurement) and `?trace=fleet` (the real `debian2_bot` export).
 * See `traceQuery.ts` for the rules; this barrel is the import path.
 */
export {
  DEFAULT_MESSAGES_PER_AGENT,
  FLEET_TRACE_VALUE,
  MAX_MESSAGES_PER_AGENT,
  MAX_SCALE_AGENTS,
  SCALE_MESSAGES_PARAM,
  SCALE_TRACE_SCHEME,
  TRACE_PARAM,
  mountTrace,
  parseScaleTrace,
  parseTraceRequest,
  scaleTraceRun,
} from './traceQuery.ts'

export type {
  FleetTraceRequest,
  MountedTrace,
  ScaleTraceRequest,
  TraceRequest,
} from './traceQuery.ts'
