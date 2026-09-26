// Director (observer) view: a free orbit camera looking at the scene from outside, plus line
// geometry for the source camera, the motion path, keyframe frustums, pivots and arms.

import { DEG, quat, v3, type Vec3 } from '../math';
import { outputFocal } from '../camera/lens';
import { evaluate, identityPose, type Motion, type Pose } from '../motion/timeline';
import type { SplatScene } from '../splat/scene';

type RGBA = [number, number, number, number];

export class ObserverCamera {
  yaw = -35 * DEG;
  pitch = -28 * DEG;
  dist = 6;
  target: Vec3 = [0, 0, 3];

  frame(focusDepth: number) {
    this.target = [0, 0, focusDepth];
    this.dist = focusDepth * 2.2;
  }

  pose(): Pose {
    const rot = quat.fromEuler(this.yaw, this.pitch, 0);
    const back = quat.rotate(rot, [0, 0, -this.dist]);
    return { position: v3.add(this.target, back), rotation: rot, zoom: 1 };
  }

  orbit(dx: number, dy: number) {
    this.yaw += dx * 0.005;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - dy * 0.005));
  }

  pan(dx: number, dy: number) {
    const k = this.dist * 0.0015;
    this.target = v3.add(this.target, quat.rotate(this.pose().rotation, [-dx * k, -dy * k, 0]));
  }

  zoom(steps: number) {
    this.dist *= Math.pow(1.1, steps);
  }
}

export interface OverlayInput {
  scene: SplatScene;
  width: number;
  height: number;
  focusDepth: number;
  motion: Motion;
  selectedKey: string | null;
  live: Pose;
  pivot: Vec3 | null;
}

function pushLine(out: number[], a: Vec3, b: Vec3, c: RGBA, c2 = c) {
  out.push(a[0], a[1], a[2], c[0], c[1], c[2], c[3], b[0], b[1], b[2], c2[0], c2[1], c2[2], c2[3]);
}

function frustumLines(out: number[], inp: OverlayInput, pose: Pose, size: number, color: RGBA) {
  const { width: w, height: h } = inp;
  const f = outputFocal(inp.scene, w, h, pose.zoom);
  const hx = (w / 2 / f) * size, hy = (h / 2 / f) * size;
  const corners = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([x, y]) =>
    v3.add(pose.position, quat.rotate(pose.rotation, [x, y, size])),
  );
  for (let i = 0; i < 4; i++) {
    pushLine(out, pose.position, corners[i], color);
    pushLine(out, corners[i], corners[(i + 1) % 4], color);
  }
  // "up" tick so roll is visible
  const up = v3.add(pose.position, quat.rotate(pose.rotation, [0, -hy * 1.5, size]));
  pushLine(out, corners[0], up, color);
  pushLine(out, up, corners[1], color);
}

function crossLines(out: number[], p: Vec3, s: number, c: RGBA) {
  pushLine(out, [p[0] - s, p[1], p[2]], [p[0] + s, p[1], p[2]], c);
  pushLine(out, [p[0], p[1] - s, p[2]], [p[0], p[1] + s, p[2]], c);
  pushLine(out, [p[0], p[1], p[2] - s], [p[0], p[1], p[2] + s], c);
}

export function directorOverlay(inp: OverlayInput): Float32Array {
  const out: number[] = [];
  const F = inp.focusDepth;
  const m = inp.motion;
  // source photo camera
  frustumLines(out, inp, identityPose(), F * 0.1, [0.55, 0.6, 0.7, 0.6]);
  // path
  if (m.keyframes.length > 1) {
    const N = 240;
    let prev: Vec3 | null = null;
    for (let i = 0; i <= N; i++) {
      const p = evaluate(m, (i / N) * m.duration)!.position;
      const t = i / N;
      if (prev) pushLine(out, prev, p, [0.96, 0.71 - 0.3 * t, 0.26 + 0.4 * t, 1]);
      prev = p;
    }
  }
  for (const k of m.keyframes) {
    frustumLines(out, inp, k.pose, F * 0.06, k.id === inp.selectedKey ? [1, 1, 1, 1] : [0.96, 0.71, 0.26, 0.8]);
    if (k.pivot) {
      crossLines(out, k.pivot, F * 0.03, [1, 0.44, 0.68, 1]);
      pushLine(out, k.pivot, k.pose.position, [1, 0.44, 0.68, 0.35]);
    }
  }
  // live camera
  frustumLines(out, inp, inp.live, F * 0.12, [0.35, 0.66, 1, 1]);
  if (inp.pivot) {
    crossLines(out, inp.pivot, F * 0.05, [1, 0.44, 0.68, 1]);
    pushLine(out, inp.pivot, inp.live.position, [1, 0.44, 0.68, 1]);
  }
  return new Float32Array(out);
}
