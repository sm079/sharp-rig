// Hover previews for the preset tiles. Each tile shows the photo as a box with the output frame
// inside it; on hover the frame moves the way the preset's camera does. The animation is derived
// from the real motion: the output frame is projected onto the subject plane of a reference
// scene at a few dozen instants and turned into translate / scale / rotate keyframes.

import { quat, v3, type Vec3 } from '../../math';
import { computeStats, type SceneStats } from '../../splat/scene';
import { evaluate, type Motion } from '../../motion/timeline';
import type { Preset } from '../../motion/presets';

const REF = { imageWidth: 1600, imageHeight: 1000, focalPx: 1400 };
const SAMPLES = 32;
/** Real amplitudes are subtle; exaggerate them so a 60 px tile shows the idea. */
const GAIN = 2.2;

let refStats: SceneStats | null = null;
function stats(): SceneStats {
  if (!refStats) {
    const n = 64;
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) positions[i * 3 + 2] = 2 + (i / n) * 4;
    refStats = computeStats({ count: n, positions, covariances: new Float32Array(n * 6), colors: new Uint8Array(n * 4).fill(255), ...REF, source: '' });
  }
  return refStats;
}

const cache = new Map<string, Keyframe[]>();

/** Web Animations keyframes for a preset (cached by id). */
function previewKeyframes(p: Preset): Keyframe[] {
  const key = `${p.id}:${p.name}:${p.duration}`;
  let frames = cache.get(key);
  if (!frames) cache.set(key, (frames = build(p)));
  return frames;
}

function build(p: Preset): Keyframe[] {
  const st = stats();
  const motion: Motion = { name: p.name, duration: p.duration, keyframes: p.build({ stats: st, intensity: 1 }, p.duration) };
  if (!motion.keyframes.length) return [];
  const F = st.focusDepth;
  const { imageWidth: sw, imageHeight: sh, focalPx: f } = REF;
  const tanY0 = sh / (2 * f), tanX0 = sw / (2 * f);

  // Frame corners (TL, TR) and centre on the plane z = F, in source-image pixels.
  const frameAt = (t: number) => {
    const pose = evaluate(motion, t)!;
    const tanY = tanY0 / pose.zoom, tanX = tanX0 / pose.zoom;
    const hit = (cx: number, cy: number): [number, number] => {
      const dir = quat.rotate(pose.rotation, [cx * tanX, cy * tanY, 1]);
      const s = dir[2] > 1e-4 ? (F - pose.position[2]) / dir[2] : F;
      const pt: Vec3 = v3.add(pose.position, v3.scale(dir, s));
      const z = Math.max(1e-3, pt[2]);
      return [(pt[0] / z) * f, (pt[1] / z) * f];
    };
    const tl = hit(-1, -1), tr = hit(1, -1), c = hit(0, 0);
    return { c, width: Math.hypot(tr[0] - tl[0], tr[1] - tl[1]), angle: Math.atan2(tr[1] - tl[1], tr[0] - tl[0]) };
  };

  const out: Keyframe[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = (i / SAMPLES) * p.duration;
    const fr = frameAt(t);
    // Offsets are in units of the frame's own size (CSS translate % is relative to the element).
    const dx = (fr.c[0] / sw) * 100 * GAIN;
    const dy = (fr.c[1] / sh) * 100 * GAIN;
    const scale = Math.pow(fr.width / sw, GAIN);
    const rot = (fr.angle * 180) / Math.PI * GAIN;
    const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));
    out.push({
      offset: i / SAMPLES,
      transform: `translate(${clamp(dx, 60).toFixed(2)}%, ${clamp(dy, 60).toFixed(2)}%) scale(${Math.max(0.35, Math.min(2.2, scale)).toFixed(3)}) rotate(${clamp(rot, 45).toFixed(2)}deg)`,
    });
  }
  return out;
}

/** Start the hover animation on `frameEl`; returns a stop function. */
export function playPreview(frameEl: HTMLElement, p: Preset): () => void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  const frames = previewKeyframes(p);
  if (!frames.length) return () => {};
  const anim = frameEl.animate(frames, {
    duration: Math.max(1400, Math.min(3600, p.duration * 450)),
    iterations: Infinity,
    direction: 'alternate',
    easing: 'linear',
  });
  return () => anim.cancel();
}
