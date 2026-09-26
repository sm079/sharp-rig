// Small, allocation-light linear algebra helpers.
// World convention follows SHARP / OpenCV: +x right, +y down, +z forward.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w
export type Mat4 = Float32Array; // column-major

export const DEG = Math.PI / 180;

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  len: (a: Vec3) => Math.hypot(a[0], a[1], a[2]),
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
  dist: (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  clone: (a: Vec3): Vec3 => [a[0], a[1], a[2]],
};

export const quat = {
  identity: (): Quat => [0, 0, 0, 1],
  axisAngle(axis: Vec3, angle: number): Quat {
    const [x, y, z] = v3.norm(axis);
    const s = Math.sin(angle / 2);
    return [x * s, y * s, z * s, Math.cos(angle / 2)];
  },
  mul(a: Quat, b: Quat): Quat {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  },
  conj: (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]],
  norm(q: Quat): Quat {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  },
  rotate(q: Quat, v: Vec3): Vec3 {
    // v' = q v q*
    const [qx, qy, qz, qw] = q;
    const [vx, vy, vz] = v;
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    return [
      vx + qw * tx + (qy * tz - qz * ty),
      vy + qw * ty + (qz * tx - qx * tz),
      vz + qw * tz + (qx * ty - qy * tx),
    ];
  },
  slerp(a: Quat, b: Quat, t: number): Quat {
    let [bx, by, bz, bw] = b;
    let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
    if (cos < 0) {
      cos = -cos;
      bx = -bx; by = -by; bz = -bz; bw = -bw;
    }
    let k0: number, k1: number;
    if (cos > 0.9995) {
      k0 = 1 - t;
      k1 = t;
    } else {
      const theta = Math.acos(cos);
      const s = Math.sin(theta);
      k0 = Math.sin((1 - t) * theta) / s;
      k1 = Math.sin(t * theta) / s;
    }
    return quat.norm([
      a[0] * k0 + bx * k1,
      a[1] * k0 + by * k1,
      a[2] * k0 + bz * k1,
      a[3] * k0 + bw * k1,
    ]);
  },
  /** Camera orientation from yaw (about +y, + = turn right), pitch (+ = look up), roll (about +z), radians. */
  fromEuler(yaw: number, pitch: number, roll: number): Quat {
    const qy = quat.axisAngle([0, 1, 0], yaw);
    const qx = quat.axisAngle([1, 0, 0], pitch);
    const qz = quat.axisAngle([0, 0, 1], roll);
    return quat.norm(quat.mul(quat.mul(qy, qx), qz));
  },
  /** Inverse of fromEuler: returns [yaw, pitch, roll] radians. */
  toEuler(q: Quat): Vec3 {
    const m = quat.toMat3(q); // columns = camera axes (right, down, forward) in world
    const fx = m[6], fy = m[7], fz = m[8];
    const pitch = Math.asin(clamp(-fy, -1, 1));
    const yaw = Math.atan2(fx, fz);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    // right vector expressed in the yaw/pitch frame -> remaining rotation is pure roll
    const ux = cy * m[0] - sy * m[2];
    const uy = m[1];
    const uz = sy * m[0] + cy * m[2];
    const roll = Math.atan2(cp * uy + sp * uz, ux);
    return [yaw, pitch, roll];
  },
  /** 3x3 rotation, column-major array of 9. */
  toMat3(q: Quat): number[] {
    const [x, y, z, w] = q;
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;
    return [
      1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy),
      2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx),
      2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy),
    ];
  },
  /** Orientation whose +z looks toward `dir` with -y as close as possible to `up` (world up = -y). */
  lookRotation(dir: Vec3, up: Vec3 = [0, -1, 0]): Quat {
    const f = v3.norm(dir);
    let r = v3.cross(up, f); // right = up x forward in this handedness gives +x
    r = v3.scale(r, -1);
    if (v3.len(r) < 1e-6) r = [1, 0, 0];
    r = v3.norm(r);
    const d = v3.cross(f, r); // down = forward x right
    return quat.fromMat3([r[0], r[1], r[2], d[0], d[1], d[2], f[0], f[1], f[2]]);
  },
  fromMat3(m: number[]): Quat {
    // column-major m
    const m00 = m[0], m10 = m[1], m20 = m[2];
    const m01 = m[3], m11 = m[4], m21 = m[5];
    const m02 = m[6], m12 = m[7], m22 = m[8];
    const tr = m00 + m11 + m22;
    let x: number, y: number, z: number, w: number;
    if (tr > 0) {
      const s = Math.sqrt(tr + 1) * 2;
      w = 0.25 * s;
      x = (m21 - m12) / s;
      y = (m02 - m20) / s;
      z = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
      const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      w = (m21 - m12) / s;
      x = 0.25 * s;
      y = (m01 + m10) / s;
      z = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      w = (m02 - m20) / s;
      x = (m01 + m10) / s;
      y = 0.25 * s;
      z = (m12 + m21) / s;
    } else {
      const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      w = (m10 - m01) / s;
      x = (m02 + m20) / s;
      y = (m12 + m21) / s;
      z = 0.25 * s;
    }
    return quat.norm([x, y, z, w]);
  },
};

/** World->camera 4x4 (column-major) for a camera at `p` with camera->world rotation `q`. */
export function viewMatrix(p: Vec3, q: Quat): Mat4 {
  const r = quat.toMat3(q); // columns: right, down, forward
  // R^T rows are r's columns
  const out = new Float32Array(16);
  out[0] = r[0]; out[4] = r[1]; out[8] = r[2];
  out[1] = r[3]; out[5] = r[4]; out[9] = r[5];
  out[2] = r[6]; out[6] = r[7]; out[10] = r[8];
  out[12] = -(r[0] * p[0] + r[1] * p[1] + r[2] * p[2]);
  out[13] = -(r[3] * p[0] + r[4] * p[1] + r[5] * p[2]);
  out[14] = -(r[6] * p[0] + r[7] * p[1] + r[8] * p[2]);
  out[15] = 1;
  return out;
}

/**
 * OpenCV-style pinhole projection to WebGL clip space.
 * View space: +x right, +y down, +z forward. fx, fy, cx, cy in pixels.
 */
export function projectionMatrix(
  fx: number, fy: number, w: number, h: number, near = 0.01, far = 1000,
): Mat4 {
  const out = new Float32Array(16);
  out[0] = (2 * fx) / w;
  out[5] = (-2 * fy) / h;
  out[10] = (far + near) / (far - near);
  out[11] = 1;
  out[14] = (-2 * far * near) / (far - near);
  return out;
}

export function mat4Mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  return out;
}

export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
