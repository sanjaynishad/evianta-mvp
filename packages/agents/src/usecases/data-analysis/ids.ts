export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "blank";
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
