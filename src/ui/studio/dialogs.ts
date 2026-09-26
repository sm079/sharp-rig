// Modal dialogs: SHARP model setup, keyboard shortcuts, and a small text prompt.

import { HOSTED_MODEL_SIZE, type Studio } from '../../engine/studio';
import { SHORTCUTS } from '../../engine/shortcuts';
import type { Disposer } from '../types';
import { h, icon } from './dom';

function shell(title: string, sub: string | null, d: Disposer, onClose?: () => void) {
  const body = h('div', { class: 'body' });
  const foot = h('div', { class: 'foot' });
  const dlg = h('dialog', { class: 'sr-dialog' },
    h('div', { class: 'head' },
      h('div', {}, h('h2', {}, title), sub ? h('p', { class: 'sub' }, sub) : null),
      h('button', { type: 'button', class: 'ghost', attrs: { 'aria-label': 'Close' }, onclick: () => close() }, icon('x'))),
    body, foot);
  const close = () => { onClose?.(); dlg.close(); };
  dlg.addEventListener('pointerdown', (e) => { if (e.target === dlg) close(); });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  d.add(() => dlg.remove());
  return { dlg, body, foot, close };
}

// ------------------------------------------------------------------ model

export function createModelDialog(studio: Studio, d: Disposer) {
  const { dlg, body, foot, close } = shell('3D model', 'SHARP turns your photo into a real 3D scene, right in your browser.', d);

  const statusText = h('div', { class: 'txt' });
  const bar = h('i');
  const barWrap = h('div', { class: 'progress' }, bar);
  const status = h('div', { class: 'model-status' }, h('span', { class: 'dot' }), statusText);

  const prefs = studio.modelPrefs;
  const url = h('input', { type: 'text', value: prefs.modelUrl, attrs: { 'aria-label': 'Graph URL' } });
  const dataUrl = h('input', { type: 'text', value: prefs.dataUrl, attrs: { 'aria-label': 'Weights URL' } });
  const auto = h('input', { type: 'checkbox', checked: prefs.autoLoad, onchange: () => studio.setModelPrefs({ autoLoad: auto.checked }) });
  const gpu = h('input', { type: 'checkbox', checked: prefs.preferWebGpu, onchange: () => studio.setModelPrefs({ preferWebGpu: gpu.checked }) });
  const graphFile = h('input', { type: 'file', accept: '.onnx', hidden: true });
  const dataFile = h('input', { type: 'file', hidden: true });
  const graphName = h('span', { class: 'fname' }, 'No file');
  const dataName = h('span', { class: 'fname' }, 'No file');
  graphFile.onchange = () => (graphName.textContent = graphFile.files?.[0]?.name ?? 'No file');
  dataFile.onchange = () => (dataName.textContent = dataFile.files?.[0]?.name ?? 'No file');

  const loadBtn = h('button', { type: 'button', class: 'btn pri', onclick: () => studio.loadModelFromUrl(url.value.trim(), dataUrl.value.trim()) }, 'Load model');

  body.append(
    status, barWrap,
    h('p', { class: 'note' }, 'Without the model, photos get a quick ', h('b', {}, 'preview depth'), ` so you can still design moves. SHARP downloads once (${HOSTED_MODEL_SIZE}) and is cached by the browser.`),
    ...('gpu' in navigator ? [] : [h('p', { class: 'note warn' }, 'This browser has no WebGPU, so SHARP would run on the CPU and take minutes per photo. A recent Chrome or Edge is recommended.')]),
    h('details', {},
      h('summary', {}, 'Load from your computer ', icon('down')),
      h('div', { class: 'files' },
        h('button', { type: 'button', class: 'btn', onclick: () => graphFile.click() }, 'Graph (.onnx)'), graphName,
        h('button', { type: 'button', class: 'btn', onclick: () => dataFile.click() }, 'Weights (.bin / .data)'), dataName),
      graphFile, dataFile,
      h('button', {
        type: 'button', class: 'btn', onclick: () => {
          const g = graphFile.files?.[0];
          if (!g) return studio.notify('Choose the .onnx graph file first', 'error');
          studio.loadModelFromFiles(g, dataFile.files?.[0]);
        },
      }, 'Load these files')),
    h('details', {},
      h('summary', {}, 'Advanced ', icon('down')),
      h('label', { class: 'field' }, h('span', {}, 'Graph URL'), url),
      h('label', { class: 'field' }, h('span', {}, 'Weights URL (int8 .bin or fp16 .onnx.data)'), dataUrl),
      h('label', { class: 'check' }, gpu, h('span', {}, 'Prefer WebGPU (falls back to WASM)')),
      h('label', { class: 'check' }, auto, h('span', {}, 'Load automatically when the model is hosted with the app'))));
  foot.append(h('button', { type: 'button', class: 'btn', onclick: close }, 'Close'), loadBtn);

  const render = () => {
    const s = studio.modelStatus;
    status.dataset.state = s.state;
    statusText.textContent = s.state === 'idle' ? 'Not loaded: photos use preview depth' : s.text;
    barWrap.hidden = s.state !== 'busy';
    barWrap.classList.toggle('indeterminate', s.percent === null);
    bar.style.width = s.percent !== null ? `${s.percent}%` : '';
    loadBtn.disabled = s.state === 'busy';
    loadBtn.textContent = s.state === 'ok' ? 'Reload model' : s.state === 'err' ? 'Try again' : `Download model (${HOSTED_MODEL_SIZE})`;
  };
  d.add(studio.on('model', (s) => { render(); if (s.state === 'ok' && dlg.open) setTimeout(close, 700); }));
  render();
  return { el: dlg, open: () => { if (!dlg.open) dlg.showModal(); } };
}

// ------------------------------------------------------------------ shortcuts

export function createHelpDialog(d: Disposer) {
  const { dlg, body, foot, close } = shell('Keyboard shortcuts', null, d);
  const keys = (s: string) => s.split(' / ').flatMap((k, i) => [i ? ' / ' : '', ...k.split(' ').map((p) => h('kbd', {}, p))]);
  const groups = [...SHORTCUTS, { group: 'This layout', items: [
    { keys: 'Ctrl E', label: 'Export video' },
    { keys: '− / =', label: 'Zoom the timeline out / in' },
    { keys: '\\', label: 'Show the whole timeline' },
    { keys: 'Ctrl Scroll', label: 'Zoom the timeline at the cursor' },
    { keys: 'Esc', label: 'Deselect' },
    { keys: '?', label: 'Viewport controls' },
  ] }];
  body.classList.add('help');
  body.append(...groups.map((g) => h('section', {},
    h('h3', {}, g.group),
    h('dl', {}, ...g.items.flatMap((it) => [h('dt', {}, ...keys(it.keys)), h('dd', {}, it.label)])))));
  foot.append(h('button', { type: 'button', class: 'btn', onclick: close }, 'Close'));
  return { el: dlg, open: () => { if (!dlg.open) dlg.showModal(); } };
}

// ------------------------------------------------------------------ prompt

export function createPromptDialog(d: Disposer) {
  let resolve: ((v: string | null) => void) | null = null;
  const finish = (v: string | null) => { resolve?.(v); resolve = null; };
  const { dlg, body, foot, close } = shell('', null, d, () => finish(null));
  const title = dlg.querySelector('h2')!;
  const input = h('input', { type: 'text', attrs: { 'aria-label': 'Name' } });
  const ok = h('button', { type: 'submit', class: 'btn pri' }, 'Save');
  const hint = h('p', { class: 'note' });
  const form = h('form', { class: 'field' }, input);
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return input.focus();
    finish(v);
    dlg.close();
  };
  ok.onclick = () => form.requestSubmit();
  body.append(form, hint);
  foot.append(h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel'), ok);
  return {
    el: dlg,
    ask(heading: string, value: string, okLabel = 'Save', note = ''): Promise<string | null> {
      hint.textContent = note;
      hint.hidden = !note;
      finish(null);
      title.textContent = heading;
      ok.textContent = okLabel;
      input.value = value;
      dlg.showModal();
      input.select();
      return new Promise((r) => (resolve = r));
    },
  };
}
