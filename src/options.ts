/**
 * The plugin's options, as written in docusaurus.config.js. Every value is
 * checked here, with a sentence a site author can act on, before the build
 * does any work. The API key is never an option: it comes from the
 * environment only, so it cannot land in a committed config.
 *
 * The render settings carry the names of `POST /v1/render` as the API docs
 * write them (`page`, `features`, `language`, `resources`, `sign`), so a
 * setting from the API reference works here unchanged. Their values are
 * checked by the API; a wrong one stops the build with the API's sentence.
 * The docs settings (`sections`, `cover`, `filename`, `rebuild`, `source`,
 * `docsPluginId`) are the plugin's own.
 */

export interface CoverOptions {
  /** The cover's title; the site title when omitted. */
  title?: string;
  /** The line under the title; the site tagline when omitted. */
  subtitle?: string;
}

/** `page` of `POST /v1/render`: size, margin, header, footer, numbering, first. */
export type PageOptions = Record<string, unknown>;
/** `features` of `POST /v1/render`: theme, mermaid, math, archive, … */
export type FeatureOptions = Record<string, unknown>;

export interface PluginOptions {
  /** Sidebar ids, or doc id prefixes, to include. Every sidebar when omitted. */
  sections?: string[];
  /** Doc ids, or doc id prefixes, to leave out. A page's front matter `pdf: false` leaves it out too. */
  exclude?: string[];
  /** The docs version to export, by name or label; the version the site shows by default when omitted. */
  version?: string;
  /** The locales that get a PDF; every locale the site builds when omitted. */
  locales?: string[];
  /** A new page before each top-level entry (`chapters`), or before every page (`pages`). */
  pageBreaks?: "chapters" | "pages";
  /** One PDF per top-level sidebar entry beside the manual: `true` for every one, or the labels or doc ids of the ones wanted. */
  modules?: boolean | string[];
  /** One PDF per page beside the manual, rendered again only when the page or a setting changed. */
  pages?: boolean;
  /** The themes to render: `["light"]`, `["dark"]` or both; the button serves the one the visitor reads in. */
  themes?: ("light" | "dark")[];
  /** The «Download PDF» button on the docs pages. */
  button?: boolean;
  /** The line under the button that names legivel. A Free account keeps it. */
  credit?: boolean;
  /** The cover page: `true` (site title and tagline), `false`, or own texts. */
  cover?: boolean | CoverOptions;
  /** The PDF's file name in the build output. */
  filename?: string;
  /** The page settings of the API: `size`, `margin`, `header`, `footer`, `numbering`, `first`. */
  page?: PageOptions;
  /** The feature switches of the API: `theme`, `mermaid`, `math`, `archive`, `accessible`, … */
  features?: FeatureOptions;
  /** `lenient`: a missing image leaves a gap; `strict`: it fails the build. */
  resources?: "lenient" | "strict";
  /** The document language, such as `en` or `de`; the site's locale when omitted. */
  language?: string;
  /** The `sign` setting of the API with a certificate the account has stored, by name
   *  (`{ certificate: "name" }`, plus `reason`, `location`, `contact`). A bundle and its
   *  password never go in the config: set LEGIVEL_SIGN_P12 (base64) and LEGIVEL_SIGN_PASSWORD. */
  sign?: Record<string, unknown>;
  /** `true` renders on every build; `false` renders only when the document or the settings changed. */
  rebuild?: boolean;
  /** `true` attaches the Markdown to the PDF and saves it beside it; `false` does neither. */
  source?: boolean;
  /** Which docs plugin instance to export when a site has several. */
  docsPluginId?: string;
  /** The API origin. Only for a staging check; the default is the product. */
  apiUrl?: string;
  /** The environment variable that holds the key. */
  keyEnv?: string;
}

export interface ResolvedOptions {
  sections: string[] | null;
  exclude: string[];
  version: string | null;
  locales: string[] | null;
  pageBreaks: "chapters" | "pages";
  modules: boolean | string[];
  pages: boolean;
  themes: ("light" | "dark")[];
  button: boolean;
  credit: boolean;
  cover: CoverOptions | null;
  filename: string;
  page: PageOptions;
  features: FeatureOptions;
  resources: "lenient" | "strict";
  language: string | null;
  sign: Record<string, unknown> | null;
  rebuild: boolean;
  source: boolean;
  docsPluginId: string;
  apiUrl: string;
  keyEnv: string;
}

export const DEFAULT_API_URL = "https://api.legivel.com";
export const DEFAULT_KEY_ENV = "LEGIVEL_API_KEY";
export const DEFAULT_FILENAME = "docs.pdf";

/** `id` is Docusaurus's own: the plugin instance name it adds to every plugin's options. */
const KNOWN_KEYS = ["id", "sections", "exclude", "version", "locales", "pageBreaks", "modules", "pages", "themes", "button", "credit", "cover", "filename", "page", "features", "resources", "language", "sign", "rebuild", "source", "docsPluginId", "apiUrl", "keyEnv"];
const FORBIDDEN_KEYS = ["apiKey", "api_key", "key", "token"];
/** Body keys of the API the plugin owns; written as options they would fight the build. */
const PLUGIN_OWNED_BODY_KEYS = ["markdown", "output", "upload_url"];
const PAGE_KEYS = ["size", "margin", "header", "footer", "numbering", "first"];

function fail(message: string): never {
  throw new Error(`docusaurus-plugin-legivel: ${message}`);
}

/** The sign setting from the config: a stored certificate by name and the
 *  signature's own fields; a bundle, a key or a password is refused, since a
 *  config file is committed and a secret in it is leaked. The bundle comes
 *  from the environment (signFromEnv). */
export const SIGN_SECRET_KEYS = ["p12", "password", "key", "cert", "chain"];
export const SIGN_P12_ENV = "LEGIVEL_SIGN_P12";
export const SIGN_PASSWORD_ENV = "LEGIVEL_SIGN_PASSWORD";

function signOption(sign: Record<string, unknown>): Record<string, unknown> {
  const secret = Object.keys(sign).find((k) => SIGN_SECRET_KEYS.includes(k));
  if (secret) {
    fail(`"sign.${secret}" is a secret and must not sit in docusaurus.config.js. Name a stored certificate ("sign": { "certificate": "name" }), or put the bundle in the ${SIGN_P12_ENV} environment variable (base64) and its password in ${SIGN_PASSWORD_ENV}.`);
  }
  for (const k of Object.keys(sign)) {
    if (!["certificate", "reason", "location", "contact"].includes(k)) fail(`"sign.${k}" is not a sign setting; the config takes "certificate", "reason", "location" and "contact".`);
  }
  if (typeof sign.certificate !== "string" || sign.certificate === "") fail('"sign.certificate" must name a certificate the account has stored.');
  return sign;
}

/** The sign setting the request carries: the config's stored certificate,
 *  or the bundle from the environment, or none. */
export function signFromEnv(configured: Record<string, unknown> | null, env: Record<string, string | undefined> = process.env): Record<string, unknown> | null {
  const p12 = env[SIGN_P12_ENV];
  const password = env[SIGN_PASSWORD_ENV];
  if (configured) {
    if (p12) fail(`both "sign.certificate" and ${SIGN_P12_ENV} are set; use one.`);
    return configured;
  }
  if (!p12) return null;
  if (password === undefined) fail(`${SIGN_P12_ENV} is set but ${SIGN_PASSWORD_ENV} is not; set both, or neither.`);
  return { p12, password };
}

function plainObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`"${name}" must be an object.`);
  return value as Record<string, unknown>;
}

export function resolveOptions(input: unknown): ResolvedOptions {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (typeof raw !== "object" || Array.isArray(raw)) fail("the options must be an object.");

  for (const key of FORBIDDEN_KEYS) {
    if (key in raw) {
      fail(`the option "${key}" is not allowed. The API key is read from the ${DEFAULT_KEY_ENV} environment variable, never from the config.`);
    }
  }
  for (const key of PLUGIN_OWNED_BODY_KEYS) {
    if (key in raw) fail(`the option "${key}" is set by the plugin; it is not yours to set.`);
  }
  const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.includes(key));
  if (unknown.length > 0) {
    fail(`unknown option${unknown.length === 1 ? "" : "s"} ${unknown.map((k) => `"${k}"`).join(", ")}. The options are ${KNOWN_KEYS.join(", ")}. Render settings go under "page" and "features", as the API docs name them.`.replace("id, ", ""));
  }

  const sections = raw.sections === undefined ? null : raw.sections;
  if (sections !== null && (!Array.isArray(sections) || sections.some((s) => typeof s !== "string" || s === ""))) {
    fail('"sections" must be a list of sidebar ids or doc id prefixes, such as ["docs"] or ["guides/"].');
  }

  const exclude = raw.exclude === undefined ? [] : raw.exclude;
  if (!Array.isArray(exclude) || exclude.some((s) => typeof s !== "string" || s === "")) {
    fail('"exclude" must be a list of doc ids or doc id prefixes, such as ["internal/"].');
  }

  const version = raw.version === undefined ? null : raw.version;
  if (version !== null && (typeof version !== "string" || version === "")) fail('"version" must be a docs version name or label, such as "current" or "2.0".');

  const locales = raw.locales === undefined ? null : raw.locales;
  if (locales !== null && (!Array.isArray(locales) || locales.some((s) => typeof s !== "string" || s === ""))) {
    fail('"locales" must be a list of locale codes, such as ["en", "de"].');
  }

  const pageBreaks = raw.pageBreaks === undefined ? "chapters" : raw.pageBreaks;
  if (pageBreaks !== "chapters" && pageBreaks !== "pages") fail('"pageBreaks" must be "chapters" (a new page per top-level entry) or "pages" (a new page per page).');

  const modules = raw.modules === undefined ? false : raw.modules;
  if (typeof modules !== "boolean" && (!Array.isArray(modules) || modules.some((s) => typeof s !== "string" || s === ""))) {
    fail('"modules" must be true (one PDF per top-level entry), false, or a list of the entries wanted, by category label or doc id.');
  }

  const pages = raw.pages === undefined ? false : raw.pages;
  if (typeof pages !== "boolean") fail('"pages" must be true (one PDF per page) or false.');

  const themes = raw.themes === undefined ? ["light"] : raw.themes;
  if (!Array.isArray(themes) || themes.length === 0 || themes.some((t) => t !== "light" && t !== "dark") || new Set(themes).size !== themes.length) {
    fail('"themes" must be ["light"], ["dark"] or ["light", "dark"].');
  }
  const button = raw.button === undefined ? true : raw.button;
  if (typeof button !== "boolean") fail('"button" must be true (a «Download PDF» button on the docs pages) or false.');

  const credit = raw.credit === undefined ? true : raw.credit;
  if (typeof credit !== "boolean") fail('"credit" must be true or false; a Free account keeps the line.');

  let cover: CoverOptions | null;
  if (raw.cover === undefined || raw.cover === true) cover = {};
  else if (raw.cover === false) cover = null;
  else if (typeof raw.cover === "object" && raw.cover !== null) {
    const c = raw.cover as Record<string, unknown>;
    for (const k of ["title", "subtitle"]) {
      if (c[k] !== undefined && typeof c[k] !== "string") fail(`"cover.${k}" must be a string.`);
    }
    cover = { title: c.title as string | undefined, subtitle: c.subtitle as string | undefined };
  } else fail('"cover" must be true, false, or { title, subtitle }.');

  const filename = raw.filename === undefined ? DEFAULT_FILENAME : raw.filename;
  if (typeof filename !== "string" || !/^[A-Za-z0-9._-]+\.pdf$/.test(filename)) {
    fail('"filename" must be a file name ending in .pdf, without a folder, such as "handbook.pdf".');
  }

  const page: PageOptions = raw.page === undefined ? {} : { ...plainObject(raw.page, "page") };
  const unknownPage = Object.keys(page).filter((key) => !PAGE_KEYS.includes(key));
  if (unknownPage.length > 0) fail(`"page" takes ${PAGE_KEYS.join(", ")}; not ${unknownPage.map((k) => `"${k}"`).join(", ")}.`);

  const features: FeatureOptions = raw.features === undefined ? {} : { ...plainObject(raw.features, "features") };
  if ("embed_source" in features) fail('"features.embed_source" is set by the "source" option; set source: false to leave the Markdown out.');
  if ("theme" in features) fail('"features.theme" is set by the "themes" option, which can render both.');
  for (const [key, value] of Object.entries(features)) {
    if (typeof value !== "boolean" && typeof value !== "string") fail(`"features.${key}" must be true, false or a word the API docs list.`);
  }

  const resources = raw.resources === undefined ? "lenient" : raw.resources;
  if (resources !== "lenient" && resources !== "strict") fail('"resources" must be "lenient" or "strict".');

  const language = raw.language === undefined ? null : raw.language;
  if (language !== null && (typeof language !== "string" || !/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(language))) {
    fail('"language" must be a language tag such as "en" or "pt-BR".');
  }

  const sign = raw.sign === undefined ? null : signOption(plainObject(raw.sign, "sign"));

  const rebuild = raw.rebuild === undefined ? true : raw.rebuild;
  if (typeof rebuild !== "boolean") fail('"rebuild" must be true (render on every build) or false (render only when something changed).');

  const source = raw.source === undefined ? true : raw.source;
  if (typeof source !== "boolean") fail('"source" must be true (the Markdown attached to the PDF and saved beside it) or false.');

  const docsPluginId = raw.docsPluginId === undefined ? "default" : raw.docsPluginId;
  if (typeof docsPluginId !== "string" || docsPluginId === "") fail('"docsPluginId" must be a non-empty string.');

  // https only, except a local development server on this machine.
  const apiUrl = raw.apiUrl === undefined ? DEFAULT_API_URL : raw.apiUrl;
  if (typeof apiUrl !== "string" || !/^(https:\/\/[^/\s]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(apiUrl)) {
    fail('"apiUrl" must be an https origin without a path, such as "https://api.legivel.com".');
  }

  const keyEnv = raw.keyEnv === undefined ? DEFAULT_KEY_ENV : raw.keyEnv;
  if (typeof keyEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(keyEnv)) fail('"keyEnv" must be an environment variable name.');

  return { sections, exclude, version, locales, pageBreaks, modules, pages, themes: themes as ("light" | "dark")[], button, credit, cover, filename, page, features, resources, language, sign, rebuild, source, docsPluginId, apiUrl, keyEnv };
}
