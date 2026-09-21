import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { envelopeDecrypt, envelopeEncrypt, packEnvelope, unpackEnvelope } from "../src/vault.js";

const master = randomBytes(32);
const secret = { access_token: "tok", refresh_token: "ref" };

describe("per-user envelope binding", () => {
  it("round-trips when org, user and provider all match", () => {
    const aad = { organization_id: "org", user_id: "alice", provider: "gmail" };
    const env = envelopeEncrypt(secret, master, aad);
    expect(envelopeDecrypt(env, master, aad)).toEqual(secret);
  });

  it("REFUSES to decrypt for a different user in the same org", () => {
    // THE PROPERTY. Copy alice's ciphertext into bob's row and it must be
    // garbage, not bob's new Gmail token.
    const env = envelopeEncrypt(secret, master, {
      organization_id: "org",
      user_id: "alice",
      provider: "gmail",
    });
    expect(() =>
      envelopeDecrypt(env, master, { organization_id: "org", user_id: "bob", provider: "gmail" }),
    ).toThrow();
  });

  it("an org-bound envelope does not decrypt as user-bound, nor the reverse", () => {
    const orgEnv = envelopeEncrypt(secret, master, { organization_id: "org", provider: "gmail" });
    expect(() =>
      envelopeDecrypt(orgEnv, master, {
        organization_id: "org",
        user_id: "alice",
        provider: "gmail",
      }),
    ).toThrow();
    const userEnv = envelopeEncrypt(secret, master, {
      organization_id: "org",
      user_id: "alice",
      provider: "gmail",
    });
    expect(() =>
      envelopeDecrypt(userEnv, master, { organization_id: "org", provider: "gmail" }),
    ).toThrow();
  });

  it("stays compatible: org-only AAD is unchanged for existing callers", () => {
    const aad = { organization_id: "org", provider: "salesforce" };
    expect(envelopeDecrypt(envelopeEncrypt(secret, master, aad), master, aad)).toEqual(secret);
  });

  it("packs to one column and unpacks to the identical envelope", () => {
    const aad = { organization_id: "org", user_id: "alice", provider: "gmail" };
    const env = envelopeEncrypt(secret, master, aad);
    const back = unpackEnvelope(packEnvelope(env));
    expect(back.ciphertext.equals(env.ciphertext)).toBe(true);
    expect(back.encrypted_data_key.equals(env.encrypted_data_key)).toBe(true);
    expect(back.key_version).toBe(env.key_version);
    expect(envelopeDecrypt(back, master, aad)).toEqual(secret);
  });

  it("rejects a malformed packed value rather than guessing", () => {
    expect(() => unpackEnvelope(Buffer.from('{"c":1}'))).toThrow(/malformed/);
  });
});
