import type {
  AgentDirectoryResponse,
  AgentProfile,
  AgentRole,
  ApproveCaseResponse,
  AskResult,
  Case,
  CaseDocument,
  CaseState,
  ChatMessage,
  ChatMessageRequest,
  ChatReplyFrame,
  CreateCaseRequest,
  Deliverable,
  DocumentDetail,
  ExportFormat,
  Finding,
  RunCompletedEvent,
  RunEvent,
  RunFailedEvent,
  RunStartResponse,
  SectionUpdateRequest,
  SourceAttachResponse,
  SourceConnection,
  SourceConnectorDefinition,
  SourceConnectorId,
  SourceImportRequest,
  SourceItem,
  SourceProposalActionRequest,
  UpdateCaseRequest,
  UpdateIntakeRequest,
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

export interface SendMessageOptions {
  // Receives the stored user message as soon as the server accepts it.
  onUserMessage?: (message: ChatMessage) => void;
  // Receives the assistant reply text as it streams in.
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
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
  getDocumentAsync(caseId: string, documentId: string): Promise<DocumentDetail>;
  // URL of the original file bytes, or undefined when the data source has no copy of them.
  getDocumentFileUrl(caseId: string, documentId: string): string | undefined;
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
  approveCaseAsync(
    caseId: string,
    note?: string,
    acknowledgeIncompleteReview?: boolean,
  ): Promise<ApproveCaseResponse>;
  listUsageCasesAsync(usageViewPath: string, query?: UsageCasesQuery): Promise<UsageCasesResponse>;
  getUsageSummaryAsync(usageViewPath: string): Promise<UsageSummary>;
  updateCaseAsync(caseId: string, update: UpdateCaseRequest): Promise<Case>;
  updateIntakeAsync(caseId: string, update: UpdateIntakeRequest): Promise<Case>;
  listMessagesAsync(caseId: string): Promise<ChatMessage[]>;
  sendMessageAsync(
    caseId: string,
    request: ChatMessageRequest,
    options?: SendMessageOptions,
  ): Promise<ChatReplyFrame>;
  listSourceConnectorsAsync(): Promise<SourceConnectorDefinition[]>;
  listSourceConnectionsAsync(): Promise<SourceConnection[]>;
  connectSourceAsync(connectorId: SourceConnectorId): Promise<SourceConnection>;
  disconnectSourceAsync(connectionId: string): Promise<void>;
  listSourceItemsAsync(connectionId: string): Promise<SourceItem[]>;
  actOnSourceProposalsAsync(
    caseId: string,
    request: SourceProposalActionRequest,
  ): Promise<SourceAttachResponse>;
  importSourceItemAsync(
    caseId: string,
    request: SourceImportRequest,
  ): Promise<SourceAttachResponse>;
}
