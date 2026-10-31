/* Archive.org audio player PWA app logic. */
'use strict';

const LS_KEY = 'epod-settings';
const LS_CATALOG = 'epod-catalog:';
const LS_LAST = 'epod-last:';
const LS_POSITION = 'epod-position:';
const DEFAULT_CONFIG_ID = Catalog.DEFAULT_CONFIG_ID;
const MAX_SAVED_CONFIGS = Catalog.MAX_SAVED_CONFIGS;

const $ = (id) => document.getElementById(id);

const els = {
  search: $('search'),
  lessonList: $('lessonList'),
  player: $('player'),
  placeholder: $('placeholder'),
  lessonTitle: $('lessonTitle'),
  lessonMeta: $('lessonMeta'),
  trackSelect: $('trackSelect'),
  audio: $('audio'),
  audioError: $('audioError'),
  nativeBar: $('nativeBar'),
  btnPlayPause: $('btnPlayPause'),
  seekBar: $('seekBar'),
  curTime: $('curTime'),
  durTime: $('durTime'),
  repeatSelect: $('repeatSelect'),
  repeatState: $('repeatState'),
  sleepSelect: $('sleepSelect'),
  sleepState: $('sleepState'),
  autoNext: $('autoNext'),
  transcript: $('transcript'),
  transcriptNote: $('transcriptNote'),
  cacheUsage: $('cacheUsage'),
  btnClearCache: $('btnClearCache'),
  brandTitle: $('brandTitle'),
  btnSettings: $('btnSettings'),
  settingsDialog: $('settingsDialog'),
  cfgFolderUrl: $('cfgFolderUrl'),
  cfgAudioRows: $('cfgAudioRows'),
  cfgTranscript: $('cfgTranscript'),
  cfgStatus: $('cfgStatus'),
  cfgName: $('cfgName'),
  cfgSavedList: $('cfgSavedList'),
  btnAddAudioRow: $('btnAddAudioRow'),
  btnSaveAsNew: $('btnSaveAsNew'),
  btnTestSettings: $('btnTestSettings'),
  btnSaveSettings: $('btnSaveSettings'),
  btnCancelSettings: $('btnCancelSettings'),
  btnResetSettings: $('btnResetSettings'),
};

/* Track labels come from the resource configuration (see catalog.js). */
/* ---------------- Player adapter ----------------
 * All playback goes through this interface; app logic never touches the
 * <audio> element directly. The Capacitor build will slot in a
 * NativePlayer with the same interface — playback then runs in a native
 * foreground service that survives the screen being locked. */

class HtmlPlayer {
  constructor(el) {
    this.el = el;
    this.sleepInterval = null;
    this.listeners = { ended: [], timeupdate: [], error: [], stateChanged: [] };
    el.addEventListener('ended', () => this.emit('ended'));
    el.addEventListener('timeupdate', () => this.emit('timeupdate'));
    el.addEventListener('error', () => this.emit('error'));
    // Keep the lock-screen/notification play-pause icon in sync no matter
    // what triggered the state change (UI, media session, end of track).
    el.addEventListener('play', () => {
      this._setPlaybackState('playing');
      this.emit('stateChanged', { playing: true });
    });
    el.addEventListener('pause', () => {
      this._setPlaybackState('paused');
      this.emit('stateChanged', { playing: false });
    });
  }

  _setPlaybackState(state) {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
  }

  on(evt, cb) {
    if (this.listeners[evt]) this.listeners[evt].push(cb);
  }

  emit(evt, data) {
    for (const cb of this.listeners[evt] || []) cb(data);
  }

  load(url, opts = {}) {
    // Drop any pending seek from a previous load() so a slow-loading track
    // can't seek a newly loaded one to the wrong position.
    if (this._pendingSeek) {
      this.el.removeEventListener('loadedmetadata', this._pendingSeek);
      this._pendingSeek = null;
    }
    this.el.src = url;
    if (opts.resumePosition > 0) {
      const seekTo = opts.resumePosition;
      this._pendingSeek = () => {
        this.el.currentTime = seekTo;
        this.el.removeEventListener('loadedmetadata', this._pendingSeek);
        this._pendingSeek = null;
      };
      this.el.addEventListener('loadedmetadata', this._pendingSeek);
    }
    if (opts.autoplay !== false) this.play();
  }

  play() {
    return this.el.play().catch(() => {
      /* Autoplay may be blocked until the user interacts; controls still work. */
    });
  }

  pause() {
    this.el.pause();
  }

  seek(t) {
    if (isFinite(t) && t >= 0) this.el.currentTime = t;
  }

  get position() {
    return this.el.currentTime || 0;
  }

  get duration() {
    return this.el.duration;
  }

  get paused() {
    return this.el.paused;
  }

  /* The sleep timer lives in the player so a native implementation can
   * run it inside the foreground service (reliable while screen locked). */
  setSleepTimer(minutes, { onFire, onTick }) {
    this.clearSleepTimer();
    const deadline = Date.now() + minutes * 60000;
    const tick = () => {
      const left = deadline - Date.now();
      if (left <= 0) {
        this.clearSleepTimer();
        onFire();
        return;
      }
      onTick(`${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`);
    };
    tick();
    this.sleepInterval = setInterval(tick, 1000);
  }

  clearSleepTimer() {
    if (this.sleepInterval) {
      clearInterval(this.sleepInterval);
      this.sleepInterval = null;
    }
  }

  /* In the browser this interval IS the sleep timer — it has to keep running
   * while the page is hidden, otherwise the audio would never stop. */
  pauseSleepTick() {}

  resumeSleepTick() {}
}

/* True inside the Capacitor Android app (not in a plain browser). */
function CapacitorIsNative() {
  return typeof window.Capacitor !== 'undefined' &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform();
}

/* Native adapter backed by the AudioPlayer plugin (PlayerService: ExoPlayer
 * in a foreground MediaSessionService). Same interface as HtmlPlayer, so all
 * app logic (repeat, auto-next, transcript, media session fallback) works
 * unchanged. Playback — including track switching and the sleep timer — runs
 * natively and keeps working while the screen is locked.
 * Timing model: the native side is the source of truth. It pushes 1 Hz
 * 'progress' events (relayed as 'timeupdate') and fires the sleep timer
 * itself; this adapter only mirrors state and renders the countdown. */
class NativePlayer {
  constructor() {
    this.position = 0;
    this.duration = 0;
    this.paused = true;
    this.listeners = { ended: [], timeupdate: [], error: [], stateChanged: [], sleepFired: [] };
    this.sleepTick = null;
    this._pendingLoad = null; // loadTrack that failed while backgrounded
    const P = window.Capacitor.Plugins.AudioPlayer;
    // If a load was rejected because the service couldn't start (the app was
    // briefly backgrounded at launch), retry it as soon as the app is active
    // again. The plugin reports the activity state itself — the Capacitor
    // App plugin is not a dependency of this app.
    P.addListener('appState', (d) => {
      if (d && d.state === 'active') this._retryPendingLoad();
    });
    P.addListener('progress', (d) => {
      this.position = d.position || 0;
      this.duration = d.duration || 0;
      this.emit('timeupdate');
    });
    P.addListener('stateChanged', (d) => {
      this.paused = !d.playing;
      this.emit('stateChanged', d);
    });
    P.addListener('ended', () => this.emit('ended'));
    P.addListener('error', (d) => this.emit('error', d));
    P.addListener('sleepFired', () => {
      this.clearSleepTimer();
      this.emit('sleepFired');
      if (this._onFire) this._onFire();
    });
    this.P = P;
  }

  on(evt, cb) {
    if (this.listeners[evt]) this.listeners[evt].push(cb);
  }

  emit(evt, data) {
    for (const cb of this.listeners[evt] || []) cb(data);
  }

  _retryPendingLoad() {
    if (!this._pendingLoad) return;
    const params = this._pendingLoad;
    this._pendingLoad = null;
    this.P.loadTrack(params).catch(() => {
      this._pendingLoad = params; // still unavailable — keep for the next retry
    });
  }

  load(url, opts = {}) {
    this.position = opts.resumePosition || 0;
    this.duration = 0;
    this.paused = false; // assume autoplay; corrected by the next stateChanged
    const params = {
      url,
      title: opts.title || '',
      artist: opts.artist || '',
      startPositionMs: Math.round((opts.resumePosition || 0) * 1000),
      autoplay: opts.autoplay !== false,
    };
    this.P.loadTrack(params).catch(() => {
      // Service couldn't start (app backgrounded at launch): remember the
      // load and retry on the next play() or when the app becomes active.
      this._pendingLoad = params;
    });
  }

  play() {
    if (this._pendingLoad) {
      this._retryPendingLoad(); // the pending load implies autoplay
      return;
    }
    this.P.play();
  }

  pause() {
    this.P.pause();
  }

  seek(t) {
    if (isFinite(t) && t >= 0) this.P.seek({ ms: Math.round(t * 1000) });
  }

  /* Native fires exactly on time (Handler in the foreground service); the
   * 1 Hz interval here only renders the countdown while the screen is on. */
  setSleepTimer(minutes, { onFire, onTick }) {
    this.clearSleepTimer();
    this._onFire = onFire;
    this._onTick = onTick;
    this._deadline = Date.now() + minutes * 60000;
    this._startSleepTick();
    this.P.setSleepTimer({ minutes });
  }

  _startSleepTick() {
    if (this.sleepTick) return;
    const tick = () => {
      const left = this._deadline - Date.now();
      if (left <= 0) {
        // Native onSleepFired will arrive too; this is the display catch-up.
        this._onTick('0:00');
        return;
      }
      this._onTick(
        `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`
      );
    };
    tick();
    this.sleepTick = setInterval(tick, 1000);
  }

  /* The countdown is display-only: stop the 1 Hz timer while the app is in
   * the background — the native service still stops the playback on time,
   * and a timer that ticks every second in a background WebView costs
   * battery for nothing. */
  pauseSleepTick() {
    if (this.sleepTick) {
      clearInterval(this.sleepTick);
      this.sleepTick = null;
    }
  }

  resumeSleepTick() {
    if (this._deadline && Date.now() < this._deadline) this._startSleepTick();
  }

  clearSleepTimer() {
    this.pauseSleepTick();
    this._deadline = 0;
    this.P.clearSleepTimer();
  }
}

// Feature-detect the native plugin; fall back to the HTML5 audio element
// in the browser/PWA. Must come after both class declarations (no hoisting).
const IS_NATIVE = CapacitorIsNative();
const player = IS_NATIVE ? new NativePlayer() : new HtmlPlayer(els.audio);

/* In native mode the <audio> element is decoupled from the real player
 * (playback happens in PlayerService), so hide it and drive a custom bar
 * from the adapter's events instead. */
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

let seekDragging = false;

function setupNativeBar() {
  if (!IS_NATIVE) return;
  els.audio.classList.add('hidden');
  els.nativeBar.classList.remove('hidden');

  els.btnPlayPause.addEventListener('click', () => {
    if (player.paused) player.play();
    else player.pause();
  });

  els.seekBar.addEventListener('input', () => {
    seekDragging = true;
    els.curTime.textContent = fmtTime((els.seekBar.value / 1000) * player.duration);
  });
  els.seekBar.addEventListener('change', () => {
    player.seek((els.seekBar.value / 1000) * player.duration);
    seekDragging = false;
  });

  let lastStatsRefresh = 0;
  player.on('timeupdate', () => {
    els.curTime.textContent = fmtTime(player.position);
    els.durTime.textContent = fmtTime(player.duration);
    if (!seekDragging && player.duration > 0) {
      els.seekBar.value = Math.round((player.position / player.duration) * 1000);
    }
    // The native cache fills as audio streams; the init-time stats read ran
    // before the service (and its cache) even existed, so keep the display
    // fresh while playing. The native stats call walks the cache's key set,
    // so it runs once a minute, not on every tick.
    const now = Date.now();
    if (now - lastStatsRefresh > 60000) {
      lastStatsRefresh = now;
      refreshStats();
    }
  });
  player.on('stateChanged', () => {
    els.btnPlayPause.textContent = player.paused ? '▶' : '⏸';
  });
  els.btnPlayPause.textContent = player.paused ? '▶' : '⏸';
}

let catalog = null;
let currentLesson = null;
let currentTrackUrl = null;   // url currently loaded into the player
let confirmedTouchUrl = null; // url whose 30 s "really listened" signal was sent
let repeatTarget = 1;
let repeatCount = 0;
let sleepMode = 'off'; // 'off' | 'track' | minutes

/* ---------------- Catalog helpers ---------------- */

// The tracks of a lesson are the audio files matched by the configuration.
function trackOf(lesson, kind) {
  const tracks = (lesson && lesson.tracks) || [];
  return tracks.find((t) => t.kind === kind) || tracks[0] || null;
}

/* ---------------- Settings persistence ---------------- */

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (s.repeat) els.repeatSelect.value = s.repeat;
    if (typeof s.autoNext === 'boolean') els.autoNext.checked = s.autoNext;
    /* Sleep timer is intentionally not persisted: a restored selection
       with no armed timer would be misleading. */
  } catch (err) {
    /* ignore corrupt settings */
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        repeat: els.repeatSelect.value,
        autoNext: els.autoNext.checked,
      })
    );
  } catch (err) {
    /* storage full — non-fatal */
  }
}

/* ---------------- Resource configuration ---------------- */

function cloneConfig(cfg) {
  return JSON.parse(JSON.stringify(cfg));
}

function normalizeConfig(cfg) {
  return Catalog.normalizeConfig(cfg);
}

/* ---------------- Saved catalog history ---------------- */

let savedConfigs = []; // history of saved catalogs
let activeConfigId = ''; // id of the active entry

// Read the saved catalog history (the built-in catalog is always present).
function loadSavedConfigs() {
  const res = Catalog.readSavedConfigs(localStorage, { max: MAX_SAVED_CONFIGS });
  savedConfigs = res.list;
  activeConfigId = res.activeId;
  saveSavedConfigs();
}

// Persist the history. The list is trimmed to MAX_SAVED_CONFIGS entries
// (the built-in and the active catalog are never dropped).
function saveSavedConfigs() {
  savedConfigs = Catalog.trimSavedConfigs(savedConfigs, activeConfigId, MAX_SAVED_CONFIGS);
  const ok = Catalog.writeSavedConfigs(localStorage, savedConfigs, activeConfigId);
  if (!ok) setCfgStatus('Could not save the catalog history (storage is full).', 'error');
  return ok;
}

function activeEntry() {
  return Catalog.findSavedConfig(savedConfigs, activeConfigId) || savedConfigs[0] || null;
}

/* ---------------- Service worker messaging ---------------- */

function swMessage(msg) {
  return new Promise((resolve, reject) => {
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
      reject(new Error('Service worker not active'));
      return;
    }
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => resolve(e.data);
    channel.port1.onerror = (e) => reject(e.error || new Error('SW message failed'));
    navigator.serviceWorker.controller.postMessage(msg, [channel.port2]);
  });
}

function formatBytes(n) {
  if (!n) return '0 MB';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function updateCacheStats(stats) {
  if (!stats) return;
  els.cacheUsage.textContent = `Cache: ${formatBytes(stats.total)} / ${formatBytes(
    stats.quota
  )} (${stats.count} files)`;
}

async function refreshStats() {
  if (IS_NATIVE) {
    // Native mode: the audio cache is SimpleCache in PlayerService (500 MB LRU).
    try {
      const res = await player.P.cacheStats();
      updateCacheStats({ total: res.bytes || 0, quota: res.quota || 0, count: res.count || 0 });
    } catch (err) {
      els.cacheUsage.textContent = 'Cache: unavailable';
    }
    return;
  }
  swMessage({ type: 'stats' })
    .then(updateCacheStats)
    .catch(() => {
      els.cacheUsage.textContent = 'Cache: unavailable';
    });
}

// The service worker only exists in a secure context (https:// or localhost).
// On plain http://<lan-ip> the app still works — just without offline caching.
if ('serviceWorker' in navigator) {
  // The SW broadcasts stats after caching/evicting media; keep the display live.
  // In native mode the audio bytes live in PlayerService's SimpleCache (the SW
  // only caches transcripts), so SW stats would under-report — ignore them.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (IS_NATIVE) return;
    if (e.data && e.data.type === 'stats') updateCacheStats(e.data);
  });
  // On the very first load the SW only becomes controller after registration;
  // refresh stats once it takes over so the header doesn't say "unavailable".
  navigator.serviceWorker.addEventListener('controllerchange', () => refreshStats());
}

/* ---------------- Lesson list ---------------- */

function renderLessonList(filter) {
  if (!catalog) return;
  const q = (filter || '').trim().toLowerCase();
  els.lessonList.innerHTML = '';
  let index = 0;
  for (const lesson of catalog) {
    index++;
    if (q && !`${lesson.id} ${lesson.title}`.toLowerCase().includes(q)) continue;
    const li = document.createElement('li');
    li.dataset.id = lesson.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(index).padStart(4, '0');
    li.appendChild(num);
    li.appendChild(document.createTextNode(lesson.title));
    li.title = lesson.title;
    li.addEventListener('click', () => selectLesson(lesson));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectLesson(lesson);
      }
    });
    els.lessonList.appendChild(li);
  }
}

function markActiveLesson(id) {
  for (const li of els.lessonList.children) {
    li.classList.toggle('active', li.dataset.id === id);
  }
  const active = els.lessonList.querySelector('.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

/* ---------------- Player ---------------- */

function selectTrack(kind, opts = {}) {
  const lesson = currentLesson;
  if (!lesson) return;
  const track = trackOf(lesson, kind);
  if (!track) return;
  const url = track.url;
  currentTrackUrl = url;
  repeatCount = 0;
  updateRepeatState();
  els.audioError.classList.add('hidden');
  player.load(url, {
    ...opts,
    title: lesson.title,
    artist: collectionTitle,
  });
  swMessage({ type: 'nowPlaying', url }).catch(() => {});
  localStorage.setItem(LS_LAST + resourceKey, JSON.stringify({ id: lesson.id, track: track.kind }));
  updateMediaSession(lesson);
}

// The track options come straight from the "Audio file name patterns" of the
// active resource: one option per configured pattern, in the configured order.
// They are built once per catalog, not once per lesson.
function buildTrackOptions() {
  els.trackSelect.innerHTML = '';
  for (const t of Catalog.configTracks(resourceConfig)) {
    const opt = document.createElement('option');
    opt.value = t.kind;
    opt.textContent = t.label;
    els.trackSelect.appendChild(opt);
  }
}

function selectLesson(lesson, trackKind, opts = {}) {
  // The track the user picked has to be read before the select is updated.
  const wanted = trackKind || els.trackSelect.value;
  currentLesson = lesson;
  markActiveLesson(lesson.id);
  els.placeholder.classList.add('hidden');
  els.player.classList.remove('hidden');
  els.lessonTitle.textContent = lesson.title;
  els.lessonMeta.textContent = `${collectionTitle} · ${String(lesson.id).trim()}`;

  els.trackSelect.value = wanted;

  loadTranscript(lesson);
  selectTrack(els.trackSelect.value, opts);
}

let transcriptSeq = 0; // guards against stale responses overwriting newer ones

async function loadTranscript(lesson) {
  const seq = ++transcriptSeq;
  els.transcript.textContent = 'Loading transcript…';
  els.transcriptNote.textContent = '';
  const url = lesson.transcript && lesson.transcript.url;
  if (!url) {
    els.transcript.textContent = 'No transcript available for this lesson.';
    return;
  }
  try {
    const resp = await fetch(url);
    if (seq !== transcriptSeq) return; // user moved on to another lesson
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = (await resp.text()).trim() || '(empty transcript)';
    if (seq !== transcriptSeq) return;
    els.transcript.textContent = text;
    els.transcriptNote.textContent = '(dialog transcript)';
  } catch (err) {
    if (seq !== transcriptSeq) return;
    els.transcript.textContent = 'Failed to load transcript: ' + err.message;
  }
}

function updateRepeatState() {
  const target = repeatTarget === Infinity ? '∞' : String(repeatTarget);
  els.repeatState.textContent =
    repeatTarget === 1 ? '' : `play ${Math.min(repeatCount + 1, repeatTarget)}/${target}`;
}

function playNextLesson() {
  if (!currentLesson) return;
  const idx = catalog.findIndex((l) => l.id === currentLesson.id);
  const next = catalog[idx + 1];
  if (next) selectLesson(next, els.trackSelect.value);
}

function playPrevLesson() {
  if (!currentLesson) return;
  const idx = catalog.findIndex((l) => l.id === currentLesson.id);
  const prev = catalog[idx - 1];
  if (prev) selectLesson(prev, els.trackSelect.value);
}

/* ---------------- Repeat ---------------- */

els.repeatSelect.addEventListener('change', () => {
  const v = els.repeatSelect.value;
  repeatTarget = v === 'inf' ? Infinity : parseInt(v, 10) || 1;
  repeatCount = 0;
  updateRepeatState();
  saveSettings();
});

/* ---------------- Player events ---------------- */

player.on('ended', () => {
  // A finished media element stays "unpaused", so the pause event never
  // arrives — stop the position timer explicitly.
  stopPositionTimer();
  if (sleepMode === 'track') {
    stopSleepTimer('Stopped at end of track');
    return;
  }
  repeatCount += 1;
  if (repeatCount < repeatTarget) {
    updateRepeatState();
    player.seek(0);
    player.play();
    return;
  }
  updateRepeatState();
  if (els.autoNext.checked) playNextLesson();
});

player.on('error', (d) => {
  els.audioError.textContent =
    'Audio failed to load' +
    (d && d.message ? ` (${d.message})` : '') +
    ' — check your connection or try another track.';
  els.audioError.classList.remove('hidden');
});

/* Confirm "really listened" after 30 s of continuous playback: only then is
 * the cache entry's access timestamp refreshed, so briefly-opened lessons
 * stay evictable under the LRU quota. Fired at most once per track load.
 * `timeupdate` fires ~4x/s, so the check is throttled. */
let lastTouchCheck = 0;
player.on('timeupdate', () => {
  if (!currentTrackUrl || confirmedTouchUrl === currentTrackUrl) return;
  const now = Date.now();
  if (now - lastTouchCheck < 5000) return;
  lastTouchCheck = now;
  if (player.position > 30) {
    confirmedTouchUrl = currentTrackUrl;
    swMessage({ type: 'touch', url: currentTrackUrl }).catch(() => {});
  }
});

/* ---------------- Media Session (lock-screen controls) ---------------- */

function setupMediaSession() {
  // Native builds get lock-screen controls from PlayerService's MediaSession;
  // the WebView session would be idle and redundant.
  if (CapacitorIsNative() || !('mediaSession' in navigator)) return;
  const set = (name, fn) => {
    try {
      navigator.mediaSession.setActionHandler(name, fn);
    } catch (err) {
      /* handler not supported on this platform */
    }
  };
  set('play', () => player.play());
  set('pause', () => player.pause());
  set('previoustrack', playPrevLesson);
  set('nexttrack', playNextLesson);
  set('seekbackward', (d) => player.seek(player.position - ((d && d.seekOffset) || 10)));
  set('seekforward', (d) => player.seek(player.position + ((d && d.seekOffset) || 10)));
  set('seekto', (d) => {
    if (d && typeof d.seekTime === 'number') player.seek(d.seekTime);
  });
}

function updateMediaSession(lesson) {
  if (IS_NATIVE) return; // native lock-screen metadata comes from PlayerService
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: lesson.title,
    artist: collectionTitle,
    album: collectionTitle,
    artwork: [{ src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}

let lastPosState = 0;
player.on('timeupdate', () => {
  if (IS_NATIVE) return; // the native MediaSession tracks position itself
  const now = Date.now();
  if (now - lastPosState < 5000) return; // throttle wakeups
  lastPosState = now;
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = player.duration;
  if (!isFinite(d) || d <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: d,
      position: Math.min(player.position, d),
      playbackRate: 1,
    });
  } catch (err) {
    /* non-fatal */
  }
});

/* ---------------- Sleep timer ---------------- */

function stopSleepTimer(message) {
  player.clearSleepTimer();
  sleepMode = 'off';
  els.sleepSelect.value = 'off';
  els.sleepState.textContent = message || '';
  player.pause();
}

function startSleepTimer(minutes) {
  sleepMode = String(minutes);
  player.setSleepTimer(minutes, {
    onFire: () => stopSleepTimer('Sleep timer: stopped'),
    onTick: (left) => {
      if (uiHidden()) return; // nobody is looking at the countdown
      els.sleepState.textContent = `stops in ${left}`;
    },
  });
}

els.sleepSelect.addEventListener('change', () => {
  const v = els.sleepSelect.value;
  if (v === 'off') {
    player.clearSleepTimer();
    sleepMode = 'off';
    els.sleepState.textContent = '';
  } else if (v === 'track') {
    player.clearSleepTimer();
    sleepMode = 'track';
    els.sleepState.textContent = 'stops after this track';
  } else {
    startSleepTimer(parseInt(v, 10));
  }
  saveSettings();
});


/* ---------------- Other controls ---------------- */

els.trackSelect.addEventListener('change', () => selectTrack(els.trackSelect.value));
els.autoNext.addEventListener('change', saveSettings);
// Debounce the search: re-rendering hundreds of list items on every keystroke
// is slow on a phone.
let searchTimer = null;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderLessonList(els.search.value), 150);
});

els.btnClearCache.addEventListener('click', async () => {
  if (!confirm('Delete all cached audio and transcripts?')) return;
  els.btnClearCache.disabled = true;
  try {
    if (IS_NATIVE) await player.P.clearCache(); // native audio cache
  } catch (err) {
    /* ignore */
  }
  try {
    const res = await swMessage({ type: 'clear' }); // SW cache: transcripts (both modes)
    if (!IS_NATIVE) updateCacheStats(res);
  } catch (err) {
    /* ignore */
  }
  if (IS_NATIVE) refreshStats();
  els.btnClearCache.disabled = false;
});

/* Save playback position so it can be resumed later.
 *
 * The interval only runs while something is playing: a timer that ticks
 * forever in the background wakes the CPU for nothing — and in the native
 * app the WebView keeps running even when the app is in the background. */
function savePlaybackPosition() {
  if (!currentLesson || player.paused || player.position <= 0) return;
  try {
    localStorage.setItem(
      LS_POSITION + resourceKey,
      JSON.stringify({ id: currentLesson.id, track: els.trackSelect.value, t: player.position })
    );
  } catch (err) {
    /* storage full — non-fatal */
  }
}

let positionTimer = null;
function startPositionTimer() {
  if (positionTimer) return;
  positionTimer = setInterval(savePlaybackPosition, 60000);
}
function stopPositionTimer() {
  if (!positionTimer) return;
  clearInterval(positionTimer);
  positionTimer = null;
}

player.on('stateChanged', (d) => {
  const playing = d && typeof d.playing === 'boolean' ? d.playing : !player.paused;
  if (playing) startPositionTimer();
  else stopPositionTimer();
});

/* ---------------- Background / visibility ---------------- */

/* True when the UI is not visible: the browser tab is in the background or
 * (in the native app) the activity is paused. Work that only feeds the
 * display is skipped then — the audio keeps playing either way. */
let appInBackground = false;
function uiHidden() {
  return document.hidden || appInBackground;
}

function updateBackgroundState() {
  if (uiHidden()) {
    player.pauseSleepTick(); // the countdown is display-only
  } else {
    player.resumeSleepTick();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) savePlaybackPosition();
  updateBackgroundState();
});
window.addEventListener('pagehide', savePlaybackPosition);

// The native app keeps its WebView alive in the background, so the plugin
// reports when the activity is paused or resumed.
if (IS_NATIVE && player.P && typeof player.P.addListener === 'function') {
  player.P.addListener('appState', (d) => {
    appInBackground = !!(d && d.state === 'paused');
    if (appInBackground) savePlaybackPosition();
    updateBackgroundState();
  });
}

/* ---------------- Resource configuration & catalog ---------------- */

let resourceConfig = null; // active resource configuration
let resourceKey = '';      // "<item>/<subfolder>" — namespaces localStorage
let collectionTitle = 'Archive.org';

function catalogCacheKey(key) {
  return LS_CATALOG + key;
}

function readCachedCatalog(key) {
  try {
    const raw = localStorage.getItem(catalogCacheKey(key));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function writeCachedCatalog(key, built) {
  try {
    localStorage.setItem(
      catalogCacheKey(key),
      JSON.stringify({
        collectionTitle: built.collectionTitle,
        lessons: built.lessons,
        savedAt: Date.now(),
      })
    );
  } catch (err) {
    /* storage full — non-fatal */
  }
}

async function fetchMetadata(url) {
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// Load the catalog for a configuration from the Archive.org metadata API.
// The built-in EnglishPod catalog is described by Catalog.DEFAULT_CONFIG and
// is built exactly like any other catalog.
async function applyConfig(cfg) {
  const parsed = Catalog.parseArchiveUrl(cfg.folderUrl);
  const key = Catalog.resourceKey(cfg);

  const meta = await fetchMetadata(parsed.metadataUrl);
  const built = Catalog.buildCatalog(meta, cfg);
  resourceConfig = cfg;
  resourceKey = key;
  catalog = built.lessons;
  collectionTitle = built.collectionTitle;
  buildTrackOptions();
  writeCachedCatalog(key, built);
  applyCollectionTitle();
}

function applyCollectionTitle() {
  // The header shows the name the user gave the catalog; the Archive.org
  // collection title stays the MediaSession album.
  const entry = activeEntry();
  const title = (entry && entry.name) || collectionTitle;
  if (els.brandTitle) els.brandTitle.textContent = title;
  document.title = title + ' Player';
}

/* ---------------- Switching between saved catalogs ---------------- */

// Show the cached catalog of a resource right away (offline-first).
function showCachedCatalog(cfg) {
  let key = '';
  try {
    key = Catalog.resourceKey(cfg);
  } catch (err) {
    return false;
  }
  const cached = readCachedCatalog(key);
  if (!cached || !cached.lessons || !cached.lessons.length) return false;
  catalog = cached.lessons;
  collectionTitle = cached.collectionTitle || collectionTitle;
  resourceConfig = cfg;
  resourceKey = key;
  buildTrackOptions();
  applyCollectionTitle();
  renderLessonList('');
  return true;
}

// Restore the last played lesson (and position) of the active resource.
function restoreLastLesson() {
  if (!catalog || !catalog.length) return;
  let last = null;
  try {
    last = JSON.parse(localStorage.getItem(LS_LAST + resourceKey) || 'null');
  } catch (err) {
    /* ignore */
  }
  const lesson = (last && catalog.find((l) => l.id === last.id)) || catalog[0];

  let resume = 0;
  try {
    const pos = JSON.parse(localStorage.getItem(LS_POSITION + resourceKey) || 'null');
    if (pos && pos.id === lesson.id && (!last || !last.track || pos.track === last.track)) {
      resume = pos.t || 0;
    }
  } catch (err) {
    /* ignore */
  }
  selectLesson(lesson, last && last.track, resume > 5 ? { resumePosition: resume } : {});
}

let switching = false; // only one catalog switch at a time

// Switch the app to a saved catalog: cached copy first, then a fresh build.
// Returns false when another switch is already running.
async function switchToEntry(entry) {
  if (!entry) throw new Error('Unknown catalog.');
  if (switching) return false;
  switching = true;
  const previousId = activeConfigId;
  try {
    activeConfigId = entry.id;
    savedConfigs = savedConfigs.map((e) =>
      e.id === entry.id ? { ...e, lastUsedAt: Date.now() } : e
    );
    saveSavedConfigs();

    const cfg = cloneConfig(entry.config);
    const shown = showCachedCatalog(cfg);
    try {
      await applyConfig(cfg);
    } catch (err) {
      if (!shown || !catalog || !catalog.length) {
        // The new catalog could not be loaded at all — fall back to the
        // previous one so the header, the lesson list and the active entry
        // stay consistent with each other.
        activeConfigId = previousId;
        const prev = Catalog.findSavedConfig(savedConfigs, previousId);
        if (prev) {
          showCachedCatalog(cloneConfig(prev.config));
          renderLessonList('');
        }
        applyCollectionTitle();
        saveSavedConfigs();
        throw err;
      }
      console.warn('Catalog refresh failed, using the cached copy:', err);
    }
    renderLessonList('');
    refreshStats();

    if (!catalog || !catalog.length) {
      els.placeholder.classList.remove('hidden');
      els.player.classList.add('hidden');
      els.placeholder.querySelector('p').textContent =
        'No lessons found. Check the file name patterns of this catalog.';
      return true;
    }
    restoreLastLesson();
    return true;
  } finally {
    switching = false;
  }
}

/* ---------------- Settings dialog ---------------- */

function setCfgStatus(message, kind) {
  els.cfgStatus.textContent = message;
  els.cfgStatus.className = 'cfg-status' + (kind ? ' ' + kind : '');
}

function addAudioRow(spec) {
  const row = document.createElement('div');
  row.className = 'cfg-row';
  // Keep the original track kind so saving the form does not renumber the
  // tracks (the remembered track/position is stored per kind).
  row.dataset.kind = (spec && spec.kind) || '';

  const label = document.createElement('input');
  label.type = 'text';
  label.className = 'cfg-label';
  label.value = (spec && spec.label) || '';
  label.placeholder = 'Track label';

  const pattern = document.createElement('input');
  pattern.type = 'text';
  pattern.className = 'cfg-pattern';
  pattern.value = (spec && spec.pattern) || '';
  pattern.placeholder = 'name_(.*)\\.ogg';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'ghost cfg-remove';
  remove.textContent = '✕';
  remove.title = 'Remove this track';
  remove.addEventListener('click', () => row.remove());

  row.appendChild(label);
  row.appendChild(pattern);
  row.appendChild(remove);
  els.cfgAudioRows.appendChild(row);
}

function renderAudioRows(patterns) {
  els.cfgAudioRows.innerHTML = '';
  const list = patterns && patterns.length ? patterns : [{ label: 'Track 1', pattern: '' }];
  for (const spec of list) addAudioRow(spec);
}

function readAudioRows() {
  const rows = [...els.cfgAudioRows.querySelectorAll('.cfg-row')];
  const used = new Set();
  return rows
    .map((row, i) => {
      let kind = row.dataset.kind || '';
      if (!kind || used.has(kind)) {
        // A new row (or a duplicate) gets a fresh, unique kind.
        let n = used.size + 1;
        while (used.has('t' + n)) n++;
        kind = 't' + n;
      }
      used.add(kind);
      return {
        kind,
        label: row.querySelector('.cfg-label').value.trim() || 'Track ' + (i + 1),
        pattern: row.querySelector('.cfg-pattern').value.trim(),
      };
    })
    .filter((p) => p.pattern);
}

function readConfigFromForm() {
  return normalizeConfig({
    folderUrl: els.cfgFolderUrl.value.trim(),
    audioPatterns: readAudioRows(),
    transcriptPattern: els.cfgTranscript.value.trim(),
  });
}

function validateConfig(cfg) {
  Catalog.parseArchiveUrl(cfg.folderUrl);
  if (!cfg.audioPatterns.length) throw new Error('Add at least one audio file name pattern.');
  for (const p of cfg.audioPatterns) Catalog.compilePattern(p.pattern, p.label);
  if (cfg.transcriptPattern) Catalog.compilePattern(cfg.transcriptPattern, 'transcript');
}

// Short description of a configuration (item / subfolder + track count).
function describeConfig(cfg) {
  try {
    const parsed = Catalog.parseArchiveUrl(cfg.folderUrl);
    const tracks = (cfg.audioPatterns || []).length;
    const where = parsed.subPath || parsed.itemId;
    return where + ' · ' + tracks + (tracks === 1 ? ' track' : ' tracks');
  } catch (err) {
    return (cfg && cfg.folderUrl) || '';
  }
}

// Fill the form with a saved catalog.
function fillForm(entry) {
  const cfg = entry ? entry.config : Catalog.DEFAULT_CONFIG;
  renderAudioRows(cfg.audioPatterns);
  els.cfgFolderUrl.value = cfg.folderUrl;
  els.cfgTranscript.value = cfg.transcriptPattern || '';
  els.cfgName.value = entry ? entry.name : Catalog.configLabel(cfg);
}

// Render the list of saved catalogs.
function renderSavedList() {
  els.cfgSavedList.innerHTML = '';
  if (!savedConfigs.length) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = 'No saved catalogs yet.';
    els.cfgSavedList.appendChild(empty);
    return;
  }

  for (const entry of savedConfigs) {
    const row = document.createElement('div');
    row.className = 'cfg-saved-row' + (entry.id === activeConfigId ? ' active' : '');

    const info = document.createElement('div');
    info.className = 'cfg-saved-info';

    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'cfg-saved-name';
    name.value = entry.name;
    name.title = 'Catalog name';
    name.setAttribute('aria-label', 'Catalog name');
    name.addEventListener('change', () => {
      entry.name = name.value.trim() || Catalog.configLabel(entry.config);
      name.value = entry.name;
      saveSavedConfigs();
      if (entry.id === activeConfigId) applyCollectionTitle(); // the header shows the name
    });

    const url = document.createElement('span');
    url.className = 'cfg-saved-url';
    url.textContent = describeConfig(entry.config);

    info.appendChild(name);
    info.appendChild(url);

    const actions = document.createElement('div');
    actions.className = 'cfg-saved-actions';

    const load = document.createElement('button');
    load.type = 'button';
    load.className = 'ghost';
    load.textContent = 'Load';
    load.addEventListener('click', () => loadEntry(entry));

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'ghost';
    rename.textContent = 'Rename';
    rename.title = 'Edit the catalog name';
    rename.addEventListener('click', () => {
      name.focus();
      name.select();
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost';
    del.textContent = 'Delete';
    del.disabled = !!entry.builtin;
    del.title = entry.builtin ? 'The built-in catalog cannot be deleted' : 'Remove from the history';
    del.addEventListener('click', () => deleteEntry(entry));

    actions.appendChild(load);
    actions.appendChild(rename);
    actions.appendChild(del);
    row.appendChild(info);
    row.appendChild(actions);
    els.cfgSavedList.appendChild(row);
  }
}

// Switch to a saved catalog and close the dialog.
async function loadEntry(entry) {
  setCfgStatus('Loading…');
  try {
    const ok = await switchToEntry(entry);
    if (!ok) {
      setCfgStatus('Another catalog is still loading — try again in a moment.', 'error');
      return;
    }
    fillForm(entry);
    renderSavedList();
    closeSettings();
  } catch (err) {
    setCfgStatus('Failed to load: ' + err.message, 'error');
  }
}

// Remove a catalog from the history (the built-in one stays).
async function deleteEntry(entry) {
  if (entry.builtin) return;
  if (switching) {
    setCfgStatus('Another catalog is still loading — try again in a moment.', 'error');
    return;
  }
  savedConfigs = Catalog.removeSavedConfig(savedConfigs, entry.id);
  saveSavedConfigs();
  if (entry.id !== activeConfigId) {
    renderSavedList();
    return;
  }
  const next = savedConfigs[0];
  if (!next) {
    renderSavedList();
    return;
  }
  try {
    const ok = await switchToEntry(next);
    if (!ok) {
      setCfgStatus('Another catalog is still loading — try again in a moment.', 'error');
      return;
    }
    fillForm(next);
    setCfgStatus('Switched to ' + next.name + '.', 'ok');
  } catch (err) {
    setCfgStatus('Failed to load: ' + err.message, 'error');
  }
  renderSavedList();
}

function openSettings() {
  const entry = activeEntry();
  fillForm(entry);
  renderSavedList();
  setCfgStatus('');
  if (els.settingsDialog.showModal) els.settingsDialog.showModal();
  else els.settingsDialog.setAttribute('open', '');
}

function closeSettings() {
  if (els.settingsDialog.close) els.settingsDialog.close();
  else els.settingsDialog.removeAttribute('open');
}

els.btnSettings.addEventListener('click', openSettings);
els.btnCancelSettings.addEventListener('click', closeSettings);
els.btnAddAudioRow.addEventListener('click', () => addAudioRow({ label: '', pattern: '' }));

els.btnTestSettings.addEventListener('click', async () => {
  const cfg = readConfigFromForm();
  els.btnTestSettings.disabled = true;
  setCfgStatus('Fetching metadata…');
  try {
    validateConfig(cfg);
    const parsed = Catalog.parseArchiveUrl(cfg.folderUrl);
    const meta = await fetchMetadata(parsed.metadataUrl);
    const built = Catalog.buildCatalog(meta, cfg);
    const first = built.lessons[0];
    setCfgStatus(
      `OK — ${built.stats.lessons} lessons, ${built.stats.matchedFiles} audio files matched` +
        (built.stats.duplicates ? `, ${built.stats.duplicates} duplicates ignored` : '') +
        (first ? `. First: ${first.title}` : ''),
      'ok'
    );
  } catch (err) {
    setCfgStatus(err.message, 'error');
  } finally {
    els.btnTestSettings.disabled = false;
  }
});

// Save the form into the history (updating the active catalog) and load it.
async function saveForm({ forceNew }) {
  if (switching) {
    setCfgStatus('Another catalog is still loading — try again in a moment.', 'error');
    return;
  }
  const cfg = readConfigFromForm();
  const name = els.cfgName.value.trim() || Catalog.configLabel(cfg);
  const button = forceNew ? els.btnSaveAsNew : els.btnSaveSettings;
  button.disabled = true;
  switching = true;
  setCfgStatus('Loading…');
  try {
    validateConfig(cfg);
    await applyConfig(cfg);
    // The built-in catalog is permanent: editing it must not replace the
    // built-in EnglishPod resource — a new entry is created instead.
    const active = activeEntry();
    const editingBuiltin = !!(active && active.builtin);
    const isDefault =
      Catalog.configSignature(cfg) === Catalog.configSignature(Catalog.DEFAULT_CONFIG);
    const keepBuiltin = editingBuiltin && !isDefault;
    const res = Catalog.upsertSavedConfig(savedConfigs, {
      id: forceNew || keepBuiltin ? undefined : activeConfigId || undefined,
      name,
      config: cfg,
      forceNew: !!forceNew,
    });
    savedConfigs = res.list;
    activeConfigId = res.entry.id;
    saveSavedConfigs();
    applyCollectionTitle(); // the header shows the catalog name
    renderLessonList('');
    restoreLastLesson();
    renderSavedList();
    fillForm(res.entry);
    closeSettings();
  } catch (err) {
    setCfgStatus('Failed to load: ' + err.message, 'error');
  } finally {
    switching = false;
    button.disabled = false;
  }
}

els.btnSaveSettings.addEventListener('click', () => saveForm({ forceNew: false }));
els.btnSaveAsNew.addEventListener('click', () => saveForm({ forceNew: true }));

els.btnResetSettings.addEventListener('click', async () => {
  const cfg = cloneConfig(Catalog.DEFAULT_CONFIG);
  const builtin = savedConfigs.find((e) => e.builtin);
  els.btnResetSettings.disabled = true;
  setCfgStatus('Loading…');
  try {
    const res = Catalog.upsertSavedConfig(savedConfigs, {
      id: builtin ? builtin.id : DEFAULT_CONFIG_ID,
      name: builtin ? builtin.name : 'EnglishPod',
      config: cfg,
      builtin: true,
    });
    savedConfigs = res.list;
    saveSavedConfigs();
    const ok = await switchToEntry(res.entry);
    if (!ok) {
      setCfgStatus('Another catalog is still loading — try again in a moment.', 'error');
      return;
    }
    renderSavedList();
    fillForm(res.entry);
    setCfgStatus('Reset to the default resource.', 'ok');
  } catch (err) {
    setCfgStatus('Failed to load: ' + err.message, 'error');
  } finally {
    els.btnResetSettings.disabled = false;
  }
});

async function init() {
  loadSettings();
  loadSavedConfigs();
  const entry = activeEntry();
  resourceConfig = entry ? cloneConfig(entry.config) : cloneConfig(Catalog.DEFAULT_CONFIG);
  if (entry) activeConfigId = entry.id;
  repeatTarget =
    els.repeatSelect.value === 'inf' ? Infinity : parseInt(els.repeatSelect.value, 10) || 1;

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch (err) {
      console.error('SW registration failed:', err);
    }
  }

  setupMediaSession();
  setupNativeBar();

  // Show the cached catalog of the active resource right away (offline-first).
  showCachedCatalog(resourceConfig);

  try {
    await applyConfig(resourceConfig);
  } catch (err) {
    if (!catalog || !catalog.length) throw err;
    console.warn('Catalog refresh failed, using the cached copy:', err);
  }
  renderLessonList('');
  refreshStats();

  if (!catalog || !catalog.length) {
    els.placeholder.querySelector('p').textContent =
      'No lessons found. Open Settings to choose another Archive.org folder and file name patterns.';
    return;
  }

  restoreLastLesson();
}

init().catch((err) => {
  els.placeholder.querySelector('p').textContent = 'Failed to load catalog: ' + err.message;
});

