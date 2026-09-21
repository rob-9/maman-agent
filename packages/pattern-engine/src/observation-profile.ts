import type { PatternFeatureEvent } from "@maman/contracts";

/**
 * WHAT THE OBSERVER IS ACTUALLY SEEING.
 *
 * `summarizeEligibility` explains why CANDIDATES were rejected. It cannot
 * explain an empty candidate list, and on a thin or semantically-poor history
 * that is the state you are in: no candidates, so no verdicts, so nothing to
 * read. This profiles the layer below — the raw feature events — so the
 * pipeline can be diagnosed from its input rather than its silence.
 *
 * It answers three questions that were being guessed at:
 *
 *  1. WHICH EVENT TYPES EXIST. A live macOS store showed only
 *     `value_committed` and `element_focused` as work events, with
 *     `element_activated`, `navigation`, `record_opened` and `table_read`
 *     never emitted at all. Capability mappings for tokens that never occur
 *     cost effort and change nothing.
 *  2. WHICH ROLES THOSE EVENTS CARRY. The AX lane has no click notification
 *     and infers a press from focus landing on a button, so "is a button ever
 *     focused" decides whether a recorded trace can contain the step that
 *     SUBMITS a form. If it cannot, a compiled agent fills fields and never
 *     saves — and reports success for the fields it did write.
 *  3. HOW MUCH IS CLASSIFIED. Pack templates need `domain_object` /
 *     `domain_action`; without them the cold-start path is unavailable no
 *     matter how much history accumulates.
 *
 * Pure, deterministic, no I/O. Counts only — never a label, a value or a host.
 */

export type RoleTally = {
  role: string;
  count: number;
  /** Which event types carried this role, so focus and commit stay separable. */
  event_types: Record<string, number>;
};

export type ObservationProfile = {
  events: number;
  by_event_type: Record<string, number>;
  by_app_category: Record<string, number>;
  by_source: Record<string, number>;
  /** Roles seen, most frequent first. */
  roles: RoleTally[];
  /** Events carrying no `target_role` at all. */
  roleless: number;
  /** Events a pack classifier gave a domain object or action. */
  classified: number;
  unclassified: number;
  /** Events joined to a replayable trace. */
  traced: number;
  untraced: number;
};

/**
 * Roles that denote something a person ACTIVATES rather than types into.
 *
 * A heuristic over an OPEN vocabulary, and labelled as one. `target_role` is a
 * free string — raw AX roles on the native lane, contract roles on the
 * relay — so this cannot be exhaustive, and a role it fails to recognise is
 * reported in `roles` regardless. It exists to answer one question quickly, not
 * to gate anything: nothing in the run path consults it.
 */
const PRESS_LIKE = /button|link|menuitem|menubutton|tab$|checkbox|radio|disclosure|popup/i;

export type PressEvidence = {
  /** Every press-like role observed, with the event types that carried it. */
  roles: RoleTally[];
  /** Total events on a press-like role. */
  events: number;
  /**
   * Press-like roles seen on a FOCUS event specifically. This is the number
   * that matters on the native lane, because that is the only way a press can
   * be inferred there.
   */
  focused: number;
  /**
   * `observed` — presses are being captured, so traces can contain a submit.
   * `none` — no press-like role appeared on any event, so every trace is
   * missing the step that completes the workflow.
   * `no_roles_recorded` — nothing carried a role at all, so the question is
   * unanswerable from this data rather than answered in the negative. Reported
   * separately because "we looked and found none" and "we could not look" call
   * for different responses.
   */
  verdict: "observed" | "none" | "no_roles_recorded";
};

function tally(into: Record<string, number>, key: string): void {
  into[key] = (into[key] ?? 0) + 1;
}

export function profileObservations(events: readonly PatternFeatureEvent[]): ObservationProfile {
  const byEventType: Record<string, number> = {};
  const byAppCategory: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const roleMap = new Map<string, RoleTally>();
  let roleless = 0;
  let classified = 0;
  let traced = 0;

  for (const e of events) {
    tally(byEventType, e.event_type);
    tally(byAppCategory, e.app_category);
    tally(bySource, e.source);

    if (e.target_role === undefined || e.target_role === "") {
      roleless += 1;
    } else {
      const entry = roleMap.get(e.target_role) ?? {
        role: e.target_role,
        count: 0,
        event_types: {},
      };
      entry.count += 1;
      tally(entry.event_types, e.event_type);
      roleMap.set(e.target_role, entry);
    }

    if (e.domain_object !== undefined || e.domain_action !== undefined) classified += 1;
    if (e.trace_ref !== undefined) traced += 1;
  }

  const roles = [...roleMap.values()].sort(
    (a, b) => b.count - a.count || a.role.localeCompare(b.role),
  );

  return {
    events: events.length,
    by_event_type: byEventType,
    by_app_category: byAppCategory,
    by_source: bySource,
    roles,
    roleless,
    classified,
    unclassified: events.length - classified,
    traced,
    untraced: events.length - traced,
  };
}

/**
 * Can a press be recovered from what was observed?
 *
 * Deliberately derived from the profile rather than re-walking the events, so
 * the two can never disagree about the same corpus.
 */
export function pressEvidence(profile: ObservationProfile): PressEvidence {
  const roles = profile.roles.filter((r) => PRESS_LIKE.test(r.role));
  const events = roles.reduce((n, r) => n + r.count, 0);
  const focused = roles.reduce(
    (n, r) =>
      n +
      Object.entries(r.event_types)
        .filter(([type]) => type === "element_focused" || type === "element_activated")
        .reduce((m, [, c]) => m + c, 0),
    0,
  );

  // No roles ANYWHERE is a different fact from no press-like roles among many.
  // Collapsing them would report "presses are not captured" about a corpus that
  // never recorded a role in the first place.
  const verdict: PressEvidence["verdict"] =
    events > 0 ? "observed" : profile.roles.length === 0 ? "no_roles_recorded" : "none";

  return { roles, events, focused, verdict };
}
