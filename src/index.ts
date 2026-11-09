/**
 * A Docusaurus plugin that exports the docs to PDF through legivel at
 * build time.
 *
 *   plugins: [["docusaurus-plugin-legivel", { filename: "handbook.pdf" }]]
 *
 * After the site is built, the plugin reads the docs plugin's sidebars,
 * collects the pages in sidebar order, joins them into one document and
 * sends it to the API with the key from the LEGIVEL_API_KEY environment
 * variable. The PDF lands in the build output next to index.html, so the
 * site can link it as /handbook.pdf; the Markdown it was made from is
 * attached to the PDF and saved beside it. One PDF per module or per page,
 * and a dark variant, come by option. A «Download PDF» button on the docs
 * pages links the right one. A failure stops the build with the API's own
 * sentence; the key never appears anywhere.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LoadContext, Plugin, PluginContentLoadedActions } from "@docusaurus/types";

import { exportAll, FREE_PLAN, type BuildDeps, type CacheRecord } from "./build.js";
import { collectOutline, selectVersion, type OutlineEntry, type VersionLike } from "./collect.js";
import type { SiteLike } from "./document.js";
import { DEFAULT_KEY_ENV, resolveOptions, signFromEnv, type PluginOptions } from "./options.js";
import { planJobs, type ButtonData, type Job } from "./plan.js";
import { usage } from "./render.js";

export type { PluginOptions } from "./options.js";
export { CREDIT_TEXT, CREDIT_URL } from "./credit.js";

const DOCS_PLUGIN = "docusaurus-plugin-content-docs";
export const PLUGIN_NAME = "docusaurus-plugin-legivel";
/** Where a build leaves its record for the next one, under the site's own cache folder. */
const CACHE_DIR = ".docusaurus/legivel-pdf";

interface DocsContent {
  loadedVersions: VersionLike[];
}

/** What loadContent learns about the account before the pages are rendered. */
interface AccountFacts {
  plan: string | null;
}

/** The plan this instance read, by its own id: a site with several
 *  instances (Redux has three docs plugins) must not read another's, and
 *  the "default" id is only the first of them. */
function ownFacts(allContent: AllContent, id: string): AccountFacts {
  return (allContent[PLUGIN_NAME]?.[id] as AccountFacts | undefined) ?? { plan: null };
}

/** The locale this build is for, or null on a site without i18n. */
function currentLocale(context: LoadContext): string | null {
  return context.i18n?.currentLocale ?? null;
}

type AllContent = Record<string, Record<string, unknown> | undefined>;

export default function legivelPdfPlugin(context: LoadContext, rawOptions: PluginOptions = {}): Plugin<AccountFacts> {
  const options = resolveOptions(rawOptions);
  // Docusaurus passes the instance id with the options on a multi-instance site.
  const instanceId = (rawOptions as { id?: string }).id ?? "default";
  let planned: { jobs: Job[]; button: ButtonData; versionLabel: string | null; docs: VersionLike["docs"] } | null = null;

  const log = (line: string) => console.log(`[legivel-pdf] ${line}`);
  const key = () => process.env[options.keyEnv];

  /** The outline, the jobs and the button's data, from the docs plugin's
   *  content; written as global data before the pages render. */
  const plan = (allContent: AllContent, actions: PluginContentLoadedActions) => {
    const instances = allContent[DOCS_PLUGIN] ?? {};
    const docs = instances[options.docsPluginId] as DocsContent | undefined;
    if (!docs) {
      const ids = Object.keys(instances);
      throw new Error(
        `${PLUGIN_NAME}: no docs plugin instance "${options.docsPluginId}"${ids.length ? ` (found: ${ids.join(", ")})` : ""}. Set docsPluginId to the instance to export.`,
      );
    }
    const own = ownFacts(allContent, instanceId);
    const version = selectVersion(docs, options.version);
    const entries: OutlineEntry[] = collectOutline(version, { sections: options.sections, exclude: options.exclude });
    const { jobs, button } = planJobs(entries, options, context.siteConfig.title);
    // A Free account keeps the line; only a plan shown to
    // be paid may hide it. An unknown plan (no key yet, the usage call
    // failed) keeps it too.
    if (!options.credit && own.plan !== null && own.plan !== FREE_PLAN) button.credit = false;
    else if (!options.credit) {
      log(own.plan === FREE_PLAN ? "credit: false needs a paid plan; a Free account keeps the line under the button." : "credit: false needs a paid plan, and the plan could not be read; the line under the button stays.");
      button.credit = true;
    }
    // A site without versioning has one version, "current"; its label is no cover line.
    const versionLabel = docs.loadedVersions.length > 1 ? (version.label ?? version.versionName) : null;
    planned = { jobs, button, versionLabel, docs: version.docs };
    // A locale the export leaves out gets no PDF, so its pages get no button
    // either: global data would link a file that is never made. Neither does
    // a build without the key (postBuild says so and makes no PDF).
    const locale = currentLocale(context);
    const exported = !options.locales || !locale || options.locales.includes(locale);
    if (options.button && exported && key()) actions.setGlobalData(button);
  };

  return {
    name: PLUGIN_NAME,

    /** The theme components: the docs page's content with the button above it. */
    getThemePath() {
      return fileURLToPath(new URL("./theme", import.meta.url));
    },

    /** The account's plan, read before the pages render: a Free account keeps the credit line. */
    async loadContent() {
      const k = key();
      if (!k || !options.button) return { plan: null };
      const account = await usage(k, options.apiUrl);
      return { plan: account.plan };
    },

    /** Docusaurus up to 3.4 hands every plugin's content to `contentLoaded`;
     *  3.5 and later call `allContentLoaded`. Whichever runs first plans. */
    contentLoaded({ actions, allContent }: { actions: PluginContentLoadedActions; allContent?: AllContent }) {
      if (allContent?.[DOCS_PLUGIN] && !planned) plan(allContent, actions);
    },

    allContentLoaded({ allContent, actions }) {
      if (!planned) plan(allContent as AllContent, actions);
    },

    async postBuild({ outDir, siteConfig, siteDir, i18n }) {
      if (!planned) throw new Error(`${PLUGIN_NAME}: the docs content was not loaded; the plugin must run in the same build as @docusaurus/plugin-content-docs.`);
      if (!planned.jobs.some((job) => job.docIds.length > 0)) {
        throw new Error(`${PLUGIN_NAME}: no pages to export${options.sections ? ` for sections ${options.sections.join(", ")}` : ""}.`);
      }

      const k = key();
      if (!k) {
        // A build without the key (a fork's pull request, a preview on a
        // runner without secrets) still succeeds; it just has no PDF.
        log(`no API key: the ${options.keyEnv} environment variable is not set, so this build makes no PDF. Set it to a key from https://legivel.com/account/api-keys (a Free account includes 100 documents a month).`);
        return;
      }
      if (options.keyEnv !== DEFAULT_KEY_ENV) log(`key read from ${options.keyEnv}.`);
      const sign = signFromEnv(options.sign);

      const locale = i18n?.currentLocale ?? null;
      if (options.locales && locale && !options.locales.includes(locale)) {
        log(`locale ${locale} gets no PDF (locales: ${options.locales.join(", ")}).`);
        return;
      }

      const site: SiteLike = { siteDir, url: siteConfig.url, baseUrl: siteConfig.baseUrl, title: siteConfig.title, tagline: siteConfig.tagline };
      const cacheDir = join(siteDir, CACHE_DIR);
      const deps: BuildDeps = {
        fetchImpl: fetch,
        readSource: (path) => readFileSync(path, "utf8"),
        readCache: (name) => readCache(cacheDir, name),
        writeCache: (name, record) => writeCache(cacheDir, name, record),
        writeOutput: (name, bytes) => {
          const target = join(outDir, name);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, bytes);
        },
        log,
        now: () => new Date(),
        // LEGIVEL_PDF_DEBUG=1 keeps every document the plugin sends under the cache folder.
        beforeRender: process.env.LEGIVEL_PDF_DEBUG
          ? (name, markdown) => {
              const target = join(cacheDir, "debug", name.replace(/\.pdf$/, ".md"));
              mkdirSync(dirname(target), { recursive: true });
              writeFileSync(target, markdown);
            }
          : undefined,
      };

      try {
        await exportAll({ jobs: planned.jobs, docs: planned.docs, versionLabel: planned.versionLabel, site, options: { ...options, sign }, key: k, locale }, deps);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason.startsWith(PLUGIN_NAME)) throw error;
        throw new Error(`${PLUGIN_NAME}: ${reason.startsWith("legivel answered") ? reason : `the request to ${options.apiUrl} failed: ${reason}`}`);
      }
    },
  };
}

function readCache(dir: string, name: string): CacheRecord | null {
  const meta = join(dir, `${name}.json`);
  if (!existsSync(meta)) return null;
  try {
    const record = JSON.parse(readFileSync(meta, "utf8")) as { hash: string; pages: number | null };
    const pdf = new Uint8Array(readFileSync(join(dir, name)));
    const markdown = readFileSync(join(dir, name.replace(/\.pdf$/, ".md")), "utf8");
    return { hash: record.hash, pages: record.pages, pdf, markdown };
  } catch {
    return null;
  }
}

function writeCache(dir: string, name: string, record: CacheRecord): void {
  const target = join(dir, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(`${target}.json`, JSON.stringify({ hash: record.hash, pages: record.pages }));
  writeFileSync(target, record.pdf);
  writeFileSync(target.replace(/\.pdf$/, ".md"), record.markdown);
}
