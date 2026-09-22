import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Client, Connection } from "@temporalio/client";
import { Worker, NativeConnection } from "@temporalio/worker";
import { loadServerEnv } from "@maman/config";
import {
  DemoSalesforceWorld,
  demoAdapterRegistry,
  type CapabilityAdapter,
} from "@maman/agent-runtime";
import {
  fetchTransport,
  gmailContentReader,
  MemoryIdempotencyStore,
  realAdapterRegistry,
  salesforceActivityWriter,
  salesforceOpportunityWriter,
} from "@maman/connector-adapters";
import { createModelProvider, DeterministicModelProvider } from "@maman/model-provider";
import { deterministicContextComposer, modelComposer } from "@maman/voice-engine";
import { createDbClient } from "@maman/db";
import { createConnectorTokenTransport } from "@maman/connector-auth";
import { createActivities, type PersistenceSink } from "./activities.js";
import {
  createSweepActivities,
  createUserVaultCredentialProvider,
  orgPolicyResolver,
  resolveDealSource,
} from "@maman/sync";
import { createVaultCredentialProvider } from "./vault-credentials.js";
import { DEFAULT_SWEEP_INTERVAL_MINUTES, ensureSweepSchedule } from "./schedule.js";

/**
 * Temporal worker process. Registers agentRunWorkflow and the activity
 * implementations. In demo mode the persistence sink logs sanitized events;
 * the API owns the authoritative DB writes it receives over its own routes.
 *
 * CONNECTOR_MODE selects the capability registry: `demo` uses the deterministic
 * in-process adapters; `real` uses live connectors (vault tokens) and falls
 * back per capability to the demo adapter when an org has no linked connector.
 *
 * The worker also owns the WORKSPACE SWEEP: on a schedule it syncs every
 * connected mailbox and re-runs detection, so the inbox is current without
 * anyone pressing "sync". The schedule is registered at startup (schedule.ts)
 * and the activities come from @maman/sync — the same job the API runs on
 * demand, so the two can never drift.
 */

const env = loadServerEnv(process.env);
const require = createRequire(import.meta.url);
const TASK_QUEUE = "maman-agent-runs";

const { sql } = createDbClient(env.DATABASE_URL);
const masterKey = createHash("sha256").update(env.CONNECTOR_ENCRYPTION_MASTER_KEY).digest();

/** OAuth client for an ORG-installed connector, from configuration. */
function orgClientCredentials(
  provider: string,
): { client_id: string; client_secret?: string } | null {
  if (provider === "salesforce" && env.SALESFORCE_CLIENT_ID) {
    return {
      client_id: env.SALESFORCE_CLIENT_ID,
      ...(env.SALESFORCE_CLIENT_SECRET ? { client_secret: env.SALESFORCE_CLIENT_SECRET } : {}),
    };
  }
  if (provider === "google_sheets" && env.GOOGLE_CLIENT_ID) {
    return {
      client_id: env.GOOGLE_CLIENT_ID,
      ...(env.GOOGLE_CLIENT_SECRET ? { client_secret: env.GOOGLE_CLIENT_SECRET } : {}),
    };
  }
  return null;
}

/** Builds the capability registry for the worker per CONNECTOR_MODE. */
function buildRegistry(): Map<string, CapabilityAdapter> {
  const demo = demoAdapterRegistry(new DemoSalesforceWorld());
  if (env.CONNECTOR_MODE !== "real") return demo;

  const credentials = createVaultCredentialProvider({
    sql,
    masterKey,
    transport: createConnectorTokenTransport(),
    clientCredentials: orgClientCredentials,
  });
  return realAdapterRegistry({
    credentials,
    demoFallback: demo,
    idempotency: new MemoryIdempotencyStore(),
    // A read served from fixtures is not an error, but it IS a fact about what
    // the run's numbers describe. Logged structurally so it is attributable to
    // a capability and an org rather than disappearing into the result.
    onDemoFallback: ({ capability_id, provider, organization_id }) => {
      console.warn(
        JSON.stringify({
          evt: "demo_fallback_read",
          capability_id,
          provider,
          organization_id,
          detail: `no ${provider} connector linked — this read returned demo data, not the org's records`,
        }),
      );
    },
  });
}

const sink: PersistenceSink = {
  runStatus: (runId, status) => {
    console.warn(JSON.stringify({ evt: "run_status", run_id: runId, status }));
  },
  stepResult: (runId, summary) => {
    console.warn(
      JSON.stringify({
        evt: "step_result",
        run_id: runId,
        step: summary.step_id,
        status: summary.status,
      }),
    );
  },
  approvalRequested: (input) => {
    console.warn(
      JSON.stringify({ evt: "approval_requested", run_id: input.runId, step: input.stepId }),
    );
  },
  receipt: (receipt) => {
    console.warn(JSON.stringify({ evt: "receipt", receipt }));
  },
};

/** The organization's connectors, from the org vault. */
const orgCredentials = createVaultCredentialProvider({
  sql,
  masterKey,
  transport: createConnectorTokenTransport(),
  clientCredentials: orgClientCredentials,
});

/** The sweep's activities: the on-demand sync job, run per person from the schedule. */
function buildSweepActivities() {
  const credentials = createUserVaultCredentialProvider({
    sql,
    masterKey,
    transport: createConnectorTokenTransport(),
    clientCredentials: (provider) =>
      provider === "gmail" && env.GOOGLE_CLIENT_ID
        ? {
            client_id: env.GOOGLE_CLIENT_ID,
            ...(env.GOOGLE_CLIENT_SECRET ? { client_secret: env.GOOGLE_CLIENT_SECRET } : {}),
          }
        : null,
  });
  return createSweepActivities({
    sql,
    credentials,
    transport: fetchTransport,
    now: () => new Date(),
    contentKey: masterKey,
    // The agent pass, only when switched on (AGENT_MODE=assist).
    ...(env.AGENT_MODE === "assist"
      ? {
          agent: {
            provider: createModelProvider(env),
            content: gmailContentReader({ credentials, transport: fetchTransport }),
          },
          // Drafts written before being asked, from the same job a click uses.
          predraft: {
            composer: modelComposer({
              provider: createModelProvider(env),
              fallback: deterministicContextComposer(new DeterministicModelProvider()),
            }),
            max: env.PREDRAFT_PER_SWEEP ?? 3,
          },
        }
      : {}),
    // Writes to the organization's CRM for what each person sent: proposed
    // always, applied without asking only under their own promotion.
    actions: {
      writer: salesforceActivityWriter({ credentials: orgCredentials, transport: fetchTransport }),
      opportunities: salesforceOpportunityWriter({
        credentials: orgCredentials,
        transport: fetchTransport,
      }),
      orgPolicy: orgPolicyResolver(sql),
    },
    // The event stream, unless switched off.
    ...(env.EVENT_STREAM === "off" ? {} : { events: {} }),
    // The organization's CRM (org vault), asked about each person's contacts.
    deals: resolveDealSource({
      sql,
      credentials: createVaultCredentialProvider({
        sql,
        masterKey,
        transport: createConnectorTokenTransport(),
        clientCredentials: orgClientCredentials,
      }),
      transport: fetchTransport,
    }),
  });
}

async function run(): Promise<void> {
  const connection = await NativeConnection.connect({ address: env.TEMPORAL_ADDRESS });
  const worker = await Worker.create({
    connection,
    namespace: env.TEMPORAL_NAMESPACE,
    taskQueue: TASK_QUEUE,
    // One entry module carries every workflow this worker runs.
    workflowsPath: require.resolve("@maman/sync/workflows"),
    activities: {
      ...createActivities({
        registry: buildRegistry(),
        sink,
        now: () => new Date(),
      }),
      ...buildSweepActivities(),
    },
  });

  const client = new Client({
    connection: await Connection.connect({ address: env.TEMPORAL_ADDRESS }),
    namespace: env.TEMPORAL_NAMESPACE,
  });
  const everyMinutes = env.WORKSPACE_SWEEP_INTERVAL_MINUTES ?? DEFAULT_SWEEP_INTERVAL_MINUTES;
  const schedule = await ensureSweepSchedule(client, { taskQueue: TASK_QUEUE, everyMinutes });
  console.warn(
    JSON.stringify({ evt: "sweep_schedule", outcome: schedule, every_minutes: everyMinutes }),
  );

  console.warn(JSON.stringify({ evt: "worker_ready", queue: TASK_QUEUE }));
  await worker.run();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
