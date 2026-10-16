import type {
  AgentProfile,
  AgentProfileInput,
  AgentRole,
  Case,
  CaseStatus,
  Deliverable,
  DeliverableInput,
  DocumentMetadata,
  DocumentMetadataInput,
  Evidence,
  EvidenceInput,
  ExtractedDocument,
  ExtractedDocumentInput,
  Finding,
  FindingInput,
  NewRunEvent,
  OpenQuestionStatus,
  RunEvent,
  SectionReviewStatus,
  Task,
  TaskInput,
  TaskStatus,
  TokenUsage,
  UseCase,
} from "@evianta/core";

export interface CreateCaseInput {
  id?: string;
  title: string;
  description?: string;
  useCase: UseCase;
  status?: CaseStatus;
  visitorId?: string;
  isSample?: boolean;
}

export interface ListAllCasesOptions {
  limit?: number;
  cursor?: string;
}

export interface CasePage {
  cases: Case[];
  nextCursor?: string;
}

/** Values are added to the current usage summary; `lastRunAt` replaces it. */
export interface CaseUsageIncrement {
  inputTokens?: number;
  outputTokens?: number;
  costEstimate?: number;
  runCount?: number;
  lastRunAt?: string;
}

export interface ApprovalInput {
  unresolvedQuestionIds?: string[];
  note?: string;
  approvedAt?: string;
}

/** Omitted fields are left unchanged; `lastError: null` clears the stored error. */
export interface TaskUpdate {
  status?: TaskStatus;
  tokenUsage?: TokenUsage;
  costEstimate?: number;
  attempts?: number;
  lastError?: string | null;
}

export interface OpenQuestionUpdate {
  status: OpenQuestionStatus;
  resolutionNote?: string;
}

/** Omitted fields are left unchanged; `null` clears a reviewer edit or comment. */
export interface SectionUpdate {
  editedContent?: string | null;
  reviewStatus?: SectionReviewStatus;
  reviewComment?: string | null;
}

export interface ListProfilesOptions {
  enabledOnly?: boolean;
}

export interface AgentDirectoryRepo {
  listProfilesAsync(options?: ListProfilesOptions): Promise<AgentProfile[]>;
  getProfileAsync(role: AgentRole): Promise<AgentProfile | undefined>;
  upsertProfileAsync(profile: AgentProfileInput): Promise<AgentProfile>;
}

export interface CaseRepo {
  createCaseAsync(input: CreateCaseInput): Promise<Case>;
  getCaseAsync(caseId: string): Promise<Case | undefined>;
  listCasesForVisitorAsync(visitorId: string): Promise<Case[]>;
  listSampleCasesAsync(): Promise<Case[]>;
  listAllCasesAsync(options?: ListAllCasesOptions): Promise<CasePage>;
  updateCaseStatusAsync(caseId: string, status: CaseStatus): Promise<Case>;
  updateCaseUsageAsync(caseId: string, increment: CaseUsageIncrement): Promise<Case>;
  recordApprovalAsync(caseId: string, approval: ApprovalInput): Promise<Case>;
  copyCaseAsync(sourceCaseId: string, visitorId: string): Promise<Case>;
}

export interface TaskRepo {
  createTaskAsync(task: TaskInput): Promise<Task>;
  /** Creates every task of one case atomically: all are stored, or none are. */
  createTasksAsync(caseId: string, tasks: readonly TaskInput[]): Promise<Task[]>;
  getTasksForCaseAsync(caseId: string): Promise<Task[]>;
  updateTaskAsync(caseId: string, taskId: string, update: TaskUpdate): Promise<Task>;
}

export interface FindingRepo {
  addFindingAsync(caseId: string, finding: FindingInput): Promise<Finding>;
  getFindingsForCaseAsync(caseId: string): Promise<Finding[]>;
  updateOpenQuestionAsync(
    caseId: string,
    questionId: string,
    update: OpenQuestionUpdate,
  ): Promise<Finding>;
}

export interface EvidenceRepo {
  addEvidenceAsync(caseId: string, evidence: EvidenceInput): Promise<Evidence>;
  getEvidenceForCaseAsync(caseId: string): Promise<Evidence[]>;
}

export interface DeliverableRepo {
  saveDeliverableAsync(deliverable: DeliverableInput): Promise<Deliverable>;
  /**
   * Reads and writes one deliverable atomically, so concurrent section edits are not overwritten.
   * `update` may run more than once and must be pure; returning undefined leaves it unchanged.
   */
  updateDeliverableAsync(
    caseId: string,
    deliverableId: string,
    update: (current: Deliverable | undefined) => DeliverableInput | undefined,
  ): Promise<Deliverable | undefined>;
  getDeliverablesForCaseAsync(caseId: string): Promise<Deliverable[]>;
  getDeliverableAsync(caseId: string, deliverableId: string): Promise<Deliverable | undefined>;
  updateSectionAsync(
    caseId: string,
    deliverableId: string,
    sectionId: string,
    update: SectionUpdate,
  ): Promise<Deliverable>;
}

export interface DocumentRepo {
  addDocumentMetadataAsync(metadata: DocumentMetadataInput): Promise<DocumentMetadata>;
  getDocumentsForCaseAsync(caseId: string): Promise<DocumentMetadata[]>;
  getDocumentAsync(caseId: string, documentId: string): Promise<DocumentMetadata | undefined>;
  saveExtractionAsync(
    caseId: string,
    extraction: ExtractedDocumentInput,
  ): Promise<ExtractedDocument>;
  getExtractionAsync(caseId: string, documentId: string): Promise<ExtractedDocument | undefined>;
}

export interface EventRepo {
  appendEventAsync(caseId: string, event: NewRunEvent): Promise<RunEvent>;
  listEventsAsync(caseId: string, afterSeq?: number): Promise<RunEvent[]>;
}

export interface Store {
  agents: AgentDirectoryRepo;
  cases: CaseRepo;
  tasks: TaskRepo;
  findings: FindingRepo;
  evidence: EvidenceRepo;
  deliverables: DeliverableRepo;
  documents: DocumentRepo;
  events: EventRepo;
}
