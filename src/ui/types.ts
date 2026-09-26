// Contract between the Studio engine and a UI. The engine knows nothing about layout: a UI
// builds itself inside a root element around a live Studio, and returns a cleanup function that
// removes everything it added (DOM, listeners, styles), leaving the Studio untouched.

import type { Studio } from '../engine/studio';

export interface UIContext {
  studio: Studio;
}

export interface StudioUI {
  /** Build the UI inside `root`. Returns a cleanup function that removes every listener it added. */
  mount(root: HTMLElement, ctx: UIContext): () => void;
}

export class Disposer {
  private fns: (() => void)[] = [];

  add(fn: () => void) {
    this.fns.push(fn);
    return fn;
  }

  listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void;
  listen<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions): void;
  listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions) {
    target.addEventListener(type, fn, opts);
    this.fns.push(() => target.removeEventListener(type, fn, opts));
  }

  /** Mount a stylesheet (imported with `?inline`) for the lifetime of the UI. */
  style(css: string, id: string) {
    const el = document.createElement('style');
    el.dataset.ui = id;
    el.textContent = css;
    document.head.appendChild(el);
    this.fns.push(() => el.remove());
  }

  dispose() {
    for (const fn of this.fns.splice(0).reverse()) {
      try { fn(); } catch (e) { console.error(e); }
    }
  }
}
