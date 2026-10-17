export interface ServerSentEvent {
  event: string;
  data: string;
  id?: string;
}

// Parses a text/event-stream body, for POST streams that EventSource cannot open.
export async function readServerSentEventsAsync(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ServerSentEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  let id: string | undefined;

  function dispatch() {
    if (dataLines.length > 0) {
      onEvent({ event: eventName || "message", data: dataLines.join("\n"), id });
    }

    eventName = "";
    dataLines = [];
  }

  function processLine(line: string) {
    if (line === "") {
      dispatch();
      return;
    }

    if (line.startsWith(":")) {
      return;
    }

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    } else if (field === "id") {
      id = value;
    }
  }

  function processBuffer(final: boolean) {
    // A trailing CR may be the first half of a CRLF split across chunks.
    const holdCarriageReturn = !final && buffer.endsWith("\r");
    const text = holdCarriageReturn ? buffer.slice(0, -1) : buffer;
    const lines = text.split(/\r\n|\r|\n/);
    const rest = lines.pop() ?? "";
    buffer = holdCarriageReturn ? `${rest}\r` : rest;
    for (const line of lines) {
      processLine(line);
    }
  }

  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    processBuffer(false);
  }

  buffer += decoder.decode();
  processBuffer(true);
  if (buffer) {
    processLine(buffer);
  }

  dispatch();
}
