import { describe, expect, test } from "bun:test";

import { chapters, exportAll, sampleNote, type BuildDeps, type CacheRecord } from "./build.js";
import { planJobs } from "./plan.js";
import type { OutlineEntry } from "./collect.js";
import { resolveOptions } from "./options.js";

const doc = (id: string, title = id) => ({ id, title, description: "", source: `@site/docs/${id}.md`, permalink: `/docs/${id}`, frontMatter: {} });
const page = (id: string, depth: number, trail: string[], sidebar = "docs"): OutlineEntry => ({ kind: "page", doc: doc(id, id.split("/").pop()!), sidebar, depth, trail });
const category = (label: string, depth: number, trail: string[], sidebar = "docs"): OutlineEntry => ({ kind: "category", label, title: label, description: null, sidebar, depth, trail });
const SITE = { siteDir: "/site", url: "https://docs.example.com", baseUrl: "/", title: "Example", tagline: "Docs for the example." };
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

const PAGES = [page("intro", 0, []), page("guides/overview", 0, []), page("guides/install", 1, ["Guides"]), page("guides/operate", 1, ["Guides"]), page("reference", 0, [])];
const args = (entries: OutlineEntry[], options: ReturnType<typeof resolveOptions>, locale = "en") => ({ jobs: planJobs(entries, options, SITE.title).jobs, docs: entries.filter((e) => e.kind === "page").map((e) => (e as { doc: { id: string } }).doc as never), versionLabel: null, site: SITE, options, key: "lgvl_k", locale });
const exportPdf = async (a: ReturnType<typeof args>, d: BuildDeps) => {
  const all = await exportAll(a, d);
  const main = all.outcomes[0]!;
  return { written: all.written, pages: main.pages, rendered: main.rendered, sample: main.sample, all };
};

/** A fake API: answers too_many_pages while the document holds more than `fits` pages of ours, else a PDF; counts the documents it "spent". */
function fakeApi(fits: number, plan = "free") {
  const headers: Record<string, string>[] = [];
  const calls: { markdown: string; features?: { theme?: string } }[] = [];
  let spent = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    headers.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])));
    if (String(url).endsWith("/v1/usage")) return Response.json({ plan, limits: { pages_max: 20, resources_mb: 4 } });
    const body = JSON.parse(String(init!.body)) as { markdown: string; features?: { theme?: string } };
    calls.push(body);
    const count = (body.markdown.match(/^#{1,6} (?!About this sample$)/gm) ?? []).length;
    if (count > fits) return Response.json({ code: "too_many_pages", error: "The document has more pages than the plan allows.", limit: { name: "pages_max", value: 20, plan } }, { status: 422 });
    spent++;
    return new Response(PDF, { status: 200, headers: { "x-legivel-pages": String(count * 2), "content-type": "application/pdf" } });
  }) as typeof fetch;
  return { fetchImpl, calls, headers, spent: () => spent };
}

function deps(fetchImpl: typeof fetch, cache: Record<string, CacheRecord> = {}) {
  const outputs: Record<string, Uint8Array | string> = {};
  const log: string[] = [];
  const d: BuildDeps = {
    fetchImpl,
    readSource: (path) => `Text of ${path.split("/").pop()}.\n`,
    readCache: (name) => cache[name] ?? null,
    writeCache: (name, record) => {
      cache[name] = record;
    },
    writeOutput: (name, bytes) => {
      outputs[name] = bytes;
    },
    log: (line) => log.push(line),
    now: () => new Date(Date.UTC(2026, 9, 19)),
  };
  return { d, outputs, log, cache };
}

describe("chapters", () => {
  test("a top-level page, or a category with its children, is one chapter", () => {
    const names = (c: OutlineEntry[][]) => c.map((ch) => ch.map((e) => (e.kind === "page" ? e.doc.id : `[${e.label}]`)));
    expect(names(chapters(PAGES))).toEqual([["intro"], ["guides/overview", "guides/install", "guides/operate"], ["reference"]]);
    // A category entry starts a chapter that holds its children.
    expect(names(chapters([category("A", 0, []), page("a/x", 1, ["A"]), page("a/y", 1, ["A"]), category("B", 0, []), page("b/x", 1, ["B"])]))).toEqual([["[A]", "a/x", "a/y"], ["[B]", "b/x"]]);
  });
});

describe("the export", () => {
  test("a render the API serves again (X-Legivel-Replay: true) is counted, not spent; the line tells the two apart (re-review of 22 Oct)", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).endsWith("/v1/usage")) return Response.json({ plan: "free", limits: { pages_max: 20, resources_mb: 4 } });
      calls++;
      return new Response(PDF, { status: 200, headers: { "x-legivel-pages": "4", "content-type": "application/pdf", ...(calls === 1 ? {} : { "x-legivel-replay": "true" }) } });
    }) as typeof fetch;
    const { d, log } = deps(fetchImpl);
    const outcome = await exportAll(args(PAGES, resolveOptions({ modules: true, themes: ["light"] })), d);
    expect(outcome.rendered).toBe(calls);
    expect(outcome.spent).toBe(1);
    expect(outcome.outcomes.filter((o) => o.replayed)).toHaveLength(calls - 1);
    expect(log.at(-1)).toBe(`${calls} renders: 1 document spent, ${calls - 1} served again from an earlier build at no charge.`);
  });

  test("renders, writes the PDF and the Markdown beside it, remembers the build", async () => {
    const api = fakeApi(99);
    const { d, outputs, log, cache } = deps(api.fetchImpl);
    const outcome = await exportPdf(args(PAGES, resolveOptions({ filename: "handbook.pdf" }), "de"), d);
    expect(outcome).toMatchObject({ written: ["handbook.pdf", "handbook.md"], pages: 10, rendered: true, sample: null });
    expect(outputs["handbook.pdf"]).toEqual(PDF);
    expect(String(outputs["handbook.md"])).toContain("# intro\n\nText of intro.md.");
    expect(String(outputs["handbook.md"])).toContain("\n## install\n\nText of install.md.");
    expect(cache["de/handbook.pdf"]!.pages).toBe(10);
    expect(api.calls[0]!.markdown).toContain("\\newpage");
    expect(log.join("\n")).toContain("wrote handbook.pdf (10 PDF pages");
    expect(log.join("\n")).toContain("saved as handbook.md");
    expect(api.spent()).toBe(1);
  });

  test("the locale is the language when the options name none, and the request carries the defaults", async () => {
    let seen: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = JSON.parse(String(init!.body));
      return new Response(PDF, { status: 200, headers: { "x-legivel-pages": "3" } });
    }) as typeof fetch;
    const { d } = deps(fetchImpl);
    await exportPdf(args(PAGES.slice(0, 1), resolveOptions({}), "pt-BR"), d);
    expect(seen.language).toBe("pt-BR");
    expect(seen.features).toEqual({ embed_source: true, theme: "light" });
    expect(seen.page).toEqual({ numbering: "Page {page} of {pages}", first: false });
    expect(String(seen.markdown)).toContain("language: pt-BR");
  });

  test("rebuild: false reuses the last PDF when nothing changed, renders when something did", async () => {
    const api = fakeApi(99);
    const { d, cache } = deps(api.fetchImpl);
    const options = resolveOptions({ rebuild: false });
    const first = await exportPdf(args(PAGES, options), d);
    expect(first.rendered).toBe(true);
    const again = deps(api.fetchImpl, cache);
    const second = await exportPdf(args(PAGES, options), again.d);
    expect(second).toMatchObject({ written: ["docs.pdf", "docs.md"], pages: 10, rendered: false, sample: null });
    expect(again.outputs["docs.pdf"]).toEqual(PDF);
    expect(again.log.join("\n")).toContain("unchanged since the last build; reused");
    const changed = deps(api.fetchImpl, cache);
    const third = await exportPdf(args(PAGES, resolveOptions({ rebuild: false, page: { size: "A5" } })), changed.d);
    expect(third.rendered).toBe(true);
    expect(api.spent()).toBe(2);
  });

  test("a Free account over its pages gets the first chapters that fit, a closing note, and spends one document", async () => {
    const api = fakeApi(3);
    const { d, outputs, log } = deps(api.fetchImpl);
    const outcome = await exportPdf(args(PAGES, resolveOptions({})), d);
    // 3 chapters; the full manual (5 pages) and 2 chapters (4 pages) are refused, 1 chapter (1 page) fits.
    expect(outcome.sample).toEqual({ chapters: 1, of: 3 });
    expect(api.calls).toHaveLength(3);
    expect(api.spent()).toBe(1);
    expect(String(outputs["docs.md"])).toContain("## About this sample\n\nThis PDF holds the first 1 of 3 chapters of Example, within the 20 pages of a Free account. The full manual needs a Starter plan: https://legivel.com/pricing");
    expect(String(outputs["docs.md"])).not.toContain("# reference");
    expect(log.join("\n")).toContain("Free plan: docs.pdf holds the first 1 of 3 chapters in 2 pages; the full manual needs a Starter plan");
  });

  test("a paid account over its pages fails with the API's sentence", async () => {
    const api = fakeApi(3, "starter");
    const { d } = deps(api.fetchImpl);
    const error = await exportPdf(args(PAGES, resolveOptions({})), d).catch((e) => e);
    expect(error.message).toContain("422 too_many_pages: The document has more pages than the plan allows. Export fewer sections");
    expect(api.calls).toHaveLength(1);
  });

  test("modules, pages and themes: one job each, pages rendered again only when changed, both themes served", async () => {
    const api = fakeApi(99);
    const { d, outputs, log, cache } = deps(api.fetchImpl);
    const options = resolveOptions({ filename: "handbook.pdf", modules: true, pages: true, themes: ["light", "dark"], source: false });
    const first = await exportAll(args(PAGES, options), d);
    // 2 manuals + 3 chapters × 2 themes + 5 pages × 2 themes = 18 outputs, all rendered.
    expect(first.outcomes).toHaveLength(18);
    expect(first.rendered).toBe(18);
    expect(Object.keys(outputs).sort()).toEqual([
      "handbook-dark.pdf", "handbook-intro-dark.pdf", "handbook-intro.pdf", "handbook-overview-dark.pdf", "handbook-overview.pdf", "handbook-reference-dark.pdf", "handbook-reference.pdf", "handbook.pdf",
      "handbook/guides/install-dark.pdf", "handbook/guides/install.pdf", "handbook/guides/operate-dark.pdf", "handbook/guides/operate.pdf", "handbook/guides/overview-dark.pdf", "handbook/guides/overview.pdf", "handbook/intro-dark.pdf", "handbook/intro.pdf", "handbook/reference-dark.pdf", "handbook/reference.pdf",
    ]);
    expect(log.join("\n")).toContain("page PDFs: 10 of 10 rendered again");
    // The dark outputs ask for the dark theme; the module of the link page holds its children.
    expect(api.calls.filter((c) => c.features?.theme === "dark")).toHaveLength(9);
    expect(api.calls.find((c) => c.markdown.includes("# overview") && c.markdown.includes("## install"))).toBeDefined();
    // Next build, one page changed: the manuals and modules render again (rebuild: true), only that page PDF does.
    const again = deps(api.fetchImpl, cache);
    again.d.readSource = (path) => (path.endsWith("operate.md") ? "Changed.\n" : `Text of ${path.split("/").pop()}.\n`);
    const second = await exportAll(args(PAGES, options), again.d);
    expect(second.outcomes.filter((o) => o.kind === "page" && o.rendered).map((o) => o.name)).toEqual(["handbook/guides/operate.pdf", "handbook/guides/operate-dark.pdf"]);
    expect(second.rendered).toBe(8 + 2);
    expect(again.log.join("\n")).toContain("page PDFs: 2 of 10 rendered again");
    expect(again.log.join("\n")).toContain("10 documents spent on this build.");
  });

  test("a vector image the engine refuses without naming it: the vectors are left out and the document is sent again", async () => {
    let calls = 0;
    let features: Record<string, unknown> = {};
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/v1/usage")) return Response.json({ plan: "scale", limits: { pages_max: 2048, resources_mb: 24 } });
      calls++;
      features = (JSON.parse(String(init!.body)) as { features: Record<string, unknown> }).features;
      if (calls === 1) return Response.json({ code: "resource_fetch_failed", error: "A remote resource could not be loaded." }, { status: 422 });
      return new Response(PDF, { status: 200, headers: { "x-legivel-pages": "2" } });
    }) as typeof fetch;
    const { d, log } = deps(fetchImpl);
    const outcome = await exportAll(args(PAGES.slice(0, 1), resolveOptions({})), d);
    expect(outcome.rendered).toBe(1);
    expect(calls).toBe(2);
    expect(features.svg).toBeUndefined();
    expect(log.join("\n")).toContain("The embedded vector images are left out and the document is sent again");
  });

  test("a new day renders nothing again; a new plan, or another locale, does (review of 20 Oct)", async () => {
    const api = fakeApi(99, "starter");
    const { d, cache } = deps(api.fetchImpl);
    const options = resolveOptions({ filename: "handbook.pdf", rebuild: false, cover: true });
    await exportPdf(args(PAGES, options, "en"), d);
    expect(api.spent()).toBe(1);
    // The next day: the cover's date changed, nothing else.
    const nextDay = { ...d, now: () => new Date(Date.UTC(2026, 9, 20)) };
    expect((await exportPdf(args(PAGES, options, "en"), nextDay)).rendered).toBe(false);
    expect(api.spent()).toBe(1);
    // Another locale has a cache of its own.
    expect((await exportPdf(args(PAGES, options, "de"), d)).rendered).toBe(true);
    expect(Object.keys(cache).sort()).toEqual(["de/handbook.pdf", "en/handbook.pdf"]);
    // An upgrade changes the fingerprint, so a Free sample never outlives the plan.
    const upgraded = fakeApi(99, "pro");
    expect((await exportPdf(args(PAGES, options, "en"), { ...deps(upgraded.fetchImpl, cache).d })).rendered).toBe(true);
    expect(upgraded.spent()).toBe(1);
  });

  test("the Idempotency-Key is the sent body's hash: two builds across midnight with no cache send two keys and keep one cache hash", async () => {
    const options = resolveOptions({ filename: "handbook.pdf" });
    const keys = (api: ReturnType<typeof fakeApi>) => api.headers.map((h) => h["idempotency-key"]).filter((k): k is string => !!k);
    const evening = fakeApi(99);
    const first = deps(evening.fetchImpl);
    first.d.now = () => new Date(Date.UTC(2026, 9, 19, 21));
    await exportPdf(args(PAGES, options), first.d);
    // A fresh CI runner the next day: no cache record, the cover's date changed.
    const morning = fakeApi(99);
    const second = deps(morning.fetchImpl);
    second.d.now = () => new Date(Date.UTC(2026, 9, 20, 6));
    await exportPdf(args(PAGES, options), second.d);
    expect(keys(evening)).toHaveLength(1);
    expect(keys(morning)).toHaveLength(1);
    expect(keys(evening)[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(keys(evening)[0]).not.toBe(keys(morning)[0]);
    expect(first.cache["en/handbook.pdf"]!.hash).toBe(second.cache["en/handbook.pdf"]!.hash);
  });

  test("a resend after a size refusal sends the same key while the body is the same: a legitimate replay, nothing spent twice", async () => {
    const sent: string[] = [];
    let refused = false;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/v1/usage")) return Response.json({ plan: "pro", limits: { pages_max: 1000, resources_mb: 4 } });
      sent.push((init?.headers as Record<string, string>)["Idempotency-Key"]);
      if (!refused) {
        refused = true;
        return Response.json({ code: "payload_too_large", error: "The document's images pass the limit." }, { status: 413 });
      }
      return new Response(PDF, { status: 200, headers: { "x-legivel-pages": "10" } });
    }) as typeof fetch;
    const { d } = deps(fetchImpl);
    await exportPdf(args(PAGES, resolveOptions({ filename: "handbook.pdf" })), d);
    // Without images to cut, the halved budget changes nothing in the body;
    // the key follows the body, so a changed body (an image left out) gets its own.
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    expect(sent[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the Free walk keeps the halved image budget and halves again on a size refusal", async () => {
    // The converter refuses the full manual for its size once, then the
    // first sample try once: both halve the budget and send again.
    let sizeRefusals = 0;
    let sampleTries = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/v1/usage")) return Response.json({ plan: "free", limits: { pages_max: 20, resources_mb: 1.5 } });
      const body = JSON.parse(String(init?.body)) as { markdown: string };
      const sample = body.markdown.includes("About this sample");
      if (sample) sampleTries++;
      if ((!sample && sizeRefusals === 0) || (sample && sampleTries === 1)) {
        sizeRefusals++;
        return Response.json({ code: "payload_too_large", error: "The document's images pass the limit." }, { status: 413 });
      }
      if (!sample) return Response.json({ code: "too_many_pages", error: "Too many pages." }, { status: 422 });
      return new Response(PDF, { status: 200, headers: { "x-legivel-pages": "12" } });
    }) as typeof fetch;
    const { d, log } = deps(fetchImpl);
    const outcome = await exportPdf(args(PAGES, resolveOptions({ filename: "handbook.pdf" })), d);
    expect(outcome.sample).toEqual({ chapters: 2, of: 3 });
    expect(sizeRefusals).toBe(2);
    expect(log.filter((l) => l.includes("The images are cut to"))).toHaveLength(2);
  });

  test("the note names the limit when it is known", () => {
    expect(sampleNote("Handbook", 1, 3, null)).toContain("within the pages of a Free account");
  });
});
