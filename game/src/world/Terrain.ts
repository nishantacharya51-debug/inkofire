import { RNG } from '../utils/rng';
import { clamp, smoothstep } from '../utils/mathx';

/**
 * Island heightfield.
 *
 * Pure data + sampling helpers (no Three.js) so the same terrain drives both
 * rendering and the headless simulation tests.
 */

export const Biome = {
  WATER: 0,
  BEACH: 1,
  GRASS: 2,
  FOREST: 3,
  ROCK: 4,
  MOUNTAIN: 5,
  SNOW: 6,
  DIRT: 7,
  ASPHALT: 8
} as const;

export type BiomeId = (typeof Biome)[keyof typeof Biome];

export interface TerrainData {
  seed: number;
  /** World extent in metres (the island spans [-size/2, size/2]). */
  size: number;
  /** Heightfield resolution in cells (grid is res+1 vertices per axis). */
  res: number;
  /** Metres per cell. */
  cell: number;
  half: number;
  heights: Float32Array;
  biome: Uint8Array;
  waterLevel: number;
  maxHeight: number;
}

export const WORLD_SIZE = 2560;
export const TERRAIN_RES = 320;
export const WATER_LEVEL = 0;

/* -------------------------------------------------------------------------- */
/* Noise                                                                       */
/* -------------------------------------------------------------------------- */

function hash2(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h & 0x7fffffff) / 0x7fffffff;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x: number, y: number, seed: number, octaves: number, lacunarity = 2.03, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 131) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

function ridged(x: number, y: number, seed: number, octaves: number): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(x * freq, y * freq, seed + i * 977) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                  */
/* -------------------------------------------------------------------------- */

export function idx(t: TerrainData, i: number, j: number): number {
  return j * (t.res + 1) + i;
}

export function generateTerrain(seed: number, size = WORLD_SIZE, res = TERRAIN_RES): TerrainData {
  const heights = new Float32Array((res + 1) * (res + 1));
  const biome = new Uint8Array((res + 1) * (res + 1));
  const cell = size / res;
  const half = size / 2;
  const t: TerrainData = { seed, size, res, cell, half, heights, biome, waterLevel: WATER_LEVEL, maxHeight: 0 };

  // Domain-warped fbm island: a coastal ring, rolling interior and a mountain spine.
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const worldX = -half + i * cell;
      const worldZ = -half + j * cell;
      const nx = worldX / 900;
      const nz = worldZ / 900;

      // Island mask — keeps the playable area inside the map bounds.
      const d = Math.min(1, Math.hypot(worldX, worldZ) / (half * 0.94));
      // Push inlets/bays into the coastline so it does not read as a circle.
      const coastNoise = fbm(nx * 2.2 + 11.3, nz * 2.2 - 4.7, seed + 5, 3) - 0.5;
      const shaped = clamp(d + coastNoise * 0.22, 0, 1);
      const island = 1 - smoothstep(0.4, 1.05, shaped);

      const warp = (fbm(nx * 1.6, nz * 1.6, seed + 21, 3) - 0.5) * 1.4;
      const base = fbm(nx * 2.6 + warp, nz * 2.6 + warp, seed + 77, 5);
      const ridge = ridged(nx * 1.5 + warp * 0.4, nz * 1.5 - warp * 0.4, seed + 149, 4);
      const mountains = Math.max(0, ridge - 0.42) * 190 * island;

      let h = -12 + island * (16 + base * 54) + mountains;
      // Guarantee a wide, shallow shelf so landing never happens on a cliff face.
      h += (1 - smoothstep(0, 0.35, d)) * 4;

      heights[idx(t, i, j)] = h;
      if (h > t.maxHeight) t.maxHeight = h;
    }
  }

  classifyBiomes(t);
  return t;
}

function classifyBiomes(t: TerrainData): void {
  const { res, heights, biome } = t;
  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const k = idx(t, i, j);
      const h = heights[k];
      let b: BiomeId;
      if (h < WATER_LEVEL - 0.4) b = Biome.WATER;
      else if (h < 2.2) b = Biome.BEACH;
      else {
        const slope = cellSlope(t, i, j);
        if (h > 88) b = Biome.SNOW;
        else if (h > 66) b = Biome.MOUNTAIN;
        else if (h > 46 || slope > 0.85) b = Biome.ROCK;
        else {
          // Moisture from a low-frequency noise decides forest vs grass.
          const m = fbm(i / 44, j / 44, t.seed + 313, 3);
          b = m > 0.56 ? Biome.FOREST : Biome.GRASS;
        }
      }
      biome[k] = b;
    }
  }
}

function cellSlope(t: TerrainData, i: number, j: number): number {
  const hL = t.heights[idx(t, Math.max(0, i - 1), j)];
  const hR = t.heights[idx(t, Math.min(t.res, i + 1), j)];
  const hD = t.heights[idx(t, i, Math.max(0, j - 1))];
  const hU = t.heights[idx(t, i, Math.min(t.res, j + 1))];
  return Math.hypot(hR - hL, hU - hD) / (2 * t.cell);
}

/* -------------------------------------------------------------------------- */
/* Sampling                                                                    */
/* -------------------------------------------------------------------------- */

export function sampleHeight(t: TerrainData, x: number, z: number): number {
  const fx = (x + t.half) / t.cell;
  const fz = (z + t.half) / t.cell;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  if (i < 0 || j < 0 || i >= t.res || j >= t.res) {
    // Outside the map: continue the coastal slope downward.
    return -14;
  }
  const u = fx - i;
  const v = fz - j;
  const h00 = t.heights[idx(t, i, j)];
  const h10 = t.heights[idx(t, i + 1, j)];
  const h01 = t.heights[idx(t, i, j + 1)];
  const h11 = t.heights[idx(t, i + 1, j + 1)];
  return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
}

export function sampleNormal(t: TerrainData, x: number, z: number, out: { x: number; y: number; z: number }): void {
  const e = t.cell;
  const hL = sampleHeight(t, x - e, z);
  const hR = sampleHeight(t, x + e, z);
  const hD = sampleHeight(t, x, z - e);
  const hU = sampleHeight(t, x, z + e);
  const nx = hL - hR;
  const ny = 2 * e;
  const nz = hD - hU;
  const len = Math.hypot(nx, ny, nz) || 1;
  out.x = nx / len;
  out.y = ny / len;
  out.z = nz / len;
}

export function sampleSlope(t: TerrainData, x: number, z: number): number {
  const e = t.cell;
  const hL = sampleHeight(t, x - e, z);
  const hR = sampleHeight(t, x + e, z);
  const hD = sampleHeight(t, x, z - e);
  const hU = sampleHeight(t, x, z + e);
  return Math.hypot(hR - hL, hU - hD) / (2 * e);
}

export function sampleBiome(t: TerrainData, x: number, z: number): BiomeId {
  const i = Math.round((x + t.half) / t.cell);
  const j = Math.round((z + t.half) / t.cell);
  if (i < 0 || j < 0 || i > t.res || j > t.res) return Biome.WATER;
  return t.biome[idx(t, i, j)] as BiomeId;
}

export function isWater(t: TerrainData, x: number, z: number): boolean {
  return sampleHeight(t, x, z) < t.waterLevel - 0.2;
}

/* -------------------------------------------------------------------------- */
/* Sculpting                                                                   */
/* -------------------------------------------------------------------------- */

/** Flattens a disc of terrain toward a target height (building pads, POIs). */
export function flattenDisc(
  t: TerrainData,
  cx: number,
  cz: number,
  radius: number,
  blend = 14,
  target: number | null = null,
  falloffShape: 'smooth' | 'plateau' = 'smooth'
): number {
  const targetY = target ?? sampleHeight(t, cx, cz);
  const r0 = Math.floor((cx - radius - blend + t.half) / t.cell);
  const r1 = Math.ceil((cx + radius + blend + t.half) / t.cell);
  const c0 = Math.floor((cz - radius - blend + t.half) / t.cell);
  const c1 = Math.ceil((cz + radius + blend + t.half) / t.cell);
  for (let j = Math.max(0, c0); j <= Math.min(t.res, c1); j++) {
    for (let i = Math.max(0, r0); i <= Math.min(t.res, r1); i++) {
      const wx = -t.half + i * t.cell;
      const wz = -t.half + j * t.cell;
      const dist = Math.hypot(wx - cx, wz - cz);
      if (dist > radius + blend) continue;
      let w: number;
      if (dist <= radius) w = 1;
      else w = 1 - smoothstep(radius, radius + blend, dist);
      if (falloffShape === 'plateau') w = w * w;
      const k = idx(t, i, j);
      t.heights[k] = t.heights[k] * (1 - w) + targetY * w;
    }
  }
  return targetY;
}

/** Flattens a corridor along a polyline (roads, runways, stairs into terrain). */
export function flattenPath(
  t: TerrainData,
  points: { x: number; z: number }[],
  halfWidth: number,
  blend = 6,
  plateau = true
): void {
  for (let s = 0; s < points.length - 1; s++) {
    const a = points[s];
    const b = points[s + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (t.cell * 0.5)));
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const cx = a.x + (b.x - a.x) * u;
      const cz = a.z + (b.z - a.z) * u;
      const dist = Math.hypot(b.x - a.x, b.z - a.z);
      const target = sampleHeight(t, cx, cz);
      const inner = halfWidth + Math.max(0, dist * 0.002);
      flattenDisc(t, cx, cz, inner, blend, target, plateau ? 'plateau' : 'smooth');
    }
  }
}

/** Paints a biome along a polyline (roads). */
export function paintPath(
  t: TerrainData,
  points: { x: number; z: number }[],
  halfWidth: number,
  biome: BiomeId
): void {
  for (let s = 0; s < points.length - 1; s++) {
    const a = points[s];
    const b = points[s + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (t.cell * 0.5)));
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const cx = a.x + (b.x - a.x) * u;
      const cz = a.z + (b.z - a.z) * u;
      const r0 = Math.floor((cx - halfWidth + t.half) / t.cell);
      const r1 = Math.ceil((cx + halfWidth + t.half) / t.cell);
      const c0 = Math.floor((cz - halfWidth + t.half) / t.cell);
      const c1 = Math.ceil((cz + halfWidth + t.half) / t.cell);
      for (let j = Math.max(0, c0); j <= Math.min(t.res, c1); j++) {
        for (let i = Math.max(0, r0); i <= Math.min(t.res, r1); i++) {
          const wx = -t.half + i * t.cell;
          const wz = -t.half + j * t.cell;
          if (Math.hypot(wx - cx, wz - cz) > halfWidth) continue;
          t.biome[idx(t, i, j)] = biome;
        }
      }
    }
  }
}

export function paintBiomeDisc(t: TerrainData, cx: number, cz: number, radius: number, biome: BiomeId): void {
  const r0 = Math.max(0, Math.floor((cx - radius + t.half) / t.cell));
  const r1 = Math.min(t.res, Math.ceil((cx + radius + t.half) / t.cell));
  const c0 = Math.max(0, Math.floor((cz - radius + t.half) / t.cell));
  const c1 = Math.min(t.res, Math.ceil((cz + radius + t.half) / t.cell));
  for (let j = c0; j <= c1; j++) {
    for (let i = r0; i <= r1; i++) {
      const wx = -t.half + i * t.cell;
      const wz = -t.half + j * t.cell;
      if (Math.hypot(wx - cx, wz - cz) > radius) continue;
      t.biome[idx(t, i, j)] = biome;
    }
  }
}

/** Finds a flat, dry spot near (cx, cz) — used to place POIs, loot and bots. */
export function findFlatSpot(
  t: TerrainData,
  rng: RNG,
  cx: number,
  cz: number,
  searchRadius: number,
  maxSlope: number,
  size: number
): { x: number; z: number; y: number } | null {
  for (let attempt = 0; attempt < 80; attempt++) {
    const r = attempt < 40 ? searchRadius * 0.5 : searchRadius;
    const ang = rng.range(0, Math.PI * 2);
    const dist = Math.sqrt(rng.next()) * r;
    const x = clamp(cx + Math.cos(ang) * dist, -t.half + size, t.half - size);
    const z = clamp(cz + Math.sin(ang) * dist, -t.half + size, t.half - size);
    const y = sampleHeight(t, x, z);
    if (y < t.waterLevel + 1.5) continue;
    if (sampleSlope(t, x, z) > maxSlope) continue;
    // Corner check so buildings never float over a cliff.
    let ok = true;
    for (const [ox, oz] of [
      [size, size], [-size, size], [size, -size], [-size, -size], [0, 0]
    ]) {
      const cy = sampleHeight(t, x + ox, z + oz);
      if (Math.abs(cy - y) > 2.4 || cy < t.waterLevel + 1.0) {
        ok = false;
        break;
      }
    }
    if (ok) return { x, z, y };
  }
  return null;
}

/**
 * Builds a coarse walkability grid used by the bot navigation code.
 * 256x256 cells (~10 m each) keeps the A* cost trivial even for 64 bots.
 */
export interface NavGrid {
  size: number;
  cell: number;
  res: number;
  walkable: Uint8Array;
}

export function buildNavGrid(t: TerrainData, res = 256): NavGrid {
  const cell = t.size / res;
  const walkable = new Uint8Array(res * res);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = -t.half + (i + 0.5) * cell;
      const z = -t.half + (j + 0.5) * cell;
      const y = sampleHeight(t, x, z);
      const slope = sampleSlope(t, x, z);
      walkable[j * res + i] = y > t.waterLevel + 0.6 && slope < 1.35 ? 1 : 0;
    }
  }
  return { size: t.size, cell, res, walkable };
}
