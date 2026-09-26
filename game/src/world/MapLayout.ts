import { RNG } from '../utils/rng';
import {
  Biome, flattenDisc, flattenPath, paintBiomeDisc, paintPath, sampleHeight, sampleSlope,
  type TerrainData, findFlatSpot
} from './Terrain';

/**
 * Procedural island layout.
 *
 * Everything here is *data*: axis-aligned boxes (so collision, nav rasterisation
 * and rendering all agree), loot spawn points, vegetation instances, vehicle
 * spawns and a road network. Nothing in this file touches the renderer, which
 * lets the headless tests load the exact same map the player sees.
 *
 * All layouts are axis-aligned on purpose — rotated collision boxes would create
 * invisible walls for players.
 */

export type SurfaceKey =
  | 'concrete' | 'brick' | 'wood' | 'metal' | 'asphalt' | 'sand' | 'grass' | 'rock'
  | 'roof' | 'fabric' | 'crate' | 'glass' | 'foliage' | 'tarp' | 'rust'
  | 'paintRed' | 'paintBlue' | 'paintYellow' | 'paintGreen'
  | 'dark' | 'white' | 'steelDark' | 'container1' | 'container2' | 'container3';

export interface WorldBox {
  kind: SurfaceKey;
  /** Centre position. */
  x: number; y: number; z: number;
  w: number; h: number; d: number;
  /** Visual rotation (collision uses the axis-aligned bounds). */
  rotY?: number;
  collide: boolean;
  /** Legacy slope tilt (0 = upright); collision expands the AABB when set. */
  rotX?: number;
  /** Horizontal face counts as a navigable surface (floors, roofs, stairs). */
  navSurface?: boolean;
  /** Texture tile size in metres. */
  tile?: number;
  /** Decorative only — skipped by collision and nav. */
  decor?: boolean;
}

export interface LootSpot {
  x: number; y: number; z: number;
  /** 0 = outskirts, 1 = village, 2 = town, 3 = military / high value. */
  tier: number;
  indoor: boolean;
}

export interface VehicleSpawn {
  x: number; y: number; z: number;
  rotY: number;
  type: 'car' | 'bike' | 'buggy';
}

export interface TreeInstance {
  x: number; y: number; z: number;
  scale: number;
  rotY: number;
  /** 0 = conifer, 1 = broadleaf, 2 = palm, 3 = small/bare (no collider). */
  kind: number;
}

export interface RockInstance {
  x: number; y: number; z: number;
  scale: number; rotY: number;
}

export interface BushInstance {
  x: number; y: number; z: number;
  scale: number;
  rotY: number;
}

export interface Road {
  kind: 'highway' | 'street' | 'trail' | 'runway';
  points: { x: number; z: number }[];
  width: number;
}

export type POIType =
  | 'CITY' | 'TOWN' | 'INDUSTRIAL' | 'FARM' | 'DOCK' | 'FOREST'
  | 'QUARRY' | 'AIRFIELD' | 'RUINS' | 'RESORT';

export interface POI {
  id: number;
  name: string;
  type: POIType;
  x: number;
  z: number;
  y: number;
  radius: number;
  /** Loot quality multiplier (0 outskirts .. 3 military). */
  tier: number;
  /** Alias kept for loot tables that read `lootTier`. */
  lootTier: number;
}

export interface BuildingRecord {
  x: number; z: number; y: number;
  radius: number;
  floors: number;
  /** Loot quality of the building's POI. */
  tier: number;
  /** Inside-loot anchor. */
  indoor: boolean;
  loot: { x: number; y: number; z: number }[];
}

export interface Landmark {
  name: string;
  x: number; z: number; y: number;
  kind: string;
}

export interface MapLayout {
  seed: number;
  terrain: TerrainData;
  pois: POI[];
  boxes: WorldBox[];
  buildings: BuildingRecord[];
  roads: Road[];
  lootSpots: LootSpot[];
  vehicleSpawns: VehicleSpawn[];
  trees: TreeInstance[];
  rocks: RockInstance[];
  bushes: BushInstance[];
  landmarks: Landmark[];
  /** Bot drop clusters (POI-centred) used by the match director. */
  botLandingZones: { x: number; z: number; y: number; poi: string }[];
  /** Flat spawn candidates used by arena modes, respawns and bot drops. */
  spawnPoints: { x: number; y: number; z: number }[];
  /** Centre of the training range. */
  rangeCentre: { x: number; y: number; z: number };
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                    */
/* -------------------------------------------------------------------------- */

class LayoutBuilder {
  boxes: WorldBox[] = [];
  buildings: BuildingRecord[] = [];
  loot: LootSpot[] = [];
  vehicles: VehicleSpawn[] = [];
  trees: TreeInstance[] = [];
  rocks: RockInstance[] = [];
  bushes: BushInstance[] = [];
  /** 2 m occupancy grid: buildings, roads, props. */
  occupancy: Uint8Array;
  occCell = 2;
  occRes: number;

  constructor(public terrain: TerrainData) {
    this.occRes = Math.floor(terrain.size / this.occCell);
    this.occupancy = new Uint8Array(this.occRes * this.occRes);
  }

  block(x: number, z: number, w: number, d: number): void {
    const g = this.occCell;
    const i0 = Math.max(0, Math.floor((x - w / 2 + this.terrain.half) / g));
    const i1 = Math.min(this.occRes - 1, Math.ceil((x + w / 2 + this.terrain.half) / g));
    const j0 = Math.max(0, Math.floor((z - d / 2 + this.terrain.half) / g));
    const j1 = Math.min(this.occRes - 1, Math.ceil((z + d / 2 + this.terrain.half) / g));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) this.occupancy[j * this.occRes + i] = 1;
    }
  }

  isBlocked(x: number, z: number, pad = 1): boolean {
    const g = this.occCell;
    const i = Math.floor((x + this.terrain.half) / g);
    const j = Math.floor((z + this.terrain.half) / g);
    for (let dj = -pad; dj <= pad; dj++) {
      for (let di = -pad; di <= pad; di++) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= this.occRes || jj >= this.occRes) return true;
        if (this.occupancy[jj * this.occRes + ii]) return true;
      }
    }
    return false;
  }

  box(
    kind: SurfaceKey,
    x: number, y: number, z: number,
    w: number, h: number, d: number,
    opts: { collide?: boolean; navSurface?: boolean; tile?: number; rotY?: number; decor?: boolean } = {}
  ): void {
    this.boxes.push({
      kind, x, y, z, w, h, d,
      collide: opts.collide ?? true,
      navSurface: opts.navSurface ?? false,
      tile: opts.tile ?? 2,
      rotY: opts.rotY ?? 0,
      decor: opts.decor ?? false
    });
    if ((opts.collide ?? true) && h > 0.9) this.block(x, z, w + 0.4, d + 0.4);
  }

  /** Reserves a corridor (road) in the occupancy grid, skipping POI interiors. */
  blockPath(points: { x: number; z: number }[], width: number, pois: POI[]): void {
    for (let seg = 0; seg < points.length - 1; seg++) {
      const a = points[seg];
      const b = points[seg + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 6));
      for (let k = 0; k <= steps; k++) {
        const u = k / steps;
        const x = a.x + (b.x - a.x) * u;
        const z = a.z + (b.z - a.z) * u;
        let inPoi = false;
        for (const p of pois) {
          if (Math.hypot(p.x - x, p.z - z) < p.radius * 0.92) { inPoi = true; break; }
        }
        if (inPoi) continue;
        this.block(x, z, width + 3, width + 3);
      }
    }
  }

  lootSpot(x: number, y: number, z: number, tier: number, indoor: boolean): void {
    this.loot.push({ x, y, z, tier, indoor });
  }
}

/* -------------------------------------------------------------------------- */
/* Structures                                                                  */
/* -------------------------------------------------------------------------- */

function wallRun(
  lb: LayoutBuilder,
  kind: SurfaceKey,
  x0: number, z0: number, x1: number, z1: number,
  y: number, height: number, thickness: number,
  gaps: { at: number; width: number; bottom: number; top: number }[] = []
): void {
  const horizontal = Math.abs(x1 - x0) > Math.abs(z1 - z0);
  const len = horizontal ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
  const dir = horizontal ? Math.sign(x1 - x0) || 1 : Math.sign(z1 - z0) || 1;
  const segs: [number, number][] = [];
  let cursor = 0;
  const sorted = [...gaps].sort((a, b) => a.at - b.at);
  for (const gap of sorted) {
    const start = gap.at - gap.width / 2;
    const end = gap.at + gap.width / 2;
    if (start > cursor) segs.push([cursor, start]);
    cursor = Math.max(cursor, end);
    // Wall above/below the opening.
    const cx = horizontal ? x0 + dir * gap.at : x0;
    const cz = horizontal ? z0 : z0 + dir * gap.at;
    if (gap.bottom > 0) {
      lb.box(kind, cx, y + gap.bottom / 2, cz,
        horizontal ? gap.width : thickness, gap.bottom, horizontal ? thickness : gap.width,
        { tile: 2 });
    }
    if (gap.top < height) {
      const hh = height - gap.top;
      lb.box(kind, cx, y + gap.top + hh / 2, cz,
        horizontal ? gap.width : thickness, hh, horizontal ? thickness : gap.width,
        { tile: 2 });
    }
  }
  if (cursor < len) segs.push([cursor, len]);
  for (const [a, b] of segs) {
    const w = b - a;
    if (w < 0.2) continue;
    const mid = (a + b) / 2;
    const cx = horizontal ? x0 + dir * mid : x0;
    const cz = horizontal ? z0 : z0 + dir * mid;
    lb.box(kind, cx, y + height / 2, cz,
      horizontal ? w : thickness, height, horizontal ? thickness : w,
      { tile: 2 });
  }
}

/** Stair flight climbing +rise over `steps` steps in the given direction. */
function stairs(
  lb: LayoutBuilder,
  kind: SurfaceKey,
  x: number, y: number, z: number,
  width: number, rise: number, steps: number, dirX: number, dirZ: number
): void {
  const stepDepth = 0.42;
  for (let i = 0; i < steps; i++) {
    const h = rise / steps;
    const cx = x + dirX * (i + 0.5) * stepDepth;
    const cz = z + dirZ * (i + 0.5) * stepDepth;
    const cy = y + h * (i + 0.5);
    lb.box(kind, cx, cy, cz,
      dirX !== 0 ? stepDepth : width, h, dirZ !== 0 ? stepDepth : width,
      { navSurface: true, tile: 1 });
  }
}

interface HouseStyle {
  kind: SurfaceKey;
  roof: SurfaceKey;
  floors: number;
  windows: boolean;
  interior: boolean;
}

/** Rectangular enterable building with floors, stairwell and walkable roof. */
function buildHouse(
  lb: LayoutBuilder,
  cx: number, cz: number,
  width: number, depth: number,
  style: HouseStyle,
  rng: RNG,
  tier: number
): void {
  const groundY = sampleHeight(lb.terrain, cx, cz);
  const baseY = flattenDisc(lb.terrain, cx, cz, Math.max(width, depth) * 0.62, 9, groundY, 'plateau');
  const wallT = 0.35;
  const floorH = 3.1;
  const halfW = width / 2;
  const halfD = depth / 2;
  const doorW = 2.6;

  // Stairwell opening: every slab (including the roof) leaves a hole here.
  const holeX0 = cx + halfW - 5.0;
  const holeX1 = cx + halfW - 1.8;
  const holeZ0 = cz + halfD - 4.8;
  const holeZ1 = cz + halfD - 0.4;

  /** Floor / roof slab with a stairwell hole. */
  const slab = (y: number, kind: SurfaceKey, thickness: number): void => {
    const leftW = holeX0 - (cx - halfW);
    if (leftW > 0.3) {
      lb.box(kind, cx - halfW + leftW / 2, y, cz, leftW, thickness, depth, { navSurface: true, tile: 2 });
    }
    const rightW = cx + halfW - holeX1;
    if (rightW > 0.3) {
      lb.box(kind, holeX1 + rightW / 2, y, cz, rightW, thickness, depth, { navSurface: true, tile: 2 });
    }
    const midW = holeX1 - holeX0;
    const frontD = holeZ0 - (cz - halfD);
    if (frontD > 0.3) {
      lb.box(kind, (holeX0 + holeX1) / 2, y, cz - halfD + frontD / 2, midW, thickness, frontD, { navSurface: true, tile: 2 });
    }
    const backD = cz + halfD - holeZ1;
    if (backD > 0.3) {
      lb.box(kind, (holeX0 + holeX1) / 2, y, holeZ1 + backD / 2, midW, thickness, backD, { navSurface: true, tile: 2 });
    }
  };

  for (let f = 0; f < style.floors; f++) {
    const y = baseY + f * floorH;
    if (f === 0) slab(y - 0.1, 'concrete', 0.3);
    else slab(y - 0.15, style.kind === 'wood' ? 'wood' : 'concrete', 0.3);

    // Outer walls with a door on the south face and windows.
    const doorOffset = rng.range(-halfW * 0.4, halfW * 0.4);
    const gapsSouth: { at: number; width: number; bottom: number; top: number }[] = [
      { at: doorOffset, width: doorW, bottom: 0, top: 2.4 }
    ];
    const gapsOther: { at: number; width: number; bottom: number; top: number }[] = [];
    if (style.windows) {
      for (let wi = -1; wi <= 1; wi++) {
        const at = wi * width * 0.28;
        if (Math.abs(at - doorOffset) > doorW) gapsSouth.push({ at, width: 1.5, bottom: 1.1, top: 2.3 });
        gapsOther.push({ at: wi * depth * 0.28, width: 1.5, bottom: 1.1, top: 2.3 });
      }
    }
    wallRun(lb, style.kind, cx - halfW, cz + halfD, cx + halfW, cz + halfD, y, floorH, wallT, gapsSouth);
    wallRun(lb, style.kind, cx - halfW, cz - halfD, cx + halfW, cz - halfD, y, floorH, wallT, gapsOther);
    wallRun(lb, style.kind, cx - halfW, cz - halfD, cx - halfW, cz + halfD, y, floorH, wallT, gapsOther);
    wallRun(lb, style.kind, cx + halfW, cz - halfD, cx + halfW, cz + halfD, y, floorH, wallT, gapsOther);

    // Interior partition with a doorway (gives cover and room division).
    if (f === 0 && style.interior && width > 9) {
      wallRun(lb, style.kind, cx - halfW + 1.2, cz, cx + halfW - 1.2, cz, y, floorH - 0.6, 0.28, [
        { at: 0, width: 2.2, bottom: 0, top: 2.2 }
      ]);
    }
    if (width > 8) {
      lb.box(style.kind, cx + halfW - 1.6, y + 0.9, cz, 0.3, 1.8, 0.3, { collide: false, decor: true, tile: 1 });
    }
  }

  // Stairs: every level, roof included, so buildings are fully traversable.
  const stepDepth = 0.42;
  const stepCount = Math.max(6, Math.round(floorH / 0.31));
  for (let f = 0; f <= style.floors; f++) {
    const y = baseY + f * floorH;
    const sx = cx + halfW - 3.4;
    const sz = cz + halfD - 0.4;
    stairs(lb, 'concrete', sx, y, sz, 2.0, floorH, stepCount, 0, -1);
  }
  void stepDepth;

  // Roof + parapet (walkable, great for sniping positions).
  const roofY = baseY + style.floors * floorH;
  slab(roofY, style.roof, 0.3);
  const parapetH = 0.9;
  lb.box(style.kind, cx, roofY + parapetH / 2 + 0.3, cz + halfD + 0.25, width + 0.5, parapetH, 0.3, { tile: 2 });
  lb.box(style.kind, cx, roofY + parapetH / 2 + 0.3, cz - halfD - 0.25, width + 0.5, parapetH, 0.3, { tile: 2 });
  lb.box(style.kind, cx - halfW - 0.25, roofY + parapetH / 2 + 0.3, cz, 0.3, parapetH, depth + 0.5, { tile: 2 });
  lb.box(style.kind, cx + halfW - 2.2, roofY + parapetH / 2 + 0.3, cz, 0.3, parapetH * 0.6, depth + 0.5, { tile: 2 });

  // Interior loot
  const lootCount = Math.round(rng.range(2, 4) + style.floors);
  for (let i = 0; i < lootCount; i++) {
    const f = rng.int(0, Math.max(0, style.floors - 1));
    const lx = cx + rng.range(-halfW + 1.2, halfW - 1.2);
    const lz = cz + rng.range(-halfD + 1.2, halfD - 1.2);
    const ly = baseY + f * floorH + 0.3;
    lb.lootSpot(lx, ly, lz, tier, true);
  }

  lb.buildings.push({
    x: cx, z: cz, y: baseY,
    radius: Math.hypot(halfW, halfD),
    floors: style.floors,
    tier,
    indoor: true,
    loot: []
  });
}

/** Big open industrial shed — great for close quarters fights. */
function buildWarehouse(
  lb: LayoutBuilder,
  cx: number, cz: number,
  width: number, depth: number,
  rng: RNG,
  tier: number
): void {
  const groundY = sampleHeight(lb.terrain, cx, cz);
  const baseY = flattenDisc(lb.terrain, cx, cz, Math.max(width, depth) * 0.6, 10, groundY, 'plateau');
  const wallT = 0.4;
  const height = 7.5;
  const halfW = width / 2;
  const halfD = depth / 2;

  lb.box('concrete', cx, baseY - 0.1, cz, width + 1.5, 0.35, depth + 1.5, { navSurface: true, tile: 3 });

  // Long walls with roll-up door openings on both long sides.
  const doorW = 5.5;
  const gaps: { at: number; width: number; bottom: number; top: number }[] = [];
  for (let i = 0; i < 2; i++) {
    const at = (i === 0 ? -1 : 1) * width * 0.28;
    gaps.push({ at, width: doorW, bottom: 0, top: 5.0 });
  }
  wallRun(lb, 'metal', cx - halfW, cz + halfD, cx + halfW, cz + halfD, baseY, height, wallT, gaps);
  wallRun(lb, 'metal', cx - halfW, cz - halfD, cx + halfW, cz - halfD, baseY, height, wallT, []);
  wallRun(lb, 'brick', cx - halfW, cz - halfD, cx - halfW, cz + halfD, baseY, height, wallT, []);
  wallRun(lb, 'brick', cx + halfW, cz - halfD, cx + halfW, cz + halfD, baseY, height, wallT, []);

  // Roof
  lb.box('roof', cx, baseY + height + 0.2, cz, width + 1.2, 0.4, depth + 1.2, { navSurface: true, tile: 3 });

  // Interior shelving racks + mezzanine
  const rows = Math.max(2, Math.floor(depth / 6));
  for (let r = 0; r < rows; r++) {
    const rz = cz - halfD + 3 + r * 6;
    if (rz > cz + halfD - 3) break;
    lb.box('steelDark', cx - width * 0.22, baseY + 1.6, rz, 2.4, 3.2, 1.2, { tile: 1 });
    lb.box('steelDark', cx + width * 0.22, baseY + 1.6, rz, 2.4, 3.2, 1.2, { tile: 1 });
    if (r % 2 === 0) lb.box('crate', cx, baseY + 0.6, rz + 2.4, 1.6, 1.2, 1.6, { navSurface: true, tile: 1 });
  }
  // Mezzanine along one wall, reached by stairs.
  const mezW = width * 0.3;
  lb.box('metal', cx + halfW - mezW / 2 - 0.6, baseY + 4.2, cz, mezW, 0.3, depth - 3, { navSurface: true, tile: 2 });
  stairs(lb, 'metal', cx + halfW - mezW - 1.6, baseY, cz - halfD + 4, 2.2, 4.2, 16, 1, 0);

  const lootCount = Math.round(rng.range(4, 7) + tier);
  for (let i = 0; i < lootCount; i++) {
    const onMezz = rng.bool(0.35);
    const lx = onMezz ? cx + rng.range(halfW - mezW, halfW - 1) : cx + rng.range(-halfW + 2, halfW - 2);
    const lz = cz + rng.range(-halfD + 2, halfD - 2);
    const ly = baseY + (onMezz ? 4.5 : 0.35);
    lb.lootSpot(lx, ly, lz, tier, true);
  }
  lb.buildings.push({ x: cx, z: cz, y: baseY, radius: Math.hypot(halfW, halfD), floors: 1, tier, indoor: true, loot: [] });
}

function buildContainerYard(lb: LayoutBuilder, cx: number, cz: number, w: number, d: number, rng: RNG, tier: number): void {
  const groundY = sampleHeight(lb.terrain, cx, cz);
  const baseY = flattenDisc(lb.terrain, cx, cz, Math.max(w, d) * 0.6, 8, groundY, 'plateau');
  const kinds: SurfaceKey[] = ['container1', 'container2', 'container3'];
  const cols = Math.max(2, Math.floor(w / 9));
  const rows = Math.max(2, Math.floor(d / 7));
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (rng.bool(0.25)) continue;
      const bx = cx - w / 2 + 4.5 + i * (w / cols);
      const bz = cz - d / 2 + 3.5 + j * (d / rows);
      const kind = kinds[rng.int(0, kinds.length - 1)];
      const stack = rng.bool(0.3) ? 2 : 1;
      for (let s = 0; s < stack; s++) {
        lb.box(kind, bx, baseY + 1.3 + s * 2.6, bz, 6.0, 2.5, 2.5, { navSurface: true, tile: 2 });
      }
      if (rng.bool(0.28)) lb.lootSpot(bx + rng.range(-2, 2), baseY + 0.4, bz + rng.range(-1.4, 1.4), tier, false);
    }
  }
  lb.box('concrete', cx, baseY - 0.15, cz, w, 0.35, d, { navSurface: true, collide: false });
}

function buildRuin(lb: LayoutBuilder, cx: number, cz: number, size: number, rng: RNG, tier: number): void {
  const groundY = sampleHeight(lb.terrain, cx, cz);
  const baseY = flattenDisc(lb.terrain, cx, cz, size * 0.6, 6, groundY, 'plateau');
  const half = size / 2;
  // Broken perimeter
  const segments = 6;
  for (let s = 0; s < 4; s++) {
    const horizontal = s < 2;
    const flip = s % 2 === 0 ? 1 : -1;
    const segLen = size / segments;
    for (let k = 0; k < segments; k++) {
      if (rng.bool(0.32)) continue;
      const h = rng.range(1.6, 4.2);
      const off = -half + segLen * (k + 0.5);
      const x = horizontal ? cx + off : cx + flip * half;
      const z = horizontal ? cz + flip * half : cz + off;
      lb.box('brick', x, baseY + h / 2, z,
        horizontal ? segLen * 0.94 : 0.4, h, horizontal ? 0.4 : segLen * 0.94, { tile: 1.5 });
    }
  }
  // Rubble mounds and a collapsed slab
  for (let i = 0; i < 5; i++) {
    const rx = cx + rng.range(-half, half);
    const rz = cz + rng.range(-half, half);
    lb.box('concrete', rx, baseY + 0.35, rz, rng.range(1.5, 3.2), 0.7, rng.range(1.5, 3.2), { navSurface: true, tile: 1.5 });
  }
  lb.box('concrete', cx + rng.range(-3, 3), baseY + 1.2, cz + rng.range(-3, 3), 5.4, 0.4, 3.6, { navSurface: true, tile: 2 });
  for (let i = 0; i < 4; i++) lb.lootSpot(cx + rng.range(-half, half), baseY + 0.4, cz + rng.range(-half, half), tier, false);
}

function buildTower(lb: LayoutBuilder, cx: number, cz: number, height: number, rng: RNG, tier: number): void {
  const groundY = sampleHeight(lb.terrain, cx, cz);
  const baseY = flattenDisc(lb.terrain, cx, cz, 8, 6, groundY, 'plateau');
  const leg = 0.7;
  const spread = 3.2;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    lb.box('steelDark', cx + sx * spread, baseY + height / 2, cz + sz * spread, leg, height, leg, { tile: 1 });
  }
  // Platforms + ladder-ish stair spiral
  const levels = Math.max(2, Math.floor(height / 8));
  for (let l = 1; l <= levels; l++) {
    const y = baseY + (height / levels) * l;
    lb.box('metal', cx, y, cz, spread * 2 + 2, 0.3, spread * 2 + 2, { navSurface: true, tile: 2 });
    const dir = l % 4;
    stairs(lb, 'metal',
      cx + (dir === 2 ? -spread : spread),
      y - height / levels,
      cz + (dir === 0 ? -spread : spread),
      1.6, height / levels, Math.round(height / levels / 0.42), dir === 0 || dir === 3 ? 1 : -1, dir === 0 || dir === 3 ? 1 : -1);
    if (l === levels) {
      lb.lootSpot(cx + rng.range(-2, 2), y + 0.4, cz + rng.range(-2, 2), tier + 1, false);
      lb.lootSpot(cx + rng.range(-2, 2), y + 0.4, cz + rng.range(-2, 2), tier, false);
    }
    if (l === Math.floor(levels / 2)) lb.lootSpot(cx + rng.range(-2, 2), y + 0.4, cz + rng.range(-2, 2), tier, false);
  }
  lb.buildings.push({ x: cx, z: cz, y: baseY, radius: spread + 2, floors: levels, tier, indoor: false, loot: [] });
}

function buildCheckpoint(lb: LayoutBuilder, x: number, z: number, rotY: number, rng: RNG): void {
  const y = sampleHeight(lb.terrain, x, z);
  const gy = flattenDisc(lb.terrain, x, z, 9, 6, y, 'plateau');
  // Concrete barriers
  for (let i = -2; i <= 2; i++) {
    if (i === 0) continue;
    lb.box('concrete', x + i * 3.4 * Math.cos(rotY), gy + 0.6, z + i * 3.4 * Math.sin(rotY), 3.0, 1.1, 0.8, { navSurface: true, tile: 1.5 });
  }
  lb.box('metal', x + 5 * Math.cos(rotY + Math.PI / 2), gy + 1.4, z + 5 * Math.sin(rotY + Math.PI / 2), 2.4, 2.8, 2.4, { tile: 1 });
  for (let i = 0; i < 3; i++) lb.lootSpot(x + rng.range(-5, 5), gy + 0.4, z + rng.range(-5, 5), 1, false);
}

function buildFence(lb: LayoutBuilder, x0: number, z0: number, x1: number, z1: number, height: number): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const count = Math.max(1, Math.floor(len / 4));
  const dx = (x1 - x0) / count;
  const dz = (z1 - z0) / count;
  for (let i = 0; i < count; i++) {
    const cx = x0 + dx * (i + 0.5);
    const cz = z0 + dz * (i + 0.5);
    const y = sampleHeight(lb.terrain, cx, cz);
    const horizontal = Math.abs(dx) > Math.abs(dz);
    lb.box('steelDark', cx, y + height / 2, cz,
      horizontal ? Math.abs(dx) : 0.18, height, horizontal ? 0.18 : Math.abs(dz), { tile: 1 });
  }
}

function buildPier(lb: LayoutBuilder, x: number, z: number, dirX: number, dirZ: number, length: number, rng: RNG): void {
  const deckW = 6;
  const startY = Math.max(1.2, sampleHeight(lb.terrain, x, z));
  const horizontal = Math.abs(dirX) > Math.abs(dirZ);
  for (let i = 0; i < length; i += 4) {
    const cx = x + dirX * i;
    const cz = z + dirZ * i;
    lb.box('wood', cx, startY + 0.6, cz,
      horizontal ? 4 : deckW, 0.4, horizontal ? deckW : 4, { navSurface: true, tile: 2, collide: true });
    if (i % 8 === 0) {
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const lx = horizontal ? cx + ox * 2.2 : cx + ox * (deckW / 2 - 0.6);
        const lz = horizontal ? cz + oz * (deckW / 2 - 0.6) : cz + oz * 2.2;
        lb.box('steelDark', lx, startY - 1.6, lz, 0.35, 4.2, 0.35, { tile: 1 });
      }
    }
    if (i > 8 && rng.bool(0.4)) lb.lootSpot(cx + rng.range(-1.5, 1.5), startY + 1.0, cz + rng.range(-1.5, 1.5), 2, false);
  }
  lb.vehicles.push({ x: x + dirX * (length * 0.25), y: startY + 1.2, z: z + dirZ * (length * 0.25), rotY: Math.atan2(dirZ, dirX), type: 'buggy' });
}

/* -------------------------------------------------------------------------- */
/* POI generators                                                              */
/* -------------------------------------------------------------------------- */

function generateCity(lb: LayoutBuilder, poi: POI, rng: RNG): void {
  const blocks = 4;
  const blockSize = poi.radius * 1.55;
  for (let bi = 0; bi < blocks; bi++) {
    for (let bj = 0; bj < blocks; bj++) {
      const bx = poi.x - blockSize / 2 + (bi + 0.5) * (blockSize / blocks);
      const bz = poi.z - blockSize / 2 + (bj + 0.5) * (blockSize / blocks);
      const layoutKind = rng.next();
      if (layoutKind < 0.42) {
        const floors = rng.int(2, 3 + (poi.tier >= 3 ? 2 : 0));
        buildHouse(lb, bx, bz, rng.range(11, 15), rng.range(10, 14),
          { kind: rng.bool(0.6) ? 'brick' : 'concrete', roof: 'roof', floors, windows: true, interior: true },
          rng, poi.tier);
      } else if (layoutKind < 0.68) {
        buildWarehouse(lb, bx, bz, rng.range(18, 24), rng.range(14, 20), rng, poi.tier);
      } else if (layoutKind < 0.84) {
        buildRuin(lb, bx, bz, rng.range(10, 15), rng, poi.tier);
      } else {
        buildContainerYard(lb, bx, bz, rng.range(14, 20), rng.range(12, 16), rng, poi.tier);
      }
      // A parked car in some blocks
      if (rng.bool(0.45)) {
        const vx = bx + rng.range(-14, 14);
        const vz = bz + rng.range(-14, 14);
        if (!lb.isBlocked(vx, vz, 1)) {
          lb.vehicles.push({ x: vx, y: sampleHeight(lb.terrain, vx, vz), z: vz, rotY: rng.bool() ? 0 : Math.PI / 2, type: rng.bool(0.75) ? 'car' : 'bike' });
        }
      }
    }
  }
  // Central plaza with the landmark tower.
  buildWarehouse(lb, poi.x + poi.radius * 0.85, poi.z - poi.radius * 0.85, 22, 18, rng, poi.tier);
  for (let i = 0; i < 8; i++) {
    lb.lootSpot(poi.x + rng.range(-poi.radius, poi.radius), 0, poi.z + rng.range(-poi.radius, poi.radius), poi.tier, false);
  }
}

function generateTown(lb: LayoutBuilder, poi: POI, rng: RNG): void {
  const count = rng.int(10, 15);
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + rng.range(-0.2, 0.2);
    const dist = rng.range(6, poi.radius);
    const x = poi.x + Math.cos(ang) * dist;
    const z = poi.z + Math.sin(ang) * dist;
    if (lb.isBlocked(x, z, 3)) continue;
    const roll = rng.next();
    if (roll < 0.55) {
      buildHouse(lb, x, z, rng.range(8, 13), rng.range(8, 12),
        { kind: rng.bool(0.7) ? 'wood' : 'brick', roof: 'roof', floors: rng.int(1, 2), windows: true, interior: true },
        rng, poi.tier);
    } else if (roll < 0.8) {
      buildWarehouse(lb, x, z, rng.range(12, 17), rng.range(10, 14), rng, poi.tier);
    } else {
      buildRuin(lb, x, z, rng.range(8, 12), rng, poi.tier);
    }
  }
}

function generateIndustrial(lb: LayoutBuilder, poi: POI, rng: RNG): void {
  for (let i = 0; i < 5; i++) {
    const ang = (i / 5) * Math.PI * 2;
    const x = poi.x + Math.cos(ang) * poi.radius * 0.5;
    const z = poi.z + Math.sin(ang) * poi.radius * 0.5;
    buildWarehouse(lb, x, z, rng.range(20, 28), rng.range(16, 22), rng, poi.tier);
  }
  for (let i = 0; i < 3; i++) {
    const ang = rng.range(0, 6.28);
    buildContainerYard(lb, poi.x + Math.cos(ang) * poi.radius * 0.9, poi.z + Math.sin(ang) * poi.radius * 0.9,
      rng.range(16, 24), rng.range(12, 18), rng, poi.tier);
  }
  // Silos + crane + water tower
  for (let i = 0; i < 3; i++) {
    const x = poi.x + rng.range(-poi.radius * 0.7, poi.radius * 0.7);
    const z = poi.z + rng.range(-poi.radius * 0.7, poi.radius * 0.7);
    const y = sampleHeight(lb.terrain, x, z);
    flattenDisc(lb.terrain, x, z, 7, 6, y, 'plateau');
    lb.box('metal', x, y + 7, z, 6.4, 14, 6.4, { tile: 2 });
    lb.box('steelDark', x, y + 15, z, 7.4, 0.6, 7.4, { navSurface: true, tile: 2 });
    lb.lootSpot(x + rng.range(-2, 2), y + 15.4, z + rng.range(-2, 2), poi.tier + 1, false);
  }
  buildTower(lb, poi.x + poi.radius * 0.75, poi.z + poi.radius * 0.75, 26, rng, poi.tier);
  buildFence(lb, poi.x - poi.radius, poi.z - poi.radius, poi.x + poi.radius, poi.z - poi.radius, 2.6);
  buildFence(lb, poi.x - poi.radius, poi.z + poi.radius, poi.x + poi.radius, poi.z + poi.radius, 2.6);
}

function generateFarm(lb: LayoutBuilder, poi: POI, rng: RNG): void {
  // Barn + silos + greenhouses + crop rows
  buildWarehouse(lb, poi.x, poi.z, 20, 15, rng, poi.tier);
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + 0.4;
    const x = poi.x + Math.cos(ang) * poi.radius * 0.85;
    const z = poi.z + Math.sin(ang) * poi.radius * 0.85;
    if (lb.isBlocked(x, z, 3)) continue;
    buildHouse(lb, x, z, 9, 8, { kind: 'wood', roof: 'roof', floors: 1, windows: true, interior: true }, rng, poi.tier);
  }
  for (let i = 0; i < 3; i++) {
    const x = poi.x + rng.range(-poi.radius, poi.radius);
    const z = poi.z + rng.range(-poi.radius, poi.radius);
    if (lb.isBlocked(x, z, 2)) continue;
    const y = sampleHeight(lb.terrain, x, z);
    lb.box('metal', x, y + 3.4, z, 4.6, 6.8, 4.6, { tile: 2 });
    lb.lootSpot(x + rng.range(-1.5, 1.5), y + 0.5, z + rng.range(-1.5, 1.5), poi.tier, false);
  }
  // Crop rows (low boxes, good cover)
  for (let r = 0; r < 8; r++) {
    const z = poi.z - poi.radius + 6 + r * 5.5;
    for (let c = 0; c < 12; c++) {
      const x = poi.x - poi.radius + 5 + c * 5.2;
      if (lb.isBlocked(x, z, 0)) continue;
      const y = sampleHeight(lb.terrain, x, z);
      if (y < 1.2) continue;
      lb.box('foliage', x, y + 0.5, z, 4.0, 1.0, 1.4, { collide: false, decor: true, tile: 2 });
    }
  }
}

function generateDock(lb: LayoutBuilder, poi: POI, rng: RNG): void {
  buildWarehouse(lb, poi.x, poi.z, 26, 16, rng, poi.tier);
  for (let i = 0; i < 3; i++) {
    const ang = rng.range(0, 6.28);
    buildWarehouse(lb, poi.x + Math.cos(ang) * poi.radius * 0.7, poi.z + Math.sin(ang) * poi.radius * 0.7,
      rng.range(16, 22), rng.range(12, 16), rng, poi.tier);
  }
  buildContainerYard(lb, poi.x + rng.range(-poi.radius * 0.8, poi.radius * 0.8), poi.z + rng.range(-poi.radius * 0.8, poi.radius * 0.8), 20, 16, rng, poi.tier);
  for (let i = 0; i < 3; i++) {
    const ang = -Math.PI * 0.5 + (i - 1) * 0.7;
    buildPier(lb, poi.x + Math.cos(ang) * 12, poi.z + Math.sin(ang) * 12, Math.cos(ang), Math.sin(ang), 34, rng);
  }
  // Cranes
  for (const side of [-1, 1]) {
    const x = poi.x + side * poi.radius * 0.8;
    const z = poi.z - poi.radius * 0.7;
    const y = sampleHeight(lb.terrain, x, z);
    flattenDisc(lb.terrain, x, z, 6, 5, y, 'plateau');
    lb.box('paintYellow', x, y + 9, z, 3.0, 18, 3.0, { tile: 2 });
    lb.box('paintYellow', x + side * 8, y + 17.4, z, 18, 1.2, 2.2, { tile: 2 });
    lb.box('metal', x + side * 15, y + 16.6, z, 2.6, 0.9, 2.6, { navSurface: true, tile: 1.5 });
  }
}

function generateForestPOI(lb: LayoutBuilder, poi: POI, rng: RNG): void {
  for (let i = 0; i < 8; i++) {
    const ang = rng.range(0, 6.28);
    const dist = rng.range(0, poi.radius);
    const x = poi.x + Math.cos(ang) * dist;
    const z = poi.z + Math.sin(ang) * dist;
    if (lb.isBlocked(x, z, 2)) continue;
    buildHouse(lb, x, z, rng.range(7, 10), rng.range(7, 10),
      { kind: 'wood', roof: 'roof', floors: rng.int(1, 2), windows: true, interior: true }, rng, poi.tier);
  }
  buildTower(lb, poi.x + rng.range(-20, 20), poi.z + rng.range(-20, 20), 22, rng, poi.tier);
  // Log piles
  for (let i = 0; i < 6; i++) {
    const x = poi.x + rng.range(-poi.radius, poi.radius);
    const z = poi.z + rng.range(-poi.radius, poi.radius);
    const y = sampleHeight(lb.terrain, x, z);
    if (lb.isBlocked(x, z, 1) || y < 2) continue;
    lb.box('wood', x, y + 0.6, z, 3.4, 1.2, 1.2, { navSurface: true, tile: 1 });
    lb.lootSpot(x + rng.range(-2, 2), y + 0.4, z + rng.range(-2, 2), poi.tier, false);
  }
}

function generateQuarry(lb: LayoutBuilder, poi: POI, rng: RNG): void {
  // Terraced pit — carved with flattenDisc at descending heights.
  const baseY = sampleHeight(lb.terrain, poi.x, poi.z);
  const levels = 3;
  for (let l = 0; l < levels; l++) {
    const r = poi.radius * (1 - l * 0.28);
    flattenDisc(lb.terrain, poi.x, poi.z, r, 7, baseY - l * 3.2, 'plateau');
    paintBiomeDisc(lb.terrain, poi.x, poi.z, r, Biome.ROCK);
  }
  const y0 = sampleHeight(lb.terrain, poi.x, poi.z);
  // Retaining walls on two terraces + machinery
  for (let l = 1; l < levels; l++) {
    const r = poi.radius * (1 - (l - 1) * 0.28);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      lb.box('rock', poi.x + dx * r, baseY - l * 3.2 + 1.6, poi.z + dz * r,
        dx !== 0 ? 0.6 : r * 1.6, 3.2, dz !== 0 ? 0.6 : r * 1.6, { tile: 3 });
    }
  }
  lb.box('concrete', poi.x, y0 - 0.1, poi.z, poi.radius * 0.7, 0.3, poi.radius * 0.7, { navSurface: true, collide: false });
  // Crusher building + conveyor
  buildWarehouse(lb, poi.x + poi.radius * 0.9, poi.z, 20, 14, rng, poi.tier);
  const cy = sampleHeight(lb.terrain, poi.x - poi.radius * 0.8, poi.z);
  lb.box('rust', poi.x - poi.radius * 0.8, cy + 3, poi.z, 5.4, 6, 5.4, { tile: 2 });
  lb.box('steelDark', poi.x - poi.radius * 0.4, cy + 6, poi.z, poi.radius * 0.8, 1.0, 1.6, { navSurface: true, tile: 1.5 });
  for (let i = 0; i < 6; i++) {
    lb.lootSpot(poi.x + rng.range(-poi.radius * 0.8, poi.radius * 0.8), baseY + 0.4, poi.z + rng.range(-poi.radius * 0.8, poi.radius * 0.8), poi.tier, false);
  }
  void y0;
}

function generateAirfield(lb: LayoutBuilder, poi: POI, rng: RNG): void {
  // Runway (flattened strip) + hangars + tower + fuel depot
  const dirX = 1;
  const len = 190;
  const halfW = 9;
  const y = sampleHeight(lb.terrain, poi.x, poi.z);
  for (let i = -len / 2; i <= len / 2; i += 12) {
    flattenDisc(lb.terrain, poi.x + i * dirX, poi.z, halfW + 2, 8, y, 'plateau');
  }
  paintPath(lb.terrain, [{ x: poi.x - len / 2, z: poi.z }, { x: poi.x + len / 2, z: poi.z }], halfW, Biome.ASPHALT);
  lb.box('asphalt', poi.x, y + 0.03, poi.z, len, 0.14, halfW * 2, { collide: false, navSurface: true, tile: 6 });
  for (let i = 0; i < 4; i++) {
    const hx = poi.x + (i - 1.5) * 30;
    const hz = poi.z + 26 * (i % 2 === 0 ? 1 : -1);
    buildWarehouse(lb, hx, hz, rng.range(22, 28), rng.range(14, 18), rng, poi.tier);
  }
  buildTower(lb, poi.x - 60, poi.z - 34, 24, rng, poi.tier + 1);
  for (let i = 0; i < 3; i++) {
    const x = poi.x + 70 + i * 6;
    const z = poi.z + 20;
    const gy = sampleHeight(lb.terrain, x, z);
    lb.box('white', x, gy + 2.4, z, 5, 4.8, 5, { tile: 2 });
    lb.lootSpot(x + rng.range(-2, 2), gy + 0.4, z + rng.range(-2, 2), poi.tier, false);
  }
  for (let i = 0; i < 4; i++) {
    lb.vehicles.push({ x: poi.x + rng.range(-80, 80), y: sampleHeight(lb.terrain, poi.x, poi.z), z: poi.z + rng.range(-30, 30), rotY: rng.range(0, 6.28), type: rng.bool(0.5) ? 'buggy' : 'car' });
  }
}

function generateResort(lb: LayoutBuilder, poi: POI, rng: RNG): void {
  // Coastal hotel complex: a long block, pool deck, cabanas, boardwalk.
  buildHouse(lb, poi.x, poi.z, 26, 14, { kind: 'concrete', roof: 'roof', floors: 3, windows: true, interior: true }, rng, poi.tier + 1);
  buildHouse(lb, poi.x + 22, poi.z + 8, 14, 12, { kind: 'concrete', roof: 'roof', floors: 2, windows: true, interior: true }, rng, poi.tier);
  const py = sampleHeight(lb.terrain, poi.x - 18, poi.z + 10);
  flattenDisc(lb.terrain, poi.x - 18, poi.z + 10, 11, 6, py, 'plateau');
  lb.box('paintBlue', poi.x - 18, py + 0.1, poi.z + 10, 18, 0.25, 12, { collide: false, navSurface: true, tile: 3 });
  for (let i = 0; i < 6; i++) {
    const cx = poi.x - 26 + (i % 3) * 8;
    const cz = poi.z + 4 + Math.floor(i / 3) * 12;
    const y = sampleHeight(lb.terrain, cx, cz);
    lb.box('fabric', cx, y + 1.6, cz, 3, 0.2, 3, { navSurface: true, tile: 1.5 });
    for (const [ox, oz] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) {
      lb.box('white', cx + ox, y + 0.8, cz + oz, 0.12, 1.6, 0.12, { tile: 1 });
    }
    lb.lootSpot(cx + rng.range(-1, 1), y + 0.4, cz + rng.range(-1, 1), poi.tier, false);
  }
  // Boardwalk to the beach
  const by = Math.max(0.6, sampleHeight(lb.terrain, poi.x - 30, poi.z));
  lb.box('wood', poi.x - 30, by + 0.4, poi.z, 26, 0.3, 5, { navSurface: true, tile: 2 });
  buildPier(lb, poi.x - 40, poi.z, -1, 0, 40, rng);
}

/* -------------------------------------------------------------------------- */
/* Terrain shaping helpers for POIs                                            */
/* -------------------------------------------------------------------------- */

function road(points: { x: number; z: number }[], width: number, kind: Road['kind'], lb: LayoutBuilder, pois: POI[] = []): void {
  flattenPath(lb.terrain, points, width * 0.5, 10, true);
  paintPath(lb.terrain, points, width * 0.5, kind === 'trail' ? Biome.DIRT : Biome.ASPHALT);
  lb.blockPath(points, width * 0.5, pois);
}

/* -------------------------------------------------------------------------- */
/* Main entry                                                                  */
/* -------------------------------------------------------------------------- */

const POI_TEMPLATES: { name: string; type: POIType; radius: number; tier: number; dir: [number, number] }[] = [
  { name: 'Ravensport', type: 'CITY', radius: 78, tier: 3, dir: [0, 0] },
  { name: 'Foundry Row', type: 'INDUSTRIAL', radius: 70, tier: 3, dir: [-0.72, -0.34] },
  { name: 'Coral Bay', type: 'DOCK', radius: 66, tier: 2, dir: [0.80, -0.30] },
  { name: 'Amber Fields', type: 'FARM', radius: 60, tier: 1, dir: [-0.44, 0.66] },
  { name: 'Whisperwood', type: 'FOREST', radius: 70, tier: 1, dir: [0.38, 0.70] },
  { name: 'Sunken Quarry', type: 'QUARRY', radius: 62, tier: 2, dir: [0.86, 0.34] },
  { name: 'Osprey Airfield', type: 'AIRFIELD', radius: 76, tier: 3, dir: [-0.86, 0.14] },
  { name: 'Hollow Village', type: 'TOWN', radius: 48, tier: 1, dir: [0.16, -0.72] },
  { name: 'Ashfall Ruins', type: 'RUINS', radius: 54, tier: 2, dir: [-0.24, -0.80] },
  { name: 'Tidewater Resort', type: 'RESORT', radius: 52, tier: 2, dir: [0.52, 0.86] }
];

export function generateLayout(terrain: TerrainData, seed = 20260926): MapLayout {
  const rng = new RNG(seed).fork(1);
  const lb = new LayoutBuilder(terrain);
  const half = terrain.half;
  const pois: POI[] = [];

  // Place POIs on the ring of the island, keeping a comfortable margin from the sea.
  for (let i = 0; i < POI_TEMPLATES.length; i++) {
    const tpl = POI_TEMPLATES[i];
    const dist = i === 0 ? 0 : rng.range(0.52, 0.78) * half;
    let x = tpl.dir[0] * dist;
    let z = tpl.dir[1] * dist;
    if (i === 0) {
      x = rng.range(-40, 40);
      z = rng.range(-40, 40);
    }
    const spot = findFlatSpot(terrain, rng, x, z, 160, 0.42, Math.min(tpl.radius * 0.7, 46));
    if (!spot) {
      // Fall back to a coarse scan so a POI is never dropped.
      const fallback = findFlatSpot(terrain, rng, 0, 0, half * 0.62, 0.5, 24);
      if (!fallback) continue;
      x = fallback.x;
      z = fallback.z;
    } else {
      x = spot.x;
      z = spot.z;
    }
    // Keep POIs from overlapping without reserving their own footprint for
    // structures (the generators place buildings inside it).
    let tooClose = false;
    for (const other of pois) {
      if (Math.hypot(other.x - x, other.z - z) < (other.radius + tpl.radius) * 0.92) { tooClose = true; break; }
    }
    if (tooClose) {
      const spot2 = findFlatSpot(terrain, rng, x * 1.25, z * 1.25, 200, 0.45, Math.min(tpl.radius * 0.7, 46));
      if (spot2) { x = spot2.x; z = spot2.z; }
    }
    const y = flattenDisc(terrain, x, z, tpl.radius * 0.75, 26, undefined, 'plateau');
    const poi: POI = {
      id: pois.length, name: tpl.name, type: tpl.type, x, z, y,
      radius: tpl.radius, tier: tpl.tier, lootTier: tpl.tier
    };
    pois.push(poi);
  }

  // Road network: connect each POI to its nearest neighbour and to the city.
  const city = pois.find((p) => p.type === 'CITY') ?? pois[0];
  for (const poi of pois) {
    if (poi === city) continue;
    const straight = { x: (poi.x + city.x) / 2 + rng.range(-40, 40), z: (poi.z + city.z) / 2 + rng.range(-40, 40) };
    road([{ x: city.x, z: city.z }, straight, { x: poi.x, z: poi.z }], 9, 'highway', lb, pois);
  }
  // Ring road linking the outer POIs (mirrors the island shape).
  const ring = [...pois].sort((a, b) => Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x));
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a === city || b === city) continue;
    const mx = (a.x + b.x) / 2 + rng.range(-50, 50);
    const mz = (a.z + b.z) / 2 + rng.range(-50, 50);
    road([{ x: a.x, z: a.z }, { x: mx, z: mz }, { x: b.x, z: b.z }], 7.5, 'street', lb, pois);
  }

  // Build the POI contents.
  for (const poi of pois) {
    const poiRng = rng.fork(100 + poi.id);
    switch (poi.type) {
      case 'CITY': generateCity(lb, poi, poiRng); break;
      case 'TOWN': generateTown(lb, poi, poiRng); break;
      case 'INDUSTRIAL': generateIndustrial(lb, poi, poiRng); break;
      case 'FARM': generateFarm(lb, poi, poiRng); break;
      case 'DOCK': generateDock(lb, poi, poiRng); break;
      case 'FOREST': generateForestPOI(lb, poi, poiRng); break;
      case 'QUARRY': generateQuarry(lb, poi, poiRng); break;
      case 'AIRFIELD': generateAirfield(lb, poi, poiRng); break;
      case 'RUINS': for (let i = 0; i < 12; i++) {
        const ang = poiRng.range(0, 6.28);
        const d = poiRng.range(0, poi.radius * 0.85);
        buildRuin(lb, poi.x + Math.cos(ang) * d, poi.z + Math.sin(ang) * d, poiRng.range(9, 16), poiRng, poi.tier);
      } break;
      case 'RESORT': generateResort(lb, poi, poiRng); break;
    }
    // Roadside checkpoints around each POI
    const cpr = poiRng.fork(9);
    for (let i = 0; i < 3; i++) {
      const ang = cpr.range(0, 6.28);
      const d = poi.radius * cpr.range(1.05, 1.3);
      buildCheckpoint(lb, poi.x + Math.cos(ang) * d, poi.z + Math.sin(ang) * d, ang, cpr);
    }
    // Loose outdoor loot on the outskirts
    for (let i = 0; i < 14; i++) {
      const ang = cpr.range(0, 6.28);
      const d = poiRng.range(0, poi.radius * 1.15);
      const x = poi.x + Math.cos(ang) * d;
      const z = poi.z + Math.sin(ang) * d;
      const y = sampleHeight(terrain, x, z);
      if (y < 0.8 || lb.isBlocked(x, z, 0)) continue;
      lb.lootSpot(x, y + 0.35, z, Math.max(0, poi.tier - 1), false);
    }
  }

  // Outskirts loot along roads (keeps the early game flowing)
  const roadRng = rng.fork(7);
  for (let i = 0; i < 90; i++) {
    const x = roadRng.range(-half * 0.82, half * 0.82);
    const z = roadRng.range(-half * 0.82, half * 0.82);
    const y = sampleHeight(terrain, x, z);
    if (y < 1.0 || sampleSlope(terrain, x, z) > 0.7) continue;
    lb.lootSpot(x, y + 0.35, z, 0, false);
  }

  /* ---------------- Vehicles ---------------- */
  for (let i = 0; i < 26; i++) {
    const x = roadRng.range(-half * 0.8, half * 0.8);
    const z = roadRng.range(-half * 0.8, half * 0.8);
    const y = sampleHeight(terrain, x, z);
    if (y < 1.5 || sampleSlope(terrain, x, z) > 0.4) continue;
    lb.vehicles.push({ x, y, z, rotY: roadRng.range(0, Math.PI * 2), type: roadRng.bool(0.7) ? 'car' : roadRng.bool(0.6) ? 'bike' : 'buggy' });
  }

  /* ---------------- Vegetation ---------------- */
  const vegRng = rng.fork(3);
  const treeBudget = 3400;
  const beachNoise = vegRng.fork(11);
  for (let i = 0; i < treeBudget * 6 && lb.trees.length < treeBudget; i++) {
    const x = beachNoise.range(-half + 24, half - 24);
    const z = beachNoise.range(-half + 24, half - 24);
    const y = sampleHeight(terrain, x, z);
    if (y < 2.6) continue;
    if (sampleSlope(terrain, x, z) > 0.62) continue;
    if (lb.isBlocked(x, z, 2)) continue;
    const biome = pixelBiome(terrain, x, z);
    if (biome === Biome.ASPHALT) continue;
    const forest = biome === Biome.FOREST;
    const grass = biome === Biome.GRASS;
    const coast = y < 4.5;
    if (!forest && !grass && !coast) continue;
    const chance = forest ? 0.85 : grass ? 0.28 : 0.22;
    if (!beachNoise.bool(chance)) continue;
    const kind = coast ? 2 : forest ? (beachNoise.bool(0.7) ? 0 : 1) : (beachNoise.bool(0.5) ? 1 : 0);
    lb.trees.push({
      x, y, z,
      scale: beachNoise.range(0.78, 1.45) * (forest ? 1.1 : 1),
      rotY: beachNoise.range(0, 6.28),
      kind
    });
    if (kind !== 2 && beachNoise.bool(0.35)) {
      lb.block(x, z, 2, 2);
    }
  }
  const rockBudget = 700;
  for (let i = 0; i < rockBudget * 4 && lb.rocks.length < rockBudget; i++) {
    const x = vegRng.range(-half + 20, half - 20);
    const z = vegRng.range(-half + 20, half - 20);
    const y = sampleHeight(terrain, x, z);
    if (y < 0.8) continue;
    if (lb.isBlocked(x, z, 1)) continue;
    const biome = pixelBiome(terrain, x, z);
    const steep = sampleSlope(terrain, x, z) > 0.55;
    if (!steep && biome !== Biome.ROCK && !vegRng.bool(0.18)) continue;
    lb.rocks.push({ x, y, z, scale: vegRng.range(0.7, 2.4), rotY: vegRng.range(0, 6.28) });
  }
  const bushBudget = 1400;
  for (let i = 0; i < bushBudget * 4 && lb.bushes.length < bushBudget; i++) {
    const x = vegRng.range(-half + 16, half - 16);
    const z = vegRng.range(-half + 16, half - 16);
    const y = sampleHeight(terrain, x, z);
    if (y < 1.6 || lb.isBlocked(x, z, 1)) continue;
    const biome = pixelBiome(terrain, x, z);
    if (biome !== Biome.GRASS && biome !== Biome.FOREST && !vegRng.bool(0.2)) continue;
    lb.bushes.push({ x, y, z, scale: vegRng.range(0.6, 1.25), rotY: vegRng.range(0, 6.28) });
  }

  /* ---------------- Roads as render data ---------------- */
  const roads: Road[] = [];
  for (const poi of pois) {
    if (poi === city) continue;
    roads.push({
      kind: 'highway',
      width: 9,
      points: [{ x: city.x, z: city.z }, { x: poi.x, z: poi.z }]
    });
  }

  /* ---------------- Spawns ---------------- */
  const spawnRng = rng.fork(21);
  const spawnPoints: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < 240; i++) {
    const x = spawnRng.range(-half * 0.75, half * 0.75);
    const z = spawnRng.range(-half * 0.75, half * 0.75);
    const y = sampleHeight(terrain, x, z);
    if (y < 1.6 || sampleSlope(terrain, x, z) > 0.45) continue;
    spawnPoints.push({ x, y, z });
  }

  const rangeCentreRaw = findFlatSpot(terrain, spawnRng, -city.x * 0.35, -city.z * 0.35, 260, 0.16, 34);
  const rangeCentre = rangeCentreRaw ?? { x: city.x + 120, y: sampleHeight(terrain, city.x + 120, city.z), z: city.z + 120 };
  buildTrainingRange(lb, rangeCentre, spawnRng.fork(5));

  const landmarks: Landmark[] = pois.map((p) => ({ name: p.name, x: p.x, z: p.z, y: p.y, kind: p.type }));
  landmarks.push({ name: 'Training Range', x: rangeCentre.x, z: rangeCentre.z, y: rangeCentre.y, kind: 'RANGE' });

  const botLandingZones = pois.map((p) => ({ x: p.x, z: p.z, y: p.y, poi: p.name }));

  return {
    seed,
    terrain,
    pois,
    botLandingZones,
    boxes: lb.boxes,
    buildings: lb.buildings,
    roads,
    lootSpots: lb.loot,
    vehicleSpawns: lb.vehicles,
    trees: lb.trees,
    rocks: lb.rocks,
    bushes: lb.bushes,
    landmarks,
    spawnPoints,
    rangeCentre
  };
}

function pixelBiome(terrain: TerrainData, x: number, z: number): number {
  const i = Math.round((x + terrain.half) / terrain.cell);
  const j = Math.round((z + terrain.half) / terrain.cell);
  if (i < 0 || j < 0 || i > terrain.res || j > terrain.res) return Biome.WATER;
  return terrain.biome[j * (terrain.res + 1) + i];
}

/** A compact firing range used by the Training mode. */
function buildTrainingRange(lb: LayoutBuilder, centre: { x: number; y: number; z: number }, rng: RNG): void {
  const y = flattenDisc(lb.terrain, centre.x, centre.z, 46, 22, centre.y, 'plateau');
  // Firing line platform
  lb.box('concrete', centre.x, y + 0.25, centre.z + 18, 40, 0.5, 10, { navSurface: true, tile: 3 });
  // Lane dividers
  for (let i = -3; i <= 3; i++) {
    lb.box('paintYellow', centre.x + i * 5.5, y + 0.9, centre.z + 16, 0.25, 0.8, 4, { tile: 1 });
  }
  // Target stands at three distances
  const distances = [22, 40, 62];
  for (let lane = 0; lane < 6; lane++) {
    for (let d = 0; d < distances.length; d++) {
      const x = centre.x - 16.5 + lane * 6.6;
      const z = centre.z + 14 - distances[d];
      lb.box('steelDark', x, y + 0.1, z, 1.0, 0.2, 1.0, { navSurface: true, tile: 1 });
      lb.box('paintRed', x, y + 1.0, z, 0.7, 1.6, 0.18, { collide: false, decor: true, tile: 1 });
    }
  }
  // Ammo + weapon tables
  for (let i = 0; i < 8; i++) {
    const x = centre.x - 17 + (i % 4) * 11;
    const z = centre.z + 20 + Math.floor(i / 4) * 3;
    lb.box('wood', x, y + 0.5, z, 2.4, 1.0, 1.0, { navSurface: true, tile: 1 });
    lb.lootSpot(x, y + 1.1, z, 3, false);
  }
  // Cover wall on the range edge
  lb.box('concrete', centre.x, y + 1.4, centre.z - 52, 44, 2.8, 1.0, { tile: 3 });
  // Vehicle pad so the player can practice driving
  lb.box('asphalt', centre.x + 34, y + 0.05, centre.z + 20, 22, 0.2, 16, { collide: false, navSurface: true, tile: 4 });
  lb.vehicles.push({ x: centre.x + 30, y: y + 0.4, z: centre.z + 18, rotY: 0.4, type: 'car' });
  lb.vehicles.push({ x: centre.x + 37, y: y + 0.4, z: centre.z + 22, rotY: 1.2, type: 'bike' });
  void rng;
}

/** Backwards-compatible alias (older harnesses import this name). */
export const generateMapLayout = generateLayout;
