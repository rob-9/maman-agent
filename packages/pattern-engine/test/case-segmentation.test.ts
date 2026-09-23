import { describe, expect, it } from "vitest";
import type { PatternFeatureEvent, WorkflowEvent } from "@maman/contracts";
import { runPatternEngine } from "../src/engine.js";
import { toPatternFeature } from "../src/projection.js";
import { CASE_GAP_BOUNDARY_MS, segmentByCase, segmentEpisodes } from "../src/segmentation.js";
import { OPPORTUNITY_THRESHOLD } from "../src/scoring.js";

const CASE_A = "a".repeat(32);
const CASE_B = "b".repeat(32);
let counter = 0;
function evt(overrides: Partial<PatternFeatureEvent> = {}): PatternFeatureEvent {
  counter++;
  return {
    event_id: `00000000-0000-7000-8000-${String(counter).padStart(12, "0")}`,
    occurred_at: "2026-09-01T10:00:00.000Z",
    monotonic_ms: counter,
    source: "google",
    app_category: "email",
    event_type: "record_updated",
    target_role: "sender",
    semantic_type: "sent_reply",
    object_type: "email_thread",
    sensitivity: "internal",
    excluded_from_learning: false,
    case_ref: CASE_A,
    ...overrides,
  };
}
const day = 24 * 60 * 60 * 1000;
const at = (base: string, offsetMs: number, over: Partial<PatternFeatureEvent> = {}) =>
  evt({ occurred_at: new Date(Date.parse(base) + offsetMs).toISOString(), ...over });

/** One run of a routine around one contact: a reply arrives, a reply goes, the CRM is updated. */
function routine(start: string, caseRef: string): PatternFeatureEvent[] {
  return [
    at(start, 0, { case_ref: caseRef, target_role: "recipient", semantic_type: "received_reply" }),
    at(start, 2 * 60 * 60 * 1000, { case_ref: caseRef }),
    at(start, 3 * 60 * 60 * 1000, {
      case_ref: caseRef,
      source: "salesforce",
      app_category: "crm",
      target_role: undefined,
      semantic_type: "update_opportunity",
      object_type: "opportunity",
    }),
  ];
}

describe("segmentation by case", () => {
  it("groups events by case across hours, splits on days of quiet, and leaves caseless events out", () => {
    const events = [
      ...routine("2026-09-01T10:00:00.000Z", CASE_A),
      ...routine("2026-09-01T11:00:00.000Z", CASE_B),
      ...routine("2026-09-10T10:00:00.000Z", CASE_A),
      at("2026-09-02T10:00:00.000Z", 0, { case_ref: undefined }),
      at("2026-09-02T10:00:01.000Z", 0, { case_ref: undefined }),
      at("2026-09-02T10:00:02.000Z", 0, { case_ref: undefined }),
    ];
    const episodes = segmentByCase(events);
    expect(episodes.map((e) => e.events.length)).toEqual([3, 3, 3]);
    expect(new Set(episodes.map((e) => e.events[0]!.case_ref))).toEqual(new Set([CASE_A, CASE_B]));
    // Hours apart is one episode; the time segmenter would have closed it after ten minutes.
    expect(segmentEpisodes(events).length).toBe(1);
    expect(CASE_GAP_BOUNDARY_MS).toBe(3 * day);
  });

  it("keeps the engine's floors: fewer than three events on a case is not an episode", () => {
    const two = routine("2026-09-01T10:00:00.000Z", CASE_A).slice(0, 2);
    expect(segmentByCase(two)).toEqual([]);
  });

  it("the gap is configurable, and the order of episodes is by time then id, run to run", () => {
    const events = [
      ...routine("2026-09-01T10:00:00.000Z", CASE_A),
      ...routine("2026-09-03T10:00:00.000Z", CASE_A),
    ];
    expect(segmentByCase(events, { case_gap_boundary_ms: day }).length).toBe(2);
    expect(segmentByCase(events, { case_gap_boundary_ms: 5 * day }).length).toBe(1);
    const a = segmentByCase(events).map((e) => e.episode_id);
    const b = segmentByCase([...events].reverse()).map((e) => e.episode_id);
    expect(a).toEqual(b);
  });

  it("the engine finds the routine through the case segmenter and not through the time one", () => {
    const events = [
      ...routine("2026-09-01T10:00:00.000Z", CASE_A),
      ...routine("2026-09-02T10:00:00.000Z", CASE_B),
      ...routine("2026-09-05T10:00:00.000Z", CASE_A),
      ...routine("2026-09-08T10:00:00.000Z", CASE_B),
    ];
    const base = {
      owner_user_id: "00000000-0000-7000-8000-00000000aaaa",
      now: () => new Date("2026-09-10T00:00:00.000Z"),
    };
    const byCase = runPatternEngine(events, {
      ...base,
      segment: (evs) => segmentByCase(evs),
      eligibility: { min_projected_minutes_weekly: 0 },
      // The ranking bar without the time term a connector stream cannot measure.
      opportunity_threshold: OPPORTUNITY_THRESHOLD - 0.25,
    });
    expect(byCase.episodes.length).toBe(4);
    expect(byCase.candidates.length).toBe(1);
    const c = byCase.candidates[0]!;
    expect(c.occurrence_count).toBe(4);
    expect(c.distinct_day_count).toBe(4);
    expect(c.status).toBe("eligible");
    expect(c.canonical_sequence).toEqual([
      "google:email:record_updated:recipient:received_reply:email_thread",
      "google:email:record_updated:sender:sent_reply:email_thread",
      "salesforce:crm:record_updated:-:update_opportunity:opportunity",
    ]);
    const byTime = runPatternEngine(events, {
      ...base,
      eligibility: { min_projected_minutes_weekly: 0 },
      opportunity_threshold: OPPORTUNITY_THRESHOLD - 0.25,
    });
    expect(byTime.candidates.length).toBe(0);
  });

  it("the projection carries the case only as a 32-hex hash from the target's stable id", () => {
    const base: WorkflowEvent = {
      schema_version: 1,
      event_id: "00000000-0000-7000-8000-000000000001",
      device_id: "00000000-0000-7000-8000-000000000002",
      user_id: "00000000-0000-7000-8000-000000000003",
      organization_id: "00000000-0000-7000-8000-000000000004",
      occurred_at: "2026-09-01T10:00:00.000Z",
      monotonic_ms: 1,
      source: "google",
      app: { display_name: "Gmail" },
      event_type: "record_updated",
      target: { semantic_type: "sent_reply", stable_id_hash: CASE_A },
      context: { object_type: "email_thread" },
      sensitivity: "internal",
      redaction: { applied: false, reasons: [] },
    };
    expect(toPatternFeature(base).case_ref).toBe(CASE_A);
    expect(toPatternFeature({ ...base, target: { semantic_type: "x" } }).case_ref).toBeUndefined();
    // A stable id that is not a hash never becomes a case.
    expect(
      toPatternFeature({
        ...base,
        target: { semantic_type: "x", stable_id_hash: "bob@client.com" },
      }).case_ref,
    ).toBeUndefined();
  });
});
