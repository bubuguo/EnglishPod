# Archive.org Audio Player PWA

A self-hosted Progressive Web App for playing audio lessons from **any Archive.org item or subfolder** — it ships with the [EnglishPod lesson archive](https://archive.org/download/englishpod_all) (365 lessons) as the default resource. Deployed as a static site (e.g. GitHub Pages) — no backend required.

## Features

- **Any Archive.org resource** — open **Settings** and point the app at an item (`https://archive.org/download/<item>`) or a subfolder inside it (`https://archive.org/download/<item>/<sub/path>/`). The catalog is built in the browser from the Archive.org metadata API.
- **Configurable file-name patterns** — one regular expression per audio track plus an optional transcript pattern. Capture group 1 is the pairing key, so `englishpod_(.*)pb.ogg` and `englishpod_(.*)dg.txt` both yield `0001` and end up in the same lesson.
- **Play OGG/MP3 audio** — each lesson can have several tracks (the default EnglishPod resource has Podcast, Dialog and Review), streamed directly from `archive.org/download/…`.
- **Transcript while playing** — the lesson's transcript (`.txt`) is fetched and shown next to the player.
- **Automatic offline caching** — anything you play is cached by the service worker (Cache Storage + IndexedDB metadata): the full audio file on first play, the transcript on lesson open. No manual "download" step.
- **500 MB cache quota with LRU eviction** — when cached media exceeds 500 MB, the *least-recently-accessed* files are deleted first (the file currently playing is never evicted). Live usage is shown in the header, with a **Clear cache** button.
- **Repeat count** — repeat a track 1×, 2×, 3×, 5×, 10× or infinitely, with an optional auto-advance to the next lesson.
- **Sleep timer** — stop playback after 5/10/15/30/45/60 minutes, or at the end of the current track, with a live countdown.
- **Lock-screen controls** — Media Session integration: notification/lock-screen play-pause, next/previous lesson, seek and scrubbing.
- Remembers the last lesson/track and playback position (per catalog); installable to the home screen (full PWA manifest + icons).

## Run it

Any static file server works. For local development:

```bash
python3 tools/server.py          # serves http://localhost:8080
python3 tools/server.py 9000     # custom port
```

Or deploy the directory as-is to any static host (GitHub Pages, etc.). Then open the URL and install it as an app from your browser menu ("Add to Home Screen" / "Install").

> The service worker requires a secure context — `localhost` counts as secure, and valid HTTPS (e.g. GitHub Pages) works out of the box. Plain `http://<lan-ip>` will load the app but the service worker (and offline caching) will not register.

## Configure a resource

Click **Settings** in the header and fill in:

| Field | Meaning |
| --- | --- |
| **Archive.org folder URL** | An item (`https://archive.org/download/<item>`) or a subfolder inside it (`https://archive.org/download/<item>/<sub/path>/`). Percent-encoded paths are supported. |
| **Audio file name patterns** | One row per track: a label (shown in the track dropdown) and a regular expression matched against the file name. |
| **Transcript file name pattern** | Optional. Same rules; leave it empty for resources without transcripts. |

Rules:

- Patterns are JavaScript regular expressions, anchored to the **whole file name**.
- **Capture group 1 is the pairing key**: the audio file `englishpod_0001pb.ogg` (pattern `englishpod_(.*)pb\.ogg`) and the transcript `englishpod_0001dg.txt` (pattern `englishpod_(.*)dg\.txt`) both yield `0001` and therefore belong to the same lesson.
- Escape dots as `\.` — `pb.ogg` would also match `pbXogg`.
- Patterns are matched against the file name only; the subfolder is used to *select* the files.
- **Test** fetches the metadata and reports how many lessons matched without saving; **Save & load** applies the configuration and stores it in `localStorage` (the built catalog is cached too, so the resource still opens offline).

Example — the default EnglishPod resource:

```
Folder URL:      https://archive.org/download/englishpod_all
Audio patterns:  englishpod_(.*)pb\.ogg   (Podcast)
                 englishpod_(.*)dg\.ogg   (Dialog)
                 englishpod_(.*)rv\.ogg   (Review)
Transcript:      englishpod_(.*)dg\.txt
```

Example — a subfolder with Chinese file names (no transcripts available):

```
Folder URL:      https://archive.org/download/bjrmgbdt.zhangshuguangbo.2015/%E5%8C%97%E4%BA%AC%E4%BA%BA%E6%B0%91%E5%B9%BF%E6%92%AD%E7%94%B5%E5%8F%B0/%E9%95%BF%E4%B9%A6%E5%B9%BF%E6%92%AD/%E7%B2%BE%E5%93%81%E5%B0%8F%E8%AF%B4%E5%B1%95%E6%92%AD/
Audio patterns:  精品小说展播-(.*)\.mp3
Transcript:      (empty)
```

Files are enumerated through `https://archive.org/metadata/<item>`, which lists nested files with their full relative paths and allows cross-origin requests. The HTML folder listing cannot be used from a browser (it redirects to a server without CORS headers).

### Saved catalogs

Every configuration you save is kept in a **history** (in `localStorage`, per device) so you can switch between catalogs at any time — the list lives at the top of the Settings dialog:

| Action | Effect |
| --- | --- |
| **Load** | Switch to that catalog: the cached copy appears instantly, then it is refreshed from the Archive.org metadata API. The lesson list, the header title and the last played lesson/position of that catalog are restored. |
| **Rename** | Edit the display name (the name field in the row is editable; the change is saved when you leave the field). The name is also shown in the header. |
| **Delete** | Remove the catalog from the history. The built-in *EnglishPod* catalog cannot be deleted. Cached media is kept — use **Clear cache** to remove it. |
| **Save & load** | Save the form into the history and load it. If the folder *and* the patterns match an existing catalog, that entry is updated instead of creating a duplicate. The built-in *EnglishPod* entry is never overwritten — editing it creates a new entry (use **Reset to default** to restore it). |
| **+ Save current as new** | Always create an additional entry — useful for two different pattern sets on the same folder. |

The active catalog is remembered across restarts. The history holds up to 50 catalogs; when it is full, the least recently used ones are dropped (the built-in and the active catalog are always kept).

> **Upgrading from a version before the catalog history:** the configuration saved by that version is *not* carried over. Clear the app's site data (or reinstall the app) once after the update — the old value is simply ignored.

## Project layout

```
index.html            App UI
styles.css            Styles
catalog.js            Archive.org catalog builder (URL parsing, pattern
                      matching, audio/transcript pairing) — shared with the tests
app.js                Player adapter, repeat, sleep timer, Media Session, cache UI,
                      resource settings dialog
sw.js                 Service worker: media caching with Range support,
                      500 MB LRU eviction, stats/clear messages
manifest.webmanifest  PWA manifest
icons/                Generated PWA icons
tests/                Unit tests for catalog.js (node:test)
tools/
  server.py           Zero-dependency Python static server (local dev)
  make_icons.py       Regenerates the PNG icons (pure stdlib)
```

## Android app (Capacitor)

The same web code ships inside a native Android app (`android/`, Capacitor + a custom `AudioPlayer` plugin):

- **Native playback** — ExoPlayer runs in a foreground `MediaSessionService` (`PlayerService`), so playback, track switching (repeat/auto-next) and the sleep timer keep working with the screen locked. Lock-screen/notification controls come from MediaSession; audio focus and headphone-unplug pause are handled natively.
- **Native offline audio cache** — ExoPlayer streams through a read-through `CacheDataSource` backed by `SimpleCache` with a `LeastRecentlyUsedCacheEvictor` (500 MB) in `files/media_cache`. Played lessons are cached natively and replay offline; the header's cache display and **Clear cache** button talk to the native cache via the plugin (`cacheStats`/`clearCache`). The service worker still caches transcripts inside the WebView.
- **Sleep timer** — armed natively (`Handler` + `elapsedRealtime`, self-correcting) and ExoPlayer holds a wake lock while playing, so it fires exactly on time with the screen off.

### Building

Requires JDK 21, the Android SDK (`ANDROID_HOME`), and podman (for Node):

```bash
tools/cap_sync.sh        # copy web assets into www/ + npx cap sync (podman node:20)
cd android
JAVA_HOME=$(/usr/libexec/java_home -v 21) ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### Release build

The release build is signed with a private keystore referenced by
`android/keystore.properties` (gitignored). One-time setup:

```bash
# 1. Generate a keystore (keep it OUTSIDE the repo and back it up — losing it
#    means you can never update the app for existing installs):
mkdir -p ~/keystores
keytool -genkeypair -v \
  -keystore ~/keystores/englishpod-release.jks \
  -alias englishpod -keyalg RSA -keysize 2048 -validity 10000

# 2. Describe it in android/keystore.properties (never committed):
#    storeFile=/Users/<you>/keystores/englishpod-release.jks
#    storePassword=...
#    keyAlias=englishpod
#    keyPassword=...
```

Every release:

```bash
# 1. Bump versionCode (+1, always) and versionName in android/app/build.gradle.
# 2. Sync web assets, then build:
tools/cap_sync.sh
cd android
JAVA_HOME=$(/usr/libexec/java_home -v 21) ./gradlew assembleRelease   # APK (sideload)
# or: ./gradlew bundleRelease                                         # AAB (Play Store)

# 3. Verify the signature and install:
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs \
  app/build/outputs/apk/release/app-release.apk
adb install -r app/build/outputs/apk/release/app-release.apk
```

Outputs: `app/build/outputs/apk/release/app-release.apk` (sideload) or
`app/build/outputs/bundle/release/app-release.aab` (Play Store upload — Play
re-signs with its own key via Play App Signing). The debug and release builds
have different signatures: uninstall the debug build before installing the
release one.

> **After reinstalling, run `adb shell pm clear io.github.bubuguo.englishpod`** (or clear the app in Settings) before launching — reinstalls keep app data, and the WebView may serve a stale cached `app.js` from the previous install.

## Tests

The catalog builder is covered by unit tests (`node:test`, no network access — the
metadata is a fixture). Node is not installed on the host, so the tests run in the
same podman container used by `tools/cap_sync.sh`:

```bash
npm test          # podman + node:20, runs tests/catalog.test.js
```

## Notes

- Media is fetched directly from `https://archive.org/download/…`, which serves `Access-Control-Allow-Origin: *` and supports byte ranges, so no server-side proxy is needed. The service worker caches every Archive.org download URL, so any item or subfolder works.
- Every catalog — including the built-in EnglishPod one, which is described by `DEFAULT_CONFIG` in `catalog.js` — is built at runtime from the Archive.org metadata API and then mirrored to `localStorage`, so it opens offline from then on. The cache is per catalog, i.e. per folder *and* pattern set, so two catalogs on the same folder never share a cached lesson list or a playback position. The very first load therefore needs a network connection; every later load works offline.
- Cache internals: the service worker tracks `{url, size, ts}` per media file in IndexedDB (`epod-cache-db`). The timestamp is refreshed once the page reports 30 s of continuous playback (fetching alone doesn't count, so briefly-opened lessons stay evictable); on every insert the total is checked against 500 MB and least-recently-accessed entries are evicted until under quota.
- Playback goes through a small player adapter (`HtmlPlayer` in `app.js`); all app logic talks to that interface, so a native player (e.g. a Capacitor plugin) can be swapped in without touching the rest of the code.

### Battery usage

The app is built to idle at almost zero cost while it is not playing:

- **No timers while idle.** The playback-position timer only runs while audio is playing, and the sleep-timer countdown (1 Hz) only paints while the UI is visible. In the native app the plugin reports `pause`/`resume`, so a backgrounded WebView stops the display-only timers instead of waking the CPU every second.
- **Throttled event handlers.** `timeupdate` fires ~4×/s; the "really listened" check behind it runs at most every 5 s, and the MediaSession position state at most every 5 s.
- **The service worker** keeps the file that is currently streaming as a `Blob` (not an `ArrayBuffer`), so a large file is never materialised in the JS heap, and it re-reads a cached file only once per track.
- **The native app** stops its 1 Hz progress ticks as soon as the screen is off or the app is hidden (`PlayerService`), and the sleep timer is fired by the foreground service, so it stays exact without a JS timer.
- **The biggest energy consumer is the download itself:** the first play of a lesson downloads the *whole* file so it is available offline afterwards (the same in the native app, via `CacheWriter`). On a metered connection that is the main thing to be aware of.
