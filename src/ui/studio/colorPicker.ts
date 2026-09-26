// Inline colour picker: curated swatches, a saturation / brightness square, a hue slider and a
// hex field. Works in sRGB 0…1, which is what the renderer clears to.

import { h } from './dom';

export type RGB = [number, number, number];

/** Neutral and muted tones that sit well behind photos (interiors, products, people). */
const SWATCHES: { hex: string; name: string }[] = [
  { hex: '#000000', name: 'Black' },
  { hex: '#1c1c1f', name: 'Charcoal' },
  { hex: '#5a5a5f', name: 'Graphite' },
  { hex: '#9a9aa0', name: 'Grey' },
  { hex: '#d9d9dc', name: 'Light grey' },
  { hex: '#ffffff', name: 'White' },
  { hex: '#e9dfd1', name: 'Warm beige' },
  { hex: '#b9c7d6', name: 'Soft sky' },
];

const rgbToHex = (c: readonly number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;

function hexToRgb(hex: string): RGB | null {
  let m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())?.[1];
  const short = /^#?([0-9a-f]{3})$/i.exec(hex.trim())?.[1];
  if (!m && short) m = [...short].map((ch) => ch + ch).join('');
  if (!m) return null;
  return [0, 2, 4].map((i) => parseInt(m!.slice(i, i + 2), 16) / 255) as RGB;
}

function rgbToHsv([r, g, b]: RGB): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hue = 0;
  if (d > 1e-6) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return [hue, max ? d / max : 0, max];
}

function hsvToRgb(hue: number, s: number, v: number): RGB {
  const f = (n: number) => {
    const k = (n + hue / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

export function createColorPicker(onChange: (rgb: RGB) => void) {
  // Hue is kept separately so it doesn't jump when saturation or brightness reaches 0.
  let hsv: [number, number, number] = [0, 0, 0];

  const swatches = h('div', { class: 'cp-swatches', attrs: { role: 'group', 'aria-label': 'Preset colours' } },
    ...SWATCHES.map((s) => h('button', {
      type: 'button', class: 'cp-sw', title: s.name, dataset: { hex: s.hex }, style: { '--c': s.hex },
      attrs: { 'aria-label': s.name }, onclick: () => apply(hexToRgb(s.hex)!, true),
    })));
  const knob = h('span', { class: 'cp-knob' });
  const area = h('div', { class: 'cp-area', attrs: { role: 'slider', 'aria-label': 'Saturation and brightness', tabindex: '0' } }, knob);
  const hue = h('input', { type: 'range', class: 'cp-hue', min: '0', max: '360', step: '1', attrs: { 'aria-label': 'Hue' } });
  const preview = h('span', { class: 'cp-preview' });
  const hex = h('input', { type: 'text', class: 'cp-hex num', maxLength: 7, spellcheck: false, attrs: { 'aria-label': 'Hex colour' } });
  const el = h('div', { class: 'cp' }, swatches, area, h('div', { class: 'cp-row' }, preview, hue, hex));

  const emit = () => onChange(hsvToRgb(...hsv));

  function paint() {
    const [hh, s, v] = hsv;
    const rgb = hsvToRgb(hh, s, v);
    const hx = rgbToHex(rgb);
    area.style.setProperty('--hue', `hsl(${hh}deg 100% 50%)`);
    knob.style.left = `${s * 100}%`;
    knob.style.top = `${(1 - v) * 100}%`;
    knob.style.background = hx;
    hue.value = String(Math.round(hh));
    preview.style.background = hx;
    if (document.activeElement !== hex) hex.value = hx;
    for (const b of swatches.querySelectorAll<HTMLElement>('.cp-sw')) b.classList.toggle('on', b.dataset.hex === hx);
    area.setAttribute('aria-valuetext', hx);
  }

  function apply(rgb: RGB, fire: boolean) {
    const [hh, s, v] = rgbToHsv(rgb);
    // Keep the hue for greys so the square doesn't snap back to red.
    hsv = [s > 1e-3 && v > 1e-3 ? hh : hsv[0], s, v];
    paint();
    if (fire) emit();
  }

  // Saturation / brightness square.
  const fromPointer = (e: PointerEvent) => {
    const r = area.getBoundingClientRect();
    hsv[1] = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    hsv[2] = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
    paint();
    emit();
  };
  let dragging = false;
  area.addEventListener('pointerdown', (e) => { dragging = true; area.setPointerCapture(e.pointerId); fromPointer(e); });
  area.addEventListener('pointermove', (e) => { if (dragging) fromPointer(e); });
  area.addEventListener('pointerup', () => (dragging = false));
  area.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const m = d[e.key];
    if (!m) return;
    e.preventDefault();
    hsv[1] = Math.max(0, Math.min(1, hsv[1] + m[0]));
    hsv[2] = Math.max(0, Math.min(1, hsv[2] + m[1]));
    paint();
    emit();
  });

  hue.addEventListener('input', () => {
    hsv[0] = Number(hue.value);
    // Picking a hue on a grey would do nothing; give it some colour.
    if (hsv[1] < 0.05) hsv[1] = 0.5;
    if (hsv[2] < 0.05) hsv[2] = 0.6;
    paint();
    emit();
  });

  hex.addEventListener('input', () => {
    const rgb = hexToRgb(hex.value);
    hex.classList.toggle('bad', !rgb);
    if (rgb) apply(rgb, true);
  });
  hex.addEventListener('blur', () => { hex.classList.remove('bad'); paint(); });
  hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') hex.blur(); });

  return {
    el,
    /** Reflect the current colour without firing onChange (skipped while the user is dragging). */
    set(rgb: readonly number[]) {
      if (dragging) return;
      if (rgbToHex(rgb) === rgbToHex(hsvToRgb(...hsv))) return;
      apply([rgb[0], rgb[1], rgb[2]], false);
    },
  };
}
