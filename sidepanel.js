import { FilesetResolver, HandLandmarker } from './vendor/tasks-vision/vision_bundle.mjs';

// Gesture tuning
const SCROLL_GAIN = 1600;      // page px per full camera-height of fist travel
const FLING_MIN = 350;         // px/s of release velocity needed to fling
const PINCH_RATIO = 0.45;      // thumb–index distance / hand size below this = pinch
const EXT_RATIO = 1.15;        // tip/pip wrist-distance ratio above this = finger extended
const POSE_STABLE_FRAMES = 3;  // frames a pose must persist before it acts
const PEACE_HOLD_S = 0.9;      // hold ✌️ this long to toggle the keyboard
const ZOOM_MIN = 0.4, ZOOM_MAX = 4;

const statusEl = document.getElementById('status');
const modeEl = document.getElementById('mode');
const zoomEl = document.getElementById('zoomLabel');
const progressEl = document.getElementById('progress');
const retryBtn = document.getElementById('retryCam');
const video = document.getElementById('cam');
const preview = document.getElementById('preview');
const pctx = preview.getContext('2d');

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = cls;
}
function setMode(text, active) {
  modeEl.textContent = text;
  modeEl.className = active ? 'active' : '';
}

// Exposed for headless tests and debugging: inject synthetic landmark frames
// and observe the state machine without a camera.
let injected = null;
window.__hwInject = (hands) => { injected = { hands, t: performance.now() }; };
window.__hwState = { mode: 'idle', zoom: 1, targetTabId: null, kbd: false, pose: '' };

// ------------------------------------------------------------ hand tracking
let landmarker = null;
let camReady = false;
let lastVideoTime = -1;

async function initTracking() {
  try {
    setStatus('loading hand tracker…');
    const fileset = await FilesetResolver.forVisionTasks('vendor/tasks-vision/wasm');
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: 'vendor/hand_landmarker.task', delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
    try {
      landmarker = await HandLandmarker.createFromOptions(fileset, options('GPU'));
    } catch {
      landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
    }
  } catch (err) {
    console.warn('hand tracker failed to load:', err);
    setStatus('hand tracker failed to load', 'error');
    return;
  }
  await initCamera();
}

async function initCamera() {
  try {
    setStatus('requesting camera…');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    camReady = true;
    retryBtn.style.display = 'none';
    setStatus('show a hand to the camera ✋');
  } catch (err) {
    console.warn('camera unavailable:', err);
    setStatus('camera blocked or unavailable', 'error');
    retryBtn.style.display = 'block';
  }
}
retryBtn.addEventListener('click', initCamera);
initTracking();

// -------------------------------------------------------- pose classification
// Landmark indices: 0 wrist, 4 thumb tip, 8 index tip, 9 middle MCP, etc.
// All positions are converted to screen fractions: sx (0 left → 1 right,
// mirrored so your hand moves like a mouse), sy (0 top → 1 bottom).
const PALM_POINTS = [0, 5, 9, 13, 17];

function classify(lm) {
  const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
  const size = d(0, 9) || 1e-3;
  const ext = (tip, pip) => d(0, tip) > d(0, pip) * EXT_RATIO;
  const extI = ext(8, 6), extM = ext(12, 10), extR = ext(16, 14), extP = ext(20, 18);
  const pinching = d(4, 8) / size < PINCH_RATIO;

  let pose = 'point';
  if (!extI && !extM && !extR && !extP) pose = 'fist';
  else if (pinching && extM && extR) pose = 'pinch';
  else if (extI && extM && !extR && !extP && !pinching) pose = 'peace';
  else if (extI && extM && extR && extP) pose = 'open';

  let px = 0, py = 0;
  for (const i of PALM_POINTS) { px += lm[i].x; py += lm[i].y; }
  px /= PALM_POINTS.length; py /= PALM_POINTS.length;

  return {
    pose,
    palm: { sx: 1 - px, sy: py },
    tip: { sx: 1 - lm[8].x, sy: lm[8].y },
    lm,
  };
}

// ----------------------------------------------------------- target tab plumbing
let targetCache = { tab: null, t: 0 };
let selfTabId = null;
chrome.tabs.getCurrent?.().then((tab) => { selfTabId = tab?.id ?? null; }).catch(() => {});

async function getTargetTab() {
  const now = performance.now();
  if (targetCache.tab && now - targetCache.t < 800) return targetCache.tab;
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const candidates = tabs.filter((t) => t.id !== selfTabId);
  let tab = candidates.find((t) => t.active) || null;
  if (!tab && candidates.length) {
    tab = candidates.reduce((a, b) => ((a.lastAccessed || 0) >= (b.lastAccessed || 0) ? a : b));
  }
  targetCache = { tab, t: now };
  window.__hwState.targetTabId = tab?.id ?? null;
  return tab;
}

let unreachable = false;
async function sendToTab(msg) {
  const tab = await getTargetTab();
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { hw: true, ...msg });
    unreachable = false;
  } catch {
    unreachable = true; // chrome:// pages, web store, or tab not yet loaded
  }
}

// The content script tells us when its ✕ key closed the keyboard.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.hw && msg.t === 'kbdClosed') {
    kbdOn = false;
    window.__hwState.kbd = false;
  }
});

// ------------------------------------------------------------- state machine
let stablePose = 'none';
let rawPose = 'none';
let poseCount = 0;
let smoothed = null;        // smoothed primary-hand positions
let scroll = { active: false, last: null, vx: 0, vy: 0 };
let zoom = { active: false, pending: false, baseDist: 0, baseZoom: 1, lastSent: 0, current: 1 };
let peaceHeld = 0;
let peaceArmed = true;
let pressArmed = true;
let kbdOn = false;
let lastHandSeen = 0;

function handDistance(a, b) {
  return Math.hypot(a.palm.sx - b.palm.sx, a.palm.sy - b.palm.sy);
}

function resetInteractions(now) {
  if (scroll.active) endScroll();
  zoom.active = zoom.pending = false;
  peaceHeld = 0;
  progressEl.style.width = '0%';
  if (now - lastHandSeen > 400) {
    sendToTab({ t: 'cursor', mode: 'none', kbd: kbdOn });
    setMode('idle', false);
    window.__hwState.mode = 'idle';
  }
}

function endScroll() {
  scroll.active = false;
  if (Math.hypot(scroll.vx, scroll.vy) > FLING_MIN) {
    sendToTab({ t: 'fling', vx: scroll.vx, vy: scroll.vy });
  }
  scroll.vx = scroll.vy = 0;
  scroll.last = null;
}

async function enterZoom(dist) {
  zoom.pending = true;
  try {
    const tab = await getTargetTab();
    if (!tab) { zoom.pending = false; return; }
    const z = await chrome.tabs.getZoom(tab.id);
    if (!zoom.pending) return;
    zoom.baseZoom = z;
    zoom.baseDist = dist;
    zoom.current = z;
    zoom.active = true;
    zoom.pending = false;
  } catch {
    zoom.pending = false;
  }
}

async function applyZoom(dist, now) {
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom.baseZoom * (dist / zoom.baseDist)));
  zoom.current = z;
  window.__hwState.zoom = z;
  zoomEl.textContent = `zoom ${Math.round(z * 100)}%`;
  if (now - zoom.lastSent > 90) {
    zoom.lastSent = now;
    try {
      const tab = await getTargetTab();
      if (tab) await chrome.tabs.setZoom(tab.id, z);
    } catch { /* unzoomable page */ }
  }
}

function step(hands, now, dt) {
  if (hands.length === 0) {
    stablePose = rawPose = 'none';
    poseCount = 0;
    smoothed = null;
    resetInteractions(now);
    return;
  }
  lastHandSeen = now;

  const classified = hands.map(classify);

  // ---- two-handed pinch & stretch = zoom
  const pinched = classified.filter((h) => h.pose === 'pinch');
  if (classified.length >= 2 && pinched.length >= 2) {
    if (scroll.active) endScroll();
    const dist = handDistance(pinched[0], pinched[1]);
    if (!zoom.active && !zoom.pending) enterZoom(dist);
    else if (zoom.active) applyZoom(dist, now);
    setMode(`zoom ${Math.round((zoom.current || 1) * 100)}%`, true);
    window.__hwState.mode = 'zoom';
    sendToTab({ t: 'cursor', mode: 'none', kbd: kbdOn });
    return;
  }
  if (zoom.active || zoom.pending) { zoom.active = zoom.pending = false; }

  // ---- single-hand interactions on the primary (first) hand
  const h = classified[0];
  window.__hwState.pose = h.pose;

  if (h.pose === rawPose) poseCount++;
  else { rawPose = h.pose; poseCount = 1; }
  if (poseCount >= POSE_STABLE_FRAMES) stablePose = rawPose;

  if (!smoothed) smoothed = { palm: { ...h.palm }, tip: { ...h.tip } };
  else {
    for (const k of ['palm', 'tip']) {
      smoothed[k].sx += (h[k].sx - smoothed[k].sx) * 0.5;
      smoothed[k].sy += (h[k].sy - smoothed[k].sy) * 0.5;
    }
  }

  // peace-sign hold toggles the keyboard
  if (stablePose === 'peace') {
    if (peaceArmed) {
      peaceHeld += dt;
      progressEl.style.width = `${Math.min(100, (peaceHeld / PEACE_HOLD_S) * 100)}%`;
      if (peaceHeld >= PEACE_HOLD_S) {
        kbdOn = !kbdOn;
        window.__hwState.kbd = kbdOn;
        sendToTab({ t: 'kbd', show: kbdOn });
        peaceArmed = false;
        progressEl.style.width = '0%';
      }
    }
  } else {
    peaceHeld = 0;
    peaceArmed = true;
    progressEl.style.width = '0%';
  }

  if (stablePose === 'fist') {
    // grab & drag: the page content follows the hand
    if (!scroll.active) {
      scroll.active = true;
      scroll.last = { ...smoothed.palm, t: now };
    } else {
      const dx = (smoothed.palm.sx - scroll.last.sx) * SCROLL_GAIN;
      const dy = (smoothed.palm.sy - scroll.last.sy) * SCROLL_GAIN;
      const fdt = Math.max((now - scroll.last.t) / 1000, 1e-3);
      scroll.vx = 0.7 * scroll.vx + 0.3 * (-dx / fdt);
      scroll.vy = 0.7 * scroll.vy + 0.3 * (-dy / fdt);
      if (Math.abs(dx) > 0.4 || Math.abs(dy) > 0.4) {
        sendToTab({ t: 'scroll', dx: -dx, dy: -dy });
      }
      scroll.last = { ...smoothed.palm, t: now };
    }
    sendToTab({ t: 'cursor', x: smoothed.palm.sx, y: smoothed.palm.sy, mode: 'grab', kbd: kbdOn });
    setMode('scroll', true);
    window.__hwState.mode = 'scroll';
    return;
  }
  if (scroll.active) endScroll();

  // pointer: cursor follows the index fingertip; pinch-tap presses
  const pinchNow = stablePose === 'pinch';
  if (pinchNow && pressArmed) {
    pressArmed = false;
    sendToTab({ t: 'press', x: smoothed.tip.sx, y: smoothed.tip.sy });
  } else if (!pinchNow && stablePose !== 'none') {
    pressArmed = true;
  }
  sendToTab({
    t: 'cursor',
    x: smoothed.tip.sx,
    y: smoothed.tip.sy,
    mode: pinchNow ? 'pinch' : 'point',
    kbd: kbdOn,
  });
  const label = kbdOn ? 'keyboard' : stablePose === 'peace' ? 'keyboard…' : 'point';
  setMode(label, true);
  window.__hwState.mode = label;
}

// ------------------------------------------------------------------ preview
const POSE_COLORS = {
  fist: '#ffb066', pinch: '#ff9ad5', peace: '#c9a2ff', open: '#7ef0c9', point: '#7ecbf0',
};
function drawPreview(hands) {
  const w = preview.width, h = preview.height;
  pctx.fillStyle = '#0a0c18';
  pctx.fillRect(0, 0, w, h);
  if (camReady && video.readyState >= 2) {
    pctx.save();
    pctx.translate(w, 0);
    pctx.scale(-1, 1);
    pctx.drawImage(video, 0, 0, w, h);
    pctx.restore();
  }
  for (const lm of hands) {
    const { pose } = classify(lm);
    pctx.fillStyle = POSE_COLORS[pose] || '#7ecbf0';
    for (const p of lm) {
      pctx.beginPath();
      pctx.arc((1 - p.x) * w, p.y * h, 4, 0, Math.PI * 2);
      pctx.fill();
    }
    pctx.font = '600 20px system-ui';
    pctx.fillText(pose, (1 - lm[0].x) * w + 12, lm[0].y * h);
  }
}

// ---------------------------------------------------------------- main loop
let lastFrame = performance.now();
let lastHandCount = -1;

function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  let hands = [];
  const useInjected = injected && now - injected.t < 400;
  if (useInjected) {
    hands = injected.hands;
  } else if (landmarker && camReady && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try {
      hands = landmarker.detectForVideo(video, now).landmarks || [];
    } catch { hands = []; }
  } else if (landmarker && camReady) {
    hands = lastHands;
  }
  lastHands = hands;

  step(hands, now, dt);
  drawPreview(hands);

  if (hands.length !== lastHandCount) {
    lastHandCount = hands.length;
    if (hands.length > 0) {
      setStatus(`tracking ${hands.length} hand${hands.length > 1 ? 's' : ''}`, 'tracking');
    } else if (camReady) {
      setStatus('show a hand to the camera ✋');
    }
  }
  if (unreachable && hands.length > 0) {
    setStatus('this page can’t be controlled (chrome:// or store page)', 'error');
  }
}
let lastHands = [];
requestAnimationFrame(loop);
