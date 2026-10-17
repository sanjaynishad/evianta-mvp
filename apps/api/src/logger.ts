export interface ApiLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

function write(severity: string, message: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({ severity, message, ...data });

  if (severity === "ERROR") {
    console.error(line);

    return;
  }

  console.log(line);
}

/** One JSON object per line, which Cloud Run turns into structured log entries. */
export const jsonLogger: ApiLogger = {
  info: (message, data) => write("INFO", message, data),
  warn: (message, data) => write("WARNING", message, data),
  error: (message, data) => write("ERROR", message, data),
};

export const silentApiLogger: ApiLogger = {
  info() {},
  warn() {},
  error() {},
};

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
