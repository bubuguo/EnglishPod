/* EnglishPod PWA app logic. */
'use strict';

const CATALOG_URL = './lessons.json';
const LS_KEY = 'epod-settings';
const ARCHIVE_BASE = 'https://archive.org/download/englishpod_all/';

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

let catalog = null;
let currentLesson = null;
let repeatTarget = 1;
let repeatCount = 0;
let sleepMode = 'off'; // 'off' | 'track' | minutes
let sleepDeadline = 0;
let sleepTick = null;

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
    if (s.sleep) els.sleepSelect.value = s.sleep;
    if (typeof s.autoNext === 'boolean') els.autoNext.checked = s.autoNext;
  } catch (err) {
    /* ignore corrupt settings */
  }
}

function saveSettings() {
  localStorage.setItem(
    LS_KEY,
    JSON.stringify({
      repeat: els.repeatSelect.value,
      sleep: els.sleepSelect.value,
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

/* ---------------- Lesson list ---------------- */

function renderLessonList(filter) {
  const q = (filter || '').trim().toLowerCase();
  els.lessonList.innerHTML = '';
  for (const lesson of catalog) {
    if (q && !`${lesson.id} ${lesson.title} ${lesson.type}`.toLowerCase().includes(q)) continue;
    const li = document.createElement('li');
    li.dataset.id = lesson.id;
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = lessonNum(lesson);
    li.appendChild(num);
    li.appendChild(document.createTextNode(`(${levelInitial(lesson)})${lesson.title}`));
    li.title = `${lesson.type} — ${lesson.title}`;
    li.addEventListener('click', () => selectLesson(lesson));
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

function selectTrack(kind) {
  const lesson = currentLesson;
  if (!lesson) return;
  const url = trackUrl(lesson, kind) || ARCHIVE_BASE + lesson.file;
  repeatCount = 0;
  updateRepeatState();
  els.audio.src = url;
  els.audio.play().catch(() => {
    /* Autoplay may be blocked until the user interacts; controls still work. */
  });
  swMessage({ type: 'nowPlaying', url }).catch(() => {});
  localStorage.setItem('epod-last', JSON.stringify({ id: lesson.id, track: kind }));
}

function selectLesson(lesson, trackKind) {
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
  selectTrack(els.trackSelect.value);
}

async function loadTranscript(lesson) {
  els.transcript.textContent = 'Loading transcript…';
  els.transcriptNote.textContent = '';
  const url = transcriptUrl(lesson);
  if (!url) {
    els.transcript.textContent = 'No transcript available for this lesson.';
    return;
  }
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    els.transcript.textContent = (await resp.text()).trim() || '(empty transcript)';
    els.transcriptNote.textContent = '(dialog transcript)';
  } catch (err) {
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

/* ---------------- Repeat ---------------- */

els.repeatSelect.addEventListener('change', () => {
  const v = els.repeatSelect.value;
  repeatTarget = v === 'inf' ? Infinity : parseInt(v, 10) || 1;
  repeatCount = 0;
  updateRepeatState();
  saveSettings();
});

els.audio.addEventListener('ended', () => {
  if (sleepMode === 'track') {
    stopSleepTimer('Stopped at end of track');
    return;
  }
  repeatCount += 1;
  if (repeatCount < repeatTarget) {
    updateRepeatState();
    els.audio.currentTime = 0;
    els.audio.play().catch(() => {});
    return;
  }
  updateRepeatState();
  if (els.autoNext.checked) playNextLesson();
});

/* ---------------- Sleep timer ---------------- */

function stopSleepTimer(message) {
  clearInterval(sleepTick);
  sleepTick = null;
  sleepMode = 'off';
  sleepDeadline = 0;
  els.sleepSelect.value = 'off';
  els.sleepState.textContent = message || '';
  els.audio.pause();
}

function startSleepTimer(minutes) {
  clearInterval(sleepTick);
  sleepMode = minutes;
  sleepDeadline = Date.now() + minutes * 60000;
  const update = () => {
    const left = sleepDeadline - Date.now();
    if (left <= 0) {
      stopSleepTimer('Sleep timer: stopped');
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    els.sleepState.textContent = `stops in ${m}:${String(s).padStart(2, '0')}`;
  };
  update();
  sleepTick = setInterval(update, 1000);
}

els.sleepSelect.addEventListener('change', () => {
  const v = els.sleepSelect.value;
  if (v === 'off') {
    clearInterval(sleepTick);
    sleepTick = null;
    sleepMode = 'off';
    els.sleepState.textContent = '';
  } else if (v === 'track') {
    clearInterval(sleepTick);
    sleepTick = null;
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
  if (currentLesson && !els.audio.paused && els.audio.currentTime > 0) {
    localStorage.setItem(
      'epod-position',
      JSON.stringify({ id: currentLesson.id, t: els.audio.currentTime })
    );
  }
}, 5000);

/* ---------------- Init ---------------- */

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

  const resp = await fetch(CATALOG_URL);
  catalog = await resp.json();
  renderLessonList('');
  refreshStats();

  // Restore last played lesson if present in the list.
  let last = null;
  try {
    last = JSON.parse(localStorage.getItem('epod-last') || 'null');
  } catch (err) {
    /* ignore */
  }
  const lesson = (last && catalog.find((l) => l.id === last.id)) || catalog[0];
  selectLesson(lesson, last && last.track);
}

init().catch((err) => {
  els.placeholder.querySelector('p').textContent = 'Failed to load catalog: ' + err.message;
});

