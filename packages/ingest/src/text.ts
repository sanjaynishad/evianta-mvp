export interface TextParseResult {
  text: string;
  warnings: string[];
}

const KEPT_EMAIL_HEADERS = ["from", "to", "cc", "date", "subject"] as const;
const HEADER_LABELS: Record<(typeof KEPT_EMAIL_HEADERS)[number], string> = {
  from: "From",
  to: "To",
  cc: "Cc",
  date: "Date",
  subject: "Subject",
};
const MAX_MIME_DEPTH = 10;

interface MimeEntity {
  headers: Map<string, string>;
  body: string;
}

interface ContentType {
  type: string;
  params: Map<string, string>;
}

export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function parsePlainText(text: string): TextParseResult {
  return { text: normalizeLineEndings(text), warnings: [] };
}

function splitEntity(raw: string): MimeEntity {
  const separator = /(^|\n)[ \t]*\n/.exec(raw);
  const headerBlock = separator ? raw.slice(0, separator.index) : raw;
  const body = separator ? raw.slice(separator.index + separator[0].length) : "";
  const headers = new Map<string, string>();
  let current: string | undefined;

  for (const line of headerBlock.split("\n")) {
    if (/^[ \t]/.test(line) && current !== undefined) {
      headers.set(current, `${headers.get(current) ?? ""} ${line.trim()}`);
      continue;
    }

    const colon = line.indexOf(":");

    if (colon <= 0) {
      current = undefined;
      continue;
    }

    current = line.slice(0, colon).trim().toLowerCase();

    const value = line.slice(colon + 1).trim();
    const existing = headers.get(current);

    headers.set(current, existing === undefined ? value : `${existing}, ${value}`);
  }

  return { headers, body };
}

function parseContentType(value: string | undefined): ContentType {
  const [type = "", ...rest] = (value ?? "text/plain").split(";");
  const params = new Map<string, string>();

  for (const part of rest) {
    const equals = part.indexOf("=");

    if (equals > 0) {
      const key = part.slice(0, equals).trim().toLowerCase();
      const paramValue = part
        .slice(equals + 1)
        .trim()
        .replace(/^"(.*)"$/, "$1");

      params.set(key, paramValue);
    }
  }

  return { type: type.trim().toLowerCase() || "text/plain", params };
}

function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function decodeQuotedPrintableBytes(text: string): Uint8Array {
  const unfolded = text.replace(/=[ \t]*\n/g, "");
  const bytes: number[] = [];

  for (let index = 0; index < unfolded.length; index += 1) {
    const char = unfolded[index] as string;
    const hex = unfolded.slice(index + 1, index + 3);

    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }

    bytes.push(...Buffer.from(char, "utf8"));
  }

  return Uint8Array.from(bytes);
}

function decodeTransfer(body: string, encoding: string | undefined, charset?: string): string {
  const normalized = encoding?.trim().toLowerCase();

  if (normalized === "base64") {
    return decodeBytes(Buffer.from(body.replace(/\s+/g, ""), "base64"), charset);
  }

  if (normalized === "quoted-printable") {
    return decodeBytes(decodeQuotedPrintableBytes(body), charset);
  }

  return body;
}

// RFC 2047 encoded words such as =?UTF-8?B?...?= appear in subjects and display names.
function decodeHeaderValue(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(
      /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
      (_match, charset: string, encoding: string, encoded: string) => {
        if (encoding.toUpperCase() === "B") {
          return decodeBytes(Buffer.from(encoded, "base64"), charset);
        }

        return decodeBytes(decodeQuotedPrintableBytes(encoded.replace(/_/g, " ")), charset);
      },
    );
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface BodyParts {
  plain: string[];
  html: string[];
}

function collectBodyParts(entity: MimeEntity, parts: BodyParts, depth: number): void {
  const contentType = parseContentType(entity.headers.get("content-type"));
  const encoding = entity.headers.get("content-transfer-encoding");
  const charset = contentType.params.get("charset");

  if (contentType.type.startsWith("multipart/")) {
    const boundary = contentType.params.get("boundary");

    if (!boundary || depth >= MAX_MIME_DEPTH) {
      return;
    }

    const delimiter = `--${boundary}`;
    const sections = entity.body.split("\n");
    let current: string[] | undefined;

    for (const line of sections) {
      const trimmed = line.trimEnd();

      if (trimmed === delimiter || trimmed === `${delimiter}--`) {
        if (current) {
          collectBodyParts(splitEntity(current.join("\n")), parts, depth + 1);
        }

        current = trimmed === delimiter ? [] : undefined;
        continue;
      }

      current?.push(line);
    }

    if (current) {
      collectBodyParts(splitEntity(current.join("\n")), parts, depth + 1);
    }

    return;
  }

  if (contentType.type === "message/rfc822" && depth < MAX_MIME_DEPTH) {
    collectBodyParts(splitEntity(entity.body), parts, depth + 1);
    return;
  }

  if (contentType.type === "text/plain") {
    parts.plain.push(decodeTransfer(entity.body, encoding, charset).trim());
    return;
  }

  if (contentType.type === "text/html") {
    parts.html.push(htmlToText(decodeTransfer(entity.body, encoding, charset)));
  }
}

/** Keeps the From, To, Cc, Date, and Subject headers, then the plain-text body. */
export function parseEmail(raw: string): TextParseResult {
  const entity = splitEntity(normalizeLineEndings(raw));
  const warnings: string[] = [];
  const headerLines = KEPT_EMAIL_HEADERS.flatMap((name) => {
    const value = entity.headers.get(name);

    return value === undefined ? [] : [`${HEADER_LABELS[name]}: ${decodeHeaderValue(value)}`];
  });
  const parts: BodyParts = { plain: [], html: [] };

  collectBodyParts(entity, parts, 0);

  let bodyParts = parts.plain.filter((part) => part.length > 0);

  if (bodyParts.length === 0 && parts.html.length > 0) {
    bodyParts = parts.html.filter((part) => part.length > 0);
    warnings.push("The email has no plain-text body; its HTML body was converted to text.");
  } else if (parts.plain.length === 0) {
    warnings.push("The email has no plain-text body.");
  }

  const body = normalizeLineEndings(bodyParts.join("\n\n"));
  const text = [headerLines.join("\n"), body].filter((section) => section.length > 0).join("\n\n");

  return { text, warnings };
}
