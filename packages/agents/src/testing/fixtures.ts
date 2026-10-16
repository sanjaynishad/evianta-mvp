import { createMockAi, type MockAiClient, type MockScript, type MockStep } from "@evianta/ai";
import type {
  AgentRole,
  Case,
  DocumentMetadata,
  ExtractedDocumentInput,
  Task,
  UseCase,
} from "@evianta/core";
import { createInMemoryStore, type Store } from "@evianta/store";

import type { AgentFindingInput, SpecialistOutputInput } from "../findings.js";
import {
  createOrchestrator,
  type Orchestrator,
  type OrchestratorOptions,
} from "../orchestrator.js";

export interface Harness {
  store: Store;
  ai: MockAiClient;
  orchestrator: Orchestrator;
}

export function createHarness(
  script: MockScript = {},
  options: Partial<Omit<OrchestratorOptions, "store" | "ai">> = {},
): Harness {
  const store = createInMemoryStore();
  const ai = createMockAi(script);
  let counter = 0;
  const orchestrator = createOrchestrator({
    store,
    ai,
    newId: () => `id-${String(++counter).padStart(4, "0")}`,
    ...options,
  });

  return { store, ai, orchestrator };
}

export async function createCaseAsync(
  store: Store,
  useCase: UseCase = "tax-notice",
  id = "case-1",
): Promise<Case> {
  return store.cases.createCaseAsync({
    id,
    title: "Notice under section 143(1)",
    description: "Respond to an intimation demanding additional tax.",
    useCase,
    visitorId: "visitor-1",
  });
}

export async function addDocumentAsync(
  store: Store,
  caseId: string,
  document: {
    id: string;
    name: string;
    pages?: string[];
    extraction?: Partial<ExtractedDocumentInput>;
  },
): Promise<DocumentMetadata> {
  const metadata = await store.documents.addDocumentMetadataAsync({
    id: document.id,
    caseId,
    name: document.name,
    mimeType: "application/pdf",
    size: 1024,
    gcsPath: `cases/${caseId}/${document.id}`,
    uploadedAt: new Date().toISOString(),
  });

  await store.documents.saveExtractionAsync(caseId, {
    documentId: document.id,
    kind: "text",
    method: "pdf-text",
    confidence: 0.95,
    pages: (document.pages ?? []).map((text, index) => ({
      index: index + 1,
      text,
      method: "pdf-text",
      confidence: 0.95,
    })),
    ...document.extraction,
  });

  return metadata;
}

export interface TaskSeed {
  id: string;
  role: AgentRole;
  dependsOn?: string[];
  title?: string;
}

export async function seedTasksAsync(
  store: Store,
  caseId: string,
  seeds: readonly TaskSeed[],
): Promise<Task[]> {
  const tasks: Task[] = [];

  for (const seed of seeds) {
    tasks.push(
      await store.tasks.createTaskAsync({
        id: seed.id,
        caseId,
        title: seed.title ?? `Task ${seed.id}`,
        assignedRole: seed.role,
        dependsOn: seed.dependsOn ?? [],
      }),
    );
  }

  return tasks;
}

export function finding(
  summary: string,
  overrides: Partial<AgentFindingInput> = {},
): AgentFindingInput {
  return {
    summary,
    severity: "low",
    confidence: "high",
    evidence: [],
    ...overrides,
  };
}

export function specialistStep(
  output: Partial<SpecialistOutputInput> = {},
  usage = { input: 1000, output: 200 },
): MockStep {
  return {
    output: {
      findings: [finding("Routine observation")],
      openQuestions: [],
      ...output,
    },
    usage,
  };
}

export function sortedBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((left, right) => key(left).localeCompare(key(right)));
}
