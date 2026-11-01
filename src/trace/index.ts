/**
 * The trace-selection seam (M5-T3): which run a URL asks the app to mount.
 *
 * One module, one parser, three schemes — `?trace=scale:<n>` (synthetic, for the
 * frame-budget measurement), `?trace=fleet` (the real `debian2_bot` export) and
 * `?trace=fixture:<shape>` (a deterministic fixture, M6-T2). See `traceQuery.ts`
 * for the rules; this barrel is the import path.
 */
export {
  DEFAULT_MESSAGES_PER_AGENT,
  FIXTURE_TRACE_SCHEME,
  FLEET_TRACE_VALUE,
  MAX_MESSAGES_PER_AGENT,
  MAX_SCALE_AGENTS,
  SCALE_MESSAGES_PARAM,
  SCALE_TRACE_SCHEME,
  TRACE_PARAM,
  mountTrace,
  parseScaleTrace,
  parseTraceRequest,
  readQueryParam,
  readTraceParam,
  scaleTraceRun,
  traceRequestQuery,
} from './traceQuery.ts'

export type {
  FixtureTraceRequest,
  FleetTraceRequest,
  MountedTrace,
  ScaleTraceRequest,
  TraceRequest,
} from './traceQuery.ts'
