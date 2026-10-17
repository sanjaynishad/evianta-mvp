import { createOrchestrator, seedAgentDirectoryAsync } from "@evianta/agents";
import { getAi } from "@evianta/ai";
import { gcsBucket, port, usageViewPath, webOrigins } from "@evianta/env";
import { createFirestoreStore, createGcsDocumentStore, getFirestoreClient } from "@evianta/store";

import { createApp } from "./app.js";
import { jsonLogger, messageOf } from "./logger.js";

const store = createFirestoreStore(getFirestoreClient());
const documentStore = createGcsDocumentStore(gcsBucket);
const ai = getAi();
const orchestrator = createOrchestrator({ store, ai, logger: jsonLogger });

try {
  const profiles = await seedAgentDirectoryAsync(store, orchestrator.agents);

  jsonLogger.info("Seeded the agent directory.", { profiles: profiles.length });
} catch (error) {
  jsonLogger.error("Could not seed the agent directory.", { error: messageOf(error) });
}

const app = createApp({
  store,
  documentStore,
  ai,
  orchestrator,
  config: { webOrigins, usageViewPath },
  logger: jsonLogger,
});
const server = app.listen(port, () => {
  jsonLogger.info(`evianta-api listening on port ${port}`);
});

process.once("SIGTERM", () => {
  jsonLogger.info("Shutting down.");
  server.close();
  server.closeAllConnections();
});
