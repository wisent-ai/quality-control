// Exit statuses are the existing Quality Control CLI contract, not tunable thresholds.
export const EXIT = Object.freeze({ clean: 0, findings: 1, error: 2 });
export const REPORT_SCHEMA_VERSION = 1;
// Bound captured child output; exceeding this limit is reported as an error, never a clean audit.
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
