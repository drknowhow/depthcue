/** The help text of `depthcue brand import`. Kept apart from the command so printing usage loads none of the import. */

export const BRAND_IMPORT_USAGE = "  depthcue brand import <file.potx|.pptx|.thmx> [--out <dir>] [--json]";

export const BRAND_IMPORT_TEXT = `brand  import turns a PowerPoint template (.potx), presentation (.pptx) or theme (.thmx) into a brand folder:
       brand.json, templates/, logos/ and images/. The theme's colors and fonts, the master's logo, footer
       and slide number, and each slide layout as a template are taken. The report lists what was left out
       and why, and each color Depthcue kept its own for because the theme's would fail the contrast rules.
       The default folder is <file name>-brand here. A folder an earlier import wrote is replaced and the
       files it no longer has are removed and listed, unless a file in it was changed since (a deck's apply
       edits brand.json); that folder is refused, and so is any other folder with files in it. Font files
       embedded in the file are never copied.
       Exit codes: 0 done, 1 the file has no theme or no usable layout, 2 the file could not be read or the
       folder could not be written (a refused folder is this too).`;
