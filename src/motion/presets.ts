// Library of predefined motions. Every preset is expressed as ordinary pose keyframes +
// segment easings, so choosing one simply fills the timeline and stays fully editable.
// Amplitudes are derived from the scene (SHARP's own max-disparity heuristic) so motions stay
// inside the region a single-image reconstruction can plausibly render.

import { DEG, mulberry32, quat, v3, type Quat, type Vec3 } from '../math';
import type { SceneStats } from '../splat/scene';
import type { EasingSpec } from './easing';
import { makeKeyframe, type Keyframe, type PathMode, type Pose } from './timeline';

export interface PresetContext {
  stats: SceneStats;
  /** user amplitude multiplier */
  intensity: number;
}

export interface Preset {
  id: string;
  name: string;
  category: string;
  description: string;
  duration: number;
  build: (ctx: PresetContext, duration: number) => Keyframe[];
}

// ---------- helpers ----------

const pose = (position: Vec3 = [0, 0, 0], ypr: Vec3 = [0, 0, 0], zoom = 1): Pose => ({
  position,
  rotation: quat.fromEuler(ypr[0] * DEG, ypr[1] * DEG, ypr[2] * DEG),
  zoom,
});

const lookAt = (position: Vec3, target: Vec3, zoom = 1, rollDeg = 0): Pose => {
  let rotation = quat.lookRotation(v3.sub(target, position));
  if (rollDeg) rotation = quat.mul(rotation, quat.axisAngle([0, 0, 1], rollDeg * DEG));
  return { position, rotation, zoom };
};

/** Rigidly rotate a pose about a pivot: the camera rides on an arm fixed to the pivot. */
export function rig(base: Pose, pivot: Vec3, delta: Quat): Pose {
  return {
    position: v3.add(pivot, quat.rotate(delta, v3.sub(base.position, pivot))),
    rotation: quat.norm(quat.mul(delta, base.rotation)),
    zoom: base.zoom,
  };
}

const yawQ = (deg: number) => quat.axisAngle([0, 1, 0], deg * DEG);
const pitchQ = (deg: number) => quat.axisAngle([1, 0, 0], deg * DEG);
const rollQ = (deg: number) => quat.axisAngle([0, 0, 1], deg * DEG);

type K = [time01: number, pose: Pose, easing?: string, extra?: { pivot?: Vec3; path?: PathMode }];

function keys(duration: number, list: K[], defaultEasing = 'easeInOutCubic'): Keyframe[] {
  return list.map(([t, p, e, extra]) =>
    makeKeyframe(t * duration, p, {
      easing: { name: e ?? defaultEasing } as EasingSpec,
      pivot: extra?.pivot ?? null,
      path: extra?.path ?? 'auto',
    }),
  );
}

/** Sample a parametric path into spline keyframes (for loops, shakes, figure-eights...). */
function sampled(duration: number, n: number, fn: (u: number) => Pose, easing = 'linear'): Keyframe[] {
  const out: K[] = [];
  for (let i = 0; i <= n; i++) out.push([i / n, fn(i / n), easing, { path: 'spline' }]);
  return keys(duration, out);
}

const units = (c: PresetContext) => {
  const a = c.stats.lateralUnit * c.intensity; // lateral amplitude (m)
  const m = c.stats.medialUnit * c.intensity; // forward amplitude (m)
  const F = c.stats.focusDepth;
  const orbitDeg = Math.atan2(1.3 * a, F) / DEG;
  const subject: Vec3 = [0, 0, F];
  // Rigid-arm moves rotate the camera by the full arm angle, and a single photo only covers
  // its own field of view, so use a long arm (small angle, useful translation).
  const arm = 1.6 * F;
  const armDeg = (lateral: number) => Math.atan2(lateral, arm) / DEG;
  return { a, m, F, orbitDeg, subject, arm, armDeg, k: c.intensity };
};

// ---------- presets ----------

export const PRESETS: Preset[] = [];
const add = (p: Preset) => PRESETS.push(p);

// Dolly
add({ id: 'push-in', name: 'Push In', category: 'Dolly', description: 'Smooth forward dolly toward the subject.', duration: 5,
  build: (c, d) => { const { m } = units(c); return keys(d, [[0, pose()], [1, pose([0, 0, 1.6 * m])]]); } });
add({ id: 'pull-out', name: 'Pull Out', category: 'Dolly', description: 'Start close, ease back to the original framing.', duration: 5,
  build: (c, d) => { const { m } = units(c); return keys(d, [[0, pose([0, 0, 1.6 * m])], [1, pose()]]); } });
add({ id: 'slow-push', name: 'Slow Push', category: 'Dolly', description: 'Barely-there creep forward. Great for portraits.', duration: 8,
  build: (c, d) => { const { m } = units(c); return keys(d, [[0, pose()], [1, pose([0, 0, 0.8 * m])]], 'easeInOutSine'); } });
add({ id: 'crash-in', name: 'Crash In', category: 'Dolly', description: 'Accelerating push that slams into the scene.', duration: 2.5,
  build: (c, d) => { const { m } = units(c); return keys(d, [[0, pose(), 'easeInExpo'], [0.8, pose([0, 0, 2.2 * m]), 'hold'], [1, pose([0, 0, 2.2 * m])]]); } });
add({ id: 'push-tilt', name: 'Push + Tilt Up', category: 'Dolly', description: 'Dolly forward while tilting up to reveal.', duration: 6,
  build: (c, d) => { const { m, k } = units(c); return keys(d, [[0, pose([0, 0, 0], [0, -3 * k, 0], 1.08)], [1, pose([0, 0, 1.3 * m], [0, 3 * k, 0], 1.08)]]); } });
add({ id: 'pull-rise', name: 'Pull Back + Rise', category: 'Dolly', description: 'Retreat and lift, like a drone backing away.', duration: 6,
  build: (c, d) => { const { m, a, subject } = units(c); return keys(d, [[0, pose([0, 0, 1.6 * m])], [1, lookAt([0, -a, 0], subject)]], 'easeInOutQuart'); } });

// Truck / pedestal
add({ id: 'truck-left', name: 'Truck Left', category: 'Truck & Pedestal', description: 'Slide the camera sideways to the left.', duration: 5,
  build: (c, d) => { const { a } = units(c); return keys(d, [[0, pose([a, 0, 0])], [1, pose([-a, 0, 0])]], 'easeInOutSine'); } });
add({ id: 'truck-right', name: 'Truck Right', category: 'Truck & Pedestal', description: 'Slide the camera sideways to the right.', duration: 5,
  build: (c, d) => { const { a } = units(c); return keys(d, [[0, pose([-a, 0, 0])], [1, pose([a, 0, 0])]], 'easeInOutSine'); } });
add({ id: 'ped-up', name: 'Pedestal Up', category: 'Truck & Pedestal', description: 'Raise the camera vertically without tilting.', duration: 5,
  build: (c, d) => { const { a } = units(c); return keys(d, [[0, pose([0, a, 0])], [1, pose([0, -a, 0])]], 'easeInOutSine'); } });
add({ id: 'ped-down', name: 'Pedestal Down', category: 'Truck & Pedestal', description: 'Lower the camera vertically without tilting.', duration: 5,
  build: (c, d) => { const { a } = units(c); return keys(d, [[0, pose([0, -a, 0])], [1, pose([0, a, 0])]], 'easeInOutSine'); } });
add({ id: 'diagonal', name: 'Diagonal Drift', category: 'Truck & Pedestal', description: 'Drift from lower-left to upper-right.', duration: 6,
  build: (c, d) => { const { a, m } = units(c); return keys(d, [[0, pose([-a, 0.6 * a, 0])], [1, pose([a, -0.6 * a, 0.5 * m])]], 'easeInOutSine'); } });
add({ id: 'track-pan', name: 'Tracking Pan', category: 'Truck & Pedestal', description: 'Truck sideways while panning to keep the subject centred.', duration: 6,
  build: (c, d) => { const { a, subject } = units(c); return keys(d, [[0, lookAt([-1.3 * a, 0, 0], subject)], [1, lookAt([1.3 * a, 0, 0], subject)]], 'easeInOutSine'); } });

// Pan / tilt / roll
add({ id: 'pan-left', name: 'Pan Left', category: 'Pan · Tilt · Roll', description: 'Rotate the camera left in place.', duration: 5,
  build: (c, d) => { const { k } = units(c); return keys(d, [[0, pose([0, 0, 0], [4 * k, 0, 0], 1.12)], [1, pose([0, 0, 0], [-4 * k, 0, 0], 1.12)]], 'easeInOutSine'); } });
add({ id: 'pan-right', name: 'Pan Right', category: 'Pan · Tilt · Roll', description: 'Rotate the camera right in place.', duration: 5,
  build: (c, d) => { const { k } = units(c); return keys(d, [[0, pose([0, 0, 0], [-4 * k, 0, 0], 1.12)], [1, pose([0, 0, 0], [4 * k, 0, 0], 1.12)]], 'easeInOutSine'); } });
add({ id: 'tilt-up', name: 'Tilt Up', category: 'Pan · Tilt · Roll', description: 'Tilt the camera upward in place.', duration: 5,
  build: (c, d) => { const { k } = units(c); return keys(d, [[0, pose([0, 0, 0], [0, -3 * k, 0], 1.12)], [1, pose([0, 0, 0], [0, 3 * k, 0], 1.12)]], 'easeInOutSine'); } });
add({ id: 'tilt-down', name: 'Tilt Down', category: 'Pan · Tilt · Roll', description: 'Tilt the camera downward in place.', duration: 5,
  build: (c, d) => { const { k } = units(c); return keys(d, [[0, pose([0, 0, 0], [0, 3 * k, 0], 1.12)], [1, pose([0, 0, 0], [0, -3 * k, 0], 1.12)]], 'easeInOutSine'); } });
add({ id: 'dutch-left', name: 'Dutch Left', category: 'Pan · Tilt · Roll', description: 'Roll into a counter-clockwise dutch angle.', duration: 4,
  build: (c, d) => { const { k, m } = units(c); return keys(d, [[0, pose([0, 0, 0], [0, 0, 0], 1.1)], [1, pose([0, 0, 0.4 * m], [0, 0, -8 * k], 1.18)]]); } });
add({ id: 'dutch-right', name: 'Dutch Right', category: 'Pan · Tilt · Roll', description: 'Roll into a clockwise dutch angle.', duration: 4,
  build: (c, d) => { const { k, m } = units(c); return keys(d, [[0, pose([0, 0, 0], [0, 0, 0], 1.1)], [1, pose([0, 0, 0.4 * m], [0, 0, 8 * k], 1.18)]]); } });
add({ id: 'roll-sway', name: 'Roll Sway', category: 'Pan · Tilt · Roll', description: 'Gentle side-to-side roll, like a boat.', duration: 6,
  build: (c, d) => { const { k } = units(c); return keys(d, [[0, pose([0, 0, 0], [0, 0, -4 * k], 1.12)], [0.5, pose([0, 0, 0], [0, 0, 4 * k], 1.12)], [1, pose([0, 0, 0], [0, 0, -4 * k], 1.12)]], 'easeInOutSine'); } });

// Orbit (front / subject pivot)
const orbit = (c: PresetContext, yawDeg: number, pitchDeg = 0, armScale = 1): Pose => {
  const { subject } = units(c);
  let base = pose([0, 0, 0], [0, 0, 0], 1.06);
  if (armScale !== 1) base = { ...base, position: v3.add(subject, v3.scale(v3.sub(base.position, subject), armScale)) };
  return rig(base, subject, quat.mul(yawQ(yawDeg), pitchQ(pitchDeg)));
};
add({ id: 'orbit-left', name: 'Orbit Left', category: 'Orbit (subject pivot)', description: 'Circle the subject to the left, keeping distance.', duration: 6,
  build: (c, d) => { const { orbitDeg, subject } = units(c); return keys(d, [[0, orbit(c, -orbitDeg), undefined, { pivot: subject }], [1, orbit(c, orbitDeg), undefined, { pivot: subject }]]); } });
add({ id: 'orbit-right', name: 'Orbit Right', category: 'Orbit (subject pivot)', description: 'Circle the subject to the right, keeping distance.', duration: 6,
  build: (c, d) => { const { orbitDeg, subject } = units(c); return keys(d, [[0, orbit(c, orbitDeg), undefined, { pivot: subject }], [1, orbit(c, -orbitDeg), undefined, { pivot: subject }]]); } });
add({ id: 'orbit-up', name: 'Orbit Over', category: 'Orbit (subject pivot)', description: 'Arc upward over the subject while looking at it.', duration: 6,
  build: (c, d) => { const { orbitDeg, subject } = units(c); return keys(d, [[0, orbit(c, 0, 0.7 * orbitDeg), undefined, { pivot: subject }], [1, orbit(c, 0, -0.7 * orbitDeg), undefined, { pivot: subject }]]); } });
add({ id: 'orbit-down', name: 'Orbit Under', category: 'Orbit (subject pivot)', description: 'Arc downward, ending at a low angle.', duration: 6,
  build: (c, d) => { const { orbitDeg, subject } = units(c); return keys(d, [[0, orbit(c, 0, -0.7 * orbitDeg), undefined, { pivot: subject }], [1, orbit(c, 0, 0.7 * orbitDeg), undefined, { pivot: subject }]]); } });
add({ id: 'orbit-swing', name: 'Orbit Swing', category: 'Orbit (subject pivot)', description: 'Swing around the subject and back.', duration: 8,
  build: (c, d) => { const { orbitDeg, subject } = units(c); const p = { pivot: subject }; return keys(d, [[0, orbit(c, -orbitDeg), 'easeInOutSine', p], [0.5, orbit(c, orbitDeg), 'easeInOutSine', p], [1, orbit(c, -orbitDeg), 'easeInOutSine', p]]); } });
add({ id: 'orbit-diag', name: 'Orbit Diagonal', category: 'Orbit (subject pivot)', description: 'Orbit from low-left to high-right.', duration: 7,
  build: (c, d) => { const { orbitDeg, subject } = units(c); return keys(d, [[0, orbit(c, -orbitDeg, 0.5 * orbitDeg), undefined, { pivot: subject }], [1, orbit(c, orbitDeg, -0.5 * orbitDeg), undefined, { pivot: subject }]]); } });
add({ id: 'orbit-push', name: 'Orbit + Push', category: 'Orbit (subject pivot)', description: 'Orbit while shortening the arm toward the subject.', duration: 7,
  build: (c, d) => { const { orbitDeg, subject, m, F } = units(c); const s = Math.max(0.5, 1 - (1.4 * m) / F); return keys(d, [[0, orbit(c, -orbitDeg), undefined, { pivot: subject }], [1, orbit(c, orbitDeg, 0, s), undefined, { pivot: subject }]]); } });
add({ id: 'pendulum', name: 'Pendulum', category: 'Orbit (subject pivot)', description: 'Rhythmic orbit oscillation.', duration: 8,
  build: (c, d) => { const { orbitDeg, subject } = units(c); const p = { pivot: subject }; return keys(d, [[0, orbit(c, -orbitDeg), 'easeInOutSine', p], [0.25, orbit(c, orbitDeg), 'easeInOutSine', p], [0.5, orbit(c, -orbitDeg), 'easeInOutSine', p], [0.75, orbit(c, orbitDeg), 'easeInOutSine', p], [1, orbit(c, -orbitDeg), 'easeInOutSine', p]]); } });

// Crane / jib (rear, side, top pivots)
const rear = (c: PresetContext): Vec3 => [0, 0, -units(c).arm];
const jibBase = () => pose([0, 0, 0], [0, 0, 0], 1.08);
const jibDeg = (c: PresetContext) => { const u = units(c); return u.armDeg(1.1 * u.a); };
const craneDeg = (c: PresetContext) => { const u = units(c); return u.armDeg(0.7 * u.a); };
add({ id: 'crane-up', name: 'Crane Up', category: 'Crane & Jib (rear pivot)', description: 'Camera rises on a jib arm pivoting behind it.', duration: 6,
  build: (c, d) => { const R = rear(c), j = craneDeg(c); return keys(d, [[0, rig(jibBase(), R, pitchQ(-j)), undefined, { pivot: R }], [1, rig(jibBase(), R, pitchQ(j)), undefined, { pivot: R }]]); } });
add({ id: 'crane-down', name: 'Crane Down', category: 'Crane & Jib (rear pivot)', description: 'Camera descends on a jib arm.', duration: 6,
  build: (c, d) => { const R = rear(c), j = craneDeg(c); return keys(d, [[0, rig(jibBase(), R, pitchQ(j)), undefined, { pivot: R }], [1, rig(jibBase(), R, pitchQ(-j)), undefined, { pivot: R }]]); } });
add({ id: 'jib-left', name: 'Jib Sweep Left', category: 'Crane & Jib (rear pivot)', description: 'Wide sweeping arc to the left around a rear pivot.', duration: 6,
  build: (c, d) => { const R = rear(c), j = jibDeg(c); return keys(d, [[0, rig(jibBase(), R, yawQ(j)), undefined, { pivot: R }], [1, rig(jibBase(), R, yawQ(-j)), undefined, { pivot: R }]]); } });
add({ id: 'jib-right', name: 'Jib Sweep Right', category: 'Crane & Jib (rear pivot)', description: 'Wide sweeping arc to the right around a rear pivot.', duration: 6,
  build: (c, d) => { const R = rear(c), j = jibDeg(c); return keys(d, [[0, rig(jibBase(), R, yawQ(-j)), undefined, { pivot: R }], [1, rig(jibBase(), R, yawQ(j)), undefined, { pivot: R }]]); } });
add({ id: 'boom-reveal', name: 'Boom Reveal', category: 'Crane & Jib (rear pivot)', description: 'Rise on the jib and push in at the top.', duration: 7,
  build: (c, d) => { const R = rear(c), j = craneDeg(c); const { m } = units(c); const top = rig(jibBase(), R, pitchQ(j)); return keys(d, [[0, rig(jibBase(), R, pitchQ(-j)), 'easeInOutSine', { pivot: R }], [0.6, top, 'easeOutCubic', { pivot: R }], [1, { ...top, position: v3.add(top.position, quat.rotate(top.rotation, [0, 0, m])) }]]); } });
add({ id: 'jib-diag', name: 'Jib Diagonal', category: 'Crane & Jib (rear pivot)', description: 'Sweep up and across on a rear pivot.', duration: 7,
  build: (c, d) => { const R = rear(c), j = jibDeg(c); return keys(d, [[0, rig(jibBase(), R, quat.mul(yawQ(-j), pitchQ(-0.45 * j))), undefined, { pivot: R }], [1, rig(jibBase(), R, quat.mul(yawQ(j), pitchQ(0.45 * j))), undefined, { pivot: R }]]); } });
add({ id: 'top-swing', name: 'Pendulum Swing', category: 'Crane & Jib (rear pivot)', description: 'Camera hangs from a pivot above and swings side to side.', duration: 6,
  build: (c, d) => { const { arm, armDeg, a } = units(c); const T: Vec3 = [0, -arm, 0]; const r = armDeg(1.2 * a); const p = { pivot: T };
    return keys(d, [[0, rig(pose([0, 0, 0], [0, 0, 0], 1.12), T, rollQ(-r)), 'easeInOutSine', p], [0.5, rig(pose([0, 0, 0], [0, 0, 0], 1.12), T, rollQ(r)), 'easeInOutSine', p], [1, rig(pose([0, 0, 0], [0, 0, 0], 1.12), T, rollQ(-r)), 'easeInOutSine', p]]); } });
add({ id: 'side-swing', name: 'Swing Door', category: 'Crane & Jib (rear pivot)', description: 'Hinge around a pivot to the side of the camera.', duration: 6,
  build: (c, d) => { const { arm, armDeg, m } = units(c); const S: Vec3 = [-arm, 0, 0]; const j = armDeg(1.2 * m); const p = { pivot: S };
    return keys(d, [[0, rig(pose([0, 0, 0], [0, 0, 0], 1.1), S, yawQ(-j)), undefined, p], [1, rig(pose([0, 0, 0], [0, 0, 0], 1.1), S, yawQ(j)), undefined, p]]); } });

// Lens
add({ id: 'zoom-in', name: 'Zoom In', category: 'Lens', description: 'Optical zoom in (no camera movement).', duration: 5,
  build: (_c, d) => keys(d, [[0, pose()], [1, pose([0, 0, 0], [0, 0, 0], 1.4)]], 'easeInOutQuad') });
add({ id: 'zoom-out', name: 'Zoom Out', category: 'Lens', description: 'Optical zoom out to the full frame.', duration: 5,
  build: (_c, d) => keys(d, [[0, pose([0, 0, 0], [0, 0, 0], 1.4)], [1, pose()]], 'easeInOutQuad') });
add({ id: 'snap-zoom', name: 'Snap Zoom', category: 'Lens', description: 'Fast punch-in zoom, then hold.', duration: 2.5,
  build: (_c, d) => keys(d, [[0, pose(), 'hold'], [0.2, pose(), 'easeOutExpo'], [0.45, pose([0, 0, 0], [0, 0, 0], 1.6), 'hold'], [1, pose([0, 0, 0], [0, 0, 0], 1.6)]]) });
const vertigo = (c: PresetContext, inward: boolean, d: number) => {
  const { F, m } = units(c);
  const z0 = 1.45;
  const dz = Math.min(F * (1 - 1 / z0) * 0.95, 3 * m);
  const zEnd = (z0 * (F - dz)) / F; // keep subject size: zoom / (F - z) constant
  const A = pose([0, 0, 0], [0, 0, 0], z0), B = pose([0, 0, dz], [0, 0, 0], zEnd);
  return keys(d, inward ? [[0, A], [1, B]] : [[0, B], [1, A]], 'easeInOutSine');
};
add({ id: 'vertigo-in', name: 'Dolly Zoom In', category: 'Lens', description: 'Hitchcock "vertigo": push in while zooming out.', duration: 5, build: (c, d) => vertigo(c, true, d) });
add({ id: 'vertigo-out', name: 'Dolly Zoom Out', category: 'Lens', description: 'Pull back while zooming in; background looms.', duration: 5, build: (c, d) => vertigo(c, false, d) });
add({ id: 'ken-burns', name: 'Ken Burns', category: 'Lens', description: 'Slow zoom with a gentle drift.', duration: 8,
  build: (c, d) => { const { a } = units(c); return keys(d, [[0, pose([-0.3 * a, 0.2 * a, 0], [0, 0, 0], 1.05)], [1, pose([0.3 * a, -0.2 * a, 0], [0, 0, 0], 1.3)]], 'linear'); } });

// SHARP trajectories (sharp.utils.camera)
add({ id: 'sharp-swipe', name: 'Swipe', category: 'Parallax (SHARP)', description: 'SHARP "swipe": left-to-right lateral pass.', duration: 3,
  build: (c, d) => { const { a } = units(c); return keys(d, [[0, pose([-a, 0, 0])], [1, pose([a, 0, 0])]], 'linear'); } });
add({ id: 'sharp-shake', name: 'Shake', category: 'Parallax (SHARP)', description: 'SHARP "shake": horizontal then vertical sine.', duration: 4,
  build: (c, d) => { const { a } = units(c); return sampled(d, 24, (u) => u < 0.5 ? pose([a * Math.sin(2 * Math.PI * u * 2), 0, 0]) : pose([0, a * Math.sin(2 * Math.PI * (u - 0.5) * 2), 0])); } });
add({ id: 'sharp-rotate', name: 'Circle', category: 'Parallax (SHARP)', description: 'SHARP "rotate": the eye circles in the image plane.', duration: 4,
  build: (c, d) => { const { a } = units(c); return sampled(d, 16, (u) => pose([a * Math.sin(2 * Math.PI * u), a * Math.cos(2 * Math.PI * u), 0])); } });
add({ id: 'sharp-rotate-forward', name: 'Rotate Forward', category: 'Parallax (SHARP)', description: 'SHARP default: side-to-side with a forward bob.', duration: 4,
  build: (c, d) => { const { a, m } = units(c); return sampled(d, 16, (u) => pose([a * Math.sin(2 * Math.PI * u), 0, (m * (1 - Math.cos(2 * Math.PI * u))) / 2])); } });
add({ id: 'figure-eight', name: 'Figure Eight', category: 'Parallax (SHARP)', description: 'Lissajous figure-eight parallax loop.', duration: 6,
  build: (c, d) => { const { a } = units(c); return sampled(d, 24, (u) => pose([a * Math.sin(2 * Math.PI * u), 0.5 * a * Math.sin(4 * Math.PI * u), 0])); } });
add({ id: 'bounce', name: 'Parallax Bounce', category: 'Parallax (SHARP)', description: 'Lateral pass with an overshoot settle.', duration: 3,
  build: (c, d) => { const { a } = units(c); return keys(d, [[0, pose([-a, 0, 0])], [1, pose([a, 0, 0])]], 'easeOutBack'); } });
add({ id: 'wiggle', name: 'Wiggle 3D', category: 'Parallax (SHARP)', description: 'Fast left/right stereo wiggle.', duration: 2,
  build: (c, d) => { const { a } = units(c); return keys(d, [[0, pose([-0.6 * a, 0, 0])], [0.25, pose([0.6 * a, 0, 0])], [0.5, pose([-0.6 * a, 0, 0])], [0.75, pose([0.6 * a, 0, 0])], [1, pose([-0.6 * a, 0, 0])]], 'easeInOutSine'); } });

// Cinematic combos
add({ id: 'spiral-in', name: 'Spiral In', category: 'Cinematic', description: 'Circle inward while pushing forward.', duration: 6,
  build: (c, d) => { const { a, m } = units(c); return sampled(d, 24, (u) => { const r = a * (1 - u); return pose([r * Math.sin(2 * Math.PI * u), r * Math.cos(2 * Math.PI * u), 1.5 * m * u]); }, 'linear'); } });
add({ id: 'spiral-out', name: 'Spiral Out', category: 'Cinematic', description: 'Circle outward while pulling back.', duration: 6,
  build: (c, d) => { const { a, m } = units(c); return sampled(d, 24, (u) => { const r = a * u; return pose([r * Math.sin(2 * Math.PI * u), -r * Math.cos(2 * Math.PI * u), 1.5 * m * (1 - u)]); }, 'linear'); } });
add({ id: 'corkscrew', name: 'Corkscrew', category: 'Cinematic', description: 'Push forward while rolling.', duration: 5,
  build: (c, d) => { const { m, k } = units(c); return keys(d, [[0, pose([0, 0, 0], [0, 0, 0], 1.15)], [1, pose([0, 0, 1.6 * m], [0, 0, 18 * k], 1.2)]]); } });
add({ id: 'reveal-rise', name: 'Reveal Rise', category: 'Cinematic', description: 'Rise up while tilting down to keep the subject.', duration: 6,
  build: (c, d) => { const { a, subject } = units(c); return keys(d, [[0, lookAt([0, 1.2 * a, 0], subject)], [1, lookAt([0, -1.2 * a, 0.3 * a], subject)]], 'easeInOutQuart'); } });
add({ id: 'hero', name: 'Hero Low Angle', category: 'Cinematic', description: 'Start low, push in and look up at the subject.', duration: 6,
  build: (c, d) => { const { a, m, subject } = units(c); return keys(d, [[0, lookAt([0, 1.2 * a, 0], subject, 1.05)], [1, lookAt([0, 1.4 * a, 1.2 * m], v3.add(subject, [0, -0.3 * a, 0]), 1.05)]], 'easeInOutSine'); } });
add({ id: 'breathing', name: 'Breathing', category: 'Cinematic', description: 'Subtle in-and-out push, loops cleanly.', duration: 6,
  build: (c, d) => { const { m } = units(c); return keys(d, [[0, pose()], [0.5, pose([0, 0, 0.6 * m])], [1, pose()]], 'easeInOutSine'); } });
add({ id: 'push-orbit', name: 'Push & Arc', category: 'Cinematic', description: 'Push in, then arc around the subject.', duration: 8,
  build: (c, d) => { const { m, orbitDeg, subject } = units(c); const mid = pose([0, 0, m]); return keys(d, [[0, pose(), 'easeInCubic'], [0.45, mid, 'easeOutCubic', { pivot: subject }], [1, rig(mid, subject, yawQ(orbitDeg * 1.2)), undefined, { pivot: subject }]]); } });
add({ id: 'dolly-left-reveal', name: 'Slide Reveal', category: 'Cinematic', description: 'Slide sideways with a slight push, like a reveal from behind cover.', duration: 5,
  build: (c, d) => { const { a, m } = units(c); return keys(d, [[0, pose([1.3 * a, 0, 0], [-2, 0, 0], 1.06)], [1, pose([-0.6 * a, 0, 0.7 * m], [1, 0, 0], 1.06)]], 'easeOutQuart'); } });

// Organic
const jitter = (c: PresetContext, d: number, n: number, pos: number, rot: number, seed: number, easing = 'easeInOutSine') => {
  const rnd = mulberry32(seed);
  const s = () => rnd() * 2 - 1;
  const out: K[] = [];
  for (let i = 0; i <= n; i++) {
    const { a, k } = units(c);
    const p = i === 0 || i === n ? [0, 0, 0] : [s() * a * pos, s() * a * pos, s() * a * pos * 0.6];
    out.push([i / n, pose(p as Vec3, [s() * rot * k, s() * rot * k, s() * rot * 0.6 * k], 1.1), easing, { path: 'spline' }]);
  }
  return keys(d, out);
};
add({ id: 'handheld', name: 'Handheld', category: 'Organic', description: 'Natural hand-held camera drift.', duration: 6, build: (c, d) => jitter(c, d, 12, 0.18, 0.5, 7) });
add({ id: 'float', name: 'Floating', category: 'Organic', description: 'Slow dreamy drift in all axes.', duration: 8, build: (c, d) => jitter(c, d, 5, 0.6, 0.8, 21) });
add({ id: 'earthquake', name: 'Earthquake', category: 'Organic', description: 'Violent rapid shake.', duration: 2, build: (c, d) => jitter(c, d, 24, 0.25, 1.4, 3, 'linear') });
add({ id: 'heartbeat', name: 'Heartbeat', category: 'Organic', description: 'Double-pulse zoom, like a heartbeat.', duration: 2,
  build: (_c, d) => keys(d, [[0, pose([0, 0, 0], [0, 0, 0], 1.05), 'easeOutQuad'], [0.1, pose([0, 0, 0], [0, 0, 0], 1.12), 'easeInOutSine'], [0.22, pose([0, 0, 0], [0, 0, 0], 1.06), 'easeOutQuad'], [0.32, pose([0, 0, 0], [0, 0, 0], 1.11), 'easeInOutSine'], [1, pose([0, 0, 0], [0, 0, 0], 1.05)]]) });

export const PRESET_CATEGORIES = [...new Set(PRESETS.map((p) => p.category))];
