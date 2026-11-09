/**
 * The export itself, with the file system, the API and the clock behind
 * small functions so a test runs it without a site, a key or a network.
 *
 * Each job of the plan (plan.ts) is one PDF: join its entries; skip the
 * render when nothing changed since the last build and the job is
 * change-detected (`rebuild: false`, or a page PDF); render; on a Free
 * account whose manual is longer than the plan's pages, render the first
 * chapters that fit, with a closing note; write the PDF and, when `source`
 * is on, the Markdown beside it; remember the result for the next build.
 */
import { createHash } from "node:crypto";

import type { CollectedPage, OutlineEntry } from "./collect.js";
import { buildDocument, COVER_DATE_LINE, PAGE_BREAK, type SiteLike } from "./document.js";
import type { ResolvedOptions } from "./options.js";
import type { Job } from "./plan.js";
import { render, RenderError, requestBody, usage, type RenderInput, type RenderRequestBody, type RenderResult, type UsageInfo } from "./render.js";

export interface BuildDeps {
  fetchImpl: typeof fetch;
  /** Reads a page's source; throws when the file is missing. */
  readSource: (path: string) => string;
  /** The last build's record for this output, or null. */
  readCache: (name: string) => CacheRecord | null;
  writeCache: (name: string, record: CacheRecord) => void;
  /** Writes a file into the build output, folders made as needed. */
  writeOutput: (name: string, bytes: Uint8Array | string) => void;
  log: (line: string) => void;
  now: () => Date;
  /** Sees every document before it goes to the API; for a look at what the plugin sends. */
  beforeRender?: (name: string, markdown: string) => void;
}

/** What one build leaves for the next: the request's fingerprint and the files. */
export interface CacheRecord {
  hash: string;
  pages: number | null;
  pdf: Uint8Array;
  markdown: string;
}

export interface BuildArgs {
  jobs: Job[];
  /** Every doc of the version, so a link to a page outside an output still resolves to the site. */
  docs: import("./collect.js").DocLike[];
  /** The version's label for the cover; null for a site without versions. */
  versionLabel: string | null;
  site: SiteLike;
  options: ResolvedOptions;
  key: string;
  /** The site's locale, the language when the options name none. */
  locale: string | null;
}

export interface JobOutcome {
  name: string;
  kind: Job["kind"];
  pages: number | null;
  rendered: boolean;
  /** The render was served again from an earlier one, at no charge. */
  replayed: boolean;
  /** Set when a Free account got the first chapters only. */
  sample: { chapters: number; of: number } | null;
}

export interface BuildOutcome {
  /** The files written into the build output, in order. */
  written: string[];
  outcomes: JobOutcome[];
  /** The renders the build made (a cached file is not one). */
  rendered: number;
  /** The documents the build spent: the renders the API did not serve again from an earlier one. */
  spent: number;
}

export const FREE_PLAN = "free";
/** When the plan's limit is unknown: the smallest plan's, less room for the rest. */
export const DEFAULT_IMAGE_BUDGET = 900 * 1024;
export const PRICING_URL = "https://legivel.com/pricing";

/** The chapters of a manual: a top-level sidebar entry with its children.
 *  Every top-level entry (a page, a category's link page, or a category
 *  without one) starts a chapter; what follows at a deeper level belongs
 *  to it. */
export function chapters(entries: OutlineEntry[]): OutlineEntry[][] {
  const out: OutlineEntry[][] = [];
  for (const entry of entries) {
    if (entry.depth === 0 || out.length === 0) out.push([entry]);
    else out[out.length - 1]!.push(entry);
  }
  return out;
}

const pagesOf = (entries: OutlineEntry[]): CollectedPage[] => entries.filter((e): e is CollectedPage => e.kind === "page");

/** The note that closes a Free sample. */
export function sampleNote(title: string, chapters: number, of: number, pagesMax: number | null): string {
  const limit = pagesMax ? `the ${pagesMax} pages of a Free account` : "the pages of a Free account";
  return `${PAGE_BREAK}\n## About this sample\n\nThis PDF holds the first ${chapters} of ${of} chapters of ${title}, within ${limit}. The full manual needs a Starter plan: ${PRICING_URL}\n`;
}

/** The cache record's fingerprint: the request as it will be sent, less the
 *  cover's date, plus the plan: a new day renders nothing again, a new plan
 *  does (a Free sample must not be served to an upgraded account). The cache
 *  only; the Idempotency-Key is the sent body's own hash (render.ts). */
export function fingerprint(body: RenderRequestBody, plan: string | null): string {
  const dated = { ...body, markdown: body.markdown.replace(COVER_DATE_LINE, ""), plan };
  return createHash("sha256").update(JSON.stringify(dated)).digest("hex");
}

/** One cache record per output per locale: locales share names. */
export function cacheName(locale: string | null, name: string): string {
  return locale ? `${locale}/${name}` : name;
}

export function sidecarName(filename: string): string {
  return filename.replace(/\.pdf$/, ".md");
}

export async function exportAll(args: BuildArgs, deps: BuildDeps): Promise<BuildOutcome> {
  const written: string[] = [];
  const outcomes: JobOutcome[] = [];
  let rendered = 0;
  let spent = 0;
  let account: UsageInfo | null = null;
  const readAccount = async () => (account ??= await usage(args.key, args.options.apiUrl, deps.fetchImpl));
  // The plan's resource limit, with room for the Markdown and the fetched images: nine tenths of it.
  const limit = (await readAccount()).resourcesMb;
  const imageBudget = limit ? Math.floor(limit * 1048576 * 0.9) : DEFAULT_IMAGE_BUDGET;
  for (const job of args.jobs) {
    const outcome = await exportJob(job, { ...args, imageBudget }, deps, readAccount);
    outcomes.push(outcome);
    written.push(outcome.name);
    if (args.options.source) written.push(sidecarName(outcome.name));
    if (outcome.rendered) {
      rendered++;
      if (!outcome.replayed) spent++;
    }
  }
  const pages = args.jobs.filter((j) => j.kind === "page").length;
  if (pages > 0) {
    const again = outcomes.filter((o) => o.kind === "page" && o.rendered).length;
    deps.log(`page PDFs: ${again} of ${pages} rendered again, the rest unchanged since the last build.`);
  }
  // A replay (the same request as an earlier build, with no cache record to
  // say so) is served again by the API at no charge; the line tells the two apart.
  const served = rendered - spent;
  deps.log(
    served > 0
      ? `${rendered} render${rendered === 1 ? "" : "s"}: ${spent} document${spent === 1 ? "" : "s"} spent, ${served} served again from an earlier build at no charge.`
      : `${spent} document${spent === 1 ? "" : "s"} spent on this build.`,
  );
  return { written, outcomes, rendered, spent };
}

async function exportJob(job: Job, args: BuildArgs & { imageBudget: number }, deps: BuildDeps, readAccount: () => Promise<UsageInfo>): Promise<JobOutcome> {
  const { site, options, key } = args;
  const language = options.language ?? args.locale;
  const title = job.cover?.title ?? site.title;

  const join = (subset: OutlineEntry[], note: string | null, imageBudget: number = args.imageBudget) => {
    const document = buildDocument(subset, site, { cover: job.cover, language, pageBreaks: options.pageBreaks, versionLabel: args.versionLabel, imageBudget, noVectors: !vectors }, deps.now(), deps.readSource, args.docs);
    return { ...document, markdown: note ? `${document.markdown}\n${note}` : document.markdown };
  };
  let vectors = true;
  const input = (markdown: string): RenderInput => ({
    markdown,
    filename: job.name.split("/").pop()!,
    page: options.page,
    features: { ...options.features, theme: job.theme },
    resources: options.resources,
    language,
    sign: options.sign,
    embedSource: options.source,
    bareFirstPage: job.cover !== null,
  });

  let budget = args.imageBudget;
  let full = join(job.entries, null, budget);
  if (job.kind === "manual") {
    for (const note of full.notes) deps.log(note);
    deps.log(`${full.pages.length} page${full.pages.length === 1 ? "" : "s"} collected.`);
  }

  const hash = fingerprint(requestBody(input(full.markdown)), (await readAccount()).plan);
  const cacheKey = cacheName(args.locale, job.name);
  if (job.changeDetected) {
    const cached = deps.readCache(cacheKey);
    if (cached && cached.hash === hash) {
      writeOutputs(deps, options, job.name, cached.pdf, cached.markdown);
      if (job.kind !== "page") deps.log(`${job.name} unchanged since the last build; reused (rebuild: false). Set rebuild: true to render on every build.`);
      return { name: job.name, kind: job.kind, pages: cached.pages, rendered: false, replayed: false, sample: null };
    }
  }

  if (job.kind === "manual") deps.log("rendering…");
  deps.beforeRender?.(job.name, full.markdown);
  let result: RenderResult;
  let markdown = full.markdown;
  let sample: JobOutcome["sample"] = null;
  try {
    result = await renderWithinBounds();
  } catch (error) {
    if (!(error instanceof RenderError) || error.code !== "too_many_pages" || job.kind === "page") throw error;
    const account = await readAccount();
    if (account.plan !== FREE_PLAN) throw error;
    const found = await freeSample(job.entries, (subset, note) => join(subset, note, budget), input, key, options, account, title, deps, hash, halveBudget);
    if (!found) throw error;
    ({ result, markdown } = found);
    sample = { chapters: found.chapters, of: found.of };
    deps.log(`Free plan: ${job.name} holds the first ${found.chapters} of ${found.of} chapters in ${result.pages ?? "?"} pages; the full manual needs a Starter plan (${PRICING_URL}).`);
  }

  writeOutputs(deps, options, job.name, result.pdf, markdown);
  deps.writeCache(cacheKey, { hash, pages: result.pages, pdf: result.pdf, markdown });

  /** The image budget halved, down to none; false when there is nothing left to cut. */
  function halveBudget(reason: string): boolean {
    if (budget === 0) return false;
    budget = budget > 512 * 1024 ? Math.floor(budget / 2) : 0;
    deps.log(`${job.name}: ${reason} The images are cut to ${(budget / 1048576).toFixed(1)} MB and the document is sent again.`);
    return true;
  }

  /** The converter has bounds of its own beyond the plan's (decode work,
   *  elements): a refusal for size halves the image budget and tries
   *  again, down to no images; a refused try spends nothing. */
  async function renderWithinBounds(): Promise<RenderResult> {
    for (;;) {
      try {
        return await render(input(markdown), key, options.apiUrl, deps.fetchImpl, undefined, true);
      } catch (error) {
        if (!(error instanceof RenderError)) throw error;
        // An embedded vector image the engine refuses, without naming it, in
        // lenient mode: the vector images are left out and the document is
        // sent again, so one drawing never stops a build.
        if (error.code === "resource_fetch_failed" && options.resources === "lenient" && vectors && !/resource e\d+|resource r\d+/.test(error.message)) {
          vectors = false;
          deps.log(`${job.name}: ${error.message} The embedded vector images are left out and the document is sent again; the engine named no image.`);
          full = join(job.entries, null, budget);
          markdown = full.markdown;
          deps.beforeRender?.(job.name, markdown);
          continue;
        }
        if (error.code !== "payload_too_large" || !halveBudget(error.message)) throw error;
        full = join(job.entries, null, budget);
        markdown = full.markdown;
        deps.beforeRender?.(job.name, markdown);
      }
    }
  }
  if (job.kind === "manual") {
    deps.log(`wrote ${job.name} (${result.pages ?? "?"} PDF pages, ${(result.pdf.length / 1024).toFixed(0)} kB); link it as ${site.baseUrl}${job.name}.`);
    if (options.source) deps.log(`the Markdown is attached to the PDF and saved as ${sidecarName(job.name)}.`);
  } else deps.log(`wrote ${job.name} (${result.pages ?? "?"} PDF pages).`);
  if (result.resourcesFailed) deps.log(`${job.name}: some resources did not load (${result.resourcesFailed}); the PDF leaves them out.`);
  return { name: job.name, kind: job.kind, pages: result.pages, rendered: true, replayed: result.replayed, sample };
}

function writeOutputs(deps: BuildDeps, options: ResolvedOptions, name: string, pdf: Uint8Array, markdown: string): void {
  deps.writeOutput(name, pdf);
  if (options.source) deps.writeOutput(sidecarName(name), markdown);
}

/** The longest run of leading chapters a Free account renders. Each try
 *  that is refused for its pages spends no document, so the search walks
 *  down from the full manual and stops at the first PDF, the one document
 *  spent. The image budget the full manual settled on is kept, and a try
 *  the converter refuses for its size halves it again, as the manual's
 *  own render does. */
async function freeSample(
  entries: OutlineEntry[],
  join: (subset: OutlineEntry[], note: string | null) => { markdown: string },
  input: (markdown: string) => RenderInput,
  key: string,
  options: ResolvedOptions,
  account: UsageInfo,
  title: string,
  deps: BuildDeps,
  hash: string,
  halve: (reason: string) => boolean,
): Promise<{ result: RenderResult; markdown: string; chapters: number; of: number } | null> {
  const all = chapters(entries);
  const of = all.length;
  for (let count = of - 1; count >= 1; count--) {
    const subset = all.slice(0, count).flat();
    const markdown = join(subset, sampleNote(title, count, of, account.pagesMax)).markdown;
    try {
      const result = await render(input(markdown), key, options.apiUrl, deps.fetchImpl, undefined, true);
      return { result, markdown, chapters: count, of };
    } catch (error) {
      if (!(error instanceof RenderError)) throw error;
      if (error.code === "payload_too_large" && halve(error.message)) {
        count++;
        continue;
      }
      if (error.code !== "too_many_pages") throw error;
    }
  }
  return null;
}
