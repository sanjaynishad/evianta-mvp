import type { Citation } from "@evianta/core";

export type { Citation } from "@evianta/core";

export const VERIFY_AGAINST_CURRENT_LAW = "Verify against current law";

interface GroundingChunk {
  web?: { uri?: string; title?: string; domain?: string };
  retrievedContext?: { uri?: string; title?: string; text?: string };
}

interface GroundingSupport {
  segment?: { text?: string };
  groundingChunkIndices?: number[];
}

interface GroundingMetadata {
  groundingChunks?: GroundingChunk[];
  groundingSupports?: GroundingSupport[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isGroundingMetadata(value: unknown): value is GroundingMetadata {
  const record = asRecord(value);

  return record !== undefined && Array.isArray(record.groundingChunks);
}

function findGroundingMetadata(response: unknown): GroundingMetadata[] {
  const record = asRecord(response);

  if (!record) {
    return [];
  }

  if (Array.isArray(record.groundingChunks)) {
    return [record as GroundingMetadata];
  }

  if (isGroundingMetadata(record.groundingMetadata)) {
    return [record.groundingMetadata];
  }

  if (Array.isArray(record.candidates)) {
    return record.candidates.flatMap((candidate) => {
      const metadata = asRecord(candidate)?.groundingMetadata;

      return isGroundingMetadata(metadata) ? [metadata] : [];
    });
  }

  for (const nestedKey of ["custom", "raw"]) {
    const nested = findGroundingMetadata(record[nestedKey]);

    if (nested.length > 0) {
      return nested;
    }
  }

  return [];
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function citationsFromMetadata(metadata: GroundingMetadata): Citation[] {
  const chunks = metadata.groundingChunks ?? [];
  const snippetsByChunk = new Map<number, string[]>();

  for (const support of metadata.groundingSupports ?? []) {
    const text = support.segment?.text?.trim();

    if (!text) {
      continue;
    }

    for (const index of support.groundingChunkIndices ?? []) {
      const snippets = snippetsByChunk.get(index) ?? [];

      if (!snippets.includes(text)) {
        snippets.push(text);
      }

      snippetsByChunk.set(index, snippets);
    }
  }

  return chunks.flatMap((chunk, index) => {
    const source = chunk.web ?? chunk.retrievedContext;
    const url = source?.uri?.trim();

    if (!url) {
      return [];
    }

    const contextText = chunk.retrievedContext?.text?.trim();
    const snippet = snippetsByChunk.get(index)?.join(" ") ?? contextText ?? "";
    const title = source?.title?.trim() || chunk.web?.domain?.trim() || hostnameOf(url);

    return [{ title, url, snippet }];
  });
}

export function extractCitations(response: unknown): Citation[] {
  const citationsByUrl = new Map<string, Citation>();

  for (const metadata of findGroundingMetadata(response)) {
    for (const citation of citationsFromMetadata(metadata)) {
      const existing = citationsByUrl.get(citation.url);

      if (!existing) {
        citationsByUrl.set(citation.url, citation);
        continue;
      }

      if (citation.snippet && !existing.snippet.includes(citation.snippet)) {
        existing.snippet = existing.snippet
          ? `${existing.snippet} ${citation.snippet}`
          : citation.snippet;
      }
    }
  }

  return [...citationsByUrl.values()];
}
