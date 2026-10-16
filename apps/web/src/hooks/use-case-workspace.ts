"use client";

import { useCallback, useEffect, useState } from "react";
import type { CaseDocument, CaseState, RunEvent } from "@evianta/core";
import { toast } from "@/components/ui/sonner";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useResource } from "@/hooks/use-resource";
import { describeError, isSampleReadOnlyError } from "@/lib/api/errors";
import { paceRunStreamHandlers } from "@/lib/api/run-stream";
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
}

export type WorkspaceAction = "run" | "retry";

const replayPaceMs = 450;
const processingPollMs = 3000;
const processingStatuses = new Set(["queued", "reading-text", "ocr"]);

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
  reload: () => void;
  runAsync: () => Promise<void>;
  retryAsync: () => Promise<void>;
  replay: () => void;
  uploadAsync: (files: File[]) => Promise<void>;
  dismissUpload: (id: string) => void;
}

export function useCaseWorkspace(
  caseId: string,
  options: { onTryCase?: () => void } = {},
): CaseWorkspaceController {
  const dataSource = useDataSource();
  const caseState = useResource(`case:${caseId}`, () => dataSource.getCaseStateAsync(caseId));
  const [live, setLive] = useState<LiveProgress | null>(null);
  const [streamRequest, setStreamRequest] = useState<StreamRequest | null>(null);
  const [finishedRunIds, setFinishedRunIds] = useState<string[]>([]);
  const [connection, setConnection] = useState<StreamConnectionState>();
  const [busyAction, setBusyAction] = useState<WorkspaceAction>();
  const [uploads, setUploads] = useState<LocalUpload[]>([]);
  const state = caseState.data;
  const { reload, mutate } = caseState;

  const runningRunId = state?.latestRun?.status === "running" ? state.latestRun.runId : undefined;
  const autoRequest: StreamRequest | null =
    runningRunId && !finishedRunIds.includes(runningRunId)
      ? { id: -1, runId: runningRunId, replay: false }
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
      const base = current?.progress ?? (state ? createRunProgress(state) : undefined);
      return base ? { progress: applyRunEvent(base, event), replay } : current;
    });
  });

  const handleTerminal = useLatestCallback((runId: string | undefined) => {
    if (runId) {
      setFinishedRunIds((current) => [...current, runId]);
    }

    setStreamRequest(null);
    reload();
  });

  const handleStreamError = useLatestCallback((error: Error) => {
    toast.error("Live progress was interrupted", { description: describeError(error) });
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
      onTerminal: () => handleTerminal(requestRunId),
      onError: (error: Error) => handleStreamError(error),
      onConnectionChange: setConnection,
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
  ]);

  const hasProcessingDocuments = Boolean(
    state?.documents.some(
      (document) => document.processing && processingStatuses.has(document.processing.status),
    ),
  );

  useEffect(() => {
    if (!hasProcessingDocuments) {
      return;
    }

    const timer = setTimeout(reload, processingPollMs);
    return () => clearTimeout(timer);
  }, [hasProcessingDocuments, reload, state]);

  async function startAsync(action: WorkspaceAction) {
    if (!state) {
      return;
    }

    setBusyAction(action);
    try {
      const { runId } =
        action === "run"
          ? await dataSource.startRunAsync(caseId)
          : await dataSource.retryRunAsync(caseId);
      setLive({
        progress: {
          ...createRunProgress(state),
          runId,
          status: "running",
          announcement: action === "run" ? "Starting the run." : "Retrying the failed steps.",
        },
        replay: false,
      });
      setStreamRequest({
        id: nextRequestId(),
        runId,
        replay: false,
        lastEventId: state.latestRun?.lastEventSeq,
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
    if (!state?.latestRun) {
      return;
    }

    setLive({ progress: createReplayProgress(state), replay: true });
    setStreamRequest({ id: nextRequestId(), runId: state.latestRun.runId, replay: true });
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
    await Promise.all(
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
  }

  const progress = live?.progress ?? (state ? createRunProgress(state) : undefined);

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
    reload,
    runAsync: () => startAsync("run"),
    retryAsync: () => startAsync("retry"),
    replay,
    uploadAsync,
    dismissUpload: (id) => setUploads((current) => current.filter((upload) => upload.id !== id)),
  };
}
