export interface ResponseIssue {
  path: (string | number)[];
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly reason?: string;
  readonly body?: unknown;

  constructor(message: string, status: number, options: { reason?: string; body?: unknown } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.reason = options.reason;
    this.body = options.body;
  }
}

export class SampleReadOnlyError extends ApiError {
  readonly copyUrl: string;

  constructor(
    copyUrl: string,
    message = "Sample cases are read-only. Try this case to work on a copy.",
  ) {
    super(message, 409, { reason: "sample-read-only" });
    this.name = "SampleReadOnlyError";
    this.copyUrl = copyUrl;
  }
}

export class ApiNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApiNetworkError";
  }
}

export class ApiResponseValidationError extends Error {
  readonly path: string;
  readonly issues: ResponseIssue[];

  constructor(path: string, issues: ResponseIssue[]) {
    super(`Unexpected response from ${path}`);
    this.name = "ApiResponseValidationError";
    this.path = path;
    this.issues = issues;
  }
}

export class DataSourceNotSupportedError extends Error {
  constructor(feature: string) {
    super(`${feature} needs the live API.`);
    this.name = "DataSourceNotSupportedError";
  }
}

export function isSampleReadOnlyError(error: unknown): error is SampleReadOnlyError {
  return error instanceof SampleReadOnlyError;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiResponseValidationError) {
    return "The server sent a response this page could not read. Refresh to try again.";
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Something went wrong. Try again.";
}
