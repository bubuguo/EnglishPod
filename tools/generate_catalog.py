#!/usr/bin/env python3
"""Generate public/lessons.json from archive.org item metadata.

Usage: python3 tools/generate_catalog.py
Fetches https://archive.org/metadata/englishpod_all and builds a catalog of
lessons (audio tracks, transcript txt, pdf) used by the PWA.
"""
import json
import re
import urllib.request

ITEM = "englishpod_all"
META_URL = f"https://archive.org/metadata/{ITEM}"
BASE = f"https://archive.org/download/{ITEM}/"
OUT = "public/lessons.json"


def main():
    with urllib.request.urlopen(META_URL) as r:
        meta = json.load(r)

    lessons = {}

    def lesson(num):
        return lessons.setdefault(num, {"n": int(num), "id": num})

    for f in meta["files"]:
        name = f["name"]
        m = re.match(r"englishpod_(\d{4})(pb|dg|rv)\.ogg$", name)
        if m:
            num, kind = m.groups()
            lesson(num).setdefault("audio", {})[kind] = {
                "file": name,
                "size": int(f.get("size", 0)),
                "length": float(f.get("length", 0)),
            }
            continue
        m = re.match(r"englishpod_(\d{4})dg\.txt$", name)
        if m:
            lesson(m.group(1))["txt"] = {"file": name, "size": int(f.get("size", 0))}
            continue
        m = re.match(r"englishpod_(\d{4})\.pdf$", name)
        if m:
            lesson(m.group(1))["pdf"] = {"file": name, "size": int(f.get("size", 0))}
            continue
        # Titles live in the mp3 id3 tags of the original files.
        m = re.match(r"englishpod_(\d{4})pb\.mp3$", name)
        if m:
            title = f.get("title", "")
            level, _, name_part = title.partition(" - ")
            les = lesson(m.group(1))
            les["title"] = name_part.strip() or f"Lesson {m.group(1)}"
            les["level"] = level.strip() or "Unknown"

    result = {
        "item": ITEM,
        "base": BASE,
        "lessons": [lessons[k] for k in sorted(lessons)],
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)
    print(f"Wrote {OUT}: {len(result['lessons'])} lessons")


if __name__ == "__main__":
    main()
