// Right-hand panel: moves (presets, amount), camera pose, background and export.

import { downloadBlob, type Preset, type Studio } from '../../engine/studio';
import { SAVED_CATEGORY } from '../../engine/library';
import type { Disposer } from '../types';
import { h, icon, paintRange, setPills, showMenu } from './dom';
import { playPreview } from './presetPreview';
import { createColorPicker } from './colorPicker';

type Refs = Record<string, HTMLElement>;

/**
 * The nine moves shown before "Show all". Chosen for interiors (slow, level, architectural moves
 * that keep verticals straight) while still suiting exteriors, people and arbitrary photos.
 */
const FEATURED = ['slow-push', 'pull-out', 'truck-right', 'track-pan', 'pan-right', 'ped-up', 'orbit-left', 'float', 'sharp-rotate-forward'];

interface SideDeps {
  toast: (message: string, opts?: { kind?: 'info' | 'error'; action?: { label: string; run: () => void }; ms?: number }) => void;
  saveMotion: () => void;
}

export function createSide(studio: Studio, d: Disposer, r: Refs, deps: SideDeps) {
  const featuredOnly = { value: true };

  // ---------------------------------------------------------------- moves
  function tile(p: Preset) {
    const fr = h('div', { class: 'fr' });
    const b = h('button', {
      type: 'button', class: `pr${studio.activePreset === p.id ? ' on' : ''}`, title: p.description,
      dataset: { id: p.id }, attrs: { 'aria-pressed': String(studio.activePreset === p.id) },
      onclick: () => studio.applyPreset(p),
    }, h('div', { class: 'pv' }, fr), h('span', { class: 'n' }, p.name));
    let stop: (() => void) | null = null;
    const start = () => { stop?.(); stop = playPreview(fr, p); };
    const end = () => { stop?.(); stop = null; };
    b.addEventListener('pointerenter', start);
    b.addEventListener('pointerleave', end);
    b.addEventListener('focus', start);
    b.addEventListener('blur', end);
    return b;
  }

  function renderPresets() {
    const all = studio.presets();
    const grid = r.presets;
    if (featuredOnly.value) {
      const list = FEATURED.map((id) => all.find((p) => p.id === id)).filter((p): p is Preset => !!p);
      // Keep the active preset visible even when it isn't a featured one.
      const active = all.find((p) => p.id === studio.activePreset);
      if (active && !list.includes(active)) list[list.length - 1] = active;
      grid.replaceChildren(...list.map(tile));
      grid.classList.remove('all');
    } else {
      const parts: HTMLElement[] = [];
      for (const cat of studio.presetCategories()) {
        const items = all.filter((p) => p.category === cat);
        if (!items.length) continue;
        parts.push(h('div', { class: 'cat' }, cat));
        for (const p of items) {
          const t = tile(p);
          if (cat === SAVED_CATEGORY) {
            const index = Number(p.id.replace('saved-', ''));
            t.append(h('span', {
              class: 'del', title: 'Remove from My motions', attrs: { role: 'button', 'aria-label': `Remove ${p.name}` },
              onclick: (e: MouseEvent) => { e.stopPropagation(); studio.deleteSavedMotion(index); },
            }, icon('x')));
          }
          parts.push(t);
        }
      }
      grid.replaceChildren(...parts);
      grid.classList.add('all');
    }
    r.moreBtn.textContent = featuredOnly.value ? `Show all ${all.length} moves` : 'Show fewer';
    renderMoveInfo();
  }

  function renderActive() {
    for (const b of r.presets.querySelectorAll<HTMLElement>('.pr')) {
      const on = b.dataset.id === studio.activePreset;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    if (featuredOnly.value && studio.activePreset && !r.presets.querySelector(`.pr[data-id="${CSS.escape(studio.activePreset)}"]`)) renderPresets();
    renderMoveInfo();
  }

  function renderMoveInfo() {
    const n = studio.motion.keyframes.length;
    const custom = !studio.activePreset && n > 0;
    r.moveInfo.textContent = !studio.scene ? '' : studio.activePreset ? studio.motion.name : n ? `Custom · ${n} key${n === 1 ? '' : 's'}` : 'None';
    r.saveMove.hidden = !(custom && n >= 2);
  }

  r.moreBtn.onclick = () => { featuredOnly.value = !featuredOnly.value; renderPresets(); };
  r.saveMove.onclick = () => deps.saveMotion();

  // ---------------------------------------------------------------- amount
  // Scales how far the preset camera travels; it re-applies (and restarts) the active preset.
  const amount = r.amount as HTMLInputElement;
  const amountText = () => `${(Number(amount.value) / 50).toFixed(1)}×`;
  function renderAmount() {
    if (document.activeElement !== amount) amount.value = String(Math.round(studio.intensity * 50));
    paintRange(amount);
    r.amountOut.textContent = amountText();
    const preset = !!studio.activePreset;
    r.amountBox.classList.toggle('off', !preset);
    r.amountHint.textContent = preset
      ? 'How far the chosen move travels. The move restarts when you let go.'
      : 'Applies to the moves above. Your own keyframed moves aren\'t scaled.';
  }
  amount.oninput = () => { paintRange(amount); r.amountOut.textContent = amountText(); };
  amount.onchange = () => { studio.setIntensity(Number(amount.value) / 50); amount.blur(); };


  // ---------------------------------------------------------------- camera
  // Sliders edit the live camera; the Studio's auto-key captures it at the playhead. Ranges scale
  // with the scene's subject distance so they suit any photo.
  interface CamRow { input: HTMLInputElement; out: HTMLOutputElement; get: () => number; set: (v: number) => void; fmt: (v: number) => string; range: () => [number, number, number] }
  const F = () => studio.stats?.focusDepth ?? 3;
  const pos = (i: 0 | 1 | 2, sign = 1) => ({
    get: () => sign * studio.controller.pose.position[i],
    set: (v: number) => studio.editCamera((c) => { c.pose.position[i] = sign * v; }),
    fmt: (v: number) => `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(2)}`,
  });
  const ang = (i: 0 | 1 | 2) => ({
    get: () => studio.eulerDegrees()[i],
    set: (v: number) => studio.setEulerDegrees(i, v),
    fmt: (v: number) => `${Math.round(v)}°`,
  });
  const camDefs: [string, string, Omit<CamRow, 'input' | 'out'>][] = [
    ['Sideways', 'Move right (+) or left (−), in metres', { ...pos(0), range: () => [-0.5 * F(), 0.5 * F(), 0.001] }],
    ['Up / down', 'Move up (+) or down (−), in metres', { ...pos(1, -1), range: () => [-0.5 * F(), 0.5 * F(), 0.001] }],
    ['Forward', 'Move toward (+) or away from (−) the scene, in metres', { ...pos(2), range: () => [-0.6 * F(), 0.9 * F(), 0.001] }],
    ['Turn', 'Pan right (+) or left (−)', { ...ang(0), range: () => [-45, 45, 0.5] }],
    ['Tilt', 'Tilt up (+) or down (−)', { ...ang(1), range: () => [-35, 35, 0.5] }],
    ['Roll', 'Roll clockwise (+) or counter-clockwise (−)', { ...ang(2), range: () => [-45, 45, 0.5] }],
    ['Lens', '35 mm-equivalent focal length', {
      get: () => studio.focal35(), set: (v: number) => studio.setFocal35(v),
      fmt: (v: number) => `${Math.round(v)}mm`, range: () => [12, 150, 1],
    }],
  ];
  let camDragging = false;
  const camRows: CamRow[] = camDefs.map(([label, tip, def]) => {
    const input = h('input', { type: 'range', attrs: { 'aria-label': label } });
    const out = h('output', { class: 'num' });
    const row: CamRow = { ...def, input, out };
    input.addEventListener('pointerdown', () => (camDragging = true));
    input.addEventListener('input', () => {
      if (!studio.scene) return;
      row.set(Number(input.value));
      paintRange(input);
      out.textContent = row.fmt(row.get());
    });
    input.addEventListener('change', () => (camDragging = false));
    input.addEventListener('pointerup', () => (camDragging = false));
    r.camRows.append(h('div', { class: 'row', title: tip }, h('span', {}, label), input, out));
    return row;
  });

  const arm = r.arm as HTMLInputElement;
  arm.oninput = () => { studio.setArmLength(Number(arm.value)); paintRange(arm); };
  r.pivotPlace.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-v]');
    if (!b || !studio.scene) return;
    studio.placePivot(b.dataset.v as Parameters<Studio['placePivot']>[0]);
    lastPlacement = b.dataset.v!;
    setPills(r.pivotPlace, lastPlacement);
  };
  let lastPlacement: string | null = null;

  function renderCamera() {
    if (!studio.scene) return;
    const open = (r.camSec as HTMLDetailsElement).open;
    if (open) {
      for (const row of camRows) {
        const [min, max, step] = row.range();
        const v = row.get();
        if (!(camDragging && document.activeElement === row.input)) {
          row.input.min = String(min);
          row.input.max = String(max);
          row.input.step = String(step);
          row.input.value = String(Math.max(min, Math.min(max, v)));
          paintRange(row.input);
        }
        row.out.textContent = row.fmt(v);
      }
    }
    const orbit = studio.mode === 'pivot';
    r.orbitRows.hidden = !orbit;
    if (open && orbit) {
      const len = studio.controller.armLength;
      arm.min = String(0.05 * F());
      arm.max = String(Math.max(3 * F(), len));
      arm.step = String(0.001 * F());
      if (document.activeElement !== arm) arm.value = String(len);
      paintRange(arm);
      r.armOut.textContent = `${len.toFixed(2)} m`;
    }
  }

  // ---------------------------------------------------------------- background
  const picker = createColorPicker((rgb) => studio.setBackground(rgb));
  r.bgPicker.append(picker.el);

  function renderSettings() {
    renderAmount();
    picker.set(studio.background);
    if (studio.mode !== 'pivot') { lastPlacement = null; setPills(r.pivotPlace, null); }
    renderCamera();
  }

  // ---------------------------------------------------------------- export
  interface ExportPrefs { shortSide: number; fps: number; format: 'mp4' | 'webm' }
  const PREFS_KEY = 'sharprig.export';
  const prefs: ExportPrefs = (() => {
    const def: ExportPrefs = { shortSide: 1080, fps: 30, format: 'mp4' };
    try { return { ...def, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return def; }
  })();
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ } };
  const resLabel = (s: number) => (s === 2160 ? '4K' : `${s}p`);
  const bitrate = () => Math.round(({ 720: 8, 1080: 16, 1440: 26, 2160: 45 } as Record<number, number>)[prefs.shortSide] * (prefs.fps >= 60 ? 1.5 : 1));

  function renderExportMeta() {
    r.res.textContent = resLabel(prefs.shortSide);
    r.fps.textContent = `${prefs.fps} fps`;
    r.fmt.textContent = prefs.format.toUpperCase();
    r.direction.textContent = studio.pingPong ? 'Back & forth' : 'Forward';
    r.direction.title = studio.pingPong
      ? 'The video plays the move forward, then in reverse, so it loops seamlessly. Same as Back & forth playback.'
      : 'The video plays the move once, start to end.';
    const { width, height } = studio.exportSize(prefs.shortSide);
    r.res.title = `Resolution · ${width} × ${height}`;
  }
  r.res.onclick = () => showMenu(r.res, [720, 1080, 1440, 2160].map((s) => {
    const { width, height } = studio.exportSize(s);
    return { label: resLabel(s), hint: `${width} × ${height}`, checked: prefs.shortSide === s, onSelect: () => { prefs.shortSide = s; savePrefs(); renderExportMeta(); } };
  }), { side: 'above' });
  r.fps.onclick = () => showMenu(r.fps, [24, 30, 60].map((f) => ({
    label: `${f} fps`, checked: prefs.fps === f, onSelect: () => { prefs.fps = f; savePrefs(); renderExportMeta(); },
  })), { side: 'above' });
  r.fmt.onclick = () => showMenu(r.fmt, [
    { label: 'MP4', hint: 'H.264 · plays everywhere', checked: prefs.format === 'mp4', onSelect: () => { prefs.format = 'mp4'; savePrefs(); renderExportMeta(); } },
    { label: 'WebM', hint: 'VP9 · smaller files', checked: prefs.format === 'webm', onSelect: () => { prefs.format = 'webm'; savePrefs(); renderExportMeta(); } },
  ], { side: 'above', align: 'end' });

  r.direction.onclick = () => showMenu(r.direction, [
    { label: 'Forward', hint: 'Start → end', checked: !studio.pingPong, onSelect: () => studio.setPingPong(false) },
    { label: 'Back & forth', hint: 'Start → end → start · seamless loop', checked: studio.pingPong, onSelect: () => { studio.setPingPong(true); studio.setLoop(true); } },
  ], { side: 'above', align: 'end' });

  let exporting: AbortController | null = null;
  const exportBtn = r.export as HTMLButtonElement;
  function renderExportButton() {
    exportBtn.disabled = !exporting && (!studio.canExport || studio.busyText !== null);
    exportBtn.classList.toggle('running', !!exporting);
    if (!exporting) {
      r.exportLabel.textContent = 'Export video';
      r.exportFill.style.width = '0';
      exportBtn.title = studio.canExport ? 'Render and download · Ctrl E' : 'Pick a move or add two keyframes first';
    }
  }

  async function runExport() {
    if (exporting) { exporting.abort(); return; }
    if (!studio.canExport) return deps.toast('Pick a move or add two keyframes first', { kind: 'error' });
    exporting = new AbortController();
    renderExportButton();
    r.exportLabel.textContent = 'Preparing…';
    exportBtn.title = 'Click to cancel';
    const t0 = performance.now();
    try {
      const res = await studio.renderVideo({
        shortSide: prefs.shortSide, fps: prefs.fps, format: prefs.format, bitrate: bitrate(),
        signal: exporting.signal,
        onProgress: (done, n) => {
          const p = done / n;
          r.exportFill.style.width = `${p * 100}%`;
          const el = (performance.now() - t0) / 1000;
          const eta = done > 3 ? (el / done) * (n - done) : null;
          r.exportLabel.textContent = `Rendering ${Math.round(p * 100)}%${eta !== null ? ` · ${eta < 60 ? `${Math.ceil(eta)} s` : `${Math.ceil(eta / 60)} min`} left` : ''}`;
        },
      });
      downloadBlob(res.blob, res.filename);
      deps.toast(`Saved ${res.filename} · ${(res.blob.size / 1e6).toFixed(1)} MB in ${res.seconds.toFixed(1)} s`, { ms: 6000 });
    } catch (e) {
      if ((e as Error).name === 'AbortError') deps.toast('Export cancelled');
      else { console.error(e); deps.toast(`Export failed: ${(e as Error).message}`, { kind: 'error' }); }
    } finally {
      exporting = null;
      renderExportButton();
    }
  }
  exportBtn.onclick = () => void runExport();
  d.add(() => exporting?.abort());

  // ---------------------------------------------------------------- events
  (r.camSec as HTMLDetailsElement).addEventListener('toggle', renderCamera);
  d.add(studio.on('scene', () => { renderPresets(); renderSettings(); renderExportButton(); renderExportMeta(); }));
  d.add(studio.on('motion', () => { renderActive(); renderAmount(); renderExportButton(); }));
  d.add(studio.on('library', renderPresets));
  d.add(studio.on('settings', () => { renderSettings(); renderExportMeta(); }));
  d.add(studio.on('frame', renderCamera));
  d.add(studio.on('busy', renderExportButton));

  renderPresets();
  renderSettings();
  renderExportButton();
  renderExportMeta();

  return { exportVideo: () => void runExport() };
}
