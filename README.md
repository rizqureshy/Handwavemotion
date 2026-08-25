# Ink Field

A blank canvas you paint on by waving your hand in front of your webcam, rendered with
[Three.js](https://threejs.org/) / WebGL2. Hand movement throws glowing particle ink
across the canvas — speed and direction shape the stroke — and the ink then drifts
apart on a swirling flow field, bleeds, and fades to nothing.

## How it works

- **Ink** — a GPU particle pool (512² = 262k particles) simulated entirely in fragment
  shaders on ping-pong float textures. Each particle carries position/velocity and
  birth/lifespan/hue. New strokes recycle the oldest particles: every emission claims a
  contiguous index range after a moving cursor and the update shader re-initializes it.
- **Dispersion** — young ink inherits the stroke's velocity; as it ages it is taken
  over by a divergence-free curl-noise flow field that pulls it into swirls, while drag
  slows it down. Particles render additively into a persistence buffer that bleeds
  (small blur) and dries (time-based fade) every frame, so strokes read as flowing ink
  that dissolves and eventually disappears completely.
- **Colour** — a slowly cycling cosine palette; each hand and stroke gets a hue offset,
  and speed nudges the hue, so drawings evolve through the spectrum over time.
- **Hand tracking** — [MediaPipe HandLandmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
  (tasks-vision) on the mirrored front camera, up to two hands. The smoothed palm
  centre draws the stroke; its speed sets particle count, spread, and thrown velocity.
  A resting hand slowly pools ink instead.
- **Fallbacks** — no camera? The mouse (or a finger on touch screens) draws identically,
  and clicking bursts ink outward.

## Run it

No build step — it is a single `index.html` that loads Three.js and MediaPipe from a CDN
(so it needs an internet connection). Camera access requires a secure context, so serve
it over `localhost` rather than opening the file directly:

```sh
python3 -m http.server 8000
# or: npx serve .
```

Then open <http://localhost:8000> in a modern browser (Chrome or Edge recommended) and
allow camera access.

## Controls

| Input | Effect |
| --- | --- |
| Wave a hand in front of the camera | Paints ink along the hand's path; speed = more ink, thrown harder |
| Hold a hand still | Ink slowly pools under the palm |
| Move the mouse / drag a finger | Same strokes, no camera needed |
| Click | Burst of ink scattering outward |
| `C` or the button | Toggle the webcam preview overlay |
