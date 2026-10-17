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
import {
  createDataAnalystAgent,
  createDataAnalystTaskHandler,
} from "./usecases/data-analysis/index.js";
import { createTaxNoticeAgents, registerTaxNoticeHandlers } from "./usecases/tax-notice/index.js";
import type { DeterministicCheckOptions } from "./verification.js";
import {
  createMsmePaymentAgents,
  createMsmePaymentTaskHandlers,
} from "./usecases/msme-payment/index.js";

export interface AgentRegistry extends AgentLookup {
  list(): AnyAgent[];
  profiles(): AgentProfile[];
  /** Adds or replaces the agent for its role. */
  register(agent: AnyAgent): AgentRegistry;
}

export function createDefaultAgents(): AnyAgent[] {
  return [
    createCoordinatorAgent(),
    ...SPECIALIST_ROLES.map((role) =>
      role === "business-data-analyst" ? createDataAnalystAgent() : createSpecialistAgent(role),
    ),
    ...createTaxNoticeAgents(),
    createReviewerAgent(),
    ...createMsmePaymentAgents(),
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

/**
 * Generic specialist handlers for every specialist role, use-case handlers where they exist (the
 * data analyst), and the deterministic-first reviewer.
 */
export function createDefaultTaskHandlers(
  reviewOptions: DeterministicCheckOptions = {},
): TaskHandlerRegistry {
  const generic = createTaskHandlerRegistry([
    ...SPECIALIST_ROLES.map((role) => createSpecialistTaskHandler(role)),
    createDataAnalystTaskHandler(),
    createReviewTaskHandler(reviewOptions),
    ...createMsmePaymentTaskHandlers({ review: reviewOptions }),
  ]);

  return registerTaxNoticeHandlers(generic, { review: reviewOptions });
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
