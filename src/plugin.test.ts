import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { collectOutline, collectPages, selectVersion, type VersionLike } from "./collect.js";
import { buildDocument, imageMime, pageBody, slugify, underSite, type BodyContext } from "./document.js";
import { join } from "node:path";
import legivelPdfPlugin from "./index.js";
import { resolveOptions, signFromEnv } from "./options.js";
import { describeFailure, render, RenderError, requestBody, RETRIES, RETRY_PAUSE_MAX_S } from "./render.js";

const doc = (id: string, title = id, extra: Partial<{ frontMatter: Record<string, unknown>; permalink: string }> = {}) => ({
  id,
  title,
  description: "",
  source: `@site/docs/${id}.md`,
  permalink: extra.permalink ?? `/docs/${id}`,
  frontMatter: extra.frontMatter ?? {},
});

const VERSION: VersionLike = {
  versionName: "current",
  docs: [doc("intro", "Introduction"), doc("guides/install", "Install"), doc("guides/run", "Run"), doc("api/render", "Render"), doc("hidden"), doc("draft"), doc("internal/notes", "Notes"), doc("skip", "Skip", { frontMatter: { pdf: false } })],
  sidebars: {
    docs: [
      { type: "doc", id: "intro" },
      { type: "category", label: "Guides", link: { type: "doc", id: "guides/install" }, items: [{ type: "doc", id: "guides/run" }, { type: "link", href: "https://x", label: "x" }] },
      { type: "doc", id: "internal/notes" },
      { type: "doc", id: "skip" },
    ],
    api: [{ type: "category", label: "API", link: { type: "generated-index", title: "The API", description: "Every call." }, items: [{ type: "doc", id: "api/render" }, { type: "doc", id: "intro" }] }],
  },
};
VERSION.docs[4]!.unlisted = true;
VERSION.docs[5]!.draft = true;

const SITE = { siteDir: "/site", url: "https://docs.example.com", baseUrl: "/", title: "Example", tagline: "Docs for the example." };
const ids = (entries: { kind: string; doc?: { id: string }; label?: string }[]) => entries.map((e) => (e.kind === "page" ? e.doc!.id : `[${e.label}]`));

describe("collecting the outline", () => {
  test("walks every sidebar in order, a category's link doc before its items, each doc once; a category without a page is an entry", () => {
    const entries = collectOutline(VERSION, { sections: null, exclude: [] });
    expect(ids(entries)).toEqual(["intro", "guides/install", "guides/run", "internal/notes", "[API]", "api/render"]);
    const api = entries[4]!;
    expect(api).toMatchObject({ kind: "category", label: "API", title: "The API", description: "Every call.", depth: 0, trail: [] });
    expect(entries[5]).toMatchObject({ depth: 1, trail: ["API"] });
  });

  test("records depth and the category trail", () => {
    const pages = collectPages(VERSION, null);
    expect(pages.find((p) => p.doc.id === "guides/run")).toMatchObject({ sidebar: "docs", depth: 1, trail: ["Guides"] });
    expect(pages.find((p) => p.doc.id === "guides/install")).toMatchObject({ depth: 0, trail: [] });
  });

  test("sections pick sidebars by id or docs by id prefix; exclude drops ids or prefixes; pdf: false drops a page", () => {
    expect(collectPages(VERSION, ["api"]).map((p) => p.doc.id)).toEqual(["api/render", "intro"]);
    expect(collectPages(VERSION, ["guides/"]).map((p) => p.doc.id)).toEqual(["guides/install", "guides/run"]);
    expect(collectPages(VERSION, null, ["internal/"]).map((p) => p.doc.id)).not.toContain("internal/notes");
    expect(collectPages(VERSION, null).map((p) => p.doc.id)).not.toContain("skip");
    // A category whose pages are all excluded is no entry.
    expect(ids(collectOutline(VERSION, { sections: null, exclude: ["api/"] }))).not.toContain("[API]");
  });

  test("drafts and unlisted docs stay out", () => {
    const got = collectPages(VERSION, null).map((p) => p.doc.id);
    expect(got).not.toContain("hidden");
    expect(got).not.toContain("draft");
  });

  test("the version: the one the site shows by default, or the one named", () => {
    const current = { ...VERSION, versionName: "current", label: "Next" };
    const released = { ...VERSION, versionName: "2.0", label: "2.0", isLast: true };
    expect(selectVersion({ loadedVersions: [current, released] }, null).versionName).toBe("2.0");
    expect(selectVersion({ loadedVersions: [current, released] }, "Next").versionName).toBe("current");
    expect(selectVersion({ loadedVersions: [VERSION] }, null).versionName).toBe("current");
    expect(() => selectVersion({ loadedVersions: [current, released] }, "3.0")).toThrow(/no docs version "3.0"; the site has "current" \(Next\), "2.0"/);
  });
});

describe("the joined document", () => {
  const page = { kind: "page" as const, doc: doc("guides/run", "Run"), sidebar: "docs", depth: 1, trail: ["Guides"] };
  const ctx = (notes: string[] = [], exported = new Set(["guides/run", "guides/install", "intro"])): BodyContext => ({ site: SITE, docs: VERSION.docs, exported, notes, embedImage: (path) => (path.endsWith("logo.png") ? "data:image/png;base64,AAA" : null) });

  test("drops front matter and imports, sits headings under the page, keeps fences whole, reports what it left out with the file", () => {
    const notes: string[] = [];
    const raw = `---\ntitle: Run\nsidebar_position: 2\n---\nimport Thing from '@site/src/Thing';\n\n# Run it\n\nText.\n\n## Steps\n\n### Detail\n\n\`\`\`md\n# not a heading\n\`\`\`\n\n<Thing prop="x">inside</Thing>\n\n<Other />\n`;
    const body = pageBody(raw, page, ctx(notes), 2);
    expect(body).not.toContain("sidebar_position");
    expect(body).not.toContain("import Thing");
    expect(body).not.toContain("Run it");
    expect(body).toContain("### Steps");
    expect(body).toContain("#### Detail");
    expect(body).toContain("\`\`\`md\n# not a heading\n\`\`\`");
    expect(body).not.toContain("<Thing");
    expect(body).not.toContain("<Other");
    expect(notes).toEqual([
      "guides/run (docs/guides/run.md): an import or export line was removed.",
      "guides/run (docs/guides/run.md): a <Thing> component was left out; the PDF has no equivalent.",
      "guides/run (docs/guides/run.md): a component was left out: <Other />…",
    ]);
  });

  test("tabs keep every tab under its label; admonitions become a quoted block with a bold first line", () => {
    const raw = `<Tabs>\n  <TabItem value="linux" label="Linux">Use systemd.</TabItem>\n  <TabItem value="mac">Use launchd.\n\n\`\`\`sh\nbrew install x\n\`\`\`\n  </TabItem>\n</Tabs>\n\n:::tip Fast path\nUse the CLI.\n\n\`\`\`sh\ngrid up\n\`\`\`\n:::\n\n:::warning\nMind the gap.\n:::\n`;
    const body = pageBody(raw, page, ctx(), 1);
    expect(body).toContain("**Linux**\n\nUse systemd.");
    expect(body).toContain("**mac**\n\nUse launchd.\n\n\`\`\`sh\nbrew install x\n\`\`\`");
    expect(body).not.toContain("<Tabs>");
    expect(body).toContain("> **Fast path**\n>\n> Use the CLI.\n>\n> \`\`\`sh\n> grid up\n> \`\`\`");
    expect(body).toContain("> **Warning**\n>\n> Mind the gap.");
  });

  test("a code block's title becomes a bold line; the other meta words go, the language stays", () => {
    const raw = `\`\`\`js title="src/app.js" showLineNumbers {2}\nconst a = 1;\n\`\`\`\n\n\`\`\`\nplain\n\`\`\`\n`;
    const body = pageBody(raw, page, ctx(), 1);
    expect(body).toBe("**src/app.js**\n\n\`\`\`js\nconst a = 1;\n\`\`\`\n\n\`\`\`\nplain\n\`\`\`");
  });

  test("images: relative and static paths embedded from disk, a site path not on disk loaded from the site, a missing relative one reported", () => {
    const notes: string[] = [];
    const raw = `![a](./logo.png) ![b](/img/logo.png) ![c](/img/other.svg) ![d](./missing.png) ![e](https://x/y.png)`;
    const body = pageBody(raw, page, ctx(notes), 1);
    expect(body).toBe("![a](data:image/png;base64,AAA) ![b](data:image/png;base64,AAA) ![c](https://docs.example.com/img/other.svg) *d* ![e](https://x/y.png)");
    expect(pageBody(`<img src="./logo.png" width="40" /> <img src="/img/x.png"> <img src="./gone.png">`, page, ctx(), 1)).toBe(`<img src="data:image/png;base64,AAA" width="40" /> <img src="https://docs.example.com/img/x.png"> `.trimEnd());
    // A tag that spans lines inside an admonition is rewritten before the quoting hides it.
    expect(pageBody(`:::note\n<img\n  src="/img/x.png"\n  style={{\n    width: 1,\n  }}\n/>\n:::\n`, page, ctx(), 1)).toBe(`> **Note**\n>\n> <img\n>   src="https://docs.example.com/img/x.png"\n> />`);
    // JSX attributes on HTML tags: a quoted value becomes plain, a number stays, an object goes; an <img> without a source goes.
    expect(pageBody(`<img src={'https://x/y.png'} width={200} style={{ border: 0 }} alt="a" /> <img> <div style={{color: "red"}}>t</div>`, page, ctx(), 1)).toBe(`<img src="https://x/y.png" width="200" alt="a" />  <div>t</div>`);
    expect(notes).toEqual(["guides/run (docs/guides/run.md): the image ./missing.png was not found next to the file; the PDF leaves it out."]);
  });

  test("an iframe becomes a link line: named by its title, else the host; a site path resolved; a frame without an address left out", () => {
    const notes: string[] = [];
    // The redux Examples page writes its sandboxes with no space between the attributes.
    const raw = [
      `Or check out the sandbox:`,
      ``,
      `<iframe class="codesandbox"src="https://codesandbox.io/embed/github/reduxjs/redux/tree/master/examples/counter/?codemirror=1"sandbox="allow-scripts"></iframe>`,
      ``,
      `<iframe width="560" src="//www.youtube.com/embed/abc" title="Intro [video]" allowFullScreen={true} />`,
      ``,
      `<iframe src="/guides/install"></iframe>`,
      ``,
      `<iframe class="empty"></iframe>`,
      ``,
      "```html",
      `<iframe src="https://kept.example/in-code"></iframe>`,
      "```",
    ].join("\n");
    expect(pageBody(raw, page, ctx(notes), 1)).toBe(
      [
        `Or check out the sandbox:`,
        ``,
        `Embedded content: [codesandbox.io](https://codesandbox.io/embed/github/reduxjs/redux/tree/master/examples/counter/?codemirror=1)`,
        ``,
        `Embedded content: [Intro \\[video\\]](https://www.youtube.com/embed/abc)`,
        ``,
        `Embedded content: [/guides/install](https://docs.example.com/guides/install)`,
        ``,
        "```html",
        `<iframe src="https://kept.example/in-code"></iframe>`,
        "```",
      ].join("\n"),
    );
    expect(notes).toEqual([
      "guides/run (docs/guides/run.md): an <iframe> became a link to https://codesandbox.io/embed/github/reduxjs/redux/tree/master/examples/counter/?codemirror=1.",
      "guides/run (docs/guides/run.md): an <iframe> became a link to https://www.youtube.com/embed/abc.",
      "guides/run (docs/guides/run.md): an <iframe> became a link to /guides/install.",
      "guides/run (docs/guides/run.md): an <iframe> without an address was left out.",
    ]);
  });

  test("every link works in the PDF: pages of the export by heading, everything else by its full address, the web as written", () => {
    const raw = `[a](./install.md) [b](../intro.mdx#who-this-is-for) [c](/docs/guides/install) [d](/docs/api/render) [e](https://x/) [f](#local) [g](mailto:a@b.c) [h](/blog/post?x=1#top) [i](../other/page.md) [j](//cdn.x/y) <a href="/pricing">p</a> <a href="#steps">s</a>`;
    const body = pageBody(raw, page, ctx(), 1);
    expect(body).toBe(
      "[a](#__doc:guides/install) [b](#__doc:intro#who-this-is-for) [c](#__doc:guides/install) [d](https://docs.example.com/docs/api/render) [e](https://x/) [f](#__doc:guides/run#local) [g](mailto:a@b.c) [h](https://docs.example.com/blog/post#top) [i](https://docs.example.com/docs/other/page) [j](//cdn.x/y) <a href=\"https://docs.example.com/pricing\">p</a> <a href=\"#__doc:guides/run#steps\">s</a>",
    );
  });

  test("the whole document: cover and contents as HTML, headings by depth, page breaks per chapter, doc links resolved to the engine's ids", () => {
    const files: Record<string, string> = {
      "/site/docs/intro.md": "# Hello\n\nWelcome. See [install](./guides/install.md) and [steps](guides/install#steps).\n\n## Who this is for\n\nYou.\n",
      "/site/docs/guides/install.md": "Install text.\n\n## Steps\n\nOne.\n",
      "/site/docs/guides/run.md": "Run text. Back to [intro](/docs/intro#who-this-is-for). Own [part](#steps).\n\n## Steps\n\nTwo.\n",
    };
    const read = (p: string) => {
      const key = p.replace(/\\/g, "/");
      if (!(key in files)) throw new Error("missing");
      return files[key]!;
    };
    const entries = collectOutline(VERSION, { sections: ["docs"], exclude: ["internal/"] });
    const built = buildDocument(entries, SITE, { cover: {}, language: "en", pageBreaks: "chapters", versionLabel: "2.0" }, new Date(Date.UTC(2026, 9, 15)), read, VERSION.docs);
    expect(built.markdown.startsWith('---\ntitle: "Example"\nlanguage: en\n---\n')).toBe(true);
    expect(built.markdown).toMatch(/<p class="cover-title" style="[^"]*font-weight: 700[^"]*">Example<\/p>/);
    expect(built.markdown).toMatch(/<p class="cover-line" style="[^"]*">Version 2\.0<\/p>/);
    expect(built.markdown).not.toContain("<style>");
    expect(built.markdown).toContain("October 15, 2026</p>\n</div>\n\n\\newpage\n\n<p style=");
    expect(built.markdown).toContain(">Contents</p>\n\n[TOC]\n\n\\newpage\n\n# Introduction\n\nWelcome.");
    // Guides: the link page at level 1, its child at level 2 with its own heading one deeper; no page break before the child.
    expect(built.markdown).toContain("\\newpage\n\n# Install\n\nInstall text.\n\n## Steps\n\nOne.\n\n## Run\n\nRun text.");
    expect(built.markdown).toContain("### Steps\n\nTwo.");
    // Doc links: the page's heading id; the hash names a heading on that page, counted document-wide (the second «Steps» is steps-1).
    expect(built.markdown).toContain("See [install](#install) and [steps](#steps).");
    expect(built.markdown).toContain("Back to [intro](#who-this-is-for).");
    expect(built.markdown).toContain("Own [part](#steps-1).");
    expect(built.markdown.match(/^\\newpage$/gm)).toHaveLength(3);
    expect(built.pages.map((p) => p.id)).toEqual(["intro", "guides/install", "guides/run"]);
    expect(built.notes).toEqual([]);
  });

  test("a category without a page is a heading with its index description; pageBreaks: pages breaks before every entry", () => {
    const entries = collectOutline(VERSION, { sections: ["api"], exclude: [] });
    const built = buildDocument(entries, SITE, { cover: null, language: null, pageBreaks: "pages" }, new Date(), () => "Body.\n", VERSION.docs);
    expect(built.markdown).toContain("[TOC]\n\n\\newpage\n\n# The API\n\nEvery call.\n\n\\newpage\n\n## Render\n\nBody.\n\n\\newpage\n\n## Introduction\n\nBody.");
    expect(built.markdown).not.toContain("cover-title");
    expect(built.markdown).not.toContain("language:");
  });

  test("a missing source file is reported and skipped", () => {
    const built = buildDocument([page], SITE, { cover: null, language: null, pageBreaks: "chapters" }, new Date(), () => {
      throw new Error("ENOENT");
    });
    expect(built.pages).toEqual([]);
    expect(built.notes[0]).toBe("guides/run (docs/guides/run.md): the source file could not be read; the page is left out.");
  });

  test("an empty front matter goes; a partial is read in place; details become a bold summary and its text; a link to the site root resolves", () => {
    const notes: string[] = [];
    const c = ctx(notes, new Set(["guides/run", "home"]));
    c.read = (p) => (p.endsWith("_part.mdx") ? "---\n---\nFrom the partial, with [a link](./install.md).\n" : "");
    c.docs = [...VERSION.docs, doc("home", "Home", { permalink: "/" })];
    const raw = `---\n---\nimport Part from './_part.mdx';\n\n# Run\n\n<Part />\n\n<details>\n  <summary>More</summary>\n  Hidden text.\n</details>\n\nGo [home](/).\n`;
    const body = pageBody(raw, page, c, 1);
    expect(body).toBe("From the partial, with [a link](https://docs.example.com/docs/guides/install).\n\n**More**\n\nHidden text.\n\nGo [home](#__doc:home).");
    expect(notes).toEqual([]);
    // A partial outside the site folder is left out, reader or no reader.
    const outside = pageBody("import Secret from '../../../_secret.mdx';\n\n# Run\n\n<Secret />\n", page, c, 1);
    expect(outside).toBe("");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/the partial .*_secret\.mdx is outside the site folder; left out\.$/);
  });

  test("images past the document's budget are left out with their alt text and one closing note", () => {
    const files: Record<string, string> = { "/site/docs/intro.md": "![one](./a.png) ![two](./b.png) ![three](./c.png)\n" };
    const entries = collectOutline({ ...VERSION, sidebars: { docs: [{ type: "doc", id: "intro" }] } }, { sections: null, exclude: [] });
    const sizes: Record<string, number> = { "a.png": 600, "b.png": 600, "c.png": 100 };
    const embedImage = (path: string, images?: BodyContext["images"]) => {
      const bytes = sizes[path.split("/").pop()!] ?? 0;
      if (images && images.spent + bytes > images.budget) {
        images.leftOut++;
        return "budget" as const;
      }
      if (images) images.spent += bytes;
      return `data:image/png;base64,${path.split("/").pop()}`;
    };
    const built = buildDocument(entries, SITE, { cover: null, language: null, pageBreaks: "chapters", imageBudget: 1000 }, new Date(), (p) => files[p.replace(/\\/g, "/")]!, VERSION.docs, embedImage);
    expect(built.markdown).toContain("![one](data:image/png;base64,a.png) *two* ![three](data:image/png;base64,c.png)");
    expect(built.notes).toEqual([
      "intro (docs/intro.md): the image ./b.png is left out; the document's images would pass the plan's limit.",
      "1 image left out: the plan allows 0 MB of images per document and 0.0 MB are embedded. Smaller images, or a plan with a higher limit, bring them back.",
    ]);
  });

  test("the engine's heading ids", () => {
    const counts = new Map<string, number>();
    expect(slugify("Install a node", counts)).toBe("install-a-node");
    expect(slugify("Install a node", counts)).toBe("install-a-node-1");
    expect(slugify("API: /v1/render (POST)", counts)).toBe("api-v1render-post");
    expect(slugify("snake_case-name", counts)).toBe("snake_case-name");
  });
});

describe("code is never rewritten (review of 20 Oct)", () => {
  const page = { kind: "page" as const, doc: doc("guides/run", "Run"), sidebar: "docs", depth: 1, trail: ["Guides"] };
  const ctx = (notes: string[] = []): BodyContext => ({ site: SITE, docs: VERSION.docs, exported: new Set(["guides/run", "guides/install"]), notes, embedImage: () => "data:image/png;base64,AAA" });
  const sample = "```md\nimport x from './x';\n# x\n[a](./install.md) ![i](./logo.png)\n<Thing />\n```";
  const indented = sample.split("\n").map((line) => "  " + line).join("\n");

  test("a fence inside details, an admonition and a list item, and inline code, come out byte-identical", () => {
    const raw = `<details>\n<summary>More</summary>\n\n${sample}\n\n</details>\n\n:::tip\n${sample}\n:::\n\n- item\n\n${indented}\n\nUse \`[a](./install.md)\` and \`![x](./logo.png)\` and \`# not a heading\` as written.\n`;
    const body = pageBody(raw, page, ctx(), 1);
    expect(body).toContain(`**More**\n\n${sample}`);
    expect(body).toContain("> **Tip**\n>\n> " + sample.split("\n").join("\n> "));
    expect(body).toContain(indented);
    expect(body).toContain("Use `[a](./install.md)` and `![x](./logo.png)` and `# not a heading` as written.");
    expect(body).not.toContain("#__doc:");
    expect(body).not.toContain("data:image");
  });

  test("a partial that is itself a fenced mdx sample stays a sample", () => {
    const raw = "```mdx\nimport Snippet from './_snippet.mdx'\n\n<Snippet />\n```\n";
    const notes: string[] = [];
    expect(pageBody(raw, page, ctx(notes), 1)).toBe(raw.trim());
    expect(notes).toEqual([]);
  });

  test("a component used twice keeps the text between the uses; a nested same-name component is one block", () => {
    const notes: string[] = [];
    const raw = "<Highlight>green</Highlight> is the brand colour.\n\nA paragraph.\n\n## Heading\n\n<Highlight>red</Highlight>\n\n<Box>\n  <Box>inner</Box>\n  outer\n</Box>\n\nAfter.\n";
    const body = pageBody(raw, page, ctx(notes), 1);
    expect(body).toContain("is the brand colour.");
    expect(body).toContain("A paragraph.");
    expect(body).toContain("## Heading");
    expect(body).toContain("After.");
    expect(body).not.toContain("inner");
    expect(body).not.toContain("outer");
    expect(notes.filter((n) => n.includes("<Highlight>"))).toHaveLength(2);
    expect(notes.filter((n) => n.includes("<Box>"))).toHaveLength(1);
  });

  test("prose that starts with import or export stays; a multi-line export goes whole", () => {
    const notes: string[] = [];
    const raw = "import Tabs from '@theme/Tabs';\nimport {\n  A,\n  B,\n} from './parts';\n\nUse the menu to\nexport the data as CSV.\n\nimport duties apply at the border.\n\nexport const toc = [\n  { value: 'a' },\n];\n\nDone.\n";
    const body = pageBody(raw, page, ctx(notes), 1);
    expect(body).toBe("Use the menu to\nexport the data as CSV.\n\nimport duties apply at the border.\n\nDone.");
    expect(notes).toHaveLength(3);
  });
});

describe("the should-fix list of the review of 20 Oct", () => {
  const page = { kind: "page" as const, doc: doc("guides/run", "Run"), sidebar: "docs", depth: 1, trail: ["Guides"] };
  const ctx = (notes: string[] = [], embedImage: BodyContext["embedImage"] = (path) => (path.endsWith("logo.png") ? "data:image/png;base64,AAA" : null)): BodyContext => ({ site: SITE, docs: VERSION.docs, exported: new Set(["guides/run", "guides/install"]), notes, embedImage });

  test("heading ids are the engine's: made from the raw title; a link written as #part still finds its heading; {#custom-id} goes and is kept for links", () => {
    const built = buildDocument(
      [page, { kind: "page", doc: doc("guides/install", "Install"), sidebar: "docs", depth: 1, trail: ["Guides"] }],
      SITE,
      { cover: null, language: null, pageBreaks: "chapters" },
      new Date(0),
      (path) => (path.endsWith("run.md") ? "## my_option\n\n## See [the API](https://x.com/api)\n\n## Custom {#custom-id}\n\nLinks: [a](#my_option) [b](#see-the-api) [c](#custom-id) [d](./install.md#setup-steps)\n" : "## Setup steps\n"),
    );
    expect(built.markdown).toContain("## my_option\n");
    expect(built.markdown).toContain("## Custom\n");
    expect(built.markdown).not.toContain("{#custom-id}");
    expect(built.markdown).not.toContain("<!--");
    expect(built.markdown).toContain("[a](#my_option) [b](#see-the-apihttpsxcomapi) [c](#custom) [d](#setup-steps)");
  });

  test("the truncate marker goes; a heading deeper than six levels is noted once per page", () => {
    const notes: string[] = [];
    const deep = { ...page, depth: 4 };
    const body = pageBody("Intro.\n\n{/* truncate */}\n\n## Two\n\n### Three\n\n#### Four\n", deep, ctx(notes), 5);
    expect(body).not.toContain("truncate");
    expect(body).toContain("###### Two\n\n###### Three\n\n###### Four");
    expect(notes).toEqual(["guides/run (docs/guides/run.md): 2 headings deeper than the PDF's six levels sit at level six."]);
  });

  test("admonitions: the bracket title, a nested admonition, tabs inside; details nested", () => {
    const raw = ":::tip[My title]\nOuter.\n\n::::note\nInner.\n::::\n\n<Tabs>\n<TabItem value=\"a\" label=\"A\">\n\nIn A.\n\n</TabItem>\n</Tabs>\n:::\n\n<details>\n<summary>Outer</summary>\n\nText.\n\n<details>\n<summary>Inner</summary>\n\nDeep.\n\n</details>\n\nAfter inner.\n\n</details>\n";
    const body = pageBody(raw.replace("::::note\nInner.\n::::", ":::note\nInner.\n:::").replace(":::tip[My title]", "::::tip[My title]").replace("</Tabs>\n:::", "</Tabs>\n::::"), page, ctx(), 1);
    expect(body).toContain("> **My title**\n>\n> Outer.\n>\n> > **Note**\n> >\n> > Inner.\n>\n> **A**\n>\n> In A.");
    expect(body).toContain("**Outer**\n\nText.\n\n**Inner**\n\nDeep.\n\nAfter inner.");
  });

  test("the four image forms the review names reach the same place as a plain one", () => {
    const raw = "![r][ref]\n\n[ref]: ./logo.png\n\n<img src='./logo.png'>\n\n![](<./logo.png>)\n\n<picture><source srcset=\"./logo.png 1x, /img/x.png 2x\"><img src=\"./logo.png\"></picture>\n";
    const body = pageBody(raw, page, ctx(), 1);
    expect(body).toBe(
      "![r][ref]\n\n[ref]: data:image/png;base64,AAA\n\n<img src='data:image/png;base64,AAA'>\n\n![](data:image/png;base64,AAA)\n\n<picture><source srcset=\"data:image/png;base64,AAA 1x, https://docs.example.com/img/x.png 2x\"><img src=\"data:image/png;base64,AAA\"></picture>",
    );
  });

  test("JSX attributes: nested braces, a template literal, require().default; an object attribute goes whole", () => {
    const raw = "<img src={`./logo.png`} style={{a: {b: 1}}} width={200} alt=\"a\" />\n\n<img src={require('./logo.png').default} />\n";
    expect(pageBody(raw, page, ctx(), 1)).toBe('<img src="data:image/png;base64,AAA" width="200" alt="a" />\n\n<img src="data:image/png;base64,AAA" />');
  });

  test("an image outside the site folder, or a file that is not an image, is left out with a note", () => {
    const notes: string[] = [];
    const embed: BodyContext["embedImage"] = (path) => (path.endsWith("secret.png") ? "outside" : path.endsWith("fake.png") ? "not-image" : null);
    const body = pageBody("![s](../../secret.png) ![f](./fake.png)\n", page, ctx(notes, embed), 1);
    expect(body).toBe("*s* *f*");
    expect(notes).toEqual([
      "guides/run (docs/guides/run.md): the image ../../secret.png is outside the site folder; the PDF leaves it out.",
      "guides/run (docs/guides/run.md): the file ./fake.png is not an image; the PDF leaves it out.",
    ]);
  });

  test("underSite and imageMime: the real path must sit under the site; the head decides the format", () => {
    expect(imageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]), ".png")).toBe("image/png");
    expect(imageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), ".jpg")).toBe("image/jpeg");
    expect(imageMime(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), ".svg")).toBe("image/svg+xml");
    expect(imageMime(new TextEncoder().encode("SECRET=1\n"), ".png")).toBeNull();
    expect(underSite(import.meta.dir, join(import.meta.dir, ".."))).toBe(true);
    expect(underSite(join(import.meta.dir, "..", ".."), import.meta.dir)).toBe(false);
  });
});

describe("a site under a non-root baseUrl (review of 20 Oct)", () => {
  const site = { ...SITE, baseUrl: "/proj/" };
  const docs = VERSION.docs.map((d) => ({ ...d, permalink: `/proj${d.permalink}` }));
  const page = { kind: "page" as const, doc: { ...doc("guides/run", "Run"), permalink: "/proj/docs/guides/run" }, sidebar: "docs", depth: 1, trail: ["Guides"] };
  const ctx = (exported: string[]): BodyContext => ({ site, docs, exported: new Set(exported), notes: [], embedImage: () => null });

  test("a site-path link to an exported page is a link inside the PDF; one to a page left out carries the base once", () => {
    const raw = "[intro](/proj/docs/intro) [install](/proj/docs/guides/install) [rel](./install.md) [other](/proj/other) [root](/)\n";
    expect(pageBody(raw, page, ctx(["guides/run", "intro"]), 1)).toBe(
      "[intro](#__doc:intro) [install](https://docs.example.com/proj/docs/guides/install) [rel](https://docs.example.com/proj/docs/guides/install) [other](https://docs.example.com/proj/other) [root](https://docs.example.com/proj/)",
    );
    expect(pageBody("[install](./install.md)\n", page, ctx(["guides/run", "guides/install"]), 1)).toBe("[install](#__doc:guides/install)");
  });
});

describe("the plugin entry (review of 20 Oct)", () => {
  const allContent = (plans: Record<string, string | null>) => ({
    "docusaurus-plugin-content-docs": { default: { loadedVersions: [VERSION] } },
    "docusaurus-plugin-legivel": Object.fromEntries(Object.entries(plans).map(([id, plan]) => [id, { plan }])),
  });
  const context = (locale: string | null) => ({ siteConfig: { title: "Example" }, i18n: locale ? { currentLocale: locale } : undefined }) as unknown as Parameters<typeof legivelPdfPlugin>[0];
  const run = (plugin: ReturnType<typeof legivelPdfPlugin>, content: ReturnType<typeof allContent>) => {
    const data: unknown[] = [];
    (plugin as unknown as { allContentLoaded: (a: unknown) => void }).allContentLoaded({ allContent: content, actions: { setGlobalData: (d: unknown) => data.push(d) } });
    return data as { credit: boolean }[];
  };

  const keyed = { keyEnv: "LEGIVEL_TEST_KEY" };
  process.env.LEGIVEL_TEST_KEY = "lgvl_test";

  test("a locale the export leaves out gets no button data; an exported one does", () => {
    expect(run(legivelPdfPlugin(context("fr"), { ...keyed, locales: ["en"] }), allContent({ default: "pro" }))).toHaveLength(0);
    expect(run(legivelPdfPlugin(context("en"), { ...keyed, locales: ["en"] }), allContent({ default: "pro" }))).toHaveLength(1);
    expect(run(legivelPdfPlugin(context(null), keyed), allContent({ default: "pro" }))).toHaveLength(1);
  });

  test("a build without the key gets no button data either: no PDF, no link (re-review of 22 Oct)", () => {
    expect(run(legivelPdfPlugin(context(null), { keyEnv: "LEGIVEL_TEST_NO_KEY" }), allContent({ default: null }))).toHaveLength(0);
  });

  test("a build without the key makes no PDF and does not fail (review of 20 Oct)", async () => {
    const plugin = legivelPdfPlugin(context(null), { keyEnv: "LEGIVEL_TEST_NO_KEY" });
    run(plugin, allContent({ default: null }));
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => void lines.push(line);
    try {
      await (plugin as unknown as { postBuild: (a: unknown) => Promise<void> }).postBuild({ outDir: "/tmp/none", siteConfig: { url: "https://x", baseUrl: "/", title: "X" }, siteDir: "/tmp/none", i18n: null });
    } finally {
      console.log = original;
    }
    expect(lines.join("\n")).toContain("no API key: the LEGIVEL_TEST_NO_KEY environment variable is not set, so this build makes no PDF.");
  });

  test("the credit line goes only on a plan shown to be paid, read from this instance", () => {
    expect(run(legivelPdfPlugin(context(null), { ...keyed, credit: false }), allContent({ default: "pro" }))[0]!.credit).toBe(false);
    expect(run(legivelPdfPlugin(context(null), { ...keyed, credit: false }), allContent({ default: "free" }))[0]!.credit).toBe(true);
    expect(run(legivelPdfPlugin(context(null), { ...keyed, credit: false }), allContent({ default: null }))[0]!.credit).toBe(true);
    expect(run(legivelPdfPlugin(context(null), { ...keyed, credit: false, id: "pdf2" } as never), allContent({ default: "pro", pdf2: "free" }))[0]!.credit).toBe(true);
    expect(run(legivelPdfPlugin(context(null), { ...keyed, credit: false, id: "pdf2" } as never), allContent({ default: "free", pdf2: "pro" }))[0]!.credit).toBe(false);
  });
});

describe("options", () => {
  test("defaults", () => {
    const o = resolveOptions(undefined);
    expect(o).toEqual({ sections: null, exclude: [], version: null, locales: null, pageBreaks: "chapters", modules: false, pages: false, themes: ["light"], button: true, credit: true, cover: {}, filename: "docs.pdf", page: {}, features: {}, resources: "lenient", language: null, sign: null, rebuild: true, source: true, docsPluginId: "default", apiUrl: "https://api.legivel.com", keyEnv: "LEGIVEL_API_KEY" });
  });

  test("a key in the config is refused with the way to do it", () => {
    expect(() => resolveOptions({ apiKey: "lgvl_x" })).toThrow(/LEGIVEL_API_KEY environment variable, never from the config/);
  });

  test("sign: a stored certificate by name in the config; a bundle or a password only from the environment (review of 20 Oct)", () => {
    expect(resolveOptions({ sign: { certificate: "acme-2026", reason: "Handbook" } }).sign).toEqual({ certificate: "acme-2026", reason: "Handbook" });
    expect(() => resolveOptions({ sign: { p12: "MIIK…", password: "x" } })).toThrow(/"sign.p12" is a secret and must not sit in docusaurus.config.js/);
    expect(() => resolveOptions({ sign: { certificate: "a", p12: "x" } })).toThrow(/sign.p12/);
    expect(() => resolveOptions({ sign: { reason: "x" } })).toThrow(/"sign.certificate" must name a certificate/);
    expect(signFromEnv(null, {})).toBeNull();
    expect(signFromEnv({ certificate: "a" }, {})).toEqual({ certificate: "a" });
    expect(signFromEnv(null, { LEGIVEL_SIGN_P12: "MIIK", LEGIVEL_SIGN_PASSWORD: "pw" })).toEqual({ p12: "MIIK", password: "pw" });
    expect(() => signFromEnv(null, { LEGIVEL_SIGN_P12: "MIIK" })).toThrow(/LEGIVEL_SIGN_PASSWORD is not/);
    expect(() => signFromEnv({ certificate: "a" }, { LEGIVEL_SIGN_P12: "MIIK", LEGIVEL_SIGN_PASSWORD: "pw" })).toThrow(/use one/);
  });

  test("each option is checked with a sentence", () => {
    expect(() => resolveOptions({ filename: "out/docs.pdf" })).toThrow(/without a folder/);
    expect(() => resolveOptions({ appearance: { theme: "dark" } })).toThrow(/unknown option "appearance".*under "page" and "features"/);
    expect(() => resolveOptions({ page: { theme: "dark" } })).toThrow(/"page" takes size, margin, header, footer, numbering, first; not "theme"/);
    expect(() => resolveOptions({ features: { math: 1 } })).toThrow(/"features.math" must be true, false or a word/);
    expect(() => resolveOptions({ features: { embed_source: false } })).toThrow(/set source: false/);
    expect(() => resolveOptions({ output: "json" })).toThrow(/set by the plugin/);
    expect(() => resolveOptions({ rebuild: "no" })).toThrow(/"rebuild" must be true/);
    expect(() => resolveOptions({ pageBreaks: "never" })).toThrow(/"pageBreaks" must be "chapters"/);
    expect(() => resolveOptions({ themes: ["blue"] })).toThrow(/"themes" must be/);
    expect(() => resolveOptions({ themes: ["light", "light"] })).toThrow(/"themes" must be/);
    expect(() => resolveOptions({ features: { theme: "dark" } })).toThrow(/"features.theme" is set by the "themes" option/);
    expect(() => resolveOptions({ modules: ["", "x"] })).toThrow(/"modules" must be true/);
    expect(resolveOptions({ modules: ["Guides"], pages: true, themes: ["light", "dark"], button: false, credit: false })).toMatchObject({ modules: ["Guides"], pages: true, themes: ["light", "dark"], button: false, credit: false });
    expect(() => resolveOptions({ exclude: "x" })).toThrow(/"exclude" must be a list/);
    expect(() => resolveOptions({ locales: ["en", 2] })).toThrow(/"locales" must be a list/);
    expect(resolveOptions({ version: "2.0", locales: ["en"], exclude: ["internal/"], pageBreaks: "pages" })).toMatchObject({ version: "2.0", locales: ["en"], exclude: ["internal/"], pageBreaks: "pages" });
    expect(resolveOptions({ page: { size: "A5", numbering: "i" }, features: { math: false }, sign: { certificate: "ops" } })).toMatchObject({ page: { size: "A5", numbering: "i" }, features: { math: false }, sign: { certificate: "ops" } });
    expect(() => resolveOptions({ resources: "loose" })).toThrow(/"lenient" or "strict"/);
    expect(() => resolveOptions({ apiUrl: "http://api.legivel.com" })).toThrow(/https origin/);
    expect(() => resolveOptions({ apiUrl: "https://api.legivel.com/v1" })).toThrow(/https origin/);
    expect(resolveOptions({ apiUrl: "http://localhost:8080" }).apiUrl).toBe("http://localhost:8080");
    expect(() => resolveOptions({ language: "English" })).toThrow(/language tag/);
    expect(resolveOptions({ cover: false }).cover).toBeNull();
    expect(resolveOptions({ cover: { title: "Handbook" } }).cover).toEqual({ title: "Handbook", subtitle: undefined });
  });
});

describe("the render call", () => {
  const input = { markdown: "# A", filename: "docs.pdf", page: { size: "A4", footer: "Example docs" }, features: { theme: "dark" }, resources: "strict" as const, language: "en", sign: null, embedSource: true, bareFirstPage: true };

  test("the request body carries the document and the settings under the API's names, plus a manual's defaults", () => {
    expect(requestBody(input)).toEqual({
      markdown: "# A",
      filename: "docs.pdf",
      output: "pdf",
      resources: "strict",
      language: "en",
      features: { theme: "dark", embed_source: true },
      page: { size: "A4", footer: "Example docs", numbering: { text: "Page {page} of {pages}", position: "footer right" }, first: false },
    });
    // The number keeps the footer center when it is free, and moves left when the right is taken too.
    expect(requestBody({ ...input, page: {} }).page!.numbering).toBe("Page {page} of {pages}");
    expect(requestBody({ ...input, page: { footer: { center: "Docs", right: "v2" } } }).page!.numbering).toEqual({ text: "Page {page} of {pages}", position: "footer left" });
    // The author's own numbering and first-page choice win; no cover, no bare first page; source off leaves embed_source out.
    expect(requestBody({ ...input, page: { numbering: "i", first: true }, features: {}, language: null, embedSource: false, bareFirstPage: false, sign: { certificate: "ops" } })).toEqual({
      markdown: "# A",
      filename: "docs.pdf",
      output: "pdf",
      resources: "strict",
      page: { numbering: "i", first: true },
      sign: { certificate: "ops" },
    });
  });

  test("a failure names the status, the code, the API's sentence and the next step; never the key", () => {
    expect(describeFailure(422, { code: "resource_invalid", error: "An image could not be read.", reason: "truncated_header", resource_id: "e2", line: 9 }).message).toBe("legivel answered 422 resource_invalid: An image could not be read (reason truncated_header, resource e2, line 9).");
    const failure = describeFailure(401, { code: "unauthorized", error: 'The API key is missing or not valid. Send it as "Authorization: Bearer <key>".' });
    expect(failure.message).toBe('legivel answered 401 unauthorized: The API key is missing or not valid. Send it as "Authorization: Bearer <key>". Check the key in the environment variable; it starts with lgvl_ and is shown once on the API keys page.');
    expect(describeFailure(502, "<html>").message).toBe("legivel answered 502.");
  });

  test("sends the key in the Authorization header only and returns the PDF with its page count", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init: init! };
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), { status: 200, headers: { "x-legivel-pages": "12", "content-type": "application/pdf" } });
    }) as typeof fetch;
    const result = await render(input, "lgvl_secret", "https://api.example.com", fetchImpl);
    expect(result.pages).toBe(12);
    expect(result.pdf.length).toBe(6);
    expect(seen!.url).toBe("https://api.example.com/v1/render");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer lgvl_secret");
    expect(String(seen!.init.body)).not.toContain("lgvl_secret");
  });

  test("a busy service is tried again after the pause it names, then the PDF comes", async () => {
    let calls = 0;
    const waits: number[] = [];
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) return Response.json({ code: "queue_full", error: "The service is busy." }, { status: 503, headers: { "retry-after": "2" } });
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), { status: 200, headers: { "x-legivel-pages": "1" } });
    }) as typeof fetch;
    const result = await render(input, "lgvl_k", "https://api.legivel.com", fetchImpl, async (ms) => void waits.push(ms));
    expect(result.pages).toBe(1);
    expect(result.replayed).toBe(false);
    expect(calls).toBe(3);
    expect(waits).toEqual([2000, 2000]);
  });

  test("a pause is clamped to a minute, 502 and 504 are tried again, and the sixth answer is the last (review of 20 Oct)", async () => {
    let calls = 0;
    const waits: number[] = [];
    const fetchImpl = (async () => {
      calls++;
      return Response.json({ code: "queue_full", error: "Busy." }, { status: calls % 2 ? 502 : 504, headers: { "retry-after": "600" } });
    }) as typeof fetch;
    const error = await render(input, "lgvl_k", "https://api.legivel.com", fetchImpl, async (ms) => void waits.push(ms)).catch((e) => e);
    expect(error).toBeInstanceOf(RenderError);
    expect(calls).toBe(RETRIES + 1);
    expect(waits).toEqual(Array(RETRIES).fill(RETRY_PAUSE_MAX_S * 1000));
  });

  test("a key whose replays are used up is not retried: the request goes again at once without the key (re-review of 22 Oct)", async () => {
    const seen: (string | null)[] = [];
    const waits: number[] = [];
    const fetchImpl = (async (_url: string | URL | Request, i?: RequestInit) => {
      const headers = new Headers(i?.headers);
      seen.push(headers.get("idempotency-key"));
      if (headers.get("idempotency-key")) return Response.json({ code: "idempotency_replay_limit", error: "This key has been replayed as often as the plan allows." }, { status: 429, headers: { "retry-after": "30" } });
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), { status: 200, headers: { "x-legivel-pages": "1" } });
    }) as typeof fetch;
    const result = await render(input, "lgvl_k", "https://api.legivel.com", fetchImpl, async (ms) => void waits.push(ms), true);
    expect(result.pages).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[1]).toBeNull();
    expect(waits).toEqual([]);
  });

  test("a key the API no longer matches to its first render (422 idempotency_mismatch) goes again once without the key", async () => {
    const seen: (string | null)[] = [];
    const waits: number[] = [];
    const fetchImpl = (async (_url: string | URL | Request, i?: RequestInit) => {
      const headers = new Headers(i?.headers);
      seen.push(headers.get("idempotency-key"));
      if (headers.get("idempotency-key")) return Response.json({ code: "idempotency_mismatch", error: "This key was already used for different document or resource content." }, { status: 422 });
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), { status: 200, headers: { "x-legivel-pages": "1" } });
    }) as typeof fetch;
    const result = await render(input, "lgvl_k", "https://api.legivel.com", fetchImpl, async (ms) => void waits.push(ms), true);
    expect(result.pages).toBe(1);
    expect(result.replayed).toBe(false);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(seen[1]).toBeNull();
    expect(waits).toEqual([]);
  });

  test("the request without the key is the last: a second 422 fails the build with the API's sentence, and another 422 code is never sent again", async () => {
    let calls = 0;
    const stubborn = (async () => {
      calls++;
      return Response.json({ code: "idempotency_mismatch", error: "This key was already used for different document or resource content." }, { status: 422 });
    }) as typeof fetch;
    const error = await render(input, "lgvl_k", "https://api.legivel.com", stubborn, async () => {}, true).catch((e) => e);
    expect(error).toBeInstanceOf(RenderError);
    expect(error.code).toBe("idempotency_mismatch");
    expect(error.status).toBe(422);
    expect(calls).toBe(2);

    calls = 0;
    const other = (async () => {
      calls++;
      return Response.json({ code: "too_many_pages", error: "The document has more pages than the plan allows." }, { status: 422 });
    }) as typeof fetch;
    const refused = await render(input, "lgvl_k", "https://api.legivel.com", other, async () => {}, true).catch((e) => e);
    expect(refused).toBeInstanceOf(RenderError);
    expect(refused.code).toBe("too_many_pages");
    expect(calls).toBe(1);
  });

  test("every request carries a timeout, and the sent body's hash as its Idempotency-Key when asked", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL | Request, i?: RequestInit) => {
      init = i;
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), { status: 200 });
    }) as typeof fetch;
    await render(input, "lgvl_k", "https://api.legivel.com", fetchImpl, undefined, true);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBe(createHash("sha256").update(String(init?.body)).digest("hex"));
  });

  test("an API error becomes a RenderError with the code", async () => {
    const fetchImpl = (async () => Response.json({ code: "quota_exhausted", error: "No documents left this period." }, { status: 402 })) as typeof fetch;
    const error = await render(input, "lgvl_secret", "https://api.legivel.com", fetchImpl).catch((e) => e);
    expect(error).toBeInstanceOf(RenderError);
    expect(error.code).toBe("quota_exhausted");
    expect(error.message).toContain("402 quota_exhausted: No documents left this period.");
    expect(error.message).not.toContain("lgvl_secret");
  });
});
