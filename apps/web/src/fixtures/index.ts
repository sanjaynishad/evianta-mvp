import {
  caseStateSchema,
  type CaseState,
  type CaseStateInput,
  type RunEvent,
  type UsageCaseRow,
  type UseCase,
} from "@evianta/core";
import { dataAnalysisCaseState } from "./data-analysis";
import { msmePaymentCaseState } from "./msme-payment";
import { buildRunEvents, toFailedCaseState } from "./run-events";
import { taxNoticeCaseState } from "./tax-notice";

// Temporary scaffolding: hand-written data shaped by @evianta/core, used when no API URL is set.
// Replace with fixtures recorded from real runs once the live API is available.
export const rawSampleCaseStates: CaseStateInput[] = [
  dataAnalysisCaseState,
  taxNoticeCaseState,
  msmePaymentCaseState,
];

function withRecordedRun(state: CaseState): { state: CaseState; events: RunEvent[] } {
  const runId = state.run.lastRunId ?? `${state.case.id}-run-1`;
  const events = buildRunEvents(state, { runId });
  return {
    state: {
      ...state,
      run: {
        active: false,
        lastEventSeq: events.length,
        lastRunId: runId,
        lastEventType: events.at(-1)?.type,
      },
    },
    events,
  };
}

const recordedSamples = rawSampleCaseStates.map((raw) =>
  withRecordedRun(caseStateSchema.parse(raw)),
);

export const sampleCaseStates: CaseState[] = recordedSamples.map((sample) => sample.state);

export const sampleRunEvents: Record<string, RunEvent[]> = Object.fromEntries(
  recordedSamples.map((sample) => [sample.state.case.id, sample.events]),
);

export function getSampleStateForUseCase(useCase: UseCase): CaseState {
  const sample = sampleCaseStates.find((state) => state.case.useCase === useCase);
  if (!sample) {
    throw new Error(`No sample fixture for ${useCase}`);
  }

  return sample;
}

export const fixtureFailure = {
  useCase: "msme-payment" as UseCase,
  taskId: "c-task-legal",
  error:
    "The legal research step could not reach the search service. Completed work is kept; retry to continue.",
};

const failedRunId = "c-run-failed";
export const failedCaseId = "fixture-failed-run";
const msmeSample = getSampleStateForUseCase(fixtureFailure.useCase);
const msmeVisitorCase: CaseState = {
  ...msmeSample,
  case: {
    ...msmeSample.case,
    id: failedCaseId,
    isSample: false,
    sourceCaseId: msmeSample.case.id,
  },
  tasks: msmeSample.tasks.map((task) => ({ ...task, caseId: failedCaseId })),
  deliverables: msmeSample.deliverables.map((deliverable) => ({
    ...deliverable,
    caseId: failedCaseId,
  })),
  documents: msmeSample.documents.map((document) => ({ ...document, caseId: failedCaseId })),
};

export const failedRunEvents: RunEvent[] = buildRunEvents(msmeVisitorCase, {
  runId: failedRunId,
  failTaskId: fixtureFailure.taskId,
  failError: fixtureFailure.error,
});

export const failedCaseState: CaseState = toFailedCaseState(msmeVisitorCase, {
  runId: failedRunId,
  failTaskId: fixtureFailure.taskId,
  failError: fixtureFailure.error,
  lastEventSeq: failedRunEvents.length,
});

export function toUsageRow(state: CaseState): UsageCaseRow {
  const usage = state.case.usage;
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return {
    id: state.case.id,
    title: state.case.title,
    useCase: state.case.useCase,
    status: state.case.status,
    visitorId: state.case.visitorId,
    isSample: state.case.isSample,
    isCopy: Boolean(state.case.sourceCaseId),
    sourceCaseId: state.case.sourceCaseId,
    createdAt: state.case.createdAt,
    updatedAt: state.case.updatedAt,
    lastRunAt: usage?.lastRunAt,
    approved: Boolean(state.case.approval),
    documentCount: state.documents.length,
    runCount: usage?.runCount ?? 0,
    tokenUsage: { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens },
    costEstimate: usage?.costEstimate ?? 0,
  };
}
