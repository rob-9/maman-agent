import { Client, Connection } from "@temporalio/client";
import { loadServerEnv } from "@maman/config";
import { createDbClient } from "@maman/db";
import { createDemoWorld, defaultDemoWorldStateFile, fileStore } from "@maman/connector-adapters";
import { buildServer } from "./server.js";
import { TemporalRunOrchestrator } from "./orchestrator.js";

const env = loadServerEnv(process.env);
const db = createDbClient(env.DATABASE_URL);

// Lazy Temporal connection: the API boots without Temporal reachable; the
// connection is established on the first run/approval call. Run routes return
// 503 until a client is available.
const temporalClient = new Client({
  connection: Connection.lazy({ address: env.TEMPORAL_ADDRESS }),
  namespace: env.TEMPORAL_NAMESPACE,
});
// With no credentials on this machine (CONNECTOR_MODE=demo), the connectors
// are a scripted Gmail, Calendar and Salesforce in memory. Every path the
// product runs is the real one; only the wire is scripted.
const demo =
  env.CONNECTOR_MODE === "demo"
    ? createDemoWorld({
        store: fileStore(env.DEMO_WORLD_STATE_FILE ?? defaultDemoWorldStateFile()),
      })
    : null;
const app = buildServer({
  env,
  sql: db.sql,
  orchestrator: new TemporalRunOrchestrator(temporalClient.workflow),
  ...(demo
    ? {
        connectorTransport: demo.token,
        gmailTransport: demo.transport,
        crmTransport: demo.transport,
      }
    : {}),
});

const url = new URL(env.API_BASE_URL);
const port = Number(url.port || 4000);

try {
  await app.listen({ port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
