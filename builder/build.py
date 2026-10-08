#!/usr/bin/env python3
"""MYTHOS: Hostile Takeover — site builder (v1).

Reads the 060 card spreadsheet + rendered card images and generates a static,
self-contained game site into site/ that runs from plain static hosting
(GitHub Pages, Netlify, or file://) with no server and no build step.

Usage:
    python3 build.py [--clean]

Outputs (site/):
    index.html, style.css, engine.js, ai.js, net.js, ui.js   (copied from src/)
    data.js        (cards + decks + asset paths, inlined for file:// support)
    cards.json     (same card data as JSON — for tooling/tests)
    decks.json     (starter deck lists)
    assets/cards/001.png ... 060.png
    assets/card-back.png
"""
import json
import openpyxl
import os
import shutil
import sys
from collections import Counter

from card_data import MOTHMAN, DECKS

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")
SITE = os.path.join(ROOT, "site")
XLSX = os.path.expanduser("~/workspace/your_files/mythos-060-card-list.xlsx")
IMG_SRC = os.path.expanduser("~/workspace/your_files/mythos-print-and-play/individual-copies")
CARD_BACK_SRC = os.path.expanduser("~/workspace/mythos-cards/card-back-rotational.png")

TYPE_FOLDERS = {
    "Character": "characters",
    "Abomination": "abominations",
    "Ritual": "rituals",
    "Location": "locations",
    "Action": "actions",
    "Trap": "traps",
    "Artifact": "artifacts",
    "Effect": "effects",
}


def to_int(v):
    if v is None or v == "" or v == "TBD" or v == "X":
        return None
    return int(v)


def clean_str(v):
    if v is None:
        return ""
    s = str(v).strip()
    if len(s) >= 2 and s.startswith('"') and s.endswith('"'):
        s = s[1:-1]
    return s


def load_cards():
    wb = openpyxl.load_workbook(XLSX, data_only=True)
    ws = wb["MYTHOS 060 Card List"]
    rows = list(ws.iter_rows(values_only=True))
    hdr = [c for c in rows[0]]
    cards = []
    for r in rows[1:]:
        d = dict(zip(hdr, r))
        cid = int(d["#"])
        card = {
            "id": cid,
            "num": "%03d" % cid,
            "name": clean_str(d["Name"]),
            "title": clean_str(d["Title"]),
            "type": clean_str(d["Type"]),
            "cost": to_int(d["Cost"]),
            "control": to_int(d["Control"]),
            "sanity": to_int(d["Sanity"]),
            "power": to_int(d["Power"]),
            "flesh": to_int(d["Flesh"]),
            "leash": to_int(d["Leash"]),
            "upkeep": to_int(d["Upkeep"]),
            "rules": clean_str(d["Rules"]),
            "flavor": clean_str(d["Flavor"]),
        }
        cards.append(card)
    return cards


def apply_mothman(cards):
    for c in cards:
        if c["id"] == MOTHMAN["id"]:
            c["cost"] = MOTHMAN["cost"]
            c["control"] = MOTHMAN["control"]
            c["sanity"] = MOTHMAN["sanity"]
            c["rules"] = MOTHMAN["rules"]
            c["flavor"] = MOTHMAN["flavor"]
            c["provisional_stats"] = True
            break


def find_image(card):
    folder = TYPE_FOLDERS[card["type"]]
    srcdir = os.path.join(IMG_SRC, folder)
    prefix = card["num"] + "-"
    for f in os.listdir(srcdir):
        if f.startswith(prefix) and f.endswith(".png"):
            return os.path.join(srcdir, f)
    return None


def validate_decks(cards):
    by_id = {c["id"]: c for c in cards}
    for key, deck in DECKS.items():
        lst = deck["cards"]
        assert len(lst) == 45, "%s: %d cards, need 45" % (key, len(lst))
        counts = Counter(lst)
        assert max(counts.values()) <= 3, "%s: >3 copies" % key
        n_chars = sum(1 for i in lst if by_id[i]["type"] == "Character")
        assert n_chars >= 1, "%s: no character" % key
        for i, n in counts.items():
            if by_id[i]["type"] == "Ritual":
                assert n == 1, "%s: ritual %d x%d" % (key, i, n)
        assert all(i in by_id for i in lst), "%s: unknown card id" % key
    print("decks OK: %s" % ", ".join("%s (%d)" % (k, len(v["cards"])) for k, v in DECKS.items()))


def build(clean=False):
    if clean and os.path.isdir(SITE):
        shutil.rmtree(SITE)
    os.makedirs(os.path.join(SITE, "assets", "cards"), exist_ok=True)

    cards = load_cards()
    assert len(cards) == 60, "expected 60 cards, got %d" % len(cards)
    ids = sorted(c["id"] for c in cards)
    assert ids == list(range(1, 61)), "card ids not 001-060: %r" % ids
    apply_mothman(cards)

    # images
    missing = []
    for c in cards:
        src = find_image(c)
        if not src:
            missing.append(c["num"] + " " + c["name"])
            continue
        dst = os.path.join(SITE, "assets", "cards", c["num"] + ".png")
        shutil.copyfile(src, dst)
        c["img"] = "assets/cards/%s.png" % c["num"]
    assert not missing, "missing card images: %r" % missing
    print("images OK: 60 copied")

    # card back
    assert os.path.isfile(CARD_BACK_SRC), "card back not found: %s" % CARD_BACK_SRC
    shutil.copyfile(CARD_BACK_SRC, os.path.join(SITE, "assets", "card-back.png"))
    print("card back OK: assets/card-back.png")

    validate_decks(cards)

    # data.js (inlined so file:// works) + JSON copies for tooling
    data = {
        "cards": cards,
        "decks": {k: {"name": v["name"], "desc": v["desc"], "cards": v["cards"]}
                  for k, v in DECKS.items()},
        "imgDir": "assets/cards",
        "cardBack": "assets/card-back.png",
        "version": "1.0.0",
    }
    with open(os.path.join(SITE, "data.js"), "w") as f:
        f.write("window.MYTHOS_DATA = " + json.dumps(data, ensure_ascii=False) + ";\n")
    with open(os.path.join(SITE, "cards.json"), "w") as f:
        json.dump(cards, f, ensure_ascii=False, indent=1)
    with open(os.path.join(SITE, "decks.json"), "w") as f:
        json.dump(data["decks"], f, ensure_ascii=False, indent=1)

    # static sources
    for fn in ["index.html", "style.css", "engine.js", "ai.js", "net.js", "ui.js"]:
        shutil.copyfile(os.path.join(SRC, fn), os.path.join(SITE, fn))
    print("site built: %s" % SITE)
    total = sum(os.path.getsize(os.path.join(dp, f))
                for dp, _, fs in os.walk(SITE) for f in fs)
    print("site size: %.1f MB" % (total / 1e6))


if __name__ == "__main__":
    build(clean="--clean" in sys.argv)
