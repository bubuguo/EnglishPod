/* Archive.org catalog builder.
 *
 * Shared by the PWA (browser) and the unit tests (Node) so the matching and
 * pairing rules live in exactly one place.
 *
 * A resource is described by:
 *   - a folder URL:  https://archive.org/download/<item>[/<sub/path>/]
 *   - one or more audio file-name patterns (regular expressions)
 *   - an optional transcript file-name pattern
 *
 * Capture group 1 of a pattern is the pairing key: the audio file
 * "englishpod_0001pb.ogg" (pattern "englishpod_(.*)pb\.ogg") and the transcript
 * "englishpod_0001dg.txt" (pattern "englishpod_(.*)dg\.txt") both yield the key
 * "0001" and therefore belong to the same lesson.
 *
 * Files are enumerated through the Archive.org metadata API
 * (https://archive.org/metadata/<item>), which lists nested files with their
 * full relative paths and sends `Access-Control-Allow-Origin: *`. The HTML
 * folder listing cannot be used from a browser: it redirects to a node server
 * that does not send CORS headers.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Catalog = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ARCHIVE_HOSTS = ['archive.org', 'www.archive.org'];

  // localStorage keys of the saved catalog history.
  const SAVED_CONFIGS_KEY = 'epod-resource-configs';
  const ACTIVE_CONFIG_KEY = 'epod-resource-active';
  const DEFAULT_CONFIG_ID = 'default';
  const MAX_SAVED_CONFIGS = 50;

  const DEFAULT_CONFIG = {
    folderUrl: 'https://archive.org/download/englishpod_all',
    audioPatterns: [
      { kind: 'pb', label: 'Podcast (full lesson)', pattern: 'englishpod_(.*)pb\\.ogg' },
      { kind: 'dg', label: 'Dialog', pattern: 'englishpod_(.*)dg\\.ogg' },
      { kind: 'rv', label: 'Review', pattern: 'englishpod_(.*)rv\\.ogg' },
    ],
    transcriptPattern: 'englishpod_(.*)dg\\.txt',
  };

  // Archive.org's own bookkeeping files — never playable content.
  const BOOKKEEPING = [
    /_files\.xml$/i,
    /_meta\.xml$/i,
    /_meta\.sqlite$/i,
    /_archive\.torrent$/i,
    /^__ia_thumb\.jpg$/i,
    /^\.DS_Store$/i,
  ];

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  function isBookkeeping(name) {
    const base = name.slice(name.lastIndexOf('/') + 1);
    return BOOKKEEPING.some((re) => re.test(base));
  }

  function decodeSegment(segment) {
    try {
      return decodeURIComponent(segment);
    } catch (err) {
      return segment;
    }
  }

  // Percent-encode each path segment (Archive.org serves UTF-8 file names).
  function encodePath(path) {
    return String(path)
      .split('/')
      .filter((s) => s.length)
      .map((s) => encodeURIComponent(s))
      .join('/');
  }

  /* Parse a folder URL into the item id, the (optional) subfolder and the
   * URLs used to fetch metadata and media. */
  function parseArchiveUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('Folder URL is required.');
    let url;
    try {
      url = new URL(raw);
    } catch (err) {
      throw new Error('Not a valid URL: ' + raw);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('Folder URL must use http:// or https://');
    }
    const host = url.hostname.toLowerCase();
    if (!ARCHIVE_HOSTS.includes(host)) {
      throw new Error('Only archive.org URLs are supported (got ' + host + ').');
    }
    const segments = url.pathname.split('/').filter(Boolean).map(decodeSegment);
    let itemId = '';
    let subSegments = [];
    if (segments[0] === 'download') {
      itemId = segments[1] || '';
      subSegments = segments.slice(2);
    } else if (segments[0] === 'details') {
      itemId = segments[1] || '';
    } else {
      throw new Error('Expected an archive.org/download/<item> URL.');
    }
    if (!itemId) throw new Error('Folder URL must include an item id.');
    const subPath = subSegments.join('/');
    return {
      itemId,
      subPath,
      baseUrl:
        'https://archive.org/download/' +
        encodeURIComponent(itemId) +
        '/' +
        (subPath ? encodePath(subPath) + '/' : ''),
      metadataUrl: 'https://archive.org/metadata/' + encodeURIComponent(itemId),
    };
  }

  function countCaptureGroups(source) {
    const probe = new RegExp(source + '|');
    const match = probe.exec('');
    return match ? match.length - 1 : 0;
  }

  /* Compile a file-name pattern. The pattern is anchored to the whole file
   * name and must expose at least one capture group (group 1 = pairing key). */
  function compilePattern(pattern, label) {
    const source = String(pattern || '').trim();
    const what = label ? ' for "' + label + '"' : '';
    if (!source) throw new Error('A file name pattern' + what + ' is required.');
    let regex;
    try {
      regex = new RegExp('^(?:' + source + ')$');
    } catch (err) {
      throw new Error('Invalid regular expression' + what + ': ' + err.message);
    }
    if (countCaptureGroups(source) < 1) {
      throw new Error(
        'Pattern' + what + ' needs a capture group, e.g. (.*) — group 1 pairs audio with transcripts.'
      );
    }
    return { source, regex, label: label || '' };
  }

  /* The tracks of a configuration: kind + label, in the configured order.
   * The UI builds the track selector from this, so the derivation of the
   * kinds and labels has to live in exactly one place. */
  function configTracks(config) {
    const patterns = ((config && config.audioPatterns) || []).filter(
      (p) => p && String(p.pattern || '').trim()
    );
    return patterns.map((p, i) => {
      const kind = p.kind || 't' + (i + 1);
      return { kind, label: p.label || kind, pattern: String(p.pattern).trim() };
    });
  }

  /* Build a lesson catalog from Archive.org metadata and a configuration. */
  function buildCatalog(metadata, config) {
    const cfg = config || {};
    const parsed = parseArchiveUrl(cfg.folderUrl);
    const tracks = configTracks(cfg);
    if (!tracks.length) throw new Error('Add at least one audio file name pattern.');

    const audioSpecs = tracks.map((t, i) => {
      const spec = compilePattern(t.pattern, t.label || 'track ' + (i + 1));
      spec.kind = t.kind;
      spec.label = t.label;
      return spec;
    });

    // The order of the patterns decides the order of the tracks.
    const trackOrder = new Map(tracks.map((t, i) => [t.kind, i]));

    const transcriptSpec =
      cfg.transcriptPattern && String(cfg.transcriptPattern).trim()
        ? compilePattern(cfg.transcriptPattern, 'transcript')
        : null;

    const files = Array.isArray(metadata && metadata.files) ? metadata.files : [];
    const prefix = parsed.subPath ? parsed.subPath + '/' : '';

    // Titles live in the metadata of the *original* files (the mp3 an ogg was
    // derived from), so index every file's stem -> title up front.
    const titles = new Map();
    for (const f of files) {
      if (!f || !f.name || !f.title) continue;
      const base = f.name.slice(f.name.lastIndexOf('/') + 1);
      const stem = base.replace(/\.[^.]+$/, '');
      if (!titles.has(stem)) titles.set(stem, String(f.title));
    }

    const lessons = new Map();
    const duplicates = [];
    let candidates = 0;
    let matchedFiles = 0;

    const lessonFor = (key) => {
      if (!lessons.has(key)) {
        lessons.set(key, { id: key, title: key, tracks: [], transcript: null });
      }
      return lessons.get(key);
    };

    const relativeOf = (name) => (prefix ? name.slice(prefix.length) : name);

    for (const f of files) {
      const name = f && f.name;
      if (!name || isBookkeeping(name)) continue;
      if (prefix && !name.startsWith(prefix)) continue;
      candidates += 1;
      const base = name.slice(name.lastIndexOf('/') + 1);
      const url = parsed.baseUrl + encodePath(relativeOf(name));
      for (const spec of audioSpecs) {
        const m = spec.regex.exec(base);
        if (!m) continue;
        const lesson = lessonFor(m[1].trim());
        if (lesson.tracks.some((t) => t.kind === spec.kind)) {
          duplicates.push(name);
          break;
        }
        lesson.tracks.push({
          kind: spec.kind,
          label: spec.label,
          file: name,
          url,
          size: Number(f.size) || 0,
          length: Number(f.length) || 0,
          format: f.format || '',
        });
        matchedFiles += 1;
        break; // one track per file
      }
    }

    let orphanTranscripts = 0;
    if (transcriptSpec) {
      for (const f of files) {
        const name = f && f.name;
        if (!name || isBookkeeping(name)) continue;
        if (prefix && !name.startsWith(prefix)) continue;
        const base = name.slice(name.lastIndexOf('/') + 1);
        const m = transcriptSpec.regex.exec(base);
        if (!m) continue;
        const lesson = lessons.get(m[1].trim());
        if (!lesson) {
          orphanTranscripts += 1;
          continue;
        }
        if (lesson.transcript) {
          duplicates.push(name);
          continue;
        }
        lesson.transcript = {
          file: name,
          url: parsed.baseUrl + encodePath(relativeOf(name)),
          size: Number(f.size) || 0,
        };
      }
    }

    const list = [];
    for (const lesson of lessons.values()) {
      if (!lesson.tracks.length) {
        orphanTranscripts += 1;
        continue;
      }
      // The tracks follow the order of the configured patterns, so the first
      // one is the primary track (e.g. "Podcast (full lesson)").
      lesson.tracks.sort((a, b) => trackOrder.get(a.kind) - trackOrder.get(b.kind));
      // The title comes from the first audio file set of the configuration,
      // exactly as Archive.org provides it.
      const titleSource = lesson.tracks
        .map((t) => titles.get(t.file.slice(t.file.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')))
        .find(Boolean);
      if (titleSource) lesson.title = titleSource.trim() || lesson.title;
      list.push(lesson);
    }
    list.sort((a, b) => collator.compare(a.id, b.id));

    const collectionTitle =
      (metadata && metadata.metadata && metadata.metadata.title) || parsed.itemId;

    return {
      item: parsed.itemId,
      subPath: parsed.subPath,
      baseUrl: parsed.baseUrl,
      metadataUrl: parsed.metadataUrl,
      collectionTitle,
      lessons: list,
      stats: {
        totalFiles: files.length,
        candidates,
        matchedFiles,
        lessons: list.length,
        duplicates: duplicates.length,
        orphanTranscripts,
      },
    };
  }

  // Stable key for a resource: item id + subfolder.
  function configKey(config) {
    const parsed = parseArchiveUrl(config && config.folderUrl);
    return parsed.itemId + '/' + parsed.subPath;
  }

  /* ---------------- Saved catalog history ---------------- */

  // Stable identity of a catalog: item + subfolder + the patterns that decide
  // which files belong to it. Two configurations with the same signature
  // describe the same catalog (labels are cosmetic and not part of it).
  // The pattern list is sorted, so reordering the rows in the settings dialog
  // does not create a second entry for the same catalog.
  function configSignature(config) {
    const cfg = config || {};
    const patterns = (cfg.audioPatterns || [])
      .map((p) => String((p && p.pattern) || '').trim())
      .filter(Boolean)
      .sort();
    const transcript = String(cfg.transcriptPattern || '').trim();
    let item = '';
    let sub = '';
    try {
      const parsed = parseArchiveUrl(cfg.folderUrl);
      item = parsed.itemId;
      sub = parsed.subPath;
    } catch (err) {
      item = String(cfg.folderUrl || '').trim();
    }
    // JSON keeps the parts unambiguous (a pattern may contain any separator).
    return JSON.stringify([item, sub, patterns, transcript]);
  }

  // Default display name of a configuration.
  function configLabel(config) {
    const cfg = config || {};
    try {
      const parsed = parseArchiveUrl(cfg.folderUrl);
      if (!parsed.subPath) return parsed.itemId;
      const leaf = parsed.subPath.split('/').filter(Boolean).pop() || parsed.subPath;
      return leaf + ' · ' + parsed.itemId;
    } catch (err) {
      return String(cfg.folderUrl || '').trim() || 'Archive.org';
    }
  }

  function newConfigId() {
    return (
      'cfg_' +
      Date.now().toString(36) +
      '_' +
      Math.random().toString(36).slice(2, 7)
    );
  }

  /* Insert or update a saved configuration.
   * - `entry.id` updates that entry when it exists
   * - otherwise the entry with the same signature is updated
   * - `entry.forceNew` always creates a new entry
   */
  function upsertSavedConfig(list, entry) {
    const items = Array.isArray(list) ? list.slice() : [];
    const cfg = entry && entry.config;
    const sig = (entry && entry.signature) || configSignature(cfg);
    const now = Date.now();

    let index = -1;
    if (entry && entry.id) index = items.findIndex((e) => e.id === entry.id);
    if (index < 0 && !(entry && entry.forceNew)) {
      index = items.findIndex((e) => (e.signature || configSignature(e.config)) === sig);
    }

    if (index >= 0) {
      // Merge: another entry with the same signature is replaced by this one.
      const merged = {
        ...items[index],
        name: (entry && entry.name) || items[index].name,
        config: cfg || items[index].config,
        signature: sig,
        lastUsedAt: now,
      };
      if (entry && entry.builtin) merged.builtin = true;
      // Replace the matched entry and drop any other entry with the same signature.
      const list2 = [];
      for (let i = 0; i < items.length; i++) {
        if (i === index) list2.push(merged);
        else if (items[i].signature !== sig) list2.push(items[i]);
      }
      return { list: list2, entry: merged, created: false };
    }

    const created = {
      id: (entry && entry.id) || newConfigId(),
      name: (entry && entry.name) || configLabel(cfg),
      config: cfg,
      signature: sig,
      savedAt: now,
      lastUsedAt: now,
      builtin: !!(entry && entry.builtin),
    };
    items.push(created);
    return { list: items, entry: created, created: true };
  }

  function removeSavedConfig(list, id) {
    const items = Array.isArray(list) ? list : [];
    return items.filter((e) => e.id !== id);
  }

  function findSavedConfig(list, idOrSignature) {
    const items = Array.isArray(list) ? list : [];
    return (
      items.find((e) => e.id === idOrSignature) ||
      items.find((e) => (e.signature || configSignature(e.config)) === idOrSignature) ||
      null
    );
  }

  /* ---------------- Configuration helpers ---------------- */

  // Normalize a stored or edited configuration. An empty folder URL stays
  // empty — it is reported as an error instead of silently becoming the
  // default resource.
  function normalizeConfig(cfg) {
    const patterns = Array.isArray(cfg && cfg.audioPatterns) ? cfg.audioPatterns : [];
    return {
      folderUrl: String((cfg && cfg.folderUrl) || '').trim(),
      audioPatterns: patterns
        .filter((p) => p && String(p.pattern || '').trim())
        .map((p, i) => ({
          kind: p.kind || 't' + (i + 1),
          label: String(p.label || '').trim() || 'Track ' + (i + 1),
          pattern: String(p.pattern || '').trim(),
        })),
      transcriptPattern: String((cfg && cfg.transcriptPattern) || '').trim(),
    };
  }

  // FNV-1a, 32 bit — a short stable hash of a string.
  function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  // Namespacing key for the cached catalog, the last lesson and the playback
  // position. It includes the pattern signature, so two catalogs on the same
  // folder with different patterns never share that state.
  function resourceKey(config) {
    return configKey(config) + '#' + hashString(configSignature(config));
  }

  /* ---------------- Saved catalog history (storage) ---------------- */

  // Keep the built-in catalog and the active one; drop the least recently
  // used entries once the list is longer than `max`.
  function trimSavedConfigs(list, activeId, max) {
    const items = Array.isArray(list) ? list.slice() : [];
    const limit = Math.max(1, max || MAX_SAVED_CONFIGS);
    if (items.length <= limit) return items;
    const keep = new Set();
    for (const e of items) if (e.builtin) keep.add(e.id);
    if (activeId) keep.add(activeId);
    const rest = items
      .filter((e) => !keep.has(e.id))
      .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    for (const e of rest) {
      if (keep.size >= limit) break;
      keep.add(e.id);
    }
    return items.filter((e) => keep.has(e.id));
  }

  // Read the saved catalog history from a storage-like object
  // ({ getItem, setItem }). The built-in catalog is always present.
  function readSavedConfigs(storage, options) {
    const opts = options || {};
    const now = opts.now || Date.now();
    let list = [];
    try {
      const raw = storage.getItem(SAVED_CONFIGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          list = parsed
            .filter((e) => e && e.config)
            .map((e) => ({
              id: e.id || newConfigId(),
              name: e.name || configLabel(e.config),
              config: normalizeConfig(e.config),
              // Always recompute the signature: a stored one may be stale
              // (e.g. from an older signature format) and would make two
              // identical catalogs look different.
              signature: configSignature(e.config),
              savedAt: Number.isFinite(e.savedAt) ? e.savedAt : now,
              lastUsedAt: Number.isFinite(e.lastUsedAt) ? e.lastUsedAt : now,
              builtin: !!e.builtin,
            }));
        }
      }
    } catch (err) {
      list = [];
    }

    // The built-in EnglishPod resource is always available.
    if (!list.some((e) => e.builtin)) {
      const defSig = configSignature(DEFAULT_CONFIG);
      list = list.filter((e) => e.signature !== defSig);
      const res = upsertSavedConfig(list, {
        id: DEFAULT_CONFIG_ID,
        name: 'EnglishPod',
        config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
        builtin: true,
      });
      list = res.list;
    }

    let activeId = '';
    try {
      activeId = storage.getItem(ACTIVE_CONFIG_KEY) || '';
    } catch (err) {
      activeId = '';
    }
    if (!findSavedConfig(list, activeId)) {
      activeId = list.length ? list[0].id : '';
    }
    list = trimSavedConfigs(list, activeId, opts.max || MAX_SAVED_CONFIGS);
    return { list, activeId };
  }

  // Persist the history. Returns false when the storage refused the write
  // (e.g. the quota is exhausted) so the caller can tell the user.
  function writeSavedConfigs(storage, list, activeId) {
    try {
      storage.setItem(SAVED_CONFIGS_KEY, JSON.stringify(Array.isArray(list) ? list : []));
      storage.setItem(ACTIVE_CONFIG_KEY, activeId || '');
      return true;
    } catch (err) {
      return false;
    }
  }

  return {
    DEFAULT_CONFIG,
    SAVED_CONFIGS_KEY,
    ACTIVE_CONFIG_KEY,
    DEFAULT_CONFIG_ID,
    MAX_SAVED_CONFIGS,
    parseArchiveUrl,
    compilePattern,
    configTracks,
    buildCatalog,
    configKey,
    configSignature,
    configLabel,
    newConfigId,
    normalizeConfig,
    hashString,
    resourceKey,
    upsertSavedConfig,
    removeSavedConfig,
    findSavedConfig,
    trimSavedConfigs,
    readSavedConfigs,
    writeSavedConfigs,
    encodePath,
  };
});
