import { agentRoles } from "@evianta/agents";
import { port } from "@evianta/env";
import express from "express";

const app = express();

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "evianta-api" });
});

app.get("/agents", (_req, res) => {
  res.json({ roles: agentRoles });
});

app.listen(port, () => {
  console.log(`evianta-api listening on port ${port}`);
});
