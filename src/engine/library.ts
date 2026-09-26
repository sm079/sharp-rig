// "My motions": motions are stored normalised by the subject distance so they transfer across scenes.

import { v3 } from '../math';
import type { Keyframe, Motion } from '../motion/timeline';
import type { Preset } from '../motion/presets';

export interface SavedMotion { name: string; duration: number; unit: 'focusDepth'; keyframes: Keyframe[] }

const KEY = 'sharprig.motions';
export const SAVED_CATEGORY = 'My motions';

export function loadSaved(): SavedMotion[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

export function storeSaved(list: SavedMotion[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 50))); } catch { /* storage unavailable */ }
}

export function normaliseMotion(m: Motion, F: number): SavedMotion {
  const s = 1 / F;
  return {
    name: m.name, duration: m.duration, unit: 'focusDepth',
    keyframes: m.keyframes.map((k) => ({
      ...k, pose: { ...k.pose, position: v3.scale(k.pose.position, s) }, pivot: k.pivot ? v3.scale(k.pivot, s) : null,
    })),
  };
}

export function denormaliseMotion(m: SavedMotion, F: number): Motion {
  return {
    name: m.name, duration: m.duration,
    keyframes: m.keyframes.map((k) => ({
      ...k, pose: { ...k.pose, position: v3.scale(k.pose.position, F) }, pivot: k.pivot ? v3.scale(k.pivot, F) : null,
    })),
  };
}

export function savedAsPresets(): Preset[] {
  return loadSaved().map((sm, i) => ({
    id: `saved-${i}`, name: sm.name, category: SAVED_CATEGORY, description: `${sm.keyframes.length} keyframes · ${sm.duration}s`,
    duration: sm.duration,
    build: (c, d) => {
      const m = denormaliseMotion(sm, c.stats.focusDepth);
      const k = d / sm.duration;
      return m.keyframes.map((kf) => ({ ...kf, time: kf.time * k }));
    },
  }));
}
