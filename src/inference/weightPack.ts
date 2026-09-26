// Streaming loader for the int8 weight pack written by tools/export_sharp_onnx.py --int8.
//
// The pack stores SHARP's fp16 external weights as int8 + per-output-channel scales (about half
// the download). It is expanded back into the exact byte layout of `sharp.onnx.data` while it
// downloads, so the compressed file is never held in memory, and the result is handed to
// onnxruntime-web as external data. Downloads are kept in Cache Storage for later visits.

interface RawChunk { kind: 'raw'; off: number; len: number; src: number }
interface Q8Chunk { kind: 'q8'; off: number; len: number; src: number; rows: number; cols: number; axis: 0 | 1 }
type Chunk = RawChunk | Q8Chunk;
interface PackHeader { dataFile: string; dataLength: number; chunks: Chunk[] }

const MAGIC = 'MVSQ8\0\0\0';
const CACHE_NAME = 'sharprig-models-v1';

export interface ExpandedWeights {
  /** file name the .onnx graph references as external data */
  path: string;
  data: Uint8Array;
}

/** True when the pack at `url` was downloaded before and is in Cache Storage. */
export async function isWeightPackCached(url: string): Promise<boolean> {
  try {
    return !!(await (await caches.open(CACHE_NAME)).match(new URL(url, location.href).href));
  } catch {
    return false;
  }
}

/** Byte size of a q8 chunk in the payload: int8 values, pad to 4, float32 scales. */
function q8Size(c: Q8Chunk) {
  const n = c.rows * c.cols;
  return n + ((4 - (n % 4)) % 4) + 4 * (c.axis === 0 ? c.rows : c.cols);
}

const F16 = (globalThis as unknown as { Float16Array?: new (b: ArrayBuffer, o: number, l: number) => { [i: number]: number } }).Float16Array;

// float32 -> float16 bits (round to nearest even), used where Float16Array is unavailable.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalfBits(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | ((mant + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  const half = sign | (exp << 10) | (mant >> 13);
  return (mant & 0x1fff) > 0x1000 || ((mant & 0x1fff) === 0x1000 && half & 1) ? half + 1 : half;
}

function dequantize(c: Q8Chunk, src: Uint8Array, out: Uint8Array) {
  const n = c.rows * c.cols;
  const q = new Int8Array(src.buffer, src.byteOffset, n);
  const scaleOff = src.byteOffset + n + ((4 - (n % 4)) % 4);
  const scales = new Float32Array(src.buffer.slice(scaleOff, scaleOff + 4 * (c.axis === 0 ? c.rows : c.cols)));
  const { rows, cols } = c;
  if (F16) {
    const dst = new F16(out.buffer as ArrayBuffer, out.byteOffset + c.off, n);
    if (c.axis === 0) {
      for (let r = 0, i = 0; r < rows; r++) {
        const s = scales[r];
        for (let k = 0; k < cols; k++, i++) dst[i] = q[i] * s;
      }
    } else {
      for (let r = 0, i = 0; r < rows; r++) for (let k = 0; k < cols; k++, i++) dst[i] = q[i] * scales[k];
    }
  } else {
    const dst = new Uint16Array(out.buffer, out.byteOffset + c.off, n);
    for (let r = 0, i = 0; r < rows; r++)
      for (let k = 0; k < cols; k++, i++) dst[i] = toHalfBits(q[i] * scales[c.axis === 0 ? r : k]);
  }
}

async function openStream(url: string, onProgress: (loaded: number, total: number, cached: boolean) => void) {
  let cache: Cache | null = null;
  try {
    if (/^https?:/.test(url)) cache = await caches.open(CACHE_NAME);
  } catch { /* no Cache Storage (e.g. insecure origin) */ }
  const hit = cache ? await cache.match(url) : undefined;
  let res: Response;
  let cached = false;
  if (hit) {
    res = hit;
    cached = true;
  } else {
    res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Could not download ${url} (${res.status})`);
    if (cache) {
      const [a, b] = res.body.tee();
      cache.put(url, new Response(b, { headers: res.headers })).catch((e) => console.warn('Model not cached:', e));
      res = new Response(a, { headers: res.headers });
    }
  }
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body!.getReader();
  let loaded = 0;
  return {
    async read() {
      const r = await reader.read();
      if (r.value) {
        loaded += r.value.byteLength;
        onProgress(loaded, total, cached);
      }
      return r;
    },
  };
}

export async function loadWeightPack(
  url: string,
  onProgress: (loaded: number, total: number, cached: boolean) => void,
): Promise<ExpandedWeights> {
  const stream = await openStream(url, onProgress);

  // Queue of received bytes not yet consumed.
  let parts: Uint8Array[] = [];
  let available = 0;
  let done = false;
  const pull = async () => {
    const r = await stream.read();
    if (r.done) done = true;
    else { parts.push(r.value); available += r.value.byteLength; }
  };
  /** Take exactly n bytes (copied into `into` if given, else a new array). */
  const take = async (n: number, into?: Uint8Array): Promise<Uint8Array> => {
    while (available < n) {
      if (done) throw new Error('Weight pack is truncated');
      await pull();
    }
    const out = into ?? new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const p = parts[0];
      const k = Math.min(p.byteLength, n - filled);
      out.set(p.subarray(0, k), filled);
      filled += k;
      if (k === p.byteLength) parts.shift();
      else parts[0] = p.subarray(k);
    }
    available -= n;
    return out;
  };

  const prelude = await take(12);
  if (new TextDecoder().decode(prelude.subarray(0, 8)) !== MAGIC) throw new Error('Not an MVSQ8 weight pack');
  const headerLen = new DataView(prelude.buffer).getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(await take(headerLen))) as PackHeader;
  await take((16 - ((12 + headerLen) % 16)) % 16);

  const out = new Uint8Array(header.dataLength);
  let scratch = new Uint8Array(0);
  for (const c of header.chunks) {
    if (c.kind === 'raw') {
      await take(c.len, out.subarray(c.off, c.off + c.len));
    } else {
      const size = q8Size(c);
      if (scratch.byteLength < size) scratch = new Uint8Array(size);
      const src = await take(size, scratch.subarray(0, size));
      dequantize(c, src, out);
    }
  }
  parts = [];
  return { path: header.dataFile, data: out };
}
