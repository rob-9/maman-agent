import { describe, expect, it } from "vitest";
import { describeCrm, describeGmail, noticeFrom, relative } from "../src/lib/connections-view.js";

/** The words on the Connections page, pinned to the states the API reports. */

const NOW = new Date("2026-09-21T12:00:00Z");

describe("relative time", () => {
  it("is coarse and never in the future", () => {
    expect(relative("2026-09-21T11:59:30Z", NOW)).toBe("just now");
    expect(relative("2026-09-21T11:48:00Z", NOW)).toBe("12 min ago");
    expect(relative("2026-09-21T09:00:00Z", NOW)).toBe("3 h ago");
    expect(relative("2026-09-19T12:00:00Z", NOW)).toBe("2 d ago");
    expect(relative("2026-09-21T13:00:00Z", NOW)).toBe("just now");
  });
});

describe("Gmail", () => {
  it("covers every status the API can report", () => {
    expect(describeGmail(undefined)).toMatchObject({ tone: "none", label: "Not connected" });
    expect(
      describeGmail(
        { status: "active", last_synced_at: "2026-09-21T11:48:00Z", last_error: null },
        NOW,
      ),
    ).toEqual({ tone: "ok", label: "Connected", detail: "Checked 12 min ago" });
    expect(
      describeGmail({ status: "active", last_synced_at: null, last_error: null }),
    ).toMatchObject({
      tone: "ok",
      detail: "Not checked yet",
    });
    expect(describeGmail({ status: "expired", last_synced_at: null, last_error: null }).tone).toBe(
      "warn",
    );
    expect(describeGmail({ status: "revoked", last_synced_at: null, last_error: null }).tone).toBe(
      "bad",
    );
    expect(
      describeGmail({ status: "error", last_synced_at: null, last_error: "HTTP 500" }),
    ).toMatchObject({
      tone: "bad",
      label: "Needs attention",
      detail: "Last check failed: HTTP 500",
    });
  });
});

describe("Salesforce", () => {
  it("says it is the team's, and what unknown deal state means when absent", () => {
    expect(describeCrm(undefined)).toMatchObject({ tone: "none", label: "Not connected" });
    expect(describeCrm(undefined).detail).toBe("Nothing is read until an admin connects it.");
    expect(
      describeCrm({ provider: "salesforce", status: "connected", last_verified_at: null }),
    ).toMatchObject({ tone: "ok", label: "Connected for your team" });
    expect(
      describeCrm({ provider: "salesforce", status: "degraded", last_verified_at: null }).tone,
    ).toBe("warn");
    expect(
      describeCrm({ provider: "salesforce", status: "revoked", last_verified_at: null }).tone,
    ).toBe("bad");
  });
});

describe("the banner after an OAuth round-trip", () => {
  it("reads the landing URL the API sends the browser to", () => {
    expect(noticeFrom({ provider: "gmail", connected: "1" })).toEqual({
      tone: "ok",
      text: "Google connected.",
    });
    expect(noticeFrom({ provider: "salesforce", error: "exchange_failed" })).toEqual({
      tone: "bad",
      text: "Salesforce sign-in did not complete. Try again.",
    });
    expect(noticeFrom({ provider: "hubspot", error: "weird" })).toEqual({
      tone: "bad",
      text: "Could not connect hubspot (weird).",
    });
    expect(noticeFrom({})).toBeNull();
  });
});
