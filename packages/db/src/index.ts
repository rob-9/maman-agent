export * as schema from "./schema.js";
export { createDbClient, type DbClient } from "./client.js";
export {
  withTenant,
  withUser,
  MissingTenantContextError,
  MissingUserContextError,
  type TenantContext,
  type UserContext,
} from "./tenant.js";
export {
  loadMigrations,
  migrateUp,
  migrateDown,
  appliedMigrationIds,
  type Migration,
} from "./migrator.js";
export {
  appendAuditEvent,
  appendAuditEventTx,
  verifyAuditChain,
  hashAuditEvent,
  type AuditEventInput,
  type ChainVerification,
} from "./audit.js";
export * from "./repositories.js";
export * from "./factories.js";
export {
  upsertSyncedThreads,
  loadDetectionInputs,
  replacePendingObligations,
  listPendingObligations,
  type SyncedThread,
  type UpsertResult,
  type DetectionInputs,
  type DetectedObligation,
  type PendingObligationRow,
  getUserConnection,
  updateUserConnectionCredentials,
  markUserConnectionSync,
  type UserConnectionRow,
  createUserConnection,
  listUserConnections,
  setObligationOutcome,
  type UserConnectionView,
  type ObligationOutcome,
} from "./workspace.js";
