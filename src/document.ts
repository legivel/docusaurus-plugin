/**
 * One Markdown document from the outline: a cover on its own page, the
 * contents on the next, then the pages, each under a heading at the depth
 * the sidebar gives it, with its body's headings one level further down,
 * so the contents and the PDF bookmarks follow the sidebar tree. A category
 * without a page of its own is a heading too, with its generated index's
 * description when the site shows one. A new page starts before each
 * chapter (a top-level entry), or before every entry with
 * `pageBreaks: "pages"`; the marker is `\newpage` alone on its line.
 *
 * The sources are MDX files. What is Markdown stays as written; what is not
 * is turned into Markdown where it has a plain reading, or removed and
 * reported so the site author knows what the PDF leaves out:
 * - `import` and `export` lines are removed.
 * - `<Tabs>`: each tab's content stays, one after another, under its label.
 * - `:::note` and the other admonitions become a quoted block with the
 *   kind, or the title, as its first bold line.
 * - A code block's `title="…"` becomes a bold line above the block; the
 *   other meta words (`showLineNumbers`, `{1,3}`) go.
 * - Another component is removed with its content, and named with its file.
 * - An `<iframe>` (a sandbox, a video) cannot play on paper: it becomes one
 *   line, «Embedded content:» and a link to its address.
 * - Images with a path relative to the file, or a site path under static/,
 *   are embedded from disk; a site path not on disk is loaded from the site.
 * - A link to another doc becomes a link to that page inside the PDF, or to
 *   the page on the site when the export leaves it out.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve, sep } from "node:path";

import type { CollectedPage, DocLike, OutlineEntry } from "./collect.js";
import type { CoverOptions } from "./options.js";

export interface SiteLike {
  siteDir: string;
  url: string;
  baseUrl: string;
  title: string;
  tagline?: string;
}

export interface DocumentOptions {
  /** The bytes of images embedded from disk one document may carry; the rest are left out with a note. */
  imageBudget?: number;
  /** Leave embedded vector images (SVG) out, with their alt text. */
  noVectors?: boolean;
  cover: CoverOptions | null;
  language: string | null;
  /** A page break before each top-level entry, or before every entry. */
  pageBreaks: "chapters" | "pages";
  /** The version's label on the cover, when the site has versions. */
  versionLabel?: string | null;
}

export interface BuiltDocument {
  markdown: string;
  /** What the export left out or changed, one sentence each, for the build log. */
  notes: string[];
  /** The pages in the document, in order. */
  pages: { id: string; title: string }[];
}

/** A line that holds only this starts a new page. */
export const PAGE_BREAK = "\\newpage\n";

const FRONT_MATTER = /^---\r?\n(?:[\s\S]*?\r?\n)?---\r?\n?/;
/** An ESM import as MDX writes it: a source in quotes on the line, or a
 *  brace list that runs on to a `from` line. Prose that starts with the
 *  word («import duties apply») has no quoted source and stays. */
const IMPORT_START = /^import\s+(?:(?:[\w$*{},\s]+?\s+from\s+)?['"][^'"]+['"];?[ \t]*$|\{[^}]*$|[\w$]+\s*,\s*\{[^}]*$)/;
const IMPORT_END = /^[^\n]*from\s+['"][^'"]+['"];?[ \t]*$/;
/** An ESM export: the keyword and a declaration form. «export the data» is prose. */
const EXPORT_START = /^export\s+(?:const|let|var|function|class|async|default|\{|\*)\b/;
const JSX_OPEN = /^<([A-Z][A-Za-z0-9.]*)\b([^>]*)>/m;
const JSX_SELF = /^<[A-Z][A-Za-z0-9.]*[^>]*\/>[ \t]*$/gm;
const TABS = /^<Tabs\b[^>]*>([\s\S]*?)^<\/Tabs>[ \t]*$/gm;
const DETAILS_OPEN = /<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>/;
/** A JSX comment (the truncate marker and the like) prints nothing on the site. */
const JSX_COMMENT = /\{\/\*[\s\S]*?\*\/\}[ \t]*\n?/g;
/** `## Title {#custom-id}`: the id the site gives the heading. */
const CUSTOM_ID = /\s*\{#([^}\s]+)\}\s*$/;
/** `[ref]: ./file.png "title"`, a reference definition on its own line. */
const REF_DEF = /^(\[[^\]]+\]:[ \t]+)(<[^>]*>|\S+)([^\n]*)$/gm;
/** `<source srcset="a.png 1x, b.png 2x">`: every path in the list. */
const SRCSET = /(<source\b[^>]*\bsrcset=)(["'])([^"']+)\2/g;
/** `import Name from './file.mdx'`: a partial the page places with `<Name />`. */
const PARTIAL_IMPORT = /^import\s+([A-Z][A-Za-z0-9]*)\s+from\s+['"](\.{1,2}\/[^'"]+\.mdx?)['"];?[ \t]*$/gm;
const TAB_ITEM = /<TabItem\b([^>]*)>([\s\S]*?)<\/TabItem>/g;
/** `:::kind[Title] Title` … `:::`; a longer run of colons nests a shorter one. */
const ADMONITION = /^(:{3,})(\w+)(?:\[([^\]]*)\])?[ \t]*([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm;
const HEADING = /^(#{1,6})[ \t]+(.*)$/gm;
/** `![alt](target "title")`; a target in angle brackets may hold spaces. */
const IMAGE = /(!\[[^\]]*\]\()(<[^>]*>|[^)\s]+)(\s*(?:"[^"]*")?\))/g;
const IMG_TAG = /(<img\b[^>]*\bsrc=)(["'])([^"']+)\2/g;
/** A JSX-style attribute on an HTML tag: `src={'x'}`, `style={{…}}`, `width={200}`. */
/** The start of a JSX attribute on an HTML tag; its value is scanned to the brace that closes it. */
const JSX_ATTR_START = /(<[a-z][a-z0-9]*\b[^>]*?)\s([a-zA-Z-]+)=\{/g;
const EMPTY_IMG = /<img(?:\s[^>]*)?>/g;
/** An embedded frame: self-closed, or with whatever sits before its closing tag. */
const IFRAME = /<iframe\b([^>]*?)(?:\/>|>[\s\S]*?<\/iframe>|>)/gi;
/** A link that is not an image: `[text](target)`, the target without spaces. */
const LINK = /(^|[^!])(\[[^\]]*\]\()([^)\s]+)(\s*(?:"[^"]*")?\))/g;
/** A fenced block at any column, in a list item or a quote too; the closing
 *  marks may carry the same prefix. */
const FENCE = /^([ \t>]*)(```+|~~~+)([^\n]*)\n[\s\S]*?^[ \t>]*\2[ \t]*$/gm;
/** A code span: the same run of backticks on both sides, no newline inside. */
const INLINE_CODE = /(`+)(?!`)[^`\n]*?(?:[^`\n][^`\n]*?)?\1(?!`)/g;
const DOC_LINK = /#__doc:([^#\s)]+)(?:#([^\s)]+))?/g;
const HREF = /(<a\b[^>]*\bhref=")([^"]+)(")/g;

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".avif": "image/avif" };

/** Resolve the docs plugin's `@site/…` alias to a path on disk. */
export function sourcePath(source: string, siteDir: string): string {
  return source.startsWith("@site/") ? join(siteDir, source.slice("@site/".length)) : source;
}

/** The engine's heading id: GitHub style, ASCII letters and digits kept
 *  in lower case, spaces and hyphens as hyphens, the rest dropped; a
 *  repeat gets -1, -2, … in document order. */
export function slugify(title: string, counts: Map<string, number>): string {
  let base = "";
  for (const c of title) {
    if (/[A-Za-z0-9]/.test(c)) base += c.toLowerCase();
    else if (c === " ") base += "-";
    else if (c === "-" || c === "_") base += c;
  }
  const seen = counts.get(base);
  if (seen === undefined) {
    counts.set(base, 0);
    return base;
  }
  counts.set(base, seen + 1);
  return `${base}-${seen + 1}`;
}

/** The heading's id on the site (Docusaurus, GitHub style): inline marks
 *  dropped, a link's text kept, so a link written as `#part` is found. The
 *  engine's own id is made from the raw title instead (slugify). */
function headingText(raw: string): string {
  return raw
    .replace(/\s+#+\s*$/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Emphasis marks go; an underscore inside a word (my_option) is text and stays.
    .replace(/[*`]/g, "")
    .replace(/(^|\s)_+|_+(\s|$)/g, "$1$2")
    .trim();
}

/** Code is never rewritten: every fence (at any column, in a list, in a
 *  quote) and every code span is cut out before any pass runs and put back
 *  only at the very end, byte for byte. A pass that quotes a block line by
 *  line (an admonition) restores the code it holds, quotes it, and masks it
 *  again, so the later passes still see a placeholder. */
export interface Masker {
  mask(text: string): string;
  restore(text: string): string;
}

export function masker(): Masker {
  const store: string[] = [];
  const keep = (code: string) => {
    store.push(code);
    return `\u0000C${store.length - 1}\u0000`;
  };
  return {
    mask: (text) => text.replace(FENCE, keep).replace(INLINE_CODE, keep),
    restore: (text) => {
      let out = text;
      // A restored block may hold a placeholder of its own (a quoted fence
      // masked again), so restore until none is left.
      while (/\u0000C\d+\u0000/.test(out)) out = out.replace(/\u0000C(\d+)\u0000/g, (_, i) => store[Number(i)]!);
      return out;
    },
  };
}

/** `title="…"` on a fence becomes a bold line above it; the other meta
 *  words go, the language stays. */
function fenceTitles(text: string): string {
  return text.replace(FENCE, (fence, prefix: string, marks: string, info: string) => {
    const title = /\btitle=(?:"([^"]*)"|'([^']*)')/.exec(info);
    const lang = info.trim().split(/\s+/)[0] ?? "";
    const language = lang && !lang.includes("=") && !lang.startsWith("{") ? lang : "";
    const rest = fence.slice(prefix.length + marks.length + info.length);
    const cleaned = `${prefix}${marks}${language}${rest}`;
    const name = title?.[1] ?? title?.[2];
    if (!name) return cleaned;
    // Inside a quote the blank line between keeps the quote's prefix.
    const blank = prefix.includes(">") ? prefix.trimEnd() : "";
    return `${prefix}**${name}**\n${blank}\n${cleaned}`;
  });
}

interface Attrs {
  [key: string]: string;
}

function attrs(text: string): Attrs {
  const out: Attrs = {};
  for (const m of text.matchAll(/([A-Za-z][\w-]*)=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g)) out[m[1]!] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  return out;
}

/** Each tab's content stays, one tab after another, under its label. */
function tabs(text: string): string {
  return text.replace(TABS, (_, inner: string) => {
    const parts: string[] = [];
    for (const item of inner.matchAll(TAB_ITEM)) {
      const a = attrs(item[1]!);
      const label = a.label ?? a.value ?? "Tab";
      parts.push(`**${label}**\n\n${item[2]!.trim()}\n`);
    }
    return parts.join("\n");
  });
}

/** `:::kind[Title]` becomes a quoted block, its first line the title or
 *  the kind in bold; a fence inside is quoted line by line. */
function admonitions(text: string, code: Masker): string {
  return text.replace(ADMONITION, (_, _marks: string, kind: string, label: string | undefined, title: string, body: string) => {
    const head = (label ?? "").trim() || title.trim() || kind.charAt(0).toUpperCase() + kind.slice(1);
    // What sits inside is handled first: tabs, a nested admonition, details.
    const inner = details(tabs(admonitions(body, code)));
    const quoted = code
      .restore(inner)
      .trim()
      .split("\n")
      .map((line) => (line === "" ? ">" : `> ${line}`))
      .join("\n")
      // Two blank quoted lines in a row read as one.
      .replace(/(?:\n>){2,}\n/g, "\n>\n");
    return `> **${head}**\n>\n${code.mask(quoted)}\n`;
  });
}

/** `<details><summary>…</summary> body </details>` becomes the summary in
 *  bold and the body; the closing tag is found by count, so a details block
 *  inside another keeps its place, handled inside out. */
export function details(text: string): string {
  for (;;) {
    const open = DETAILS_OPEN.exec(text);
    if (!open) return text;
    const start = open.index;
    const afterSummary = start + open[0].length;
    const tag = /<(\/?)details\b[^>]*>/g;
    tag.lastIndex = afterSummary;
    let depth = 1;
    let end = -1;
    for (let m = tag.exec(text); m; m = tag.exec(text)) {
      depth += m[1] === "/" ? -1 : 1;
      if (depth === 0) {
        end = m.index;
        break;
      }
    }
    if (end < 0) return text;
    const close = /<\/details>[ \t]*/y;
    close.lastIndex = end;
    const closeLen = close.exec(text)?.[0].length ?? "</details>".length;
    const body = details(text.slice(afterSummary, end));
    text = `${text.slice(0, start)}**${open[1]!.trim()}**\n\n${body.trim()}\n${text.slice(end + closeLen)}`;
  }
}

/** A JSX attribute's value, from the brace after `=` to the one that
 *  closes it, braces and strings counted. */
function jsxValue(text: string, from: number): { value: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { value: text.slice(from + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** JSX attributes on an HTML tag, as MDX allows them: a quoted string or a
 *  template literal without `${` becomes a plain value, a number stays,
 *  `require('./x.png').default` becomes the path, an object or an
 *  expression goes with its attribute. */
export function plainAttributes(text: string, restore: (part: string) => string = (part) => part): string {
  let out = "";
  let rest = text;
  for (;;) {
    JSX_ATTR_START.lastIndex = 0;
    const m = JSX_ATTR_START.exec(rest);
    if (!m) return out + rest;
    const braceAt = m.index + m[0].length - 1;
    const scanned = jsxValue(rest, braceAt);
    if (!scanned) return out + rest;
    const head = m[1]!;
    const name = m[2]!;
    // A template literal was masked as a code span; the value is read whole.
    const value = restore(scanned.value).trim();
    const str = /^(['"])([^'"]*)\1$/.exec(value) ?? (/^`([^`]*)`$/.test(value) && !value.includes("${") ? [value, "`", value.slice(1, -1)] : null);
    const req = /^require\((['"])([^'"]+)\1\)(?:\.default)?$/.exec(value);
    let kept: string;
    if (str) kept = `${head} ${name}="${str[2]}"`;
    else if (req) kept = `${head} ${name}="${req[2]}"`;
    else if (/^\d+$/.test(value)) kept = `${head} ${name}="${value}"`;
    else kept = head;
    // The tag's head stays in `rest`, so its next JSX attribute is found too.
    out += rest.slice(0, m.index);
    rest = kept + rest.slice(scanned.end);
  }
}

/** ESM lines go, as the site's compiler drops them; a line of prose that
 *  starts with the word stays. A statement that runs on over several lines
 *  (a brace list of names, an exported array) goes whole. */
export function removeEsm(text: string, onRemove: (statement: string) => void): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let end = -1;
    if (IMPORT_START.test(line)) {
      end = i;
      if (!/['"][^'"]+['"];?[ \t]*$/.test(line)) {
        for (let j = i + 1; j < lines.length && j < i + 40; j++) if (IMPORT_END.test(lines[j]!)) { end = j; break; }
        if (end === i) end = -1;
      }
    } else if (EXPORT_START.test(line)) {
      end = i;
      if (!/[;}\]][ \t]*$/.test(line) || /[[{(][ \t]*$/.test(line)) {
        let depth = 0;
        for (let j = i; j < lines.length && j < i + 200; j++) {
          for (const c of lines[j]!) {
            if (c === "{" || c === "[" || c === "(") depth++;
            else if (c === "}" || c === "]" || c === ")") depth--;
          }
          if (depth <= 0 && j > i && /[;}\]][ \t]*$/.test(lines[j]!)) { end = j; break; }
          if (depth <= 0 && j > i && lines[j]!.trim() === "") { end = j - 1; break; }
          end = j;
        }
      }
    }
    if (end < 0) {
      out.push(line);
      continue;
    }
    onRemove(lines.slice(i, end + 1).join("\n"));
    i = end;
  }
  return out.join("\n");
}

/** A component with content, opened at the start of a line, is removed up to
 *  its own closing tag, counted so a nested use of the same name, or a second
 *  use further down, keeps the text between. An unbalanced block stays. */
export function removeJsxBlocks(text: string, onRemove: (name: string) => void): string {
  let out = "";
  let rest = text;
  for (;;) {
    const open = JSX_OPEN.exec(rest);
    if (!open) return out + rest;
    const [whole, name, attrsText] = open;
    const at = open.index;
    if (attrsText!.trimEnd().endsWith("/")) {
      out += rest.slice(0, at + whole.length);
      rest = rest.slice(at + whole.length);
      continue;
    }
    const tag = new RegExp("<(/?)" + name!.replace(/\./g, "\\.") + "\\b([^>]*)>", "g");
    tag.lastIndex = at + whole.length;
    let depth = 1;
    let closeEnd = -1;
    for (let m = tag.exec(rest); m; m = tag.exec(rest)) {
      if (m[1] === "/") depth--;
      else if (!m[2]!.trimEnd().endsWith("/")) depth++;
      if (depth === 0) {
        closeEnd = m.index + m[0].length;
        break;
      }
    }
    if (closeEnd < 0) {
      out += rest.slice(0, at + whole.length);
      rest = rest.slice(at + whole.length);
      continue;
    }
    onRemove(name!);
    const trailing = /^[ \t]*(?=\n|$)/.exec(rest.slice(closeEnd))?.[0] ?? "";
    out += rest.slice(0, at);
    rest = rest.slice(closeEnd + trailing.length);
  }
}

/** The file as a data URI, "budget" when it would pass the document's image
 *  budget, null when it is not an image on disk. */
/** True when `path` is under the site folder: symlinks followed where the
 *  file exists, the written path where it does not (a missing file fails
 *  at its read, with a note of its own). */
export function underSite(path: string, siteDir: string): boolean {
  const realOrWritten = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const real = realOrWritten(path);
  const root = realOrWritten(siteDir);
  return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The first bytes of the formats the plugin embeds; a file with another
 *  head is not an image, whatever its name. */
export function imageMime(bytes: Uint8Array, ext: string): string | null {
  const head = (...n: number[]) => n.every((b, i) => bytes[i] === b);
  const text = (len: number) => new TextDecoder("latin1").decode(bytes.subarray(0, len));
  if (head(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (head(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (head(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (text(4) === "RIFF" && text(12).slice(8) === "WEBP") return "image/webp";
  if (text(12).slice(4, 8) === "ftyp" && /avif|avis/.test(text(12).slice(8))) return "image/avif";
  if (ext === ".svg" && /^\s*(<\?xml|<!--|<svg)/i.test(new TextDecoder("utf8").decode(bytes.subarray(0, 512)))) return "image/svg+xml";
  return null;
}

function embed(path: string, images?: BodyContext["images"], siteDir?: string): string | null | "budget" | "vector" | "outside" | "not-image" {
  const ext = extname(path).toLowerCase();
  if (!MIME[ext] || !existsSync(path)) return null;
  if (siteDir !== undefined && !underSite(path, siteDir)) return "outside";
  const bytes = readFileSync(path);
  const mime = imageMime(bytes, ext);
  if (!mime) return "not-image";
  if (images?.noVectors && mime === "image/svg+xml") {
    images.vectorsOut = (images.vectorsOut ?? 0) + 1;
    return "vector";
  }
  if (images) {
    if (images.spent + bytes.length > images.budget) {
      images.leftOut++;
      return "budget";
    }
    images.spent += bytes.length;
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** The place of a file under the site, for the log. */
function fileLabel(page: CollectedPage, site: SiteLike): string {
  return relative(site.siteDir, sourcePath(page.doc.source, site.siteDir)) || page.doc.source;
}

export interface BodyContext {
  site: SiteLike;
  /** The image budget and what is spent of it, shared by the document's pages. */
  images?: { budget: number; spent: number; leftOut: number; noVectors?: boolean; vectorsOut?: number };
  /** Every doc of the version, to resolve links between docs. */
  docs: DocLike[];
  /** The ids of the pages in the export. */
  exported: Set<string>;
  notes: string[];
  read?: (path: string) => string;
  embedImage?: (path: string, images?: BodyContext["images"], siteDir?: string) => string | null | "budget" | "vector" | "outside" | "not-image";
}

/** A partial imported from a Markdown file next to the page and placed
 *  with `<Name />` is read and put in its place, its own front matter
 *  dropped, up to three levels deep. */
function partials(text: string, page: CollectedPage, ctx: BodyContext, depth: number): string {
  const from = dirname(sourcePath(page.doc.source, ctx.site.siteDir));
  const names = new Map<string, string>();
  let out = text.replace(PARTIAL_IMPORT, (_, name: string, file: string) => {
    names.set(name, resolve(from, file));
    return "";
  });
  for (const [name, path] of names) {
    const use = new RegExp("^<" + name + "\\s*/>[ \\t]*$", "gm");
    out = out.replace(use, () => {
      if (!underSite(path, ctx.site.siteDir)) {
        ctx.notes.push(`${page.doc.id} (${fileLabel(page, ctx.site)}): the partial ${relative(ctx.site.siteDir, path)} is outside the site folder; left out.`);
        return "";
      }
      try {
        const raw = (ctx.read ?? ((p: string) => readFileSync(p, "utf8")))(path).replace(/\r\n?/g, "\n").replace(FRONT_MATTER, "");
        const inner = { ...page, doc: { ...page.doc, source: path } };
        return depth < 3 ? partials(raw, inner, ctx, depth + 1).trim() : raw.trim();
      } catch {
        ctx.notes.push(`${page.doc.id} (${fileLabel(page, ctx.site)}): the partial ${relative(ctx.site.siteDir, path)} could not be read; left out.`);
        return "";
      }
    });
  }
  return out;
}

/** Where a link goes in the PDF: a same-page anchor and a page of the
 *  export become placeholders for the heading ids (resolved once the whole
 *  document stands); a page outside the export, a site path and a relative
 *  path become the full address on the site; a link to another website stays as written. */
export function linkTarget(target: string, page: CollectedPage, ctx: BodyContext): string {
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return target;
  if (target.startsWith("#")) return `#__doc:${page.doc.id}${target}`;
  const hashAt = target.indexOf("#");
  const hash = hashAt >= 0 ? target.slice(hashAt) : "";
  const doc = linkedDoc(target, page, ctx);
  if (doc && ctx.exported.has(doc.id)) return `#__doc:${doc.id}${hash}`;
  // A permalink already carries the site's baseUrl; an address the author
  // wrote may or may not, so it is joined only when it does not.
  const onSite = (sitePath: string) => `${ctx.site.url}${sitePath}${hash}`;
  const withBase = (path: string) => (ctx.site.baseUrl !== "/" && path.startsWith(ctx.site.baseUrl) ? path : posix.join(ctx.site.baseUrl, path));
  if (doc) return onSite(doc.permalink);
  const path = (hashAt >= 0 ? target.slice(0, hashAt) : target).split("?")[0]!;
  if (path.startsWith("/")) return onSite(withBase(path));
  // A relative path: from the page's own address, the extension of a source file dropped.
  const dir = posix.dirname(page.doc.permalink.replace(/\/+$/, "") || "/");
  return onSite(posix.resolve(dir, path.replace(/\.mdx?$/, "")));
}

/** A doc the link points at: by site path (the permalink), or by file
 *  path relative to the source. */
function linkedDoc(target: string, page: CollectedPage, ctx: BodyContext): DocLike | undefined {
  const [path] = target.split("#") as [string];
  if (path === "") return undefined;
  if (path.startsWith("/")) {
    // A permalink carries the baseUrl; a link the author wrote may carry it
    // (as Docusaurus docs do) or not, so both spellings reach the doc.
    const norm = (p: string) => p.replace(/\/+$/, "") || "/";
    const spellings = new Set([norm(path), norm(posix.join(ctx.site.baseUrl, path))]);
    return ctx.docs.find((doc) => spellings.has(norm(doc.permalink)));
  }
  if (/^[a-z]+:/i.test(path)) return undefined;
  const from = dirname(sourcePath(page.doc.source, ctx.site.siteDir));
  const absolute = resolve(from, path);
  // The extension is not part of the match: a link written as .mdx reaches
  // the .md file the site resolves it to, and the other way round.
  const stem = absolute.replace(/\.mdx?$/, "");
  const candidates = [stem, join(stem, "index")];
  return ctx.docs.find((doc) => candidates.includes(resolve(sourcePath(doc.source, ctx.site.siteDir)).replace(/\.mdx?$/, "")));
}

/** A page's body: front matter, imports and components handled; headings
 *  moved down to sit under the page's own heading; images embedded or
 *  made absolute; links between docs turned into placeholders the whole
 *  document resolves once its headings are known. */
export function pageBody(raw: string, page: CollectedPage, ctx: BodyContext, level: number): string {
  const file = fileLabel(page, ctx.site);
  const notes = ctx.notes;
  let text = raw.replace(/\r\n?/g, "\n").replace(FRONT_MATTER, "");
  // Code first: nothing below sees a fence or a code span. A partial's code
  // is masked once the partial is in place.
  const code = masker();
  text = code.mask(fenceTitles(text));
  text = code.mask(partials(text, page, ctx, 0));
  text = ((part: string) => {
    part = part.replace(JSX_COMMENT, "");
    part = details(part);
    part = removeEsm(part, () => {
      notes.push(`${page.doc.id} (${file}): an import or export line was removed.`);
    });
    // MDX lets an HTML tag carry JSX attributes: a quoted value becomes a
    // plain one, a number stays, an object or an expression goes.
    part = plainAttributes(part, code.restore);
    // A removed attribute may leave a blank line inside the tag.
    let tidy = true;
    while (tidy) {
      tidy = false;
      part = part.replace(/(<[a-z][a-z0-9]*\b[^>]*?)\n[ \t]*\n(?=[^>]*>)/g, (_, head: string) => {
        tidy = true;
        return `${head}\n`;
      });
    }
    // An embedded frame would draw an empty box: a link line takes its place,
    // named by its title or the address's host. A site path goes through
    // the link pass below like any other link.
    part = part.replace(IFRAME, (_, tagAttrs: string) => {
      const src = /(?:^|[\s"'])src=(["'])([^"']+)\1/.exec(tagAttrs)?.[2];
      if (!src) {
        notes.push(`${page.doc.id} (${file}): an <iframe> without an address was left out.`);
        return "";
      }
      const href = src.startsWith("//") ? `https:${src}` : src;
      const title = /(?:^|[\s"'])title=(["'])([^"']*)\1/.exec(tagAttrs)?.[2]?.trim();
      const host = /^https?:\/\/([^/?#]+)/i.exec(href)?.[1];
      notes.push(`${page.doc.id} (${file}): an <iframe> became a link to ${href}.`);
      const label = (title || host || href).replace(/[[\]]/g, "\\$&");
      return `Embedded content: [${label}](${href})`;
    });
    /** One image address, wherever it is written: embedded from disk when
     *  it is a file under the site, made absolute when it is a site path,
     *  left out with a note otherwise. `null` means: leave the element out. */
    const imageSource = (src: string): string | null => {
      if (/^(https?:)?\/\//.test(src) || src.startsWith("data:")) return src;
      const embedImage = ctx.embedImage ?? embed;
      const path = src.startsWith("/") ? join(ctx.site.siteDir, "static", src) : resolve(dirname(sourcePath(page.doc.source, ctx.site.siteDir)), src);
      const onDisk = embedImage(path, ctx.images, ctx.site.siteDir);
      if (onDisk === "budget") {
        notes.push(`${page.doc.id} (${file}): the image ${src} is left out; the document's images would pass the plan's limit.`);
        return null;
      }
      if (onDisk === "vector") return null;
      if (onDisk === "outside") {
        notes.push(`${page.doc.id} (${file}): the image ${src} is outside the site folder; the PDF leaves it out.`);
        return null;
      }
      if (onDisk === "not-image") {
        notes.push(`${page.doc.id} (${file}): the file ${src} is not an image; the PDF leaves it out.`);
        return null;
      }
      if (onDisk) return onDisk;
      if (src.startsWith("/")) return `${ctx.site.url}${posix.join(ctx.site.baseUrl, src)}`;
      notes.push(`${page.doc.id} (${file}): the image ${src} was not found next to the file; the PDF leaves it out.`);
      return null;
    };
    const unwrap = (target: string) => (target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target);
    // <img src="…"> in the MDX: the same places as a Markdown image.
    part = part.replace(IMG_TAG, (whole, before: string, quote: string, src: string) => {
      // An image left out gets an empty source; the empty-tag pass below drops the tag.
      const out = imageSource(src);
      return out === null ? `${before}${quote}${quote}` : out === src ? whole : `${before}${quote}${out}${quote}`;
    });
    // <source srcset="a.png 1x, b.png 2x">: each candidate's path.
    part = part.replace(SRCSET, (whole, before: string, quote: string, list: string) => {
      const candidates = list.split(",").map((c) => c.trim()).filter(Boolean);
      const out: string[] = [];
      for (const candidate of candidates) {
        const [src, ...descriptor] = candidate.split(/\s+/) as [string, ...string[]];
        const resolved = imageSource(src);
        if (resolved !== null) out.push([resolved, ...descriptor].join(" "));
      }
      return out.length === 0 ? "" : `${before}${quote}${out.join(", ")}${quote}`;
    });
    // [ref]: ./file.png, a reference used by ![alt][ref] or [text][ref].
    part = part.replace(REF_DEF, (whole, before: string, target: string, after: string) => {
      const bare = unwrap(target);
      if (MIME[extname(bare.split("#")[0]!.split("?")[0]!).toLowerCase()]) {
        const out = imageSource(bare);
        return out === null ? "" : `${before}${out}${after}`;
      }
      return `${before}${linkTarget(bare, page, ctx)}${after}`;
    });
    // An <img> without a source draws nothing and would be refused.
    part = part.replace(EMPTY_IMG, (tag) => (/\bsrc=["'][^"']+["']/.test(tag) ? tag : ""));
    part = admonitions(part, code);
    part = tabs(part);
    part = removeJsxBlocks(part, (name) => {
      notes.push(`${page.doc.id} (${file}): a <${name}> component was left out; the PDF has no equivalent.`);
    });
    part = part.replace(JSX_SELF, (block) => {
      notes.push(`${page.doc.id} (${file}): a component was left out: ${block.trim().slice(0, 40)}…`);
      return "";
    });
    // The page's title is the heading the document writes above the body,
    // as it is the page's h1 on the site. A body that opens with its own
    // `#` repeats the title, so that line goes. The other headings sit
    // under the page's heading: a body `##` is one level below the page.
    part = part.replace(/^\s*#[ \t]+[^\n]*\n+/, "");
    let flattened = 0;
    part = part.replace(HEADING, (_, hashes: string, title: string) => {
      const own = hashes.length;
      const wanted = level + Math.max(1, own - 1);
      const target = Math.min(6, wanted);
      if (wanted > 6) flattened++;
      // `{#custom-id}` is the site's id for the heading; the engine prints
      // it, so it goes, and the id is kept for links (customIds).
      const custom = CUSTOM_ID.exec(title);
      const text = custom ? title.replace(CUSTOM_ID, "") : title;
      return `${"#".repeat(target)} ${text}${custom ? ` <!-- #${custom[1]} -->` : ""}`;
    });
    if (flattened > 0) notes.push(`${page.doc.id} (${file}): ${flattened} heading${flattened === 1 ? "" : "s"} deeper than the PDF's six levels sit at level six.`);
    part = part.replace(IMAGE, (whole, open: string, target: string, close: string) => {
      const src = unwrap(target);
      const alt = /^!\[([^\]]*)\]/.exec(open)?.[1] ?? "";
      const out = imageSource(src);
      if (out === null) return alt ? `*${alt}*` : "";
      return out === src ? whole : `${open}${out}${close}`;
    });
    // Every link a reader could follow on the site is one in the PDF: a page
    // of the export by its heading, anything else by its full address.
    part = part.replace(LINK, (whole, before: string, open: string, target: string, close: string) => `${before}${open}${linkTarget(target, page, ctx)}${close}`);
    part = part.replace(HREF, (_, before: string, target: string, after: string) => `${before}${linkTarget(target, page, ctx)}${after}`);
    return part;
  })(text);
  return code.restore(text.replace(/\n{3,}/g, "\n\n").trim());
}

function coverBlock(cover: CoverOptions, site: SiteLike, versionLabel: string | null | undefined, date: Date): string {
  const title = cover.title ?? site.title;
  const subtitle = cover.subtitle ?? site.tagline ?? "";
  const when = date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const lines = [`<div class="cover" style="${COVER.block}"><p class="cover-title" style="${COVER.title}">${escapeHtml(title)}</p>`];
  if (subtitle) lines.push(`<p class="cover-subtitle" style="${COVER.subtitle}">${escapeHtml(subtitle)}</p>`);
  if (versionLabel) lines.push(`<p class="cover-line" style="${COVER.line}">Version ${escapeHtml(versionLabel)}</p>`);
  lines.push(`<p class="cover-line" style="${COVER.line}">${escapeHtml(site.url + site.baseUrl)}</p>`, `<p class="cover-date" style="${COVER.line}">${escapeHtml(when)}</p>`, "</div>");
  return `${lines.join("\n")}\n`;
}

/** The cover's date line, the one part of a document that changes with the
 *  day; a change-detected build leaves it out of its fingerprint. */
export const COVER_DATE_LINE = /<p class="cover-date"[^\n]*\n?/;

/** The cover and the contents heading are HTML, not Markdown headings, so
 *  the contents list and the bookmarks hold the pages only. The styles are
 *  inline: the engine reads an element's own style, not a style sheet. */
const COVER = {
  block: "padding-top: 30%;",
  title: "font-size: 2.4em; font-weight: 700; line-height: 1.15; margin: 0 0 0.5em;",
  subtitle: "font-size: 1.25em; margin: 0 0 1.5em;",
  line: "margin: 0 0 0.3em;",
};
const CONTENTS_HEADING = `<p style="font-size: 1.6em; font-weight: 700; margin: 0 0 0.8em;">Contents</p>`;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Once the whole document stands, every heading gets the id the engine
 *  will give it, in order, and each `#__doc:` placeholder becomes the id of
 *  its page's heading, or of the heading the link's own `#part` names on
 *  that page. */
export function resolveDocLinks(markdown: string, pageSlugs: Map<string, { title: string; headings: Map<string, string> }>): string {
  return markdown.replace(DOC_LINK, (whole, id: string, hash: string | undefined) => {
    const page = pageSlugs.get(id);
    if (!page) return whole;
    if (hash) {
      const inner = page.headings.get(hash.toLowerCase());
      if (inner) return `#${inner}`;
      // A part the page has no heading for (an id written by hand): the page's top.
    }
    return `#${page.title}`;
  });
}

/** The headings of the document in order, with their ids, grouped by page. */
function headingIds(parts: { id: string | null; markdown: string }[]): Map<string, { title: string; headings: Map<string, string> }> {
  const counts = new Map<string, number>();
  const out = new Map<string, { title: string; headings: Map<string, string> }>();
  for (const part of parts) {
    const masked = part.markdown.replace(FENCE, "");
    let first = true;
    const entry = { title: "", headings: new Map<string, string>() };
    for (const m of masked.matchAll(HEADING)) {
      const custom = /\s*<!-- #([^\s>]+) -->\s*$/.exec(m[2]!);
      const raw = custom ? m[2]!.replace(/\s*<!-- #[^\s>]+ -->\s*$/, "") : m[2]!;
      // The engine makes the id from the raw title, inline marks and a
      // link's address included; the site makes its own
      // from the text, which is what a link written as `#part` names.
      const slug = slugify(raw, counts);
      if (first) {
        entry.title = slug;
        first = false;
      } else {
        const own = slugify(headingText(raw), new Map());
        if (!entry.headings.has(own)) entry.headings.set(own, slug);
        if (custom && !entry.headings.has(custom[1]!.toLowerCase())) entry.headings.set(custom[1]!.toLowerCase(), slug);
      }
    }
    if (part.id) out.set(part.id, entry);
  }
  return out;
}

export function buildDocument(
  entries: OutlineEntry[],
  site: SiteLike,
  options: DocumentOptions,
  now = new Date(),
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
  docs: DocLike[] = entries.filter((e): e is CollectedPage => e.kind === "page").map((e) => e.doc),
  embedImage?: (path: string) => string | null,
): BuiltDocument {
  const notes: string[] = [];
  const parts: { id: string | null; markdown: string }[] = [];
  const title = options.cover?.title ?? site.title;
  const exported = new Set(entries.filter((e): e is CollectedPage => e.kind === "page").map((e) => e.doc.id));
  const images: BodyContext["images"] = options.imageBudget !== undefined ? { budget: options.imageBudget, spent: 0, leftOut: 0, noVectors: options.noVectors, vectorsOut: 0 } : undefined;
  const ctx: BodyContext = { site, docs, exported, notes, read, embedImage, images };

  const front: string[] = [`title: ${JSON.stringify(title)}`];
  if (options.language) front.push(`language: ${options.language}`);
  parts.push({ id: null, markdown: `---\n${front.join("\n")}\n---\n` });

  if (options.cover) parts.push({ id: null, markdown: coverBlock(options.cover, site, options.versionLabel, now) }, { id: null, markdown: PAGE_BREAK });
  parts.push({ id: null, markdown: `${CONTENTS_HEADING}\n\n[TOC]\n` });

  const included: { id: string; title: string }[] = [];
  let first = true;
  for (const entry of entries) {
    const level = Math.min(5, entry.depth + 1);
    const breakHere = options.pageBreaks === "pages" || entry.depth === 0 || first;
    first = false;
    if (entry.kind === "category") {
      const body = entry.description ? `\n${entry.description}\n` : "";
      parts.push({ id: null, markdown: `${breakHere ? `${PAGE_BREAK}\n` : ""}${"#".repeat(level)} ${entry.title}\n${body}` });
      continue;
    }
    const path = sourcePath(entry.doc.source, site.siteDir);
    let raw: string;
    try {
      raw = read(path);
    } catch {
      notes.push(`${entry.doc.id} (${fileLabel(entry, site)}): the source file could not be read; the page is left out.`);
      continue;
    }
    const body = pageBody(raw, entry, ctx, level);
    parts.push({ id: entry.doc.id, markdown: `${breakHere ? `${PAGE_BREAK}\n` : ""}${"#".repeat(level)} ${entry.doc.title}\n\n${body}\n` });
    included.push({ id: entry.doc.id, title: entry.doc.title });
  }

  if (images?.vectorsOut) notes.push(`${images.vectorsOut} vector image${images.vectorsOut === 1 ? "" : "s"} left out, as asked.`);
  if (images && images.leftOut > 0) {
    notes.push(`${images.leftOut} image${images.leftOut === 1 ? "" : "s"} left out: the plan allows ${(images.budget / 1048576).toFixed(0)} MB of images per document and ${(images.spent / 1048576).toFixed(1)} MB are embedded. Smaller images, or a plan with a higher limit, bring them back.`);
  }
  // The custom-id markers served headingIds; the engine must not see them.
  const markdown = resolveDocLinks(parts.map((p) => p.markdown).join("\n"), headingIds(parts)).replace(/ <!-- #[^\s>]+ -->/g, "");
  return { markdown, notes, pages: included };
}
