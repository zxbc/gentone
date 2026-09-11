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
//   - While any session is streaming, a scheduler emits one short chirp at a
//     time — durations stay shorter than the shortest possible interval, so
//     notes can never stack or queue. Rhythm is patterned: every PATTERN_SIZE
//     notes use a fixed pattern of intervals around NOTE_EVERY_MS (each ±JITTER,
//     default ±50%), and a fresh random pattern rolls only after 8 notes have
//     actually played, so the rhythm feels steady in groups of 8.
//   - Generation speed = all streamed chars (text AND thinking tokens) over a
//     rolling WINDOW_MS window. That rate (EMA-smoothed, log-mapped) picks the
//     pitch from the selected scale's 3-octave ladder — C minor blues by
//     default, or minor pentatonic, major, or phrygian dominant, chosen from
//     the ♪ chip's popover (see SCALES below). Faster stream → higher scale
//     degree, so the speed variations paint a melody in the scale. Each
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
//   - When the last stream ends, the scheduler stops and the master volume
//     fades out in ~30ms — no trailing notes, no delay.
// ============================================================================

import { host, STATUSBAR_AREAS, Popover, PopoverContent, PopoverTrigger, RowButton, icons } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

// ------------------------------ tunables -----------------------------------
const ROOT_FREQ = 261.63         // Hz of scale degree 0 (C4)

// 3-octave scale ladders (semitone offsets from the root, ascending). Every
// scale ends exactly two octaves above its first note, so the top degree maps
// to the same ceiling note across scales.
const MINOR_BLUES = [0, 3, 5, 6, 7, 10, 12, 15, 17, 18, 19, 22, 24, 27, 29, 30, 31, 34] // C Eb F F# G Bb
const MINOR_PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27, 29, 31, 34] // C Eb F G Bb
const MAJOR = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24, 26, 28, 29, 31, 33, 35] // C D E F G A B
const PHRYGIAN_DOM = [0, 1, 4, 5, 7, 8, 10, 12, 13, 16, 17, 19, 20, 22, 24, 25, 28, 29, 31, 32, 34] // C Db E F G Ab Bb (1-♭2-3-4-5-♭6-♭7)

const SCALES = [
  { id: 'blues', name: 'Blues', short: 'blues', notes: 'C · E♭ · F · F♯ · G · B♭', degrees: MINOR_BLUES },
  { id: 'pentatonic', name: 'Pentatonic', short: 'penta', notes: 'C · E♭ · F · G · B♭', degrees: MINOR_PENTA },
  { id: 'major', name: 'Major', short: 'major', notes: 'C · D · E · F · G · A · B', degrees: MAJOR },
  { id: 'phrygian', name: 'Phrygian Dominant', short: 'phryg', notes: 'C · D♭ · E · F · G · A♭ · B♭', degrees: PHRYGIAN_DOM },
]
const DEFAULT_SCALE_ID = 'blues'

const NOTE_EVERY_MS = 150        // base cadence — rhythm patterns vary around this
const NOTE_LEN_MS = 70           // chirp length (< shortest possible interval: 75 ms)
const PATTERN_SIZE = 8           // notes per rhythm pattern before a new one rolls
const JITTER = 0.5               // interval variation, ±50% of NOTE_EVERY_MS
const WINDOW_MS = 700            // speed rolling window
const MIN_CPS = 6                // chars/sec → lowest degree (single-digit / low tps)
const MAX_CPS = 100              // chars/sec → highest degree (100+ tps hits the top)
const STALE_MS = 900             // no delta for this long → thinking mode
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
let wander = 0                // current ±degree offset from the mapped note
let jitterPattern = null      // active smooth perturbation — array of integer degree deltas, or null
let jitterPos = 0             // note index within the active jitterPattern
let jitterGap = 0             // notes left in the quiet gap before the next jitter may start
let timer = null              // scheduler handle (setTimeout chain)
let pattern = null            // [ms, ...] intervals for the current note group
let patternPos = 0            // slot within the current pattern
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
  const ac = ensureAudio()
  if (!ac || !master) return
  const t = ac.currentTime
  const f = noteFreq(degree)

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
function degreeForCps(cps) {
  const lo = Math.log(MIN_CPS)
  const hi = Math.log(MAX_CPS)
  const t = (Math.log(cps) - lo) / (hi - lo)
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

// ------------------------------ scheduler -----------------------------------
/** One rhythm pattern = PATTERN_SIZE intervals, each base ±JITTER. The pattern
 *  holds for a whole group of notes and a fresh one rolls only after 8 notes
 *  have actually played, so the feel stays steady within a group. */
function rollPattern() {
  pattern = []
  patternPos = 0
  for (let i = 0; i < PATTERN_SIZE; i++) {
    pattern.push(NOTE_EVERY_MS * (1 + (Math.random() * 2 - 1) * JITTER))
  }
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

  // Chirp while a stream is active and tokens are flowing. Pitch tracks the
  // speed-mapped degree (±WANDER) for both text and thinking. Thinking tokens
  // feed the same speed window; we just play them at reduced volume so the
  // "thinking" phase is audible but quieter than the answer. No tokens for
  // STALE_MS (tool calls / waits) → silence.
  let played = false
  const degrees = getScale().degrees
  if (generating > 0 && !document.hidden && now - lastDeltaAt <= STALE_MS) {
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

    const degree = Math.max(0, Math.min(degrees.length - 1, degreeForCps(emaCps) + Math.round(wander + jitter)))
    playNote(degree, inThinking ? THINKING_VOLUME : VOLUME)
    played = true
  }

  // Advance the rhythm only on notes actually played (the user asked for a new
  // pattern every 8 notes played), then schedule the next tick from the
  // pattern. Silent ticks (gaps) just reschedule at the base interval.
  if (played) {
    patternPos += 1
    if (patternPos >= PATTERN_SIZE) rollPattern()
  }
  timer = setTimeout(tick, played ? pattern[patternPos] : NOTE_EVERY_MS)
}

function ensureTimer() {
  if (timer) return
  rollPattern()
  timer = setTimeout(tick, NOTE_EVERY_MS)
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
