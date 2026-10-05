// Exit statuses are the existing Quality Control CLI contract, not tunable thresholds.
export const EXIT = Object.freeze({ clean: 0, findings: 1, error: 2 });
export const REPORT_SCHEMA_VERSION = 1;
// Child output (git, the guards an audit runs) is captured whole: no byte bound is chosen here.
export const MAX_OUTPUT_BYTES = Infinity;
// What an audit records for one repository: the guard's exit status by name, or a failure to run it.
export const RESULT = Object.freeze({ clean: 'clean', findings: 'findings', error: 'error' });
