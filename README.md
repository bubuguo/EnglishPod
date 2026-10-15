# EnglishPod Player PWA

A self-hosted Progressive Web App for playing the [EnglishPod lesson archive](https://archive.org/download/englishpod_all) (365 lessons) hosted on archive.org.

## Features

- **Play OGG audio** — each lesson has three tracks: Podcast (full lesson), Dialog, and Review, streamed directly from `archive.org/download/englishpod_all`.
- **Transcript while playing** — the lesson's dialog transcript (`.txt`) is fetched and shown next to the player.
- **Lesson PDF** — view the lesson's PDF (lesson notes/vocabulary) inline.
- **Offline caching** — audio, transcripts and PDFs are cached by the service worker (Cache Storage + IndexedDB metadata). Press **⤓ Offline** on a lesson to pre-cache it; anything you play/view is cached automatically.
- **500 MB cache quota with LRU eviction** — when cached media exceeds 500 MB, the *least-recently-accessed* files are deleted first (the file currently playing is never evicted). Live usage is shown in the header.
- **Repeat count** — repeat a track 1×, 2×, 3×, 5×, 10× or infinitely, with an optional auto-advance to the next lesson.
- **Sleep timer** — stop playback after 5/10/15/30/45/60 minutes, or at the end of the current track, with a live countdown.
- Remembers the last lesson/track and playback position; installable to the home screen (full PWA manifest + icons).

## Run it

Requires only Python 3 (no dependencies):

```bash
python3 server.py          # serves http://localhost:8080
python3 server.py 9000     # custom port
```

Then open <http://localhost:8080>. Install it as an app from your browser menu ("Add to Home Screen" / "Install").

> The service worker requires a secure context — `localhost` counts as secure, so this works out of the box. If you expose it on the network (`0.0.0.0`), access it via `localhost` or set up HTTPS for the service worker to register on other devices.

## Project layout

```
server.py               Zero-dependency Python static server
public/
  index.html            App UI
  styles.css            Styles
  app.js                Player, repeat, sleep timer, cache UI
  sw.js                 Service worker: media caching, Range support,
                        500 MB LRU eviction, stats/download/clear messages
  lessons.json          Generated catalog (365 lessons)
  manifest.webmanifest  PWA manifest
  icons/                Generated PWA icons
tools/
  generate_catalog.py   Rebuilds public/lessons.json from archive.org metadata
  make_icons.py         Regenerates the PNG icons (pure stdlib)
```

## Notes

- Media is fetched directly from `https://archive.org/download/englishpod_all/…`, which serves `Access-Control-Allow-Origin: *` and supports byte ranges, so no server-side proxy is needed.
- The catalog (`lessons.json`) is generated once from the archive metadata; re-run `python3 tools/generate_catalog.py` to refresh it.
- Cache internals: the service worker tracks `{url, size, lastAccessed}` per media file in IndexedDB (`epod-cache-db`). On every cache hit the access timestamp is refreshed; on every insert the total is checked against 500 MB and oldest-accessed entries are evicted until under quota.
