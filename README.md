# Handwave — browse Chrome with your hands

A Chrome extension (Manifest V3) that lets you control web pages with hand gestures
through your webcam: grab the page to scroll it, pinch-and-stretch with both hands to
zoom, and summon an on-screen keyboard you type on in mid-air. Hand tracking runs on
[MediaPipe HandLandmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker),
fully bundled inside the extension (no network calls, nothing leaves your machine).

## Install

1. Clone this branch, or download it as a folder.
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select the repository folder (the one with `manifest.json`).
4. Click the Handwave toolbar icon — the side panel opens.
5. First run: click **grant camera access** in the panel. Chrome side panels often
   cannot show the camera permission prompt themselves, so this opens a small
   extension tab where the prompt works; allow the camera there and the tab closes
   itself. The permission sticks — from then on the panel connects silently.
6. Keep the panel open while you browse: it hosts the camera and shows what the
   tracker sees, with your current gesture labelled live.

## Gestures

| Gesture | Action |
| --- | --- |
| ☝️ Move a hand | Moves the on-page cursor (follows your index fingertip) |
| 🤏 Pinch-tap (thumb+index touch, other fingers open) | Click whatever is under the cursor / press the hovered key |
| ✊ Make a fist and drag | Scrolls whatever is under your hand — inner panels, chat lists, dropdowns — chaining to the page when the component runs out; flick for momentum |
| 🤏🤏 Pinch with both hands, stretch/squeeze | Zooms the page in/out (real Chrome zoom) |
| ✌️ Hold a peace sign still (~1s) | Summons / dismisses the on-screen keyboard |
| ✌️ Two-finger swipe right / left | Browser back / forward (like a trackpad swipe) |

The on-screen keyboard types into whatever field has focus — pinch-tap an input first,
then peace-sign to summon the keyboard, hover a key and pinch to press. Shift, backspace,
enter, and a ✕ key to close it are included.

## How it's built

- **Side panel** (`sidepanel.html/js`) — hosts the webcam and the vendored MediaPipe
  HandLandmarker (wasm + model in `vendor/`, SIMD and non-SIMD builds). Classifies hand
  poses from the 21 landmarks (finger extension ratios + thumb–index distance), runs a
  debounced gesture state machine, and drives the active tab. Zoom uses
  `chrome.tabs.setZoom`, so it is the browser's real page zoom.
- **Content script** (`content.js`) — injected into http(s) pages; renders the hand
  cursor and keyboard in a `pointer-events: none` shadow-DOM overlay (it can never block
  real page interaction), and executes scroll, momentum fling, synthetic clicks, and
  typing (`execCommand('insertText')` with manual fallbacks).
- **Testing** — the panel exposes `window.__hwInject(hands)` so the whole
  gesture→action pipeline can be driven headless with synthetic landmark frames
  (12 end-to-end checks: poses, scroll both ways, zoom, click, keyboard summon,
  typing, backspace, dismiss).

## Limitations

- Works on regular web pages only — Chrome blocks extensions on `chrome://` pages and
  the Web Store.
- Scrolling reaches into open shadow DOM and same-origin iframes; content inside
  cross-origin iframes (some embeds) cannot be reached from the host page.
- The side panel must stay open (it is the camera host).
- Good lighting helps MediaPipe; the panel preview shows exactly what the tracker sees.

The files in `vendor/` are Google's [MediaPipe tasks-vision](https://www.npmjs.com/package/@mediapipe/tasks-vision)
runtime and hand landmark model, licensed under Apache-2.0.
