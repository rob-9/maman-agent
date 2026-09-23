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
export { runDraftJob, type DraftJobDeps, type DraftJobResult } from "./draft-job.js";
export { runPredraft, type PredraftDeps, type PredraftResult } from "./predraft.js";
export {
  LOG_ACTIVITY,
  UPDATE_OPPORTUNITY,
  applyAction,
  proposeOpportunityUpdate,
  approveAction,
  autoActions,
  declineAction,
  diffHash,
  listActionViews,
  orgPolicyResolver,
  promoteAction,
  proposeActivityLog,
  revertAction,
  shapeHash,
  type ActionDeps,
  type ActionView,
  type ActivityDiff,
  type FieldChange,
  type OpportunityDiff,
} from "./actions.js";
export {
  runOpportunityPass,
  type OpportunityPassDeps,
  type OpportunityPassResult,
} from "./opportunity-pass.js";
export {
  caseRefFor,
  deriveEvents,
  runEventStep,
  EVENT_WINDOW_DAYS,
  type DerivedEvent,
  type EventStepDeps,
  type EventStepResult,
} from "./events.js";
export {
  runDiscoveryStep,
  DISMISSAL_COOLDOWN_DAYS,
  CONNECTOR_OPPORTUNITY_THRESHOLD,
  type DiscoveryDeps,
  type DiscoveryOptions,
  type DiscoveryResult,
} from "./discovery.js";
export {
  decideOnRoutine,
  routineView,
  routineViews,
  startRoutine,
  type RoutineEvidenceView,
  type RoutineView,
  type RoutineStepView,
  type RoutineWord,
} from "./routines.js";
export {
  compileRoutine,
  stepTokensOf,
  triggerTokenOf,
  ROUTINE_COMPILER,
  type CompiledRoutine,
} from "./routine-spec.js";
export {
  acceptedRoutines,
  ensureRoutineAgents,
  routineAgentState,
  startRoutineAgent,
  type EnsureAgentsResult,
} from "./routine-agents.js";
export {
  actualChanges,
  proposedChanges,
  routineRunSummary,
  runRoutines,
  type RoutineRunDeps,
  type RoutineRunResult,
  type RoutineRunSummary,
} from "./routine-runs.js";
