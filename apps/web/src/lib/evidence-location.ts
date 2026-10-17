import type {
  BoundingBox,
  EvidenceLocation,
  ExtractedPage,
  ExtractedTable,
  PageExtractionMethod,
  TextSpan,
} from "@evianta/core";

export type HighlightSource = "bbox" | "quote" | "page";

export interface RegionHighlight {
  page: number;
  boxes: BoundingBox[];
  source: HighlightSource;
  // OCR and handwriting positions are estimates, so the highlight is labelled approximate.
  approximate: boolean;
}

export interface Point {
  x: number;
  y: number;
}

const approximateMethods = new Set<PageExtractionMethod>(["ocr", "handwriting"]);

export function isApproximateMethod(method: PageExtractionMethod | "mixed" | undefined): boolean {
  return method !== undefined && method !== "mixed" && approximateMethods.has(method);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

// Finds a quote in text ignoring case and differences in whitespace, and returns the matching
// range as offsets into the original text.
export function findQuoteRange(
  text: string,
  quote: string,
): { start: number; end: number } | undefined {
  const needle = normalizeText(quote);
  if (!needle) {
    return undefined;
  }

  let normalized = "";
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (/\s/.test(char)) {
      if (normalized.length > 0 && !normalized.endsWith(" ")) {
        normalized += " ";
        offsets.push(index);
      }

      continue;
    }

    normalized += char.toLowerCase();
    offsets.push(index);
  }

  const found = normalized.indexOf(needle);
  if (found < 0) {
    return undefined;
  }

  return { start: offsets[found]!, end: offsets[found + needle.length - 1]! + 1 };
}

function compactText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

// Finds the spans that together contain the quote, comparing case-insensitively and ignoring
// whitespace entirely, because span boundaries can fall inside a word or number ("12" ",400").
export function findQuoteInSpans(quote: string, spans: TextSpan[]): BoundingBox[] | undefined {
  const needle = compactText(quote);
  if (!needle) {
    return undefined;
  }

  let haystack = "";
  const ranges: { start: number; end: number; span: TextSpan }[] = [];
  for (const span of spans) {
    const text = compactText(span.text);
    if (!text) {
      continue;
    }

    ranges.push({ start: haystack.length, end: haystack.length + text.length, span });
    haystack += text;
  }

  const index = haystack.indexOf(needle);
  if (index < 0) {
    return undefined;
  }

  const end = index + needle.length;
  const boxes = ranges
    .filter((range) => range.start < end && range.end > index)
    .map((range) => range.span.bbox);
  return boxes.length > 0 ? boxes : undefined;
}

export interface ResolveHighlightOptions {
  // Number of pages in the source, so a page outside it falls back to the first page.
  pageCount?: number;
  approximate?: boolean;
}

// Resolves where to highlight: the evidence bbox, else the quote located in extracted spans,
// else the whole page. Locating the quote in the rendered PDF text layer happens in the viewer.
export function resolveRegionHighlight(
  location: EvidenceLocation | undefined,
  page: ExtractedPage | undefined,
  options: ResolveHighlightOptions = {},
): RegionHighlight {
  const requestedPage = location?.page ?? page?.index ?? 1;
  const pageNumber =
    options.pageCount && requestedPage > options.pageCount ? 1 : Math.max(1, requestedPage);
  const approximate = options.approximate ?? isApproximateMethod(page?.method);

  if (location?.bbox) {
    return { page: pageNumber, boxes: [location.bbox], source: "bbox", approximate };
  }

  if (location?.textQuote && page?.spans) {
    const boxes = findQuoteInSpans(location.textQuote, page.spans);
    if (boxes) {
      return { page: pageNumber, boxes, source: "quote", approximate };
    }
  }

  return { page: pageNumber, boxes: [], source: "page", approximate };
}

export function unionBoxes(boxes: BoundingBox[]): BoundingBox | undefined {
  if (boxes.length === 0) {
    return undefined;
  }

  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function boxContainsPoint(box: BoundingBox, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

export function boxCenter(box: BoundingBox): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export function clampBox(box: BoundingBox): BoundingBox {
  const x = Math.min(Math.max(box.x, 0), 1);
  const y = Math.min(Math.max(box.y, 0), 1);
  return {
    x,
    y,
    width: Math.min(Math.max(box.width, 0), 1 - x),
    height: Math.min(Math.max(box.height, 0), 1 - y),
  };
}

export function toPercentStyle(box: BoundingBox): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  const clamped = clampBox(box);
  const percent = (value: number) => `${Math.round(value * 10000) / 100}%`;
  return {
    left: percent(clamped.x),
    top: percent(clamped.y),
    width: percent(clamped.width),
    height: percent(clamped.height),
  };
}

export interface SheetRange {
  startRow: number;
  endRow: number;
  // 1-based columns; undefined means every column.
  startColumn?: number;
  endColumn?: number;
}

export function columnNumber(letters: string): number {
  let result = 0;
  for (const letter of letters.toUpperCase()) {
    result = result * 26 + (letter.charCodeAt(0) - 64);
  }

  return result;
}

export function columnLabel(column: number): string {
  let label = "";
  let remaining = column;
  while (remaining > 0) {
    const offset = (remaining - 1) % 26;
    label = String.fromCharCode(65 + offset) + label;
    remaining = Math.floor((remaining - 1) / 26);
  }

  return label;
}

const cellPattern = /^\$?([A-Za-z]{1,3})\$?(\d+)$/;
const qualifiedRangePattern = /^(?:'((?:[^']|'')+)'|([^!']+))!(.+)$/;

// Splits "Sales!H2" or "'Q2 Sales'!A1:B4" into the worksheet name and the A1 reference.
export function splitSheetQualifier(range: string): { sheet?: string; reference: string } {
  const match = qualifiedRangePattern.exec(range.trim());
  if (!match) {
    return { reference: range.trim() };
  }

  const sheet = match[1] !== undefined ? match[1].replace(/''/g, "'") : match[2]!.trim();
  return { sheet, reference: match[3]!.trim() };
}

// Parses an A1 cell or range such as "B14:F29" or "H2", optionally sheet-qualified.
export function parseCellRange(range: string): SheetRange | undefined {
  const [startRef, endRef = startRef] = splitSheetQualifier(range).reference.split(":");
  const start = startRef ? cellPattern.exec(startRef.trim()) : null;
  const end = endRef ? cellPattern.exec(endRef.trim()) : null;
  if (!start || !end) {
    return undefined;
  }

  const columns = [columnNumber(start[1]!), columnNumber(end[1]!)];
  const rows = [Number(start[2]), Number(end[2])];
  return {
    startRow: Math.min(...rows),
    endRow: Math.max(...rows),
    startColumn: Math.min(...columns),
    endColumn: Math.max(...columns),
  };
}

export function sheetRangeOf(location: EvidenceLocation | undefined): SheetRange | undefined {
  if (!location) {
    return undefined;
  }

  if (location.cellRange) {
    const parsed = parseCellRange(location.cellRange);
    if (parsed) {
      return parsed;
    }
  }

  if (location.rowRange) {
    return {
      startRow: Math.min(location.rowRange.start, location.rowRange.end),
      endRow: Math.max(location.rowRange.start, location.rowRange.end),
    };
  }

  return undefined;
}

export interface TableLayout {
  // Worksheet row of the header and the first data row, and the worksheet column of the first column.
  headerRow: number;
  firstDataRow: number;
  firstColumn: number;
}

export function tableLayout(table: ExtractedTable): TableLayout {
  const parsed = table.range ? parseCellRange(table.range) : undefined;
  const headerRow = parsed?.startRow ?? 1;
  return {
    headerRow,
    firstDataRow: headerRow + 1,
    firstColumn: parsed?.startColumn ?? 1,
  };
}

// The worksheet a location points at: its sheet field, else the qualifier on its cell range.
export function sheetOfLocation(location: EvidenceLocation | undefined): string | undefined {
  if (location?.sheet) {
    return location.sheet;
  }

  return location?.cellRange ? splitSheetQualifier(location.cellRange).sheet : undefined;
}

export function findTableForLocation(
  tables: ExtractedTable[],
  location: EvidenceLocation | undefined,
): ExtractedTable | undefined {
  const sheet = sheetOfLocation(location);
  if (sheet) {
    const match = tables.find((table) => table.sheet === sheet || table.name === sheet);
    if (match) {
      return match;
    }
  }

  return tables[0];
}

export function rangeContainsRow(range: SheetRange, row: number): boolean {
  return row >= range.startRow && row <= range.endRow;
}

export function rangeContainsCell(range: SheetRange, row: number, column: number): boolean {
  if (!rangeContainsRow(range, row)) {
    return false;
  }

  if (range.startColumn === undefined || range.endColumn === undefined) {
    return true;
  }

  return column >= range.startColumn && column <= range.endColumn;
}

export function locationMatchesSheet(
  location: EvidenceLocation | undefined,
  table: ExtractedTable,
): boolean {
  const sheet = sheetOfLocation(location);
  if (!sheet) {
    return true;
  }

  return sheet === table.sheet || sheet === table.name;
}
