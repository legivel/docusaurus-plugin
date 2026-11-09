/**
 * Reads a PDF the way the end-to-end test checks it: the text of every page
 * as lines from top to bottom, the links with the page they lead to, the
 * bookmarks with their depth and target page, whether a page draws an image, and the
 * attached Markdown. No system tools, so the test runs the same in CI.
 */
import { readFileSync } from "node:fs";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfLink {
  /** An address outside the PDF. */
  url: string | null;
  /** The page a link inside the PDF leads to, from 1. */
  page: number | null;
}

export interface PdfPage {
  number: number;
  /** The page's text lines, top to bottom, each line's pieces left to right. */
  lines: string[];
  /** The lines joined, hyphenated line ends rejoined, spaces collapsed. */
  text: string;
  links: PdfLink[];
  drawsImage: boolean;
  size: { width: number; height: number };
}

export interface PdfFile {
  pages: PdfPage[];
  /** Every bookmark in order, with its depth (0 = top level) and the page it opens, from 1. */
  bookmarks: { title: string; depth: number; page: number | null }[];
  /** Attached files by name. */
  attachments: Record<string, string>;
}

type Item = { str: string; transform: number[] };
type OutlineNode = { title: string; dest?: unknown; items?: OutlineNode[] };

/** Ligatures and soft hyphens out, so a search finds the word as written. */
export function plain(text: string): string {
  return text.normalize("NFKC").replace(/­/g, "");
}

export async function readPdf(path: string): Promise<PdfFile> {
  const bytes = new Uint8Array(readFileSync(path));
  const loading = getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0 });
  const doc = await loading.promise;

  const pageOf = async (dest: unknown): Promise<number | null> => {
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : (dest as unknown[] | null);
    if (!explicit || explicit.length === 0) return null;
    const target = explicit[0];
    if (typeof target === "number") return target + 1;
    return (await doc.getPageIndex(target as { num: number; gen: number })) + 1;
  };

  const pages: PdfPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    // Pieces on the same baseline (within 2 pt) make one line.
    const rows: { y: number; items: Item[] }[] = [];
    for (const item of content.items as Item[]) {
      if (!("str" in item) || item.str.trim() === "") continue;
      const y = item.transform[5]!;
      const row = rows.find((r) => Math.abs(r.y - y) < 2);
      if (row) row.items.push(item);
      else rows.push({ y, items: [item] });
    }
    rows.sort((a, b) => b.y - a.y);
    const lines = rows.map((r) =>
      plain(r.items.sort((a, b) => a.transform[4]! - b.transform[4]!).map((i) => i.str).join(" "))
        .replace(/\s+/g, " ")
        .trim()
        // A hyphen the line break added can come as its own piece: «Up -» is «Up-».
        .replace(/(\w) -$/, "$1-"),
    );
    const text = lines.join("\n").replace(/(\w)-\n(\w)/g, "$1$2").replace(/\s+/g, " ");

    const links: PdfLink[] = [];
    for (const a of (await page.getAnnotations()) as { subtype: string; url?: string; dest?: unknown }[]) {
      if (a.subtype !== "Link") continue;
      links.push({ url: a.url ?? null, page: a.dest ? await pageOf(a.dest) : null });
    }
    const ops = await page.getOperatorList();
    const drawsImage = ops.fnArray.some((op: number) => op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject);
    const [x0, y0, x1, y1] = page.view as number[];
    pages.push({ number: n, lines, text, links, drawsImage, size: { width: x1! - x0!, height: y1! - y0! } });
  }

  const bookmarks: PdfFile["bookmarks"] = [];
  const walk = async (nodes: OutlineNode[] | null, depth: number) => {
    for (const node of nodes ?? []) {
      bookmarks.push({ title: plain(node.title).trim(), depth, page: node.dest ? await pageOf(node.dest) : null });
      await walk(node.items ?? null, depth + 1);
    }
  };
  await walk((await doc.getOutline()) as OutlineNode[] | null, 0);

  const attachments: Record<string, string> = {};
  for (const [id, file] of (await doc.getAttachments()) ?? []) {
    const content = file.content ?? (await doc.getAttachmentContent(id));
    if (content) attachments[file.filename] = new TextDecoder().decode(content);
  }

  await loading.destroy();
  return { pages, bookmarks, attachments };
}
