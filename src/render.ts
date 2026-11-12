/**
 * One call to `POST /v1/render`, and one to `GET /v1/usage`. The key travels
 * in the Authorization header and nowhere else: not in the log, not in an
 * error, not in a file. A failure answers with the API's own sentence and
 * code, so the build log says what to do next.
 *
 * The request body is the API's: `page`, `features`, `language`, `resources`
 * and `sign` go through under their own names. The plugin adds the defaults
 * of a manual (a page number «Page X of Y», no header or footer on the
 * cover, the Markdown attached) where the site author set nothing.
 */
import { createHash } from "node:crypto";
import type { FeatureOptions, PageOptions } from "./options.js";

export interface RenderInput {
  markdown: string;
  filename: string;
  page: PageOptions;
  features: FeatureOptions;
  resources: "lenient" | "strict";
  language: string | null;
  sign: Record<string, unknown> | null;
  /** Attach the Markdown to the PDF as `document.md`. */
  embedSource: boolean;
  /** A cover is the first page: no header, footer or number on it. */
  bareFirstPage: boolean;
}

export interface RenderRequestBody {
  markdown: string;
  filename: string;
  output: "pdf";
  resources: "lenient" | "strict";
  language?: string;
  features?: FeatureOptions;
  page?: PageOptions;
  sign?: Record<string, unknown>;
}

export interface RenderResult {
  pdf: Uint8Array;
  pages: number | null;
  /** Resources the API could not load, in lenient mode: ids and codes only. */
  resourcesFailed: string | null;
  /** The API served an earlier render of this exact request again
   *  (X-Legivel-Replay: true) and charged no document for it. */
  replayed: boolean;
}

/** What `GET /v1/usage` says about the account, as far as the build needs it. */
export interface UsageInfo {
  plan: string | null;
  pagesMax: number | null;
  /** The images and other resources one document may carry, in MB. */
  resourcesMb: number | null;
}

export class RenderError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RenderError";
  }
}

export const DEFAULT_NUMBERING = "Page {page} of {pages}";

/** The number sits in the footer center unless the author's footer text
 *  takes that place; then it moves right, or left when the right is taken
 *  too. A footer text at the number's position would win over it. */
export function defaultNumbering(footer: unknown): string | { text: string; position: string } {
  const taken = (slot: string) =>
    typeof footer === "object" && footer !== null && typeof (footer as Record<string, unknown>)[slot] === "string";
  const centerTaken = typeof footer === "string" || taken("center");
  if (!centerTaken) return DEFAULT_NUMBERING;
  return { text: DEFAULT_NUMBERING, position: taken("right") ? "footer left" : "footer right" };
}

export function requestBody(input: RenderInput): RenderRequestBody {
  const body: RenderRequestBody = { markdown: input.markdown, filename: input.filename, output: "pdf", resources: input.resources };
  if (input.language) body.language = input.language;

  const features: FeatureOptions = { ...input.features };
  if (input.embedSource) features.embed_source = true;
  if (Object.keys(features).length > 0) body.features = features;

  const page: PageOptions = { ...input.page };
  if (page.numbering === undefined) page.numbering = defaultNumbering(page.footer);
  if (input.bareFirstPage && page.first === undefined) page.first = false;
  if (Object.keys(page).length > 0) body.page = page;

  if (input.sign) body.sign = input.sign;
  return body;
}

/** What the build log says for an API answer; the key never appears. */
export function describeFailure(status: number, payload: unknown): { message: string; code: string | null } {
  const p = (payload ?? {}) as { code?: unknown; error?: unknown; message?: unknown; reason?: unknown; resource_id?: unknown; line?: unknown; renderer_bound?: unknown };
  const code = typeof p.code === "string" ? p.code : null;
  const raw = typeof p.error === "string" ? p.error : typeof p.message === "string" ? p.message : null;
  const detail = [
    typeof p.reason === "string" ? `reason ${p.reason}` : null,
    typeof p.resource_id === "string" ? `resource ${p.resource_id}` : null,
    typeof p.line === "number" ? `line ${p.line}` : null,
    typeof p.renderer_bound === "string" ? `bound ${p.renderer_bound}` : null,
  ].filter(Boolean);
  const sentence = raw ? `${raw.trim().replace(/\.$/, "")}${detail.length ? ` (${detail.join(", ")})` : ""}` : null;
  let hint = "";
  switch (code) {
    case "unauthorized":
      hint = " Check the key in the environment variable; it starts with lgvl_ and is shown once on the API keys page.";
      break;
    case "email_unverified":
      hint = " Verify the account's email address, then build again.";
      break;
    case "quota_exhausted":
      hint = " The account's documents for this period are used up.";
      break;
    case "resource_fetch_failed":
    case "too_many_resources":
      hint = ' Set resources: "lenient" to build with the missing images left out.';
      break;
    case "too_many_pages":
      hint = " Export fewer sections, or move the account to a plan with a higher page limit.";
      break;
  }
  const message = `legivel answered ${status}${code ? ` ${code}` : ""}${sentence ? `: ${sentence}` : ""}.${hint}`;
  return { message, code };
}

const USER_AGENT = "docusaurus-plugin-legivel";

/** A busy service (503) or a full burst (429) is tried again after the
 *  pause it names in Retry-After, a few seconds without one, up to five
 *  times; a build on a shared runner should not fail for a busy minute. */
const RETRY_STATUSES = [429, 502, 503, 504];
/** The one 429 a pause does not cure: the key's replays are used up (Free
 *  allows two per key). The request goes again at once without the key, as a
 *  fresh render that spends a document, since the build cannot finish without
 *  the PDF: a fresh CI build of an unchanged site on Free hit it on the fourth
 *  build (review of 22 Oct). */
export const REPLAY_LIMIT_CODE = "idempotency_replay_limit";
/** The 422 the same cure fits. The key is the hash of the body, so the body
 *  under it never differs; the API answers this when what it kept of the
 *  first render no longer matches the request: an image the document loads
 *  from a URL has changed since, or a service update changed what it keeps.
 *  Sending the same key again would get the same answer until the key
 *  expires, so the request goes again at once without it, as a fresh render
 *  that spends a document. */
export const MISMATCH_CODE = "idempotency_mismatch";

/** The API will not serve this key again: its replays are used up (429) or
 *  its first render no longer matches (422). */
async function keyRefused(response: Response): Promise<boolean> {
  const code = response.status === 429 ? REPLAY_LIMIT_CODE : response.status === 422 ? MISMATCH_CODE : null;
  if (!code) return false;
  try {
    const payload = (await response.clone().json()) as { code?: unknown };
    return payload?.code === code;
  } catch {
    return false;
  }
}
export const RETRIES = 5;
/** The longest pause Retry-After may ask for; a longer one is a wait of a minute. */
export const RETRY_PAUSE_MAX_S = 60;
/** A render that outlasts this is a hung socket, not a slow document: the
 *  API answers a render within its own timeout, far below this. */
export const RENDER_TIMEOUT_MS = 180_000;
export const USAGE_TIMEOUT_MS = 20_000;

export async function render(
  input: RenderInput,
  key: string,
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  /** Send an Idempotency-Key: the SHA-256 of the body as sent, so the API
   *  serves a repeat of this exact request without spending another document,
   *  and a body that differs (the cover's date, a halved image budget, a
   *  sample) gets a key of its own. Never the cache fingerprint, which leaves
   *  the date out: one key with two bodies is refused as idempotency_mismatch. */
  idempotent = false,
): Promise<RenderResult> {
  const body = JSON.stringify(requestBody(input));
  let idempotencyKey = idempotent ? createHash("sha256").update(body).digest("hex") : undefined;
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    response = await fetchImpl(`${apiUrl}/v1/render`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/pdf, application/json",
        "User-Agent": USER_AGENT,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body,
      signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
    });
    if (idempotencyKey && (await keyRefused(response))) {
      idempotencyKey = undefined; // once more, without the key: a new document
      continue;
    }
    if (!RETRY_STATUSES.includes(response.status) || attempt >= RETRIES) break;
    const after = Number(response.headers.get("retry-after"));
    await sleep((Number.isFinite(after) && after > 0 ? Math.min(after, RETRY_PAUSE_MAX_S) : 3) * 1000);
  }

  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      /* a non-JSON answer: the status alone is reported */
    }
    const { message, code } = describeFailure(response.status, payload);
    throw new RenderError(message, code, response.status);
  }

  const pdf = new Uint8Array(await response.arrayBuffer());
  if (pdf.length < 5 || String.fromCharCode(...pdf.subarray(0, 5)) !== "%PDF-") {
    throw new RenderError("legivel answered 200 but the body is not a PDF.", null, response.status);
  }
  const pages = Number(response.headers.get("x-legivel-pages"));
  return {
    pdf,
    pages: Number.isFinite(pages) && pages > 0 ? pages : null,
    resourcesFailed: response.headers.get("x-legivel-resources-failed"),
    replayed: response.headers.get("x-legivel-replay") === "true",
  };
}

/** The account's plan and page limit. Reading usage spends nothing. A
 *  failure here is not the build's: the result is simply unknown. */
export async function usage(key: string, apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<UsageInfo> {
  try {
    const response = await fetchImpl(`${apiUrl}/v1/usage`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
    if (!response.ok) return { plan: null, pagesMax: null, resourcesMb: null };
    const body = (await response.json()) as { plan?: unknown; limits?: { pages_max?: unknown; resources_mb?: unknown } };
    const plan = typeof body.plan === "string" ? body.plan : null;
    const pagesMax = typeof body.limits?.pages_max === "number" ? body.limits.pages_max : null;
    const resourcesMb = typeof body.limits?.resources_mb === "number" ? body.limits.resources_mb : null;
    return { plan, pagesMax, resourcesMb };
  } catch {
    return { plan: null, pagesMax: null, resourcesMb: null };
  }
}
