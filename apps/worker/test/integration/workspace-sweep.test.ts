import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ScheduleOverlapPolicy } from "@temporalio/client";
import { createRequire } from "node:module";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { uuidv7 } from "@maman/contracts";
import {
  addMembership,
  createDbClient,
  globalCreateOrganization,
  globalCreateUser,
  listPendingObligations,
  loadMigrations,
  migrateUp,
  withUser,
  type DbClient,
} from "@maman/db";
import { envelopeEncrypt, packEnvelope } from "@maman/connector-auth";
import type { HttpRequest, HttpResponse } from "@maman/connector-adapters";
import { createSweepActivities, createUserVaultCredentialProvider } from "@maman/sync";
import { workspaceSweepWorkflow, type WorkspaceSweepResult } from "@maman/sync/workflow";
import {
  ensureSweepSchedule,
  SWEEP_SCHEDULE_ID,
  sweepScheduleOptions,
} from "../../src/schedule.js";

/**
 * THE SWEEP, DURABLY, END TO END: a Temporal workflow drives the real sync
 * job against a real database with a scripted Gmail. One mailbox succeeds,
 * one errors, one colleague has nothing connected — and the sweep completes
 * with the right accounting, the failure recorded where the person can see it.
 */

const require = createRequire(import.meta.url);
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "db",
  "migrations",
);

let env: TestWorkflowEnvironment;
let container: StartedPostgreSqlContainer;
let client: DbClient;
const master = randomBytes(32);
const NOW = new Date("2026-09-21T12:00:00.000Z");
const ago = (days: number) => String(NOW.getTime() - days * 86_400_000);
const orgId = uuidv7();
const alice = uuidv7();
const bob = uuidv7();
const carol = uuidv7();
const TASK_QUEUE = "sweep-test";

const thread = (id: string, from: string, to: string, whenMs: string, subject: string) => ({
  id,
  messages: [
    {
      id: `${id}-m`,
      internalDate: whenMs,
      payload: {
        headers: [
          { name: "From", value: from },
          { name: "To", value: to },
          { name: "Subject", value: subject },
        ],
      },
    },
  ],
});
const ALICE_BOX: Record<string, unknown> = {
  owed: thread("owed", "Sarah <sarah@acme.com>", "alice@co.example", ago(4), "Pricing"),
  quiet: thread("quiet", "alice@co.example", "bob@client.com", ago(9), "Proposal"),
};

/** Whose token: Alice's says "alice", Carol's says "carol"; Carol's Gmail is down. */
const transport = async (req: HttpRequest): Promise<HttpResponse> => {
  const bearer = (req.headers?.["authorization"] ?? "").toString();
  if (bearer === "Bearer carol") return { status: 500, headers: {}, body: { error: "down" } };
  const url = new URL(req.url);
  if (url.pathname.endsWith("/profile")) {
    return { status: 200, headers: {}, body: { emailAddress: "alice@co.example" } };
  }
  if (url.pathname.endsWith("/threads")) {
    return {
      status: 200,
      headers: {},
      body: { threads: Object.keys(ALICE_BOX).map((id) => ({ id })) },
    };
  }
  const id = decodeURIComponent(url.pathname.split("/").pop()!);
  return { status: 200, headers: {}, body: ALICE_BOX[id] };
};

async function seedUser(id: string, email: string) {
  await globalCreateUser(client.sql, {
    id,
    workos_user_id: `wu_${id}`,
    email,
    display_name: email,
  });
  await addMembership(client.sql, { organizationId: orgId }, { user_id: id, role: "member" });
}
async function linkGmail(userId: string, token: string) {
  const packed = packEnvelope(
    envelopeEncrypt({ access_token: token, refresh_token: "ref" }, master, {
      organization_id: orgId,
      user_id: userId,
      provider: "gmail",
    }),
  );
  await withUser(client.sql, { organizationId: orgId, userId }, async (tx) => {
    await tx`
      INSERT INTO user_connections
        (id, organization_id, owner_user_id, provider, external_account_label,
         encrypted_credentials, scopes, status)
      VALUES (${uuidv7()}, ${orgId}, ${userId}, 'gmail', ${token}, ${packed},
              ARRAY['gmail.metadata'], 'active')
    `;
  });
}

beforeAll(async () => {
  [env, container] = await Promise.all([
    TestWorkflowEnvironment.createTimeSkipping(),
    new PostgreSqlContainer("postgres:17-alpine").start(),
  ]);
  client = createDbClient(container.getConnectionUri(), { max: 4 });
  await migrateUp(client.sql, loadMigrations(migrationsDir));
  await globalCreateOrganization(client.sql, {
    id: orgId,
    workos_organization_id: `wk_${orgId}`,
    name: "Co",
    status: "active",
    default_timezone: "UTC",
  });
  await seedUser(alice, "alice@co.example");
  await seedUser(bob, "bob@co.example");
  await seedUser(carol, "carol@co.example");
  await linkGmail(alice, "alice");
  await linkGmail(carol, "carol");
}, 240_000);

afterAll(async () => {
  await env?.teardown();
  await client?.close();
  await container?.stop();
});

async function createWorker() {
  return Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: require.resolve("@maman/sync/workflows"),
    activities: createSweepActivities({
      sql: client.sql,
      credentials: createUserVaultCredentialProvider({
        sql: client.sql,
        masterKey: master,
        transport: async () => ({ status: 500, body: {} }),
        clientCredentials: () => ({ client_id: "x" }),
      }),
      transport,
      now: () => NOW,
    }),
  });
}

describe("workspaceSweepWorkflow", () => {
  it("sweeps every connected mailbox, counts the one that failed, and moves on", async () => {
    const worker = await createWorker();
    const result = await worker.runUntil(
      env.client.workflow.execute(workspaceSweepWorkflow, {
        taskQueue: TASK_QUEUE,
        workflowId: `sweep-${uuidv7()}`,
      }),
    );
    expect(result satisfies WorkspaceSweepResult).toEqual({
      targets: 2,
      synced: 1,
      failed: 1,
      obligations_written: 2,
    });

    // Alice's inbox is current — nobody pressed sync.
    const list = await listPendingObligations(client.sql, { organizationId: orgId, userId: alice });
    expect(list.map((o) => [o.subject, o.kind])).toEqual([
      ["Pricing", "awaiting_you"],
      ["Proposal", "awaiting_them"],
    ]);
    // Bob, unconnected, was never a target and sees nothing.
    expect(
      await listPendingObligations(client.sql, { organizationId: orgId, userId: bob }),
    ).toEqual([]);
    // Carol's failure is on HER connection, where the UI can ask her to reconnect.
    const carolConn = await withUser(
      client.sql,
      { organizationId: orgId, userId: carol },
      (tx) => tx`SELECT status, last_error FROM user_connections`,
    );
    expect(carolConn[0]!["status"]).toBe("error");
    expect(String(carolConn[0]!["last_error"])).toMatch(/500/);
  });

  it("a second sweep is idempotent and no longer targets the broken mailbox", async () => {
    const worker = await createWorker();
    const result = await worker.runUntil(
      env.client.workflow.execute(workspaceSweepWorkflow, {
        taskQueue: TASK_QUEUE,
        workflowId: `sweep-${uuidv7()}`,
      }),
    );
    expect(result).toEqual({ targets: 1, synced: 1, failed: 0, obligations_written: 2 });
    const list = await listPendingObligations(client.sql, { organizationId: orgId, userId: alice });
    expect(list).toHaveLength(2);
  });
});

describe("the schedule", () => {
  it("describes an interval schedule that skips overlapping runs and does not catch up", () => {
    const opts = sweepScheduleOptions({ taskQueue: "q", everyMinutes: 15 });
    expect(opts.scheduleId).toBe(SWEEP_SCHEDULE_ID);
    expect(opts.spec).toEqual({ intervals: [{ every: "15m" }] });
    expect(opts.action).toMatchObject({ type: "startWorkflow", taskQueue: "q" });
    expect(opts.policies).toMatchObject({
      overlap: ScheduleOverlapPolicy.SKIP,
      catchupWindow: "1 minute",
    });
    expect(() => sweepScheduleOptions({ taskQueue: "q", everyMinutes: 0 })).toThrow(/>= 1/);
    expect(() => sweepScheduleOptions({ taskQueue: "q", everyMinutes: 2.5 })).toThrow(
      /whole number/,
    );
  });

  it("is created once and brought up to date on later starts", async () => {
    // Schedules need a real server; the time-skipping test server has none.
    let local: TestWorkflowEnvironment;
    try {
      local = await TestWorkflowEnvironment.createLocal();
    } catch (e) {
      throw new Error(`Temporal dev server unavailable for the schedule test: ${String(e)}`);
    }
    try {
      expect(await ensureSweepSchedule(local.client, { taskQueue: "q", everyMinutes: 15 })).toBe(
        "created",
      );
      expect(await ensureSweepSchedule(local.client, { taskQueue: "q", everyMinutes: 30 })).toBe(
        "updated",
      );
      const described = await local.client.schedule.getHandle(SWEEP_SCHEDULE_ID).describe();
      expect(described.spec.intervals?.[0]?.every).toBe(30 * 60 * 1000);
      expect(described.policies.overlap).toBe(ScheduleOverlapPolicy.SKIP);
      expect(described.action).toMatchObject({
        type: "startWorkflow",
        workflowType: "workspaceSweepWorkflow",
        taskQueue: "q",
      });
    } finally {
      await local.teardown();
    }
  }, 180_000);
});
