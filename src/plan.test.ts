import { describe, expect, test } from "bun:test";

import type { OutlineEntry } from "./collect.js";
import { resolveOptions } from "./options.js";
import { fileSlug, pdfFor, planJobs } from "./plan.js";

const doc = (id: string, title: string) => ({ id, title, description: "", source: `@site/docs/${id}.md`, permalink: `/docs/${id}`, frontMatter: {} });
const page = (id: string, title: string, depth: number, trail: string[]): OutlineEntry => ({ kind: "page", doc: doc(id, title), sidebar: "docs", depth, trail });
const category = (label: string, depth: number, trail: string[]): OutlineEntry => ({ kind: "category", label, title: label, description: null, sidebar: "docs", depth, trail });
const ENTRIES = [page("intro", "Introduction", 0, []), category("Guides", 0, []), page("guides/install", "Install a node", 1, ["Guides"]), page("guides/run", "Run", 1, ["Guides"]), page("api", "API: v1 (beta)", 0, [])];

describe("the plan", () => {
  test("the manual only, by default", () => {
    const { jobs, button } = planJobs(ENTRIES, resolveOptions({}), "Site");
    expect(jobs.map((j) => [j.kind, j.name, j.theme, j.changeDetected])).toEqual([["manual", "docs.pdf", "light", false]]);
    expect(jobs[0]!.docIds).toEqual(["intro", "guides/install", "guides/run", "api"]);
    expect(button).toEqual({ manual: { light: "/docs.pdf" }, modules: {}, pages: {}, paths: { "/docs/intro": "intro", "/docs/guides/install": "guides/install", "/docs/guides/run": "guides/run", "/docs/api": "api" }, themes: ["light"], credit: true });
  });

  test("modules per top-level entry with the module's own cover; named modules only when asked; file names from the titles", () => {
    const { jobs, button } = planJobs(ENTRIES, resolveOptions({ filename: "handbook.pdf", modules: true, cover: { subtitle: "Ops" } }), "Site");
    const modules = jobs.filter((j) => j.kind === "module");
    expect(modules.map((j) => j.name)).toEqual(["handbook-introduction.pdf", "handbook-guides.pdf", "handbook-api-v1-beta.pdf"]);
    expect(modules[1]!.cover).toEqual({ title: "Guides", subtitle: "Ops" });
    expect(modules[1]!.docIds).toEqual(["guides/install", "guides/run"]);
    expect(button.modules["guides/run"]).toEqual({ light: "/handbook-guides.pdf" });
    const named = planJobs(ENTRIES, resolveOptions({ modules: ["Guides", "api"] }), "Site").jobs.filter((j) => j.kind === "module");
    expect(named.map((j) => j.name)).toEqual(["docs-guides.pdf", "docs-api-v1-beta.pdf"]);
    expect(fileSlug("Über uns!")).toBe("ber-uns");
    expect(fileSlug("???")).toBe("section");
  });

  test("pages: one change-detected job per page, no cover, the page at the top level; dark variants carry -dark", () => {
    const { jobs, button } = planJobs(ENTRIES, resolveOptions({ pages: true, themes: ["light", "dark"] }), "Site");
    const pages = jobs.filter((j) => j.kind === "page");
    expect(pages.map((j) => j.name)).toEqual(["docs/intro.pdf", "docs/intro-dark.pdf", "docs/guides/install.pdf", "docs/guides/install-dark.pdf", "docs/guides/run.pdf", "docs/guides/run-dark.pdf", "docs/api.pdf", "docs/api-dark.pdf"]);
    expect(pages[2]).toMatchObject({ cover: null, changeDetected: true, entries: [{ depth: 0, trail: [] }] });
    expect(button.manual).toEqual({ light: "/docs.pdf", dark: "/docs-dark.pdf" });
    expect(button.pages["guides/run"]).toEqual({ light: "/docs/guides/run.pdf", dark: "/docs/guides/run-dark.pdf" });
  });

  test("the button picks the page's PDF, else the module's, else the manual, in the theme read", () => {
    const { button } = planJobs(ENTRIES, resolveOptions({ modules: ["Guides"], themes: ["light", "dark"] }), "Site");
    expect(pdfFor(button, "guides/run", "dark")).toBe("/docs-guides-dark.pdf");
    expect(pdfFor(button, "intro", "dark")).toBe("/docs-dark.pdf");
    const lightOnly = planJobs(ENTRIES, resolveOptions({ pages: true }), "Site").button;
    expect(pdfFor(lightOnly, "intro", "dark")).toBe("/docs/intro.pdf");
  });
});
