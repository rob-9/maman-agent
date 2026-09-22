import { describe, expect, it } from "vitest";
import { diffHash, shapeHash } from "../src/actions.js";

describe("what approval binds to", () => {
  it("hashes the diff canonically: key order does not matter, values do", () => {
    const a = { kind: "k", subject: "S", contact_email: "x@y.com", activity_date: "2026-09-22" };
    const b = { activity_date: "2026-09-22", contact_email: "x@y.com", subject: "S", kind: "k" };
    expect(diffHash(a)).toBe(diffHash(b));
    expect(diffHash({ ...a, subject: "S2" })).not.toBe(diffHash(a));
    expect(diffHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the shape is the kind and the field names, not the values", () => {
    const one = shapeHash("salesforce.log_activity", {
      kind: "salesforce.log_activity",
      subject: "A",
      contact_email: "a@b.c",
    });
    const two = shapeHash("salesforce.log_activity", {
      kind: "salesforce.log_activity",
      subject: "B",
      contact_email: "z@b.c",
    });
    const three = shapeHash("salesforce.log_activity", {
      kind: "salesforce.log_activity",
      subject: "A",
      contact_email: "a@b.c",
      stage: "Closed",
    });
    expect(one).toBe(two);
    expect(one).not.toBe(three);
    expect(shapeHash("other.kind", { subject: "A", contact_email: "a@b.c" })).not.toBe(one);
  });
});
