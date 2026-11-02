/** The help text of `depthcue brand init|use|check|add|remove` and `depthcue new`. Kept apart so printing usage loads none of them. */

export const BRAND_COMMANDS_USAGE = `  depthcue brand init <dir> [--name <name>] [--json]
  depthcue brand use <brand-folder> <deck-folder> [--force] [--json]
  depthcue brand check <brand-folder | deck-folder> [--json]
  depthcue brand add <file> <deck-folder> --kind font|logo|image [--name <name>] [--replace --base-rev <rev>] [--json]
  depthcue brand remove <path-in-brand> <deck-folder> --base-rev <rev> [--json]`;

export const NEW_USAGE = "  depthcue new <dir> [--brand <brand-folder>] [--name <title>] [--json]";

export const BRAND_COMMANDS_TEXT = `brand  init writes a starter brand into an empty folder: brand.json with the two palettes of the presets, a
       built-in font pair, a footer and slide number, and no logo or templates of its own. It passes brand
       check as it is. --name sets the brand's name; the id is made from it, or from the folder's name.
       use copies a brand folder into a deck as real files (brand.json, templates/, fonts/, logos/, images/;
       never links) and makes it the deck's brand through the same save and revision guard as apply, with
       a record of what it copied in brand/.depthcue-brand-use. A deck whose brand was copied that way is
       replaced only while every file is still as it was copied; a deck brand with a file changed since
       (apply edits brand.json) or with no record is refused, naming each file, unless --force. A scene
       that uses a template the new brand lacks is always refused, naming the scene and the apply
       operations that move it. The hashes of the fonts, logos and images a brand.json can name are part of
       the deck's revision. A brand folder that fails brand check is not copied.
       add puts a font, a logo (svg, png) or a background image (png, jpg, webp, svg) into the deck's brand
       folder, as the editor's upload does: the kind and extension come from the bytes, the name is the
       file's base name (or --name) in the characters brand.json takes, fonts must unpack within the
       export's limits, and SVG may not script, load or link outside itself. The same bytes write nothing;
       other bytes under the same name, compared without case, need --replace and --base-rev. It prints
       the path in brand/ for brand.json to name. remove takes a file out against --base-rev, refused
       while brand.json or a template names it. Both are recorded for review as the agent's changes.
       check reads a brand folder, or the brand of a deck folder, and reports what depthcue check reports for
       it: the brand's files, each template, the colors on both presets. For a brand folder it also checks
       Depthcue's own templates under the brand's palettes and styles, as warnings.
       Exit codes: 0 done (check: no errors, warnings allowed), 1 refused or errors found, 2 a folder could
       not be read or written, 3 the deck changed while use was working (nothing was copied).`;

export const NEW_TEXT = `new    Makes a deck in an empty folder: deck.json and one opening scene on the title template. With --brand the
       folder's brand is copied in the way brand use does it, and the scene takes the brand's title template.
       --name is the deck's title (default: the folder's name). Exit codes as brand use.`;
