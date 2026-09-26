// In-memory Gaussian scene in SHARP/OpenCV world coordinates (metric, camera at origin looking +z).

export interface SplatScene {
  count: number;
  /** xyz per splat */
  positions: Float32Array;
  /** Upper triangle of 3D covariance per splat: xx, xy, xz, yy, yz, zz */
  covariances: Float32Array;
  /** sRGB RGBA8 per splat (alpha = opacity) */
  colors: Uint8Array;
  /** Source image metadata used to reproduce the original camera. */
  imageWidth: number;
  imageHeight: number;
  focalPx: number;
  /** Where the scene came from, for display only. */
  source: string;
}

export interface SceneStats {
  /** ~10% depth quantile: the "near" content that limits parallax. */
  nearDepth: number;
  /** median depth: default subject / focus distance. */
  focusDepth: number;
  /** ~90% depth quantile. */
  farDepth: number;
  /** SHARP-style max lateral camera offset (metres) that keeps disparity ~8%. */
  lateralUnit: number;
  /** SHARP-style max forward offset. */
  medialUnit: number;
}

export function computeStats(scene: SplatScene): SceneStats {
  const n = scene.count;
  const step = Math.max(1, Math.floor(n / 50000));
  const zs: number[] = [];
  for (let i = 0; i < n; i += step) {
    const z = scene.positions[i * 3 + 2];
    if (z > 0 && scene.colors[i * 4 + 3] > 20) zs.push(z);
  }
  zs.sort((a, b) => a - b);
  const q = (t: number) => (zs.length ? zs[Math.min(zs.length - 1, Math.floor(t * zs.length))] : 1);
  const nearDepth = q(0.1);
  const focusDepth = q(0.5);
  const farDepth = q(0.9);
  const diag = Math.hypot(scene.imageWidth / scene.focalPx, scene.imageHeight / scene.focalPx);
  // Mirrors sharp.utils.camera.compute_max_offset (max_disparity=0.08, max_zoom=0.15).
  const lateralUnit = 0.08 * diag * nearDepth;
  const medialUnit = 0.15 * nearDepth;
  return { nearDepth, focusDepth, farDepth, lateralUnit, medialUnit };
}

/** Build covariance (upper triangle) from scale (std-dev) and rotation quaternion (w,x,y,z). */
export function covarianceFromScaleRot(
  sx: number, sy: number, sz: number,
  qw: number, qx: number, qy: number, qz: number,
  out: Float32Array, o: number,
) {
  const l = Math.hypot(qw, qx, qy, qz) || 1;
  qw /= l; qx /= l; qy /= l; qz /= l;
  // Rotation matrix (row-major)
  const r00 = 1 - 2 * (qy * qy + qz * qz), r01 = 2 * (qx * qy - qw * qz), r02 = 2 * (qx * qz + qw * qy);
  const r10 = 2 * (qx * qy + qw * qz), r11 = 1 - 2 * (qx * qx + qz * qz), r12 = 2 * (qy * qz - qw * qx);
  const r20 = 2 * (qx * qz - qw * qy), r21 = 2 * (qy * qz + qw * qx), r22 = 1 - 2 * (qx * qx + qy * qy);
  // M = R * S
  const m00 = r00 * sx, m01 = r01 * sy, m02 = r02 * sz;
  const m10 = r10 * sx, m11 = r11 * sy, m12 = r12 * sz;
  const m20 = r20 * sx, m21 = r21 * sy, m22 = r22 * sz;
  out[o] = m00 * m00 + m01 * m01 + m02 * m02;
  out[o + 1] = m00 * m10 + m01 * m11 + m02 * m12;
  out[o + 2] = m00 * m20 + m01 * m21 + m02 * m22;
  out[o + 3] = m10 * m10 + m11 * m11 + m12 * m12;
  out[o + 4] = m10 * m20 + m11 * m21 + m12 * m22;
  out[o + 5] = m20 * m20 + m21 * m21 + m22 * m22;
}

export const linearToSrgb = (x: number) =>
  x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;

export const toByte = (x: number) => (x <= 0 ? 0 : x >= 1 ? 255 : Math.round(x * 255));
