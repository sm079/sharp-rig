import type { SplatScene } from '../splat/scene';

/**
 * Global crop applied on top of every pose's zoom. A single photo only covers its own frustum,
 * so any camera translation exposes its edges; a little overscan hides them (viewport + export).
 */
export const lensSettings = { overscan: 1.08 };

/**
 * Focal length (output pixels) for an output frame of outW x outH. At zoom = 1 the output
 * frustum is the largest one with the output aspect that fits inside the source photo's
 * frustum (i.e. a centre crop), so no empty borders appear for the unmoved camera.
 */
export function outputFocal(scene: Pick<SplatScene, 'imageWidth' | 'imageHeight' | 'focalPx'>, outW: number, outH: number, zoom: number) {
  const tanX = scene.imageWidth / (2 * scene.focalPx);
  const tanY = scene.imageHeight / (2 * scene.focalPx);
  const tanYo = Math.min(tanY, (tanX * outH) / outW);
  return (outH / (2 * tanYo)) * zoom * lensSettings.overscan;
}
