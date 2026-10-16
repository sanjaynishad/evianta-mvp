import type { AgentProfile, AgentRole } from "@evianta/core";
import type { Store } from "@evianta/store";

import type { AnyAgent } from "./agent.js";
import { createCoordinatorAgent } from "./agents/coordinator.js";
import { createReviewerAgent, createReviewTaskHandler } from "./agents/reviewer.js";
import { createSpecialistAgent, SPECIALIST_ROLES } from "./agents/specialist.js";
import {
  createSpecialistTaskHandler,
  createTaskHandlerRegistry,
  type AgentLookup,
  type TaskHandlerRegistry,
} from "./handlers.js";
import type { DeterministicCheckOptions } from "./verification.js";

export interface AgentRegistry extends AgentLookup {
  list(): AnyAgent[];
  profiles(): AgentProfile[];
  /** Adds or replaces the agent for its role. */
  register(agent: AnyAgent): AgentRegistry;
}

export function createDefaultAgents(): AnyAgent[] {
  return [
    createCoordinatorAgent(),
    ...SPECIALIST_ROLES.map((role) => createSpecialistAgent(role)),
    createReviewerAgent(),
  ];
}

export function createAgentRegistry(
  agents: readonly AnyAgent[] = createDefaultAgents(),
): AgentRegistry {
  const byRole = new Map<AgentRole, AnyAgent>();
  const registry: AgentRegistry = {
    get(role) {
      return byRole.get(role);
    },
    require(role) {
      const agent = byRole.get(role);

      if (!agent) {
        throw new Error(`No agent is registered for role "${role}".`);
      }

      return agent;
    },
    list() {
      return [...byRole.values()];
    },
    profiles() {
      return [...byRole.values()].map((agent) => ({ ...agent.profile }));
    },
    register(agent) {
      byRole.set(agent.role, agent);

      return registry;
    },
  };

  for (const agent of agents) {
    registry.register(agent);
  }

  return registry;
}

/** Generic specialist handlers for every specialist role plus the deterministic-first reviewer. */
export function createDefaultTaskHandlers(
  reviewOptions: DeterministicCheckOptions = {},
): TaskHandlerRegistry {
  return createTaskHandlerRegistry([
    ...SPECIALIST_ROLES.map((role) => createSpecialistTaskHandler(role)),
    createReviewTaskHandler(reviewOptions),
  ]);
}

/** Upserts every agent profile into the persistent directory. Safe to run repeatedly. */
export async function seedAgentDirectoryAsync(
  store: Pick<Store, "agents">,
  registry: AgentRegistry = createAgentRegistry(),
): Promise<AgentProfile[]> {
  const seeded: AgentProfile[] = [];

  for (const profile of registry.profiles()) {
    seeded.push(await store.agents.upsertProfileAsync(profile));
  }

  return seeded;
}
