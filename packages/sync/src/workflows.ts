/**
 * THE WORKER'S WORKFLOW ENTRY MODULE.
 *
 * A Temporal worker bundles exactly one workflows module, so every workflow
 * the worker runs is re-exported from here. Nothing else belongs in this
 * file: it is bundled into the workflow sandbox, where only
 * `@temporalio/workflow` and pure code may be imported.
 */
export * from "@maman/agent-runtime/workflow";
export * from "./workflow.js";
