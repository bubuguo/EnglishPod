/* Unit tests for the Archive.org catalog builder (catalog.js).
 *
 * Run with: npm test   (podman + node:20 — node is not installed on the host)
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const Catalog = require('../catalog.js');

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'metadata-subfolder.json'), 'utf8')
);

const SUBFOLDER = '北京人民广播电台/长书广播/精品小说展播/';
const SUBFOLDER_URL =
  'https://archive.org/download/bjrmgbdt.zhangshuguangbo.2015/' +
  '%E5%8C%97%E4%BA%AC%E4%BA%BA%E6%B0%91%E5%B9%BF%E6%92%AD%E7%94%B5%E5%8F%B0/' +
  '%E9%95%BF%E4%B9%A6%E5%B9%BF%E6%92%AD/' +
  '%E7%B2%BE%E5%93%81%E5%B0%8F%E8%AF%B4%E5%B1%95%E6%92%AD/';

test('parseArchiveUrl: item root', () => {
  const parsed = Catalog.parseArchiveUrl('https://archive.org/download/englishpod_all');
  assert.strictEqual(parsed.itemId, 'englishpod_all');
  assert.strictEqual(parsed.subPath, '');
  assert.strictEqual(parsed.baseUrl, 'https://archive.org/download/englishpod_all/');
  assert.strictEqual(parsed.metadataUrl, 'https://archive.org/metadata/englishpod_all');
});

test('parseArchiveUrl: subfolder with percent-encoded path', () => {
  const parsed = Catalog.parseArchiveUrl(SUBFOLDER_URL);
  assert.strictEqual(parsed.itemId, 'bjrmgbdt.zhangshuguangbo.2015');
  assert.strictEqual(parsed.subPath, SUBFOLDER.slice(0, -1));
  assert.ok(parsed.baseUrl.startsWith('https://archive.org/download/bjrmgbdt.zhangshuguangbo.2015/'));
  assert.ok(parsed.baseUrl.endsWith('%E7%B2%BE%E5%93%81%E5%B0%8F%E8%AF%B4%E5%B1%95%E6%92%AD/'));
  assert.strictEqual(
    parsed.metadataUrl,
    'https://archive.org/metadata/bjrmgbdt.zhangshuguangbo.2015'
  );
});

test('parseArchiveUrl: raw (unencoded) subfolder path', () => {
  const parsed = Catalog.parseArchiveUrl(
    'https://archive.org/download/bjrmgbdt.zhangshuguangbo.2015/' + SUBFOLDER
  );
  assert.strictEqual(parsed.subPath, SUBFOLDER.slice(0, -1));
});

test('parseArchiveUrl: rejects foreign hosts and broken URLs', () => {
  assert.throws(() => Catalog.parseArchiveUrl('https://example.com/download/item'), /archive\.org/);
  assert.throws(() => Catalog.parseArchiveUrl('not a url'), /valid URL/);
  assert.throws(() => Catalog.parseArchiveUrl(''), /required/);
});

test('compilePattern: requires a valid regex with a capture group', () => {
  assert.throws(() => Catalog.compilePattern('englishpod_.*pb.ogg', 'audio'), /capture group/);
  assert.throws(() => Catalog.compilePattern('englishpod_(.*pb.ogg', 'audio'), /Invalid regular/);
  assert.throws(() => Catalog.compilePattern('', 'audio'), /required/);
  const spec = Catalog.compilePattern('englishpod_(.*)pb\\.ogg', 'audio');
  assert.strictEqual(spec.regex.test('englishpod_0001pb.ogg'), true);
  assert.strictEqual(spec.regex.test('englishpod_0001pbXogg'), false);
});

test('buildCatalog: item root pairs audio with transcripts and reads titles', () => {
  const built = Catalog.buildCatalog(fixture, {
    folderUrl: 'https://archive.org/download/englishpod_all',
    audioPatterns: [
      { kind: 'pb', label: 'Podcast', pattern: 'englishpod_(.*)pb\\.ogg' },
      { kind: 'dg', label: 'Dialog', pattern: 'englishpod_(.*)dg\\.ogg' },
    ],
    transcriptPattern: 'englishpod_(.*)dg\\.txt',
  });

  assert.strictEqual(built.lessons.length, 1);
  const lesson = built.lessons[0];
  assert.strictEqual(lesson.id, '0001');
  assert.strictEqual(lesson.title, 'Elementary - Difficult Customer');
  assert.strictEqual('type' in lesson, false);
  assert.deepStrictEqual(
    lesson.tracks.map((t) => t.kind),
    ['pb', 'dg']
  );
  assert.strictEqual(lesson.transcript.file, 'englishpod_0001dg.txt');
  assert.strictEqual(
    lesson.tracks[0].url,
    'https://archive.org/download/englishpod_all/englishpod_0001pb.ogg'
  );
});

test('configTracks: the kinds and labels of the configured patterns', () => {
  const tracks = Catalog.configTracks({
    audioPatterns: [
      { kind: 'pb', label: 'Podcast (full lesson)', pattern: 'englishpod_(.*)pb\\.ogg' },
      { kind: 'dg', label: 'Dialog', pattern: 'englishpod_(.*)dg\\.ogg' },
      { pattern: 'Chapter(.*)\\.mp3' },
      { kind: 'x', label: 'Empty', pattern: '   ' },
    ],
  });

  // Patterns without a file name are dropped, a pattern without a kind gets
  // one from its position.
  assert.deepStrictEqual(tracks, [
    { kind: 'pb', label: 'Podcast (full lesson)', pattern: 'englishpod_(.*)pb\\.ogg' },
    { kind: 'dg', label: 'Dialog', pattern: 'englishpod_(.*)dg\\.ogg' },
    { kind: 't3', label: 't3', pattern: 'Chapter(.*)\\.mp3' },
  ]);
});

test('buildCatalog: the tracks follow the configured pattern order and the title comes from the first one', () => {
  // The real archive.org listing puts the dg files before the pb files and
  // stores the titles on the original mp3 files.
  const built = Catalog.buildCatalog(
    {
      metadata: { identifier: 'englishpod_all', title: 'EnglishPod' },
      files: [
        { name: 'englishpod_0006dg.mp3', format: 'VBR MP3', title: 'Road Trip | Dialog' },
        { name: 'englishpod_0006dg.ogg', format: 'Ogg Vorbis' },
        { name: 'englishpod_0006pb.mp3', format: 'VBR MP3', title: 'Elementary - Road Trip' },
        { name: 'englishpod_0006pb.ogg', format: 'Ogg Vorbis' },
        { name: 'englishpod_0006rv.mp3', format: 'VBR MP3', title: 'Road Trip | Review' },
        { name: 'englishpod_0006rv.ogg', format: 'Ogg Vorbis' },
      ],
    },
    {
      folderUrl: 'https://archive.org/download/englishpod_all',
      audioPatterns: [
        { kind: 'pb', label: 'Podcast (full lesson)', pattern: 'englishpod_(.*)pb\\.ogg' },
        { kind: 'dg', label: 'Dialog', pattern: 'englishpod_(.*)dg\\.ogg' },
        { kind: 'rv', label: 'Review', pattern: 'englishpod_(.*)rv\\.ogg' },
      ],
      transcriptPattern: '',
    }
  );

  const lesson = built.lessons[0];
  // The order of the patterns decides the order of the tracks, no matter how
  // the files are listed in the metadata.
  assert.deepStrictEqual(
    lesson.tracks.map((t) => t.kind),
    ['pb', 'dg', 'rv']
  );
  // The title comes from the first audio file set of the configuration.
  assert.strictEqual(lesson.title, 'Elementary - Road Trip');
});

test('buildCatalog: the capture group is trimmed', () => {
  const built = Catalog.buildCatalog(
    {
      metadata: { identifier: 'chapters', title: 'Letters' },
      files: [
        {
          name: 'Chapter 03 - The Letters From No One.mp3',
          format: 'VBR MP3',
          title: 'Chapter 03 - The Letters From No One',
        },
      ],
    },
    {
      folderUrl: 'https://archive.org/download/chapters',
      audioPatterns: [{ kind: 'ch', label: 'Chapter', pattern: 'Chapter(.*)\\.mp3' }],
      transcriptPattern: '',
    }
  );

  assert.strictEqual(built.lessons[0].id, '03 - The Letters From No One');
  assert.strictEqual(built.lessons[0].title, 'Chapter 03 - The Letters From No One');
});

test('buildCatalog: subfolder only matches files inside it', () => {
  const built = Catalog.buildCatalog(fixture, {
    folderUrl: SUBFOLDER_URL,
    audioPatterns: [{ kind: 't1', label: 'Audio', pattern: '精品小说展播-(.*)\\.mp3' }],
    transcriptPattern: '',
  });

  assert.strictEqual(built.item, 'bjrmgbdt.zhangshuguangbo.2015');
  assert.strictEqual(built.collectionTitle, '北京长书广播 2015');
  assert.strictEqual(built.lessons.length, 3);
  assert.deepStrictEqual(
    built.lessons.map((l) => l.id),
    ['20150624-020000', '20150624-100000', '20150625-020000']
  );
  // No title metadata in this item -> the capture group is the title.
  assert.strictEqual(built.lessons[0].title, '20150624-020000');
  assert.strictEqual(built.lessons[0].transcript, null);
  // The URL keeps the subfolder and is percent-encoded per segment.
  assert.strictEqual(
    built.lessons[0].tracks[0].url,
    'https://archive.org/download/bjrmgbdt.zhangshuguangbo.2015/' +
      '%E5%8C%97%E4%BA%AC%E4%BA%BA%E6%B0%91%E5%B9%BF%E6%92%AD%E7%94%B5%E5%8F%B0/' +
      '%E9%95%BF%E4%B9%A6%E5%B9%BF%E6%92%AD/' +
      '%E7%B2%BE%E5%93%81%E5%B0%8F%E8%AF%B4%E5%B1%95%E6%92%AD/' +
      '%E7%B2%BE%E5%93%81%E5%B0%8F%E8%AF%B4%E5%B1%95%E6%92%AD-20150624-020000.mp3'
  );
  // Files outside the subfolder are not candidates.
  assert.strictEqual(built.stats.candidates, 3);
});

test('buildCatalog: bookkeeping files are ignored', () => {
  const built = Catalog.buildCatalog(fixture, {
    folderUrl: 'https://archive.org/download/bjrmgbdt.zhangshuguangbo.2015',
    audioPatterns: [{ kind: 't1', label: 'Audio', pattern: '(.*)\\.mp3' }],
    transcriptPattern: '',
  });
  const files = built.lessons.flatMap((l) => l.tracks.map((t) => t.file));
  assert.ok(!files.some((f) => f.endsWith('_files.xml')));
  assert.ok(!files.some((f) => f.endsWith('_meta.sqlite')));
  assert.ok(!files.some((f) => f.endsWith('_archive.torrent')));
});

test('buildCatalog: a transcript without matching audio is ignored', () => {
  const built = Catalog.buildCatalog(fixture, {
    folderUrl: 'https://archive.org/download/englishpod_all',
    audioPatterns: [{ kind: 'rv', label: 'Review', pattern: 'englishpod_(.*)rv\\.ogg' }],
    transcriptPattern: 'englishpod_(.*)dg\\.txt',
  });
  // The fixture has no review track, so the dialog transcript has no lesson.
  assert.strictEqual(built.lessons.length, 0);
  assert.strictEqual(built.stats.orphanTranscripts, 1);
});

test('configKey', () => {
  assert.strictEqual(
    Catalog.configKey({ folderUrl: SUBFOLDER_URL }),
    'bjrmgbdt.zhangshuguangbo.2015/' + SUBFOLDER.slice(0, -1)
  );
});

/* ---------------- Saved catalog history ---------------- */

const CFG_A = {
  folderUrl: 'https://archive.org/download/englishpod_all',
  audioPatterns: [{ kind: 'pb', label: 'Podcast', pattern: 'englishpod_(.*)pb\\.ogg' }],
  transcriptPattern: 'englishpod_(.*)dg\\.txt',
};

const CFG_B = {
  folderUrl: SUBFOLDER_URL,
  audioPatterns: [{ kind: 't1', label: 'Audio', pattern: '精品小说展播-(.*)\\.mp3' }],
  transcriptPattern: '',
};

test('configSignature: same catalog -> same signature, different patterns -> different', () => {
  assert.strictEqual(Catalog.configSignature(CFG_A), Catalog.configSignature({ ...CFG_A }));
  // Labels are cosmetic and not part of the identity.
  assert.strictEqual(
    Catalog.configSignature(CFG_A),
    Catalog.configSignature({
      ...CFG_A,
      audioPatterns: [{ kind: 'x', label: 'Renamed', pattern: 'englishpod_(.*)pb\\.ogg' }],
    })
  );
  assert.notStrictEqual(Catalog.configSignature(CFG_A), Catalog.configSignature(CFG_B));
  assert.notStrictEqual(
    Catalog.configSignature(CFG_A),
    Catalog.configSignature({ ...CFG_A, transcriptPattern: '' })
  );
});

test('configLabel: item root and subfolder', () => {
  assert.strictEqual(Catalog.configLabel(CFG_A), 'englishpod_all');
  assert.strictEqual(
    Catalog.configLabel(CFG_B),
    '精品小说展播 · bjrmgbdt.zhangshuguangbo.2015'
  );
  assert.strictEqual(Catalog.configLabel({ folderUrl: 'not a url' }), 'not a url');
});

test('upsertSavedConfig: insert, update in place, no duplicates', () => {
  const first = Catalog.upsertSavedConfig([], { name: 'EnglishPod', config: CFG_A });
  assert.strictEqual(first.created, true);
  assert.strictEqual(first.list.length, 1);
  assert.strictEqual(first.entry.name, 'EnglishPod');
  assert.ok(first.entry.id);

  // Same catalog -> the existing entry is updated, not duplicated.
  const second = Catalog.upsertSavedConfig(first.list, { name: 'Renamed', config: CFG_A });
  assert.strictEqual(second.created, false);
  assert.strictEqual(second.list.length, 1);
  assert.strictEqual(second.entry.id, first.entry.id);
  assert.strictEqual(second.entry.name, 'Renamed');

  // A different catalog is appended.
  const third = Catalog.upsertSavedConfig(second.list, { name: 'Chinese', config: CFG_B });
  assert.strictEqual(third.created, true);
  assert.strictEqual(third.list.length, 2);
});

test('upsertSavedConfig: update by id and forceNew', () => {
  const first = Catalog.upsertSavedConfig([], { name: 'A', config: CFG_A });
  const second = Catalog.upsertSavedConfig(first.list, { name: 'B', config: CFG_B });

  // Update by id keeps the entry and replaces its configuration.
  const updated = Catalog.upsertSavedConfig(second.list, {
    id: first.entry.id,
    name: 'A2',
    config: { ...CFG_A, transcriptPattern: '' },
  });
  assert.strictEqual(updated.created, false);
  assert.strictEqual(updated.list.length, 2);
  assert.strictEqual(updated.entry.name, 'A2');
  assert.strictEqual(updated.entry.config.transcriptPattern, '');

  // forceNew always creates another entry, even for an identical catalog.
  const forced = Catalog.upsertSavedConfig(updated.list, {
    name: 'Copy',
    config: CFG_A,
    forceNew: true,
  });
  assert.strictEqual(forced.created, true);
  assert.strictEqual(forced.list.length, 3);
  assert.notStrictEqual(forced.entry.id, first.entry.id);
});

test('removeSavedConfig and findSavedConfig', () => {
  const first = Catalog.upsertSavedConfig([], { name: 'A', config: CFG_A });
  const second = Catalog.upsertSavedConfig(first.list, { name: 'B', config: CFG_B });

  assert.strictEqual(Catalog.findSavedConfig(second.list, first.entry.id).name, 'A');
  assert.strictEqual(
    Catalog.findSavedConfig(second.list, Catalog.configSignature(CFG_B)).name,
    'B'
  );
  assert.strictEqual(Catalog.findSavedConfig(second.list, 'nope'), null);

  const removed = Catalog.removeSavedConfig(second.list, first.entry.id);
  assert.strictEqual(removed.length, 1);
  assert.strictEqual(removed[0].name, 'B');
});

/* ---------------- Saved catalog history (storage) ---------------- */

// Minimal localStorage stand-in.
function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test('configSignature: no separator collision, order-insensitive', () => {
  const one = {
    folderUrl: 'https://archive.org/download/x',
    audioPatterns: [{ pattern: 'a|b' }],
    transcriptPattern: '',
  };
  const two = {
    folderUrl: 'https://archive.org/download/x',
    audioPatterns: [{ pattern: 'a' }, { pattern: 'b' }],
    transcriptPattern: '',
  };
  // A pattern containing the separator must not look like two patterns.
  assert.notStrictEqual(Catalog.configSignature(one), Catalog.configSignature(two));
  // The order of the pattern rows does not change the catalog.
  assert.strictEqual(
    Catalog.configSignature(two),
    Catalog.configSignature({
      ...two,
      audioPatterns: [{ pattern: 'b' }, { pattern: 'a' }],
    })
  );
});

test('resourceKey: namespaced per folder AND pattern set', () => {
  const p1 = {
    folderUrl: 'https://archive.org/download/x',
    audioPatterns: [{ pattern: 'a(.*)' }],
    transcriptPattern: '',
  };
  const p2 = {
    folderUrl: 'https://archive.org/download/x',
    audioPatterns: [{ pattern: 'b(.*)' }],
    transcriptPattern: '',
  };
  assert.notStrictEqual(Catalog.resourceKey(p1), Catalog.resourceKey(p2));
  assert.strictEqual(Catalog.resourceKey(p1), Catalog.resourceKey({ ...p1 }));
  assert.ok(Catalog.resourceKey(p1).startsWith('x/#'));
});

test('normalizeConfig: an empty folder URL stays empty', () => {
  const cfg = Catalog.normalizeConfig({ folderUrl: '  ', audioPatterns: [] });
  assert.strictEqual(cfg.folderUrl, '');
  assert.throws(() => Catalog.parseArchiveUrl(cfg.folderUrl), /required/);
});

test('trimSavedConfigs: keeps the built-in and the active entry', () => {
  const list = [];
  for (let i = 0; i < 10; i++) {
    list.push({
      id: 'e' + i,
      name: 'E' + i,
      config: CFG_A,
      signature: 's' + i,
      lastUsedAt: i,
      builtin: false,
    });
  }
  list.push({
    id: 'builtin',
    name: 'EnglishPod',
    config: CFG_A,
    signature: 'sb',
    lastUsedAt: 0,
    builtin: true,
  });

  const trimmed = Catalog.trimSavedConfigs(list, 'e9', 5);
  assert.strictEqual(trimmed.length, 5);
  assert.ok(trimmed.some((e) => e.id === 'builtin'));
  assert.ok(trimmed.some((e) => e.id === 'e9'));
  // The least recently used entries are dropped first.
  assert.ok(!trimmed.some((e) => e.id === 'e0'));
  assert.ok(trimmed.some((e) => e.id === 'e8'));
});

test('readSavedConfigs: seeds the built-in catalog', () => {
  const res = Catalog.readSavedConfigs(fakeStorage(), { now: 1000 });
  assert.strictEqual(res.list.length, 1);
  assert.strictEqual(res.list[0].builtin, true);
  assert.strictEqual(res.list[0].name, 'EnglishPod');
  assert.strictEqual(res.activeId, res.list[0].id);
});

test('readSavedConfigs: an unknown legacy key is ignored (no migration)', () => {
  const storage = fakeStorage({
    'epod-resource-config': JSON.stringify({ folderUrl: 'https://archive.org/download/legacy' }),
  });
  const res = Catalog.readSavedConfigs(storage, { now: 1000 });
  assert.strictEqual(res.list.length, 1);
  assert.strictEqual(res.list[0].builtin, true);
  assert.ok(!res.list.some((e) => (e.config.folderUrl || '').includes('legacy')));
});

test('readSavedConfigs: a stored history is restored', () => {
  const storage = fakeStorage();
  const first = Catalog.readSavedConfigs(storage, { now: 1000 });
  const custom = Catalog.upsertSavedConfig(first.list, { name: 'Custom', config: CFG_B });
  Catalog.writeSavedConfigs(storage, custom.list, custom.entry.id);

  const second = Catalog.readSavedConfigs(storage, { now: 2000 });
  assert.strictEqual(second.list.length, 2);
  assert.strictEqual(second.activeId, custom.entry.id);
  assert.strictEqual(second.list.find((e) => e.id === custom.entry.id).name, 'Custom');
});

test('writeSavedConfigs: reports a failing storage', () => {
  assert.strictEqual(Catalog.writeSavedConfigs(fakeStorage(), [], 'x'), true);
  const broken = {
    getItem: () => null,
    setItem: () => {
      throw new Error('quota exceeded');
    },
  };
  assert.strictEqual(Catalog.writeSavedConfigs(broken, [], 'x'), false);
});

test('readSavedConfigs: a timestamp of 0 is not treated as missing', () => {
  const storage = fakeStorage({
    'epod-resource-configs': JSON.stringify([
      { id: 'a', name: 'A', config: CFG_A, signature: 'sa', savedAt: 0, lastUsedAt: 0 },
    ]),
  });
  const res = Catalog.readSavedConfigs(storage, { now: 1000 });
  const entry = res.list.find((e) => e.id === 'a');
  assert.strictEqual(entry.lastUsedAt, 0);
  assert.strictEqual(entry.savedAt, 0);
});

test('readSavedConfigs: a stale stored signature is recomputed', () => {
  const storage = fakeStorage({
    'epod-resource-configs': JSON.stringify([
      { id: 'a', name: 'A', config: CFG_A, signature: 'signature-from-an-older-format' },
    ]),
  });
  const res = Catalog.readSavedConfigs(storage, { now: 1000 });
  const entry = res.list.find((e) => e.id === 'a');
  assert.strictEqual(entry.signature, Catalog.configSignature(CFG_A));
  // The recomputed signature makes the entry match its config again.
  assert.strictEqual(Catalog.findSavedConfig(res.list, Catalog.configSignature(CFG_A)).id, 'a');
});
