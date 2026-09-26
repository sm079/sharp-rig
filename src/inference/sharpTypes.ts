// Messages exchanged with the SHARP worker.

export const SHARP_INTERNAL = 1536;

/** Every request carries an id; every response (including progress) echoes it. */
export type SharpWorkerRequest = { id: number } & (
  | {
      type: 'load';
      model: string | Uint8Array;
      /** external weights file name as referenced inside the .onnx, and its source */
      externalData?: { path: string; data: string | Uint8Array };
      /** int8 weight pack (URL, may be blob:) expanded into the external data in the worker */
      weightPack?: string;
      preferWebGpu: boolean;
    }
  | {
      type: 'run';
      /** RGBA pixels at SHARP_INTERNAL x SHARP_INTERNAL */
      pixels: Uint8ClampedArray;
      width: number;
      height: number;
      focalPx: number;
    }
);

/** Request body without the id (the main-thread facade assigns it). */
export type SharpWorkerCall = SharpWorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

export type SharpWorkerResponse = { id: number } & (
  | { type: 'loaded'; backend: string }
  | { type: 'progress'; stage: string }
  | {
      type: 'result';
      count: number;
      positions: Float32Array;
      covariances: Float32Array;
      colors: Uint8Array;
      ms: number;
      backend: string;
    }
  | { type: 'error'; message: string }
);

