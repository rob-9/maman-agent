import type { Sql } from "postgres";
import {
  envelopeDecrypt,
  envelopeEncrypt,
  packEnvelope,
  refreshTokens,
  unpackEnvelope,
  type TokenTransport,
} from "@maman/connector-auth";
import {
  getUserConnection,
  markUserConnectionSync,
  updateUserConnectionCredentials,
} from "@maman/db";
import { PermanentAdapterError } from "@maman/agent-runtime";
import type {
  ProviderCredentials,
  UserCredentialKey,
  UserCredentialProvider,
} from "@maman/connector-adapters";

/**
 * Vault-backed credentials for ONE PERSON's connections.
 *
 * The org-level provider in vault-credentials.ts reads `connector_accounts`
 * under `withTenant`. This one reads `user_connections` under `withUser`, and
 * decrypts with an AAD that names the user — so a ciphertext copied between
 * two reps' rows fails to open rather than opening as the wrong mailbox.
 *
 * Tokens are decrypted in-process, handed to the adapter as a Bearer header,
 * and never returned to a caller, written anywhere, or logged.
 */

export type UserVaultDeps = {
  sql: Sql;
  masterKey: Buffer;
  transport: TokenTransport;
  clientCredentials: (provider: string) => { client_id: string; client_secret?: string } | null;
};

type StoredToken = { access_token: string; refresh_token?: string; scope?: string };

export function createUserVaultCredentialProvider(deps: UserVaultDeps): UserCredentialProvider {
  const ctxOf = (k: UserCredentialKey) => ({
    organizationId: k.organization_id,
    userId: k.user_id,
  });
  const aadOf = (k: UserCredentialKey) => ({
    organization_id: k.organization_id,
    user_id: k.user_id,
    provider: k.provider,
  });

  async function loadStored(k: UserCredentialKey) {
    const conn = await getUserConnection(deps.sql, ctxOf(k), k.provider);
    if (!conn) return null;
    const token = envelopeDecrypt(
      unpackEnvelope(conn.encrypted_credentials),
      deps.masterKey,
      aadOf(k),
    ) as StoredToken;
    return { conn, token };
  }

  return {
    async load(k): Promise<ProviderCredentials | null> {
      const stored = await loadStored(k);
      if (!stored) return null;
      const { access_token, refresh_token, scope } = stored.token;
      return {
        access_token,
        ...(refresh_token !== undefined ? { refresh_token } : {}),
        ...(scope !== undefined ? { scope } : {}),
      };
    },

    async refresh(k): Promise<ProviderCredentials> {
      const stored = await loadStored(k);
      if (!stored)
        throw new PermanentAdapterError(`${k.provider}: no linked connection to refresh`);
      if (!stored.token.refresh_token) {
        await markUserConnectionSync(deps.sql, ctxOf(k), stored.conn.id, {
          ok: false,
          error: "no refresh token",
          expired: true,
        });
        throw new PermanentAdapterError(`${k.provider}: no refresh token; user must reconnect`);
      }
      const client = deps.clientCredentials(k.provider);
      if (!client)
        throw new PermanentAdapterError(`${k.provider}: no client credentials configured`);

      const result = await refreshTokens(
        {
          provider: k.provider,
          client_id: client.client_id,
          ...(client.client_secret ? { client_secret: client.client_secret } : {}),
          refresh_token: stored.token.refresh_token,
        },
        deps.transport,
      );
      if (!result.ok) {
        // A refused refresh means the grant is gone. Say so on the row, so the
        // UI can ask the person to reconnect instead of silently retrying.
        await markUserConnectionSync(deps.sql, ctxOf(k), stored.conn.id, {
          ok: false,
          error: `refresh failed: ${result.error}`,
          expired: true,
        });
        throw new PermanentAdapterError(`${k.provider}: refresh failed (${result.error})`);
      }

      const next: StoredToken = {
        access_token: result.tokens.access_token,
        // Providers may omit the refresh token on rotation; keep the old one.
        refresh_token: result.tokens.refresh_token ?? stored.token.refresh_token,
        ...(result.tokens.scope !== undefined ? { scope: result.tokens.scope } : {}),
      };
      await updateUserConnectionCredentials(
        deps.sql,
        ctxOf(k),
        stored.conn.id,
        packEnvelope(envelopeEncrypt(next, deps.masterKey, aadOf(k))),
      );
      const { access_token, refresh_token, scope } = next;
      return {
        access_token,
        ...(refresh_token !== undefined ? { refresh_token } : {}),
        ...(scope !== undefined ? { scope } : {}),
      };
    },
  };
}
