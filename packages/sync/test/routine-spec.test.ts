import { describe, expect, it } from "vitest";
import type { WorkflowEvent } from "@maman/contracts";
import type { RoutineCandidateRow } from "@maman/db";
import { compileRoutine, stepTokensOf, triggerTokenOf } from "../src/routine-spec.js";
import { actualChanges, proposedChanges } from "../src/routine-runs.js";

const ctx = {
  organizationId: "0192b3c4-0000-7000-8000-000000000001",
  userId: "0192b3c4-0000-7000-8000-000000000002",
};
const NOW = new Date("2026-09-22T12:00:00.000Z");
const SEQ = [
  "google:email:record_updated:recipient:received_reply:email_thread",
  "google:email:record_updated:sender:sent_reply:email_thread",
  "google:email:record_updated:sender:sent_reply:email_thread",
  "salesforce:crm:record_updated:-:update_opportunity:opportunity",
];
const row = (
  sequence: string[] = SEQ,
  over: Partial<RoutineCandidateRow> = {},
): RoutineCandidateRow => ({
  id: "0192b3c4-0000-7000-8000-0000000000d1",
  signature: sequence.join("|"),
  status: "eligible",
  decision: null,
  decided_at: null,
  title: "Reply and update the deal",
  summary: "You reply and update Salesforce.",
  occurrence_count: 4,
  distinct_day_count: 4,
  first_seen_at: "2026-09-01T10:00:00.000Z",
  last_seen_at: "2026-09-12T10:00:00.000Z",
  candidate: { canonical_sequence: sequence },
  naming: {},
  verdict: {},
  evidence: [],
  agent_id: null,
  evaluated_at: NOW.toISOString(),
  ...over,
});

describe("a routine, compiled", () => {
  it("the first step is the trigger; the rest become steps on the catalog's capability, never in write mode", () => {
    expect(triggerTokenOf(row())).toBe(SEQ[0]);
    expect(stepTokensOf(row())).toEqual([SEQ[1], SEQ[3]]);
    const c = compileRoutine(row(), ctx, NOW);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.spec.trigger).toEqual({
      type: "event",
      connector: "google",
      event_name: "record_updated:received_reply:email_thread",
    });
    expect(c.spec.steps.map((s) => [s.capability_id, s.mode, s.approval.required])).toEqual([
      ["gmail.create_draft", "propose_write", true],
      ["salesforce.propose_field_updates", "propose_write", true],
    ]);
    expect(c.spec.steps.every((s) => s.mode !== "write")).toBe(true);
    expect(c.spec.state).toBe("shadow");
    expect(c.spec.created_by).toBe("compiler");
    expect(c.spec.source_pattern_id).toBe(row().id);
    expect(c.spec.budgets.max_records_written).toBe(2);
    expect(c.plan.some((l) => l.includes("proposes changes only, writes nothing"))).toBe(true);
  });

  it("is deterministic: the same routine gives the same agent, hash and version, whenever it is compiled", () => {
    const a = compileRoutine(row(), ctx, NOW);
    const b = compileRoutine(row(), ctx, new Date("2026-10-01T00:00:00.000Z"));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.spec.agent_id).toBe(b.spec.agent_id);
    expect(a.spec_sha256).toBe(b.spec_sha256);
    expect(a.spec.version_id).toBe(b.spec.version_id);
    // A different person compiling the same shape gets a different agent.
    const other = compileRoutine(
      row(),
      { ...ctx, userId: "0192b3c4-0000-7000-8000-0000000000ff" },
      NOW,
    );
    expect(other.ok && other.spec.agent_id).not.toBe(a.spec.agent_id);
  });

  it("refuses a routine with a step no capability can do, and one with no step after the trigger", () => {
    const manual = compileRoutine(
      row([SEQ[0]!, "chrome:other:element_activated:button:x:thing"]),
      ctx,
      NOW,
    );
    expect(manual).toMatchObject({ ok: false, reason: "manual_step" });
    expect(compileRoutine(row([SEQ[0]!]), ctx, NOW)).toMatchObject({
      ok: false,
      reason: "no_steps",
    });
  });
});

describe("what a shadow run compares", () => {
  const CASE = "c".repeat(32);
  const ev = (
    over: Partial<WorkflowEvent> & { at: string; token: [string, string, string, string, string] },
  ): WorkflowEvent => ({
    schema_version: 1,
    event_id: "0192b3c4-0000-7000-8000-00000000e" + over.at.slice(14, 16) + "0",
    device_id: "0192b3c4-0000-7000-8000-0000000000de",
    user_id: ctx.userId,
    organization_id: ctx.organizationId,
    occurred_at: over.at,
    monotonic_ms: Date.parse(over.at),
    source: over.token[0] as WorkflowEvent["source"],
    app: { display_name: over.token[1] },
    event_type: over.token[2] as WorkflowEvent["event_type"],
    target: {
      semantic_type: over.token[4],
      ...(over.token[3] ? { role: over.token[3] } : {}),
      stable_id_hash: CASE,
    },
    context: {
      object_type: over.token[4].includes("opportunity") ? "opportunity" : "email_thread",
    },
    sensitivity: "internal",
    redaction: { applied: false, reasons: [] },
  });

  it("proposes one change per capability among the steps; the actual is the same mapping over the person's later events on the case", () => {
    const proposed = proposedChanges(row(), CASE);
    expect(proposed.map((p) => p.field)).toEqual([
      "gmail.create_draft",
      "salesforce.propose_field_updates",
    ]);
    expect(proposed.every((p) => p.object_ref === CASE)).toBe(true);
    const events = [
      ev({
        at: "2026-09-20T10:00:00.000Z",
        token: ["google", "Gmail", "record_updated", "recipient", "received_reply"],
      }),
      ev({
        at: "2026-09-20T12:00:00.000Z",
        token: ["google", "Gmail", "record_updated", "sender", "sent_reply"],
      }),
      ev({
        at: "2026-09-20T13:00:00.000Z",
        token: ["salesforce", "Salesforce", "record_updated", "", "update_opportunity"],
      }),
      ev({
        at: "2026-09-25T13:00:00.000Z",
        token: ["salesforce", "Salesforce", "record_updated", "", "update_opportunity"],
      }),
    ];
    const actual = actualChanges(
      events,
      CASE,
      "2026-09-20T10:00:00.000Z",
      "2026-09-23T10:00:00.000Z",
    );
    expect(actual.map((a) => a.field)).toEqual([
      "gmail.create_draft",
      "salesforce.propose_field_updates",
    ]);
    // Only what came after the trigger and before the window closed, on this case.
    const early = actualChanges(
      events,
      CASE,
      "2026-09-20T10:00:00.000Z",
      "2026-09-20T12:30:00.000Z",
    );
    expect(early.map((a) => a.field)).toEqual(["gmail.create_draft"]);
    expect(
      actualChanges(events, "d".repeat(32), "2026-09-20T10:00:00.000Z", "2026-09-23T10:00:00.000Z"),
    ).toEqual([]);
  });
});
