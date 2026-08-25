# Ripple Field

An interactive iridescent water surface, rendered with [Three.js](https://threejs.org/) /
WebGL2, that you disturb by waving your hand in front of your webcam. Hand position,
direction, and speed shape the ripples: a slow drift barely stirs the surface, a fast
swipe throws a directional wake across the pool.

## How it works

- **Water** — a GPU heightfield wave simulation (the classic two-buffer wave equation)
  running on ping-pong half-float render targets at 512², ~120 steps/s. The visible
  surface is a displaced plane whose normals are derived from the height field and
  shaded with a cosine-palette iridescent gradient (teal → violet → pink) driven by
  wave height and fresnel, plus a specular highlight.
- **Hand tracking** — [MediaPipe HandLandmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
  (tasks-vision) on the mirrored front camera, up to two hands. The palm centre is
  tracked and smoothed each frame; its velocity determines ripple amplitude and radius,
  and a directional (dipole) impulse pushes a bow wave along the direction of motion.
  Fast swipes spawn a trail of impulses along the movement path so the wake is continuous.
- **Fallbacks** — if the camera or the model is unavailable, moving the mouse (or a
  finger on touch screens) ripples the water the same way. Gentle raindrops keep the
  surface alive when nobody interacts.

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
| Wave a hand in front of the camera | Ripples where the hand is; speed = splash size, motion direction = wake direction |
| Move the mouse / drag a finger | Same ripples, no camera needed |
| Click | Drop a single big ripple |
| `C` or the button | Toggle the webcam preview overlay |
