import { agentRoleSchema } from "@evianta/core";
import { Router } from "express";
import { z } from "zod";

import type { ApiContext } from "../context.js";
import { notFoundError } from "../errors.js";
import { asyncRoute } from "../http.js";

const listQuerySchema = z.object({
  enabled: z.enum(["true", "false"]).optional(),
});

export function createAgentRoutes(ctx: ApiContext): Router {
  const router = Router();

  router.get(
    "/agents",
    asyncRoute(async (req, res) => {
      const query = listQuerySchema.parse(req.query);
      const agents = await ctx.store.agents.listProfilesAsync({
        enabledOnly: query.enabled === "true",
      });

      res.json({ roles: agents.map((agent) => agent.role), agents });
    }),
  );

  router.get(
    "/agents/:role",
    asyncRoute(async (req, res) => {
      const role = agentRoleSchema.safeParse(req.params.role);
      const profile = role.success ? await ctx.store.agents.getProfileAsync(role.data) : undefined;

      if (!profile) {
        throw notFoundError("agent");
      }

      res.json(profile);
    }),
  );

  return router;
}
