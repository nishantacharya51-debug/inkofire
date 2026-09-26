/**
 * Deterministic pseudo random number generation + value noise.
 * All world generation and AI rolls use seeded RNG so matches are reproducible
 * (important for future authoritative-server / netcode parity).
 */

export class RNG {
  private s: number;

  constructor(seed = 1337) {
    this.s = seed >>> 0 || 1;
  }

  /** mulberry32 — fast, decent distribution, deterministic. */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }

  /** Weighted pick — `weights` parallel to `arr`. */
  weighted<T>(arr: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  fork(salt: number): RNG {
    return new RNG(Math.imul(this.s ^ salt, 0x9e3779b1) >>> 0);
  }
}

/* ------------------------------------------------------------------ */
/* Value noise                                                         */
/* ------------------------------------------------------------------ */

const PERM_SIZE = 512;

export class Noise2D {
  private perm = new Uint8Array(PERM_SIZE);
  private grad = new Float32Array(PERM_SIZE);

  constructor(seed = 7) {
    const rng = new RNG(seed);
    for (let i = 0; i < 256; i++) this.perm[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = this.perm[i];
      this.perm[i] = this.perm[j];
      this.perm[j] = t;
    }
    for (let i = 0; i < 256; i++) {
      this.perm[256 + i] = this.perm[i];
      this.grad[i] = rng.next() * 2 - 1;
      this.grad[256 + i] = this.grad[i];
    }
  }

  private hash(x: number, y: number): number {
    return this.grad[(this.perm[(x & 255)] + (y & 255)) & 511];
  }

  /** Smooth value noise in [-1,1]. */
  noise(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = this.hash(xi, yi);
    const b = this.hash(xi + 1, yi);
    const c = this.hash(xi, yi + 1);
    const d = this.hash(xi + 1, yi + 1);
    const ab = a + (b - a) * u;
    const cd = c + (d - c) * u;
    return ab + (cd - ab) * v;
  }

  /** Fractal brownian motion. */
  fbm(x: number, y: number, octaves = 4, lacunarity = 2.03, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise(x * freq, y * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / (norm || 1);
  }

  ridged(x: number, y: number, octaves = 4): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise(x * freq, y * freq));
      sum += n * n * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.07;
    }
    return sum / (norm || 1);
  }
}
