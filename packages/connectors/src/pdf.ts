import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export interface PdfColumn {
  /** Left edge for left-aligned cells, right edge for right-aligned cells. */
  x: number;
  align?: "left" | "right";
}

export type PdfBlock =
  | { kind: "text"; text: string; size?: number; bold?: boolean; indent?: number }
  | {
      kind: "row";
      cells: readonly string[];
      columns: readonly PdfColumn[];
      size?: number;
      bold?: boolean;
    }
  | { kind: "rule" }
  | { kind: "space"; height?: number };

export interface PdfDocumentSpec {
  title: string;
  author: string;
  subject: string;
  /** ISO date stamped as the creation date, so the bytes never depend on the clock. */
  createdOn: string;
  /** Each entry starts a new page; long pages continue on further pages. */
  pages: readonly (readonly PdfBlock[])[];
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN_X = 48;
const TOP_Y = 790;
const BOTTOM_Y = 72;
const DEFAULT_SIZE = 10;
const SYNTHETIC_FOOTER = "Synthetic sample for demonstration only. Not an official document.";

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

interface DrawText {
  text: string;
  x: number;
  y: number;
  size: number;
  bold: boolean;
}

interface LaidOutPage {
  texts: DrawText[];
  rules: number[];
}

export const pdfColumns = {
  pageLeft: MARGIN_X,
  pageRight: PAGE_WIDTH - MARGIN_X,
} as const;

function lineHeight(size: number): number {
  return Math.round(size * 1.5);
}

function blockHeight(block: PdfBlock): number {
  switch (block.kind) {
    case "text":
    case "row":
      return lineHeight(block.size ?? DEFAULT_SIZE);
    case "rule":
      return 8;
    case "space":
      return block.height ?? 8;
  }
}

function layout(spec: PdfDocumentSpec, fonts: Fonts): LaidOutPage[] {
  const pages: LaidOutPage[] = [];

  for (const blocks of spec.pages) {
    let page: LaidOutPage = { texts: [], rules: [] };
    let y = TOP_Y;

    pages.push(page);

    for (const block of blocks) {
      const height = blockHeight(block);

      if (y - height < BOTTOM_Y) {
        page = { texts: [], rules: [] };
        pages.push(page);
        y = TOP_Y;
      }

      y -= height;

      if (block.kind === "text") {
        page.texts.push({
          text: block.text,
          x: MARGIN_X + (block.indent ?? 0),
          y,
          size: block.size ?? DEFAULT_SIZE,
          bold: block.bold ?? false,
        });
      } else if (block.kind === "row") {
        const size = block.size ?? DEFAULT_SIZE;
        const bold = block.bold ?? false;
        const font = bold ? fonts.bold : fonts.regular;

        block.cells.forEach((text, index) => {
          const column = block.columns[index];

          if (!column || text.length === 0) {
            return;
          }

          const x =
            column.align === "right" ? column.x - font.widthOfTextAtSize(text, size) : column.x;

          page.texts.push({ text, x, y, size, bold });
        });
      } else if (block.kind === "rule") {
        page.rules.push(y + 4);
      }
    }
  }

  return pages;
}

function drawFooter(page: PDFPage, fonts: Fonts, pageNumber: number, pageCount: number): void {
  const size = 7.5;
  const pageLabel = `Page ${pageNumber} of ${pageCount}`;

  page.drawText(SYNTHETIC_FOOTER, { x: MARGIN_X, y: 40, size, font: fonts.regular });
  page.drawText(pageLabel, {
    x: PAGE_WIDTH - MARGIN_X - fonts.regular.widthOfTextAtSize(pageLabel, size),
    y: 40,
    size,
    font: fonts.regular,
  });
}

/** A text PDF drawn with Helvetica, so every page has a real text layer. Deterministic bytes. */
export async function createTextPdfAsync(spec: PdfDocumentSpec): Promise<Buffer> {
  const createdOn = new Date(`${spec.createdOn}T00:00:00.000Z`);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };

  pdf.setTitle(spec.title);
  pdf.setAuthor(spec.author);
  pdf.setSubject(spec.subject);
  pdf.setCreator("Evianta demo connectors");
  pdf.setProducer("pdf-lib");
  pdf.setCreationDate(createdOn);
  pdf.setModificationDate(createdOn);

  const laidOut = layout(spec, fonts);

  laidOut.forEach((laidOutPage, index) => {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

    for (const text of laidOutPage.texts) {
      page.drawText(text.text, {
        x: text.x,
        y: text.y,
        size: text.size,
        font: text.bold ? fonts.bold : fonts.regular,
      });
    }

    for (const y of laidOutPage.rules) {
      page.drawLine({
        start: { x: MARGIN_X, y },
        end: { x: PAGE_WIDTH - MARGIN_X, y },
        thickness: 0.5,
        color: rgb(0.4, 0.4, 0.4),
      });
    }

    drawFooter(page, fonts, index + 1, laidOut.length);
  });

  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
