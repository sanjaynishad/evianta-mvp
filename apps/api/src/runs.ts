import {
  createRunEventEmitter,
  type Orchestrator,
  type RunEventBus,
  type RunMode,
  type Unsubscribe,
} from "@evianta/agents";
import { isTerminalRunEvent } from "@evianta/core";
import type { Store } from "@evianta/store";

import { ApiError } from "./errors.js";
import { DocumentsUnavailableError, type IngestionService } from "./ingestion.js";
import { messageOf, type ApiLogger } from "./logger.js";

export interface StartedRun {
  runId: string;
  mode: RunMode;
}

export interface RunLauncher {
  /** Starts a run in the background and returns its id at once; throws 409 when one is active. */
  start(caseId: string, mode: RunMode): StartedRun;
  isActive(caseId: string): boolean;
  /** Called after a background run for the case has fully finished, including its lock release. */
  onSettled(caseId: string, listener: () => void): Unsubscribe;
  idleAsync(): Promise<void>;
}

export interface RunLauncherOptions {
  store: Store;
  orchestrator: Orchestrator;
  events: RunEventBus;
  ingestion: IngestionService;
  logger: ApiLogger;
  newId: () => string;
}

export function createRunLauncher(options: RunLauncherOptions): RunLauncher {
  const { store, orchestrator, events, ingestion, logger, newId } = options;
  const running = new Map<string, Promise<void>>();
  const settledListeners = new Map<string, Set<() => void>>();

  function isActive(caseId: string): boolean {
    return running.has(caseId) || orchestrator.isRunning(caseId);
  }

  // A run that fails before the orchestrator starts it has no terminal event, so one is recorded
  // here; stream clients always see run-completed or run-failed for every accepted run.
  async function recordFailureAsync(caseId: string, runId: string, error: unknown) {
    try {
      await store.cases.updateCaseStatusAsync(caseId, "failed");
    } catch (statusError) {
      logger.error("Could not mark the failed run on its case.", {
        caseId,
        runId,
        error: messageOf(statusError),
      });
    }

    try {
      const recorded = await store.events.listEventsAsync(caseId);

      if (recorded.some((event) => event.runId === runId && isTerminalRunEvent(event))) {
        return;
      }

      await createRunEventEmitter(
        store,
        events,
        caseId,
      )({
        type: "run-failed",
        runId,
        error:
          error instanceof DocumentsUnavailableError
            ? error.message
            : "The run could not finish. Try again.",
        failedTaskIds: [],
      });
    } catch (recordError) {
      logger.error("Could not record the failed run.", {
        caseId,
        runId,
        error: messageOf(recordError),
      });
    }
  }

  function notifySettled(caseId: string): void {
    for (const listener of [...(settledListeners.get(caseId) ?? [])]) {
      try {
        listener();
      } catch (error) {
        logger.warn("A run settle listener failed.", { caseId, error: messageOf(error) });
      }
    }
  }

  return {
    start(caseId, mode) {
      if (isActive(caseId)) {
        throw new ApiError(409, "run-in-progress", "This case already has a run in progress.");
      }

      const runId = newId();
      const work = (async () => {
        try {
          await ingestion.ensureCaseExtractedAsync(caseId);

          const result =
            mode === "retry"
              ? await orchestrator.retryFailedAsync(caseId, { runId })
              : await orchestrator.runCaseAsync(caseId, { runId });

          logger.info("Run finished.", {
            caseId,
            runId,
            mode,
            status: result.status,
            costEstimate: result.costEstimate,
          });

          // A failed result can mean the terminal event itself could not be stored.
          if (result.status === "failed") {
            await recordFailureAsync(caseId, runId, new Error(result.error ?? "The run failed."));
          }
        } catch (error) {
          logger.warn("Run could not finish.", { caseId, runId, mode, error: messageOf(error) });
          await recordFailureAsync(caseId, runId, error);
        } finally {
          running.delete(caseId);
          notifySettled(caseId);
        }
      })();

      running.set(caseId, work);

      return { runId, mode };
    },
    isActive,
    onSettled(caseId, listener) {
      let listeners = settledListeners.get(caseId);

      if (!listeners) {
        listeners = new Set();
        settledListeners.set(caseId, listeners);
      }

      listeners.add(listener);

      return () => {
        const current = settledListeners.get(caseId);

        current?.delete(listener);

        if (current?.size === 0) {
          settledListeners.delete(caseId);
        }
      };
    },
    async idleAsync() {
      while (running.size > 0) {
        await Promise.allSettled([...running.values()]);
      }
    },
  };
}
