import * as THREE from 'three';
import { settings, type QualityLevel } from './Settings';
import { bus } from './EventBus';

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** Headless mode: no WebGL context is created (used by automated tests). */
  headless?: boolean;
}

export interface FrameInfo {
  dt: number;
  elapsed: number;
  frame: number;
  fps: number;
}

type UpdateFn = (info: FrameInfo) => void;

/**
 * Renderer / scene / camera owner plus the fixed-timestep game loop.
 *
 * Simulation runs on a fixed 60 Hz step (deterministic + stable physics), and
 * rendering happens once per animation frame with interpolation-friendly state.
 */
export class Engine {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer | null = null;
  readonly clock = new THREE.Clock();
  readonly canvas: HTMLCanvasElement;

  private updates: UpdateFn[] = [];
  private frameCallbacks: UpdateFn[] = [];
  private rafId = 0;
  private running = false;
  private accumulator = 0;
  private readonly fixedStep = 1 / 60;
  private maxStepsPerFrame = 4;

  frame = 0;
  elapsed = 0;
  fps = 60;
  private fpsSmoothing = 60;
  private slowFrames = 0;
  private fastFrames = 0;
  private currentPixelRatio = 1;
  private renderScale = 1;
  private width = 1;
  private height = 1;
  /** Adaptive-resolution state (disabled on ULTRA to keep image quality). */
  adaptiveResolution = true;
  lastFrameInfo: FrameInfo = { dt: 0, elapsed: 0, frame: 0, fps: 60 };

  constructor(opts: EngineOptions) {
    this.canvas = opts.canvas;
    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;
    this.camera = new THREE.PerspectiveCamera(settings.data.fov, 16 / 9, 0.12, 3000);
    this.camera.rotation.order = 'YXZ';

    if (!opts.headless) {
      this.renderer = new THREE.WebGLRenderer({
        canvas: opts.canvas,
        antialias: settings.graphics.antialias,
        powerPreference: 'high-performance',
        stencil: false,
        depth: true,
        alpha: false
      });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.05;
      this.renderer.shadowMap.enabled = settings.graphics.shadows;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.renderer.setClearColor(0x9fb6cd, 1);
      this.applyQuality();
    }

    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
    this.onResize();
  }

  get isHeadless(): boolean {
    return this.renderer === null;
  }

  /** Apply current quality settings to the renderer. */
  applyQuality(forceLevel?: QualityLevel): void {
    const g = settings.graphics;
    this.renderScale = g.renderScale;
    this.adaptiveResolution = settings.resolvedQuality !== 'ULTRA' || forceLevel === 'ULTRA' ? settings.resolvedQuality !== 'ULTRA' : false;
    this.camera.fov = settings.data.fov;
    this.camera.updateProjectionMatrix();
    if (!this.renderer) return;
    this.renderer.shadowMap.enabled = g.shadows;
    this.renderer.shadowMap.type = settings.resolvedQuality === 'LOW' ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
    this.renderer.toneMappingExposure = 1.05;
    this.onResize();
  }

  onResize = (): void => {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.width = w;
    this.height = h;
    const g = settings.graphics;
    const dpr = Math.min(window.devicePixelRatio || 1, g.maxPixelRatio);
    this.currentPixelRatio = dpr * this.renderScale;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.renderer) {
      this.renderer.setPixelRatio(this.currentPixelRatio);
      this.renderer.setSize(w, h, false);
      this.canvas.style.width = '100%';
      this.canvas.style.height = '100%';
    }
  };

  get aspect(): number {
    return this.width / this.height;
  }

  get viewportWidth(): number {
    return this.width;
  }

  get viewportHeight(): number {
    return this.height;
  }

  /** Fixed-step simulation callback (60 Hz). */
  onFixedUpdate(fn: UpdateFn): () => void {
    this.updates.push(fn);
    return () => {
      const i = this.updates.indexOf(fn);
      if (i >= 0) this.updates.splice(i, 1);
    };
  }

  /**
   * Per-frame callback with the real (variable) frame delta, run once after the
   * fixed steps of that frame — for camera smoothing, HUD and other visual-only
   * work that should not affect the simulation.
   */
  onRender(fn: UpdateFn): () => void {
    this.frameCallbacks.push(fn);
    return () => {
      const i = this.frameCallbacks.indexOf(fn);
      if (i >= 0) this.frameCallbacks.splice(i, 1);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const loop = (): void => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      this.tick();
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private tick(): void {
    const raw = this.clock.getDelta();
    // Guard against tab-switch time jumps.
    const frameDt = Math.min(0.25, raw);
    this.accumulate(frameDt);
    this.runFrameCallbacks(frameDt);

    if (this.renderer) {
      try {
        this.renderer.render(this.scene, this.camera);
      } catch (err) {
        console.error('[Engine] render error', err);
        this.stop();
      }
    }
  }

  /**
   * Advances the simulation by `frameDt` of real time using the fixed-step
   * accumulator, without touching requestAnimationFrame or the renderer.
   * Automated tests drive the real game loop through this.
   */
  advance(frameDt: number): void {
    const dt = Math.min(0.25, Math.max(0, frameDt));
    this.accumulate(dt);
    this.runFrameCallbacks(dt);
  }

  private runFrameCallbacks(frameDt: number): void {
    if (this.frameCallbacks.length === 0) {
      this.updateFps(frameDt);
      return;
    }
    const info: FrameInfo = { dt: frameDt, elapsed: this.elapsed, frame: this.frame, fps: this.fps };
    this.lastFrameInfo = info;
    for (let i = 0; i < this.frameCallbacks.length; i++) {
      try {
        this.frameCallbacks[i](info);
      } catch (err) {
        console.error('[Engine] frame callback error', err);
      }
    }
    this.updateFps(frameDt);
  }

  private accumulate(frameDt: number): void {
    const info: FrameInfo = { dt: frameDt, elapsed: this.elapsed, frame: this.frame, fps: this.fps };

    this.accumulator += frameDt;
    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < this.maxStepsPerFrame) {
      this.accumulator -= this.fixedStep;
      steps++;
      this.elapsed += this.fixedStep;
      info.dt = this.fixedStep;
      info.elapsed = this.elapsed;
      info.frame = this.frame;
      for (let i = 0; i < this.updates.length; i++) {
        try {
          this.updates[i](info);
        } catch (err) {
          console.error('[Engine] update error', err);
        }
      }
      this.frame++;
    }
    if (steps >= this.maxStepsPerFrame) this.accumulator = 0;

    if (this.frameCallbacks.length === 0) {
      info.elapsed = this.elapsed;
      info.frame = this.frame;
      info.fps = this.fps;
      this.lastFrameInfo = info;
      this.updateFps(frameDt);
    }
  }

  private updateFps(dt: number): void {
    if (dt <= 0) return;
    const inst = 1 / dt;
    this.fpsSmoothing += (inst - this.fpsSmoothing) * 0.08;
    this.fps = this.fpsSmoothing;

    if (!this.adaptiveResolution || !this.renderer) return;
    if (this.fps < 45) {
      this.slowFrames++;
      this.fastFrames = 0;
    } else if (this.fps > 58) {
      this.fastFrames++;
      this.slowFrames = 0;
    }
    // Nudge the render scale to hold ~60fps on weaker GPUs.
    if (this.slowFrames > 60 && this.renderScale > 0.6) {
      this.renderScale = Math.max(0.6, this.renderScale - 0.08);
      this.slowFrames = 0;
      this.applyScale();
    } else if (this.fastFrames > 180 && this.renderScale < Math.min(1, settings.graphics.renderScale)) {
      this.renderScale = Math.min(settings.graphics.renderScale, this.renderScale + 0.05);
      this.fastFrames = 0;
      this.applyScale();
    }
  }

  private applyScale(): void {
    if (!this.renderer) return;
    const dpr = Math.min(window.devicePixelRatio || 1, settings.graphics.maxPixelRatio) * this.renderScale;
    this.currentPixelRatio = dpr;
    this.renderer.setPixelRatio(dpr);
  }

  /** Force a specific render scale (used by the settings screen). */
  setRenderScale(scale: number): void {
    this.renderScale = scale;
    this.applyScale();
  }

  renderOnce(): void {
    if (this.renderer) this.renderer.render(this.scene, this.camera);
  }

  /** Approximate GPU/JS timing snapshot for the debug overlay. */
  getInfo(): { fps: number; calls: number; triangles: number; renderScale: number; pixelRatio: number } {
    const info = this.renderer?.info;
    return {
      fps: this.fps,
      calls: info?.render.calls ?? 0,
      triangles: info?.render.triangles ?? 0,
      renderScale: this.renderScale,
      pixelRatio: this.currentPixelRatio
    };
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    this.updates.length = 0;
    this.renderer?.dispose();
    bus.clear();
  }
}
