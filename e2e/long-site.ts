/**
 * Writes the Free sample site of the end-to-end test: five chapters of about
 * seven pages each, so the full manual is past a Free account's 20 pages and
 * the plugin must render the first chapters that fit. Generated, never
 * edited by hand; the folder is ignored by git.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LONG_CHAPTERS = ["Arrival", "Survey", "Samples", "Weather", "Departure"];

const WORDS = "the station keeps a careful record of every count so that each season can be read against the last and the volunteers who walk the line at dawn write what they see before the light changes".split(" ");

/** About 100 words, the same on every run. */
function paragraph(seed: number): string {
  const words: string[] = [];
  for (let i = 0; i < 100; i++) words.push(WORDS[(seed * 7 + i * 3) % WORDS.length]!);
  const text = words.join(" ");
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

export function writeLongSite(dir: string, pluginPath: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "package.json"), `{ "name": "legivel-docusaurus-pdf-e2e-long", "private": true }\n`);
  writeFileSync(
    join(dir, "docusaurus.config.js"),
    `module.exports = {
  title: "Kestrel Season Log",
  tagline: "Five chapters, past the Free page limit.",
  url: "https://docs.example.com",
  baseUrl: "/",
  onBrokenLinks: "throw",
  presets: [["classic", { docs: { sidebarPath: "./sidebars.js", routeBasePath: "/" }, blog: false, pages: false }]],
  plugins: [[${JSON.stringify(pluginPath)}, { filename: "season.pdf", page: { size: "A4" }, apiUrl: process.env.LEGIVEL_API_URL || (() => { throw new Error("set LEGIVEL_API_URL to the API origin"); })() }]],
};
`,
  );
  const ids = LONG_CHAPTERS.map((_, i) => `chapter-${i + 1}`);
  writeFileSync(join(dir, "sidebars.js"), `module.exports = { season: ${JSON.stringify(ids)} };\n`);
  LONG_CHAPTERS.forEach((title, c) => {
    const sections = Array.from({ length: 7 }, (_, s) => {
      const body = Array.from({ length: 5 }, (_, p) => paragraph(c * 100 + s * 10 + p)).join("\n\n");
      return `## ${title} part ${s + 1}\n\n${body}`;
    }).join("\n\n");
    const slug = c === 0 ? "slug: /\n" : "";
    writeFileSync(join(dir, "docs", `${ids[c]}.md`), `---\ntitle: ${title}\n${slug}---\n\n${sections}\n`);
  });
}
