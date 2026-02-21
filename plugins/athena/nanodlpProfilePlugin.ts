/**
 * Backward-compatible Athena NanoDLP entrypoint.
 *
 * The original implementation lived in this single file. We now keep the logic
 * split into focused modules under `./nanodlp`, but re-export here so existing
 * imports continue to work unchanged.
 *
 * Integration note:
 * - Preferred import path for legacy call sites:
 *   `plugins/athena/nanodlpProfilePlugin`
 * - Internal source of truth:
 *   `plugins/athena/nanodlp/*`
 */
export * from './nanodlp';
