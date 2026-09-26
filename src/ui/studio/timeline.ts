// Timeline: transport + a zoomable, horizontally scrolling track.
//
//   scroll (overflow-x) › track (width = visible width × zoom) › inner (padded; everything inside
//   is positioned in % of the motion duration): ruler · lane (segments) · marks (keys) · playhead
//
// Zoom with the buttons, Ctrl/⌘-scroll (zooms at the cursor, also trackpad pinch) or − / = keys;
// "fit" (\) zooms all the way out. Plain scroll pans a zoomed timeline. During playback the view
// pages along to keep the playhead visible.

import type { Studio } from '../../engine/studio';
import type { Disposer } from '../types';
import { curveAreaPath, curveLabel, curvePath } from './curves';
import { h, icon, showMenu, type MenuItem } from './dom';

type Refs = Record<string, HTMLElement>;

const MAX_PX_PER_SEC = 2400;
const INNER_PAD = 12; // px, so the first / last diamonds are not clipped (keep in sync with CSS)

interface TimelineDeps {
  toast: (message: string, opts?: { action?: { label: string; run: () => void } }) => void;
  /** A segment was clicked: open its curve editor above `anchor` (viewport px), or close it (null). */
  editSegment: (index: number | null, anchor?: { x: number; top: number }) => void;
}

export function createTimeline(studio: Studio, d: Disposer, r: Refs, deps: TimelineDeps) {
  const { scroll, track, inner, ruler, lane, marks, playhead } = r;
  const length = r.length as HTMLInputElement;
  let zoom = 1;

  // ---------------------------------------------------------------- transport
  r.play.onclick = () => studio.togglePlay();
  r.addKey.onclick = () => studio.addKeyframe();
  const deleteKey = (id = studio.selectedKey) => {
    if (!id) return;
    studio.deleteKey(id);
    deps.toast('Keyframe deleted', { action: { label: 'Undo', run: () => studio.undo() } });
  };
  r.delKey.onclick = () => deleteKey();
  r.copyKey.onclick = () => studio.copyKey();
  r.pasteKey.onclick = () => studio.pasteKey();
  r.clearKeys.onclick = () => {
    studio.clearKeyframes();
    deps.toast('Keyframes cleared', { action: { label: 'Undo', run: () => studio.undo() } });
  };
  // Playback: once, loop, or back & forth. Back & forth is also what export renders.
  type PlayMode = 'once' | 'loop' | 'bounce';
  const playMode = (): PlayMode => (studio.pingPong ? 'bounce' : studio.loop ? 'loop' : 'once');
  const setPlayMode = (m: PlayMode) => { studio.setLoop(m !== 'once'); studio.setPingPong(m === 'bounce'); };
  const PLAY_MODES: { v: PlayMode; label: string; hint: string; icon: 'once' | 'loop' | 'bounce' }[] = [
    { v: 'once', label: 'Play once', hint: 'Stops at the end', icon: 'once' },
    { v: 'loop', label: 'Loop', hint: 'Repeats from the start', icon: 'loop' },
    { v: 'bounce', label: 'Back & forth', hint: 'Forward, then reverse · export too', icon: 'bounce' },
  ];
  r.loop.onclick = () => showMenu(r.loop, PLAY_MODES.map((m) => ({
    label: m.label, hint: m.hint, checked: playMode() === m.v, onSelect: () => setPlayMode(m.v),
  })), { side: 'above' });
  const commitLength = () => {
    const v = parseFloat(length.value);
    if (Number.isFinite(v) && v > 0) {
      // The length is the video's length: keep it for presets picked later, too.
      studio.setPresetDuration(v);
      studio.setDuration(v);
    }
    renderTime();
  };
  length.onchange = commitLength;
  length.onkeydown = (e) => {
    if (e.key === 'Enter') { commitLength(); length.blur(); }
    if (e.key === 'Escape') { length.value = studio.motion.duration.toFixed(1); length.blur(); }
  };

  // ---------------------------------------------------------------- zoom
  const dur = () => Math.max(1e-6, studio.motion.duration);
  const viewW = () => Math.max(1, scroll.clientWidth);
  const innerW = () => Math.max(1, track.clientWidth - 2 * INNER_PAD);
  const maxZoom = () => Math.max(1, (MAX_PX_PER_SEC * dur()) / viewW());

  /** Set the zoom, keeping the time under `anchorX` (px from the scroll box's left) in place. */
  function setZoom(z: number, anchorX = viewW() / 2) {
    z = Math.min(maxZoom(), Math.max(1, z));
    const t = timeAtScrollX(scroll.scrollLeft + anchorX);
    zoom = z;
    track.style.width = `${zoom * 100}%`;
    scroll.scrollLeft = INNER_PAD + (t / dur()) * innerW() - anchorX;
    renderZoom();
  }
  const timeAtScrollX = (x: number) => Math.max(0, Math.min(1, (x - INNER_PAD) / innerW())) * dur();

  function renderZoom() {
    (r.zoomOut as HTMLButtonElement).disabled = zoom <= 1.0001;
    (r.zoomFit as HTMLButtonElement).disabled = zoom <= 1.0001;
    (r.zoomIn as HTMLButtonElement).disabled = zoom >= maxZoom() - 1e-3;
    scroll.classList.toggle('zoomed', zoom > 1.0001);
    renderRuler();
    renderLaneLabels();
  }

  r.zoomIn.onclick = () => setZoom(zoom * 2, playheadAnchor());
  r.zoomOut.onclick = () => setZoom(zoom / 2, playheadAnchor());
  r.zoomFit.onclick = () => setZoom(1);
  /** Zoom buttons keep the playhead put when it's on screen. */
  const playheadAnchor = () => {
    const x = INNER_PAD + (studio.time / dur()) * innerW() - scroll.scrollLeft;
    return x >= 0 && x <= viewW() ? x : viewW() / 2;
  };

  d.listen(scroll, 'wheel', (e) => {
    const b = scroll.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), e.clientX - b.left);
    } else if (zoom > 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      scroll.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 20 : 1);
    }
  }, { passive: false });

  // ---------------------------------------------------------------- rendering
  const pct = (t: number) => `${(t / dur()) * 100}%`;

  function renderRuler() {
    const w = innerW();
    // Label every `major` seconds, at least ~80 px apart; four minor ticks per label.
    const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    const major = steps.find((s) => (s / dur()) * w >= 80) ?? 60;
    const minor = major / 4;
    const decimals = major < 0.1 ? 2 : major < 1 ? (major === 0.25 ? 2 : 1) : 0;
    const html: string[] = [];
    const n = Math.floor(dur() / minor + 1e-6);
    for (let i = 0; i <= n; i++) {
      const t = i * minor;
      const m = i % 4 === 0;
      html.push(`<div class="tick${m ? ' m' : ''}" style="left:${pct(t)}">${m ? `<label>${t.toFixed(decimals)}s</label>` : ''}</div>`);
    }
    ruler.innerHTML = html.join('');
  }

  function renderLane() {
    const ks = studio.motion.keyframes;
    const segs: HTMLElement[] = [];
    for (let i = 0; i < ks.length - 1; i++) {
      const a = ks[i], b = ks[i + 1];
      const el = h('div', {
        class: `lseg${studio.selectedSegment === i ? ' sel' : ''}`,
        dataset: { seg: String(i) },
        style: { left: pct(a.time), width: pct(b.time - a.time) },
        title: `Segment ${i + 1} · ${curveLabel(a.easing)}\nClick to edit its curve`,
      });
      // The segment's own easing curve (progress over time), stretched to fill the segment.
      el.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">`
        + `<path class="area" d="${curveAreaPath(a.easing, 100, 100, 64)}"/>`
        + `<path class="line" d="${curvePath(a.easing, 100, 100, 0, 64)}"/></svg>`;
      el.append(h('span', {}, curveLabel(a.easing)));
      segs.push(el);
    }
    lane.replaceChildren(...segs);
    lane.classList.toggle('none', ks.length < 2);
    lane.dataset.hint = ks.length === 0 ? 'No keyframes · pick a move or press Add keyframe' : ks.length === 1 ? 'Add another keyframe to make a move' : '';
    renderLaneLabels();
  }

  /** Hide segment labels that don't fit. */
  function renderLaneLabels() {
    const w = innerW();
    for (const s of lane.querySelectorAll<HTMLElement>('.lseg')) {
      s.classList.toggle('narrow', (parseFloat(s.style.width) / 100) * w < 64);
    }
  }

  function renderMarks() {
    marks.replaceChildren(...studio.motion.keyframes.map((k) => h('div', {
      class: `kf${k.id === studio.selectedKey ? ' sel' : ''}${k.pivot ? ' pv' : ''}`,
      dataset: { key: k.id },
      style: { left: pct(k.time) },
      title: `${k.time.toFixed(2)} s${k.pivot ? ' · orbit key' : ''}\nDrag to move · right-click for copy / delete`,
      attrs: { role: 'button', 'aria-label': `Keyframe at ${k.time.toFixed(2)} seconds` },
    })));
    const sel = !!studio.selectedKeyframe;
    r.copyKey.hidden = !sel;
    r.delKey.hidden = !sel;
    r.pasteKey.hidden = !studio.keyClipboard;
    (r.clearKeys as HTMLButtonElement).disabled = studio.motion.keyframes.length === 0;
    renderAddLabel();
  }

  /** Camera changes are keyed automatically, so "Add" is only for holding the current view. */
  function renderAddLabel() {
    const t = Math.round(studio.time * 100) / 100;
    const onKey = studio.motion.keyframes.some((k) => Math.abs(k.time - t) < 0.02);
    const b = r.addKey as HTMLButtonElement;
    b.disabled = !studio.scene || onKey;
    b.title = onKey ? 'There is already a keyframe here; camera changes update it automatically'
      : 'Keyframe the camera at the playhead · K\nCamera changes are keyed automatically';
  }

  function renderTime() {
    const t = studio.time;
    playhead.style.left = pct(t);
    r.tc.replaceChildren(h('b', {}, t.toFixed(2)), ` / ${studio.motion.duration.toFixed(2)} s`);
    if (document.activeElement !== length) length.value = studio.motion.duration.toFixed(1);
    renderAddLabel();
    if (studio.playing && zoom > 1) follow();
  }

  /** Page the view along so the playhead stays visible during playback. */
  function follow() {
    const x = INNER_PAD + (studio.time / dur()) * innerW();
    const left = scroll.scrollLeft, w = viewW();
    if (x < left + 8 || x > left + w - 8) scroll.scrollLeft = x - w * 0.1;
  }

  function renderMotion() {
    const has = !!studio.scene;
    r.laneEmpty.hidden = has;
    track.hidden = !has;
    r.mname.textContent = studio.scene ? studio.motion.name : '';
    renderRuler();
    renderLane();
    renderMarks();
    renderTime();
    renderPlayback();
    renderZoom();
  }

  function renderPlayback() {
    const playing = studio.playing;
    r.play.replaceChildren(icon(playing ? 'pause' : 'play'));
    r.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    (r.play as HTMLButtonElement).disabled = !studio.scene || studio.motion.keyframes.length < 2;
  }

  function renderSettings() {
    const m = PLAY_MODES.find((x) => x.v === playMode())!;
    r.loopIcon.replaceChildren(icon(m.icon));
    r.loop.classList.toggle('on', m.v !== 'once');
    r.loop.title = `Playback: ${m.label.toLowerCase()}${m.v === 'bounce' ? ' (the exported video plays forward, then in reverse)' : ''}`;
  }

  // ---------------------------------------------------------------- pointer interaction
  // Diamonds: select + drag to retime. Ruler: scrub. Lane: click a segment to select it, click
  // empty space to seek, drag to scrub. Dragging past either edge scrolls a zoomed timeline.
  let drag: { kind: 'key' | 'scrub' | 'maybe'; id?: string; x: number; seg?: number; lastX: number } | null = null;
  const timeAt = (clientX: number) => {
    const b = inner.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - b.left) / Math.max(1, b.width))) * dur();
  };

  d.listen(inner, 'pointerdown', (e) => {
    if (!studio.scene || e.button !== 0) return;
    const target = e.target as HTMLElement;
    const kf = target.closest<HTMLElement>('.kf');
    inner.setPointerCapture(e.pointerId);
    if (kf) {
      const id = kf.dataset.key!;
      studio.pause();
      studio.selectSegment(null);
      studio.selectKey(id);
      const k = studio.selectedKeyframe;
      if (k) studio.seek(k.time);
      drag = { kind: 'key', id, x: e.clientX, lastX: e.clientX };
    } else if (target.closest('.ruler')) {
      studio.scrub(timeAt(e.clientX));
      drag = { kind: 'scrub', x: e.clientX, lastX: e.clientX };
    } else {
      const seg = target.closest<HTMLElement>('.lseg');
      drag = { kind: 'maybe', x: e.clientX, lastX: e.clientX, seg: seg ? Number(seg.dataset.seg) : undefined };
    }
    e.preventDefault();
  });

  function dragTo(clientX: number) {
    if (!drag) return;
    if (drag.kind === 'scrub') studio.scrub(timeAt(clientX));
    else if (drag.kind === 'key' && Math.abs(clientX - drag.x) > 2) studio.retimeKey(drag.id!, timeAt(clientX));
  }

  let edgeTimer = 0;
  d.listen(inner, 'pointermove', (e) => {
    if (!drag) return;
    drag.lastX = e.clientX;
    if (drag.kind === 'maybe' && Math.abs(e.clientX - drag.x) > 3) drag.kind = 'scrub';
    dragTo(e.clientX);
    // Auto-scroll while the pointer is held past an edge.
    const b = scroll.getBoundingClientRect();
    const over = e.clientX < b.left + 12 ? -1 : e.clientX > b.right - 12 ? 1 : 0;
    clearInterval(edgeTimer);
    if (over && zoom > 1) {
      edgeTimer = window.setInterval(() => {
        if (!drag) return clearInterval(edgeTimer);
        scroll.scrollLeft += over * 14;
        dragTo(drag.lastX);
      }, 30);
    }
  });

  const endDrag = (e: PointerEvent) => {
    clearInterval(edgeTimer);
    if (!drag) return;
    if (drag.kind === 'maybe') {
      studio.selectKey(null);
      if (drag.seg !== undefined) {
        const again = studio.selectedSegment === drag.seg;
        studio.selectSegment(again ? null : drag.seg);
        deps.editSegment(again ? null : drag.seg, { x: e.clientX, top: lane.getBoundingClientRect().top });
      } else {
        studio.selectSegment(null);
        deps.editSegment(null);
        studio.scrub(timeAt(e.clientX));
      }
    }
    drag = null;
  };
  d.listen(inner, 'pointerup', endDrag);
  d.listen(inner, 'pointercancel', () => { clearInterval(edgeTimer); drag = null; });
  d.add(() => clearInterval(edgeTimer));

  // Right-click: on a diamond, act on that keyframe; elsewhere on the lane, act at that time.
  d.listen(inner, 'contextmenu', (e) => {
    if (!studio.scene) return;
    e.preventDefault();
    const kf = (e.target as HTMLElement).closest<HTMLElement>('.kf');
    const anchor = h('div', { class: 'menu-anchor', style: { left: `${e.clientX}px`, top: `${e.clientY}px` } });
    (inner.closest('.sr') ?? document.body).append(anchor);
    let items: MenuItem[];
    if (kf) {
      const id = kf.dataset.key!;
      const k = studio.motion.keyframes.find((x) => x.id === id)!;
      studio.selectSegment(null);
      studio.selectKey(id);
      items = [
        { heading: `Keyframe at ${k.time.toFixed(2)} s` },
        { label: 'Copy', hint: 'Ctrl C', onSelect: () => studio.copyKey(id) },
        { label: 'Paste over it', disabled: !studio.keyClipboard, onSelect: () => studio.pasteKey(k.time) },
        { label: 'Go to keyframe', onSelect: () => studio.scrub(k.time) },
        'sep',
        { label: 'Delete', hint: 'Del', danger: true, onSelect: () => deleteKey(id) },
      ];
    } else {
      const t = Math.round(timeAt(e.clientX) * 100) / 100;
      items = [
        { heading: `At ${t.toFixed(2)} s` },
        { label: 'Paste keyframe here', hint: 'Ctrl V', disabled: !studio.keyClipboard, onSelect: () => studio.pasteKey(t) },
        { label: 'Add keyframe here', onSelect: () => { studio.scrub(t); studio.addKeyframe({ advance: false }); } },
      ];
    }
    showMenu(anchor, items);
    setTimeout(() => anchor.remove(), 0);
  });

  const ro = new ResizeObserver(() => {
    track.style.width = `${zoom * 100}%`;
    renderRuler();
    renderLaneLabels();
  });
  ro.observe(scroll);
  d.add(() => ro.disconnect());

  // ---------------------------------------------------------------- events
  d.add(studio.on('scene', () => { zoom = 1; track.style.width = '100%'; renderMotion(); }));
  d.add(studio.on('motion', () => { zoom = Math.min(zoom, maxZoom()); track.style.width = `${zoom * 100}%`; renderMotion(); }));
  d.add(studio.on('selection', () => { renderLane(); renderMarks(); }));
  d.add(studio.on('time', renderTime));
  d.add(studio.on('playback', renderPlayback));
  d.add(studio.on('settings', renderSettings));

  track.style.width = '100%';
  renderMotion();
  renderSettings();

  return {
    zoomIn: () => setZoom(zoom * 2, playheadAnchor()),
    zoomOut: () => setZoom(zoom / 2, playheadAnchor()),
    zoomFit: () => setZoom(1),
  };
}
