import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption for connector credentials:
 * - a fresh random 256-bit data key per credential
 * - the data key wrapped by the master key (local dev: env master key;
 *   production: a KMS-backed wrap, same interface)
 * Tokens are never returned to desktop clients or the extension — only this
 * server-side vault can open them.
 */

/**
 * What a ciphertext is BOUND to. Decryption fails if any part differs.
 *
 * `user_id` is optional for compatibility with org-installed connectors, and
 * REQUIRED in spirit for anything per-user: without it, an encrypted Gmail
 * token could be copied from one rep's row to another's in the same org and
 * would still decrypt. The AAD is the only thing that makes "this secret
 * belongs to this person" a cryptographic fact rather than a column value.
 */
export type EnvelopeAad = { organization_id: string; user_id?: string; provider: string };

function aadFor(parts: EnvelopeAad, keyVersion: number): Buffer {
  // The user segment is positional, so an org-bound and a user-bound AAD can
  // never collide — `org:provider:v` and `org:user:provider:v` differ in shape.
  const segments = [parts.organization_id];
  if (parts.user_id !== undefined) segments.push(`u=${parts.user_id}`);
  segments.push(parts.provider, String(keyVersion));
  return Buffer.from(segments.join(":"));
}

/**
 * One-column storage form. `user_connections.encrypted_credentials` is a
 * single bytea, unlike `connector_accounts` which spreads the envelope over
 * three columns. Both directions are exact inverses; a byte of drift fails
 * decryption loudly rather than yielding a wrong token silently.
 */
export function packEnvelope(env: EnvelopeCiphertext): Buffer {
  return Buffer.from(
    JSON.stringify({
      c: env.ciphertext.toString("base64"),
      k: env.encrypted_data_key.toString("base64"),
      v: env.key_version,
    }),
  );
}

export function unpackEnvelope(packed: Uint8Array): EnvelopeCiphertext {
  const o = JSON.parse(Buffer.from(packed).toString()) as { c: string; k: string; v: number };
  if (typeof o.c !== "string" || typeof o.k !== "string" || typeof o.v !== "number") {
    throw new Error("malformed packed envelope");
  }
  return {
    ciphertext: Buffer.from(o.c, "base64"),
    encrypted_data_key: Buffer.from(o.k, "base64"),
    key_version: o.v,
  };
}

export type EnvelopeCiphertext = {
  ciphertext: Buffer; // nonce || aes-256-gcm ciphertext of the payload
  encrypted_data_key: Buffer; // nonce || wrap of the data key
  key_version: number;
};

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function open(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  const nonce = sealed.subarray(0, 12);
  const tag = sealed.subarray(sealed.length - 16);
  const body = sealed.subarray(12, sealed.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function envelopeEncrypt(
  payload: Record<string, unknown>,
  masterKey: Buffer,
  aadParts: EnvelopeAad,
  keyVersion = 1,
): EnvelopeCiphertext {
  if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");
  const aad = aadFor(aadParts, keyVersion);
  const dataKey = randomBytes(32);
  const ciphertext = seal(dataKey, Buffer.from(JSON.stringify(payload)), aad);
  const encryptedDataKey = seal(masterKey, dataKey, aad);
  return { ciphertext, encrypted_data_key: encryptedDataKey, key_version: keyVersion };
}

export function envelopeDecrypt(
  envelope: EnvelopeCiphertext,
  masterKey: Buffer,
  aadParts: EnvelopeAad,
): Record<string, unknown> {
  const aad = aadFor(aadParts, envelope.key_version);
  const dataKey = open(masterKey, envelope.encrypted_data_key, aad);
  const plaintext = open(dataKey, envelope.ciphertext, aad);
  return JSON.parse(plaintext.toString()) as Record<string, unknown>;
}

/** Connection health derived from stored metadata (no token exposure). */
export type ConnectionHealth = "connected" | "expiring_soon" | "expired" | "revoked";

export function connectionHealth(input: {
  revoked_at: string | null;
  expires_at: string | null;
  now_ms: number;
}): ConnectionHealth {
  if (input.revoked_at) return "revoked";
  if (!input.expires_at) return "connected";
  const expiry = Date.parse(input.expires_at);
  if (expiry <= input.now_ms) return "expired";
  if (expiry - input.now_ms < 24 * 3600 * 1000) return "expiring_soon";
  return "connected";
}
