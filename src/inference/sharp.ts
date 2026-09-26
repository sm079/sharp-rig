// Main-thread facade over the SHARP worker.

import { rasterize, type LoadedImage } from './image';
import type { SplatScene } from '../splat/scene';
import SharpWorker from './sharpWorker?worker';
import { isWeightPackCached } from './weightPack';
import { SHARP_INTERNAL, type SharpWorkerCall, type SharpWorkerResponse } from './sharpTypes';

export type ModelSource =
  | { kind: 'url'; modelUrl: string; dataUrl?: string }
  | { kind: 'files'; model: File; data?: File };

/** The worker stopped answering (a hung GPU run, a crash): it has been reset and must be reloaded. */
export class SharpStalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SharpStalledError';
  }
}

/** How long a request may go without any message from the worker before it's considered hung. */
const QUIET_LIMIT_MS = { load: 5 * 60_000, gpu: 5 * 60_000, cpu: 20 * 60_000 };

type Progress = (stage: string) => void;

interface Pending {
  progress: Progress;
  resolve: (m: SharpWorkerResponse) => void;
  reject: (e: Error) => void;
  limit: number;
  timer: number;
}

export class SharpModel {
  private worker: Worker | null = null;
  backend: string | null = null;
  /** The last source loaded, so the model can be reloaded after the worker is reset. */
  lastSource: { src: ModelSource; preferWebGpu: boolean } | null = null;
  /** The worker was reset after a crash or hang; cleared by the next successful load. */
  crashed = false;
  /** Called when the worker is reset, so the owner can update its status. */
  onReset: (err: Error) => void = () => {};
  private seq = 0;
  private pending = new Map<number, Pending>();

  get loaded() {
    return this.backend !== null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new SharpWorker();
    // One dispatcher for every request: responses are routed by id, so overlapping calls can
    // never steal each other's result.
    w.onmessage = (e: MessageEvent<SharpWorkerResponse>) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') {
        p.progress(m.stage);
        if (/WASM|CPU/.test(m.stage)) p.limit = QUIET_LIMIT_MS.cpu;
        this.arm(m.id, p);
        return;
      }
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m);
    };
    w.onerror = (e) => this.reset(new SharpStalledError(`SHARP worker crashed${e.message ? `: ${e.message}` : ''}`));
    w.onmessageerror = () => this.reset(new SharpStalledError('SHARP worker sent an unreadable message'));
    return (this.worker = w);
  }

  /** (Re)start the watchdog for a request: any message from the worker counts as a sign of life. */
  private arm(id: number, p: Pending) {
    clearTimeout(p.timer);
    p.timer = window.setTimeout(() => {
      if (this.pending.get(id) === p) this.reset(new SharpStalledError('SHARP stopped responding; the model is being reloaded'));
    }, p.limit);
  }

  /** Kill the worker and fail everything in flight. The model has to be loaded again. */
  private reset(err: Error) {
    this.worker?.terminate();
    this.worker = null;
    this.backend = null;
    this.crashed = true;
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) { clearTimeout(p.timer); p.reject(err); }
    this.onReset(err);
  }

  private call(req: SharpWorkerCall, progress: Progress, transfer: Transferable[] = []): Promise<SharpWorkerResponse> {
    const worker = this.ensureWorker();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const p: Pending = {
        progress, resolve, reject, timer: 0,
        limit: req.type === 'load' ? QUIET_LIMIT_MS.load : this.backend === 'wasm' ? QUIET_LIMIT_MS.cpu : QUIET_LIMIT_MS.gpu,
      };
      this.pending.set(id, p);
      this.arm(id, p);
      worker.postMessage({ ...req, id }, transfer);
    });
  }

  /** Loads and runs are serialised: ORT handles one session build or run at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => {}).then(fn);
    this.queue = run;
    return run;
  }

  private loads = 0;

  /** True while a model load is queued or running. */
  get loading() {
    return this.loads > 0;
  }

  /** Load (or reload) the model. `onProgress` gets this load's status lines only. */
  load(src: ModelSource, preferWebGpu = true, onProgress: Progress = () => {}): Promise<void> {
    this.loads++;
    this.lastSource = { src, preferWebGpu };
    const run = this.enqueue(() => this.loadNow(src, preferWebGpu, onProgress));
    run.finally(() => this.loads--).catch(() => {});
    return run;
  }

  /** True when this source's weights are already cached, so loading won't download them. */
  isCached(src: ModelSource): Promise<boolean> {
    return src.kind === 'url' && src.dataUrl && isPack(src.dataUrl) ? isWeightPackCached(src.dataUrl) : Promise.resolve(false);
  }

  /** Resolves once any in-flight load has finished (successfully or not). */
  idle(): Promise<void> {
    return this.queue.then(() => {}, () => {});
  }

  private async loadNow(src: ModelSource, preferWebGpu: boolean, onProgress: Progress) {
    this.backend = null;
    let req: SharpWorkerCall;
    if (src.kind === 'url') {
      const modelUrl = new URL(src.modelUrl, location.href).href;
      const dataUrl = src.dataUrl ? new URL(src.dataUrl, location.href).href : undefined;
      req = isPack(dataUrl)
        ? { type: 'load', model: modelUrl, weightPack: dataUrl, preferWebGpu }
        : {
            type: 'load',
            model: modelUrl,
            externalData: dataUrl ? { path: basename(dataUrl), data: dataUrl } : undefined,
            preferWebGpu,
          };
    } else {
      onProgress('Reading model files…');
      const model = new Uint8Array(await src.model.arrayBuffer());
      if (src.data && isPack(src.data.name)) {
        req = { type: 'load', model, weightPack: URL.createObjectURL(src.data), preferWebGpu };
      } else {
        const data = src.data ? new Uint8Array(await src.data.arrayBuffer()) : undefined;
        req = {
          type: 'load',
          model,
          externalData: data && src.data ? { path: src.data.name, data } : undefined,
          preferWebGpu,
        };
      }
    }
    const res = await this.call(req, onProgress);
    if (res.type === 'loaded') {
      this.backend = res.backend;
      this.crashed = false;
    }
  }

  /** Predict Gaussians for an image. Runs after any queued load or prediction. */
  predict(img: LoadedImage, onProgress: Progress = () => {}): Promise<SplatScene> {
    return this.enqueue(() => this.predictNow(img, onProgress));
  }

  private async predictNow(img: LoadedImage, onProgress: Progress): Promise<SplatScene> {
    if (!this.loaded) throw new Error('Load the SHARP model first');
    // Same as sharp.cli.predict.predict_image: resize to the square internal resolution.
    const pixels = rasterize(img.bitmap, SHARP_INTERNAL, SHARP_INTERNAL);
    const res = await this.call(
      { type: 'run', pixels, width: img.width, height: img.height, focalPx: img.focalPx },
      onProgress,
      [pixels.buffer],
    );
    if (res.type !== 'result') throw new Error('Unexpected SHARP response');
    this.backend = res.backend;
    return {
      count: res.count,
      positions: res.positions,
      covariances: res.covariances,
      colors: res.colors,
      imageWidth: img.width,
      imageHeight: img.height,
      focalPx: img.focalPx,
      source: `SHARP (${this.backend}, ${(res.ms / 1000).toFixed(1)} s)`,
    };
  }
}

const isPack = (name?: string) => !!name && /\.bin($|\?)/i.test(name);

function basename(url: string) {
  return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'model.onnx.data');
}
