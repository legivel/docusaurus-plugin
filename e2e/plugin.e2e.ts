/**
 * The end-to-end test: real Docusaurus builds of e2e/site with the plugin
 * compiled from src/, a real PDF from the legivel API, and checks on what
 * the PDF holds: cover, contents and page numbers, sidebar order, chapter
 * pages, bookmarks and their targets, links, the converted MDX, the attached
 * Markdown, the button, and that the key lands nowhere. A second, generated
 * site of five long chapters checks the Free sample when the key is on a
 * Free plan.
 *
 * Run: `LEGIVEL_API_URL=https://api.legivel.com LEGIVEL_API_KEY=… bun run test:e2e`,
 * or name a file that holds `LEGIVEL_API_KEY=…` with LEGIVEL_E2E_KEY_FILE.
 * LEGIVEL_API_URL is the API the key belongs to; it has no default, so a run
 * never reaches an API by chance. Without a key only the no-key build runs.
 * Every log and output lands in e2e/.out/, the key masked in the logs.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LONG_CHAPTERS, writeLongSite } from "./long-site.ts";
import { readPdf, type PdfFile, type PdfPage } from "./pdf.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITE = join(ROOT, "e2e/site");
const LONG_SITE = join(ROOT, "e2e/.generated/long");
const OUT = join(ROOT, "e2e/.out");
const DOCUSAURUS = join(ROOT, "node_modules/@docusaurus/core/bin/docusaurus.mjs");
const PLUGIN = join(ROOT, "dist/index.js");
const API_URL = process.env.LEGIVEL_API_URL || null;
/** The sites' configs stop without an API origin; a build without a key contacts no API, so it gets this one. */
const NO_API = "https://api.example.com";
/** A build that runs longer is stopped: the plugin's own retries end within about 5 minutes per render. */
const BUILD_TIMEOUT_MS = 8 * 60_000;

/** What e2e/site holds, in sidebar order; the PDF must show exactly this. */
const EXPECTED = {
  title: "Kestrel Field Manual",
  tagline: "How the field station runs, in one PDF.",
  /** Sidebar entries with their depth; categories without a page included. */
  entries: [
    ["Kestrel station overview", 0],
    ["Field work", 0],
    ["Run a survey", 1],
    ["Handle samples", 1],
    ["Reference", 0],
    ["Status codes", 1],
    ["Equipment", 1],
    ["Radio checks", 2],
  ] as [string, number][],
  /** Top-level entries: each starts a new page. */
  chapters: ["Kestrel station overview", "Field work", "Reference"],
  /** A draft and an unlisted page: never in the PDF. */
  absent: ["Retired draft procedure", "Unlisted calibration notes", "must never reach the PDF"],
};

function readKey(): string | null {
  if (process.env.LEGIVEL_API_KEY) return process.env.LEGIVEL_API_KEY;
  const file = process.env.LEGIVEL_E2E_KEY_FILE;
  if (!file) return null;
  const line = readFileSync(file.replace(/^~(?=\/)/, homedir()), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("LEGIVEL_API_KEY="));
  // An env file may quote the value: LEGIVEL_API_KEY="lgvl_…".
  return line?.slice("LEGIVEL_API_KEY=".length).trim().replace(/^(["'])(.*)\1$/, "$2") || null;
}

const KEY = readKey();
if (KEY && !API_URL) throw new Error("LEGIVEL_API_URL is not set: name the API origin the key belongs to.");
/** Shaped like a key, so the API, not the plugin, refuses it. */
const WRONG_KEY = `lgvl_e2e_${randomBytes(16).toString("hex")}`;

interface Build {
  code: number;
  log: string;
  out: string;
}

/** One `docusaurus build` with a fresh cache, the key (or none) in its environment only. */
function build(name: string, siteDir: string, key: string | null): Build {
  const out = join(OUT, name);
  rmSync(out, { recursive: true, force: true });
  rmSync(join(siteDir, ".docusaurus"), { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const env: Record<string, string | undefined> = { ...process.env, LEGIVEL_API_URL: API_URL ?? NO_API, NO_COLOR: "1", FORCE_COLOR: "0" };
  delete env.LEGIVEL_API_KEY;
  delete env.LEGIVEL_E2E_KEY_FILE;
  if (key) env.LEGIVEL_API_KEY = key;
  const run = spawnSync("node", [DOCUSAURUS, "build", "--out-dir", out], { cwd: siteDir, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: BUILD_TIMEOUT_MS });
  const stopped = run.error ? `\n[e2e] the build was stopped: ${run.error.message}\n` : "";
  const log = `${run.stdout ?? ""}${run.stderr ?? ""}${stopped}`;
  const masked = [KEY, WRONG_KEY].reduce<string>((text, k) => (k ? text.split(k).join("[key]") : text), log);
  writeFileSync(join(OUT, `${name}.log`), masked);
  return { code: run.status ?? -1, log, out };
}

/** Every file under a folder, PDFs included, searched for the key's bytes. */
function filesHolding(dir: string, needle: string): string[] {
  if (!existsSync(dir)) return [];
  const hits: string[] = [];
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, name);
    if (statSync(path).isFile() && readFileSync(path).includes(needle)) hits.push(path);
  }
  return hits;
}

/** Where a key's bytes are: only the names of the logs and files, never the text around them, so a failure does not print the key. */
function keyFoundIn(key: string, logs: Record<string, string>, dirs: string[]): string[] {
  const hits = Object.entries(logs).filter(([, text]) => text.includes(key)).map(([name]) => name);
  for (const dir of dirs) hits.push(...filesHolding(dir, key));
  return hits;
}

function pdfsIn(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).filter((name) => name.endsWith(".pdf"));
}

const LEADER = /\.{4,} ?\d+$/;

/** The contents: page 2, headed «Contents», and each page after it that holds
 *  only contents lines above its footer. */
function contentsPages(pdf: PdfFile): PdfPage[] {
  const pages = [pdf.pages[1]!];
  for (const page of pdf.pages.slice(2)) {
    const body = page.lines.slice(0, -1);
    if (body.length === 0 || !body.every((l) => LEADER.test(l))) break;
    pages.push(page);
  }
  return pages;
}

/** The page whose text has the line, first page after the cover and the contents. */
function headingAt(pdf: PdfFile, title: string): { page: number; line: number } | null {
  for (const page of pdf.pages.slice(1 + contentsPages(pdf).length)) {
    const line = page.lines.indexOf(title);
    if (line >= 0) return { page: page.number, line };
  }
  return null;
}

beforeAll(() => {
  const tsc = spawnSync("node", [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", join(ROOT, "tsconfig.json")], { encoding: "utf8" });
  if (tsc.status !== 0) throw new Error(`tsc failed:\n${tsc.stdout}${tsc.stderr}`);
});

describe("a build without a key", () => {
  let run: Build;
  beforeAll(() => {
    run = build("no-key", SITE, null);
  });

  test("passes, says why there is no PDF, and shows no button", () => {
    expect(run.code).toBe(0);
    expect(run.log).toContain("[legivel-pdf] no API key: the LEGIVEL_API_KEY environment variable is not set");
    expect(pdfsIn(run.out)).toEqual([]);
    expect(readFileSync(join(run.out, "index.html"), "utf8")).not.toContain("Download PDF");
  });
});

if (!KEY) console.log("[e2e] no LEGIVEL_API_KEY: only the no-key build runs.");

describe.skipIf(!KEY)(`a build against ${API_URL ?? "the API"}`, () => {
  let wrong: Build;
  let run: Build;
  let pdf: PdfFile;

  beforeAll(async () => {
    wrong = build("wrong-key", SITE, WRONG_KEY);
    run = build("site", SITE, KEY);
    if (run.code !== 0) throw new Error(`the site build failed (exit ${run.code}); log in e2e/.out/site.log`);
    pdf = await readPdf(join(run.out, "manual.pdf"));
  });

  test("a wrong key fails the build with the API's sentence, and the key is not in the log", () => {
    expect(wrong.code).not.toBe(0);
    expect(wrong.log).toContain("legivel answered 401");
    expect(wrong.log).toContain("The API key is missing or not valid.");
    expect(keyFoundIn(WRONG_KEY, { "the wrong-key build log": wrong.log }, [OUT])).toEqual([]);
    expect(existsSync(join(wrong.out, "manual.pdf"))).toBe(false);
  });

  test("the build passes and names the MDX component it left out, with its file", () => {
    expect(run.code).toBe(0);
    const line = run.log.split("\n").find((l) => l.includes("SampleGauge"));
    expect(line).toBeDefined();
    expect(line).toContain("field/samples.mdx");
  });

  test("the key is nowhere: not in the build logs, the saved logs, the build output or the plugin's cache", () => {
    expect(keyFoundIn(KEY!, { "the site build log": run.log, "the wrong-key build log": wrong.log }, [OUT, join(SITE, ".docusaurus")])).toEqual([]);
  });

  test("the PDF and its Markdown are in the build output; every page is A4", () => {
    expect(readFileSync(join(run.out, "manual.pdf")).subarray(0, 5).toString()).toBe("%PDF-");
    expect(existsSync(join(run.out, "manual.md"))).toBe(true);
    expect(pdf.pages.length).toBeGreaterThanOrEqual(5);
    for (const page of pdf.pages) {
      expect(Math.round(page.size.width)).toBe(595);
      expect(Math.round(page.size.height)).toBe(842);
    }
  });

  test("the cover is its own page: title and tagline, no page number", () => {
    const cover = pdf.pages[0]!;
    expect(cover.lines).toContain(EXPECTED.title);
    expect(cover.lines).toContain(EXPECTED.tagline);
    expect(cover.text).not.toMatch(/Page 1 of/);
    for (const [title] of EXPECTED.entries) expect(cover.lines).not.toContain(title);
  });

  test("every page after the cover carries «Page X of Y»", () => {
    const total = pdf.pages.length;
    for (const page of pdf.pages.slice(1)) expect(page.text).toContain(`Page ${page.number} of ${total}`);
  });

  test("the contents list every entry in sidebar order, with the page it really starts on", () => {
    const pages = contentsPages(pdf);
    expect(pages[0]!.lines[0]).toBe("Contents");
    const lines = pages.flatMap((p) => p.lines);
    let last = 0;
    for (const [title] of EXPECTED.entries) {
      const index = lines.findIndex((l) => l.startsWith(`${title} `) && LEADER.test(l));
      expect(index, `contents entry «${title}»`).toBeGreaterThan(last);
      last = index;
      const listed = Number(/(\d+)$/.exec(lines[index]!)![1]);
      expect(listed, `page of «${title}»`).toBe(headingAt(pdf, title)?.page ?? -1);
    }
  });

  test("the pages follow the sidebar; each top-level entry opens a page; drafts and unlisted pages stay out", () => {
    const places = EXPECTED.entries.map(([title]) => headingAt(pdf, title));
    places.forEach((place, i) => expect(place, `heading «${EXPECTED.entries[i]![0]}»`).not.toBeNull());
    for (let i = 1; i < places.length; i++) {
      const [a, b] = [places[i - 1]!, places[i]!];
      expect(b.page > a.page || (b.page === a.page && b.line > a.line), `«${EXPECTED.entries[i]![0]}» after «${EXPECTED.entries[i - 1]![0]}»`).toBe(true);
    }
    for (const title of EXPECTED.chapters) expect(headingAt(pdf, title)!.line, `«${title}» tops its page`).toBe(0);
    const all = pdf.pages.map((p) => p.text).join(" ");
    for (const text of EXPECTED.absent) expect(all).not.toContain(text);
  });

  test("the bookmarks mirror the sidebar tree, each opening the page its heading is on", () => {
    let from = 0;
    for (const [title, depth] of EXPECTED.entries) {
      const index = pdf.bookmarks.findIndex((b, i) => i >= from && b.title === title);
      expect(index, `bookmark «${title}»`).toBeGreaterThanOrEqual(from);
      expect(pdf.bookmarks[index]!.depth, `depth of «${title}»`).toBe(depth);
      expect(pdf.bookmarks[index]!.page, `page of bookmark «${title}»`).toBe(headingAt(pdf, title)?.page ?? -1);
      from = index + 1;
    }
    for (const text of EXPECTED.absent) expect(pdf.bookmarks.map((b) => b.title)).not.toContain(text);
  });

  test("a link to another doc leads to its page inside the PDF; a link to the web keeps its address", () => {
    const from = headingAt(pdf, "Run a survey")!.page;
    const to = headingAt(pdf, "Handle samples")!.page;
    const links = pdf.pages.slice(from - 1, to).flatMap((p) => p.links);
    expect(links).toContainEqual({ url: null, page: headingAt(pdf, "Status codes")!.page });
    expect(links.map((l) => l.url)).toContain("https://www.rfc-editor.org/rfc/rfc9110");
  });

  test("the MDX converts: every tab under its label, the admonition, the code title and code, the table, the image", () => {
    const from = headingAt(pdf, "Run a survey")!.page;
    const to = headingAt(pdf, "Handle samples")!.page;
    const survey = pdf.pages.slice(from - 1, to);
    const text = survey.map((p) => p.text).join(" ");
    // In this order: each tab's content under its own label, the admonition's title over its body.
    let last = -1;
    for (const piece of [
      "Summer route",
      "Start at the north gate and walk the ridge.",
      "Winter route",
      "Start at the boathouse and keep to the shore path.",
      "Check the radio",
      "Test the radio at the gate before you walk out.",
      "survey-start.sh",
    ]) {
      const at = text.indexOf(piece, last + 1);
      expect(at, `«${piece}» after the piece before it`).toBeGreaterThan(last);
      last = at;
    }
    expect(survey.flatMap((p) => p.lines)).toContain("kestrel-log start --transect north --interval 30s");
    expect(survey.some((p) => p.drawsImage)).toBe(true);
    // The table keeps its rows: each code and its meaning on one line, in order.
    const codes = pdf.pages[headingAt(pdf, "Status codes")!.page - 1]!.lines;
    const rows = ["Code Meaning", "K1 Logger started", "K7 Battery low"].map((row) => codes.indexOf(row));
    expect(rows.every((at) => at >= 0), `table rows in ${JSON.stringify(codes)}`).toBe(true);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
    const all = pdf.pages.map((p) => p.text).join(" ");
    expect(all).toContain("Keep samples below 4 degrees until they reach the lab.");
    expect(all).not.toContain("Gauge level");
  });

  test("the PDF carries its Markdown as document.md, the same as the file beside it, with the manual in it", () => {
    expect(Object.keys(pdf.attachments)).toContain("document.md");
    const markdown = pdf.attachments["document.md"]!;
    expect(markdown).toBe(readFileSync(join(run.out, "manual.md"), "utf8"));
    for (const text of [EXPECTED.title, "Run a survey", "Start at the north gate and walk the ridge."]) expect(markdown).toContain(text);
  });

  test("docs pages have the «Download PDF» button to the manual and the credit line", () => {
    const html = readFileSync(join(run.out, "field/survey/index.html"), "utf8");
    expect(html).toContain("Download PDF");
    expect(html).toMatch(/href="\/manual\.pdf"/);
    expect(html).toContain("PDF made with legivel");
  });
});

describe.skipIf(!KEY)("the Free sample", () => {
  let plan: string | null = null;
  let pagesMax = 20;
  let run: Build;
  let pdf: PdfFile;

  beforeAll(async () => {
    // The plugin's own usage call, compiled by the beforeAll above; null when the call failed.
    const { usage } = (await import(join(ROOT, "dist/render.js"))) as { usage: (key: string, apiUrl: string) => Promise<{ plan: string | null; pagesMax: number | null }> };
    const account = await usage(KEY!, API_URL!);
    plan = account.plan;
    pagesMax = account.pagesMax ?? pagesMax;
    if (plan !== "free") return;
    writeLongSite(LONG_SITE, PLUGIN);
    run = build("free-sample", LONG_SITE, KEY);
    if (run.code !== 0) throw new Error(`the Free sample build failed (exit ${run.code}); log in e2e/.out/free-sample.log`);
    pdf = await readPdf(join(run.out, "season.pdf"));
  });

  test("the key is on a Free plan", () => {
    expect(plan, `the key's plan (null: ${API_URL}/v1/usage did not answer)`).toBe("free");
  });

  test("a manual past the page limit becomes the first chapters that fit, with the note at its end and in the log", () => {
    if (plan !== "free") return;
    const logged = /Free plan: \S+ holds the first (\d+) of (\d+) chapters in (\d+) pages/.exec(run.log);
    expect(logged).not.toBeNull();
    const [kept, of, pages] = [Number(logged![1]), Number(logged![2]), Number(logged![3])];
    expect(of).toBe(LONG_CHAPTERS.length);
    expect(kept).toBeGreaterThanOrEqual(1);
    expect(kept).toBeLessThan(of);
    expect(pdf.pages.length).toBe(pages);
    expect(pdf.pages.length).toBeLessThanOrEqual(pagesMax);
    const end = pdf.pages.at(-1)!.text;
    expect(end).toContain("About this sample");
    expect(end).toContain(`the first ${kept} of ${of} chapters`);
    expect(end).toContain("The full manual needs a Starter plan");
    const top = pdf.bookmarks.filter((b) => b.depth === 0).map((b) => b.title);
    expect(top).toEqual(LONG_CHAPTERS.slice(0, kept).concat(top.includes("About this sample") ? ["About this sample"] : []));
  });

  test("the key is nowhere in the Free sample's log, output or cache", () => {
    if (plan !== "free") return;
    expect(keyFoundIn(KEY!, { "the Free sample build log": run.log }, [OUT, join(LONG_SITE, ".docusaurus")])).toEqual([]);
  });
});
