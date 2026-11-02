/** The help text of `depthcue brand init|use|check` and `depthcue new`. Kept apart so printing usage loads none of them. */

export const BRAND_COMMANDS_USAGE = `  depthcue brand init <dir> [--name <name>] [--json]
  depthcue brand use <brand-folder> <deck-folder> [--force] [--json]
  depthcue brand check <brand-folder | deck-folder> [--json]`;

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
       operations that move it. The bytes of copied fonts, logos and images are not part of the deck's
       revision, as assets are not. A brand folder that fails brand check is not copied.
       check reads a brand folder, or the brand of a deck folder, and reports what depthcue check reports for
       it: the brand's files, each template, the colors on both presets. For a brand folder it also checks
       Depthcue's own templates under the brand's palettes and styles, as warnings.
       Exit codes: 0 done (check: no errors, warnings allowed), 1 refused or errors found, 2 a folder could
       not be read or written, 3 the deck changed while use was working (nothing was copied).`;

export const NEW_TEXT = `new    Makes a deck in an empty folder: deck.json and one opening scene on the title template. With --brand the
       folder's brand is copied in the way brand use does it, and the scene takes the brand's title template.
       --name is the deck's title (default: the folder's name). Exit codes as brand use.`;
