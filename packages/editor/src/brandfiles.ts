/**
 * The brand folder's files in the Brand panel: a logo or a font sent to the server, which checks its bytes and names it,
 * and a file nothing names any more taken out. The server's refusals are said as it words them. Each call runs as a save
 * does, and the store takes the answer in, so a file sent never makes unsaved work saved or saved work unsaved.
 */
import type { Brand } from "@depthcue/core";
import { h } from "@depthcue/player";
import type { BrandFileAnswer } from "./api.ts";
import { type BrandContext, hint, part } from "./brandbits.ts";
import { actionButton, fileButton } from "./fields.ts";

type Added = Extract<BrandFileAnswer, { ok: true }>;
type Faces = Exclude<NonNullable<Brand["fonts"]>, string>;
type Face = Faces["display"];
type FaceFile = NonNullable<Face["files"]>[number];
type Role = "display" | "body" | "mono";

/** What a file of each kind may be, for the file chooser. The server checks the bytes. */
export const ACCEPT = { logo: ".svg,.png", font: ".woff2,.woff,.ttf,.otf" } as const;

const CONFLICT = "The files changed on disk while you were editing. Reload them, or keep your version first.";

/**
 * Sends a file to the brand folder and hands what the server made of it to `then`. A refusal is said at the top of the
 * panel as the server words it. A file of that name with other bytes is replaced only when the person says so.
 */
export async function sendFile(
  ctx: BrandContext,
  kind: keyof typeof ACCEPT,
  file: File,
  then: (added: Added) => void,
  replace = false,
): Promise<void> {
  const { store } = ctx.host;
  if (store.status.conflict) return ctx.say(CONFLICT);
  ctx.say(`Adding ${file.name}…`);
  const answer = await store.brandFile((rev) => [
    `?kind=${kind}&name=${encodeURIComponent(file.name)}${replace ? `&replace=1&baseRev=${rev}` : ""}`,
    file,
  ]);
  if (answer.ok) {
    ctx.say(undefined);
    then(answer);
    return;
  }
  ctx.say(
    answer.message,
    answer.error === "exists" && !replace
      ? actionButton("Replace it", () => void sendFile(ctx, kind, file, then, true), {
          "data-field": "brand:file:replace",
        })
      : undefined,
  );
}

/** Takes a file out of the brand folder. The files on disk must not name it, so unsaved edits are saved first. */
async function removeFile(ctx: BrandContext, path: string): Promise<void> {
  const { store, session } = ctx.host;
  if (store.status.conflict) return ctx.say(CONFLICT);
  if (session.dirty) await store.save();
  if (session.dirty) return ctx.say(store.status.message ?? "Save the deck first, then delete the file.");
  const answer = await store.brandFile((rev) => ["/remove", JSON.stringify({ path, baseRev: rev })]);
  ctx.say(answer.ok ? undefined : answer.message);
}

/** Whether brand.json or a template names a file, by its path in brand/, compared without case as the server does. */
const named = (ctx: BrandContext, path: string): boolean =>
  JSON.stringify([ctx.session.doc.brand, ctx.session.doc.templates])
    .toLowerCase()
    .includes(JSON.stringify(path).toLowerCase());

/** The files in one folder of the brand's, each one nothing names with a Delete that asks first. */
export function filesPart(ctx: BrandContext, folder: "logos" | "fonts"): HTMLElement {
  const paths = [...(ctx.session.doc.brandFiles ?? [])]
    .map((path) => path.slice("brand/".length))
    .filter((path) => path.startsWith(`${folder}/`))
    .sort();
  const rows = paths.map((path) =>
    h(
      "li",
      { "data-file": path },
      h("code", {}, path.slice(folder.length + 1)),
      named(ctx, path)
        ? h("span", { class: "ed-hint-text" }, "In use")
        : actionButton(
            "Delete",
            () =>
              ctx.say(
                `Delete brand/${path}? Nothing in the brand names it, and Undo does not bring it back.`,
                actionButton("Delete the file", () => void removeFile(ctx, path), {
                  "data-field": "brand:file:delete",
                }),
              ),
            { "data-field": `brand:file:${path}:remove`, "aria-label": `Delete ${path}` },
          ),
    ),
  );
  return part(
    "Files in the brand folder",
    rows.length > 0 ? h("ul", { class: "ed-brand-files" }, ...rows) : hint("None yet."),
  );
}

/** A role a new family of faces takes, by what the person picks. */
const ROLES: Record<string, string> = {
  both: "Headings and text",
  display: "Headings",
  body: "Text",
  mono: "Code and labels",
};

/** The weight a font says, as a brand names it: a hundred from 100 to 900. */
const weightOf = (weight: number) => Math.min(900, Math.max(100, Math.round(weight / 100) * 100));

/** Adds a font file to the brand: to the face of its family, or as a new face in the roles chosen. */
function takeFont(ctx: BrandContext, added: Added): void {
  const { family = "", weight = 400, italic = false } = added.sniffed ?? {};
  const fonts = ctx.brand().fonts;
  const own = typeof fonts === "object" ? fonts : undefined;
  const roles: Role[] = ["display", "body", "mono"];
  const same = roles.filter((role) => own?.[role]?.family === family);
  const license = (same.length > 0 && own?.[same[0] as Role]?.license) || ctx.state.license?.trim();
  if (!license) {
    ctx.say(
      `brand/${added.path} is in the brand folder now. A face the deck carries needs its license: write it under License, then add the file again.`,
    );
    return;
  }
  const entry: FaceFile = {
    file: added.path,
    weight: weightOf(weight) as FaceFile["weight"],
    style: italic ? "italic" : "normal",
  };
  const face = (was: Face | undefined): Face => ({
    family,
    license,
    files: [
      ...(was?.files ?? []).filter((file) => file.weight !== entry.weight || file.style !== entry.style),
      entry,
    ].sort((a, b) => a.weight - b.weight || a.style.localeCompare(b.style)),
  });
  const chosen = ctx.state.role ?? "both";
  const to: Role[] =
    same.length > 0 ? same : !own || chosen === "both" ? ["display", "body"] : [chosen as Role];
  const next: Faces = own
    ? { ...own }
    : {
        display: face(undefined),
        body: face(undefined),
        fallback: ctx.session.doc.deck.fonts ?? "editorial",
      };
  if (typeof fonts === "string") next.fallback = fonts;
  for (const role of to) next[role] = face(own?.[role]?.family === family ? own[role] : undefined);
  ctx.run([{ op: "brand.set", set: { fonts: next } }]);
}

/**
 * Adding a font file: the server reads its family, weight and style, and the file joins the face of its family or makes
 * a new one, with the license written here, in the roles chosen. The first one makes the brand's own faces.
 */
export function fontFilePart(ctx: BrandContext): HTMLElement {
  const fonts = ctx.brand().fonts;
  const own = typeof fonts === "object" ? fonts : undefined;
  const license = h("input", {
    type: "text",
    "data-field": "brand:fonts:file-license",
    maxlength: 120,
    spellcheck: false,
    placeholder: "OFL-1.1",
  });
  // Never filled in from the faces there: a new family's license is the person's to state, not the editor's to guess.
  license.value = ctx.state.license ?? "";
  license.addEventListener("input", () => {
    ctx.state.license = license.value;
  });
  const role = h(
    "select",
    { "data-field": "brand:fonts:file-role" },
    ...Object.entries(ROLES).map(([value, label]) => h("option", { value }, label)),
  );
  role.value = ctx.state.role ?? "both";
  role.addEventListener("change", () => {
    ctx.state.role = role.value;
  });
  return part(
    "Add a font file",
    hint(
      own
        ? "WOFF2, WOFF, TrueType or OpenType. A file of a family the brand has joins that face; a new family takes the role chosen here."
        : "WOFF2, WOFF, TrueType or OpenType. The first file makes the brand's own faces, for headings and text, with the pair to fall back on while they load.",
    ),
    h(
      "div",
      { class: "ed-brand-props" },
      h("div", { class: "ed-field" }, h("label", {}, h("span", { class: "ed-label" }, "License"), license)),
      own &&
        h(
          "div",
          { class: "ed-field" },
          h("label", {}, h("span", { class: "ed-label" }, "New family for"), role),
        ),
    ),
    fileButton("Choose a font file…", ACCEPT.font, "brand:fonts:upload", (file) => {
      ctx.state.license = license.value;
      void sendFile(ctx, "font", file, (added) => takeFont(ctx, added));
    }),
  );
}
