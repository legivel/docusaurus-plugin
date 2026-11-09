/**
 * What the «Download PDF» button needs, and how it picks a file. No Node
 * import here: the theme component ships this to the browser.
 */
export type Theme = "light" | "dark";

/** Written by the plugin as its global data (index.ts, allContentLoaded). */
export interface ButtonData {
  /** The manual's path per theme, from the site root. */
  manual: Partial<Record<Theme, string>>;
  /** Per doc id, the module PDF per theme. */
  modules: Record<string, Partial<Record<Theme, string>>>;
  /** Per doc id, the page PDF per theme. */
  pages: Record<string, Partial<Record<Theme, string>>>;
  /** The doc id of each page's site path, so the button finds its page from the address on every Docusaurus 3 release. */
  paths: Record<string, string>;
  themes: Theme[];
  credit: boolean;
}

/** The site path as the map keys it: no trailing slash, the root as "/". */
export function pathKey(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/** The PDF for a page: its own, its module's, or the manual, in the theme read. */
export function pdfFor(data: ButtonData, docId: string, colorMode: Theme): string | null {
  const theme: Theme = data.themes.includes(colorMode) ? colorMode : data.themes[0]!;
  const candidates = [data.pages[docId], data.modules[docId], data.manual];
  for (const set of candidates) {
    const path = set?.[theme];
    if (path) return path;
  }
  return null;
}
