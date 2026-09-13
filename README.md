# genTone: Musical chirps while Hermes streams

A [Hermes Desktop Plugin](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk)
(single ESM file, `@hermes/plugin-sdk`). While the agent streams text, it emits
short robotic chirps whose pitch follows the generation speed, quantized to a
three-octave scale ladder starting at C4 (261.63 Hz). Faster generation →
higher notes, slower → lower, so the tempo of the model paints a melody in the
scale. The melody also goes into little improvised "wanderings" every once in a while. When the model is thinking, the same speed-mapped notes continue at
reduced volume (~70%), so the thinking phase sounds like the answer but
quieter. Sound stops the moment the last stream ends.

Six scales are selectable from the status-bar chip, all rooted at C and
defaulting to **Blues**:

- **Blues** (C minor blues) — C · E♭ · F · F♯ · G · B♭ — 18 degrees
- **Pentatonic** (C minor pentatonic) — C · E♭ · F · G · B♭ — 15 degrees
- **Major** (C major) — C · D · E · F · G · A · B — 21 degrees
- **Phrygian Dominant** (1–♭2–3–4–5–♭6–♭7) — C · D♭ · E · F · G · A♭ · B♭ — 21 degrees
- **Diminished** (half-whole diminished) — C · D♭ · E♭ · E · G♭ · G · A · B♭ — 24 degrees
- **Whole Tone** (all whole steps) — C · D · E · F♯ · G♯ · A♯ — 18 degrees (six per octave)

Every ladder spans three octaves from the C root; Blues/Pentatonic/Phrygian/
Diminished/Whole-Tone top out at B♭6 (≈1865 Hz) and Major at C7 (≈1976 Hz).

## Install

1. Copy `plugin.js` to `~/.hermes/desktop-plugins/gentone/plugin.js`
   (the folder name **must** match the plugin `id`: `gentone`; under a named
   profile it's `~/.hermes/profiles/<name>/desktop-plugins/gentone/`).
2. The app loads it within a few seconds. If nothing appears, run `⌘K` →
   **Reload desktop plugins**. On the latest Hermes builds the plugin may not
   register until you **fully relaunch Hermes Desktop** — quitting and
   starting the app again is the reliable way to force it to load.
3. If you hear nothing, click the `♪` chip once — that's the user gesture that
   unlocks the audio context (Electron autoplay policy).

## The chip

The status-bar chip is the scale selector. It shows `♫` while streaming,
`♪` idle, and `♪ off` muted, followed by the current scale name. Picking any
scale always enables the plugin. The **Volume** slider at the bottom of the
picker sets the loudness: its minimum (0) mutes — the chip then reads `♪ off`
— and dragging above 0 re-enables at that volume. The slider rests at the
original volume by default and tops out 20% louder than that.

## How it works

- **Signals** — listens to gateway events via `host.onEvent`: `message.start`,
  `message.delta`, `thinking.delta`, `reasoning.delta` (all carry payload
  `.text`), `message.complete`, and `error`.
- **Speed** — chars streamed over a rolling 700 ms window (text **and**
  thinking tokens) → chars/sec, EMA-smoothed onto the selected scale's
  ladder via the dynamic mapping below.
- **Dynamic speed → pitch mapping** — the pitch bounds are no longer fixed:
  each tick records the smoothed cps into a rolling `RANGE_WINDOW_MS` (16 s)
  history, and every `REMAP_INTERVAL_MS` (8 s ≈ 2 phrases) the min/max of that
  history are fitted across the whole three-octave ladder. A steady tps band
  therefore still spans all three octaves instead of hovering on one note.
  `MIN_SPAN_LOG2` keeps a very steady stream from becoming hypersensitive and
  `RANGE_PAD` keeps the top and bottom degrees reachable; a new stream resets
  to the initial `MIN_CPS`/`MAX_CPS` bounds.
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
- **Time-locked rhythm in phrases of 4 s** — the scheduler is a `setTimeout`
  chain locked to the wall clock, not a fixed `setInterval`. Each phrase is
  exactly `RHYTHM_PERIOD_MS` (4 s) long, split into `RHYTHM_BARS` (8) bars of
  500 ms, each subdivided into eighth-note slots (`RHYTHM_SLOTS` = 16, i.e.
  250 ms). Every phrase rolls a fresh random rhythm: a note count drawn from
  `RHYTHM_MIN_NOTES`–`RHYTHM_MAX_NOTES` (5–9) is placed across the slots, with
  the downbeat (slot 0) always anchored and bar starts weighted
  `RHYTHM_DOWNBEAT_WEIGHT` (3×) more heavily than offbeats so the phrase feels
  grounded even as the count and placement vary. The grid is anchored to
  `performance.now()`, so the 4 s phrases stay steady with no drift and a new
  phrase always begins exactly on the boundary — even across silent gaps.
  Each note that fires still gets its pitch from the stream-speed mechanics
  above, so the rhythm varies but the melody follows generation.
- **No stacking** — each chirp's envelope (`NOTE_LEN_MS` = 70 ms) stays
  shorter than the *shortest possible note spacing* (one slot = 125 ms), so
  notes physically cannot overlap or queue. When the last stream ends the
  scheduler stops and the master gain fades in ~30 ms — no trailing notes.
- **Pause "interlude" beat** — while a stream is active but no tokens flow
  for `STALE_MS` (tool calls, waits), the same wall-clock-locked rhythm keeps
  playing as a static-frequency hat-like beat at `BEAT_FREQ` (1200 Hz) instead
  of silence — an interlude at the same tempo and placement complexity as the
  notes, using the same chirp synthesis with the note choice removed. The
  instant tokens resume the speed-mapped notes take over again; when the
  stream fully ends the beat stops with everything else (nothing plays after
  `message.complete`).
- **Thinking at reduced volume** — thinking/reasoning tokens
  (`thinking.delta` / `reasoning.delta`) feed the same speed window and play
  the same speed-mapped, wandering notes at ~70% of whatever the volume slider
  is set to (so thinking stays quieter at any volume). The latest token type
  decides the volume class, so the transition is instant. Gaps with no tokens
  at all (tool calls, waits) switch to the pause "interlude" beat once
  `STALE_MS` (900 ms) pass.
- **Volume slider** — the **Volume** slider at the bottom of the picker sets
  the streaming volume (`userVolume`, 0–`VOLUME_MAX`). Its default is the
  original `VOLUME` (0.07); `VOLUME_MAX` is `VOLUME × 1.2` (0.084), so the
  ceiling is 20% louder than the default. The minimum (0) mutes and reads
  `♪ off` in the chip — it replaces the old explicit Off row — and any value
  above 0 re-enables and resumes the audio. Thinking notes follow the slider
  via `THINKING_RATIO` (~70%).
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
| `NOTE_LEN_MS` | 70 | chirp length — keep ≤ 125 ms (one rhythm slot) |
| `BEAT_FREQ` | 1200 | Hz of the static-frequency pause "interlude" beat (hat-like) |
| `RHYTHM_PERIOD_MS` | 4000 | fixed phrase length — every phrase is exactly this long |
| `RHYTHM_BARS` / `RHYTHM_SLOTS` | 8 / 32 | bars per phrase, and placement resolution (sixteenth notes) |
| `RHYTHM_MIN_NOTES` / `RHYTHM_MAX_NOTES` | 10 / 18 | random note count range per phrase |
| `RHYTHM_DOWNBEAT_WEIGHT` | 3 | bar starts weigh this much more than offbeats when placing notes |
| `WINDOW_MS` | 700 | speed rolling window |
| `MIN_CPS` / `MAX_CPS` | 6 / 100 | initial mapping bounds until samples arrive (see dynamic range below) |
| `RANGE_WINDOW_MS` | 16000 | rolling cps history used to estimate the speed range |
| `REMAP_INTERVAL_MS` | 8000 | how often the dynamic pitch bounds are recomputed (~2 phrases) |
| `MIN_SPAN_LOG2` | 0.5 | min span the dynamic mapping covers (sensitivity floor) |
| `RANGE_PAD` | 0.10 | bounds padded outward by this fraction of the span |
| `STALE_MS` | 900 | token gap before notes switch to the pause "interlude" beat |
| `EMA` | 0.3 | pitch smoothing (1 = none, 0 = frozen) |
| `WANDER` | 2 | ±scale degrees of pitch variation around the mapped note |
| `JITTER_PROB` | 0.2 | per-note chance a smooth jitter starts (constant throughout, not monotony-based) |
| `JITTER_MAX_LEN` / `JITTER_MAX_PEAK` | 4 / 4 | max notes in a jitter bump, and max peak deviation in scale degrees |
| `JITTER_GAP` | 8 | quiet notes after a jitter ends before the next can start |
| `VOLUME` | 0.07 | default streaming volume (0–1) — where the picker slider rests with no input |
| `VOLUME_MAX` | 0.084 | slider ceiling = `VOLUME × 1.2` (20% louder than the default) |
| `THINKING_VOLUME` | 0.05 | default thinking-note volume (~70% of `VOLUME`) |
| `THINKING_RATIO` | 0.05/0.07 | thinking notes scale by this (~70%) of whatever the slider sets |
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
