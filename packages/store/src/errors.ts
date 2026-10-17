export type StoreEntity =
  | "agent-profile"
  | "case"
  | "task"
  | "finding"
  | "open-question"
  | "evidence"
  | "deliverable"
  | "deliverable-section"
  | "document"
  | "extraction"
  | "event"
  | "file";

export class StoreNotFoundError extends Error {
  constructor(
    readonly entity: StoreEntity,
    readonly id: string,
  ) {
    super(`${entity} "${id}" was not found`);
    this.name = "StoreNotFoundError";
  }
}

export class StoreConflictError extends Error {
  constructor(
    readonly entity: StoreEntity,
    readonly id: string,
  ) {
    super(`${entity} "${id}" already exists`);
    this.name = "StoreConflictError";
  }
}

/** A fenced write was rejected because its owner no longer holds the case run lease. */
export class StoreLeaseLostError extends Error {
  constructor(
    readonly caseId: string,
    readonly leaseOwner: string,
  ) {
    super(`The run lease for case "${caseId}" is no longer held by this run`);
    this.name = "StoreLeaseLostError";
  }
}
