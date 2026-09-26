// Reader/writer for 3DGS .ply files, including the SHARP flavour produced by `sharp predict`
// (extra elements: intrinsic, image_size, color_space, ...).

import { covarianceFromScaleRot, linearToSrgb, toByte, type SplatScene } from './scene';

const SH_C0 = 0.28209479177387814;

type PlyType = 'char' | 'uchar' | 'short' | 'ushort' | 'int' | 'uint' | 'float' | 'double';
const TYPE_ALIASES: Record<string, PlyType> = {
  int8: 'char', uint8: 'uchar', int16: 'short', uint16: 'ushort', int32: 'int', uint32: 'uint',
  float32: 'float', float64: 'double', char: 'char', uchar: 'uchar', short: 'short', ushort: 'ushort',
  int: 'int', uint: 'uint', float: 'float', double: 'double',
};
const TYPE_SIZE: Record<PlyType, number> = {
  char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8,
};

interface PlyElement {
  name: string;
  count: number;
  props: { name: string; type: PlyType; offset: number }[];
  stride: number;
}

function readValue(dv: DataView, off: number, t: PlyType): number {
  switch (t) {
    case 'char': return dv.getInt8(off);
    case 'uchar': return dv.getUint8(off);
    case 'short': return dv.getInt16(off, true);
    case 'ushort': return dv.getUint16(off, true);
    case 'int': return dv.getInt32(off, true);
    case 'uint': return dv.getUint32(off, true);
    case 'float': return dv.getFloat32(off, true);
    case 'double': return dv.getFloat64(off, true);
  }
}

export function parsePly(buffer: ArrayBuffer, source = 'ply'): SplatScene {
  const bytes = new Uint8Array(buffer);
  const headerEndToken = 'end_header\n';
  const probe = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const headerEnd = probe.indexOf(headerEndToken);
  if (!probe.startsWith('ply') || headerEnd < 0) throw new Error('Not a PLY file');
  const header = probe.slice(0, headerEnd);
  if (!header.includes('format binary_little_endian')) {
    throw new Error('Only binary little-endian PLY files are supported');
  }
  const elements: PlyElement[] = [];
  for (const raw of header.split('\n')) {
    const parts = raw.trim().split(/\s+/);
    if (parts[0] === 'element') {
      elements.push({ name: parts[1], count: parseInt(parts[2], 10), props: [], stride: 0 });
    } else if (parts[0] === 'property') {
      const el = elements[elements.length - 1];
      if (parts[1] === 'list') throw new Error('PLY list properties are not supported');
      const type = TYPE_ALIASES[parts[1]];
      if (!type) throw new Error(`Unknown PLY type ${parts[1]}`);
      el.props.push({ name: parts[2], type, offset: el.stride });
      el.stride += TYPE_SIZE[type];
    }
  }

  const dv = new DataView(buffer);
  let cursor = headerEnd + headerEndToken.length;
  const elementOffsets = new Map<string, number>();
  for (const el of elements) {
    elementOffsets.set(el.name, cursor);
    cursor += el.count * el.stride;
  }

  const readScalarElement = (name: string): number[] | null => {
    const el = elements.find((e) => e.name === name);
    if (!el || el.props.length !== 1) return null;
    const base = elementOffsets.get(name)!;
    const out: number[] = [];
    for (let i = 0; i < el.count; i++) out.push(readValue(dv, base + i * el.stride, el.props[0].type));
    return out;
  };

  const vertex = elements.find((e) => e.name === 'vertex');
  if (!vertex) throw new Error('PLY has no vertex element');
  const prop = (n: string) => vertex.props.find((p) => p.name === n);
  const required = ['x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  for (const r of required) if (!prop(r)) throw new Error(`Not a Gaussian splat PLY (missing ${r})`);
  const hasDc = !!prop('f_dc_0');
  const hasRgb = !!prop('red');

  // Colour space: SHARP writes 0=sRGB, 1=linearRGB. Default for generic 3DGS is "treat as sRGB".
  const cs = readScalarElement('color_space');
  const isLinear = cs ? cs[0] === 1 : false;

  const n = vertex.count;
  const positions = new Float32Array(n * 3);
  const covariances = new Float32Array(n * 6);
  const colors = new Uint8Array(n * 4);
  const base = elementOffsets.get('vertex')!;
  const off = (name: string) => prop(name)!.offset;
  const typ = (name: string) => prop(name)!.type;
  const allFloat = required.every((r) => typ(r) === 'float') && (!hasDc || typ('f_dc_0') === 'float');

  const oX = off('x'), oY = off('y'), oZ = off('z'), oOp = off('opacity');
  const oS0 = off('scale_0'), oS1 = off('scale_1'), oS2 = off('scale_2');
  const oR0 = off('rot_0'), oR1 = off('rot_1'), oR2 = off('rot_2'), oR3 = off('rot_3');
  const oD0 = hasDc ? off('f_dc_0') : 0, oD1 = hasDc ? off('f_dc_1') : 0, oD2 = hasDc ? off('f_dc_2') : 0;
  const f = (o: number, name: string) => (allFloat ? dv.getFloat32(o, true) : readValue(dv, o, typ(name)));

  for (let i = 0; i < n; i++) {
    const b = base + i * vertex.stride;
    positions[i * 3] = f(b + oX, 'x');
    positions[i * 3 + 1] = f(b + oY, 'y');
    positions[i * 3 + 2] = f(b + oZ, 'z');
    covarianceFromScaleRot(
      Math.exp(f(b + oS0, 'scale_0')), Math.exp(f(b + oS1, 'scale_1')), Math.exp(f(b + oS2, 'scale_2')),
      f(b + oR0, 'rot_0'), f(b + oR1, 'rot_1'), f(b + oR2, 'rot_2'), f(b + oR3, 'rot_3'),
      covariances, i * 6,
    );
    let r = 0.5, g = 0.5, bl = 0.5;
    if (hasDc) {
      r = 0.5 + SH_C0 * f(b + oD0, 'f_dc_0');
      g = 0.5 + SH_C0 * f(b + oD1, 'f_dc_1');
      bl = 0.5 + SH_C0 * f(b + oD2, 'f_dc_2');
    } else if (hasRgb) {
      r = readValue(dv, b + off('red'), typ('red')) / 255;
      g = readValue(dv, b + off('green'), typ('green')) / 255;
      bl = readValue(dv, b + off('blue'), typ('blue')) / 255;
    }
    if (isLinear) {
      r = linearToSrgb(Math.max(0, r)); g = linearToSrgb(Math.max(0, g)); bl = linearToSrgb(Math.max(0, bl));
    }
    colors[i * 4] = toByte(r);
    colors[i * 4 + 1] = toByte(g);
    colors[i * 4 + 2] = toByte(bl);
    colors[i * 4 + 3] = toByte(1 / (1 + Math.exp(-f(b + oOp, 'opacity'))));
  }

  // Intrinsics / image size (SHARP metadata). Fall back to SHARP's VGA default.
  let imageWidth = 640, imageHeight = 480, focalPx = 512;
  const intr = readScalarElement('intrinsic');
  const size = readScalarElement('image_size');
  if (intr && size && intr.length === 9) {
    focalPx = intr[0];
    imageWidth = size[0];
    imageHeight = size[1];
  } else if (intr && intr.length === 4) {
    focalPx = intr[0];
    imageWidth = intr[2];
    imageHeight = intr[3];
  }

  return { count: n, positions, covariances, colors, imageWidth, imageHeight, focalPx, source };
}

/**
 * Export a scene as a standard 3DGS ply (SHARP-compatible metadata). Covariances are
 * eigen-decomposed back into scale + rotation.
 */
export function writePly(scene: SplatScene): Blob {
  const n = scene.count;
  const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  let header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n`;
  for (const p of props) header += `property float ${p}\n`;
  header += 'element intrinsic 9\nproperty float intrinsic\n';
  header += 'element image_size 2\nproperty uint image_size\n';
  header += 'element color_space 1\nproperty uchar color_space\n';
  header += 'end_header\n';
  const headerBytes = new TextEncoder().encode(header);
  const body = new ArrayBuffer(n * props.length * 4 + 9 * 4 + 2 * 4 + 1);
  const dv = new DataView(body);
  let o = 0;
  const w = (x: number) => { dv.setFloat32(o, x, true); o += 4; };
  const eig = new Float64Array(12);
  for (let i = 0; i < n; i++) {
    w(scene.positions[i * 3]); w(scene.positions[i * 3 + 1]); w(scene.positions[i * 3 + 2]);
    for (let c = 0; c < 3; c++) w((scene.colors[i * 4 + c] / 255 - 0.5) / SH_C0);
    const a = Math.min(0.9999, Math.max(1e-4, scene.colors[i * 4 + 3] / 255));
    w(Math.log(a / (1 - a)));
    symmetricEigen(scene.covariances, i * 6, eig);
    for (let c = 0; c < 3; c++) w(Math.log(Math.sqrt(Math.max(eig[c], 1e-14))));
    const q = rotationToQuatWxyz(eig);
    w(q[0]); w(q[1]); w(q[2]); w(q[3]);
  }
  const intr = [scene.focalPx, 0, scene.imageWidth / 2, 0, scene.focalPx, scene.imageHeight / 2, 0, 0, 1];
  for (const x of intr) w(x);
  dv.setUint32(o, scene.imageWidth, true); o += 4;
  dv.setUint32(o, scene.imageHeight, true); o += 4;
  dv.setUint8(o, 0); // sRGB
  return new Blob([headerBytes, body], { type: 'application/octet-stream' });
}

/** Jacobi eigen-decomposition of a symmetric 3x3. out[0..2] = eigenvalues, out[3..11] = eigenvectors (columns). */
function symmetricEigen(cov: Float32Array, o: number, out: Float64Array) {
  const a = [
    [cov[o], cov[o + 1], cov[o + 2]],
    [cov[o + 1], cov[o + 3], cov[o + 4]],
    [cov[o + 2], cov[o + 4], cov[o + 5]],
  ];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 12; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-20) break;
    for (let p = 0; p < 2; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  out[0] = a[0][0]; out[1] = a[1][1]; out[2] = a[2][2];
  // ensure right-handed basis
  const det =
    v[0][0] * (v[1][1] * v[2][2] - v[1][2] * v[2][1]) -
    v[0][1] * (v[1][0] * v[2][2] - v[1][2] * v[2][0]) +
    v[0][2] * (v[1][0] * v[2][1] - v[1][1] * v[2][0]);
  if (det < 0) for (let k = 0; k < 3; k++) v[k][2] = -v[k][2];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[3 + c * 3 + r] = v[r][c];
}

function rotationToQuatWxyz(e: Float64Array): [number, number, number, number] {
  // columns at e[3..], rotation matrix m[r][c] = e[3 + c*3 + r]
  const m = (r: number, c: number) => e[3 + c * 3 + r];
  const tr = m(0, 0) + m(1, 1) + m(2, 2);
  let w: number, x: number, y: number, z: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (m(2, 1) - m(1, 2)) / s; y = (m(0, 2) - m(2, 0)) / s; z = (m(1, 0) - m(0, 1)) / s;
  } else if (m(0, 0) > m(1, 1) && m(0, 0) > m(2, 2)) {
    const s = Math.sqrt(1 + m(0, 0) - m(1, 1) - m(2, 2)) * 2;
    w = (m(2, 1) - m(1, 2)) / s; x = 0.25 * s; y = (m(0, 1) + m(1, 0)) / s; z = (m(0, 2) + m(2, 0)) / s;
  } else if (m(1, 1) > m(2, 2)) {
    const s = Math.sqrt(1 + m(1, 1) - m(0, 0) - m(2, 2)) * 2;
    w = (m(0, 2) - m(2, 0)) / s; x = (m(0, 1) + m(1, 0)) / s; y = 0.25 * s; z = (m(1, 2) + m(2, 1)) / s;
  } else {
    const s = Math.sqrt(1 + m(2, 2) - m(0, 0) - m(1, 1)) * 2;
    w = (m(1, 0) - m(0, 1)) / s; x = (m(0, 2) + m(2, 0)) / s; y = (m(1, 2) + m(2, 1)) / s; z = 0.25 * s;
  }
  return [w, x, y, z];
}
