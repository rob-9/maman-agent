import type { Sql, TransactionSql } from "postgres";
import type { OrganizationRole } from "@maman/contracts";

/**
 * TenantContext is REQUIRED at every repository boundary. Combined with
 * PostgreSQL row-level security (SET LOCAL app.organization_id), tenant
 * isolation is enforced twice: in application code and in the database.
 */
export type TenantContext = {
  organizationId: string;
  userId?: string;
  role?: OrganizationRole;
};

export class MissingTenantContextError extends Error {
  constructor() {
    super("TenantContext with a non-empty organizationId is required");
    this.name = "MissingTenantContextError";
  }
}

export class MissingUserContextError extends Error {
  constructor() {
    super("UserContext with a non-empty userId is required for user-owned tables");
    this.name = "MissingUserContextError";
  }
}

/** A tenant context that is known to carry a user. */
export type UserContext = TenantContext & { userId: string };

/**
 * Runs `fn` inside a transaction with the tenant RLS setting applied.
 * Every tenant-scoped read or write MUST go through this helper.
 *
 * The transaction drops to the restricted `maman_app` role (SET LOCAL ROLE)
 * so row-level security genuinely applies even when the connection user is a
 * superuser or the table owner. Both revert automatically at transaction end.
 */
export async function withTenant<T>(
  sql: Sql,
  ctx: TenantContext,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  if (!ctx.organizationId) throw new MissingTenantContextError();
  return (await sql.begin(async (tx) => {
    // Drizzle's postgres-js driver reads `client.options` (parsers/serializers),
    // which postgres.js does not expose on TransactionSql. Attach the parent
    // connection's options so repositories can wrap this transaction in drizzle.
    if (!(tx as unknown as { options?: unknown }).options) {
      Object.assign(tx, { options: (sql as unknown as { options: unknown }).options });
    }
    await tx`SELECT set_config('app.organization_id', ${ctx.organizationId}, true)`;
    await tx`SET LOCAL ROLE maman_app`;
    return fn(tx);
  })) as T;
}

/**
 * Runs `fn` with BOTH tenant and user RLS settings applied.
 *
 * A SEPARATE function from `withTenant`, deliberately, rather than a flag on
 * it. The tables added in 0008 hold one person's inbox and pipeline, and their
 * policies require `app.user_id`; an org-scoped transaction reads zero rows
 * from them. Making that a distinct call means the choice is visible at every
 * call site — "am I reading this org's data, or this person's?" — instead of
 * hiding in an optional field that is easy to omit and silent when forgotten.
 *
 * The isolation is enforced three times: here, in the RLS policy, and by the
 * `maman_app` role that cannot bypass it.
 */
export async function withUser<T>(
  sql: Sql,
  ctx: UserContext,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  if (!ctx.organizationId) throw new MissingTenantContextError();
  if (!ctx.userId) throw new MissingUserContextError();
  return (await sql.begin(async (tx) => {
    if (!(tx as unknown as { options?: unknown }).options) {
      Object.assign(tx, { options: (sql as unknown as { options: unknown }).options });
    }
    await tx`SELECT set_config('app.organization_id', ${ctx.organizationId}, true)`;
    await tx`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    await tx`SET LOCAL ROLE maman_app`;
    return fn(tx);
  })) as T;
}
