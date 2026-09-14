/**
 * Predefined variables whose values change on every run or reference the local
 * machine. They are excluded from the job memoization fingerprint, since two
 * invocations that differ only in these variables produce identical results.
 *
 * User-supplied variables (`--variable`, gitlab-ci files) are always hashed.
 * Phase 3 (determinism) reuses this list.
 */
export const VOLATILE_VARIABLES: ReadonlySet<string> = new Set([
    // Run-specific identifiers
    "CI_PIPELINE_IID",
    "CI_PIPELINE_ID",
    "CI_PIPELINE_URL",
    "CI_JOB_ID",
    "CI_JOB_ID_URL",
    "CI_JOB_URL",
    "CI_JOB_NAME",
    "CI_JOB_NAME_SLUG",
    "CI_JOB_STAGE",
    "CI_JOB_STARTED_AT",
    "CI_JOB_STATUS",
    "CI_PIPELINE_CREATED_AT",
    "CI_COMMIT_TIMESTAMP", // generated per invocation, see GitData.init
    "CI_CONCURRENT_ID",

    // Machine-specific paths and runner identity
    "CI_PROJECT_DIR",
    "CI_BUILDS_DIR",
    "CI_RUNNER_ID",
    "CI_RUNNER_SHORT_TOKEN",
    "GCL_PROJECT_DIR_ON_HOST",

    // Registry credentials resolved at run time
    "CI_REGISTRY_USER",
    "CI_REGISTRY_PASSWORD",
]);
