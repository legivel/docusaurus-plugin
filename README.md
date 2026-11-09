# docusaurus-plugin-legivel

Export a Docusaurus site to one PDF at build time, through [legivel](https://legivel.com).

The plugin reads the docs sidebars, collects the pages in sidebar order, joins them into one document with a cover and a contents list, and sends it to the legivel API. The PDF lands in the build output next to `index.html`, so the site can link it.

## Setup

1. Create an API key on the [API keys page](https://legivel.com/account/api-keys). A Free account includes 100 documents a month.
2. Install the plugin:

   ```bash
   npm install --save-dev docusaurus-plugin-legivel
   ```

3. Add it to `docusaurus.config.js`:

   ```js
   plugins: [["docusaurus-plugin-legivel", { filename: "handbook.pdf" }]],
   ```

   Docusaurus also takes the short form `"legivel"`.

4. Build with the key in the environment:

   ```bash
   LEGIVEL_API_KEY=lgvl_… npm run build
   ```

5. Link the file from the site, for example a navbar item with `to: "/handbook.pdf"`.

Every PDF rendered counts as one document of the account's plan: the manual and each module on every build, or only when something changed with `rebuild: false`; each page PDF only when it changed. The build log ends with the count.

A build without the key (a pull request from a fork, a preview on a runner without secrets) still succeeds: the plugin says so in the log and makes no PDF.

## Options

| Option | Default | What it does |
|---|---|---|
| `filename` | `docs.pdf` | The file name in the build output. No folder, must end in `.pdf`. |
| `sections` | every sidebar | Sidebar ids, or doc id prefixes such as `guides/`, to include. |
| `exclude` | none | Doc ids, or doc id prefixes, to leave out. A page with `pdf: false` in its front matter stays out too. |
| `version` | the site's default | The docs version to export, by name (`current`) or label (`2.0`), for a versioned site. |
| `locales` | every locale | The locales that get a PDF. Docusaurus builds each locale on its own; each build writes its PDF into its own output. |
| `pageBreaks` | `chapters` | `chapters` starts a new page before each top-level sidebar entry; `pages` before every page. |
| `modules` | `false` | `true`: one PDF per top-level sidebar entry beside the manual, as `handbook-<entry>.pdf`; or a list of the entries wanted, by category label or doc id. |
| `pages` | `false` | `true`: one PDF per page under `handbook/<doc id>.pdf`, rendered again only when the page or a setting changed since the last build. |
| `themes` | `["light"]` | `["light", "dark"]` renders both; the dark files carry `-dark`. The button serves the one the visitor reads in. |
| `button` | `true` | A «Download PDF» button at the top of every docs page of the export: the page's own PDF when there is one, else its module's, else the manual. A page left out of the export (excluded, unlisted, not in a sidebar, or in a locale without a PDF) gets no button. |
| `credit` | `true` | The line «PDF made with legivel» under the button, linking to legivel.com. A Free account keeps it; a paid plan may set `false`. The PDF itself carries no credit. |
| `cover` | `true` | `true` for the site title and tagline, `false` for none, or `{ title, subtitle }`. |
| `page` | `{}` | The page settings of the API under their own names: `size` (`A4`, `Letter`, `A5 landscape`, `210mm 297mm`), `margin` (CSS order), `header`, `footer`, `numbering`, `first`. See the [render reference](https://legivel.com/docs/api/render). |
| `features` | `{}` | The feature switches of the API under their own names: `mermaid`, `math`, `archive`, `accessible`, `hyphenation`, … The theme is set by `themes`, which can render both. |
| `resources` | `lenient` | `lenient` leaves a missing image out; `strict` fails the build on it. |
| `language` | the site's locale | A language tag such as `en` or `de`; sets hyphenation and is written into the PDF. |
| `sign` | none | Seals the PDF with a certificate the account has stored, by name: `{ certificate: "name", reason: "…" }`. A bundle never goes in the config: set `LEGIVEL_SIGN_P12` (the PKCS#12 bundle, base64) and `LEGIVEL_SIGN_PASSWORD` in the environment instead. |
| `rebuild` | `true` | `true` renders the manual and the modules on every build, so the PDF never goes stale. `false` renders only when a page, a setting or the account's plan changed since the last build and reuses the last PDF otherwise; the cover's date alone does not count. Each locale keeps its own record. |
| `source` | `true` | Attaches the Markdown to the PDF as `document.md` (readable by AI agents and by any PDF reader's attachments pane) and saves it beside the PDF, as `handbook.md` next to `handbook.pdf`. |
| `docsPluginId` | `default` | The docs plugin instance to export when a site has several. |
| `keyEnv` | `LEGIVEL_API_KEY` | The environment variable that holds the key. |

The key is never an option: a key in the config is refused with a message that says where it belongs.

Defaults for a manual, where the config sets nothing else: the page number reads «Page X of Y», in the footer center or beside the footer text; the cover carries no header, footer or number; the language is the site's locale.

## Free accounts

A Free account renders up to 20 pages per document. When the manual is longer, the plugin renders the first chapters that fit (a chapter is a top-level sidebar entry with its children) and ends the PDF with a short note that the full manual needs a Starter plan. The build log says the same, with the page count. The tries that are refused for their length spend no document; the one PDF does.

## What the PDF contains

- The cover, when on, on a page of its own: the title, the subtitle, the version on a versioned site, the site address and the build date.
- A contents list with page numbers on the next page, and the PDF's bookmarks, both following the sidebar tree: a top-level entry is a chapter, its children sit under it. A category that links to a page puts that page first; a category without one is a heading of its own, with its generated index's description.
- Each chapter on a new page, in sidebar order, the page's own headings one level below its title. Drafts, unlisted pages, excluded pages stay out.
- Markdown as written: paragraphs, lists, tables, code blocks with their titles, diagrams in `mermaid` fences, math, images.
- Links: a link to a page of the export, or to a part of the same page, goes to its heading, custom `{#ids}` included; a link to anything else on the site (a page left out, a blog post, another docs instance, a relative path) carries the full address on the site; a link to another website stays as written. Reference-style links and images (`[text][ref]`, `[ref]: ./file`) are resolved the same way. A query string on a site link stays as written.
- Images with a path relative to the file, or a site path under `static/`, in Markdown, `<img>`, `<source srcset>` or a reference definition, embedded from disk at build time when the file sits under the site folder and its bytes are an image (a path that leads outside the site, or a file that is not an image, is left out with a note), up to the plan's resource allowance per document (nine tenths of it; the rest are left out with their alt text and one line in the log). A site path not on disk is loaded from the site's `url`. Should the converter still refuse the document for its size, the plugin halves the image budget and sends it again, down to no images; a refused try spends no document. A vector image the engine refuses without naming it, in lenient mode, makes the plugin send the document again without its embedded vector images, said in the log.
- The Markdown the PDF was made from, attached inside the PDF and saved beside it (`source: false` leaves both out).

## What becomes Markdown, and what is left out

Docusaurus pages are MDX. What has a plain reading becomes Markdown; the rest is left out and named in the build log with its file:

- `<Tabs>`: every tab's content stays, one tab after another, each under its label in bold.
- A partial imported from a Markdown file (`import Part from './_part.mdx'`, placed as `<Part />`) is read in place.
- `<details>` becomes its summary in bold and its text.
- An `<iframe>` (a sandbox, a video) cannot play on paper: it becomes one line, «Embedded content:» and a link to its address, named by its `title` or the host. The log names each one.
- A JSX attribute on an HTML tag (`<img src={'…'} width={200} style={{…}} />`) becomes a plain one; a template literal without `${}` and `require('./file.png').default` become the path; an object or another expression goes with its attribute.
- `:::note`, `:::tip`, `:::info`, `:::warning`, `:::danger`: a quoted block whose first line is the title (`:::tip[My title]` or `:::tip My title`), or the kind, in bold. One inside another (`::::`), tabs and details inside, all keep their place.
- A code block's `title="…"` becomes a bold line above the block; `showLineNumbers` and line marks go, the language stays.
- `import` and `export` statements are removed, multi-line ones whole; a line of prose that starts with one of those words stays. Code in a fence or a code span is never changed, wherever it sits. A JSX comment (`{/* truncate */}`) goes.
- Any other component (`<MyWidget />`, a JSX block) is removed with its content; the log names the component and the file.

Every change appears in the build log as `[legivel-pdf] <doc id> (<file>): …`.

## Errors

A failure stops the build with the API's own sentence and code, for example:

```
docusaurus-plugin-legivel: legivel answered 401 unauthorized: The API key is missing or not valid. Send it as "Authorization: Bearer <key>". Check the key in the environment variable; it starts with lgvl_ and is shown once on the API keys page.
```

The key never appears in the log, in an error or in the output. A busy service (429, 502, 503, 504) is tried again after the pause it names, a minute at most, up to five times; a request that gets no answer within three minutes fails the build rather than hanging it. Every render carries the hash of its request as its `Idempotency-Key`, so a repeat of the same document spends nothing; once a key's replays are used up (two per key on Free), the request goes again without the key and spends one document.

## Requirements

Docusaurus 3 with `@docusaurus/plugin-content-docs` (checked on 3.1.0 and 3.10.2), Node 18 or newer.

## A look at what is sent

`LEGIVEL_PDF_DEBUG=1` on the build keeps every document the plugin sends under `.docusaurus/legivel-pdf/debug/`.

## Development

`bun run typecheck` and `bun test` run the unit tests; CI runs them on every pull request. The end-to-end test builds the sample site in `e2e/site` against a real API and reads the PDF back. It needs a key and the API origin it belongs to, and each run spends one or two documents of that account:

```bash
LEGIVEL_API_URL=https://api.legivel.com LEGIVEL_API_KEY=lgvl_… bun run test:e2e
```

Logs and outputs land in `e2e/.out/`, the key masked.
