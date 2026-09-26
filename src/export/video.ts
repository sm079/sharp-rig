// Deterministic offline rendering of a motion to MP4 (H.264) or WebM (VP9/VP8) via WebCodecs.

import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer';
import { outputFocal } from '../camera/lens';
import { evaluate, type Motion } from '../motion/timeline';
import { SplatRenderer } from '../splat/renderer';
import type { SplatScene } from '../splat/scene';

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  /** Mbit/s */
  bitrate: number;
  format: 'mp4' | 'webm';
  pingPong: boolean;
  background: [number, number, number];
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  mime: string;
  extension: string;
  codec: string;
}

const H264_CODECS = ['avc1.640034', 'avc1.640033', 'avc1.640028', 'avc1.4d0034', 'avc1.4d0028', 'avc1.42003e', 'avc1.42001f'];
const WEBM_CODECS: [string, 'V_VP9' | 'V_VP8'][] = [['vp09.00.51.08', 'V_VP9'], ['vp09.00.41.08', 'V_VP9'], ['vp8', 'V_VP8']];

async function pickConfig(opts: ExportOptions): Promise<{ config: VideoEncoderConfig; format: 'mp4' | 'webm'; muxCodec?: 'V_VP9' | 'V_VP8' }> {
  const base = {
    width: opts.width,
    height: opts.height,
    bitrate: Math.round(opts.bitrate * 1e6),
    framerate: opts.fps,
  };
  const tryH264 = async () => {
    for (const codec of H264_CODECS) {
      const config: VideoEncoderConfig = { ...base, codec, avc: { format: 'avc' } };
      const s = await VideoEncoder.isConfigSupported(config).catch(() => null);
      if (s?.supported) return { config, format: 'mp4' as const };
    }
    return null;
  };
  const tryWebm = async () => {
    for (const [codec, muxCodec] of WEBM_CODECS) {
      const config: VideoEncoderConfig = { ...base, codec };
      const s = await VideoEncoder.isConfigSupported(config).catch(() => null);
      if (s?.supported) return { config, format: 'webm' as const, muxCodec };
    }
    return null;
  };
  const first = opts.format === 'mp4' ? await tryH264() : await tryWebm();
  const res = first ?? (opts.format === 'mp4' ? await tryWebm() : await tryH264());
  if (!res) throw new Error(`No supported video encoder for ${opts.width}×${opts.height} in this browser`);
  return res;
}

export function frameTimes(motion: Motion, fps: number, pingPong: boolean): number[] {
  const n = Math.max(1, Math.round(motion.duration * fps));
  const times: number[] = [];
  for (let i = 0; i < n; i++) times.push((i / (n - 1 || 1)) * motion.duration);
  if (pingPong) for (let i = n - 2; i > 0; i--) times.push(times[i]);
  return times;
}

export async function exportVideo(scene: SplatScene, motion: Motion, opts: ExportOptions): Promise<ExportResult> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error('This browser lacks WebCodecs (VideoEncoder). Use a recent Chrome, Edge or Safari.');
  }
  // Encoders need even dimensions.
  opts = { ...opts, width: opts.width & ~1, height: opts.height & ~1 };
  const { config, format, muxCodec } = await pickConfig(opts);

  const canvas = document.createElement('canvas');
  canvas.width = opts.width;
  canvas.height = opts.height;
  const renderer = new SplatRenderer(canvas);
  renderer.background = opts.background;
  renderer.setScene(scene);

  let mp4: Mp4Muxer<Mp4Target> | null = null;
  let webm: WebmMuxer<WebmTarget> | null = null;
  if (format === 'mp4') {
    mp4 = new Mp4Muxer({
      target: new Mp4Target(),
      video: { codec: 'avc', width: opts.width, height: opts.height, frameRate: opts.fps },
      fastStart: 'in-memory',
    });
  } else {
    webm = new WebmMuxer({
      target: new WebmTarget(),
      video: { codec: muxCodec!, width: opts.width, height: opts.height, frameRate: opts.fps },
    });
  }

  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (mp4) mp4.addVideoChunk(chunk, meta);
      else webm!.addVideoChunk(chunk, meta);
    },
    error: (e) => { encodeError = e instanceof Error ? e : new Error(String(e)); },
  });
  encoder.configure(config);

  const times = frameTimes(motion, opts.fps, opts.pingPong);
  const frameDurUs = 1e6 / opts.fps;
  try {
    for (let i = 0; i < times.length; i++) {
      if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (encodeError) throw encodeError;
      const pose = evaluate(motion, times[i])!;
      const f = outputFocal(scene, opts.width, opts.height, pose.zoom);
      await renderer.renderExact({ position: pose.position, rotation: pose.rotation, fx: f, fy: f });
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameDurUs), duration: Math.round(frameDurUs) });
      encoder.encode(frame, { keyFrame: i % (opts.fps * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 2));
      opts.onProgress?.(i + 1, times.length);
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    renderer.dispose();
  }

  if (mp4) {
    mp4.finalize();
    return { blob: new Blob([mp4.target.buffer], { type: 'video/mp4' }), mime: 'video/mp4', extension: 'mp4', codec: config.codec };
  }
  webm!.finalize();
  return { blob: new Blob([webm!.target.buffer], { type: 'video/webm' }), mime: 'video/webm', extension: 'webm', codec: config.codec };
}
