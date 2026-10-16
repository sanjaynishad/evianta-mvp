const STOPWORDS = new Set([
  "a",
  "about",
  "all",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "did",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "in",
  "is",
  "it",
  "its",
  "me",
  "of",
  "on",
  "or",
  "show",
  "tell",
  "that",
  "the",
  "their",
  "there",
  "this",
  "to",
  "was",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
]);

/** Lowercased search terms with stopwords removed and digit grouping commas collapsed. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/(?<=\d),(?=\d)/g, "")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .split(/[^\p{L}\p{N}.]+/u)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))
    .filter((token) => token.length > 1 || /\d/.test(token));
}

export function uniqueTerms(text: string): Set<string> {
  return new Set(tokenize(text));
}

export function countMatchingTerms(terms: ReadonlySet<string>, text: string): number {
  if (terms.size === 0 || text.length === 0) {
    return 0;
  }

  const candidate = uniqueTerms(text);
  let matches = 0;

  for (const term of terms) {
    if (candidate.has(term)) {
      matches += 1;
    }
  }

  return matches;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
