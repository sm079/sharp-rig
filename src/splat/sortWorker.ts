// Depth-sorts splats back-to-front for a given view using a 16-bit counting sort.

let positions: Float32Array | null = null;
let count = 0;
let depthKeys = new Int32Array(0);
let counts = new Uint32Array(65536);
let starts = new Uint32Array(65536);

interface SortRequest {
  type: 'sort';
  id: number;
  /** third row of the world->camera matrix: depth = r0*x + r1*y + r2*z + r3 */
  row: [number, number, number, number];
}
interface SetRequest {
  type: 'positions';
  positions: Float32Array;
  count: number;
}

self.onmessage = (e: MessageEvent<SortRequest | SetRequest>) => {
  const msg = e.data;
  if (msg.type === 'positions') {
    positions = msg.positions;
    count = msg.count;
    depthKeys = new Int32Array(count);
    return;
  }
  if (!positions) return;
  const [r0, r1, r2, r3] = msg.row;
  const near = 1e-3;
  let minD = Infinity, maxD = -Infinity;
  let visible = 0;
  const depths = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const d = r0 * positions[i * 3] + r1 * positions[i * 3 + 1] + r2 * positions[i * 3 + 2] + r3;
    depths[i] = d;
    if (d > near) {
      visible++;
      if (d < minD) minD = d;
      if (d > maxD) maxD = d;
    }
  }
  const indices = new Uint32Array(visible);
  if (visible > 0) {
    // Sort on inverse depth: more resolution near the camera where ordering matters most.
    const invMin = 1 / maxD, invMax = 1 / minD;
    const scale = 65535 / Math.max(1e-12, invMax - invMin);
    counts.fill(0);
    for (let i = 0; i < count; i++) {
      const d = depths[i];
      if (d > near) {
        // far (small inverse depth) first => key ascending = back-to-front
        const k = Math.min(65535, Math.max(0, ((1 / d - invMin) * scale) | 0));
        depthKeys[i] = k;
        counts[k]++;
      } else depthKeys[i] = -1;
    }
    starts[0] = 0;
    for (let k = 1; k < 65536; k++) starts[k] = starts[k - 1] + counts[k - 1];
    for (let i = 0; i < count; i++) {
      const k = depthKeys[i];
      if (k >= 0) indices[starts[k]++] = i;
    }
  }
  (self as unknown as Worker).postMessage({ id: msg.id, indices, visible }, [indices.buffer]);
};
