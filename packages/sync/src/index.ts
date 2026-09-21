/**
 * Jobs that compose connectors, the per-user vault, the workspace repository
 * and the detector into real paths. Consumed by BOTH the API (on-demand sync
 * after connect) and the worker (scheduled sweeps) — which is why this is a
 * package and not a file in either app: apps may not import apps.
 */
export { createUserVaultCredentialProvider, type UserVaultDeps } from "./user-vault-credentials.js";
export { runGmailSyncJob, type GmailSyncJobDeps, type GmailSyncJobResult } from "./sync-gmail.js";
