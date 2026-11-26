'use strict';

const $ = (id) => document.getElementById(id);
const video = $('video');

const state = {
  info: null,          // probe result for the loaded file
  start: 0,
  end: 0,
  volume: 1,           // 1 = unchanged
  muted: false,
  tame: 0,             // 0..1, "Tame loud parts"
  boost: 0,            // 0..1, "Boost quiet parts"
  auto: null,          // last Auto volume result + what it was measured for
  voices: null,        // "Even out voices" analysis: { start, end, voicesBuf, gameBuf, on }
  voicesDb: 0,         // extra volume for the voices / the game, in dB
  gameDb: 0,
  voicesOk: true,      // voice model present
  mode: 'lossless',
  quality: 'original',
  keyframes: null,     // sorted keyframe times (seconds) for the loaded file
  settings: {},
  busy: false,
};

let api = null;
let audio = null;      // { ctx, gain } – WebAudio graph so preview can go above 100%

// ------------------------------------------------------------------ helpers

function fmt(t) {
  if (!isFinite(t)) t = 0;
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = s.toFixed(2).padStart(5, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function parseTime(text) {
  text = String(text).trim().replace(',', '.');
  if (!text) return NaN;
  const parts = text.split(':');
  if (parts.length > 3 || parts.some((p) => p === '' || isNaN(Number(p)))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const duration = () => (state.info ? state.info.duration : 0);
const frameStep = () => (state.info && state.info.fps ? 1 / state.info.fps : 1 / 30);

function toast(message, { error = false, actions = [], timeout = error ? 9000 : 6000 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.textContent = message;
  el.appendChild(msg);
  const box = document.createElement('div');
  box.className = 'actions';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'btn tiny' + (a.primary ? ' primary' : ' ghost');
    b.textContent = a.label;
    b.onclick = () => { a.run(); el.remove(); };
    box.appendChild(b);
  }
  const close = document.createElement('button');
  close.className = 'btn tiny ghost';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Dismiss');
  close.onclick = () => el.remove();
  box.appendChild(close);
  el.appendChild(box);
  $('toasts').appendChild(el);
  if (timeout) setTimeout(() => el.remove(), timeout);
}

function basename(p) { return p.split(/[\\/]/).pop(); }

function fmtSize(bytes) {
  if (!bytes) return '?';
  return bytes >= 1e9 ? (bytes / 1e9).toFixed(2) + ' GB' : (bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1) + ' MB';
}

// Hover explanations: any element with data-tip gets a tooltip.
let tipTarget = null;
let tipTimer = null;
function showTip(el) {
  const tip = $('tooltip');
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  let top = r.top - t.height - 8;
  if (top < 8) top = r.bottom + 8;
  const left = clamp(r.left + r.width / 2 - t.width / 2, 8, window.innerWidth - t.width - 8);
  tip.style.top = top + 'px';
  tip.style.left = left + 'px';
}
function hideTip() { clearTimeout(tipTimer); tipTarget = null; $('tooltip').hidden = true; }
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest && e.target.closest('[data-tip]');
  if (el === tipTarget) return;
  hideTip();
  if (!el) return;
  tipTarget = el;
  tipTimer = setTimeout(() => showTip(el), 350);
});
document.addEventListener('focusin', (e) => { if (e.target.dataset && e.target.dataset.tip) { tipTarget = e.target; showTip(e.target); } });
document.addEventListener('focusout', hideTip);
document.addEventListener('pointerdown', hideTip);

// ------------------------------------------------------------------ startup

window.addEventListener('pywebviewready', async () => {
  api = window.pywebview.api;
  const init = await api.init();
  state.settings = init.settings;
  state.mode = init.settings.mode || 'lossless';
  $('ffmpegWarning').hidden = init.ffmpeg_ok;
  state.voicesOk = init.voices_ok;
  renderVoices();
  renderMode();
  renderDest();
  if (init.startup_file) openPath(init.startup_file);
});

// ------------------------------------------------------------------ opening

async function openPath(path) {
  if (state.busy) return;
  const info = await api.open_file(path);
  if (!info) return;
  if (info.error) { toast(info.error, { error: true }); return; }
  loadInfo(info);
}

async function browse() {
  if (state.busy || !api) return;
  const info = await api.browse();
  if (!info) return;
  if (info.error) { toast(info.error, { error: true }); return; }
  loadInfo(info);
}

function loadInfo(info, keepTrim = false) {
  dropVoices(); // an analysis belongs to one video (and its current sound)
  state.info = info;
  state.keyframes = null;
  if (!keepTrim) {
    // A new video starts from scratch: full length, original sound.
    state.start = 0; state.end = info.duration;
    state.volume = 1; state.muted = false; state.tame = 0; state.boost = 0;
    renderDynamics();
    renderVolume();
  }
  state.auto = null;
  renderVoices();
  state.end = Math.min(state.end, info.duration);
  state.usingProxy = false;
  $('emptyState').hidden = true;
  $('editor').hidden = false;
  $('kfLayer').innerHTML = '';
  const meta = [info.width && `${info.width}×${info.height}`, info.fps && `${Math.round(info.fps * 100) / 100} fps`,
    info.video_codec.toUpperCase(), fmt(info.duration)].filter(Boolean).join(' · ');
  $('fileLabel').innerHTML = '';
  const b = document.createElement('b');
  b.textContent = info.name;
  $('fileLabel').append(b, document.createTextNode('  ' + meta));
  $('fileLabel').title = info.path;
  $('durTime').textContent = fmt(info.duration);
  for (const id of ['volume', 'autoVol', 'dynBtn', 'muteBtn']) $(id).disabled = info.audio_tracks === 0;
  $('volume').title = info.audio_tracks === 0 ? 'This video has no audio' : '';
  video.src = info.url;
  video.load();
  renderRuler();
  renderTrim();
}

window.onFileDropped = (path) => { $('dragOverlay').hidden = true; openPath(path); };

window.onKeyframes = (path, kf) => {
  if (!state.info || state.info.path !== path) return;
  state.keyframes = kf;
  renderKeyframes();
  renderTrim();
};

// Drag & drop: Python receives the real path; we only handle the visuals here.
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dragOverlay').hidden = false; });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dragOverlay').hidden = true; } });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('dragOverlay').hidden = true; });

$('emptyState').onclick = browse;
$('openBtn').onclick = browse;

// ------------------------------------------------------------------ preview fallback (HEVC etc.)

function checkPlayable() {
  if (!state.info || state.usingProxy) return;
  if (video.error || (video.readyState >= 1 && video.videoWidth === 0)) makeProxy();
}
video.addEventListener('error', checkPlayable);
video.addEventListener('loadedmetadata', () => { checkPlayable(); seek(state.start); });

async function makeProxy() {
  state.usingProxy = true;
  const info = state.info;
  $('stageOverlay').hidden = false;
  $('stageOverlayText').textContent = 'This video format can’t be previewed directly — preparing a preview copy…';
  const res = await api.make_preview(info.path);
  if (state.info !== info) return;
  $('stageOverlay').hidden = true;
  if (res.error) { toast('Could not create a preview:\n' + res.error, { error: true }); return; }
  video.src = res.url;
  video.load();
  toast('Previewing a lower-quality copy. Your export still uses the original file at full quality.');
}
window.onPreviewProgress = (p) => {
  $('stageOverlayText').textContent = `Preparing a preview copy… ${Math.round(p * 100)}%  (your export will use the original)`;
};

// ------------------------------------------------------------------ playback

function seek(t) {
  if (!state.info) return;
  video.currentTime = clamp(t, 0, duration());
  renderPlayhead();
}

function togglePlay() {
  if (!state.info) return;
  ensureAudio();
  if (video.paused) {
    const t = video.currentTime;
    if ($('loopSel').checked && (t < state.start - 0.05 || t >= state.end - 0.05)) video.currentTime = state.start;
    video.play();
  } else {
    video.pause();
  }
}

video.addEventListener('play', renderPlayIcon);
video.addEventListener('pause', renderPlayIcon);
video.addEventListener('ended', renderPlayIcon);

function renderPlayIcon() {
  $('playIcon').innerHTML = video.paused
    ? '<path fill="currentColor" d="M7 4.5v15l12-7.5-12-7.5Z"/>'
    : '<path fill="currentColor" d="M6 4h4v16H6zM14 4h4v16h-4z"/>';
}

function tick() {
  if (state.info && !video.paused && $('loopSel').checked && video.currentTime >= state.end) {
    video.currentTime = state.start;
  }
  renderPlayhead();
  syncStems();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

$('playBtn').onclick = togglePlay;
video.onclick = togglePlay;

// ------------------------------------------------------------------ volume

// Preview graph:
//   video sound ─ elGain ─┐
//   voices track ─ gain ──┼─ bus ─ loud/quiet processor ─ volume ─ speakers
//   game track ── gain ───┘
// While "Even out voices" is on, the analyzed tracks replace the video's own sound.
// The processor (dynamics-worklet.js) uses the same math as the export.
function ensureAudio() {
  if (audio) { if (audio.ctx.state === 'suspended') audio.ctx.resume(); return; }
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(video);
    const elGain = ctx.createGain();
    const bus = ctx.createGain();
    const gain = ctx.createGain();
    src.connect(elGain).connect(bus);
    bus.connect(gain).connect(ctx.destination);
    audio = { ctx, src, elGain, bus, gain, dyn: null };
    applyVolume();
    ctx.audioWorklet.addModule('dynamics-worklet.js').then(() => {
      const dyn = new AudioWorkletNode(ctx, 'dynamics', { outputChannelCount: [2] });
      bus.disconnect();
      bus.connect(dyn).connect(gain);
      audio.dyn = dyn;
      applyDynamics();
    }).catch(() => {});
  } catch (e) {
    audio = null;
  }
}

// ---- Playing the analyzed voices/game tracks in sync with the video

const dbGain = (db) => 10 ** (db / 20);
let stems = null; // { sources, gains, startedAt, offset } while playing

function voicesActive() { return !!(state.voices && state.voices.on && state.voices.voicesBuf); }

function stopStems() {
  if (!stems) return;
  for (const s of stems.sources) { try { s.stop(); } catch (e) { /* already stopped */ } }
  stems = null;
}

function startStems(offset) {
  stopStems();
  const v = state.voices;
  const make = (buffer, db) => {
    const s = audio.ctx.createBufferSource();
    s.buffer = buffer;
    const g = audio.ctx.createGain();
    g.gain.value = dbGain(db);
    s.connect(g).connect(audio.bus);
    s.start(0, offset);
    return [s, g];
  };
  const [vs, vg] = make(v.voicesBuf, state.voicesDb);
  const [gs, gg] = make(v.gameBuf, state.gameDb);
  stems = { sources: [vs, gs], gains: [vg, gg], startedAt: audio.ctx.currentTime, offset };
}

// Called every frame: keep the tracks lined up with the video (restart if they drift).
function syncStems() {
  if (!audio) return;
  const v = state.voices;
  const pos = v ? video.currentTime - v.start : -1;
  const inRange = voicesActive() && pos >= 0 && pos < v.voicesBuf.duration - 0.05;
  audio.elGain.gain.value = inRange ? 0 : 1;
  if (!inRange || video.paused || video.seeking) { stopStems(); return; }
  const playing = stems ? stems.offset + (audio.ctx.currentTime - stems.startedAt) : NaN;
  if (!stems || Math.abs(playing - pos) > 0.08) startStems(pos);
}

function applyStemGains() {
  if (stems) {
    stems.gains[0].gain.value = dbGain(state.voicesDb);
    stems.gains[1].gain.value = dbGain(state.gameDb);
  }
}

// Keep in sync with dynamics_filters() in app.py.
function dynamicsStages() {
  const stages = [];
  if (state.tame > 0) {
    stages.push({ threshold: 10 ** ((-10 - 14 * state.tame) / 20), ratio: 2 + 4 * state.tame, attack: 5, release: 120, upward: false });
  }
  if (state.boost > 0) {
    stages.push({ threshold: 10 ** (-32 / 20), ratio: 1 + 3 * state.boost, attack: 20, release: 300, upward: true });
  }
  return stages;
}

function applyDynamics() {
  if (audio && audio.dyn) audio.dyn.port.postMessage(dynamicsStages());
}

function applyVolume() {
  const v = state.muted ? 0 : state.volume;
  if (audio) audio.gain.gain.value = v;
  else video.volume = Math.min(1, v);
}

function sliderFill(el, fraction) {
  const f = clamp(fraction, 0, 1) * 100;
  el.style.background = `linear-gradient(90deg, var(--accent) ${f}%, var(--border) ${f}%)`;
}

function renderVolume() {
  const pct = Math.round(state.volume * 100);
  $('volume').value = pct;
  $('volValue').textContent = pct + '%';
  $('volValue').classList.toggle('boost', pct !== 100);
  sliderFill($('volume'), pct / Number($('volume').max));
  $('volIconPath').setAttribute('d', state.muted || pct === 0
    ? 'M4 9v6h4l5 5V4L8 9H4Zm11.6 3 2.7 2.7 1.4-1.4-2.7-2.7 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7Z'
    : 'M4 9v6h4l5 5V4L8 9H4Zm12.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4Z');
  applyVolume();
}

$('volume').addEventListener('input', (e) => {
  ensureAudio();
  state.volume = Number(e.target.value) / 100;
  state.muted = false;
  state.auto = null;
  renderVolume();
  renderAuto();
});
$('volReset').onclick = () => { state.volume = 1; state.muted = false; state.auto = null; renderVolume(); renderAuto(); };
$('muteBtn').onclick = () => { ensureAudio(); state.muted = !state.muted; renderVolume(); };
renderVolume();

// ---- Auto volume (loudness normalization to internet level)

const autoKey = () => [state.start.toFixed(2), state.end.toFixed(2), state.tame, state.boost,
  voicesActive() ? `${state.voicesDb}/${state.gameDb}` : 'orig'].join('|');
const voicesOpts = () => (voicesActive() ? { voices_db: state.voicesDb, game_db: state.gameDb } : null);

function renderAuto() {
  const btn = $('autoVol');
  const a = state.auto;
  btn.classList.toggle('on', !!a && a.key === autoKey());
  if (!a) btn.textContent = 'Auto volume';
  else if (a.key !== autoKey()) btn.textContent = 'Auto volume ↻';
  else btn.textContent = `Auto ✓ ${a.gain_db >= 0 ? '+' : ''}${a.gain_db.toFixed(1)} dB`;
  btn.title = a && a.key !== autoKey() ? 'You changed the trim or the sound settings since measuring — click to measure again' : '';
}

async function autoVolume() {
  if (!state.info || state.busy) return;
  ensureAudio();
  const btn = $('autoVol');
  btn.disabled = true;
  btn.textContent = 'Measuring…';
  const key = autoKey();
  const res = await api.measure_loudness(state.info.path, state.start, state.end, state.tame, state.boost, voicesOpts());
  btn.disabled = false;
  if (res.error) { state.auto = null; renderAuto(); toast(res.error, { error: true }); return; }
  state.volume = res.volume;
  state.muted = false;
  state.auto = { ...res, key };
  renderVolume();
  renderAuto();
  if (res.limited_by_peak) {
    toast(`Turned up ${res.gain_db.toFixed(1)} dB. It stopped there so the loudest moment doesn’t distort, so the clip is a bit quieter than the internet standard (${res.result_loudness} instead of −14 LUFS).`, { timeout: 10000 });
  }
}
$('autoVol').onclick = autoVolume;

// ---- Loud / quiet parts (optional, off by default)

function renderDynamics() {
  for (const k of ['tame', 'boost']) {
    const pct = Math.round(state[k] * 100);
    $(k).value = pct;
    sliderFill($(k), state[k]);
    $(k + 'Val').textContent = pct ? pct + '%' : 'Off';
    $(k + 'Val').classList.toggle('active', pct > 0);
  }
  const anyOn = !!(state.tame || state.boost || voicesActive());
  $('dynDot').hidden = !anyOn;
  $('dynBtn').classList.toggle('on', anyOn);
  applyDynamics();
  renderAuto();
}

for (const k of ['tame', 'boost']) {
  $(k).addEventListener('input', (e) => { ensureAudio(); state[k] = Number(e.target.value) / 100; renderDynamics(); });
}
$('dynReset').onclick = () => { state.tame = 0; state.boost = 0; renderDynamics(); };
$('dynBtn').onclick = () => {
  const open = $('dynPanel').hidden;
  $('dynPanel').hidden = !open;
  $('dynBtn').setAttribute('aria-expanded', open);
};
document.addEventListener('pointerdown', (e) => {
  if (!$('dynPanel').hidden && !e.target.closest('.dyn-wrap')) {
    $('dynPanel').hidden = true;
    $('dynBtn').setAttribute('aria-expanded', 'false');
  }
});

// ---- Even out voices (AI separation, optional)

// The analysis covers the selection plus a little margin; trimming outside it needs a new one.
function voicesCover() {
  const v = state.voices;
  return !!v && effectiveStart() >= v.start - 0.05 && state.end <= v.end + 0.05;
}

function renderVoices() {
  const v = state.voices;
  $('voicesIdle').hidden = !!v;
  $('voicesOn').hidden = !v;
  $('voicesBtn').disabled = !state.voicesOk || !state.info || !state.info.audio_tracks;
  if (!state.voicesOk) $('voicesIntro').textContent = 'The voice model is missing (models\\Kim_Vocal_2.onnx next to the app), so this isn’t available.';
  if (v) {
    $('voicesToggle').checked = v.on;
    $('voicesStale').hidden = !v.on || voicesCover();
    for (const k of ['voicesDb', 'gameDb']) {
      const el = $(k);
      el.value = state[k];
      el.disabled = !v.on;
      sliderFill(el, (state[k] - el.min) / (el.max - el.min));
      $(k + 'Val').textContent = (state[k] > 0 ? '+' : '') + state[k] + ' dB';
      $(k + 'Val').classList.toggle('active', state[k] !== 0);
    }
  }
  renderDynamics();
}

async function analyzeVoices() {
  if (!state.info || state.busy) return;
  ensureAudio();
  video.pause();
  const info = state.info;
  setBusy(true, 'Finding and evening out voices…', true);
  const res = await api.analyze_voices(info.path, effectiveStart(), state.end);
  if (res.cancelled || state.info !== info) { setBusy(false); return; }
  if (res.error) { setBusy(false); toast(res.error, { error: true }); return; }
  let voicesBuf = null, gameBuf = null;
  if (audio) {
    $('progressText').textContent = 'Loading the result for preview…';
    try {
      [voicesBuf, gameBuf] = await Promise.all([res.voices_url, res.game_url].map((u) =>
        fetch(u).then((r) => r.arrayBuffer()).then((b) => audio.ctx.decodeAudioData(b))));
    } catch (e) {
      toast('Couldn’t load the preview of the evened-out voices, but saving will still use them.', { error: true });
    }
  }
  setBusy(false);
  state.voices = { start: res.start, end: res.end, voicesBuf, gameBuf, on: true };
  renderVoices();
  toast('Voices evened out. Press play to hear it — it will be used when you save.');
}

function dropVoices() {
  stopStems();
  if (state.voices && state.info) api.forget_voices(state.info.path);
  state.voices = null;
  state.voicesDb = 0;
  state.gameDb = 0;
}

$('voicesBtn').onclick = analyzeVoices;
$('voicesAgain').onclick = analyzeVoices;
$('voicesToggle').onchange = (e) => { state.voices.on = e.target.checked; renderVoices(); };
for (const k of ['voicesDb', 'gameDb']) {
  $(k).addEventListener('input', (e) => { state[k] = Number(e.target.value); applyStemGains(); renderVoices(); });
}
window.onVoicesProgress = (p) => {
  $('progressBar').style.width = (p * 100).toFixed(1) + '%';
  $('progressText').textContent = Math.round(p * 100) + '%';
};
$('progressCancel').onclick = () => { api.cancel_voices(); $('progressText').textContent = 'Cancelling…'; };
renderDynamics();

// ------------------------------------------------------------------ trimming

// Making the file smaller means re-encoding, which always cuts frame-exact.
const effMode = () => (state.quality === 'original' ? state.mode : 'precise');

function effectiveStart() {
  // Lossless cuts can only begin on a keyframe: the one at or before the chosen start.
  if (effMode() !== 'lossless' || !state.keyframes || state.start <= 0.001) return state.start;
  let k = 0;
  for (const t of state.keyframes) { if (t <= state.start + 0.001) k = t; else break; }
  return k;
}

function setStart(t) {
  state.start = clamp(t, 0, Math.max(0, state.end - 0.1));
  renderTrim();
}
function setEnd(t) {
  state.end = clamp(t, Math.min(duration(), state.start + 0.1), duration());
  renderTrim();
}

const pct = (t) => (duration() ? (t / duration()) * 100 : 0);

function renderTrim() {
  if (!state.info) return;
  const s = pct(state.start), e = pct(state.end);
  $('selection').style.left = s + '%';
  $('selection').style.width = (e - s) + '%';
  $('handleStart').style.left = s + '%';
  $('handleEnd').style.left = e + '%';
  $('shadeLeft').style.width = s + '%';
  $('shadeRight').style.width = (100 - e) + '%';
  if (document.activeElement !== $('startInput')) $('startInput').value = fmt(state.start);
  if (document.activeElement !== $('endInput')) $('endInput').value = fmt(state.end);
  $('startInput').classList.remove('invalid');
  $('endInput').classList.remove('invalid');

  const es = effectiveStart();
  const extra = state.start - es;
  $('clipLen').textContent = fmt(state.end - es);
  $('ghost').hidden = extra <= 0.02;
  if (extra > 0.02) {
    $('ghost').style.left = pct(es) + '%';
    $('ghost').style.width = (pct(state.start) - pct(es)) + '%';
  }
  const note = $('kfNote');
  note.classList.toggle('warn', extra > 1);
  if (effMode() === 'lossless' && state.start > 0.001) {
    if (!state.keyframes) note.textContent = 'Finding keyframes…';
    else if (extra > 0.02) {
      note.innerHTML = '';
      note.append(extra > 1
        ? `⚠ This video has few keyframes, so a lossless clip will start at ${fmt(es)} — ${extra.toFixed(1)} s before your start (shaded on the timeline) — and be ${fmt(state.end - es)} long. `
        : `Lossless cuts start on a keyframe, so the clip will begin at ${fmt(es)} (${extra.toFixed(2)} s earlier). `);
      const snap = document.createElement('button');
      snap.className = 'link';
      snap.textContent = 'Snap start there';
      snap.onclick = () => setStart(es);
      note.append(snap);
      const exact = document.createElement('button');
      exact.className = 'link';
      exact.textContent = 'switch to Frame-exact';
      exact.onclick = () => { state.mode = 'precise'; renderMode(); };
      note.append(' or ', exact, ' to start exactly at ' + fmt(state.start) + '.');
    } else note.textContent = 'Start is on a keyframe — the cut will be exact.';
  } else note.textContent = '';
  renderVoices();
}

function renderPlayhead() {
  $('playhead').style.left = pct(video.currentTime || 0) + '%';
  $('curTime').textContent = fmt(video.currentTime || 0);
}

function renderRuler() {
  const ruler = $('ruler');
  ruler.innerHTML = '';
  const d = duration();
  if (!d) return;
  const width = $('track').clientWidth || 800;
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = steps.find((s) => (width / (d / s)) >= 70) || 3600;
  for (let t = 0; t <= d + 1e-6; t += step) {
    const span = document.createElement('span');
    span.style.left = pct(t) + '%';
    span.textContent = step < 1 ? fmt(t) : fmt(t).replace(/\.00$/, '');
    ruler.appendChild(span);
  }
}

function renderKeyframes() {
  const layer = $('kfLayer');
  layer.innerHTML = '';
  if (!state.keyframes || effMode() !== 'lossless') return;
  const width = $('track').clientWidth || 800;
  if (state.keyframes.length > width / 3) return; // too dense to be useful
  const frag = document.createDocumentFragment();
  for (const t of state.keyframes) {
    const i = document.createElement('i');
    i.style.left = pct(t) + '%';
    frag.appendChild(i);
  }
  layer.appendChild(frag);
}

window.addEventListener('resize', () => { renderRuler(); renderKeyframes(); });

// Timeline pointer interaction
function timeAt(clientX) {
  const r = $('track').getBoundingClientRect();
  return clamp((clientX - r.left) / r.width, 0, 1) * duration();
}

function startDrag(e, kind) {
  if (!state.info) return;
  e.preventDefault();
  e.stopPropagation();
  const wasPlaying = !video.paused;
  if (kind !== 'seek') video.pause();
  const grabT = timeAt(e.clientX);
  const s0 = state.start, e0 = state.end;
  const move = (ev) => {
    const t = timeAt(ev.clientX);
    if (kind === 'start') { setStart(t); seek(state.start); }
    else if (kind === 'end') { setEnd(t); seek(state.end); }
    else if (kind === 'move') {
      const len = e0 - s0;
      const ns = clamp(s0 + (t - grabT), 0, duration() - len);
      state.start = ns; state.end = ns + len;
      renderTrim(); seek(ns);
    } else seek(t);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (kind === 'start' || kind === 'move') seek(state.start);
    if (wasPlaying && kind !== 'end') video.play();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  if (kind === 'seek') move(e);
}

$('handleStart').addEventListener('pointerdown', (e) => startDrag(e, 'start'));
$('handleEnd').addEventListener('pointerdown', (e) => startDrag(e, 'end'));
$('selection').addEventListener('pointerdown', (e) => {
  // Short click on the selection = seek, drag = move the whole selection.
  const x0 = e.clientX;
  const probe = (ev) => {
    if (Math.abs(ev.clientX - x0) > 4) { cleanup(); startDrag(ev, 'move'); }
  };
  const cleanup = () => { window.removeEventListener('pointermove', probe); window.removeEventListener('pointerup', click); };
  const click = (ev) => { cleanup(); seek(timeAt(ev.clientX)); };
  window.addEventListener('pointermove', probe);
  window.addEventListener('pointerup', click);
  e.preventDefault();
  e.stopPropagation();
});
$('track').addEventListener('pointerdown', (e) => startDrag(e, 'seek'));

// Trim inputs and buttons
for (const [id, setter] of [['startInput', setStart], ['endInput', setEnd]]) {
  const el = $(id);
  const commit = () => {
    const t = parseTime(el.value);
    if (isNaN(t)) { el.classList.add('invalid'); return; }
    setter(t);
    el.value = fmt(id === 'startInput' ? state.start : state.end);
    seek(id === 'startInput' ? state.start : state.end);
  };
  el.addEventListener('change', commit);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commit(); el.blur(); }
    if (e.key === 'Escape') { el.blur(); renderTrim(); }
  });
  el.addEventListener('blur', () => renderTrim());
}

document.querySelectorAll('.nudge').forEach((b) => {
  b.onclick = () => {
    const d = Number(b.dataset.delta);
    if (b.dataset.target === 'start') { setStart(state.start + d); seek(state.start); }
    else { setEnd(state.end + d); seek(state.end); }
  };
});

$('setStart').onclick = () => setStart(video.currentTime);
$('setEnd').onclick = () => setEnd(video.currentTime);
$('resetTrim').onclick = () => { state.start = 0; state.end = duration(); renderTrim(); };

// ------------------------------------------------------------------ keyboard

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); browse(); return; }
  if (e.key === 'Escape') { closeModals(); return; }
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  if (e.target.type === 'range' && e.key.startsWith('Arrow')) return; // arrows move the slider
  if (tag === 'select' || !state.info || state.busy || anyModalOpen()) return;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'i': case 'I': setStart(video.currentTime); break;
    case 'o': case 'O': setEnd(video.currentTime); break;
    case 'ArrowLeft': e.preventDefault(); video.pause(); seek(video.currentTime - (e.shiftKey ? 1 : frameStep())); break;
    case 'ArrowRight': e.preventDefault(); video.pause(); seek(video.currentTime + (e.shiftKey ? 1 : frameStep())); break;
    case 'Home': e.preventDefault(); seek(state.start); break;
    case 'End': e.preventDefault(); seek(Math.max(state.start, state.end - 0.05)); break;
  }
});

// ------------------------------------------------------------------ export

function renderMode() {
  const mode = effMode();
  const shrinking = state.quality !== 'original';
  document.querySelectorAll('.segmented button').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.classList.toggle('disabled', shrinking && b.dataset.mode === 'lossless');
    b.setAttribute('aria-checked', on);
  });
  $('modeNote').textContent = shrinking
    ? 'Making the file smaller re-processes the video, so the cut is frame-exact. Pick “Original quality” to use Lossless.'
    : mode === 'lossless'
      ? 'Copies the original video data as-is — no quality loss, done in seconds.'
      : 'Cuts on the exact frame. Video is re-processed at very high quality (slower).';
  $('quality').value = state.quality;
  renderKeyframes();
  renderTrim();
}
document.querySelectorAll('.segmented button').forEach((b) => {
  b.onclick = () => {
    if (state.quality !== 'original' && b.dataset.mode === 'lossless') {
      toast('Lossless only works with “Original quality”. Change the file size setting back to use it.');
      return;
    }
    state.mode = b.dataset.mode;
    renderMode();
  };
});
$('quality').onchange = (e) => { state.quality = e.target.value; renderMode(); };

function renderDest() {
  const s = state.settings;
  const folder = s.default_folder_resolved;
  $('destPath').textContent = folder && !s.always_ask ? folder : 'Ask every time';
  $('destPath').title = $('destPath').textContent;
  $('setFolderPath').textContent = folder || 'Not set — you’ll be asked each time';
  $('setFolderPath').title = folder || '';
  $('setAlwaysAsk').checked = !!s.always_ask;
  $('setReveal').checked = !!s.reveal_after_export;
  $('setSuffix').value = s.suffix ?? '_clip';
  $('setMode').value = s.mode || 'lossless';
  $('suffixExample').textContent = `e.g. my video${s.suffix ?? ''}.mp4`;
}

$('changeDest').onclick = openSettings;

function setBusy(on, title, cancelable = false) {
  state.busy = on;
  $('progressModal').hidden = !on;
  $('progressActions').hidden = !cancelable;
  $('progressTitle').textContent = title || 'Saving clip…';
  $('progressBar').style.width = '0%';
  $('progressText').textContent = '0%';
  $('exportBtn').disabled = on;
  $('replaceBtn').disabled = on;
}
window.onExportProgress = (p) => {
  $('progressBar').style.width = (p * 100).toFixed(1) + '%';
  $('progressText').textContent = Math.round(p * 100) + '%';
};

function exportOptions(target, folder) {
  return {
    path: state.info.path, start: state.start, end: state.end,
    volume: state.volume, tame: state.tame, boost: state.boost,
    mode: effMode(), quality: state.quality, voices: voicesOpts(), target, folder,
  };
}

// "Even out voices" only works inside the analyzed part of the video.
function voicesReady() {
  if (!voicesActive() || voicesCover()) return true;
  toast('“Even out voices” was analyzed for a different part of the video. Click “Analyze again” in the Sound panel, or turn it off.', { error: true });
  return false;
}

// What actually came out, so a surprising file size is easy to explain.
function resultSummary(res) {
  let text = `${fmt(res.duration)} long · ${fmtSize(res.size)}`;
  if (res.requested_start - res.start > 0.5) {
    text += `\nStarts at ${fmt(res.start)} instead of ${fmt(res.requested_start)} (nearest keyframe).`;
  }
  return text;
}

async function exportCopy() {
  if (!state.info || state.busy || !voicesReady()) return;
  video.pause();
  const s = state.settings;
  let folder = s.default_folder_resolved;
  let picked = false;
  if (!folder || s.always_ask) {
    folder = await api.pick_export_folder(folder || state.info.folder);
    if (!folder) return;
    picked = true;
  }
  setBusy(true, 'Saving clip…');
  const res = await api.export(exportOptions('copy', folder));
  setBusy(false);
  if (res.error) { toast('Export failed:\n' + res.error, { error: true }); return; }
  const actions = [{ label: 'Show in folder', run: () => api.reveal(res.output) }];
  toast(`Saved ${basename(res.output)}\n${resultSummary(res)}`, { actions, timeout: 10000 });
  if (picked && !s.default_folder_resolved) {
    toast(`Always save clips to “${folder}”?`, {
      timeout: 15000,
      actions: [{ label: 'Make default', primary: true, run: async () => { state.settings = await api.set_default_folder(folder); renderDest(); } }],
    });
  }
}

function askReplace() {
  if (!state.info || state.busy || !voicesReady()) return;
  video.pause();
  const es = effectiveStart();
  $('confirmText').textContent = `“${state.info.name}” will be overwritten with the part from ${fmt(es)} to ${fmt(state.end)} (${fmt(state.end - es)} long).`;
  $('confirmModal').hidden = false;
  $('confirmOk').focus();
}

async function doReplace() {
  $('confirmModal').hidden = true;
  const info = state.info;
  const keep = { start: state.start, end: state.end };
  setBusy(true, 'Replacing original…');
  const opts = exportOptions('replace');
  // Release the file from the player so Windows lets us overwrite it.
  video.removeAttribute('src');
  video.load();
  await api.release(info.path);
  const res = await api.export(opts);
  setBusy(false);
  if (res.error) {
    toast('Replace failed:\n' + res.error, { error: true });
    const again = await api.open_file(info.path);
    if (again && !again.error) { loadInfo(again, true); state.start = keep.start; state.end = keep.end; renderTrim(); }
    return;
  }
  toast(`Replaced ${info.name}\n${resultSummary(res)}`, {
    actions: [{ label: 'Show in folder', run: () => api.reveal(res.output) }], timeout: 10000,
  });
  const fresh = await api.open_file(info.path);
  if (fresh && !fresh.error) loadInfo(fresh);
}

$('exportBtn').onclick = exportCopy;
$('replaceBtn').onclick = askReplace;
$('confirmCancel').onclick = () => { $('confirmModal').hidden = true; };
$('confirmOk').onclick = doReplace;

// ------------------------------------------------------------------ settings

function anyModalOpen() { return !$('settingsModal').hidden || !$('confirmModal').hidden || !$('progressModal').hidden; }
function closeModals() { $('settingsModal').hidden = true; $('confirmModal').hidden = true; $('dynPanel').hidden = true; }

function openSettings() { renderDest(); $('settingsModal').hidden = false; }
$('settingsBtn').onclick = openSettings;
$('settingsDone').onclick = () => { $('settingsModal').hidden = true; };
$('settingsModal').addEventListener('pointerdown', (e) => { if (e.target === $('settingsModal')) $('settingsModal').hidden = true; });

$('setFolderBtn').onclick = async () => { state.settings = await api.choose_default_folder(); renderDest(); };
$('clearFolderBtn').onclick = async () => { state.settings = await api.set_default_folder(''); renderDest(); };

async function saveSetting(changes) { state.settings = await api.update_settings(changes); renderDest(); }
$('setAlwaysAsk').onchange = (e) => saveSetting({ always_ask: e.target.checked });
$('setReveal').onchange = (e) => saveSetting({ reveal_after_export: e.target.checked });
$('setSuffix').onchange = (e) => saveSetting({ suffix: e.target.value.replace(/[\\/:*?"<>|]/g, '') });
$('setMode').onchange = (e) => { saveSetting({ mode: e.target.value }); state.mode = e.target.value; renderMode(); };
