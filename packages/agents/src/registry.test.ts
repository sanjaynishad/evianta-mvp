import { agentProfileSchema, agentRoleSchema } from "@evianta/core";
import { createInMemoryStore } from "@evianta/store";
import { describe, expect, it } from "vitest";

import { createSpecialistAgent } from "./agents/specialist.js";
import {
  createAgentRegistry,
  createDefaultTaskHandlers,
  seedAgentDirectoryAsync,
} from "./registry.js";

describe("agent registry", () => {
  it("has an agent and a valid profile for every role", () => {
    const registry = createAgentRegistry();
    const roles = registry.list().map((agent) => agent.role);

    expect(new Set(roles)).toEqual(new Set(agentRoleSchema.options));

    for (const agent of registry.list()) {
      expect(agentProfileSchema.parse(agent.profile)).toEqual(agent.profile);
      expect(agent.profile.role).toBe(agent.role);
      expect(agent.profile.modelTier).toBe(agent.modelTier);
    }
  });

  it("uses the planned model tiers and grounding", () => {
    const registry = createAgentRegistry();

    expect(registry.require("coordinator").modelTier).toBe("mid");
    expect(registry.require("independent-review").modelTier).toBe("high");
    expect(registry.require("case-analysis").modelTier).toBe("cheap");
    expect(registry.require("tax-research").grounding).toBe(true);
    expect(registry.require("legal-research").grounding).toBe(true);
    expect(registry.require("reconciliation").grounding).toBe(false);
  });

  it("lets a later agent replace a role", () => {
    const registry = createAgentRegistry();
    const custom = createSpecialistAgent("reconciliation", { modelTier: "cheap" });

    registry.register(custom);

    expect(registry.require("reconciliation")).toBe(custom);
    expect(registry.require("reconciliation").profile.modelTier).toBe("cheap");
  });

  it("registers a default handler for every planned role", () => {
    const handlers = createDefaultTaskHandlers();

    expect(new Set(handlers.roles())).toEqual(
      new Set(agentRoleSchema.options.filter((role) => role !== "coordinator")),
    );
  });
});

describe("seedAgentDirectoryAsync", () => {
  it("upserts every profile and is idempotent", async () => {
    const store = createInMemoryStore();

    const first = await seedAgentDirectoryAsync(store);
    const afterFirst = await store.agents.listProfilesAsync();
    const second = await seedAgentDirectoryAsync(store);
    const afterSecond = await store.agents.listProfilesAsync();

    expect(first).toHaveLength(agentRoleSchema.options.length);
    expect(second).toEqual(first);
    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.map((profile) => profile.role)).toEqual(agentRoleSchema.options);
    expect(await store.agents.getProfileAsync("tax-research")).toMatchObject({
      displayName: "Tax Researcher",
      tools: ["google-search-grounding"],
      enabled: true,
    });
  });
});
