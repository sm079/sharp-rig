// Studio UI: a three-box editor layout.
//
//   ┌───────────────────────────────┬────────────┐
//   │ 3D viewport  ┌ shot ┐          │ photo  New │
//   │              └──────┘          │ moves      │
//   │ view · tool · reset  ? aspect  │ amount     │
//   ├───────────────────────────────┤ camera     │
//   │ ▶ time  keys · loop · zoom     │ background │
//   │ ─◆────◆────◆─ (zoomable)      │ [Export]   │
//   └───────────────────────────────┴────────────┘
//
// The canvas fills the whole viewport; the output frame is outlined inside it and everything
// outside the outline is dimmed (what the camera sees beyond the shot).

import css from './style.css?inline';
import markup from './markup.html?raw';
import { ASPECTS, HOSTED_MODEL_SIZE, downloadBlob, parseAspect, type Aspect } from '../../engine/studio';
import { bindShortcuts } from '../../engine/shortcuts';
import { Disposer, type StudioUI, type UIContext } from '../types';
import { closeMenus, createToasts, h, hydrateIcons, showMenu, type MenuItem } from './dom';
import { createHelpDialog, createModelDialog, createPromptDialog } from './dialogs';
import { createTimeline } from './timeline';
import { createSegmentEditor } from './segmentEditor';
import { createControlsHelp } from './controlsHelp';
import { createSide } from './side';

export const studioUI: StudioUI = {
  mount(root, ctx) {
    const d = new Disposer();
    d.style(css, 'studio');
    const font = h('link', { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap' });
    document.head.append(font);
    d.add(() => font.remove());
    build(root, ctx, d);
    return () => {
      closeMenus();
      d.dispose();
      root.innerHTML = '';
    };
  },
};

function build(root: HTMLElement, ctx: UIContext, d: Disposer) {
  const { studio } = ctx;

  // ---------------------------------------------------------------- skeleton
  const app = h('div', { class: 'sr app no-image' });
  app.innerHTML = markup;
  hydrateIcons(app);
  const r: Record<string, HTMLElement> = {};
  for (const el of app.querySelectorAll<HTMLElement>('[data-ref]')) r[el.dataset.ref!] = el;

  const toasts = createToasts();
  const toast = (message: string, opts?: Parameters<typeof toasts.show>[1]) => toasts.show(message, opts);
  d.add(studio.on('notify', ({ message, kind }) => toasts.show(message, { kind, ms: message === 'Undo' || message === 'Redo' ? 1200 : undefined })));

  const fileImage = h('input', { type: 'file', accept: 'image/*,.ply', hidden: true });
  const fileMotion = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const takeFile = (input: HTMLInputElement, fn: (f: File) => void) => {
    input.onchange = () => { const f = input.files?.[0]; if (f) fn(f); input.value = ''; };
  };
  takeFile(fileImage, (f) => studio.openFile(f));
  takeFile(fileMotion, (f) => studio.importMotion(f));
  const openPicker = () => fileImage.click();

  const modelDlg = createModelDialog(studio, d);
  const helpDlg = createHelpDialog(d);
  const promptDlg = createPromptDialog(d);

  app.append(toasts.el, fileImage, fileMotion, modelDlg.el, helpDlg.el, promptDlg.el);
  root.append(app);

  // ---------------------------------------------------------------- viewport
  const frame = studio.mount(r.stage, { padding: 14 });
  d.add(() => studio.unmount());
  const pivot = h('div', { class: 'pivot', hidden: true, title: 'Orbit point · drag onto the subject to move it' });
  const outlineLabel = h('span', { class: 'lbl' });
  const outline = h('div', { class: 'shot-outline', attrs: { 'aria-hidden': 'true' } }, outlineLabel);
  frame.append(outline, pivot);
  r.stage.prepend(frame);

  function renderOutline() {
    const o = studio.outputRect();
    outline.hidden = !studio.scene || studio.view !== 'camera';
    Object.assign(outline.style, { left: `${o.x}px`, top: `${o.y}px`, width: `${o.width}px`, height: `${o.height}px` });
    const { width, height } = studio.exportSize(1080);
    outlineLabel.textContent = `${aspectName(studio.aspect)} · ${width}×${height}`;
  }

  for (const b of r.view.querySelectorAll<HTMLButtonElement>('[data-view]')) b.onclick = () => studio.setView(b.dataset.view as 'camera' | 'director');
  for (const b of r.view.querySelectorAll<HTMLButtonElement>('[data-mode]')) b.onclick = () => studio.setMode(b.dataset.mode as 'free' | 'pivot');
  r.resetCam.onclick = () => studio.resetCamera();
  const controlsHelp = createControlsHelp(studio, d, r.helpBtn, app, () => helpDlg.open());

  const aspectName = (a: Aspect) => (a === 'source' ? 'Photo' : a);
  const aspectHint: Record<string, string> = { source: 'Match the photo', '16:9': 'Landscape', '9:16': 'Stories, Reels', '1:1': 'Square', '4:5': 'Portrait feed', '21:9': 'Cinema' };
  const isPreset = (a: Aspect) => (ASPECTS as readonly string[]).includes(a);
  r.aspect.onclick = () => {
    const items: MenuItem[] = ASPECTS.map((a) => ({
      label: aspectName(a), hint: aspectHint[a], checked: studio.aspect === a, onSelect: () => studio.setAspect(a),
    }));
    if (!isPreset(studio.aspect)) items.push({ label: studio.aspect, hint: 'Custom', checked: true, onSelect: () => {} });
    items.push('sep', { label: 'Custom…', hint: 'Any ratio', onSelect: () => void askAspect() });
    showMenu(r.aspect, items, { align: 'end', side: 'above' });
  };
  async function askAspect() {
    const current = isPreset(studio.aspect) ? '2.39:1' : studio.aspect;
    const text = await promptDlg.ask('Custom aspect ratio', current, 'Apply', 'Width : height, like 2.39:1, 3:2 or 1080:1350. Between 1:5 and 5:1.');
    if (text === null) return;
    const a = parseAspect(text);
    if (a) studio.setAspect(a);
    else studio.notify(`"${text}" isn't an aspect ratio. Use width:height, e.g. 3:2`, 'error');
  }

  // The orbit point can be dragged onto any surface in the picture.
  let pivotDrag: { id: number } | null = null;
  d.listen(pivot, 'pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    pivot.setPointerCapture(e.pointerId);
    pivotDrag = { id: e.pointerId };
    pivot.classList.add('dragging');
  });
  d.listen(pivot, 'pointermove', (e) => {
    if (!pivotDrag) return;
    const b = studio.canvas.getBoundingClientRect();
    pivot.style.transform = `translate(${e.clientX - b.left}px, ${e.clientY - b.top}px)`;
  });
  d.listen(pivot, 'pointerup', (e) => {
    if (!pivotDrag) return;
    pivotDrag = null;
    pivot.classList.remove('dragging');
    const b = studio.canvas.getBoundingClientRect();
    studio.setPivotAt(e.clientX - b.left, e.clientY - b.top);
    studio.invalidate();
  });
  d.listen(pivot, 'pointercancel', () => { pivotDrag = null; pivot.classList.remove('dragging'); studio.invalidate(); });

  // ---------------------------------------------------------------- drop zone
  r.pick.onclick = openPicker;
  r.sample.onclick = () => studio.openSample();
  // Not loaded yet: one click starts the download. Otherwise it opens the details.
  r.modelLine.onclick = () => (studio.modelStatus.state === 'idle' ? studio.loadModelFromUrl() : modelDlg.open());

  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  const setDragging = (on: boolean) => { app.classList.toggle('drag-on', on); r.drop.classList.toggle('hot', on); };
  d.listen(window, 'dragenter', (e) => { if (!hasFiles(e)) return; dragDepth++; setDragging(true); });
  d.listen(window, 'dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; setDragging(false); } });
  d.listen(window, 'dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  d.listen(window, 'drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    setDragging(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) studio.openFile(f);
  });

  // ---------------------------------------------------------------- thumbnail
  // A small JPEG of the photo for the header; for a .ply scene, a
  // snapshot of the first rendered frame.
  let thumb: { key: unknown; url: string } | null = null;
  function thumbnail(): string | null {
    const key = studio.image ?? studio.scene;
    if (!key) return null;
    if (thumb?.key === key) return thumb.url;
    const src: CanvasImageSource | null = studio.image?.bitmap ?? (studio.canvas.width ? studio.canvas : null);
    if (!src) return null;
    const sw = studio.image?.width ?? studio.canvas.width, sh = studio.image?.height ?? studio.canvas.height;
    const c = document.createElement('canvas');
    c.height = 120;
    c.width = Math.max(1, Math.round((120 * sw) / sh));
    c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
    thumb = { key, url: c.toDataURL('image/jpeg', 0.8) };
    return thumb.url;
  }

  // ---------------------------------------------------------------- panels
  const segEditor = createSegmentEditor(studio, d, app);
  const timeline = createTimeline(studio, d, r, {
    toast,
    editSegment: (i, anchor) => (i === null || !anchor ? segEditor.close() : segEditor.open(i, anchor)),
  });
  const side = createSide(studio, d, r, { toast, saveMotion });

  async function saveMotion() {
    const m = studio.motion;
    const name = await promptDlg.ask('Save to My motions', m.name === 'Untitled' ? 'My move' : `${m.name} (custom)`);
    if (name) studio.saveMotion(name);
  }

  r.newBtn.onclick = openPicker;
  r.fstatus.onclick = () => modelDlg.open();
  r.menu.onclick = () => {
    const has = !!studio.scene;
    const items: MenuItem[] = [
      { label: 'Open photo or .ply…', onSelect: openPicker },
      { label: 'Try the sample photo', onSelect: () => studio.openSample() },
      'sep',
      { label: 'Undo', hint: 'Ctrl Z', disabled: !studio.canUndo, onSelect: () => studio.undo() },
      { label: 'Redo', hint: 'Ctrl Shift Z', disabled: !studio.canRedo, onSelect: () => studio.redo() },
      'sep',
      { heading: 'Motion' },
      { label: 'Save to My motions…', disabled: !has || studio.motion.keyframes.length < 2, onSelect: () => void saveMotion() },
      { label: 'Import motion (.json)…', disabled: !has, onSelect: () => fileMotion.click() },
      { label: 'Download motion (.json)', disabled: !has, onSelect: () => { const f = studio.exportMotionJSON(); if (f) downloadBlob(f.blob, f.filename); } },
      { label: 'Clear keyframes', disabled: !studio.motion.keyframes.length, danger: true, onSelect: () => { studio.clearKeyframes(); toast('Keyframes cleared', { action: { label: 'Undo', run: () => studio.undo() } }); } },
      'sep',
      { label: 'Download 3D scene (.ply)', disabled: !has, onSelect: () => { const f = studio.exportPly(); if (f) downloadBlob(f.blob, f.filename); } },
      { label: '3D model settings…', onSelect: () => modelDlg.open() },
      { label: 'Keyboard shortcuts', onSelect: () => helpDlg.open() },
    ];
    showMenu(r.menu, items, { align: 'end' });
  };

  // ---------------------------------------------------------------- rendering
  function renderScene() {
    const has = !!studio.scene;
    app.classList.toggle('no-image', !has);
    app.classList.toggle('has-image', has);
    thumb = null;
    const url = thumbnail();
    r.thumb.style.backgroundImage = url ? `url("${url}")` : '';
    r.fname.textContent = has ? (studio.image?.name ?? studio.scene!.source.replace(/^PLY: /, '')) : 'No photo';
    r.fname.title = r.fname.textContent;
    renderStatus();
    renderOutline();
    if (has && !url) {
      // .ply: grab a thumbnail once the first frame is on screen.
      const off = studio.on('frame', () => {
        off();
        const u = thumbnail();
        if (u) r.thumb.style.backgroundImage = `url("${u}")`;
      });
    }
  }

  function renderStatus() {
    const s = studio.scene, m = studio.modelStatus;
    const pts = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`);
    let text: string, state: string, tip = m.text;
    if (studio.busyText !== null) { text = 'Building 3D…'; state = 'busy'; }
    else if (s?.source.startsWith('SHARP')) { text = `3D ready · ${pts(s.count)} points`; state = 'ok'; }
    else if (s?.source.startsWith('PLY')) { text = `3D from .ply · ${pts(s.count)} points`; state = 'ok'; }
    else if (s) {
      text = m.state === 'busy' ? `Preview depth · SHARP ${m.percent !== null ? `${m.percent}%` : 'loading'}` : 'Preview depth · set up SHARP';
      state = 'warn';
      tip = 'Approximate depth from a heuristic. Click to set up the SHARP model.';
    } else {
      text = m.state === 'busy' ? `Waiting for a photo · SHARP ${m.percent !== null ? `${m.percent}%` : 'loading'}` : 'Waiting for a photo';
      state = 'idle';
    }
    r.fstatus.textContent = text;
    r.fstatus.dataset.state = state;
    r.fstatus.title = `${tip}\nClick for 3D model settings`;

    const stub = m.state === 'ok' && /stub/i.test(m.text);
    r.modelLine.dataset.state = stub ? 'err' : m.state;
    r.modelText.textContent = stub ? 'Test stub model loaded, not SHARP'
      : m.state === 'ok' ? 'SHARP 3D model ready'
      : m.state === 'busy' ? `Loading SHARP 3D model${m.percent !== null ? ` · ${m.percent}%` : '…'}`
      : m.state === 'err' ? 'SHARP model failed to load · details'
      : `Load SHARP for real 3D · ${HOSTED_MODEL_SIZE}, downloaded once`;
  }

  function renderBusy(text: string | null) {
    app.classList.toggle('is-building', text !== null);
    r.buildText.textContent = text ?? '';
    const pct = text ? /(\d+(?:\.\d+)?)%/.exec(text)?.[1] : null;
    r.building.classList.toggle('indeterminate', !pct);
    r.buildBar.style.width = pct ? `${pct}%` : '';
    renderStatus();
  }

  function renderSettings() {
    for (const b of r.view.querySelectorAll<HTMLElement>('[data-view]')) {
      const on = b.dataset.view === studio.view;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    for (const b of r.view.querySelectorAll<HTMLElement>('[data-mode]')) {
      const on = b.dataset.mode === studio.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    r.aspectLabel.textContent = aspectName(studio.aspect);
    const ar = studio.aspectRatio();
    Object.assign(r.aspectGlyph.style, { width: `${ar >= 1 ? 14 : Math.round(14 * ar)}px`, height: `${ar >= 1 ? Math.round(14 / ar) : 14}px` });
    renderOutline();
    app.classList.toggle('is-director', studio.view === 'director');
  }

  function onFrame() {
    renderOutline();
    const p = studio.pivotScreen();
    pivot.hidden = !p;
    if (p && !pivotDrag) {
      pivot.classList.toggle('offscreen', p.offscreen);
      pivot.style.transform = `translate(${p.x}px, ${p.y}px)`;
      pivot.title = `Orbit point · ${p.behind ? 'behind the camera · ' : ''}${p.distance.toFixed(2)} m away\nDrag onto the subject to move it`;
    }
  }

  d.add(studio.on('scene', renderScene));
  d.add(studio.on('model', renderStatus));
  d.add(studio.on('busy', renderBusy));
  d.add(studio.on('settings', renderSettings));
  d.add(studio.on('frame', onFrame));
  d.add(studio.on('time', onFrame));
  d.add(studio.on('motion', onFrame));

  // ---------------------------------------------------------------- keyboard
  d.add(bindShortcuts(studio, (e) => {
    if (e.key === '?') { controlsHelp.toggle(); return true; }
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === '=' || e.key === '+') { timeline.zoomIn(); return true; }
      if (e.key === '-' || e.key === '_') { timeline.zoomOut(); return true; }
      if (e.code === 'Backslash') { timeline.zoomFit(); return true; }
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyE') { e.preventDefault(); side.exportVideo(); return true; }
    if ((e.code === 'Delete' || e.code === 'Backspace') && studio.selectedKeyframe) {
      studio.deleteSelectedKey();
      toast('Keyframe deleted', { action: { label: 'Undo', run: () => studio.undo() } });
      return true;
    }
    if (e.code === 'Escape' && (studio.selectedKey || studio.selectedSegment !== null)) {
      studio.selectKey(null);
      studio.selectSegment(null);
      return true;
    }
    return false;
  }));

  renderScene();
  renderSettings();
  renderBusy(studio.busyText);
  studio.invalidate();
}
