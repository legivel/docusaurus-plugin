/**
 * The outline of the export, in sidebar order. The docs plugin's loaded
 * content holds every version with its docs and its sidebars; the export
 * takes one version (the one the site shows by default, or the one the
 * options name), walks each sidebar depth first, and lists what it
 * reaches: a page once, and a category as an entry of its own when no page
 * is its link, so the contents and the bookmarks follow the sidebar tree.
 * A category that links to a page contributes that page before its items.
 * Links and HTML items have no source and are skipped. Drafts, unlisted
 * pages, the `exclude` list and a page whose front matter says `pdf: false`
 * stay out.
 */

export interface DocLike {
  id: string;
  title: string;
  description: string;
  source: string;
  permalink: string;
  frontMatter: Record<string, unknown>;
  draft?: boolean;
  unlisted?: boolean;
}

export type SidebarItemLike =
  | { type: "doc" | "ref"; id: string; label?: string }
  | {
      type: "category";
      label: string;
      items: SidebarItemLike[];
      link?: { type: "doc"; id: string } | { type: "generated-index"; title?: string; description?: string };
    }
  | { type: "link"; href: string; label: string }
  | { type: "html"; value: string };

export interface VersionLike {
  versionName: string;
  label?: string;
  isLast?: boolean;
  docs: DocLike[];
  sidebars: Record<string, SidebarItemLike[]>;
}

interface EntryBase {
  /** The sidebar the entry came from. */
  sidebar: string;
  /** Nesting depth in the sidebar, 0 at the top. */
  depth: number;
  /** The category labels above the entry, outermost first. */
  trail: string[];
}

/** A page of the export. */
export interface PageEntry extends EntryBase {
  kind: "page";
  doc: DocLike;
}

/** A category with no page of its own: a heading in the document, with
 *  the generated index's title and description when the site shows one. */
export interface CategoryEntry extends EntryBase {
  kind: "category";
  label: string;
  title: string;
  description: string | null;
}

export type OutlineEntry = PageEntry | CategoryEntry;

/** A page with its place; the chapters and the tests use it. */
export type CollectedPage = PageEntry;

export interface CollectOptions {
  /** Sidebar ids, or doc id prefixes, to include; every sidebar when null. */
  sections: string[] | null;
  /** Doc ids, or doc id prefixes, to leave out. */
  exclude: string[];
}

/**
 * `sections` filters by sidebar id, or by doc id prefix when no sidebar has
 * that id. Omitted, every sidebar is exported in the order the sidebars file
 * lists them. A category is listed only when it has at least one page under
 * it in the export.
 */
export function collectOutline(version: VersionLike, options: CollectOptions): OutlineEntry[] {
  const byId = new Map(version.docs.map((doc) => [doc.id, doc]));
  const seen = new Set<string>();
  const sidebarIds = Object.keys(version.sidebars);
  const wantedSidebars = options.sections ? options.sections.filter((s) => sidebarIds.includes(s)) : sidebarIds;
  const prefixes = options.sections ? options.sections.filter((s) => !sidebarIds.includes(s)) : [];
  const wanted = (id: string, sidebar: string) =>
    wantedSidebars.includes(sidebar) || prefixes.some((p) => id === p || id.startsWith(p));
  // A prefix matches whole path segments: "api" leaves out api and api/…, not apiary/….
  const excluded = (doc: DocLike) =>
    options.exclude.some((p) => doc.id === p || doc.id.startsWith(p.endsWith("/") ? p : `${p}/`)) || doc.frontMatter.pdf === false;

  const page = (id: string, sidebar: string, depth: number, trail: string[]): PageEntry | null => {
    const doc = byId.get(id);
    if (!doc || seen.has(id) || doc.draft || doc.unlisted || excluded(doc)) return null;
    if (!wanted(id, sidebar)) return null;
    seen.add(id);
    return { kind: "page", doc, sidebar, depth, trail };
  };

  const walk = (items: SidebarItemLike[], sidebar: string, depth: number, trail: string[]): OutlineEntry[] => {
    const out: OutlineEntry[] = [];
    for (const item of items) {
      if (item.type === "doc" || item.type === "ref") {
        const entry = page(item.id, sidebar, depth, trail);
        if (entry) out.push(entry);
      } else if (item.type === "category") {
        const own = item.link?.type === "doc" ? page(item.link.id, sidebar, depth, trail) : null;
        const children = walk(item.items, sidebar, depth + 1, [...trail, item.label]);
        if (own) out.push(own, ...children);
        else if (children.length > 0) {
          const index = item.link?.type === "generated-index" ? item.link : null;
          out.push({ kind: "category", label: item.label, title: index?.title ?? item.label, description: index?.description ?? null, sidebar, depth, trail }, ...children);
        }
      }
    }
    return out;
  };

  const out: OutlineEntry[] = [];
  for (const sidebar of sidebarIds) out.push(...walk(version.sidebars[sidebar] ?? [], sidebar, 0, []));
  return out;
}

/** The pages of the outline, in order. */
export function collectPages(version: VersionLike, sections: string[] | null, exclude: string[] = []): CollectedPage[] {
  return collectOutline(version, { sections, exclude }).filter((entry): entry is PageEntry => entry.kind === "page");
}

/** The version to export: the one named by the option (its name or its
 *  label), else the one the site shows by default (the last released
 *  version, or the only one). */
export function selectVersion(content: { loadedVersions: VersionLike[] }, wanted: string | null): VersionLike {
  const versions = content.loadedVersions;
  if (versions.length === 0) throw new Error("docusaurus-plugin-legivel: the docs plugin loaded no version; is @docusaurus/plugin-content-docs configured?");
  if (wanted !== null) {
    const version = versions.find((v) => v.versionName === wanted || v.label === wanted);
    if (!version) {
      throw new Error(`docusaurus-plugin-legivel: no docs version "${wanted}"; the site has ${versions.map((v) => `"${v.versionName}"${v.label && v.label !== v.versionName ? ` (${v.label})` : ""}`).join(", ")}.`);
    }
    return version;
  }
  return versions.find((v) => v.isLast) ?? versions[0]!;
}

/** The version the site shows by default. */
export function currentVersion(content: { loadedVersions: VersionLike[] }): VersionLike {
  return selectVersion(content, null);
}
