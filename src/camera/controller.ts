// The viewport IS the camera. This controller turns pointer / wheel / keyboard input into 6DoF
// pose changes, either freely (fly) or constrained to a pivot (rigid arm of fixed length).

import { quat, v3, type Vec3 } from '../math';
import { clonePose, identityPose, type Pose } from '../motion/timeline';

export type ControlMode = 'free' | 'pivot';
export type PivotPlacement = 'front' | 'rear' | 'left' | 'right' | 'top' | 'bottom';

export class CameraController {
  pose: Pose = identityPose();
  mode: ControlMode = 'free';
  pivot: Vec3 = [0, 0, 3];
  /** metres; drives movement speeds */
  sceneScale = 1;
  enabled = true;
  onChange: (source: 'user' | 'api') => void = () => {};

  private keys = new Set<string>();
  private drag: { button: number; x: number; y: number; shift: boolean } | null = null;
  private el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // ---------- pose API ----------

  setPose(p: Pose, source: 'user' | 'api' = 'api') {
    this.pose = clonePose(p);
    this.onChange(source);
  }

  get armLength() {
    return v3.dist(this.pose.position, this.pivot);
  }

  /** Move the pivot along the line of sight so it sits `len` from the camera. */
  setArmLength(len: number) {
    len = Math.max(1e-3, len);
    const dir = v3.norm(v3.sub(this.pivot, this.pose.position));
    this.pivot = v3.add(this.pose.position, v3.scale(dir, len));
    this.onChange('user');
  }

  placePivot(where: PivotPlacement, distance: number) {
    const local: Record<PivotPlacement, Vec3> = {
      front: [0, 0, distance], rear: [0, 0, -distance],
      left: [-distance, 0, 0], right: [distance, 0, 0],
      top: [0, -distance, 0], bottom: [0, distance, 0],
    };
    this.pivot = v3.add(this.pose.position, quat.rotate(this.pose.rotation, local[where]));
    this.onChange('user');
  }

  /** Rigidly rotate camera about the pivot (world-space rotation). */
  rigRotate(delta: [number, number, number, number]) {
    this.pose.position = v3.add(this.pivot, quat.rotate(delta, v3.sub(this.pose.position, this.pivot)));
    this.pose.rotation = quat.norm(quat.mul(delta, this.pose.rotation));
  }

  private right(): Vec3 {
    return quat.rotate(this.pose.rotation, [1, 0, 0]);
  }

  /** translate in camera-local axes */
  moveLocal(dx: number, dy: number, dz: number, withPivot = this.mode === 'pivot') {
    const d = quat.rotate(this.pose.rotation, [dx, dy, dz]);
    this.pose.position = v3.add(this.pose.position, d);
    if (withPivot) this.pivot = v3.add(this.pivot, d);
  }

  rotateLocal(yaw: number, pitch: number, roll: number) {
    // Yaw about world vertical keeps the horizon level; pitch/roll about camera axes.
    let q = this.pose.rotation;
    if (yaw) q = quat.mul(quat.axisAngle([0, 1, 0], yaw), q);
    if (pitch) q = quat.mul(q, quat.axisAngle([1, 0, 0], pitch));
    if (roll) q = quat.mul(q, quat.axisAngle([0, 0, 1], roll));
    this.pose.rotation = quat.norm(q);
  }

  // ---------- input ----------

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.el.setPointerCapture(e.pointerId);
    this.drag = { button: e.button, x: e.clientX, y: e.clientY, shift: e.shiftKey };
    this.el.focus();
  };

  private onMove = (e: PointerEvent) => {
    if (!this.drag || !this.enabled) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    const fine = e.altKey ? 0.2 : 1;
    const rot = 0.0025 * fine;
    const pan = this.drag.button === 1 || this.drag.button === 2 || this.drag.shift || e.shiftKey;
    if (pan) {
      const k = this.sceneScale * 0.0012 * fine;
      this.moveLocal(-dx * k, -dy * k, 0);
    } else if (this.mode === 'pivot') {
      const yaw = quat.axisAngle([0, 1, 0], dx * rot);
      const pitch = quat.axisAngle(this.right(), -dy * rot);
      this.rigRotate(quat.mul(yaw, pitch));
    } else {
      this.rotateLocal(dx * rot, -dy * rot, 0);
    }
    this.onChange('user');
  };

  private onUp = (e: PointerEvent) => {
    if (this.drag) this.el.releasePointerCapture?.(e.pointerId);
    this.drag = null;
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const steps = Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 100 || 1);
    if (e.altKey || e.ctrlKey) {
      this.pose.zoom = Math.min(8, Math.max(0.3, this.pose.zoom * Math.pow(1.04, -steps)));
    } else if (this.mode === 'pivot') {
      // dolly along the arm (the pivot stays put)
      const len = this.armLength;
      const next = Math.max(0.02 * this.sceneScale, len * Math.pow(1.05, steps));
      const dir = v3.norm(v3.sub(this.pose.position, this.pivot));
      this.pose.position = v3.add(this.pivot, v3.scale(dir, next));
    } else {
      this.moveLocal(0, 0, -steps * this.sceneScale * 0.02, false);
    }
    this.onChange('user');
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF'].includes(e.code) && !e.ctrlKey && !e.metaKey) {
      this.keys.add(e.code);
    }
  };

  /** Continuous keyboard motion; call every animation frame. Returns true if the pose changed. */
  tick(dt: number, shift: boolean): boolean {
    if (!this.enabled || this.keys.size === 0) return false;
    const speed = this.sceneScale * 0.25 * dt * (shift ? 3 : 1);
    const rs = 0.6 * dt;
    let dx = 0, dy = 0, dz = 0, roll = 0;
    if (this.keys.has('KeyW')) dz += speed;
    if (this.keys.has('KeyS')) dz -= speed;
    if (this.keys.has('KeyA')) dx -= speed;
    if (this.keys.has('KeyD')) dx += speed;
    if (this.keys.has('KeyR')) dy -= speed;
    if (this.keys.has('KeyF')) dy += speed;
    if (this.keys.has('KeyQ')) roll -= rs;
    if (this.keys.has('KeyE')) roll += rs;
    if (this.mode === 'pivot') {
      // A/D and R/F orbit the rig; W/S change arm length; Q/E roll.
      const yaw = quat.axisAngle([0, 1, 0], (-dx / Math.max(1e-3, this.armLength)));
      const pitch = quat.axisAngle(this.right(), (dy / Math.max(1e-3, this.armLength)));
      this.rigRotate(quat.mul(yaw, pitch));
      if (dz) {
        const dir = v3.norm(v3.sub(this.pose.position, this.pivot));
        const len = Math.max(0.02 * this.sceneScale, this.armLength - dz);
        this.pose.position = v3.add(this.pivot, v3.scale(dir, len));
      }
    } else {
      this.moveLocal(dx, dy, dz, false);
    }
    if (roll) this.rotateLocal(0, 0, roll);
    this.onChange('user');
    return true;
  }
}
