#!/usr/bin/env python3
"""Build a gojūon-sorted copy of the Japanese kanji CSVs.

Reads the part CSVs for the two kanji-bearing categories, groups every word by
the FIRST kana of its reading (assimilating voiced/small kana to their base
gojūon kana), sorts within each group in gojūon order, and writes one folder +
one CSV per initial kana under data/japanese/kana/<category>/<kana>/<kana>.csv.

Originals under data/japanese/csv/ are never touched.
"""
import csv
import os
import shutil

# data/japanese lives at the repo root, two levels up from this script (scripts/).
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "japanese")
SRC = os.path.join(ROOT, "csv")
OUT = os.path.join(ROOT, "kana")

# Only the categories that actually have kanji readings to sort by.
CATS = [
    ("1_全汉字词", "1_全汉字词"),
    ("4_平假名汉字混合词", "4_平假名汉字混合词"),
]

# Base gojūon order (46). Every reading's initial kana is folded to one of these.
GOJUON = list("あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん")
BASE_INDEX = {k: i for i, k in enumerate(GOJUON)}

# voiced / semi-voiced / small kana -> base gojūon kana, plus a voicing subrank
# so that e.g. か < が < き orders naturally within a group.
VOICED = {
    "が": ("か", 1), "ぎ": ("き", 1), "ぐ": ("く", 1), "げ": ("け", 1), "ご": ("こ", 1),
    "ざ": ("さ", 1), "じ": ("し", 1), "ず": ("す", 1), "ぜ": ("せ", 1), "ぞ": ("そ", 1),
    "だ": ("た", 1), "ぢ": ("ち", 1), "づ": ("つ", 1), "で": ("て", 1), "ど": ("と", 1),
    "ば": ("は", 1), "び": ("ひ", 1), "ぶ": ("ふ", 1), "べ": ("へ", 1), "ぼ": ("ほ", 1),
    "ぱ": ("は", 2), "ぴ": ("ひ", 2), "ぷ": ("ふ", 2), "ぺ": ("へ", 2), "ぽ": ("ほ", 2),
    "ゔ": ("う", 1),
    "ぁ": ("あ", 0), "ぃ": ("い", 0), "ぅ": ("う", 0), "ぇ": ("え", 0), "ぉ": ("お", 0),
    "っ": ("つ", 0), "ゃ": ("や", 0), "ゅ": ("ゆ", 0), "ょ": ("よ", 0), "ゎ": ("わ", 0),
}


def to_hiragana(ch):
    """Convert a single katakana char to hiragana; pass others through."""
    o = ord(ch)
    if 0x30A1 <= o <= 0x30F6:  # katakana range with hiragana equivalents
        return chr(o - 0x60)
    return ch


def char_key(ch):
    """(base_index, voicing_subrank) sort key for one kana char."""
    ch = to_hiragana(ch)
    if ch in VOICED:
        base, sub = VOICED[ch]
        return (BASE_INDEX[base], sub)
    if ch in BASE_INDEX:
        return (BASE_INDEX[ch], 0)
    # long-vowel mark, digits, unknowns -> sort after all kana, stable by codepoint
    return (100 + ord(ch), 0)


def reading_sort_key(reading):
    return [char_key(c) for c in reading]


def group_kana(reading):
    """The base gojūon kana this reading files under (its normalized first kana)."""
    for c in reading:
        c = to_hiragana(c)
        if c in VOICED:
            return VOICED[c][0]
        if c in BASE_INDEX:
            return c
    return None  # no kana found (shouldn't happen)


def load_rows(cat_dir):
    d = os.path.join(SRC, cat_dir)
    rows = []
    for name in os.listdir(d):
        if not name.lower().endswith(".csv"):
            continue
        with open(os.path.join(d, name), encoding="utf-8-sig", newline="") as f:
            r = list(csv.reader(f))
        for i, row in enumerate(r):
            if i == 0:
                header = row
                continue
            if len(row) < 4 or not row[0].strip():
                continue
            rows.append([c.strip() for c in row[:4]])
    return rows


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    header = ["日文(汉字)", "假名读音", "中文释义", "音频文件"]

    grand = 0
    for cat_id, cat_dir in CATS:
        rows = load_rows(cat_dir)
        OTHER = "他"  # catch-all for entries whose reading has no kana (e.g. ～元)
        buckets = {}
        for row in rows:
            g = group_kana(row[1]) or OTHER
            buckets.setdefault(g, []).append(row)

        # Order the group folders in gojūon order, with 他 last.
        ordered_groups = sorted(buckets.keys(),
                                key=lambda k: BASE_INDEX.get(k, len(GOJUON)))
        total = 0
        for g in ordered_groups:
            items = sorted(buckets[g], key=lambda r: reading_sort_key(r[1]))
            gdir = os.path.join(OUT, cat_id, g)
            os.makedirs(gdir, exist_ok=True)
            with open(os.path.join(gdir, g + ".csv"), "w", encoding="utf-8", newline="") as f:
                w = csv.writer(f)
                w.writerow(header)
                w.writerows(items)
            total += len(items)
        grand += total
        print(f"{cat_id}: {len(ordered_groups)} groups, {total} words"
              + f"  [{' '.join(ordered_groups)}]")
    print(f"TOTAL: {grand} words")


if __name__ == "__main__":
    main()
