import type {
  AgentDirectoryResponse,
  AgentProfile,
  AgentRole,
  ApproveCaseResponse,
  AskResult,
  Case,
  CaseDocument,
  CaseState,
  CreateCaseRequest,
  Deliverable,
  ExportFormat,
  Finding,
  RunCompletedEvent,
  RunEvent,
  RunFailedEvent,
  RunStartResponse,
  SectionUpdateRequest,
  UsageCasesResponse,
  UsageSummary,
} from "@evianta/core";
import type { DataSourceMode } from "@/lib/env";

export type StreamConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface AskOptions {
  // Receives the answer text as it streams in.
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export interface RunStreamHandlers {
  onEvent: (event: RunEvent) => void;
  onTerminal?: (event: RunCompletedEvent | RunFailedEvent) => void;
  onError?: (error: Error) => void;
  onConnectionChange?: (state: StreamConnectionState) => void;
}

export interface RunStreamOptions {
  // Only events of this run are delivered, and only its terminal event closes the stream.
  runId?: string;
  // Resume after this sequence number.
  lastEventId?: number;
}

export type Unsubscribe = () => void;

export interface UploadOptions {
  signal?: AbortSignal;
}

export interface UsageCasesQuery {
  cursor?: string;
  limit?: number;
}

export interface CaseDataSource {
  readonly mode: DataSourceMode;
  listAgentsAsync(options?: { enabledOnly?: boolean }): Promise<AgentDirectoryResponse>;
  getAgentAsync(role: AgentRole): Promise<AgentProfile>;
  listSamplesAsync(): Promise<Case[]>;
  listCasesAsync(): Promise<Case[]>;
  createCaseAsync(request: CreateCaseRequest): Promise<Case>;
  copyCaseAsync(caseId: string): Promise<Case>;
  getCaseStateAsync(caseId: string): Promise<CaseState>;
  uploadDocumentAsync(caseId: string, file: File, options?: UploadOptions): Promise<CaseDocument>;
  startRunAsync(caseId: string): Promise<RunStartResponse>;
  retryRunAsync(caseId: string): Promise<RunStartResponse>;
  subscribeToRun(
    caseId: string,
    handlers: RunStreamHandlers,
    options?: RunStreamOptions,
  ): Unsubscribe;
  getDeliverableAsync(caseId: string, deliverableId: string): Promise<Deliverable>;
  // Undefined when the data source cannot produce server-side exports.
  getExportUrl(caseId: string, deliverableId: string, format: ExportFormat): string | undefined;
  askAsync(caseId: string, question: string, options?: AskOptions): Promise<AskResult>;
  updateSectionAsync(
    caseId: string,
    deliverableId: string,
    sectionId: string,
    update: SectionUpdateRequest,
  ): Promise<Deliverable>;
  resolveOpenQuestionAsync(caseId: string, questionId: string, note?: string): Promise<Finding>;
  dismissOpenQuestionAsync(caseId: string, questionId: string, note?: string): Promise<Finding>;
  approveCaseAsync(caseId: string, note?: string): Promise<ApproveCaseResponse>;
  listUsageCasesAsync(usageViewPath: string, query?: UsageCasesQuery): Promise<UsageCasesResponse>;
  getUsageSummaryAsync(usageViewPath: string): Promise<UsageSummary>;
}
