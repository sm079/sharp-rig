// WebGL2 Gaussian-splat renderer with an OpenCV pinhole camera model.

import { mat4Mul, projectionMatrix, viewMatrix, type Quat, type Vec3 } from '../math';
import type { SplatScene } from './scene';
import SortWorker from './sortWorker?worker';

export interface RenderCamera {
  position: Vec3;
  rotation: Quat;
  /** focal length in output pixels */
  fx: number;
  fy: number;
}

/** Line overlay vertices: x,y,z,r,g,b,a per vertex (pairs form segments). */
export type LineList = Float32Array;

const SPLATS_PER_ROW = 1024;
const TEXELS_PER_SPLAT = 3;

const SPLAT_VS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D u_data;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform vec2 u_focal;
uniform vec2 u_viewport;

in vec2 a_corner;
in uint a_index;

out vec4 v_color;
out vec2 v_pos;

void main() {
  ivec2 base = ivec2(int(a_index % ${SPLATS_PER_ROW}u) * ${TEXELS_PER_SPLAT}, int(a_index / ${SPLATS_PER_ROW}u));
  uvec4 t0 = texelFetch(u_data, base, 0);
  uvec4 t1 = texelFetch(u_data, base + ivec2(1, 0), 0);
  uvec4 t2 = texelFetch(u_data, base + ivec2(2, 0), 0);

  vec3 center = uintBitsToFloat(t0.xyz);
  vec4 cam = u_view * vec4(center, 1.0);
  vec4 clip = u_proj * cam;
  float clipBound = 1.25 * clip.w;
  if (cam.z <= 0.01 || clip.x < -clipBound || clip.x > clipBound || clip.y < -clipBound || clip.y > clipBound) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  vec4 c1 = uintBitsToFloat(t1);
  vec2 c2 = uintBitsToFloat(t2.xy);
  mat3 Vrk = mat3(c1.x, c1.y, c1.z,
                  c1.y, c1.w, c2.x,
                  c1.z, c2.x, c2.y);

  float z = cam.z;
  mat3 J = mat3(u_focal.x / z, 0.0, 0.0,
                0.0, u_focal.y / z, 0.0,
                -u_focal.x * cam.x / (z * z), -u_focal.y * cam.y / (z * z), 0.0);
  mat3 W = mat3(u_view);
  mat3 T = J * W;
  mat3 cov2d = T * Vrk * transpose(T);

  // Low-pass filter (anti-aliasing) of 0.3 px^2.
  float a = cov2d[0][0] + 0.3;
  float b = cov2d[0][1];
  float d = cov2d[1][1] + 0.3;
  float mid = 0.5 * (a + d);
  float radius = length(vec2(0.5 * (a - d), b));
  float lambda1 = mid + radius;
  float lambda2 = max(mid - radius, 0.1);
  if (lambda2 < 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec2 diag = normalize(abs(b) < 1e-8 && a >= d ? vec2(1.0, 0.0) : (abs(b) < 1e-8 ? vec2(0.0, 1.0) : vec2(b, lambda1 - a)));
  float r1 = min(3.0 * sqrt(lambda1), 2048.0);
  float r2 = min(3.0 * sqrt(lambda2), 2048.0);
  vec2 majorAxis = r1 * diag;
  vec2 minorAxis = r2 * vec2(diag.y, -diag.x);

  uint rgba = t0.w;
  v_color = vec4(float(rgba & 0xffu), float((rgba >> 8) & 0xffu), float((rgba >> 16) & 0xffu), float(rgba >> 24)) / 255.0;
  v_pos = a_corner * 3.0; // in units of sigma

  vec2 ndc = clip.xy / clip.w;
  vec2 offsetPx = a_corner.x * majorAxis + a_corner.y * minorAxis;
  // pixel space is y-down; NDC is y-up
  vec2 offsetNdc = vec2(offsetPx.x, -offsetPx.y) * 2.0 / u_viewport;
  gl_Position = vec4(ndc + offsetNdc, clip.z / clip.w, 1.0);
}
`;

const SPLAT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_pos;
out vec4 fragColor;
void main() {
  float r2 = dot(v_pos, v_pos);
  if (r2 > 9.0) discard;
  float alpha = v_color.a * exp(-0.5 * r2);
  if (alpha < 1.0 / 255.0) discard;
  fragColor = vec4(v_color.rgb * alpha, alpha);
}
`;

const LINE_VS = /* glsl */ `#version 300 es
precision highp float;
uniform mat4 u_viewProj;
in vec3 a_pos;
in vec4 a_color;
out vec4 v_color;
void main() {
  v_color = a_color;
  gl_Position = u_viewProj * vec4(a_pos, 1.0);
}
`;
const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() { fragColor = vec4(v_color.rgb * v_color.a, v_color.a); }
`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
  return p;
}

export class SplatRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private splatProgram: WebGLProgram;
  private lineProgram: WebGLProgram;
  private splatVao: WebGLVertexArrayObject;
  private lineVao: WebGLVertexArrayObject;
  private indexBuffer: WebGLBuffer;
  private lineBuffer: WebGLBuffer;
  private texture: WebGLTexture | null = null;
  private worker: Worker;
  private scene: SplatScene | null = null;
  private visible = 0;
  private sortId = 0;
  private sortPending = false;
  private lastSortRow: number[] | null = null;
  private queuedRow: [number, number, number, number] | null = null;
  private sortWaiters = new Map<number, () => void>();
  background: [number, number, number] = [0, 0, 0];
  /** Called when an async sort lands, so the owner can redraw. */
  onSortComplete: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      alpha: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.splatProgram = compile(gl, SPLAT_VS, SPLAT_FS);
    this.lineProgram = compile(gl, LINE_VS, LINE_FS);

    this.splatVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.splatVao);
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    const aCorner = gl.getAttribLocation(this.splatProgram, 'a_corner');
    gl.enableVertexAttribArray(aCorner);
    gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);
    this.indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
    const aIndex = gl.getAttribLocation(this.splatProgram, 'a_index');
    gl.enableVertexAttribArray(aIndex);
    gl.vertexAttribIPointer(aIndex, 1, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(aIndex, 1);
    const ebo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.lineVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.lineVao);
    this.lineBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    const aPos = gl.getAttribLocation(this.lineProgram, 'a_pos');
    const aCol = gl.getAttribLocation(this.lineProgram, 'a_color');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(aCol);
    gl.vertexAttribPointer(aCol, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);

    this.worker = new SortWorker();
    this.worker.onmessage = (e: MessageEvent<{ id: number; indices: Uint32Array; visible: number }>) => {
      const { id, indices, visible } = e.data;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);
      this.visible = visible;
      this.sortPending = false;
      const waiter = this.sortWaiters.get(id);
      if (waiter) {
        this.sortWaiters.delete(id);
        waiter();
      }
      if (this.queuedRow) {
        const row = this.queuedRow;
        this.queuedRow = null;
        this.requestSort(row);
      }
      this.onSortComplete?.();
    };
  }

  setScene(scene: SplatScene) {
    const gl = this.gl;
    this.scene = scene;
    const rows = Math.ceil(scene.count / SPLATS_PER_ROW);
    const width = SPLATS_PER_ROW * TEXELS_PER_SPLAT;
    const data = new Uint32Array(width * rows * 4);
    const f = new Float32Array(data.buffer);
    const colors32 = new Uint32Array(scene.colors.buffer, scene.colors.byteOffset, scene.count);
    for (let i = 0; i < scene.count; i++) {
      const o = i * TEXELS_PER_SPLAT * 4;
      f[o] = scene.positions[i * 3];
      f[o + 1] = scene.positions[i * 3 + 1];
      f[o + 2] = scene.positions[i * 3 + 2];
      data[o + 3] = colors32[i];
      const c = i * 6;
      f[o + 4] = scene.covariances[c];
      f[o + 5] = scene.covariances[c + 1];
      f[o + 6] = scene.covariances[c + 2];
      f[o + 7] = scene.covariances[c + 3];
      f[o + 8] = scene.covariances[c + 4];
      f[o + 9] = scene.covariances[c + 5];
    }
    if (this.texture) gl.deleteTexture(this.texture);
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, width, rows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, data);
    this.visible = 0;
    this.lastSortRow = null;
    this.worker.postMessage({ type: 'positions', positions: scene.positions.slice(), count: scene.count });
  }

  private sortRow(cam: RenderCamera): [number, number, number, number] {
    const v = viewMatrix(cam.position, cam.rotation);
    return [v[2], v[6], v[10], v[14]];
  }

  private requestSort(row: [number, number, number, number]): number {
    if (this.sortPending) {
      this.queuedRow = row;
      return -1;
    }
    this.sortPending = true;
    this.lastSortRow = row;
    const id = ++this.sortId;
    this.worker.postMessage({ type: 'sort', id, row });
    return id;
  }

  private needsSort(row: number[]) {
    const l = this.lastSortRow;
    if (!l) return true;
    const dDir = Math.abs(l[0] - row[0]) + Math.abs(l[1] - row[1]) + Math.abs(l[2] - row[2]);
    return dDir > 1e-4 || Math.abs(l[3] - row[3]) > 1e-4;
  }

  /** Draw with the most recent sort; kicks off a background re-sort if the view moved. */
  render(cam: RenderCamera, lines?: LineList) {
    if (this.scene) {
      const row = this.sortRow(cam);
      if (this.needsSort(row)) this.requestSort(row);
    }
    this.draw(cam, lines);
  }

  /** Sort synchronously for this exact camera, then draw. Used for deterministic video frames. */
  async renderExact(cam: RenderCamera): Promise<void> {
    if (this.scene) {
      const row = this.sortRow(cam);
      // Wait for any in-flight sort, then issue ours.
      while (this.sortPending) await new Promise<void>((r) => setTimeout(r, 1));
      this.queuedRow = null;
      const id = this.requestSort(row);
      await new Promise<void>((resolve) => this.sortWaiters.set(id, resolve));
    }
    this.draw(cam);
    this.gl.finish();
  }

  private draw(cam: RenderCamera, lines?: LineList) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(this.background[0], this.background[1], this.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const view = viewMatrix(cam.position, cam.rotation);
    const proj = projectionMatrix(cam.fx, cam.fy, w, h, 0.01, 10000);
    gl.disable(gl.DEPTH_TEST);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    if (this.scene && this.texture && this.visible > 0) {
      gl.useProgram(this.splatProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(gl.getUniformLocation(this.splatProgram, 'u_data'), 0);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.splatProgram, 'u_view'), false, view);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.splatProgram, 'u_proj'), false, proj);
      gl.uniform2f(gl.getUniformLocation(this.splatProgram, 'u_focal'), cam.fx, cam.fy);
      gl.uniform2f(gl.getUniformLocation(this.splatProgram, 'u_viewport'), w, h);
      gl.bindVertexArray(this.splatVao);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.visible);
      gl.bindVertexArray(null);
    }

    if (lines && lines.length) {
      gl.useProgram(this.lineProgram);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProgram, 'u_viewProj'), false, mat4Mul(proj, view));
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, lines, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINES, 0, lines.length / 7);
      gl.bindVertexArray(null);
    }
  }

  resize(width: number, height: number) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  dispose() {
    this.worker.terminate();
    if (this.texture) this.gl.deleteTexture(this.texture);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
