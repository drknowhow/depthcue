"""Subsets each font in a jobs file to Latin plus Latin Extended and writes a woff2.

Usage: python -I subset.py <jobs.json> [features-profile]

jobs.json is a list of {"in": "<ttf path>", "out": "<woff2 path>"}, with an optional "rename" (see `rename`) for a font
whose license reserves its name. Every path is passed in, nothing is read from the current directory. The unicode set
and layout features are fixed here so every file is made the same way.

IBM Plex is not made here: its license reserves the name "Plex", so its files are IBM's own split woff2, copied as they
are. See manifest.json for the route each family took.
"""

import json
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

# Latin, Latin-1, Latin Extended A and B, spacing modifiers, combining accents, Latin Extended Additional, general
# punctuation, currency, a few letterlike and math signs that data slides use, and the fi/fl ligatures.
UNICODES = (
    "U+0020-007E,U+00A0-024F,U+0259,U+02B0-02FF,U+0300-036F,U+1E00-1EFF,U+2C60-2C7F,U+A720-A7FF,"
    "U+2010-2027,U+2030-205E,U+20A0-20BF,U+2113,U+2116,U+2122,U+2190-2193,U+2212,U+2215,U+221E,"
    "U+2248,U+2260,U+2264-2265,U+25CA,U+FB01-FB02,U+FEFF,U+FFFD"
)

# What a slide needs from the font's tables: pair kerning, ligatures, accents, and figure styles for numbers.
FEATURES = [
    "kern", "liga", "clig", "calt", "ccmp", "locl", "mark", "mkmk", "rlig",
    "tnum", "pnum", "lnum", "onum", "case", "zero", "frac", "numr", "dnom", "sups", "subs",
]


# The name records that say what the font is called. The copyright (0), license (13, 14) and trademark (7) records are
# the Copyright Holder's notices and are always kept as they came.
NAME_IDS = (1, 3, 4, 6, 16, 17, 21, 22, 25)


def rename(font: TTFont, change: dict) -> None:
    """Renames a font whose license reserves its name, so the subset is not sold under the reserved name.

    `change` is {"from": [name, postscript-name], "to": [name, postscript-name], "reserved": "Word"}. The family, full
    and PostScript names, the unique id and the typographic names take the new name; nothing else is touched. Fails if
    the reserved word is still in any of them, so a font that went out under it cannot be made by mistake.
    """
    table = font["name"]
    for record in list(table.names):
        if record.nameID not in NAME_IDS:
            continue
        text = record.toUnicode()
        for old, new in zip(change["from"], change["to"]):
            text = text.replace(old, new)
        table.setName(text, record.nameID, record.platformID, record.platEncID, record.langID)
    reserved = change["reserved"].lower()
    for record in table.names:
        if record.nameID in NAME_IDS and reserved in record.toUnicode().lower():
            raise SystemExit(f"name {record.nameID} still has the reserved name {change['reserved']!r}")


def make(source: Path, target: Path, change: dict | None = None) -> int:
    options = subset.Options()
    options.flavor = "woff2"
    options.layout_features = FEATURES
    options.hinting = False
    options.desubroutinize = True
    options.name_IDs = ["*"]
    options.name_legacy = False
    options.notdef_outline = True
    options.recalc_bounds = True
    options.drop_tables += ["DSIG"]
    font = TTFont(str(source), lazy=True)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=subset.parse_unicodes(UNICODES))
    subsetter.subset(font)
    if change is not None:
        rename(font, change)
    target.parent.mkdir(parents=True, exist_ok=True)
    subset.save_font(font, str(target), options)
    font.close()
    return target.stat().st_size


def main() -> None:
    jobs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
    for job in jobs:
        size = make(Path(job["in"]), Path(job["out"]), job.get("rename"))
        print(f"{size:>8}  {job['out']}")


main()
