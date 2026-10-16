"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiErrorCodes,
  type CaseDocument,
  type CaseState,
  type DocumentStatus,
  type RunEvent,
} from "@evianta/core";
import { toast } from "@/components/ui/sonner";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useResource } from "@/hooks/use-resource";
import { describeError, hasApiErrorCode, isSampleReadOnlyError } from "@/lib/api/errors";
import { paceRunStreamHandlers } from "@/lib/api/run-stream";
import {
  retryWhileUploadingAsync,
  type UploadConflictRetryOptions,
} from "@/lib/api/upload-conflict";
import { useDataSource } from "@/lib/data/data-source-context";
import type { StreamConnectionState } from "@/lib/data/types";
import {
  applyRunEvent,
  createReplayProgress,
  createRunProgress,
  type RunProgress,
} from "@/lib/run-progress";
import { partitionUploadFiles, unsupportedUploadMessage } from "@/lib/use-cases";

export interface LocalUpload {
  id: string;
  name: string;
  size: number;
  status: "uploading" | "failed";
  error?: string;
}

interface StreamRequest {
  id: number;
  runId?: string;
  replay: boolean;
  lastEventId?: number;
}

interface LiveProgress {
  progress: RunProgress;
  replay: boolean;
  // Set once the case state has been refreshed after the terminal event, so it takes over again.
  settled?: boolean;
}

export type WorkspaceAction = "run" | "retry";

export const runActiveUploadMessage = "Wait for the run to finish before adding documents.";

export const casePlannedUploadMessage =
  "Documents cannot be added once the case has been planned, because later runs reuse the completed steps. Start a new case to use different documents.";

const replayPaceMs = 450;
const processingPollMs = 3000;
const settleAttempts = 10;
const settleDelayMs = 300;
const processingStatuses = new Set<DocumentStatus>(["pending", "processing"]);

let requestCounter = 0;

function nextRequestId(): number {
  requestCounter += 1;
  return requestCounter;
}

export interface CaseWorkspaceController {
  state: CaseState | undefined;
  error: unknown;
  loading: boolean;
  progress: RunProgress | undefined;
  replaying: boolean;
  streaming: boolean;
  connection: StreamConnectionState | undefined;
  busyAction: WorkspaceAction | undefined;
  uploads: LocalUpload[];
  // Run and retry wait while this is true, because a run reads the documents present at its start.
  uploading: boolean;
  // Set when the API would reject an upload, with a reason to show instead of the drop area.
  uploadLockedReason: string | undefined;
  reload: () => void;
  mutate: (update: (current: CaseState) => CaseState) => void;
  runAsync: () => Promise<void>;
  retryAsync: () => Promise<void>;
  replay: () => void;
  uploadAsync: (files: File[]) => Promise<void>;
  dismissUpload: (id: string) => void;
}

export function useCaseWorkspace(
  caseId: string,
  options: { onTryCase?: () => void; uploadRetry?: UploadConflictRetryOptions } = {},
): CaseWorkspaceController {
  const dataSource = useDataSource();
  const caseState = useResource(`case:${caseId}`, () => dataSource.getCaseStateAsync(caseId));
  const uploadsInFlight = useRef(new Set<Promise<unknown>>());
  const reconciling = useRef(false);
  const uploadRetry = options.uploadRetry;
  const [live, setLive] = useState<LiveProgress | null>(null);
  const [streamRequest, setStreamRequest] = useState<StreamRequest | null>(null);
  // Seq of the last terminal event seen; older case state still reports that run as active.
  const [terminalSeq, setTerminalSeq] = useState(0);
  const [connection, setConnection] = useState<StreamConnectionState>();
  const [busyAction, setBusyAction] = useState<WorkspaceAction>();
  const [uploads, setUploads] = useState<LocalUpload[]>([]);
  const state = caseState.data;
  const { reload, mutate } = caseState;

  const activeRun =
    state?.run.active && (terminalSeq === 0 || state.run.lastEventSeq > terminalSeq)
      ? state.run
      : undefined;
  const lastEventIsTerminal =
    activeRun?.lastEventType === "run-completed" || activeRun?.lastEventType === "run-failed";
  const autoRequest: StreamRequest | null = activeRun
    ? {
        id: -1,
        // Until the new run's first event is stored, the cursor still names the previous run.
        runId: lastEventIsTerminal ? undefined : activeRun.lastRunId,
        replay: false,
        lastEventId: activeRun.lastEventSeq,
      }
    : null;
  const activeRequest = streamRequest ?? autoRequest;

  const showReadOnlyToast = useCallback(
    (error: unknown) => {
      if (isSampleReadOnlyError(error)) {
        toast.info("Sample cases are read-only", {
          description: "Try this case to work on your own copy.",
          action: options.onTryCase
            ? { label: "Try this case", onClick: options.onTryCase }
            : undefined,
        });
        return true;
      }

      return false;
    },
    [options.onTryCase],
  );

  const handleEvent = useLatestCallback((event: RunEvent, replay: boolean) => {
    setLive((current) => {
      const base =
        current && !current.settled
          ? current.progress
          : state
            ? createRunProgress(state)
            : undefined;
      return base ? { progress: applyRunEvent(base, event), replay } : current;
    });
  });

  const handleTerminal = useLatestCallback((event: RunEvent) => {
    setTerminalSeq((current) => Math.max(current, event.seq));
    setStreamRequest(null);
    void settleAfterRunAsync(event.runId, event.seq);
  });

  // The stream can end before the API releases the run, so wait briefly for it to go inactive.
  async function settleAfterRunAsync(runId: string | undefined, terminalEventSeq: number) {
    try {
      let refreshed = await dataSource.getCaseStateAsync(caseId);
      for (
        let attempt = 1;
        refreshed.run.active &&
        refreshed.run.lastEventSeq <= terminalEventSeq &&
        attempt < settleAttempts;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, settleDelayMs));
        refreshed = await dataSource.getCaseStateAsync(caseId);
      }

      mutate(() => refreshed);
      setLive((current) =>
        current && current.progress.runId === runId ? { ...current, settled: true } : current,
      );
    } catch {
      reload();
    }
  }

  const handleStreamError = useLatestCallback((error: Error) => {
    void (async () => {
      if (!(await reconcileAfterInterruptionAsync())) {
        toast.error("Live progress was interrupted", { description: describeError(error) });
      }
    })();
  });

  // A stream that drops or closes without a terminal event may belong to a run that already
  // finished (the server closes once a finished run is released, for example when the snapshot
  // cursor pointed at its terminal event). Refetch, and stop streaming once the run is inactive.
  // A genuinely new run stays active, so its subscription keeps waiting for the first event.
  async function reconcileAfterInterruptionAsync(): Promise<boolean> {
    if (reconciling.current) {
      return false;
    }

    reconciling.current = true;
    try {
      const refreshed = await dataSource.getCaseStateAsync(caseId);
      mutate(() => refreshed);
      if (refreshed.run.active) {
        return false;
      }

      setStreamRequest(null);
      setLive((current) => current && { ...current, settled: true });
      return true;
    } catch {
      return false;
    } finally {
      reconciling.current = false;
    }
  }

  const handleConnectionChange = useLatestCallback((next: StreamConnectionState) => {
    setConnection(next);
    if (next === "reconnecting") {
      void reconcileAfterInterruptionAsync();
    }
  });

  const requestId = activeRequest?.id;
  const requestRunId = activeRequest?.runId;
  const requestReplay = activeRequest?.replay ?? false;
  const requestLastEventId = activeRequest?.lastEventId;

  useEffect(() => {
    if (requestId === undefined) {
      return;
    }

    const handlers = {
      onEvent: (event: RunEvent) => handleEvent(event, requestReplay),
      onTerminal: (event: RunEvent) => handleTerminal(event),
      onError: (error: Error) => handleStreamError(error),
      onConnectionChange: handleConnectionChange,
    };
    const paced =
      requestReplay && dataSource.mode === "live"
        ? paceRunStreamHandlers(handlers, replayPaceMs)
        : undefined;
    const unsubscribe = dataSource.subscribeToRun(caseId, paced?.handlers ?? handlers, {
      runId: requestRunId,
      lastEventId: requestLastEventId,
    });
    return () => {
      paced?.cancel();
      unsubscribe();
    };
  }, [
    caseId,
    dataSource,
    requestId,
    requestRunId,
    requestReplay,
    requestLastEventId,
    handleEvent,
    handleTerminal,
    handleStreamError,
    handleConnectionChange,
  ]);

  const hasProcessingDocuments = Boolean(
    state?.documents.some((document) => processingStatuses.has(document.status)),
  );

  useEffect(() => {
    if (!hasProcessingDocuments) {
      return;
    }

    const timer = setTimeout(reload, processingPollMs);
    return () => clearTimeout(timer);
  }, [hasProcessingDocuments, reload, state, caseState.error]);

  async function startAsync(action: WorkspaceAction) {
    if (!state) {
      return;
    }

    setBusyAction(action);
    try {
      await Promise.allSettled([...uploadsInFlight.current]);
      const { runId } = await retryWhileUploadingAsync(
        () =>
          action === "run" ? dataSource.startRunAsync(caseId) : dataSource.retryRunAsync(caseId),
        uploadRetry,
      );
      setLive({
        progress: {
          ...createRunProgress(state),
          runId,
          status: "running",
          error: undefined,
          announcement: action === "run" ? "Starting the run." : "Retrying the failed steps.",
        },
        replay: false,
      });
      setStreamRequest({
        id: nextRequestId(),
        runId,
        replay: false,
        lastEventId: state.run.lastEventSeq,
      });
      reload();
    } catch (error) {
      if (!showReadOnlyToast(error)) {
        toast.error(action === "run" ? "The run did not start" : "The retry did not start", {
          description: describeError(error),
        });
      }
    } finally {
      setBusyAction(undefined);
    }
  }

  function replay() {
    const runId = state?.run.lastRunId;
    if (!state || !runId) {
      return;
    }

    setLive({ progress: createReplayProgress(state), replay: true });
    setStreamRequest({ id: nextRequestId(), runId, replay: true });
  }

  async function uploadAsync(files: File[]) {
    const { supported, unsupported } = partitionUploadFiles(files);
    const pending = supported.map((file) => ({
      id: `upload-${nextRequestId()}`,
      file,
    }));
    setUploads((current) => [
      ...current,
      ...unsupported.map((file) => ({
        id: `upload-${nextRequestId()}`,
        name: file.name,
        size: file.size,
        status: "failed" as const,
        error: unsupportedUploadMessage,
      })),
      ...pending.map(({ id, file }) => ({
        id,
        name: file.name,
        size: file.size,
        status: "uploading" as const,
      })),
    ]);
    const settled = Promise.all(
      pending.map(async ({ id, file }) => {
        try {
          const document: CaseDocument = await dataSource.uploadDocumentAsync(caseId, file);
          setUploads((current) => current.filter((upload) => upload.id !== id));
          mutate((current) => ({ ...current, documents: [...current.documents, document] }));
        } catch (error) {
          if (showReadOnlyToast(error)) {
            setUploads((current) => current.filter((upload) => upload.id !== id));
            return;
          }

          // The case was planned or started elsewhere; refresh so the upload area explains why.
          if (
            hasApiErrorCode(error, apiErrorCodes.caseAlreadyPlanned) ||
            hasApiErrorCode(error, apiErrorCodes.runInProgress)
          ) {
            reload();
          }

          setUploads((current) =>
            current.map((upload) =>
              upload.id === id
                ? { ...upload, status: "failed", error: describeError(error) }
                : upload,
            ),
          );
        }
      }),
    );
    uploadsInFlight.current.add(settled);
    try {
      await settled;
    } finally {
      uploadsInFlight.current.delete(settled);
    }
  }

  let uploadLockedReason: string | undefined;
  if (state?.run.active || activeRequest || busyAction) {
    uploadLockedReason = runActiveUploadMessage;
  } else if (state && state.tasks.length > 0) {
    uploadLockedReason = casePlannedUploadMessage;
  }

  let progress: RunProgress | undefined;
  if (live && !live.settled) {
    progress = live.progress;
  } else if (state) {
    progress = { ...createRunProgress(state), announcement: live?.progress.announcement ?? "" };
  }

  return {
    state,
    error: caseState.error,
    loading: caseState.loading,
    progress,
    replaying: Boolean(live?.replay && activeRequest),
    streaming: Boolean(activeRequest),
    connection,
    busyAction,
    uploads,
    uploading: uploads.some((upload) => upload.status === "uploading"),
    uploadLockedReason,
    reload,
    mutate,
    runAsync: () => startAsync("run"),
    retryAsync: () => startAsync("retry"),
    replay,
    uploadAsync,
    dismissUpload: (id) => setUploads((current) => current.filter((upload) => upload.id !== id)),
  };
}
