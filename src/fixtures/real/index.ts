/**
 * The real exported runs (M5-T3).
 *
 * A separate barrel from `../index.ts` on purpose: the fixtures barrel is
 * imported by the scale/profile probes, which run under
 * `node --experimental-strip-types` and therefore must stay free of bundler-only
 * imports (the snapshot here is loaded with Vite's `?raw`). Import real runs from
 * `../fixtures/real`, synthetic ones from `../fixtures`.
 */
export {
  FLEET_EXPORT_CAPTURED_AT,
  FLEET_EXPORT_DATASET,
  FLEET_EXPORT_REDACTIONS,
  FLEET_EXPORT_REGION,
  FLEET_EXPORT_ROWS,
  FLEET_EXPORT_TABLE,
  FLEET_RUN,
  FLEET_RUN_LABEL,
  buildFleetRun,
  summarizeFleetExport,
} from './fleetExport.ts'

export type { FleetExportSummary } from './fleetExport.ts'
