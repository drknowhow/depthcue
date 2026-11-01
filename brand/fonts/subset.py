"""Subsets each font in a jobs file to Latin plus Latin Extended and writes a woff2.

Usage: python -I subset.py <jobs.json> [features-profile]

jobs.json is a list of {"in": "<ttf path>", "out": "<woff2 path>"}. Every path is passed in, nothing is read from the
current directory. The unicode set and layout features are fixed here so every file is made the same way.
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


def make(source: Path, target: Path) -> int:
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
    target.parent.mkdir(parents=True, exist_ok=True)
    subset.save_font(font, str(target), options)
    font.close()
    return target.stat().st_size


def main() -> None:
    jobs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
    for job in jobs:
        size = make(Path(job["in"]), Path(job["out"]))
        print(f"{size:>8}  {job['out']}")


main()
