/**
 * What one build renders: the manual, one PDF per module (a top-level
 * sidebar entry with its children) when asked, one PDF per page when
 * asked, each in the themes wanted. Pure: the outline and the options in,
 * the jobs and the button's map out, so a test reads the plan without a
 * site. The names: `handbook.pdf`, `handbook-dark.pdf`, modules as
 * `handbook-<entry>.pdf`, pages under `handbook/<doc id>.pdf`.
 */
import { chapters } from "./build.js";
import type { OutlineEntry } from "./collect.js";
import type { CoverOptions, ResolvedOptions } from "./options.js";

import { pathKey, pdfFor, type ButtonData, type Theme } from "./button-data.js";

export type { ButtonData, Theme } from "./button-data.js";
export { pdfFor };

export interface Job {
  kind: "manual" | "module" | "page";
  /** The output path under the build folder, with its folders. */
  name: string;
  theme: Theme;
  entries: OutlineEntry[];
  /** The cover for this output; null for a page. */
  cover: CoverOptions | null;
  /** The doc ids the output stands for, for the button. */
  docIds: string[];
  /** A page PDF renders only when it changed; the others follow `rebuild`. */
  changeDetected: boolean;
}

/** The file name's part for an entry: lower case, letters and digits, hyphens. */
export function fileSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

function themed(stem: string, theme: Theme, themes: Theme[]): string {
  return themes.length > 1 && theme === "dark" ? `${stem}-dark.pdf` : `${stem}.pdf`;
}

function entryTitle(entry: OutlineEntry): string {
  return entry.kind === "page" ? entry.doc.title : entry.title;
}

function entryKey(entry: OutlineEntry): string {
  return entry.kind === "page" ? entry.doc.id : entry.label;
}

export function planJobs(entries: OutlineEntry[], options: ResolvedOptions, siteTitle: string): { jobs: Job[]; button: ButtonData } {
  const stem = options.filename.replace(/\.pdf$/, "");
  const jobs: Job[] = [];
  const button: ButtonData = { manual: {}, modules: {}, pages: {}, paths: {}, themes: options.themes, credit: options.credit };
  for (const entry of entries) if (entry.kind === "page") button.paths[pathKey(entry.doc.permalink)] = entry.doc.id;
  const docIds = (list: OutlineEntry[]) => list.filter((e) => e.kind === "page").map((e) => (e as { doc: { id: string } }).doc.id);
  const all = docIds(entries);

  for (const theme of options.themes) {
    const name = themed(stem, theme, options.themes);
    jobs.push({ kind: "manual", name, theme, entries, cover: options.cover, docIds: all, changeDetected: !options.rebuild });
    button.manual[theme] = `/${name}`;
  }

  if (options.modules !== false) {
    const wanted = options.modules === true ? null : options.modules;
    const used = new Map<string, number>();
    for (const chapter of chapters(entries)) {
      const head = chapter[0]!;
      if (head.depth !== 0) continue;
      const key = entryKey(head);
      if (wanted && !wanted.includes(key) && !wanted.includes(entryTitle(head))) continue;
      let part = fileSlug(entryTitle(head));
      const seen = used.get(part) ?? 0;
      used.set(part, seen + 1);
      if (seen > 0) part = `${part}-${seen + 1}`;
      const ids = docIds(chapter);
      for (const theme of options.themes) {
        const name = themed(`${stem}-${part}`, theme, options.themes);
        const cover = options.cover ? { title: options.cover.title ?? entryTitle(head), subtitle: options.cover.subtitle ?? siteTitle } : null;
        jobs.push({ kind: "module", name, theme, entries: chapter, cover, docIds: ids, changeDetected: !options.rebuild });
        for (const id of ids) (button.modules[id] ??= {})[theme] = `/${name}`;
      }
    }
  }

  if (options.pages) {
    for (const entry of entries) {
      if (entry.kind !== "page") continue;
      for (const theme of options.themes) {
        const name = themed(`${stem}/${entry.doc.id}`, theme, options.themes);
        jobs.push({ kind: "page", name, theme, entries: [{ ...entry, depth: 0, trail: [] }], cover: null, docIds: [entry.doc.id], changeDetected: true });
        (button.pages[entry.doc.id] ??= {})[theme] = `/${name}`;
      }
    }
  }

  return { jobs, button };
}
