/* EnglishPod PWA app logic. */
'use strict';

const CATALOG_URL = './lessons.json';
const LS_KEY = 'epod-settings';
const ARCHIVE_BASE = 'https://archive.org/download/englishpod_all/'; // keep in sync with MEDIA_PREFIX in sw.js

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
};

const TRACK_LABELS = { pb: 'Podcast (full lesson)', dg: 'Dialog', rv: 'Review' };

/* ---------------- Player adapter ----------------
 * All playback goes through this interface; app logic never touches the
 * <audio> element directly. The Capacitor build will slot in a
 * NativePlayer with the same interface — playback then runs in a native
 * foreground service that survives the screen being locked. */

class HtmlPlayer {
  constructor(el) {
    this.el = el;
    this.sleepInterval = null;
    this.listeners = { ended: [], timeupdate: [], error: [] };
    el.addEventListener('ended', () => this.emit('ended'));
    el.addEventListener('timeupdate', () => this.emit('timeupdate'));
    el.addEventListener('error', () => this.emit('error'));
    // Keep the lock-screen/notification play-pause icon in sync no matter
    // what triggered the state change (UI, media session, end of track).
    el.addEventListener('play', () => this._setPlaybackState('playing'));
    el.addEventListener('pause', () => this._setPlaybackState('paused'));
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
    const P = window.Capacitor.Plugins.AudioPlayer;
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

  load(url, opts = {}) {
    this.position = opts.resumePosition || 0;
    this.duration = 0;
    this.paused = false; // assume autoplay; corrected by the next stateChanged
    this.P.loadTrack({
      url,
      title: opts.title || '',
      artist: opts.artist || '',
      startPositionMs: Math.round((opts.resumePosition || 0) * 1000),
      autoplay: opts.autoplay !== false,
    });
  }

  play() {
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
    const deadline = Date.now() + minutes * 60000;
    this.sleepTick = setInterval(() => {
      const left = deadline - Date.now();
      if (left <= 0) {
        // Native onSleepFired will arrive too; this is the display catch-up.
        onTick('0:00');
        return;
      }
      onTick(`${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`);
    }, 1000);
    this.P.setSleepTimer({ minutes });
  }

  clearSleepTimer() {
    if (this.sleepTick) {
      clearInterval(this.sleepTick);
      this.sleepTick = null;
    }
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

  player.on('timeupdate', () => {
    els.curTime.textContent = fmtTime(player.position);
    els.durTime.textContent = fmtTime(player.duration);
    if (!seekDragging && player.duration > 0) {
      els.seekBar.value = Math.round((player.position / player.duration) * 1000);
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

// Derive any track URL from the pb file name in the catalog:
// englishpod_0001pb.ogg + kind -> englishpod_0001<kind>.ogg
function trackUrl(lesson, kind) {
  const m = /^englishpod_(\d+)(pb|dg|rv)\.ogg$/.exec(lesson.file || '');
  return m && TRACK_LABELS[kind] ? ARCHIVE_BASE + `englishpod_${m[1]}${kind}.ogg` : null;
}

// Derive the transcript URL from the audio file name:
// englishpod_0001pb.ogg -> englishpod_0001dg.txt
function transcriptUrl(lesson) {
  const m = /^englishpod_(\d+)(pb|dg|rv)\.ogg$/.exec(lesson.file || '');
  return m ? ARCHIVE_BASE + `englishpod_${m[1]}dg.txt` : null;
}

// "1" -> "0001"
function lessonNum(lesson) {
  return String(lesson.id).padStart(4, '0');
}

// "Elementary" -> "E", "Upper-Intermediate" -> "U"
function levelInitial(lesson) {
  return (lesson.type || '?').trim().charAt(0).toUpperCase();
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
  localStorage.setItem(
    LS_KEY,
    JSON.stringify({
      repeat: els.repeatSelect.value,
      autoNext: els.autoNext.checked,
    })
  );
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

function refreshStats() {
  swMessage({ type: 'stats' })
    .then(updateCacheStats)
    .catch(() => {
      els.cacheUsage.textContent = 'Cache: unavailable';
    });
}

// The SW broadcasts stats after caching/evicting media; keep the display live.
navigator.serviceWorker.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'stats') updateCacheStats(e.data);
});
// On the very first load the SW only becomes controller after registration;
// refresh stats once it takes over so the header doesn't say "unavailable".
navigator.serviceWorker.addEventListener('controllerchange', () => refreshStats());

/* ---------------- Lesson list ---------------- */

function renderLessonList(filter) {
  const q = (filter || '').trim().toLowerCase();
  els.lessonList.innerHTML = '';
  for (const lesson of catalog) {
    if (q && !`${lesson.id} ${lesson.title} ${lesson.type}`.toLowerCase().includes(q)) continue;
    const li = document.createElement('li');
    li.dataset.id = lesson.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = lessonNum(lesson);
    li.appendChild(num);
    li.appendChild(document.createTextNode(`(${levelInitial(lesson)})${lesson.title}`));
    li.title = `${lesson.type} — ${lesson.title}`;
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
  const url = trackUrl(lesson, kind) || (lesson.file ? ARCHIVE_BASE + lesson.file : null);
  if (!url) return;
  currentTrackUrl = url;
  repeatCount = 0;
  updateRepeatState();
  els.audioError.classList.add('hidden');
  player.load(url, {
    ...opts,
    title: `${lessonNum(lesson)}. ${lesson.title}`,
    artist: lesson.type || 'EnglishPod',
  });
  swMessage({ type: 'nowPlaying', url }).catch(() => {});
  localStorage.setItem('epod-last', JSON.stringify({ id: lesson.id, track: kind }));
  updateMediaSession(lesson);
}

function selectLesson(lesson, trackKind, opts = {}) {
  currentLesson = lesson;
  markActiveLesson(lesson.id);
  els.placeholder.classList.add('hidden');
  els.player.classList.remove('hidden');
  els.lessonTitle.textContent = `${lessonNum(lesson)}. ${lesson.title}`;
  els.lessonMeta.textContent = `${lesson.type} · Lesson ${lesson.id}`;

  els.trackSelect.innerHTML = '';
  for (const kind of Object.keys(TRACK_LABELS)) {
    const opt = document.createElement('option');
    opt.value = kind;
    opt.textContent = TRACK_LABELS[kind];
    els.trackSelect.appendChild(opt);
  }
  els.trackSelect.value = trackKind && TRACK_LABELS[trackKind] ? trackKind : 'pb';

  loadTranscript(lesson);
  selectTrack(els.trackSelect.value, opts);
}

let transcriptSeq = 0; // guards against stale responses overwriting newer ones

async function loadTranscript(lesson) {
  const seq = ++transcriptSeq;
  els.transcript.textContent = 'Loading transcript…';
  els.transcriptNote.textContent = '';
  const url = transcriptUrl(lesson);
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

player.on('error', () => {
  els.audioError.textContent =
    'Audio failed to load — check your connection or try another track.';
  els.audioError.classList.remove('hidden');
});

/* Confirm "really listened" after 30 s of continuous playback: only then is
 * the cache entry's access timestamp refreshed, so briefly-opened lessons
 * stay evictable under the LRU quota. Fired at most once per track load. */
player.on('timeupdate', () => {
  if (!currentTrackUrl || confirmedTouchUrl === currentTrackUrl) return;
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
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: `${lessonNum(lesson)}. ${lesson.title}`,
    artist: lesson.type,
    album: 'EnglishPod',
    artwork: [{ src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
  });
}

let lastPosState = 0;
player.on('timeupdate', () => {
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
els.search.addEventListener('input', () => renderLessonList(els.search.value));

els.btnClearCache.addEventListener('click', async () => {
  if (!confirm('Delete all cached audio and transcripts?')) return;
  els.btnClearCache.disabled = true;
  try {
    const res = await swMessage({ type: 'clear' });
    updateCacheStats(res);
  } catch (err) {
    /* ignore */
  } finally {
    els.btnClearCache.disabled = false;
  }
});

/* Save playback position so it can be resumed later. */
setInterval(() => {
  if (currentLesson && !player.paused && player.position > 0) {
    localStorage.setItem(
      'epod-position',
      JSON.stringify({ id: currentLesson.id, track: els.trackSelect.value, t: player.position })
    );
  }
}, 60000);

/* ---------------- Init ---------------- */

async function loadCatalog() {
  try {
    const resp = await fetch(CATALOG_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    catalog = await resp.json();
    try {
      localStorage.setItem('epod-catalog', JSON.stringify(catalog));
    } catch (err) {
      /* storage full — non-fatal */
    }
  } catch (err) {
    // Offline first visit or fetch failure: fall back to the mirrored copy.
    const cached = localStorage.getItem('epod-catalog');
    if (cached) {
      try {
        catalog = JSON.parse(cached);
        console.warn('Using cached catalog:', err);
      } catch (parseErr) {
        throw err; // corrupt mirror — report the original failure
      }
    } else {
      throw err;
    }
  }
}

async function init() {
  loadSettings();
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
  await loadCatalog();
  renderLessonList('');
  refreshStats();

  // Restore last played lesson (and position) if present in the list.
  let last = null;
  try {
    last = JSON.parse(localStorage.getItem('epod-last') || 'null');
  } catch (err) {
    /* ignore */
  }
  const lesson = (last && catalog.find((l) => l.id === last.id)) || catalog[0];

  let resume = 0;
  try {
    const pos = JSON.parse(localStorage.getItem('epod-position') || 'null');
    if (pos && pos.id === lesson.id && (!last || !last.track || pos.track === last.track)) {
      resume = pos.t || 0;
    }
  } catch (err) {
    /* ignore */
  }
  selectLesson(lesson, last && last.track, resume > 5 ? { resumePosition: resume } : {});
}

init().catch((err) => {
  els.placeholder.querySelector('p').textContent = 'Failed to load catalog: ' + err.message;
});

