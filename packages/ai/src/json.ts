export type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: string };

function tryParse(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function parseJsonText(text: string): JsonParseResult {
  const trimmed = text.trim();

  if (!trimmed) {
    return { ok: false, error: "The model returned an empty response." };
  }

  const direct = tryParse(trimmed);

  if (direct.ok) {
    return direct;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);

  if (fenced?.[1]) {
    const fromFence = tryParse(fenced[1].trim());

    if (fromFence.ok) {
      return fromFence;
    }
  }

  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));

  if (start >= 0 && end > start) {
    const embedded = tryParse(trimmed.slice(start, end + 1));

    if (embedded.ok) {
      return embedded;
    }
  }

  return direct;
}
