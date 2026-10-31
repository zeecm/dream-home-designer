import { useSyncExternalStore } from 'react';

/**
 * Soft footsteps while walking through: a short burst of filtered noise per step, a little
 * different each time, made with Web Audio (nothing to download). They can be turned off,
 * and the choice is remembered in this browser.
 */

const KEY = 'dhd-walk-sound';
const listeners = new Set<() => void>();

function stored(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

let on = typeof window === 'undefined' ? false : stored();

export function setSound(value: boolean) {
  on = value;
  try {
    window.localStorage.setItem(KEY, value ? 'on' : 'off');
  } catch {
    // Private windows may refuse; the choice holds for this visit.
  }
  for (const fn of listeners) fn();
}

/** Whether footsteps play, as React state. */
export function useSound(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => on,
  );
}

let audio: AudioContext | null = null;
let noise: AudioBuffer | null = null;

/** A step's sound: 120 ms of noise, fading fast, as a soft shoe on a hard floor. */
function stepBuffer(ctx: AudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 0.12);
  const buf = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / length;
    data[i] = (Math.random() * 2 - 1) * (1 - t) ** 3;
  }
  return buf;
}

/**
 * Makes the audio ready: call it from a tap or click (starting a walk, the toggle), since
 * some browsers (iPhones) only let sound start from one.
 */
export function unlockAudio() {
  if (!on || typeof AudioContext === 'undefined') return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume().catch(() => {});
  } catch {
    // No audio here: walking stays silent.
  }
}

/** Plays one footstep (`weight` above 1 for running). Silent if sound is off or unavailable. */
export function footstep(weight = 1) {
  if (!on || typeof AudioContext === 'undefined') return;
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume().catch(() => {});
    noise ??= stepBuffer(audio);
    const src = audio.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = 0.75 + Math.random() * 0.3;
    const filter = audio.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500 + Math.random() * 250;
    const gain = audio.createGain();
    gain.gain.value = 0.12 * weight;
    src.connect(filter).connect(gain).connect(audio.destination);
    src.start();
  } catch {
    // No audio here (or it was refused): walking stays silent.
  }
}
