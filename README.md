# EnglishPod Player PWA

A self-hosted Progressive Web App for playing the [EnglishPod lesson archive](https://archive.org/download/englishpod_all) (365 lessons) hosted on archive.org. Deployed as a static site (e.g. GitHub Pages) — no backend required.

## Features

- **Play OGG audio** — each lesson has three tracks: Podcast (full lesson), Dialog, and Review, streamed directly from `archive.org/download/englishpod_all`.
- **Transcript while playing** — the lesson's dialog transcript (`.txt`) is fetched and shown next to the player.
- **Automatic offline caching** — anything you play is cached by the service worker (Cache Storage + IndexedDB metadata): the full audio file on first play, the transcript on lesson open. No manual "download" step.
- **500 MB cache quota with LRU eviction** — when cached media exceeds 500 MB, the *least-recently-accessed* files are deleted first (the file currently playing is never evicted). Live usage is shown in the header, with a **Clear cache** button.
- **Repeat count** — repeat a track 1×, 2×, 3×, 5×, 10× or infinitely, with an optional auto-advance to the next lesson.
- **Sleep timer** — stop playback after 5/10/15/30/45/60 minutes, or at the end of the current track, with a live countdown.
- **Lock-screen controls** — Media Session integration: notification/lock-screen play-pause, next/previous lesson, seek and scrubbing.
- Remembers the last lesson/track and playback position; installable to the home screen (full PWA manifest + icons).

## Run it

Any static file server works. For local development:

```bash
python3 tools/server.py          # serves http://localhost:8080
python3 tools/server.py 9000     # custom port
```

Or deploy the directory as-is to any static host (GitHub Pages, etc.). Then open the URL and install it as an app from your browser menu ("Add to Home Screen" / "Install").

> The service worker requires a secure context — `localhost` counts as secure, and valid HTTPS (e.g. GitHub Pages) works out of the box. Plain `http://<lan-ip>` will load the app but the service worker (and offline caching) will not register.

## Project layout

```
index.html            App UI
styles.css            Styles
app.js                Player adapter, repeat, sleep timer, Media Session, cache UI
sw.js                 Service worker: media caching with Range support,
                      500 MB LRU eviction, stats/clear messages
lessons.json          Generated catalog (365 lessons)
manifest.webmanifest  PWA manifest
icons/                Generated PWA icons
tools/
  server.py           Zero-dependency Python static server (local dev)
  generate_catalog.py Rebuilds lessons.json from archive.org metadata
  make_icons.py       Regenerates the PNG icons (pure stdlib)
```

## Notes

- Media is fetched directly from `https://archive.org/download/englishpod_all/…`, which serves `Access-Control-Allow-Origin: *` and supports byte ranges, so no server-side proxy is needed.
- The catalog (`lessons.json`) is generated once from the archive metadata; re-run `python3 tools/generate_catalog.py` to refresh it. A copy is mirrored to localStorage so the very first load works offline too.
- Cache internals: the service worker tracks `{url, size, ts}` per media file in IndexedDB (`epod-cache-db`). The timestamp is refreshed once the page reports 30 s of continuous playback (fetching alone doesn't count, so briefly-opened lessons stay evictable); on every insert the total is checked against 500 MB and least-recently-accessed entries are evicted until under quota.
- Playback goes through a small player adapter (`HtmlPlayer` in `app.js`); all app logic talks to that interface, so a native player (e.g. a Capacitor plugin) can be swapped in without touching the rest of the code.
