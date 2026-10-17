import { inflateRawSync } from "node:zlib";

import type { ExtractedTable } from "@evianta/core";

import { CellBudget } from "./spreadsheet.js";
import { buildTable, uniqueName, type DateOrder, type RawCell } from "./tabular.js";
import { DEFAULT_PAGE_CHARS, pageIndexAt, paginateText, type TextParseResult } from "./text.js";

export const MAX_DOCX_PART_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const MAX_XML_DEPTH = 256;
const MAX_GRID_SPAN = 64;
const DEFAULT_DOCUMENT_PART = "word/document.xml";
const OFFICE_DOCUMENT_RELATIONSHIP = /\/officeDocument$/;
const HEADER_FOOTER_PART = /^word\/(header|footer)\d*\.xml$/;

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);

  for (let offset = bytes.length - 22; offset >= lowest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }

  return -1;
}

function readZipEntries(bytes: Buffer): ZipEntry[] {
  const end = findEndOfCentralDirectory(bytes);

  if (end === -1) {
    throw new Error("The file is not a valid zip archive.");
  }

  const count = bytes.readUInt16LE(end + 10);
  const directoryOffset = bytes.readUInt32LE(end + 16);

  if (count === 0xffff || directoryOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported.");
  }

  if (count > MAX_ZIP_ENTRIES) {
    throw new RangeError(`The archive has more than ${MAX_ZIP_ENTRIES} entries.`);
  }

  const entries: ZipEntry[] = [];
  let offset = directoryOffset;

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("The zip central directory is corrupt.");
    }

    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);

    entries.push({
      name: bytes.toString("utf8", offset + 46, offset + 46 + nameLength),
      flags: bytes.readUInt16LE(offset + 8),
      method: bytes.readUInt16LE(offset + 10),
      compressedSize: bytes.readUInt32LE(offset + 20),
      localOffset: bytes.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

// Declared sizes can lie, so the inflated output is capped rather than trusted.
function readZipEntry(bytes: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  if ((entry.flags & 0x1) !== 0) {
    throw new Error("Encrypted documents are not supported.");
  }

  const local = entry.localOffset;

  if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) {
    throw new Error(`The zip entry "${entry.name}" is corrupt.`);
  }

  const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
  const data = bytes.subarray(start, start + entry.compressedSize);

  if (data.length !== entry.compressedSize) {
    throw new Error(`The zip entry "${entry.name}" is truncated.`);
  }

  const limitError = new RangeError(`"${entry.name}" expands past the ${maxBytes}-byte limit.`);

  if (entry.method === 0) {
    if (data.length > maxBytes) {
      throw limitError;
    }

    return data;
  }

  if (entry.method !== 8) {
    throw new Error(`The zip entry "${entry.name}" uses an unsupported compression method.`);
  }

  try {
    return inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw limitError;
    }

    throw error;
  }
}

interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const XML_ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const XML_ATTRIBUTE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decodeEntities(text: string): string {
  return text.replace(XML_ENTITY, (raw, entity: string) => {
    if (!entity.startsWith("#")) {
      return NAMED_ENTITIES[entity] ?? raw;
    }

    const codePoint =
      entity[1] === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);

    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : raw;
  });
}

const TEXT_ELEMENTS = new Set(["w:t"]);

/**
 * A minimal XML reader for WordprocessingML. It keeps character data only inside `w:t`, never
 * expands entity declarations, and rejects DOCTYPE, so external or recursive entities cannot apply.
 */
function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#root", attributes: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let index = 0;

  const skipPast = (marker: string, from: number) => {
    const end = xml.indexOf(marker, from);

    if (end === -1) {
      throw new Error("The document XML is malformed.");
    }

    return end + marker.length;
  };

  while (index < xml.length) {
    const open = xml.indexOf("<", index);
    const current = stack[stack.length - 1] as XmlElement;
    const textEnd = open === -1 ? xml.length : open;

    if (textEnd > index && TEXT_ELEMENTS.has(current.name)) {
      current.text += decodeEntities(xml.slice(index, textEnd));
    }

    if (open === -1) {
      break;
    }

    if (xml.startsWith("<!--", open)) {
      index = skipPast("-->", open + 4);
      continue;
    }

    if (xml.startsWith("<![CDATA[", open)) {
      const end = skipPast("]]>", open + 9);

      if (TEXT_ELEMENTS.has(current.name)) {
        current.text += xml.slice(open + 9, end - 3);
      }

      index = end;
      continue;
    }

    if (xml.startsWith("<?", open)) {
      index = skipPast("?>", open + 2);
      continue;
    }

    if (xml.startsWith("<!", open)) {
      throw new Error("Document type declarations are not supported.");
    }

    const close = skipPast(">", open + 1) - 1;
    const tag = xml.slice(open + 1, close);

    if (tag.startsWith("/")) {
      if (stack.length === 1 || current.name !== tag.slice(1).trim()) {
        throw new Error("The document XML is malformed.");
      }

      stack.pop();
    } else {
      const selfClosing = tag.endsWith("/");
      const body = selfClosing ? tag.slice(0, -1) : tag;
      const name = /^[^\s/>]+/.exec(body)?.[0];

      if (!name) {
        throw new Error("The document XML is malformed.");
      }

      const attributes: Record<string, string> = {};

      for (const match of body.slice(name.length).matchAll(XML_ATTRIBUTE)) {
        attributes[match[1] as string] = decodeEntities(match[2] ?? match[3] ?? "");
      }

      const element: XmlElement = { name, attributes, children: [], text: "" };

      current.children.push(element);

      if (!selfClosing) {
        if (stack.length > MAX_XML_DEPTH) {
          throw new RangeError("The document XML is nested too deeply.");
        }

        stack.push(element);
      }
    }

    index = close + 1;
  }

  if (stack.length !== 1) {
    throw new Error("The document XML is malformed.");
  }

  return root;
}

function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
  return element?.children.find((candidate) => candidate.name === name);
}

function isOn(element: XmlElement | undefined): boolean {
  const value = element?.attributes["w:val"];

  return element !== undefined && value !== "0" && value !== "false" && value !== "off";
}

const SKIPPED_INLINE = new Set([
  "w:pPr",
  "w:rPr",
  "w:sdtPr",
  "w:sdtEndPr",
  "w:del",
  "w:moveFrom",
  "w:delText",
  "w:instrText",
  "w:footnoteReference",
  "w:endnoteReference",
  "w:commentReference",
]);
const HEADING_STYLE = /^(heading\s?[1-9]|title)$/i;

class TextBuilder {
  text = "";
  private pageStart = 0;

  constructor(private readonly paged: boolean) {}

  append(value: string): void {
    this.text += value;
  }

  // Word often marks the same break twice (an explicit break and a rendered one), so a break
  // on a page that has no text yet is ignored.
  breakPage(): void {
    if (!this.paged) {
      this.text += "\n";

      return;
    }

    if (this.text.slice(this.pageStart).trim() === "") {
      return;
    }

    this.text += "\f";
    this.pageStart = this.text.length;
  }
}

interface WalkState {
  budget: CellBudget;
  dateOrder: DateOrder;
  tableNames: Set<string>;
  tables: { start: number; table: ExtractedTable }[];
  heading?: string;
}

function walkInline(element: XmlElement, out: TextBuilder, textBoxes: XmlElement[]): void {
  for (const node of element.children) {
    if (SKIPPED_INLINE.has(node.name)) {
      continue;
    }

    switch (node.name) {
      case "w:t":
        out.append(node.text);
        break;
      case "w:tab":
        out.append("\t");
        break;
      case "w:cr":
        out.append("\n");
        break;
      case "w:noBreakHyphen":
        out.append("-");
        break;
      case "w:br":
        if (node.attributes["w:type"] === "page") {
          out.breakPage();
        } else {
          out.append("\n");
        }

        break;
      case "w:lastRenderedPageBreak":
        out.breakPage();
        break;
      case "w:txbxContent":
        textBoxes.push(node);
        break;
      case "mc:AlternateContent": {
        // Choice and Fallback hold the same content; reading both would duplicate it.
        const choice = node.children.find((candidate) => candidate.name !== "mc:Fallback");

        if (choice) {
          walkInline(choice, out, textBoxes);
        }

        break;
      }

      default:
        walkInline(node, out, textBoxes);
    }
  }
}

function writeParagraph(paragraph: XmlElement, out: TextBuilder, state: WalkState | undefined) {
  const properties = child(paragraph, "w:pPr");

  if (isOn(child(properties, "w:pageBreakBefore"))) {
    out.breakPage();
  }

  const start = out.text.length;
  const textBoxes: XmlElement[] = [];

  walkInline(paragraph, out, textBoxes);

  const style = child(properties, "w:pStyle")?.attributes["w:val"] ?? "";
  const isHeading = HEADING_STYLE.test(style) || child(properties, "w:outlineLvl") !== undefined;
  const text = out.text.slice(start).replace(/\f/g, "").trim();

  if (state && isHeading && text) {
    state.heading = text;
  }

  out.append("\n");

  for (const textBox of textBoxes) {
    walkBlocks(textBox, out, state);
  }
}

function cellText(cell: XmlElement): string {
  const out = new TextBuilder(false);

  walkBlocks(cell, out, undefined);

  return out.text.replace(/\s+/g, " ").trim();
}

function rowCells(row: XmlElement): string[] {
  const cells: string[] = [];
  const gridBefore = Number(child(child(row, "w:trPr"), "w:gridBefore")?.attributes["w:val"]);

  for (let index = 0; index < Math.min(gridBefore || 0, MAX_GRID_SPAN); index += 1) {
    cells.push("");
  }

  const visit = (element: XmlElement) => {
    for (const node of element.children) {
      if (node.name === "w:tc") {
        const properties = child(node, "w:tcPr");
        const vMerge = child(properties, "w:vMerge");
        const continued = vMerge !== undefined && vMerge.attributes["w:val"] !== "restart";
        const span = Number(child(properties, "w:gridSpan")?.attributes["w:val"]);

        cells.push(continued ? "" : cellText(node));

        for (let extra = 1; extra < Math.min(span || 1, MAX_GRID_SPAN); extra += 1) {
          cells.push("");
        }
      } else if (
        node.name === "w:sdt" ||
        node.name === "w:sdtContent" ||
        node.name === "w:customXml"
      ) {
        visit(node);
      }
    }
  };

  visit(row);

  return cells;
}

function tableRows(table: XmlElement): string[][] {
  const rows: string[][] = [];

  const visit = (element: XmlElement) => {
    for (const node of element.children) {
      if (node.name === "w:tr") {
        rows.push(rowCells(node));
      } else if (
        node.name === "w:sdt" ||
        node.name === "w:sdtContent" ||
        node.name === "w:customXml"
      ) {
        visit(node);
      }
    }
  };

  visit(table);

  return rows;
}

function writeTable(element: XmlElement, out: TextBuilder, state: WalkState | undefined): void {
  const rows = tableRows(element);

  if (!state) {
    out.append(` ${rows.map((row) => row.join(" ")).join(" ")} `);

    return;
  }

  const start = out.text.length;

  for (const row of rows) {
    out.append(`${row.join("\t")}\n`);
  }

  // A one-row table is usually layout, such as a letterhead, rather than data.
  if (rows.length < 2) {
    return;
  }

  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);

  state.budget.spend(rows.length, width);

  const grid = rows.map((row) =>
    row.map((cell): RawCell => (cell === "" ? { kind: "empty" } : { kind: "text", text: cell })),
  );
  const name = uniqueName(state.heading ?? `Table ${state.tables.length + 1}`, state.tableNames);
  const table = buildTable(grid, { name, dateOrder: state.dateOrder });

  if (table) {
    state.tables.push({ start, table });
  }
}

function walkBlocks(element: XmlElement, out: TextBuilder, state: WalkState | undefined): void {
  for (const node of element.children) {
    switch (node.name) {
      case "w:p":
        writeParagraph(node, out, state);
        break;
      case "w:tbl":
        writeTable(node, out, state);
        break;
      case "w:sdt":
      case "w:sdtContent":
      case "w:customXml":
      case "w:ins":
      case "w:moveTo":
      case "w:txbxContent":
        walkBlocks(node, out, state);
        break;
      default:
        break;
    }
  }
}

function documentPartName(bytes: Buffer, entries: readonly ZipEntry[], maxBytes: number): string {
  const relationships = entries.find((entry) => entry.name === "_rels/.rels");

  if (!relationships) {
    return DEFAULT_DOCUMENT_PART;
  }

  const xml = readZipEntry(bytes, relationships, maxBytes).toString("utf8");
  const target = parseXml(xml)
    .children.flatMap((element) => element.children)
    .find((element) => OFFICE_DOCUMENT_RELATIONSHIP.test(element.attributes.Type ?? ""))
    ?.attributes.Target;

  return target ? target.replace(/^\//, "") : DEFAULT_DOCUMENT_PART;
}

/** Reads the main document text of a .docx as pages, plus its tables. */
export function parseDocx(
  buffer: Uint8Array,
  options: { dateOrder: DateOrder; maxChars?: number; maxPartBytes?: number },
): TextParseResult {
  const maxPartBytes = options.maxPartBytes ?? MAX_DOCX_PART_BYTES;
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const entries = readZipEntries(bytes);
  const partName = documentPartName(bytes, entries, maxPartBytes);
  const documentEntry = entries.find((entry) => entry.name === partName);

  if (!documentEntry) {
    throw new Error(`The file has no "${partName}" part.`);
  }

  const root = parseXml(readZipEntry(bytes, documentEntry, maxPartBytes).toString("utf8"));
  const body = child(child(root, "w:document"), "w:body");

  if (!body) {
    throw new Error("The file is not a Word document.");
  }

  const out = new TextBuilder(true);
  const state: WalkState = {
    budget: new CellBudget(),
    dateOrder: options.dateOrder,
    tableNames: new Set(),
    tables: [],
  };

  walkBlocks(body, out, state);

  const pages = paginateText(out.text, options.maxChars ?? DEFAULT_PAGE_CHARS);
  const warnings: string[] = [];

  if (out.text.trim() === "") {
    warnings.push("The file has no text.");
  }

  if (entries.some((entry) => HEADER_FOOTER_PART.test(entry.name))) {
    warnings.push("Headers and footers were not read.");
  }

  return {
    pages: pages.map((page) => page.text),
    tables: state.tables.map(({ start, table }) => ({
      ...table,
      pageIndex: pageIndexAt(pages, start),
    })),
    warnings,
  };
}
