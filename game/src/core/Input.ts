import { settings } from './Settings';

export interface TouchStick {
  active: boolean;
  x: number;
  y: number;
  id: number;
  originX: number;
  originY: number;
}

/**
 * Unified keyboard/mouse/touch input.
 * Pointer lock + raw mouse deltas for desktop; virtual stick + look-drag for
 * touch devices. Actions are polled (held) while events fire once.
 */
export class Input {
  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private releasedThisFrame = new Set<string>();

  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  pointerLocked = false;

  mouseDown = new Set<number>();
  mousePressed = new Set<number>();

  /** Touch support */
  isTouch = false;
  leftStick: TouchStick = { active: false, x: 0, y: 0, id: -1, originX: 0, originY: 0 };
  rightStick: TouchStick = { active: false, x: 0, y: 0, id: -1, originX: 0, originY: 0 };
  private lookTouchId = -1;
  private lastLookX = 0;
  private lastLookY = 0;
  /** Virtual buttons pressed via DOM overlay (mobile HUD). */
  private virtualHeld = new Set<string>();
  private virtualPressed = new Set<string>();
  onVirtualInteract: (() => void) | null = null;

  private element: HTMLElement;
  private disposers: (() => void)[] = [];

  constructor(element: HTMLElement) {
    this.element = element;
    const coarse = typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: none) and (pointer: coarse)').matches
      : false;
    this.isTouch = coarse || 'ontouchstart' in window;

    this.bind(window, 'keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (ev.repeat) return;
      if (this.shouldSwallow(ev.code)) {
        ev.preventDefault();
      }
      this.down.add(ev.code);
      this.pressedThisFrame.add(ev.code);
    });

    this.bind(window, 'keyup', (e) => {
      const ev = e as KeyboardEvent;
      this.down.delete(ev.code);
      this.releasedThisFrame.add(ev.code);
    });

    this.bind(window, 'blur', () => {
      this.down.clear();
      this.mouseDown.clear();
      this.leftStick.active = false;
      this.rightStick.active = false;
      this.virtualHeld.clear();
    });

    this.bind(document, 'pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.element;
    });

    this.bind(document, 'mousemove', (e) => {
      const ev = e as MouseEvent;
      if (!this.pointerLocked) return;
      const s = settings.data.sensitivity;
      this.mouseDX += ev.movementX * 0.0022 * s;
      this.mouseDY += ev.movementY * 0.0022 * s * (settings.data.invertY ? -1 : 1);
    });

    this.bind(document, 'mousedown', (e) => {
      const ev = e as MouseEvent;
      if (!this.pointerLocked) return;
      this.mouseDown.add(ev.button);
      this.mousePressed.add(ev.button);
    });

    this.bind(document, 'mouseup', (e) => {
      const ev = e as MouseEvent;
      this.mouseDown.delete(ev.button);
    });

    this.bind(document, 'wheel', (e) => {
      const ev = e as WheelEvent;
      this.wheel += Math.sign(ev.deltaY);
      if (this.pointerLocked) ev.preventDefault();
    }, { passive: false });

    this.bind(document, 'contextmenu', (e) => {
      if (this.pointerLocked) e.preventDefault();
    });

    this.bind(document, 'touchstart', (e) => this.onTouchStart(e as TouchEvent), { passive: false });
    this.bind(document, 'touchmove', (e) => this.onTouchMove(e as TouchEvent), { passive: false });
    this.bind(document, 'touchend', (e) => this.onTouchEnd(e as TouchEvent), { passive: false });
    this.bind(document, 'touchcancel', (e) => this.onTouchEnd(e as TouchEvent), { passive: false });
  }

  private bind<K extends keyof DocumentEventMap>(
    target: Document | Window | HTMLElement,
    type: K | string,
    handler: (e: Event) => void,
    opts?: AddEventListenerOptions
  ): void {
    target.addEventListener(type, handler as EventListener, opts);
    this.disposers.push(() => target.removeEventListener(type, handler as EventListener, opts));
  }

  private shouldSwallow(code: string): boolean {
    return code === 'Tab' || code === 'Space' || code.startsWith('Arrow') || code === 'F5';
  }

  /* ---------------- Desktop-ish queries ---------------- */

  isDown(action: keyof typeof settings.data.keybinds | string): boolean {
    const code = settings.data.keybinds[action as string] ?? action;
    return this.down.has(code) || this.virtualHeld.has(action as string);
  }

  wasPressed(action: string): boolean {
    const code = settings.data.keybinds[action] ?? action;
    return this.pressedThisFrame.has(code) || this.virtualPressed.has(action);
  }

  /** Raw key check (for keys not in the bind table). */
  keyDown(code: string): boolean {
    return this.down.has(code);
  }

  keyPressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  fireDown(): boolean {
    return this.mouseDown.has(0) || this.virtualHeld.has('fire');
  }

  firePressed(): boolean {
    return this.mousePressed.has(0) || this.virtualPressed.has('fire');
  }

  aimDown(): boolean {
    return this.mouseDown.has(2) || this.virtualHeld.has('aim');
  }

  /* ---------------- Virtual (mobile HUD) ---------------- */

  virtualPress(action: string): void {
    this.virtualHeld.add(action);
    this.virtualPressed.add(action);
  }

  virtualRelease(action: string): void {
    this.virtualHeld.delete(action);
  }

  /* ---------------- Touch ---------------- */

  private onTouchStart(e: TouchEvent): void {
    this.isTouch = true;
    const w = window.innerWidth;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      const target = t.target as HTMLElement | null;
      if (target && target.closest('[data-ui-block]')) continue;
      const leftSide = t.clientX < w * 0.45;
      if (leftSide && !this.leftStick.active) {
        this.leftStick = { active: true, x: 0, y: 0, id: t.identifier, originX: t.clientX, originY: t.clientY };
      } else if (!leftSide && this.lookTouchId === -1 && !this.rightStick.active) {
        const isRightFlick = t.clientX > w * 0.6;
        if (isRightFlick) {
          this.lookTouchId = t.identifier;
          this.lastLookX = t.clientX;
          this.lastLookY = t.clientY;
        }
      }
    }
    if (e.cancelable) e.preventDefault();
  }

  private onTouchMove(e: TouchEvent): void {
    const w = window.innerWidth;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier === this.leftStick.id) {
        const maxR = 68;
        let dx = t.clientX - this.leftStick.originX;
        let dy = t.clientY - this.leftStick.originY;
        const len = Math.hypot(dx, dy);
        if (len > maxR) {
          dx = (dx / len) * maxR;
          dy = (dy / len) * maxR;
          // let the stick origin follow so it feels like a real analogue stick
          this.leftStick.originX += (t.clientX - this.leftStick.originX) * 0.04;
          this.leftStick.originY += (t.clientY - this.leftStick.originY) * 0.04;
        }
        this.leftStick.x = dx / maxR;
        this.leftStick.y = dy / maxR;
      } else if (t.identifier === this.lookTouchId) {
        const s = settings.data.sensitivity * 0.0032;
        this.mouseDX += (t.clientX - this.lastLookX) * s;
        this.mouseDY += (t.clientY - this.lastLookY) * s * (settings.data.invertY ? -1 : 1);
        this.lastLookX = t.clientX;
        this.lastLookY = t.clientY;
      }
      void w;
    }
    if (e.cancelable) e.preventDefault();
  }

  private onTouchEnd(e: TouchEvent): void {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (t.identifier === this.leftStick.id) {
        this.leftStick = { active: false, x: 0, y: 0, id: -1, originX: 0, originY: 0 };
      }
      if (t.identifier === this.lookTouchId) this.lookTouchId = -1;
    }
  }

  /** Combined movement axes from keyboard or virtual stick. */
  moveAxes(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.isDown('forward')) y -= 1;
    if (this.isDown('back')) y += 1;
    if (this.isDown('left')) x -= 1;
    if (this.isDown('right')) x += 1;
    if (this.leftStick.active) {
      x += this.leftStick.x;
      y += this.leftStick.y;
    }
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y };
  }

  requestPointerLock(): void {
    if (this.isTouch) return;
    const el = this.element as HTMLElement & { requestPointerLock?: (o?: object) => Promise<void> | void };
    try {
      const r = el.requestPointerLock?.({ unadjustedMovement: true });
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => {
          try {
            el.requestPointerLock?.();
          } catch { /* ignore */ }
        });
      }
    } catch {
      try {
        el.requestPointerLock?.();
      } catch { /* ignore */ }
    }
  }

  exitPointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Called at the end of every frame. */
  endFrame(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mousePressed.clear();
    this.virtualPressed.clear();
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.down.clear();
    this.mouseDown.clear();
  }
}
