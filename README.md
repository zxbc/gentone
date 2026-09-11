# genTone — scale-mapped chirps while Hermes streams

A [Hermes Desktop Plugin](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk)
(single ESM file, `@hermes/plugin-sdk`). While the agent streams text, it emits
short robotic chirps whose pitch follows the generation speed, quantized to a
three-octave scale ladder starting at C4 (261.63 Hz). Faster generation →
higher notes, slower → lower, so the tempo of the model paints a melody in the
scale. While the model is "thinking", the same speed-mapped notes continue at
reduced volume (~70%), so the thinking phase sounds like the answer but
quieter. Sound stops the moment the last stream ends.

Four scales are selectable from the status-bar chip, all rooted at C and
defaulting to **Blues**:

- **Blues** (C minor blues) — C · E♭ · F · F♯ · G · B♭ — 18 degrees
- **Pentatonic** (C minor pentatonic) — C · E♭ · F · G · B♭ — 15 degrees
- **Major** (C major) — C · D · E · F · G · A · B — 21 degrees
- **Phrygian Dominant** (1–♭2–3–4–5–♭6–♭7) — C · D♭ · E · F · G · A♭ · B♭ — 21 degrees

Every ladder spans three octaves from the C root; Blues/Pentatonic/Phrygian
top out at B♭6 (≈1865 Hz) and Major at C7 (≈1976 Hz).

## Install

1. Copy `plugin.js` to `~/.hermes/desktop-plugins/gentone/plugin.js`
   (the folder name **must** match the plugin `id`: `gentone`; under a named
   profile it's `~/.hermes/profiles/<name>/desktop-plugins/gentone/`).
2. The app loads it within a few seconds. If nothing appears, run `⌘K` →
   **Reload desktop plugins**.
3. If you hear nothing, click the `♪` chip once — that's the user gesture that
   unlocks the audio context (Electron autoplay policy).

## The chip

The status-bar chip is the scale selector. It shows `♫` while streaming,
`♪` idle, and `♪ off` muted, followed by the current scale name. Picking any
scale always enables the plugin; the explicit **Off** row at the bottom of the
picker is the only way to mute. While muted the chip reads `♪ off`.

## How it works

- **Signals** — listens to gateway events via `host.onEvent`: `message.start`,
  `message.delta`, `thinking.delta`, `reasoning.delta` (all carry payload
  `.text`), `message.complete`, and `error`.
- **Speed** — chars streamed over a rolling 700 ms window (text **and**
  thinking tokens) → chars/sec, log-mapped and EMA-smoothed onto the selected
  scale's ladder. `MIN_CPS` (6) maps to the lowest degree, `MAX_CPS` (100) to
  the top.
- **Melodic wander** — each streaming note random-walks ±`WANDER` (2) scale
  degrees around the speed-mapped pitch, so steady generation wanders
  melodically instead of holding one note. Switching scales re-anchors the
  walk and clears any active jitter so a perturbation can't leak across scales.
- **Smooth jitter** — a constant-probability perturbation, independent of how
  monotone the melody is. With chance `JITTER_PROB` (0.2) per eligible note, a
  short "bump" starts: a pattern of 1–`JITTER_MAX_LEN` (4) notes whose peak
  deviation is 1–`JITTER_MAX_PEAK` (4) degrees. The bump rises toward the peak
  and falls after it (each step ±1, never overshooting the envelope), so the
  melody is bent continuously across a few notes instead of a single note
  jumping. The sign is random, so a jitter lifts or dips the line. A jitter
  never starts while one is active, and once it ends a `JITTER_GAP` (8) note
  quiet period passes before the next can start.
- **Rhythm in groups of 8** — the scheduler is a `setTimeout` chain, not a
  fixed `setInterval`. Every `PATTERN_SIZE` (8) notes played use a fixed
  pattern of intervals, each drawn once around `NOTE_EVERY_MS` (150 ms) within
  ±`JITTER` (default ±50%); a fresh random pattern rolls only after 8 notes
  have actually played, so the rhythm stays steady within a group and varies
  between groups. Silent ticks (token gaps) reschedule at the base interval
  and don't advance the pattern.
- **No stacking** — each chirp's envelope (70 ms) stays shorter than the
  *shortest possible interval* (75 ms = 150 ms × 0.5), so notes physically
  cannot overlap or queue even at the edge of the jitter range. When the last
  stream ends the scheduler stops and the master gain fades in ~30 ms — no
  trailing notes.
- **Thinking at reduced volume** — thinking/reasoning tokens
  (`thinking.delta` / `reasoning.delta`) feed the same speed window and play
  the same speed-mapped, wandering notes at `THINKING_VOLUME` (~70% of
  `VOLUME`). The latest token type decides the volume class, so the transition
  is instant. Gaps with no tokens at all (tool calls, waits) are silent once
  `STALE_MS` (900 ms) pass.
- **Any session** — notes play while *any* session streams, focused or not
  (the tab being hidden also silences notes).
- **Hot-reload safe** — a global engine guard disposes the previous module's
  interval + listener on file save, so re-loading the plugin can't duplicate
  notes.

## Tunables (top of `plugin.js`)

| Constant | Default | Meaning |
| --- | --- | --- |
| `ROOT_FREQ` | 261.63 | Hz of scale degree 0 (C4) |
| `MINOR_BLUES` | `[0,3,5,…,34]` | semitone offsets, 3-octave minor blues (18 degrees) |
| `MINOR_PENTA` | `[0,3,5,…,34]` | semitone offsets, 3-octave minor pentatonic (15 degrees) |
| `MAJOR` | `[0,2,4,…,35]` | semitone offsets, 3-octave major (21 degrees) |
| `PHRYGIAN_DOM` | `[0,1,4,…,34]` | semitone offsets, 3-octave phrygian dominant (21 degrees) |
| `NOTE_EVERY_MS` | 150 | base cadence — rhythm intervals vary around this |
| `NOTE_LEN_MS` | 70 | chirp length — keep ≤ 75 ms (shortest possible interval) |
| `PATTERN_SIZE` | 8 | notes per rhythm pattern before a new one rolls |
| `JITTER` | 0.5 | interval variation, ±50% of `NOTE_EVERY_MS` |
| `WINDOW_MS` | 700 | speed rolling window |
| `MIN_CPS` / `MAX_CPS` | 6 / 100 | chars/sec spanned by the scale ladder |
| `STALE_MS` | 900 | token gap before silence (tool calls / waits) |
| `EMA` | 0.3 | pitch smoothing (1 = none, 0 = frozen) |
| `WANDER` | 2 | ±scale degrees of pitch variation around the mapped note |
| `JITTER_PROB` | 0.2 | per-note chance a smooth jitter starts (constant throughout, not monotony-based) |
| `JITTER_MAX_LEN` / `JITTER_MAX_PEAK` | 4 / 4 | max notes in a jitter bump, and max peak deviation in scale degrees |
| `JITTER_GAP` | 8 | quiet notes after a jitter ends before the next can start |
| `VOLUME` | 0.07 | master volume for streaming notes (0–1) |
| `THINKING_VOLUME` | 0.05 | volume for the thinking notes (~70% of `VOLUME`) |
| `SHIMMER` | 0.007 | detune of the second oscillator (robot color) |

## Notes

- Built against the **new desktop plugin SDK** (`@hermes/plugin-sdk` disk
  format, hot-reload, no build step) — needs a recent desktop build.
- Requires Web Audio API in the renderer (standard Electron/Chromium — no
  extra deps, no imports beyond `@hermes/plugin-sdk`, `react`,
  `react/jsx-runtime`).
- Verified: JS syntax (`node --check`), and all four scale ladders parse from
  the source as monotonically ascending from C4 (261.63 Hz) to ≈1865–1976 Hz.
  Not yet runtime-tested on a real desktop app instance — that's the
  copy-and-try step on your side. If the chip never appears or JS errors,
  check `hermes logs gui -f` and the app's error toast.
