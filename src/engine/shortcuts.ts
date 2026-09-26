// Default keyboard shortcuts for any UI. (WASD / QE / RF camera keys live in the controller.)

import type { Studio } from './studio';

export interface Shortcut { keys: string; label: string }

export const SHORTCUTS: { group: string; items: Shortcut[] }[] = [
  { group: 'Playback', items: [
    { keys: 'Space', label: 'Play / pause' },
    { keys: 'Home / End', label: 'Jump to start / end' },
    { keys: ', / .', label: 'Previous / next keyframe' },
  ] },
  { group: 'Keyframes', items: [
    { keys: 'K', label: 'Add keyframe at playhead (camera changes are keyed automatically)' },
    { keys: 'Del', label: 'Delete selected keyframe' },
    { keys: 'Ctrl C / Ctrl V', label: 'Copy keyframe / paste at playhead' },
    { keys: 'Ctrl Z / Ctrl Shift Z', label: 'Undo / redo' },
  ] },
  { group: 'Camera', items: [
    { keys: '1 / 2', label: 'Free fly / orbit pivot' },
    { keys: 'C / V', label: 'Camera / director view' },
    { keys: 'Drag', label: 'Look (free) · swing around pivot (orbit)' },
    { keys: 'Shift drag', label: 'Move sideways / up-down' },
    { keys: 'Wheel', label: 'Dolly in / out' },
    { keys: 'Alt wheel', label: 'Zoom lens' },
    { keys: 'W A S D', label: 'Move · R / F up / down' },
    { keys: 'Q / E', label: 'Roll' },
  ] },
];

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

/** Bind the default shortcuts. Returns an unbind function. */
export function bindShortcuts(studio: Studio, extra?: (e: KeyboardEvent) => boolean): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    if (document.querySelector('dialog[open]')) return;
    if (extra?.(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) studio.redo(); else studio.undo();
      return;
    }
    if (mod && e.code === 'KeyY') { e.preventDefault(); studio.redo(); return; }
    if (mod && e.code === 'KeyC' && studio.selectedKey && !getSelection()?.toString()) { e.preventDefault(); studio.copyKey(); return; }
    if (mod && e.code === 'KeyV' && studio.keyClipboard) { e.preventDefault(); studio.pasteKey(); return; }
    if (mod || e.altKey) return;
    switch (e.code) {
      case 'Space': e.preventDefault(); studio.togglePlay(); break;
      case 'KeyK': studio.addKeyframe(); break;
      case 'Delete': case 'Backspace': studio.deleteSelectedKey(); break;
      case 'Digit1': studio.setMode('free'); break;
      case 'Digit2': studio.setMode('pivot'); break;
      case 'KeyC': studio.setView('camera'); break;
      case 'KeyV': studio.setView('director'); break;
      case 'Home': studio.scrub(0); break;
      case 'End': studio.scrub(studio.motion.duration); break;
      case 'Comma': studio.jumpKey(-1); break;
      case 'Period': studio.jumpKey(1); break;
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
