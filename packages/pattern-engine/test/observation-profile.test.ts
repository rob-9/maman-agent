import { describe, expect, it } from "vitest";
import type { PatternFeatureEvent } from "@maman/contracts";
import { pressEvidence, profileObservations } from "../src/observation-profile.js";

let seq = 0;
function ev(over: Partial<PatternFeatureEvent> = {}): PatternFeatureEvent {
  seq += 1;
  return {
    event_id: `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    occurred_at: "2026-09-21T10:00:00.000Z",
    monotonic_ms: seq * 1000,
    source: "macos_ax",
    app_category: "browser",
    event_type: "value_committed",
    sensitivity: "internal",
    excluded_from_learning: false,
    ...over,
  } as PatternFeatureEvent;
}

describe("profileObservations", () => {
  it("counts an empty corpus without inventing anything", () => {
    const p = profileObservations([]);
    expect(p).toEqual({
      events: 0,
      by_event_type: {},
      by_app_category: {},
      by_source: {},
      roles: [],
      roleless: 0,
      classified: 0,
      unclassified: 0,
      traced: 0,
      untraced: 0,
    });
  });

  it("tallies event types, categories and sources", () => {
    const p = profileObservations([
      ev({ event_type: "value_committed", app_category: "browser" }),
      ev({ event_type: "value_committed", app_category: "spreadsheet" }),
      ev({ event_type: "element_focused", app_category: "browser", source: "chrome" }),
    ]);
    expect(p.events).toBe(3);
    expect(p.by_event_type).toEqual({ value_committed: 2, element_focused: 1 });
    expect(p.by_app_category).toEqual({ browser: 2, spreadsheet: 1 });
    expect(p.by_source).toEqual({ macos_ax: 2, chrome: 1 });
  });

  it("keeps each role's event types separate", () => {
    // Focus and commit on the same role are different facts: only the focus
    // can become an inferred press.
    const p = profileObservations([
      ev({ target_role: "AXButton", event_type: "element_focused" }),
      ev({ target_role: "AXButton", event_type: "element_focused" }),
      ev({ target_role: "AXTextField", event_type: "value_committed" }),
    ]);
    expect(p.roles[0]).toEqual({
      role: "AXButton",
      count: 2,
      event_types: { element_focused: 2 },
    });
    expect(p.roles[1]!.event_types).toEqual({ value_committed: 1 });
  });

  it("counts events carrying no role at all", () => {
    const p = profileObservations([ev(), ev({ target_role: "" }), ev({ target_role: "AXButton" })]);
    expect(p.roleless).toBe(2);
    expect(p.roles).toHaveLength(1);
  });

  it("splits classified from unclassified", () => {
    const p = profileObservations([
      ev({ domain_object: "gl_entry" }),
      ev({ domain_action: "extract_field" }),
      ev(),
    ]);
    expect(p.classified).toBe(2);
    expect(p.unclassified).toBe(1);
  });

  it("splits traced from untraced", () => {
    const p = profileObservations([
      ev({ trace_ref: "00000000-0000-7000-8000-0000000000aa" }),
      ev(),
    ]);
    expect(p.traced).toBe(1);
    expect(p.untraced).toBe(1);
  });

  it("orders roles by frequency, then name, so the report is stable", () => {
    const p = profileObservations([
      ev({ target_role: "AXTextField" }),
      ev({ target_role: "AXTextField" }),
      ev({ target_role: "AXButton" }),
      ev({ target_role: "AXLink" }),
    ]);
    expect(p.roles.map((r) => r.role)).toEqual(["AXTextField", "AXButton", "AXLink"]);
  });
});

describe("pressEvidence", () => {
  it("reports presses when a button role was observed", () => {
    const e = pressEvidence(
      profileObservations([
        ev({ target_role: "AXButton", event_type: "element_focused" }),
        ev({ target_role: "AXTextField", event_type: "value_committed" }),
      ]),
    );
    expect(e.verdict).toBe("observed");
    expect(e.events).toBe(1);
    expect(e.focused).toBe(1);
  });

  it("distinguishes 'we looked and found none' from 'we could not look'", () => {
    // THE DISTINCTION THAT MATTERS. A corpus full of text fields and no buttons
    // says presses are not being captured. A corpus with no roles at all says
    // nothing about presses — and reporting "none" for it would be an answer
    // the data cannot support.
    const none = pressEvidence(
      profileObservations([
        ev({ target_role: "AXTextField" }),
        ev({ target_role: "AXStaticText" }),
      ]),
    );
    expect(none.verdict).toBe("none");

    const blind = pressEvidence(profileObservations([ev(), ev()]));
    expect(blind.verdict).toBe("no_roles_recorded");
    expect(blind.events).toBe(0);
  });

  it("counts focus separately from other event types on a press-like role", () => {
    // A button whose only appearance is a value_committed is NOT evidence that
    // a press can be inferred — only focus (or an explicit activation) is.
    const e = pressEvidence(
      profileObservations([
        ev({ target_role: "AXButton", event_type: "value_committed" }),
        ev({ target_role: "AXButton", event_type: "element_focused" }),
      ]),
    );
    expect(e.events).toBe(2);
    expect(e.focused).toBe(1);
  });

  it.each(["AXButton", "AXLink", "AXMenuItem", "AXRadioButton", "AXCheckBox", "button", "link"])(
    "recognises %s as press-like",
    (role) => {
      expect(pressEvidence(profileObservations([ev({ target_role: role })])).verdict).toBe(
        "observed",
      );
    },
  );

  it.each(["AXTextField", "AXTextArea", "AXStaticText", "textbox", "AXCell"])(
    "does not mistake %s for press-like",
    (role) => {
      expect(pressEvidence(profileObservations([ev({ target_role: role })])).verdict).toBe("none");
    },
  );

  it("agrees with the profile it was derived from", () => {
    // Derived, not re-walked — so the two can never disagree about one corpus.
    const profile = profileObservations([
      ev({ target_role: "AXButton" }),
      ev({ target_role: "AXButton" }),
      ev({ target_role: "AXTextField" }),
    ]);
    const e = pressEvidence(profile);
    const fromProfile = profile.roles.find((r) => r.role === "AXButton")!.count;
    expect(e.events).toBe(fromProfile);
  });
});
