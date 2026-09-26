// The Studio is the UI-agnostic engine: it owns the scene, the SHARP model, the camera rig, the
// motion being edited, playback, auto-keying, undo, the render loop and export. It knows nothing
// about panels, buttons or layout; a UI calls its methods and listens to its typed events.
//
// The Studio owns its <canvas>. A UI provides a host element via `mount()`: the canvas fills it,
// and the output frame (the shot) is a centred rect inside it, see `outputRect()`. Camera input
// is bound to the canvas itself.

import { DEG, quat, v3, type Vec3 } from '../math';
import { SplatRenderer, type RenderCamera } from '../splat/renderer';
import { computeStats, type SceneStats, type SplatScene } from '../splat/scene';
import { parsePly, writePly } from '../splat/ply';
import { loadImage, type LoadedImage } from '../inference/image';
import { buildPreviewScene } from '../inference/previewDepth';
import { SharpModel, SharpStalledError, type ModelSource } from '../inference/sharp';
import { CameraController, type ControlMode, type PivotPlacement } from '../camera/controller';
import { outputFocal } from '../camera/lens';
import { cloneEasing, type EasingSpec } from '../motion/easing';
import {
  clonePose, cloneMotion, evaluate, evaluatePivot, identityPose, makeKeyframe, sortKeyframes,
  type Keyframe, type Motion, type PathMode, type Pose,
} from '../motion/timeline';
import { PRESETS, PRESET_CATEGORIES, type Preset } from '../motion/presets';
import { exportVideo } from '../export/video';
import sampleUrl from '../assets/sample.jpg';
import { Emitter } from './emitter';
import { ObserverCamera, directorOverlay } from './director';
import {
  SAVED_CATEGORY, denormaliseMotion, loadSaved, normaliseMotion, savedAsPresets, storeSaved, type SavedMotion,
} from './library';

export type ViewMode = 'camera' | 'director';
export type ModelState = 'idle' | 'busy' | 'ok' | 'err';
export interface ModelStatus { state: ModelState; text: string; percent: number | null }
export interface Notice { message: string; kind: 'info' | 'error' }
/** The output frame inside the viewport canvas, in CSS pixels relative to the canvas. */
export interface OutputRect { x: number; y: number; width: number; height: number }
export interface PivotScreen { x: number; y: number; offscreen: boolean; behind: boolean; distance: number }
/** Linear 0…1 RGB behind the scene (where a camera move reveals the edge of the reconstruction). */
export type Background = [number, number, number];
export interface ModelPrefs { modelUrl: string; dataUrl: string; autoLoad: boolean; preferWebGpu: boolean }

export interface StudioEvents extends Record<string, unknown> {
  /** A new scene was loaded. */
  scene: void;
  /** Keyframes, easing, duration, name or active preset changed. */
  motion: void;
  /** Selected keyframe / segment changed. */
  selection: void;
  /** Playhead moved (seconds). */
  time: number;
  /** Playback started / stopped. */
  playback: boolean;
  /** Mode, view, aspect, loop, ping-pong, background or preset parameters changed. */
  settings: void;
  /** A frame was drawn after the camera, pivot or scene changed. Refresh live readouts here. */
  frame: void;
  model: ModelStatus;
  /** Long-running work: a status line, or null when done. */
  busy: string | null;
  notify: Notice;
  /** Saved motions ("My motions") changed. */
  library: void;
  /** Undo / redo availability changed. */
  history: void;
}

export interface RenderVideoOptions {
  /** short side in pixels */
  shortSide: number;
  fps: number;
  /** Mbit/s */
  bitrate: number;
  format: 'mp4' | 'webm';
  /** play forward then back; defaults to the Studio's own `pingPong` */
  pingPong?: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface RenderedVideo {
  blob: Blob;
  filename: string;
  extension: string;
  codec: string;
  seconds: number;
}

export const ASPECTS = ['source', '16:9', '9:16', '1:1', '4:5', '21:9'] as const;
/** A preset aspect, the photo's own ('source'), or any custom `w:h`. */
export type Aspect = (typeof ASPECTS)[number] | `${number}:${number}`;

/**
 * Parse a user-typed aspect ratio: "2.39:1", "3 x 2", "1080/1350" or a plain ratio "1.85".
 * Returns a normalised `w:h`, or null when invalid or outside 1:5 … 5:1.
 */
export function parseAspect(text: string): Aspect | null {
  const m = /^\s*(\d*\.?\d+)\s*(?:[:x×/]\s*(\d*\.?\d+))?\s*$/i.exec(text);
  if (!m) return null;
  const w = parseFloat(m[1]), h = m[2] ? parseFloat(m[2]) : 1;
  if (!(w > 0 && h > 0) || w / h > 5 || h / w > 5) return null;
  const fmt = (v: number) => String(+v.toFixed(3));
  return `${fmt(w)}:${fmt(h)}` as Aspect;
}

const DEFAULT_PRESET = 'sharp-rotate-forward';
/** The model shipped next to the app (see public/models/README.md). */
const MODEL_BASE = (import.meta.env.VITE_MODEL_BASE_URL || 'models/').replace(/\/?$/, '/');
/** The model the app ships with: next to the app, or wherever VITE_MODEL_BASE_URL points at build time. */
export const HOSTED_MODEL = { modelUrl: `${MODEL_BASE}sharp.onnx`, dataUrl: `${MODEL_BASE}sharp.int8.bin` };
/** Size of the hosted model's download, for telling people before they start it. */
export const HOSTED_MODEL_SIZE = '0.7 GB';
const HISTORY_LIMIT = 100;

export class Studio extends Emitter<StudioEvents> {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: SplatRenderer;
  readonly controller: CameraController;
  readonly sharp = new SharpModel();
  readonly observer = new ObserverCamera();

  scene: SplatScene | null = null;
  stats: SceneStats | null = null;
  image: LoadedImage | null = null;
  motion: Motion = { name: 'Untitled', duration: 5, keyframes: [] };
  time = 0;
  playing = false;
  loop = true;
  /** Motion plays forward then back (playback and export). */
  pingPong = false;
  /** A keyframe copied with `copyKey`, pasted with `pasteKey`. */
  keyClipboard: Keyframe | null = null;
  view: ViewMode = 'camera';
  /** Output aspect; defaults to the photo's own. */
  aspect: Aspect = 'source';
  activePreset: string | null = null;
  selectedKey: string | null = null;
  selectedSegment: number | null = null;
  background: Background = [0, 0, 0];
  /** Preset amplitude multiplier. */
  intensity = 1;
  /** Preset duration override (seconds), or null for each preset's own. */
  presetDuration: number | null = null;
  modelStatus: ModelStatus = { state: 'idle', text: 'Not loaded. Images use the heuristic preview depth until the SHARP model is loaded.', percent: null };
  busyText: string | null = null;

  private frameEl: HTMLDivElement;
  private host: HTMLElement | null = null;
  private hostObserver = new ResizeObserver(() => this.layout());
  private framePadding = 24;
  private outRect: OutputRect = { x: 0, y: 0, width: 1, height: 1 };
  private dirty = true;
  private lastFrame = performance.now();
  private shiftDown = false;
  private lastMode: ControlMode = 'free';
  private undoStack: Motion[] = [];
  private redoStack: Motion[] = [];
  private lastCheckpoint = { tag: '', at: 0 };
  /** Position within one play cycle (0..duration, or 0..2·duration when ping-ponging). */
  private playClock = 0;
  private autoKeyPending = false;
  /**
   * Bumped whenever a new scene is requested (photo, .ply, model reload). Async work checks it
   * before touching the scene or the busy line, so a slow, superseded request can neither
   * overwrite a newer scene nor leave a stale "Running SHARP…" behind.
   */
  private sceneJob = 0;
  /** The SHARP prediction in flight; requests for the same image share it. */
  private inflight: { image: LoadedImage; promise: Promise<SplatScene> } | null = null;

  constructor() {
    super();
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viewport-canvas';
    this.canvas.tabIndex = 0;
    this.frameEl = document.createElement('div');
    this.frameEl.className = 'viewport-frame';
    this.frameEl.appendChild(this.canvas);
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%', outline: 'none', touchAction: 'none' });

    this.renderer = new SplatRenderer(this.canvas);
    this.renderer.onSortComplete = () => (this.dirty = true);
    this.controller = new CameraController(this.canvas);
    this.controller.onChange = (source) => {
      if (source === 'user' && this.playing) this.pause();
      // Auto-key: every camera change the user makes is captured at the playhead.
      if (source === 'user') this.autoKeyPending = true;
      if (this.controller.mode !== this.lastMode) {
        this.lastMode = this.controller.mode;
        this.emit('settings');
      }
      this.dirty = true;
    };
    this.sharp.onReset = (err) => {
      console.warn('[studio] SHARP worker reset:', err.message);
      this.setModelStatus('err', 'SHARP stopped responding. It reloads automatically with the next photo, or reload it here.');
    };
    this.bindDirectorInput();
    window.addEventListener('keydown', (e) => (this.shiftDown = e.shiftKey));
    window.addEventListener('keyup', (e) => (this.shiftDown = e.shiftKey));
    requestAnimationFrame(this.tick);
  }

  // ------------------------------------------------------------ mounting

  /**
   * Place the viewport inside `host`. The canvas fills the host and shows the scene around the
   * shot; the output frame is fitted inside it with `padding` (see `outputRect()`). Returns the
   * frame element so the UI can layer overlays on top of the picture.
   */
  mount(host: HTMLElement, opts: { padding?: number } = {}): HTMLElement {
    this.unmount();
    this.host = host;
    this.framePadding = opts.padding ?? 24;
    host.appendChild(this.frameEl);
    this.hostObserver.observe(host);
    this.layout();
    return this.frameEl;
  }

  /** Detach from the current host and drop any overlays the UI added to the frame. */
  unmount() {
    if (!this.host) return;
    this.hostObserver.disconnect();
    for (const child of [...this.frameEl.children]) if (child !== this.canvas) child.remove();
    this.frameEl.className = 'viewport-frame';
    this.frameEl.removeAttribute('style');
    this.frameEl.remove();
    this.host = null;
  }

  aspectRatio(): number {
    if (this.aspect === 'source') return this.scene ? this.scene.imageWidth / this.scene.imageHeight : 16 / 9;
    const [a, b] = this.aspect.split(':').map(Number);
    return a / b;
  }

  layout() {
    if (!this.host) return;
    const r = this.host.getBoundingClientRect();
    const ar = this.aspectRatio();
    const pad = this.framePadding;
    let w = r.width - pad * 2, h = w / ar;
    if (h > r.height - pad * 2) {
      h = r.height - pad * 2;
      w = h * ar;
    }
    w = Math.max(50, w); h = Math.max(50, h);
    const cw = Math.max(50, r.width), ch = Math.max(50, r.height);
    this.outRect = { x: (cw - w) / 2, y: (ch - h) / 2, width: w, height: h };
    this.frameEl.style.width = `${cw}px`;
    this.frameEl.style.height = `${ch}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.renderer.resize(Math.round(cw * dpr), Math.round(ch * dpr));
    this.dirty = true;
  }

  /** Where the output frame sits on the canvas (CSS px). */
  outputRect(): OutputRect {
    return { ...this.outRect };
  }

  /** Output frame size in canvas (device) pixels: the frame the focal length is defined for. */
  private outputPx(): [number, number] {
    const k = this.canvas.width / Math.max(1, parseFloat(this.frameEl.style.width) || this.canvas.width);
    return [Math.max(1, Math.round(this.outRect.width * k)), Math.max(1, Math.round(this.outRect.height * k))];
  }

  // ------------------------------------------------------------ notifications

  notify(message: string, kind: Notice['kind'] = 'info') {
    this.emit('notify', { message, kind });
  }

  private setBusy(text: string | null) {
    this.busyText = text;
    this.emit('busy', text);
  }

  // ------------------------------------------------------------ scene loading

  private setScene(scene: SplatScene) {
    this.scene = scene;
    this.stats = computeStats(scene);
    this.renderer.setScene(scene);
    this.controller.sceneScale = this.stats.focusDepth;
    this.controller.pivot = [0, 0, this.stats.focusDepth];
    this.observer.frame(this.stats.focusDepth);
    this.layout();
    this.emit('scene');
    if (this.motion.keyframes.length === 0) {
      this.applyPreset(DEFAULT_PRESET, { silent: true, record: false });
    } else {
      // Keep the user's motion when switching images: it was authored in metres.
      this.emit('motion');
    }
    this.seek(this.time);
  }

  async openImage(file: Blob, name: string) {
    const job = ++this.sceneJob;
    const current = () => job === this.sceneJob;
    try {
      this.setBusy('Decoding image…');
      const img = await loadImage(file, name);
      if (!current()) return;
      this.image = img;
      let scene: SplatScene | null;
      if (this.sharp.loading) {
        this.setBusy('Waiting for the SHARP model to finish loading…');
        await this.sharp.idle();
        if (!current()) return;
      }
      // The worker was reset after a crash or hang: bring the model back before predicting.
      const last = this.sharp.lastSource;
      if (this.sharp.crashed && !this.sharp.loaded && last) {
        this.setBusy('Reloading the SHARP model…');
        await this.loadModelOnly(last.src);
        if (!current()) return;
      }
      if (this.sharp.loaded) {
        this.setBusy('Running SHARP…');
        scene = await this.sharpScene(img, job);
      } else {
        this.setBusy('Lifting image with preview depth…');
        await new Promise((r) => setTimeout(r, 30));
        scene = buildPreviewScene(img);
        this.notify('SHARP model not loaded: using heuristic preview depth. Load the model for real 3D.');
      }
      if (scene && current()) this.setScene(scene);
    } catch (e) {
      console.error(e);
      if (current()) this.notify(`Could not process image: ${(e as Error).message}`, 'error');
    } finally {
      if (current()) this.setBusy(null);
    }
  }

  /** One SHARP prediction per image at a time; its progress only shows while it's still wanted. */
  private predictSharp(img: LoadedImage): Promise<SplatScene> {
    if (this.inflight?.image === img) return this.inflight.promise;
    const promise = this.sharp.predict(img, (stage) => { if (this.image === img && this.busyText !== null) this.setBusy(stage); });
    this.inflight = { image: img, promise };
    const clear = () => { if (this.inflight?.promise === promise) this.inflight = null; };
    promise.then(clear, clear);
    return promise;
  }

  /**
   * SHARP scene for `img`, or null if the job was superseded. If the worker hung or crashed it
   * has been reset: reload the model once and retry.
   */
  private async sharpScene(img: LoadedImage, job: number): Promise<SplatScene | null> {
    try {
      return await this.predictSharp(img);
    } catch (e) {
      const last = this.sharp.lastSource;
      if (!(e instanceof SharpStalledError) || !last) throw e;
      console.warn(e);
      this.notify('SHARP stopped responding. Reloading the model and trying again…', 'error');
      if (job === this.sceneJob) this.setBusy('Reloading the SHARP model…');
      if (!(await this.loadModelOnly(last.src))) throw new Error('the SHARP model could not be reloaded');
      if (job !== this.sceneJob) return null;
      this.setBusy('Running SHARP…');
      return await this.predictSharp(img);
    }
  }

  async openPly(file: File) {
    const job = ++this.sceneJob;
    try {
      this.setBusy('Parsing .ply…');
      const buf = await file.arrayBuffer();
      const scene = parsePly(buf, `PLY: ${file.name}`);
      if (job !== this.sceneJob) return;
      this.image = null;
      this.setScene(scene);
    } catch (e) {
      if (job === this.sceneJob) this.notify(`Could not load .ply: ${(e as Error).message}`, 'error');
    } finally {
      if (job === this.sceneJob) this.setBusy(null);
    }
  }

  /** Open whatever the user dropped or picked: an image or a SHARP .ply. */
  openFile(file: File) {
    if (file.name.toLowerCase().endsWith('.ply')) return this.openPly(file);
    if (file.type.startsWith('image/')) return this.openImage(file, file.name);
    this.notify('Drop an image or a SHARP .ply', 'error');
    return Promise.resolve();
  }

  /** Open the bundled sample photo (a bedroom interior). */
  async openSample() {
    const res = await fetch(sampleUrl);
    return this.openImage(await res.blob(), 'interior.jpg');
  }

  /** Base name for downloads, derived from the source image. */
  get baseName() {
    return (this.image?.name ?? this.scene?.source.replace(/^PLY: /, '') ?? 'scene').replace(/\.[^.]+$/, '');
  }

  exportPly(): { blob: Blob; filename: string } | null {
    if (!this.scene) return null;
    return { blob: writePly(this.scene), filename: `${this.baseName}.ply` };
  }

  // ------------------------------------------------------------ SHARP model

  get modelPrefs(): ModelPrefs {
    const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
    return {
      modelUrl: get('sharprig.modelUrl') || HOSTED_MODEL.modelUrl,
      dataUrl: get('sharprig.modelDataUrl') ?? HOSTED_MODEL.dataUrl,
      autoLoad: get('sharprig.autoLoad') !== '0',
      preferWebGpu: get('sharprig.preferWebGpu') !== '0',
    };
  }

  setModelPrefs(p: Partial<ModelPrefs>) {
    const set = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
    if (p.modelUrl !== undefined) set('sharprig.modelUrl', p.modelUrl);
    if (p.dataUrl !== undefined) set('sharprig.modelDataUrl', p.dataUrl);
    if (p.autoLoad !== undefined) set('sharprig.autoLoad', p.autoLoad ? '1' : '0');
    if (p.preferWebGpu !== undefined) set('sharprig.preferWebGpu', p.preferWebGpu ? '1' : '0');
  }

  private setModelStatus(state: ModelState, text: string) {
    const pct = /(\d+)%/.exec(text)?.[1];
    this.modelStatus = { state, text, percent: pct ? Number(pct) : null };
    this.emit('model', this.modelStatus);
  }

  /** Load the model, then re-run SHARP on the current photo (replacing its preview depth). */
  async loadModel(src: ModelSource) {
    if (!(await this.loadModelOnly(src))) return;
    const img = this.image;
    if (!img) return;
    const job = ++this.sceneJob;
    this.setBusy('Running SHARP…');
    try {
      const scene = await this.sharpScene(img, job);
      if (scene && job === this.sceneJob) this.setScene(scene);
    } catch (e) {
      console.error(e);
      if (job === this.sceneJob) this.notify(`SHARP could not process the photo: ${(e as Error).message}`, 'error');
    } finally {
      if (job === this.sceneJob) this.setBusy(null);
    }
  }

  /** Load the model and report it in the model status. Resolves false on failure. */
  private async loadModelOnly(src: ModelSource): Promise<boolean> {
    this.setModelStatus('busy', 'Loading…');
    // Name anything other than the hosted model, so a test/stub model can't pass for SHARP.
    const name = src.kind === 'url' ? src.modelUrl.split(/[\/]/).pop()! : src.model.name;
    const custom = !(src.kind === 'url' && src.modelUrl === HOSTED_MODEL.modelUrl);
    const stub = /stub/i.test(name);
    try {
      await this.sharp.load(src, this.modelPrefs.preferWebGpu, (stage) => this.setModelStatus('busy', stage));
      this.setModelStatus('ok', stub
        ? `Test stub model loaded (${name}): its output is placeholder data, not a real reconstruction.`
        : `SHARP ready (${this.sharp.backend})${custom ? ` · ${name}` : ''}.`);
      this.notify(stub ? `Loaded test stub model ${name}, not SHARP` : 'SHARP model loaded', stub ? 'error' : 'info');
      return true;
    } catch (e) {
      console.error(e);
      this.setModelStatus('err', `Failed: ${(e as Error).message}`);
      return false;
    }
  }

  loadModelFromUrl(modelUrl = this.modelPrefs.modelUrl, dataUrl = this.modelPrefs.dataUrl) {
    this.setModelPrefs({ modelUrl, dataUrl });
    return this.loadModel({ kind: 'url', modelUrl, dataUrl: dataUrl || undefined });
  }

  loadModelFromFiles(model: File, data?: File) {
    return this.loadModel({ kind: 'files', model, data });
  }

  /**
   * Load the model on startup, but only when the deployment actually ships it next to the app.
   * Always the hosted model: a URL loaded by hand (e.g. the test stub) is never auto-loaded.
   */
  async autoLoadModel() {
    if (!this.modelPrefs.autoLoad) return;
    const src: ModelSource = { kind: 'url', ...HOSTED_MODEL };
    // A model on another origin (e.g. a model hub) only loads by itself once it has been downloaded
    // before: a first visit shouldn't start a large download nobody asked for.
    if (new URL(HOSTED_MODEL.modelUrl, location.href).origin !== location.origin) {
      if (await this.sharp.isCached(src)) this.loadModel(src);
      return;
    }
    try {
      const r = await fetch(HOSTED_MODEL.modelUrl, { method: 'HEAD' });
      if (r.ok && !/text\/html/.test(r.headers.get('content-type') ?? '')) this.loadModel(src);
    } catch { /* not deployed with the app */ }
  }

  // ------------------------------------------------------------ presets & library

  presets(): Preset[] {
    return [...savedAsPresets(), ...PRESETS];
  }

  presetCategories(): string[] {
    return [SAVED_CATEGORY, ...PRESET_CATEGORIES];
  }

  applyPreset(p: Preset | string, opts: { silent?: boolean; record?: boolean } = {}) {
    const preset = typeof p === 'string' ? this.presets().find((x) => x.id === p) : p;
    if (!preset) return;
    if (!this.stats) return this.notify('Load an image first', 'error');
    if (opts.record !== false) this.checkpoint();
    const duration = this.presetDuration && this.presetDuration > 0 ? this.presetDuration : preset.duration;
    this.motion = { name: preset.name, duration, keyframes: preset.build({ stats: this.stats, intensity: this.intensity }, duration) };
    this.activePreset = preset.id;
    this.selectedKey = null;
    this.selectedSegment = null;
    // Leave the controller in the mode the preset was authored in.
    const pivotKey = this.motion.keyframes.find((k) => k.pivot);
    if (pivotKey) {
      this.controller.pivot = v3.clone(pivotKey.pivot!);
      this.setMode('pivot');
    }
    this.emit('motion');
    this.emit('selection');
    this.seek(0);
    if (!opts.silent) this.play(true);
  }

  /** Change the preset amplitude; re-applies the active preset unless `reapply` is false. */
  setIntensity(v: number, reapply = true) {
    this.intensity = v;
    this.emit('settings');
    if (reapply && this.activePreset) this.applyPreset(this.activePreset);
  }

  setPresetDuration(v: number | null) {
    this.presetDuration = v && v > 0 ? v : null;
    this.emit('settings');
  }

  saveMotion(name: string) {
    if (!this.stats || this.motion.keyframes.length < 2) return this.notify('Need at least 2 keyframes', 'error');
    const saved = loadSaved();
    saved.unshift(normaliseMotion({ ...this.motion, name }, this.stats.focusDepth));
    storeSaved(saved);
    this.motion.name = name;
    this.activePreset = 'saved-0';
    this.emit('library');
    this.emit('motion');
    this.notify(`Saved "${name}" to My motions`);
  }

  deleteSavedMotion(index: number) {
    const saved = loadSaved();
    const [gone] = saved.splice(index, 1);
    if (!gone) return;
    storeSaved(saved);
    if (this.activePreset?.startsWith('saved-')) this.activePreset = null;
    this.emit('library');
    this.notify(`Removed "${gone.name}"`);
  }

  exportMotionJSON(): { blob: Blob; filename: string } | null {
    if (!this.stats) return null;
    const data = normaliseMotion(this.motion, this.stats.focusDepth);
    return {
      blob: new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      filename: `${this.motion.name.replace(/\W+/g, '-')}.motion.json`,
    };
  }

  async importMotion(file: File) {
    if (!this.stats) return this.notify('Load an image first', 'error');
    try {
      const sm = JSON.parse(await file.text()) as SavedMotion;
      if (!Array.isArray(sm.keyframes)) throw new Error('no keyframes');
      this.checkpoint();
      this.motion = denormaliseMotion(sm, this.stats.focusDepth);
      sortKeyframes(this.motion);
      this.selectedKey = null;
      this.selectedSegment = null;
      this.markEdited();
      this.emit('selection');
      this.seek(0);
      this.notify(`Imported "${sm.name}"`);
    } catch (err) {
      this.notify(`Invalid motion file: ${(err as Error).message}`, 'error');
    }
  }

  // ------------------------------------------------------------ undo / redo

  /**
   * Snapshot the motion before an edit. Calls with the same `tag` in quick succession (a drag,
   * a slider) coalesce into one undo step.
   */
  checkpoint(tag = '') {
    const now = performance.now();
    if (tag && tag === this.lastCheckpoint.tag && now - this.lastCheckpoint.at < 1000) {
      this.lastCheckpoint.at = now;
      return;
    }
    this.lastCheckpoint = { tag, at: now };
    this.undoStack.push(cloneMotion(this.motion));
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.emit('history');
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  undo() { this.restore(this.undoStack, this.redoStack, 'Undo'); }
  redo() { this.restore(this.redoStack, this.undoStack, 'Redo'); }

  private restore(from: Motion[], to: Motion[], label: string) {
    const m = from.pop();
    if (!m) return;
    to.push(cloneMotion(this.motion));
    this.motion = m;
    this.lastCheckpoint = { tag: '', at: 0 };
    if (!this.motion.keyframes.some((k) => k.id === this.selectedKey)) this.selectedKey = null;
    if (this.selectedSegment !== null && this.selectedSegment >= this.motion.keyframes.length - 1) this.selectedSegment = null;
    this.activePreset = null;
    this.emit('motion');
    this.emit('selection');
    this.emit('history');
    this.seek(this.time);
    this.notify(label);
  }

  // ------------------------------------------------------------ playback

  seek(t: number) {
    this.time = Math.max(0, Math.min(this.motion.duration, t));
    const pose = evaluate(this.motion, this.time);
    if (pose) this.controller.setPose(pose, 'api');
    const pv = evaluatePivot(this.motion, this.time);
    if (pv) this.controller.pivot = pv;
    this.dirty = true;
    this.emit('time', this.time);
  }

  /** Seek as a user action (scrubbing): stops playback first. */
  scrub(t: number) {
    this.pause();
    this.seek(t);
  }

  play(fromStart = false) {
    if (!this.scene || this.motion.keyframes.length < 2) return;
    if (fromStart || (!this.pingPong && this.time >= this.motion.duration)) this.time = 0;
    if (this.playing) return;
    this.playClock = this.time;
    this.playing = true;
    this.emit('playback', true);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.emit('playback', false);
  }

  togglePlay() {
    if (this.playing) this.pause(); else this.play();
  }

  setLoop(on: boolean) {
    this.loop = on;
    this.emit('settings');
  }

  setPingPong(on: boolean) {
    this.pingPong = on;
    this.emit('settings');
  }

  /** Change the total duration, retiming keyframes proportionally. */
  setDuration(d: number) {
    d = Math.max(0.5, d || 5);
    if (Math.abs(d - this.motion.duration) < 1e-6) return;
    this.checkpoint('duration');
    const k = d / this.motion.duration;
    for (const kf of this.motion.keyframes) kf.time *= k;
    this.motion.duration = d;
    this.markEdited();
    this.seek(this.time * k);
  }

  // ------------------------------------------------------------ keyframes

  private markEdited() {
    this.activePreset = null;
    this.emit('motion');
  }

  get selectedKeyframe(): Keyframe | null {
    return this.motion.keyframes.find((k) => k.id === this.selectedKey) ?? null;
  }

  selectKey(id: string | null) {
    this.selectedKey = id;
    this.emit('selection');
  }

  selectSegment(i: number | null) {
    this.selectedSegment = i !== null && i >= 0 && i < this.motion.keyframes.length - 1 ? i : null;
    this.emit('selection');
  }

  /**
   * Capture the viewport pose at the playhead (overwrites a key already at that time).
   * `advance: false` keeps the playhead in place; `tag` coalesces repeated captures (a slider
   * drag) into one undo step; `silent` suppresses the notice.
   */
  addKeyframe(opts: { advance?: boolean; tag?: string; silent?: boolean } = {}) {
    if (!this.scene) return;
    this.pause();
    this.checkpoint(opts.tag);
    const t = Math.round(this.time * 100) / 100;
    const pivot = this.controller.mode === 'pivot' ? this.controller.pivot : null;
    const existing = this.motion.keyframes.find((k) => Math.abs(k.time - t) < 0.02);
    if (existing) {
      existing.pose = clonePose(this.controller.pose);
      existing.pivot = pivot ? v3.clone(pivot) : null;
      this.selectedKey = existing.id;
      if (!opts.silent) this.notify(`Updated keyframe at ${t.toFixed(2)} s`);
    } else {
      const prev = [...this.motion.keyframes].reverse().find((k) => k.time < t);
      const kf = makeKeyframe(t, this.controller.pose, { pivot, easing: prev ? cloneEasing(prev.easing) : undefined });
      this.motion.keyframes.push(kf);
      sortKeyframes(this.motion);
      this.selectedKey = kf.id;
      // Nudge the playhead forward so the next capture lands on a new time.
      if (opts.advance !== false) {
        const next = Math.min(this.motion.duration, t + Math.max(0.5, this.motion.duration / 4));
        this.time = next > t ? next : t;
        this.emit('time', this.time);
      }
    }
    this.selectedSegment = null;
    this.markEdited();
    this.emit('selection');
  }

  deleteSelectedKey() {
    const i = this.motion.keyframes.findIndex((x) => x.id === this.selectedKey);
    if (i < 0) return;
    this.checkpoint();
    this.motion.keyframes.splice(i, 1);
    this.selectedKey = null;
    this.selectedSegment = null;
    this.markEdited();
    this.emit('selection');
    this.seek(this.time);
  }

  /** Copy a keyframe (the selected one by default) for `pasteKey`. */
  copyKey(id = this.selectedKey) {
    const k = this.motion.keyframes.find((x) => x.id === id);
    if (!k) return;
    this.keyClipboard = JSON.parse(JSON.stringify(k));
    this.emit('selection');
    this.notify(`Copied keyframe at ${k.time.toFixed(2)} s`);
  }

  /** Paste the copied keyframe at `time` (the playhead by default), replacing a key already there. */
  pasteKey(time = this.time) {
    const src = this.keyClipboard;
    if (!src || !this.scene) return;
    this.pause();
    this.checkpoint();
    const t = Math.round(Math.max(0, Math.min(this.motion.duration, time)) * 100) / 100;
    const existing = this.motion.keyframes.find((k) => Math.abs(k.time - t) < 0.02);
    const kf = makeKeyframe(t, src.pose, { pivot: src.pivot, easing: cloneEasing(src.easing), path: src.path });
    if (existing) Object.assign(existing, { pose: kf.pose, pivot: kf.pivot, easing: kf.easing, path: kf.path });
    else this.motion.keyframes.push(kf);
    sortKeyframes(this.motion);
    this.selectedKey = existing?.id ?? kf.id;
    this.selectedSegment = null;
    this.markEdited();
    this.emit('selection');
    this.seek(t);
  }

  deleteKey(id: string) {
    this.selectedKey = id;
    this.deleteSelectedKey();
  }

  clearKeyframes() {
    if (!this.motion.keyframes.length) return;
    this.checkpoint();
    this.motion.keyframes = [];
    this.selectedKey = null;
    this.selectedSegment = null;
    this.markEdited();
    this.emit('selection');
  }

  /** Move a keyframe in time (drags coalesce into one undo step). */
  retimeKey(id: string, time: number) {
    const kf = this.motion.keyframes.find((k) => k.id === id);
    if (!kf) return;
    this.checkpoint(`retime:${id}`);
    kf.time = Math.round(Math.max(0, Math.min(this.motion.duration, time)) * 100) / 100;
    sortKeyframes(this.motion);
    this.markEdited();
    this.seek(kf.time);
  }

  jumpKey(dir: -1 | 1) {
    const ks = this.motion.keyframes;
    const k = dir > 0 ? ks.find((x) => x.time > this.time + 1e-3) : [...ks].reverse().find((x) => x.time < this.time - 1e-3);
    if (!k) return;
    this.pause();
    this.selectedSegment = null;
    this.selectKey(k.id);
    this.seek(k.time);
  }

  // ------------------------------------------------------------ segments

  segmentKey(i = this.selectedSegment): Keyframe | null {
    if (i === null || i < 0 || i >= this.motion.keyframes.length - 1) return null;
    return this.motion.keyframes[i];
  }

  setSegmentEasing(i: number, spec: EasingSpec) {
    const k = this.segmentKey(i);
    if (!k) return;
    this.checkpoint(`easing:${i}`);
    k.easing = cloneEasing(spec.name === 'custom' && !spec.bezier ? { ...spec, bezier: k.easing.bezier } : spec);
    this.markEdited();
    this.seek(this.time);
  }

  setSegmentPath(i: number, path: PathMode) {
    const k = this.segmentKey(i);
    if (!k) return;
    this.checkpoint();
    k.path = path;
    this.markEdited();
    this.seek(this.time);
  }

  applyEasingToAll(spec: EasingSpec) {
    this.checkpoint();
    for (const o of this.motion.keyframes) o.easing = cloneEasing(spec);
    this.markEdited();
    this.seek(this.time);
  }

  // ------------------------------------------------------------ camera

  get mode(): ControlMode {
    return this.controller.mode;
  }

  setMode(mode: ControlMode) {
    this.controller.mode = mode;
    this.lastMode = mode;
    this.dirty = true;
    this.emit('settings');
  }

  setView(view: ViewMode) {
    this.view = view;
    this.controller.enabled = view === 'camera';
    this.dirty = true;
    this.emit('settings');
  }

  setAspect(aspect: Aspect) {
    this.aspect = aspect;
    this.layout();
    this.emit('settings');
  }

  setBackground(bg: Background) {
    this.background = bg;
    this.renderer.background = bg;
    this.dirty = true;
    this.emit('settings');
  }

  /** Mutate the live camera (pose / pivot) from a UI control; stops playback. */
  editCamera(fn: (c: CameraController) => void) {
    fn(this.controller);
    this.controller.onChange('user');
  }

  resetCamera() {
    this.controller.setPose(identityPose(), 'user');
  }

  /** Default arm length for a placement: the subject distance in front, shorter elsewhere. */
  placePivot(where: PivotPlacement) {
    const F = this.stats?.focusDepth ?? 3;
    const dist = where === 'front' ? F : 0.45 * F;
    this.controller.placePivot(where, dist);
    this.setMode('pivot');
    return dist;
  }

  /** Put the pivot on the surface under a viewport point (CSS px within the canvas). */
  setPivotAt(cssX: number, cssY: number): boolean {
    const hit = this.pickPoint(cssX, cssY);
    if (!hit) return false;
    this.controller.pivot = hit;
    this.setMode('pivot');
    this.controller.onChange('user');
    return true;
  }

  setArmLength(len: number) {
    this.controller.setArmLength(Math.max(0.01, len));
  }

  eulerDegrees(): Vec3 {
    return quat.toEuler(this.controller.pose.rotation).map((r) => r / DEG) as Vec3;
  }

  setEulerDegrees(index: 0 | 1 | 2, deg: number) {
    const e = this.eulerDegrees();
    e[index] = deg;
    this.editCamera((c) => (c.pose.rotation = quat.fromEuler(e[0] * DEG, e[1] * DEG, e[2] * DEG)));
  }

  setZoom(z: number) {
    this.editCamera((c) => (c.pose.zoom = Math.min(8, Math.max(0.3, z))));
  }

  /** 35mm-equivalent focal length of the output frame (diagonal convention, as SHARP). */
  focal35(zoom = this.controller.pose.zoom) {
    if (!this.scene) return 30;
    const [w, h] = this.outputPx();
    const f = outputFocal(this.scene, w, h, zoom);
    return (f * Math.hypot(36, 24)) / Math.hypot(w, h);
  }

  setFocal35(mm: number) {
    if (!this.scene) return;
    this.setZoom(this.controller.pose.zoom * (mm / this.focal35()));
  }

  /** Where the pivot appears in the frame (CSS px), for drawing a marker. Null when not relevant. */
  pivotScreen(): PivotScreen | null {
    if (this.view !== 'camera' || this.controller.mode !== 'pivot' || !this.scene) return null;
    const cam = this.renderCamera();
    const p = quat.rotate(quat.conj(cam.rotation), v3.sub(this.controller.pivot, cam.position));
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    if (!cw || !ch) return null;
    const dpr = this.canvas.width / cw;
    let x: number, y: number, offscreen = false, behind = false;
    if (p[2] > 1e-3) {
      x = ((p[0] / p[2]) * cam.fx + this.canvas.width / 2) / dpr;
      y = ((p[1] / p[2]) * cam.fy + this.canvas.height / 2) / dpr;
      if (x < 0 || y < 0 || x > cw || y > ch) offscreen = true;
    } else {
      offscreen = behind = true;
      const d = Math.hypot(p[0], p[1]) || 1;
      x = cw / 2 + (p[0] / d) * cw * 0.3;
      y = ch / 2 + (p[1] / d) * ch * 0.3;
      if (Math.hypot(p[0], p[1]) < 1e-3) { x = cw / 2; y = ch - 30; }
    }
    return {
      x: Math.min(cw - 14, Math.max(14, x)),
      y: Math.min(ch - 14, Math.max(14, y)),
      offscreen, behind, distance: v3.len(p),
    };
  }

  private renderCamera(): RenderCamera {
    const pose = this.controller.pose;
    const [w, h] = this.outputPx();
    const f = this.scene ? outputFocal(this.scene, w, h, pose.zoom) : h;
    return { position: pose.position, rotation: pose.rotation, fx: f, fy: f };
  }

  private pickPoint(cssX: number, cssY: number): Vec3 | null {
    const s = this.scene;
    if (!s) return null;
    const canvas = this.canvas;
    const dpr = canvas.width / canvas.clientWidth;
    const px = cssX * dpr, py = cssY * dpr;
    const cam = this.renderCamera();
    const qInv = quat.conj(cam.rotation);
    const step = Math.max(1, Math.floor(s.count / 300000));
    const radius = 10 * dpr;
    let best = -1, bestZ = Infinity;
    const zs: number[] = [];
    for (let i = 0; i < s.count; i += step) {
      if (s.colors[i * 4 + 3] < 60) continue;
      const p = quat.rotate(qInv, v3.sub([s.positions[i * 3], s.positions[i * 3 + 1], s.positions[i * 3 + 2]], cam.position));
      if (p[2] <= 0.01) continue;
      const u = (p[0] / p[2]) * cam.fx + canvas.width / 2;
      const v = (p[1] / p[2]) * cam.fy + canvas.height / 2;
      if (Math.abs(u - px) < radius && Math.abs(v - py) < radius) {
        zs.push(p[2]);
        if (p[2] < bestZ) { bestZ = p[2]; best = i; }
      }
    }
    if (best < 0) {
      this.notify('Nothing there to orbit around. Drop the point on the subject.', 'error');
      return null;
    }
    // Use a robust near-surface depth (20th percentile) rather than a stray floater.
    zs.sort((a, b) => a - b);
    const z = zs[Math.floor(zs.length * 0.2)];
    const dir: Vec3 = [(px - canvas.width / 2) / cam.fx, (py - canvas.height / 2) / cam.fy, 1];
    return v3.add(cam.position, quat.rotate(cam.rotation, v3.scale(dir, z)));
  }

  // ------------------------------------------------------------ director view input

  private bindDirectorInput() {
    const canvas = this.canvas;
    let drag: { x: number; y: number; pan: boolean } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (this.view !== 'director') return;
      drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button !== 0 };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || this.view !== 'director') return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) this.observer.pan(dx, dy);
      else this.observer.orbit(dx, dy);
      this.dirty = true;
    });
    canvas.addEventListener('pointerup', () => (drag = null));
    canvas.addEventListener('wheel', (e) => {
      if (this.view !== 'director') return;
      e.preventDefault();
      this.observer.zoom(Math.sign(e.deltaY));
      this.dirty = true;
    }, { passive: false });
  }

  // ------------------------------------------------------------ render loop

  /** Force a redraw on the next frame. */
  invalidate() {
    this.dirty = true;
  }

  private tick = (now: number) => {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (this.playing) {
      const d = this.motion.duration;
      const cycle = this.pingPong ? 2 * d : d;
      let c = this.playClock + dt;
      if (c >= cycle) {
        if (this.loop) c %= cycle;
        else { c = cycle; this.pause(); }
      }
      this.playClock = c;
      this.seek(c > d ? 2 * d - c : c);
    }
    if (this.controller.tick(dt, this.shiftDown)) this.dirty = true;
    if (this.autoKeyPending) {
      // Once per frame at most, so a drag becomes one keyframe update per frame (one undo step).
      this.autoKeyPending = false;
      if (this.scene && this.view === 'camera') {
        this.addKeyframe({ advance: false, silent: true, tag: `autokey:${Math.round(this.time * 100)}` });
      }
    }

    if (this.dirty && this.scene && this.host) {
      this.dirty = false;
      if (this.view === 'camera') {
        this.renderer.render(this.renderCamera());
      } else {
        const op = this.observer.pose();
        const f = this.canvas.height / (2 * Math.tan(30 * DEG));
        const lines = directorOverlay({
          scene: this.scene, width: this.outputPx()[0], height: this.outputPx()[1],
          focusDepth: this.stats?.focusDepth ?? 3, motion: this.motion, selectedKey: this.selectedKey,
          live: this.controller.pose, pivot: this.controller.mode === 'pivot' ? this.controller.pivot : null,
        });
        this.renderer.render({ position: op.position, rotation: op.rotation, fx: f, fy: f }, lines);
      }
      this.emit('frame');
    }
    requestAnimationFrame(this.tick);
  };

  // ------------------------------------------------------------ export

  /** Output size for a given short side at the current aspect (even dimensions). */
  exportSize(shortSide: number) {
    const ar = this.aspectRatio();
    let w: number, h: number;
    if (ar >= 1) { h = shortSide; w = Math.round(shortSide * ar); } else { w = shortSide; h = Math.round(shortSide / ar); }
    return { width: w & ~1, height: h & ~1 };
  }

  get canExport() {
    return !!this.scene && this.motion.keyframes.length >= 2;
  }

  async renderVideo(opts: RenderVideoOptions): Promise<RenderedVideo> {
    if (!this.scene) throw new Error('Load an image first');
    if (this.motion.keyframes.length < 2) throw new Error('Add at least 2 keyframes or pick a preset');
    this.pause();
    const { width, height } = this.exportSize(opts.shortSide);
    const t0 = performance.now();
    const res = await exportVideo(this.scene, this.motion, {
      width, height, fps: opts.fps, bitrate: opts.bitrate, format: opts.format, pingPong: opts.pingPong ?? this.pingPong,
      background: this.background, signal: opts.signal, onProgress: opts.onProgress,
    });
    const slug = this.motion.name.replace(/\W+/g, '-').toLowerCase();
    return {
      blob: res.blob,
      filename: `${this.baseName}-${slug}.${res.extension}`,
      extension: res.extension,
      codec: res.codec,
      seconds: (performance.now() - t0) / 1000,
    };
  }
}

export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export type { ControlMode, PivotPlacement, Preset, Keyframe, Motion, PathMode, Pose, EasingSpec };
