import { agentRoles } from "@evianta/agents";
import express from "express";

const app = express();
const port = Number(process.env.PORT ?? 8080);

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "evianta-api" });
});

app.get("/agents", (_req, res) => {
  res.json({ roles: agentRoles });
});

app.listen(port, () => {
  console.log(`evianta-api listening on port ${port}`);
});
