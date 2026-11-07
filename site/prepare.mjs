// Builds the docs site's content before Astro runs. Everything it writes is generated and ignored by git:
//   src/content/docs/   the pages, from docs/*.md, brand/README.md, site/content/ and the generated sections
//   src/assets/         the logo and mark, copied from brand/
//   src/styles/         the tokens and the two palettes, from brand/
//   public/favicon.svg  the mark
// docs/ stays the one place the guides are written, so they read the same on GitHub and on the site.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  expand,
  frontMatter,
  paletteCss,
  rewriteFrontMatterLinks,
  rewriteLinks,
  schemaReference,
  splitTitle,
  toolReference,
} from "./lib.mjs";
import { BASE, REPO } from "./site.config.mjs";

const site = fileURLToPath(new URL("./", import.meta.url));
const root = join(site, "..");
const docsOut = join(site, "src/content/docs");

/** Every doc that is on the site: its repository path, and where it goes. */
const PAGES = {
  "docs/clips.md": "guides/clips",
  "docs/comments-and-review.md": "guides/comments-and-review",
  "docs/editor.md": "guides/editor",
  "docs/export.md": "guides/export",
  "docs/lease.md": "guides/lease",
  "docs/placement.md": "guides/placement",
  "docs/presenter.md": "guides/presenter",
  "docs/style.md": "guides/style",
  "docs/voice.md": "guides/voice",
  "docs/tables-and-charts.md": "guides/tables-and-charts",
  "docs/PLAN.md": "project/plan",
  "brand/README.md": "project/brand",
};

/** Docs that are left off, and why. A link to one of these goes to the file on GitHub. */
const LEFT_OFF = {
  "docs/AUDIT_COLLAB_PLAN.md":
    "It is the plan for the controller session and the audit log, with open questions the user guides do not need.",
  "docs/HEADER_FOOTER_PLAN.md":
    "It is the plan for headers, footers, slide numbers and contents, with decisions the user guides do not need.",
  "docs/BRANDS_AND_PPTX.md":
    "It is the build record of the brands and PowerPoint work, with decisions the user guides do not need.",
  "docs/CONTENT_RANGE.md":
    "It is the build record of the content-range work, with decisions the user guides do not need.",
  "docs/EDITOR_REMAKE.md":
    "It is the build record of the editor remake, with internals and decisions that the user guides do not need.",
  "docs/IMAGES.md":
    "It is the plan and build record of the images work, with decisions the user guides do not need.",
  "docs/RESEARCH.md": "It quotes forum posts by handle. Remove those before it is public.",
  "docs/TRIAL.md":
    "It compares Depthcue with two other projects from single runs. Check the claims for fairness before it is public.",
};

const read = (path) => readFileSync(join(root, path), "utf8");
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
};

/** A page's address from where it is written: "guides/clips" is "/guides/clips/". */
const addressOf = (slug) => (slug === "index" ? "/" : `/${slug}/`);
const pages = Object.fromEntries(Object.entries(PAGES).map(([path, slug]) => [path, addressOf(slug)]));

// A doc that is on neither list is a mistake worth stopping for: it would be missing from the site without a sign.
for (const name of readdirSync(join(root, "docs")).filter((file) => file.endsWith(".md"))) {
  const path = `docs/${name}`;
  if (!(path in PAGES) && !(path in LEFT_OFF)) {
    throw new Error(
      `${path} is not on the site. Add it to PAGES, or to LEFT_OFF with a reason, in site/prepare.mjs.`,
    );
  }
}

const generated = {
  "cli-help": () => {
    const cli = join(root, "packages/cli/dist/main.js");
    const run = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    const text = `${run.stdout}${run.stderr}`.trimEnd();
    if (!text.startsWith("Usage:"))
      throw new Error(`depthcue --help did not print its usage. Build the cli first.\n${text}`);
    return `\`\`\`text\n${text}\n\`\`\``;
  },
  "mcp-tools": () => {
    const entry = join(root, "packages/mcp/dist/index.js");
    // The server is imported, not started: only its descriptions are read.
    return import(pathToFileURL(entry).href).then((mcp) => toolReference(mcp.TOOL_DESCRIPTIONS));
  },
  "schema-fields": () => {
    const schema = (name) => JSON.parse(read(`packages/core/schema/${name}.schema.json`));
    return schemaReference({ deck: schema("deck"), scene: schema("scene") });
  },
};

// The MCP section is async because it imports the built server, so resolve every generator up front.
const resolved = Object.fromEntries(
  await Promise.all(Object.entries(generated).map(async ([name, make]) => [name, await make()])),
);
const generators = Object.fromEntries(Object.entries(resolved).map(([name, text]) => [name, () => text]));

rmSync(docsOut, { recursive: true, force: true });

// Pages written by hand for the site.
function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const full = join(directory, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
for (const file of walk(join(site, "content"))) {
  const path = relative(join(site, "content"), file).replaceAll("\\", "/");
  const text = expand(readFileSync(file, "utf8"), { read, generated: generators, path });
  const linked = rewriteLinks(text, { from: `site/content/${path}`, pages, base: BASE, repo: REPO });
  write(join(docsOut, path), rewriteFrontMatterLinks(linked, BASE));
}

// Docs that live in the repository, with their own heading taken as the page title.
for (const [path, slug] of Object.entries(PAGES)) {
  const { title, body } = splitTitle(read(path), path);
  const text = expand(body, { read, generated: generators, path });
  write(
    join(docsOut, `${slug}.md`),
    frontMatter({ title }) + rewriteLinks(text, { from: path, pages, base: BASE, repo: REPO }),
  );
}

// What the theme draws with.
const assets = join(site, "src/assets");
for (const name of ["logo", "logo-on-dark", "mark", "mark-on-dark"]) {
  mkdirSync(assets, { recursive: true });
  copyFileSync(join(root, `brand/${name}.svg`), join(assets, `${name}.svg`));
}
mkdirSync(join(site, "public"), { recursive: true });
copyFileSync(join(root, "brand/mark.svg"), join(site, "public/favicon.svg"));
mkdirSync(join(site, "src/styles"), { recursive: true });
copyFileSync(join(root, "brand/tokens.css"), join(site, "src/styles/tokens.css"));
write(join(site, "src/styles/palette.css"), paletteCss(JSON.parse(read("brand/tokens.json"))));

console.log(
  `site: wrote ${Object.keys(PAGES).length} docs and the pages in site/content to site/src/content/docs`,
);
