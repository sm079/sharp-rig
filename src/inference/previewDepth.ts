// Model-free fallback: lifts the image into Gaussians using a heuristic depth prior.
// This is NOT SHARP. It exists so the motion editor and exporter can be used before the
// SHARP ONNX weights are available (or on devices without WebGPU).

import { rasterize, type LoadedImage } from './image';
import { covarianceFromScaleRot, type SplatScene } from '../splat/scene';

export function buildPreviewScene(img: LoadedImage, maxSide = 900): SplatScene {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(2, Math.round(img.width * s));
  const h = Math.max(2, Math.round(img.height * s));
  const px = rasterize(img.bitmap, w, h);
  const f = img.focalPx * (w / img.width);

  // Luminance, blurred luminance -> crude "saliency" used to pull subjects forward.
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
  const blur = boxBlur(boxBlur(lum, w, h, Math.max(2, Math.round(w / 40))), w, h, Math.max(2, Math.round(w / 40)));
  const detail = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) detail[i] = Math.abs(lum[i] - blur[i]);
  const detailBlur = boxBlur(boxBlur(detail, w, h, Math.round(w / 25)), w, h, Math.round(w / 25));
  let maxDetail = 1e-6;
  for (let i = 0; i < w * h; i++) maxDetail = Math.max(maxDetail, detailBlur[i]);

  const baseDepth = 3.0;
  const n = w * h;
  const positions = new Float32Array(n * 3);
  const covariances = new Float32Array(n * 6);
  const colors = new Uint8Array(n * 4);
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = x / (w - 1);
      // Ground-plane-ish gradient (top of frame farther), centre-weighted subject bulge,
      // and textured regions nudged forward.
      const r2 = (u - 0.5) ** 2 + (v - 0.55) ** 2;
      const bulge = Math.exp(-r2 / 0.06);
      const sal = detailBlur[i] / maxDetail;
      const depth = baseDepth * (1 + 0.9 * (1 - v) ** 1.5) * (1 - 0.28 * bulge - 0.18 * sal);
      const X = ((x + 0.5 - w / 2) / f) * depth;
      const Y = ((y + 0.5 - h / 2) / f) * depth;
      positions[i * 3] = X;
      positions[i * 3 + 1] = Y;
      positions[i * 3 + 2] = depth;
      const sigma = (0.62 * depth) / f;
      covarianceFromScaleRot(sigma, sigma, sigma * 0.4, 1, 0, 0, 0, covariances, i * 6);
      colors[i * 4] = px[i * 4];
      colors[i * 4 + 1] = px[i * 4 + 1];
      colors[i * 4 + 2] = px[i * 4 + 2];
      colors[i * 4 + 3] = 255;
    }
  }
  return {
    count: n, positions, covariances, colors,
    imageWidth: img.width, imageHeight: img.height, focalPx: img.focalPx,
    source: 'Preview depth (heuristic, not SHARP)',
  };
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  r = Math.max(1, r);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * r + 1);
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}
