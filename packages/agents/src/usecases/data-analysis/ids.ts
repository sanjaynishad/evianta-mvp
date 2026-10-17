export const MAX_SLUG_CHARS = 40;
export const MAX_LABEL_CHARS = 60;

export function slugify(text: string): string {
  const slug = text
    .slice(0, MAX_SLUG_CHARS * 4)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/^-+|-+$/g, "");

  return slug || "blank";
}

/** Bounds a source value used as a display label, such as a category value. */
export function shortLabel(text: string): string {
  return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 3)}...` : text;
}

/** Returns a function that hands out unique ids, suffixing repeats with -2, -3, and so on. */
export function createIdAllocator(): (base: string) => string {
  const used = new Set<string>();

  return (base) => {
    let id = base;
    let suffix = 2;

    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }

    used.add(id);

    return id;
  };
}
