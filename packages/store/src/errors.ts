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
