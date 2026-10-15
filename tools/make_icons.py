#!/usr/bin/env python3
"""Generate PWA icons (pure stdlib PNG writer, no PIL needed)."""
import os
import struct
import zlib


def write_png(path, w, h, pixel):
    raw = b""
    for y in range(h):
        row = bytearray()
        row.append(0)
        for x in range(w):
            row.extend(pixel(x, y))
        raw += bytes(row)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def make(size):
    bg = (15, 23, 42)      # slate-900
    fg = (56, 189, 248)    # sky-400
    s = size
    m = s * 0.22           # margin for the E glyph
    bar = s * 0.13         # stroke thickness

    def inside(x, y):
        # rounded-corner background mask
        r = s * 0.12
        cx = min(max(x, r), s - r)
        cy = min(max(y, r), s - r)
        if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
            return False
        return True

    def in_e(x, y):
        if not (m <= x <= m + bar):  # vertical stem
            return False
        top = m <= y <= m + bar
        mid = s / 2 - bar / 2 <= y <= s / 2 + bar / 2
        bot = s - m - bar <= y <= s - m
        return top or mid or bot

    def pixel(x, y):
        if inside(x, y) and in_e(x, y):
            return fg
        return bg

    return pixel


out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "icons")
os.makedirs(out, exist_ok=True)
for size in (192, 512):
    write_png(os.path.join(out, "icon-%d.png" % size), size, size, make(size))
    print("icon-%d.png written" % size)
