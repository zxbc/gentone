// ============================================================================
// genTone — robotic chirps in a selectable scale while Hermes streams text.
// ----------------------------------------------------------------------------
// Desktop plugin for the Hermes desktop app (@hermes/plugin-sdk).
// Install: copy this file to  ~/.hermes/desktop-plugins/gentone/plugin.js
// (folder name must match the plugin id). The app hot-loads it within seconds;
// ⌘K → "Reload desktop plugins" forces a reload.
//
// How it works:
//   - Listens to gateway events: message.start / message.delta / message.complete
//   - While any session is streaming, a scheduler emits short chirps on a fixed
//     time-locked grid: every phrase is exactly RHYTHM_PERIOD_MS (4 s) long,
//     split into RHYTHM_BARS bars (500 ms each). Each phrase is a fresh random
//     rhythm — a random number of notes placed across the bars' sixteenth-note
//     slots, with the downbeat always anchored and bar starts weighted to feel
//     grounded. The grid is locked to the wall clock, so the 4 s phrases stay
//     steady with no drift even across silent gaps. Each note's pitch comes
//     from the stream speed (see below), so the rhythm varies but the melody
//     still follows generation.
//   - Generation speed = all streamed chars (text AND thinking tokens) over a
//     rolling WINDOW_MS window. That rate (EMA-smoothed) picks the pitch from
//     the selected scale's 3-octave ladder — C minor blues by default, or
//     minor pentatonic, major, phrygian dominant, diminished, or whole tone,
//     chosen from the ♪ chip's popover (see SCALES below) — via a dynamically compressed mapping: every
//     REMAP_INTERVAL_MS the cps range observed over the past RANGE_WINDOW_MS
//     is fitted across the whole ladder (with a min-span sensitivity floor
//     and edge padding), so a steady tps band still spans three octaves
//     instead of hovering on one note. Each
//     streaming note additionally random-walks ±WANDER degrees around that
//     mapped pitch so the tone wanders melodically rather than holding a note.
//     A smooth jitter then bends the melody: with a constant chance (per note,
//     independent of how "monotone" it is) a short perturbation starts — a bump
//     of ≤4 notes whose peak deviation is 1–4 degrees, rising then falling so
//     the change spreads smoothly across a few notes. Once one ends, a quiet
//     gap of ≥8 notes passes before another can start.
//   - The ♪ chip is the scale selector (Blues by default, plus Pentatonic,
//     Major, Phrygian Dominant); picking any scale is always on, and an
//     explicit "Off" row at the bottom of the picker is the only way to mute.
//     While muted the chip reads "♪ off".
//   - Thinking/reasoning tokens (thinking.delta / reasoning.delta) play the
//     same speed-mapped notes at reduced volume (THINKING_VOLUME ≈ 70% of
//     VOLUME), so the thinking phase is audible but quieter than the answer.
//   - While a stream is active but tokens have stopped flowing (tool calls,
//     waits — no delta for STALE_MS), the same rhythm keeps playing as a
//     static-frequency hat-like beat (BEAT_FREQ) instead of silence — an
//     interlude. The instant tokens resume it's back to the speed-mapped
//     notes; when the stream fully ends it stops with everything else.
//   - When the last stream ends, the scheduler stops and the master volume
//     fades out in ~30ms — no trailing notes, no delay.
// ============================================================================

import { host, STATUSBAR_AREAS, Popover, PopoverContent, PopoverTrigger, RowButton, icons } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

// ------------------------------ tunables -----------------------------------
const ROOT_FREQ = 261.63         // Hz of scale degree 0 (C4)

// 3-octave scale ladders (semitone offsets from the root, ascending). Every
// ladder spans three octaves from the C root; Major tops out at C7 (35) and
// the other five at B♭6 (34).
const MINOR_BLUES = [0, 3, 5, 6, 7, 10, 12, 15, 17, 18, 19, 22, 24, 27, 29, 30, 31, 34] // C Eb F F# G Bb
const MINOR_PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27, 29, 31, 34] // C Eb F G Bb
const MAJOR = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24, 26, 28, 29, 31, 33, 35] // C D E F G A B
const PHRYGIAN_DOM = [0, 1, 4, 5, 7, 8, 10, 12, 13, 16, 17, 19, 20, 22, 24, 25, 28, 29, 31, 32, 34] // C Db E F G Ab Bb (1-♭2-3-4-5-♭6-♭7)
const DIMINISHED = [0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18, 19, 21, 22, 24, 25, 27, 28, 30, 31, 33, 34] // C Db Eb E Gb G A Bb (half-whole diminished)
const WHOLE_TONE = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34] // C D E F# G# A# (all whole steps — only six degrees per octave)

const SCALES = [
  { id: 'blues', name: 'Blues', short: 'blues', notes: 'C · E♭ · F · F♯ · G · B♭', degrees: MINOR_BLUES },
  { id: 'pentatonic', name: 'Pentatonic', short: 'penta', notes: 'C · E♭ · F · G · B♭', degrees: MINOR_PENTA },
  { id: 'major', name: 'Major', short: 'major', notes: 'C · D · E · F · G · A · B', degrees: MAJOR },
  { id: 'phrygian', name: 'Phrygian Dominant', short: 'phryg', notes: 'C · D♭ · E · F · G · A♭ · B♭', degrees: PHRYGIAN_DOM },
  { id: 'diminished', name: 'Diminished', short: 'dim', notes: 'C · D♭ · E♭ · E · G♭ · G · A · B♭', degrees: DIMINISHED },
  { id: 'whole-tone', name: 'Whole Tone', short: 'wt', notes: 'C · D · E · F♯ · G♯ · A♯', degrees: WHOLE_TONE },
]
const DEFAULT_SCALE_ID = 'blues'

const NOTE_LEN_MS = 70           // chirp length (< shortest possible note spacing: 125 ms)
const BEAT_FREQ = 1200           // Hz of the static-frequency "interlude" beat — hat-like, kept mid-range so it isn't harsh
const RHYTHM_PERIOD_MS = 4000    // fixed phrase length — every phrase is exactly this long
const RHYTHM_BARS = 8            // bars per phrase (each bar = 500 ms)
const RHYTHM_SLOTS = 32          // placement resolution (sixteenth notes: 4 slots per bar)
const RHYTHM_MIN_NOTES = 10      // fewest notes a phrase may contain
const RHYTHM_MAX_NOTES = 18      // most notes a phrase may contain
const RHYTHM_DOWNBEAT_WEIGHT = 3 // bar starts (downbeats) are 3x more likely to hold a note than offbeats
const WINDOW_MS = 700            // speed rolling window
const MIN_CPS = 6                // initial mapping floor (natural log units), until samples arrive
const MAX_CPS = 100              // initial mapping ceiling, until samples arrive
const STALE_MS = 900             // no delta for this long → thinking mode
const RANGE_WINDOW_MS = 16000    // rolling cps history used to estimate the speed range
const REMAP_INTERVAL_MS = 8000   // how often the dynamic pitch bounds are recomputed (~2 phrases)
const MIN_SPAN_LOG2 = 0.5        // min span (log2 of cps) the mapping covers — sensitivity floor
const RANGE_PAD = 0.10           // bounds padded outward by this fraction of the span
const EMA = 0.3                  // pitch smoothing, 1 = none, 0 = frozen
const WANDER = 2                 // ±scale degrees of pitch variation around the mapped note
const JITTER_PROB = 0.2          // probability per eligible note that a new jitter starts (constant throughout)
const JITTER_MAX_LEN = 4         // a jitter pattern never modifies more than this many notes
const JITTER_MAX_PEAK = 4        // the max peak deviation, in scale degrees, never exceeds this
const JITTER_GAP = 8             // notes with no jitter after a pattern ends before the next can start
const VOLUME = 0.07              // 0..1 master volume (streaming notes)
const THINKING_VOLUME = 0.05     // thinking-note volume (~70% of VOLUME)
const SHIMMER = 0.007            // detune of the second oscillator (robot shimmer)
// ----------------------------------------------------------------------------

// ------------------------------ engine state --------------------------------
let generating = 0            // number of active streams
let lastDeltaAt = 0           // performance.now() of last token (text or thinking)
let inThinking = false        // true while the latest tokens are thinking/reasoning
const deltas = []             // [{ t, chars }] speed window
let emaCps = null             // smoothed chars/sec
const cpsSamples = []         // [{ t, cps }] rolling history feeding the dynamic range
let mapLo = Math.log(MIN_CPS) // current dynamic mapping bounds (natural log of cps)
let mapHi = Math.log(MAX_CPS)
let lastRemapAt = 0           // last time the dynamic bounds were remapped
let wander = 0                // current ±degree offset from the mapped note
let jitterPattern = null      // active smooth perturbation — array of integer degree deltas, or null
let jitterPos = 0             // note index within the active jitterPattern
let jitterGap = 0             // notes left in the quiet gap before the next jitter may start
let timer = null              // scheduler handle (setTimeout chain)
let rhythmSlots = null        // current phrase — sorted list of slot indices (0..RHYTHM_SLOTS-1) where notes fire
let rhythmIndex = 0           // pointer into rhythmSlots — next note to fire this phrase
let rhythmAnchor = 0          // performance.now() at which the current phrase began (wall-clock anchor)
let audio = null              // AudioContext
let master = null             // master GainNode
let enabled = true            // user toggle
const stateSubs = new Set()   // UI subscribers
let disposed = false

// ------------------------------ scale selection -----------------------------
let currentScaleId = DEFAULT_SCALE_ID
const getScale = () => SCALES.find(s => s.id === currentScaleId) || SCALES[0]

function setScale(id) {
  if (id === currentScaleId && enabled) return
  currentScaleId = id
  enabled = true            // every scale is "on" — only the Off row mutes
  if (enabled && !timer) resumeAudio()
  wander = 0                 // re-anchor the walk at the new scale's mapped pitch
  jitterPattern = null       // don't carry a perturbation across a scale change
  jitterPos = 0
  jitterGap = 0
  emitState()
}

const emitState = () => {
  for (const fn of stateSubs) {
    try {
      fn()
    } catch {
      /* listener errors are isolated */
    }
  }
}

// ------------------------------ audio ---------------------------------------
function ensureAudio() {
  if (audio) return audio
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  audio = new AC()
  master = audio.createGain()
  master.gain.value = 0
  master.connect(audio.destination)
  return audio
}

function resumeAudio() {
  const ac = ensureAudio()
  if (ac && ac.state === 'suspended') ac.resume().catch(() => {})
}

function noteFreq(degree) {
  const degrees = getScale().degrees
  return ROOT_FREQ * Math.pow(2, degrees[degree] / 12)
}

/** Play one short chirp at the given scale degree. Envelope is attack-then-decay
 *  and shorter than the scheduler interval, so notes never overlap. */
function playNote(degree, vol = VOLUME) {
  playChirp(noteFreq(degree), vol)
}

/** Play one short chirp at a fixed frequency — the same synthesis as a note,
 *  minus the scale mapping. Used by the pause "interlude" beat. */
function playBeat(vol = VOLUME) {
  playChirp(BEAT_FREQ, vol)
}

/** Shared chirp synthesis: two detuned sine oscillators through a short
 *  attack-then-decay envelope, shorter than the scheduler interval so sounds
 *  never overlap. */
function playChirp(f, vol) {
  const ac = ensureAudio()
  if (!ac || !master) return
  const t = ac.currentTime

  master.gain.setValueAtTime(vol, t) // restore bus at this note's volume (faded on stop)

  const osc1 = ac.createOscillator()
  osc1.type = 'sine'
  osc1.frequency.value = f
  const osc2 = ac.createOscillator()
  osc2.type = 'sine'
  osc2.frequency.value = f * (1 + SHIMMER)
  const d2 = ac.createGain()
  d2.gain.value = 0.35

  const env = ac.createGain()
  const dur = NOTE_LEN_MS / 1000
  env.gain.setValueAtTime(0.0001, t)
  env.gain.exponentialRampToValueAtTime(1, t + 0.012)
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur)

  osc1.connect(env)
  osc2.connect(d2)
  d2.connect(env)
  env.connect(master)

  osc1.start(t)
  osc2.start(t)
  osc1.stop(t + dur + 0.02)
  osc2.stop(t + dur + 0.02)
}

// ------------------------------ pitch mapping -------------------------------
/** Recompute the dynamic mapping bounds: fit the cps range observed over the
 *  past RANGE_WINDOW_MS across the whole ladder, with a minimum span so a very
 *  steady stream can't become hypersensitive and a small outward pad so the
 *  top and bottom degrees stay reachable. Called at most every
 *  REMAP_INTERVAL_MS, so the compression drifts slowly instead of tracking
 *  each tick and never causes a pitch jump. */
function remapRange(now) {
  if (now - lastRemapAt < REMAP_INTERVAL_MS) return
  lastRemapAt = now
  if (!cpsSamples.length) return // nothing observed yet — keep the initial bounds
  let lo = Infinity
  let hi = -Infinity
  for (const s of cpsSamples) {
    if (s.logCps < lo) lo = s.logCps
    if (s.logCps > hi) hi = s.logCps
  }
  // min-span floor: a band narrower than 2^(MIN_SPAN_LOG2) in cps stays at the
  // floor, centered on the observed range — sensitivity stays bounded
  let span = hi - lo
  if (span < MIN_SPAN_LOG2) {
    const mid = (lo + hi) / 2
    lo = mid - MIN_SPAN_LOG2 / 2
    hi = mid + MIN_SPAN_LOG2 / 2
    span = MIN_SPAN_LOG2
  }
  const pad = span * RANGE_PAD
  mapLo = lo - pad
  mapHi = hi + pad
}

/** Map the smoothed cps to a scale degree via the dynamic bounds. The ladder
 *  is fitted onto [mapLo, mapHi] (natural log of cps, set by remapRange), so
 *  the whole three-octave range tracks the recently observed speed range. */
function degreeForCps(cps) {
  const t = (Math.log(cps) - mapLo) / (mapHi - mapLo)
  const degrees = getScale().degrees
  const i = Math.round(Math.min(1, Math.max(0, t)) * (degrees.length - 1))
  return i
}

// ------------------------------ smooth jitter --------------------------------
/** Roll one jitter "perturbation": a short (≤ JITTER_MAX_LEN note) bump of
 *  integer scale-degree deltas whose maximum is a random peak of 1..JITTER_MAX_PEAK.
 *  The bump rises toward the peak and falls after it (each step ±1), so the
 *  melody is bent continuously over a few notes instead of one note jumping.
 *  The sign is random — a jitter can lift the melody or dip it. */
function rollJitterPattern() {
  const len = 1 + Math.floor(Math.random() * JITTER_MAX_LEN)      // 1..4 notes
  const peak = 1 + Math.floor(Math.random() * JITTER_MAX_PEAK)    // 1..4 degrees
  const peakPos = Math.floor(Math.random() * len)                 // where the bump tops out
  const pattern = new Array(len)
  for (let i = 0; i < len; i += 1) {
    const dist = Math.abs(i - peakPos)
    const target = peak - dist                                    // ramp down by 1 per step
    pattern[i] = i === 0 ? target : Math.max(1, pattern[i - 1] + (Math.random() < 0.5 ? -1 : 1))
    if (pattern[i] > target) pattern[i] = target                  // never overshoot the envelope
  }
  const sign = Math.random() < 0.5 ? -1 : 1
  jitterPattern = pattern.map(d => sign * d)
  jitterPos = 0
}

// ------------------------------ rhythm --------------------------------------
const SLOT_MS = RHYTHM_PERIOD_MS / RHYTHM_SLOTS // ms per placement slot (125 ms = a sixteenth note)

/** Roll one phrase of rhythm: RHYTHM_PERIOD_MS, fixed, subdivided into
 *  RHYTHM_SLOTS sixteenth-note slots. Returns a sorted list of the slot indices
 *  that hold a note. A random count (RHYTHM_MIN_NOTES..RHYTHM_MAX_NOTES) of
 *  slots are chosen, with the downbeat (slot 0) always anchored and the rest
 *  drawn by weighted sampling that favours bar starts (downbeats) so the
 *  phrase feels grounded even as the count and placement vary. */
function rollRhythm() {
  const count = RHYTHM_MIN_NOTES + Math.floor(Math.random() * (RHYTHM_MAX_NOTES - RHYTHM_MIN_NOTES + 1))
  const chosen = new Set([0])
  // weights per slot: downbeats (bar starts, every RHYTHM_SLOTS/RHYTHM_BARS slots) weigh more
  const weights = new Array(RHYTHM_SLOTS)
  const slotsPerBar = RHYTHM_SLOTS / RHYTHM_BARS
  for (let s = 0; s < RHYTHM_SLOTS; s += 1) weights[s] = (s % slotsPerBar === 0) ? RHYTHM_DOWNBEAT_WEIGHT : 1
  let remaining = count - 1
  while (remaining > 0) {
    let total = 0
    for (let s = 0; s < RHYTHM_SLOTS; s += 1) if (!chosen.has(s)) total += weights[s]
    let r = Math.random() * total
    for (let s = 0; s < RHYTHM_SLOTS; s += 1) {
      if (chosen.has(s)) continue
      r -= weights[s]
      if (r <= 0) { chosen.add(s); remaining -= 1; break }
    }
    if (remaining > 0 && chosen.size >= RHYTHM_SLOTS) break // safety: never more notes than slots
  }
  return [...chosen].sort((a, b) => a - b)
}

/** Begin a fresh phrase anchored to the wall clock so phrases stay exactly
 *  RHYTHM_PERIOD_MS long with no drift, even across silent gaps. */
function startPhrase(now) {
  rhythmSlots = rollRhythm()
  rhythmIndex = 0
  rhythmAnchor = now
}

// ------------------------------ scheduler -----------------------------------
/** Schedule the next event of the current phrase on the wall-clock grid. A
 *  tick fires either on a note's slot or, if none remain, exactly at the phrase
 *  boundary — whichever comes first — then re-plans from the anchor. */
function scheduleNext() {
  if (disposed || !enabled) return
  const now = performance.now()
  let wait
  if (rhythmIndex < rhythmSlots.length) {
    const slotTime = rhythmAnchor + rhythmSlots[rhythmIndex] * SLOT_MS
    wait = Math.max(0, slotTime - now)
  } else {
    // phrase is done — roll the next one exactly on the boundary (may already be
    // slightly late if a gap stalled us; startPhrase re-anchors to keep it steady)
    wait = Math.max(0, rhythmAnchor + RHYTHM_PERIOD_MS - now)
  }
  timer = setTimeout(tick, wait)
}

function tick() {
  if (!enabled || disposed) return
  const now = performance.now()

  // prune the speed window
  const cutoff = now - WINDOW_MS
  while (deltas.length && deltas[0].t < cutoff) deltas.shift()
  let cps = 0
  if (deltas.length) {
    let chars = 0
    for (const d of deltas) chars += d.chars
    cps = (chars / WINDOW_MS) * 1000
  }
  emaCps = emaCps == null ? cps : EMA * cps + (1 - EMA) * emaCps

  // Rolling cps history for the dynamic range, and a periodic remap of the
  // pitch bounds onto the recently observed range.
  cpsSamples.push({ t: now, logCps: Math.log(Math.max(cps, 1)) })
  const sampleCutoff = now - RANGE_WINDOW_MS
  while (cpsSamples.length && cpsSamples[0].t < sampleCutoff) cpsSamples.shift()
  remapRange(now)

  // Fire every note whose slot has come due this tick. (If we were silent and
  // overshot one or more slots — e.g. a long token gap — skip them so the
  // phrase stays locked to the grid.)
  while (rhythmIndex < rhythmSlots.length && now >= rhythmAnchor + rhythmSlots[rhythmIndex] * SLOT_MS) {
    // Chirp while a stream is active. Pitch tracks the speed-mapped degree
    // (±WANDER ±smooth-jitter) for both text and thinking; thinking tokens feed
    // the same speed window and just play at reduced volume. If tokens stop
    // flowing for STALE_MS (tool calls / waits) the same rhythm continues as a
    // static-frequency "interlude" beat until tokens resume — or the stream
    // ends (generating === 0 silences everything, and stopStreaming fades it).
    if (generating > 0 && !document.hidden && now - lastDeltaAt > STALE_MS) {
      resumeAudio()
      playBeat(inThinking ? THINKING_VOLUME : VOLUME)
    } else if (generating > 0 && !document.hidden) {
      resumeAudio()
      wander = Math.max(-WANDER, Math.min(WANDER, wander + (Math.random() * 2 - 1)))

      // Smooth jitter: a constant-probability perturbation that bends the melody
      // across a few notes. It never starts while one is active, and once a
      // pattern ends a JITTER_GAP quiet period passes before the next can start.
      let jitter = 0
      if (jitterPattern) {
        jitter = jitterPattern[jitterPos]
        jitterPos += 1
        if (jitterPos >= jitterPattern.length) {
          jitterPattern = null
          jitterGap = JITTER_GAP
        }
      } else if (jitterGap > 0) {
        jitterGap -= 1
      } else if (Math.random() < JITTER_PROB) {
        rollJitterPattern()
        jitter = jitterPattern[jitterPos]
        jitterPos += 1
        if (jitterPos >= jitterPattern.length) {
          jitterPattern = null
          jitterGap = JITTER_GAP
        }
      }

      const degrees = getScale().degrees
      const degree = Math.max(0, Math.min(degrees.length - 1, degreeForCps(emaCps) + Math.round(wander + jitter)))
      playNote(degree, inThinking ? THINKING_VOLUME : VOLUME)
    }
    rhythmIndex += 1
  }

  // Roll the next phrase exactly at the grid boundary — independent of where the
  // last note of this phrase landed — so every phrase stays RHYTHM_PERIOD_MS
  // long with no drift. Re-anchors the clock (self-corrects any accumulated
  // setTimeout jitter, and snaps back after a long silent gap).
  if (now >= rhythmAnchor + RHYTHM_PERIOD_MS) startPhrase(now)
  scheduleNext()
}

function ensureTimer() {
  if (timer) return
  startPhrase(performance.now())
  scheduleNext()
}

function stopStreaming() {
  if (!timer) return
  clearTimeout(timer)
  timer = null
  // immediate fade — no trailing note, no delay
  const ac = ensureAudio()
  if (ac && master) master.gain.setTargetAtTime(0, ac.currentTime, 0.012)
  if (ac && ac.state === 'running') ac.suspend().catch(() => {})
}

// ------------------------------ gateway events ------------------------------
/** listener signature: host.onEvent(type, (event) => {}), event = { type, payload, session_id } */
function onGatewayEvent(event) {
  if (disposed) return
  const { type, payload } = event || {}

  if (type === 'message.start') {
    resumeAudio()
    generating += 1
    emaCps = null
    cpsSamples.length = 0
    mapLo = Math.log(MIN_CPS) // fresh stream → start from the initial bounds
    mapHi = Math.log(MAX_CPS)
    lastRemapAt = 0
    wander = 0
    jitterPattern = null
    jitterPos = 0
    jitterGap = 0
    inThinking = false
    lastDeltaAt = performance.now()
    ensureTimer()
    emitState()
  } else if (type === 'message.complete' || type === 'error') {
    generating = Math.max(0, generating - 1)
    if (generating === 0) stopStreaming()
    emitState()
  } else if (type === 'message.delta' || type === 'thinking.delta' || type === 'reasoning.delta') {
    const text = payload && typeof payload.text === 'string' ? payload.text : ''
    const chars = text.length || 1
    const now = performance.now()
    lastDeltaAt = now
    inThinking = type !== 'message.delta' // latest tokens decide the volume class
    deltas.push({ t: now, chars })
    /* window is pruned in tick(); guard against unbounded growth if the
       scheduler ever stops while a stream is running */
    if (deltas.length > 2000) deltas.splice(0, deltas.length - 2000)
  }
}

// ------------------------------ UI: status-bar chip --------------------------
// Disk plugins are not scanned by Tailwind; the popover rows are styled with a
// scoped CSS block (same approach as the bundled radio plugin).
const CSS = `
.hermes-gentone-bar{display:flex;align-items:center;height:100%;color:var(--ui-text-tertiary)}
.hermes-gentone-bar .hermes-gentone-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hermes-gentone-picker{width:216px;max-width:calc(100vw - 24px);padding:6px}
.hermes-gentone-scale-row{display:flex;align-items:center;gap:8px;width:100%;height:26px;padding:2px 6px;border-radius:4px;text-align:left;font-size:12px;line-height:18px;color:var(--ui-text-primary);cursor:pointer}
.hermes-gentone-scale-row:hover,.hermes-gentone-scale-row:focus-visible{background:var(--chrome-action-hover)}
.hermes-gentone-scale-row[data-current=true]{background:var(--chrome-action-hover)}
.hermes-gentone-scale-row[data-current=true] .hermes-gentone-scale-name{color:var(--ui-accent)}
.hermes-gentone-scale-row:focus-visible{outline:1px solid var(--ui-accent);outline-offset:-1px}
.hermes-gentone-scale-icon{display:flex;align-items:center;justify-content:center;width:14px;flex-shrink:0;color:var(--ui-text-quaternary);opacity:0}
.hermes-gentone-scale-row[data-current=true] .hermes-gentone-scale-icon,.hermes-gentone-scale-row:hover .hermes-gentone-scale-icon{opacity:1;color:var(--ui-accent)}
.hermes-gentone-scale-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hermes-gentone-scale-notes{flex-shrink:0;font-size:10px;color:var(--ui-text-quaternary)}
.hermes-gentone-divider{height:1px;margin:4px 6px;background:var(--ui-text-quaternary);opacity:.25}
`

function GenToneChip() {
  const [s, setS] = useState({
    enabled,
    generating: generating > 0,
    scaleId: currentScaleId,
    scaleName: getScale().name,
  })
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  const [triggerWidth, setTriggerWidth] = useState(null)

  useEffect(() => {
    const fn = () => setS({
      enabled,
      generating: generating > 0,
      scaleId: currentScaleId,
      scaleName: getScale().name,
    })
    stateSubs.add(fn)
    return () => stateSubs.delete(fn)
  }, [])

  // The chip is the selector trigger — picking a scale is always "on", so the
  // chip itself no longer toggles mute. The only way to silence is the Off
  // row at the bottom of the picker.
  const setOff = () => {
    enabled = false
    stopStreaming()
    emitState()
  }

  // Freeze the trigger width while browsing so a selection can't resize the
  // chip and move the open popover under the pointer (radio-plugin pattern).
  const onOpenChange = value => {
    if (value) setTriggerWidth(triggerRef.current.getBoundingClientRect().width)
    setOpen(value)
  }

  const label = s.enabled ? (s.generating ? '♫' : '♪') : '♪ off'
  const title = s.enabled
    ? `genTone: chirps (${s.scaleName}) while Hermes streams; quieter notes while thinking — open to pick a scale or turn off`
    : 'genTone is off — open the picker and choose a scale to re-enable'

  return jsxs('div', { className: 'hermes-gentone-bar', children: [
    jsxs(Popover, { open, onOpenChange, children: [
      jsxs(PopoverTrigger, { asChild: true, children: jsxs('button', {
        ref: triggerRef,
        type: 'button',
        title,
        style: { width: open ? triggerWidth : undefined },
        className: 'hermes-gentone-label',
        children: [label, jsx('span', { 'aria-hidden': true, children: ' ' }), jsx('span', { children: s.scaleName })]
      }) }),
      jsx(PopoverContent, { side: 'top', align: 'end', className: 'hermes-gentone-picker', 'aria-label': 'genTone scale', children:
        jsxs('div', { children: [
          ...SCALES.map(scale => jsxs(RowButton, {
            className: 'hermes-gentone-scale-row',
            'data-current': scale.id === s.scaleId,
            'aria-pressed': scale.id === s.scaleId,
            title: scale.notes,
            onClick: () => setScale(scale.id),
            children: [
              jsx('span', { className: 'hermes-gentone-scale-icon', 'aria-hidden': true, children: jsx(icons.Check, { size: 12 }) }),
              jsx('span', { className: 'hermes-gentone-scale-name', children: scale.name }),
              jsx('span', { className: 'hermes-gentone-scale-notes', children: scale.notes }),
            ]
          }, scale.id)),
          jsx('div', { className: 'hermes-gentone-divider', 'aria-hidden': true }),
          jsxs(RowButton, {
            className: 'hermes-gentone-scale-row',
            'data-current': false,
            'aria-pressed': false,
            title: 'Silence genTone until a scale is picked again',
            onClick: setOff,
            children: [
              jsx('span', { className: 'hermes-gentone-scale-icon', 'aria-hidden': true, children: jsx(icons.VolumeX, { size: 12 }) }),
              jsx('span', { className: 'hermes-gentone-scale-name', children: 'Off' }),
            ]
          }, 'off'),
        ] })
      })
    ] }),
  ] })
}

// ------------------------------ plugin --------------------------------------
function dispose() {
  disposed = true
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  try {
    const old = globalThis.__gentoneEngine__
    if (old && typeof old.off === 'function') old.off()
  } catch {
    /* ignore */
  }
  const ac = ensureAudio()
  if (ac && master) master.gain.setTargetAtTime(0, ac.currentTime, 0.012)
  if (ac && ac.state === 'running') ac.suspend().catch(() => {})
}

export default {
  id: 'gentone',
  name: 'genTone',
  register(ctx) {
    // Hot-reload guard: saving the file re-evaluates this module while the old
    // instance's interval + event listener are still alive. Dispose the old
    // engine first or notes would double up (stacking).
    if (globalThis.__gentoneEngine__ && typeof globalThis.__gentoneEngine__.dispose === 'function') {
      globalThis.__gentoneEngine__.dispose()
    }

    const style = document.createElement('style')
    style.textContent = CSS
    document.head.append(style)
    ctx.onDispose(() => style.remove())

    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 140,
      render: () => jsx(GenToneChip, {}),
    })

    // One tap on the whole event stream; we filter by type ourselves.
    const off = host.onEvent('*', onGatewayEvent)

    globalThis.__gentoneEngine__ = { dispose }
    globalThis.__gentoneEngine__.off = off
  },
}
