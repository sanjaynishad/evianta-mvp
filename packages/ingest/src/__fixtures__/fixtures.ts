import { crc32, deflateRawSync, deflateSync } from "node:zlib";

import type { DocumentMetadata } from "@evianta/core";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { utils, write } from "xlsx";

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, checksum]);
}

/** A small grayscale PNG with a dark band, standing in for a scanned page. */
export function createPng(width = 16, height = 16): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const rows = Buffer.alloc((width + 1) * height, 0xff);

  for (let row = 0; row < height; row += 1) {
    rows[row * (width + 1)] = 0;

    if (row === Math.floor(height / 2)) {
      rows.fill(0x20, row * (width + 1) + 1, (row + 1) * (width + 1));
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export type FixturePage = { text: string[] } | { image: true };

/** Builds a PDF where text pages have a real text layer and image pages have none. */
export async function createPdfAsync(pages: readonly FixturePage[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const png = await pdf.embedPng(createPng());

  for (const fixturePage of pages) {
    const page = pdf.addPage([612, 792]);

    if ("image" in fixturePage) {
      page.drawImage(png, { x: 0, y: 0, width: 612, height: 792 });
      continue;
    }

    fixturePage.text.forEach((line, index) => {
      page.drawText(line, { x: 72, y: 720 - index * 20, size: 12, font });
    });
  }

  return Buffer.from(await pdf.save());
}

export interface SheetFixture {
  name: string;
  rows: unknown[][];
  /** Top-left cell of the data, for example "B3". */
  origin?: string;
  dateCells?: Record<string, number>;
}

/** Writes an xlsx workbook; `dateCells` maps addresses to Excel serial dates. */
export function createWorkbook(
  sheets: readonly SheetFixture[],
  bookType: "xlsx" | "xls" = "xlsx",
): Buffer {
  const workbook = utils.book_new();

  for (const sheet of sheets) {
    const worksheet = utils.aoa_to_sheet(sheet.rows, { origin: sheet.origin ?? "A1" });

    for (const [address, serial] of Object.entries(sheet.dateCells ?? {})) {
      worksheet[address] = { t: "n", v: serial, z: "yyyy-mm-dd" };
    }

    utils.book_append_sheet(workbook, worksheet, sheet.name);
  }

  return write(workbook, { type: "buffer", bookType }) as Buffer;
}

export interface ZipFixtureEntry {
  name: string;
  data: string | Buffer;
  /** Store without compression instead of deflating. */
  store?: boolean;
}

/** Writes a minimal zip archive with stored or deflated entries. */
export function createZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const body = entry.store ? raw : deflateRawSync(raw);
    const name = Buffer.from(entry.name, "utf8");
    const method = entry.store ? 0 : 8;
    const checksum = crc32(raw);
    const local = Buffer.alloc(30);
    const central = Buffer.alloc(46);

    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, name, body);
    centralParts.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, directory, end]);
}

const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const OFFICE_DOCUMENT_RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

export function wordDocumentXml(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`;
}

/** A .docx package whose main document body is `bodyXml`. */
export function createDocx(bodyXml: string, extraEntries: readonly ZipFixtureEntry[] = []): Buffer {
  return createZip([
    {
      name: "[Content_Types].xml",
      data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    { name: "_rels/.rels", data: OFFICE_DOCUMENT_RELATIONSHIPS },
    { name: "word/document.xml", data: wordDocumentXml(bodyXml) },
    ...extraEntries,
  ]);
}

export function documentMetadata(
  overrides: Partial<DocumentMetadata> & Pick<DocumentMetadata, "name" | "mimeType">,
): DocumentMetadata {
  return {
    id: "doc-1",
    caseId: "case-1",
    size: 0,
    gcsPath: "memory://evianta-documents/unused",
    uploadedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
