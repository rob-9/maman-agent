import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptBody, encryptBody, toSyncedMessage } from "../src/content.js";

/** Mail content is encrypted to the person. The AAD is the whole point. */
const key = randomBytes(32);
const alice = { organizationId: "org-1", userId: "alice" };
const bob = { organizationId: "org-1", userId: "bob" };

describe("content encryption", () => {
  it("round-trips for the person it was encrypted to", () => {
    const ct = encryptBody("Can you confirm pricing for 60 seats?", key, alice);
    expect(Buffer.from(ct).toString("utf8")).not.toContain("60 seats");
    expect(decryptBody(ct, key, alice)).toBe("Can you confirm pricing for 60 seats?");
  });

  it("refuses to open for a colleague in the same organization, or with another key", () => {
    const ct = encryptBody("secret plans", key, alice);
    expect(() => decryptBody(ct, key, bob)).toThrow();
    expect(() => decryptBody(ct, randomBytes(32), alice)).toThrow();
  });

  it("makes a projected message storable, keeping the plaintext length beside the ciphertext", () => {
    const m = toSyncedMessage(
      {
        external_id: "m1",
        from_address: "s@a.com",
        from_display_name: "S",
        direction: "inbound",
        sent_at: "2026-09-21T12:00:00.000Z",
        text: "hello there",
      },
      key,
      alice,
    );
    expect(m).toMatchObject({
      external_id: "m1",
      from_display_name: "S",
      direction: "inbound",
      body_chars: 11,
    });
    expect(decryptBody(m.body_ciphertext, key, alice)).toBe("hello there");
  });
});
