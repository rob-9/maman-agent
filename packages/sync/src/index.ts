/**
 * Jobs that compose connectors, the per-user vault, the workspace repository
 * and the detector into real paths. Consumed by BOTH the API (on-demand sync
 * after connect) and the worker (scheduled sweeps) — which is why this is a
 * package and not a file in either app: apps may not import apps.
 */
export { createUserVaultCredentialProvider, type UserVaultDeps } from "./user-vault-credentials.js";
export { createOrgVaultCredentialProvider, type OrgVaultDeps } from "./org-vault-credentials.js";
export {
  resolveDealSource,
  type DealSourceResolver,
  type ResolveDealSourceDeps,
} from "./deal-source.js";
export {
  runGmailSyncJob,
  type DealStepResult,
  type GmailSyncJobDeps,
  type GmailSyncJobResult,
} from "./sync-gmail.js";
export { createSweepActivities, listSweepTargets } from "./sweep.js";
export type {
  SweepActivities,
  SweepOutcome,
  SweepTarget,
  WorkspaceSweepResult,
} from "./workflow.js";
export { runAgentPass, type AgentDeps, type AgentPassResult } from "./assess.js";
export {
  decryptBody,
  encryptBody,
  storedThreadContent,
  toSyncedMessage,
  voiceExemplars,
} from "./content.js";
export { editDistance, matchSentDrafts, similarity, voiceFor, type Voice } from "./voice.js";
export { runCalendarStep, toSyncedMeeting, type CalendarStepResult } from "./sync-calendar.js";
export { meetingContext, type MeetingContext } from "./meetings.js";
export {
  activeRules,
  forgetIntent,
  intentsFor,
  listIntentViews,
  skippedWithReasons,
  stateIntent,
  type IntentView,
} from "./intents.js";
