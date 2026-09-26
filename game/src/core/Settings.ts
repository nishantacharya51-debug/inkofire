import { bus } from './EventBus';

export type QualityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'ULTRA';

export interface GraphicsConfig {
  shadows: boolean;
  shadowQuality: number;
  renderScale: number;
  viewDistance: number;
  vegetationDensity: number;
  particleQuality: number;
  bloom: boolean;
  ssao: boolean;
  anisotropic: number;
  antialias: boolean;
  maxPixelRatio: number;
}

export interface SettingsData {
  quality: QualityLevel | 'AUTO';
  /** Explicit overrides (null = follow quality preset). */
  overrides: Partial<GraphicsConfig>;
  fov: number;
  firstPerson: boolean;
  sensitivity: number;
  adsSensitivity: number;
  invertY: boolean;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  voiceVolume: number;
  showCrosshair: boolean;
  crosshairColor: string;
  damageNumbers: boolean;
  damageIndicators: boolean;
  autoPickup: boolean;
  autoReload: boolean;
  aimAssist: number;
  showFps: boolean;
  minimapRotate: boolean;
  keybinds: Record<string, string>;
  botDifficulty: 'EASY' | 'NORMAL' | 'HARD' | 'ELITE';
  showBlood: boolean;
}

const DEFAULT_KEYBINDS: Record<string, string> = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  crouch: 'KeyC',
  prone: 'KeyZ',
  sprint: 'ShiftLeft',
  reload: 'KeyR',
  interact: 'KeyF',
  inventory: 'Tab',
  map: 'KeyM',
  slot1: 'Digit1',
  slot2: 'Digit2',
  slot3: 'Digit3',
  slot4: 'Digit4',
  grenade: 'KeyG',
  heal: 'KeyH',
  fireMode: 'KeyB',
  vehicle: 'KeyE',
  scoreboard: 'KeyP',
  flashlight: 'KeyL'
};

export const QUALITY_PRESETS: Record<QualityLevel, GraphicsConfig> = {
  LOW: {
    shadows: false, shadowQuality: 0, renderScale: 0.75, viewDistance: 420,
    vegetationDensity: 0.25, particleQuality: 0.35, bloom: false, ssao: false,
    anisotropic: 1, antialias: false, maxPixelRatio: 1
  },
  MEDIUM: {
    shadows: true, shadowQuality: 1024, renderScale: 0.9, viewDistance: 640,
    vegetationDensity: 0.5, particleQuality: 0.6, bloom: false, ssao: false,
    anisotropic: 4, antialias: true, maxPixelRatio: 1.25
  },
  HIGH: {
    shadows: true, shadowQuality: 2048, renderScale: 1, viewDistance: 900,
    vegetationDensity: 0.8, particleQuality: 1, bloom: true, ssao: false,
    anisotropic: 8, antialias: true, maxPixelRatio: 1.5
  },
  ULTRA: {
    shadows: true, shadowQuality: 3072, renderScale: 1, viewDistance: 1300,
    vegetationDensity: 1, particleQuality: 1.4, bloom: true, ssao: true,
    anisotropic: 16, antialias: true, maxPixelRatio: 2
  }
};

const STORAGE_KEY = 'apexisland.settings.v1';

const DEFAULTS: SettingsData = {
  quality: 'AUTO',
  overrides: {},
  fov: 78,
  firstPerson: false,
  sensitivity: 1,
  adsSensitivity: 0.7,
  invertY: false,
  masterVolume: 0.85,
  musicVolume: 0.5,
  sfxVolume: 0.9,
  voiceVolume: 0.8,
  showCrosshair: true,
  crosshairColor: '#8ef7a0',
  damageNumbers: true,
  damageIndicators: true,
  autoPickup: true,
  autoReload: true,
  aimAssist: 0.35,
  showFps: false,
  minimapRotate: false,
  keybinds: { ...DEFAULT_KEYBINDS },
  botDifficulty: 'NORMAL',
  showBlood: true
};

/**
 * Hardware detection used for the AUTO quality preset.
 * Uses the WebGL renderer string, device memory and core count — all available
 * without any permissions prompt.
 */
export function detectQuality(): QualityLevel {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency || 4;
  const memory = nav.deviceMemory ?? 4;
  let gpuScore = 1;
  let isMobile = false;
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
      const r = renderer.toLowerCase();
      isMobile = /adreno|mali|powervr|apple gpu|videocore/.test(r);
      if (/rtx|radeon rx|geforce (gtx|rtx)|apple m[1-9]/.test(r)) gpuScore = 4;
      else if (/intel.*(iris|arc)|radeon (vega|graphics)|gtx/.test(r)) gpuScore = 3;
      else if (/intel|uhd|hd graphics/.test(r)) gpuScore = 2;
      else if (/swiftshader|software|llvmpipe/.test(r)) gpuScore = 1;
    }
  } catch {
    gpuScore = 2;
  }
  if (isMobile) return cores >= 8 && memory >= 6 ? 'MEDIUM' : 'LOW';
  if (gpuScore >= 4 && cores >= 8 && memory >= 8) return 'ULTRA';
  if (gpuScore >= 3 && cores >= 4) return 'HIGH';
  if (gpuScore >= 2) return 'MEDIUM';
  return 'LOW';
}

class SettingsManager {
  data: SettingsData = { ...DEFAULTS, keybinds: { ...DEFAULT_KEYBINDS } };
  resolvedQuality: QualityLevel = 'MEDIUM';
  graphics: GraphicsConfig = { ...QUALITY_PRESETS.MEDIUM };

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SettingsData>;
        this.data = {
          ...DEFAULTS,
          ...parsed,
          keybinds: { ...DEFAULT_KEYBINDS, ...(parsed.keybinds ?? {}) },
          overrides: { ...(parsed.overrides ?? {}) }
        };
      }
    } catch (err) {
      console.warn('[Settings] failed to load, using defaults', err);
    }
    this.resolveQuality();
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (err) {
      console.warn('[Settings] failed to persist', err);
    }
  }

  resolveQuality(): void {
    this.resolvedQuality = this.data.quality === 'AUTO' ? detectQuality() : this.data.quality;
    this.graphics = { ...QUALITY_PRESETS[this.resolvedQuality], ...this.data.overrides };
  }

  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]): void {
    this.data[key] = value;
    this.resolveQuality();
    this.save();
    bus.emit('settings:changed', {});
  }

  setOverride(key: keyof GraphicsConfig, value: number | boolean): void {
    (this.data.overrides as Record<string, number | boolean>)[key] = value;
    this.resolveQuality();
    this.save();
    bus.emit('settings:changed', {});
  }

  resetKeybinds(): void {
    this.data.keybinds = { ...DEFAULT_KEYBINDS };
    this.save();
    bus.emit('settings:changed', {});
  }

  resetAll(): void {
    this.data = { ...DEFAULTS, keybinds: { ...DEFAULT_KEYBINDS }, overrides: {} };
    this.resolveQuality();
    this.save();
    bus.emit('settings:changed', {});
  }
}

export const settings = new SettingsManager();
export { DEFAULT_KEYBINDS };
