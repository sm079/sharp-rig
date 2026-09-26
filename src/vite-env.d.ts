/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where sharp.onnx and sharp.int8.bin are served from (default: models/ next to the app). */
  readonly VITE_MODEL_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
