import { WATER_LEVEL, sampleHeight, sampleSlope, type TerrainData } from '../world/Terrain';
import type { MapLayout } from '../world/MapLayout';

/**
 * Coarse navigation grid for AI pathing.
 *
 * Cells are walkable when they are dry land with a sane slope. Building
 * footprints get a traversal cost penalty (rather than being walled off) so
 * bots prefer going around a house but can still cut through a doorway when
 * that is clearly the better route — the local steering layer handles the
 * actual door alignment.
 */

export const NAV_RES = 192;

export class NavGrid {
  readonly res: number;
  readonly cell: number;
  readonly half: number;
  readonly walkable: Uint8Array;
  readonly cost: Float32Array;
  readonly height: Float32Array;
  /** Was this cell marked as "inside/next to a structure"? Used for cover logic. */
  readonly structure: Uint8Array;

  // Scratch buffers reused between searches (single-threaded use only).
  private gScore: Float32Array;
  private fScore: Float32Array;
  private cameFrom: Int32Array;
  private openStamp: Int32Array;
  private closedStamp: Int32Array;
  private stamp = 0;
  private openHeap: number[] = [];

  constructor(terrain: TerrainData, layout: MapLayout, res = NAV_RES) {
    this.res = res;
    this.cell = terrain.size / res;
    this.half = terrain.half;
    const n = res * res;
    this.walkable = new Uint8Array(n);
    this.cost = new Float32Array(n);
    this.height = new Float32Array(n);
    this.structure = new Uint8Array(n);
    this.gScore = new Float32Array(n);
    this.fScore = new Float32Array(n);
    this.cameFrom = new Int32Array(n);
    this.openStamp = new Int32Array(n);
    this.closedStamp = new Int32Array(n);

    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = -this.half + (i + 0.5) * this.cell;
        const z = -this.half + (j + 0.5) * this.cell;
        const y = sampleHeight(terrain, x, z);
        const slope = sampleSlope(terrain, x, z);
        const id = j * res + i;
        this.height[id] = y;
        // Off-map border and water are impassable.
        const inBounds = Math.abs(x) < this.half - 6 && Math.abs(z) < this.half - 6;
        this.walkable[id] = inBounds && y > WATER_LEVEL + 0.55 && slope < 1.05 ? 1 : 0;
        this.cost[id] = 1 + slope * 1.4;
      }
    }

    // Buildings: mark +25% cost, and flag as structure cover.
    for (const b of layout.buildings) {
      const r = b.radius + 2.5;
      const i0 = Math.max(0, Math.floor((b.x - r + this.half) / this.cell));
      const i1 = Math.min(res - 1, Math.ceil((b.x + r + this.half) / this.cell));
      const j0 = Math.max(0, Math.floor((b.z - r + this.half) / this.cell));
      const j1 = Math.min(res - 1, Math.ceil((b.z + r + this.half) / this.cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const id = j * res + i;
          this.cost[id] += 1.6;
          this.structure[id] = 1;
        }
      }
    }

    // Impassable obstacles (containers, rocks, walls) raise cost so paths curve.
    for (const box of layout.boxes) {
      if (!box.collide) continue;
      if (box.h < 1.1) continue;
      const r = Math.max(box.w, box.d) * 0.5 + 0.6;
      const i0 = Math.max(0, Math.floor((box.x - r + this.half) / this.cell));
      const i1 = Math.min(res - 1, Math.ceil((box.x + r + this.half) / this.cell));
      const j0 = Math.max(0, Math.floor((box.z - r + this.half) / this.cell));
      const j1 = Math.min(res - 1, Math.ceil((box.z + r + this.half) / this.cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const id = j * res + i;
          this.cost[id] += box.w * box.d > 40 ? 3.2 : 1.1;
        }
      }
    }
  }

  cellIndex(x: number, z: number): number {
    const i = Math.min(this.res - 1, Math.max(0, Math.floor((x + this.half) / this.cell)));
    const j = Math.min(this.res - 1, Math.max(0, Math.floor((z + this.half) / this.cell)));
    return j * this.res + i;
  }

  cellCenter(id: number): { x: number; z: number } {
    const i = id % this.res;
    const j = (id / this.res) | 0;
    return { x: -this.half + (i + 0.5) * this.cell, z: -this.half + (j + 0.5) * this.cell };
  }

  isWalkable(x: number, z: number): boolean {
    return this.walkable[this.cellIndex(x, z)] === 1;
  }

  /** Nearest walkable cell to a position (spiral search). */
  nearestWalkable(x: number, z: number, maxRings = 12): { x: number; z: number } | null {
    const startId = this.cellIndex(x, z);
    if (this.walkable[startId]) return { x, z };
    const start = this.cellCenter(startId);
    const i0 = startId % this.res;
    const j0 = (startId / this.res) | 0;
    for (let ring = 1; ring <= maxRings; ring++) {
      for (let dj = -ring; dj <= ring; dj++) {
        for (let di = -ring; di <= ring; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
          const i = i0 + di;
          const j = j0 + dj;
          if (i < 0 || j < 0 || i >= this.res || j >= this.res) continue;
          const id = j * this.res + i;
          if (this.walkable[id]) return this.cellCenter(id);
        }
      }
    }
    void start;
    return null;
  }

  /**
   * A* path between two world positions. Returns waypoints (world space) or an
   * empty array when unreachable. Cost-aware so bots avoid open crossfire.
   */
  findPath(sx: number, sz: number, tx: number, tz: number, maxNodes = 4200): { x: number; z: number }[] {
    const start = this.cellIndex(sx, sz);
    let goal = this.cellIndex(tx, tz);
    if (!this.walkable[goal]) {
      const alt = this.nearestWalkable(tx, tz, 8);
      if (!alt) return [];
      goal = this.cellIndex(alt.x, alt.z);
    }
    if (start === goal) return [{ x: tx, z: tz }];

    this.stamp++;
    const stamp = this.stamp;
    const open = this.openHeap;
    open.length = 0;
    this.gScore[start] = 0;
    this.fScore[start] = this.heuristic(start, goal);
    this.cameFrom[start] = -1;
    this.openStamp[start] = stamp;
    open.push(start);

    let visited = 0;
    let found = false;
    while (open.length > 0 && visited < maxNodes) {
      // Binary-heap-free extraction: find the lowest f (open lists stay small).
      let bestIdx = 0;
      let bestF = this.fScore[open[0]];
      for (let i = 1; i < open.length; i++) {
        const f = this.fScore[open[i]];
        if (f < bestF) {
          bestF = f;
          bestIdx = i;
        }
      }
      const current = open[bestIdx];
      open[bestIdx] = open[open.length - 1];
      open.pop();
      if (current === goal) {
        found = true;
        break;
      }
      this.closedStamp[current] = stamp;
      visited++;
      const ci = current % this.res;
      const cj = (current / this.res) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= this.res || j >= this.res) continue;
          const nid = j * this.res + i;
          if (!this.walkable[nid]) continue;
          if (this.closedStamp[nid] === stamp) continue;
          // Diagonal moves must not clip through blocked corners.
          if (di !== 0 && dj !== 0) {
            if (!this.walkable[cj * this.res + i] || !this.walkable[j * this.res + ci]) continue;
          }
          const step = di !== 0 && dj !== 0 ? 1.41421 : 1;
          const tentative = this.gScore[current] + step * this.cost[nid];
          if (this.openStamp[nid] === stamp && tentative >= this.gScore[nid]) continue;
          this.gScore[nid] = tentative;
          this.fScore[nid] = tentative + this.heuristic(nid, goal);
          this.cameFrom[nid] = current;
          if (this.openStamp[nid] !== stamp) {
            this.openStamp[nid] = stamp;
            open.push(nid);
          } else {
            // already in open list, f value updated above
          }
        }
      }
    }

    if (!found) return [];
    const path: { x: number; z: number }[] = [];
    let node = goal;
    let guard = 0;
    while (node !== -1 && guard++ < 4000) {
      path.push(this.cellCenter(node));
      node = this.cameFrom[node];
    }
    path.reverse();
    path.push({ x: tx, z: tz });
    return this.smooth(path);
  }

  private heuristic(a: number, b: number): number {
    const ai = a % this.res;
    const aj = (a / this.res) | 0;
    const bi = b % this.res;
    const bj = (b / this.res) | 0;
    const dx = Math.abs(ai - bi);
    const dz = Math.abs(aj - bj);
    return (dx + dz) + (1.41421 - 2) * Math.min(dx, dz);
  }

  /** String-pulling: drop waypoints that are directly reachable. */
  private smooth(path: { x: number; z: number }[]): { x: number; z: number }[] {
    if (path.length <= 2) return path;
    const out: { x: number; z: number }[] = [path[0]];
    let anchor = 0;
    for (let i = 2; i < path.length; i++) {
      if (!this.lineClear(path[anchor], path[i])) {
        out.push(path[i - 1]);
        anchor = i - 1;
      }
    }
    out.push(path[path.length - 1]);
    out.shift();
    return out;
  }

  /** Grid raycast between two world points, ignoring structure penalty. */
  lineClear(a: { x: number; z: number }, b: { x: number; z: number }): boolean {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    const steps = Math.ceil(dist / (this.cell * 0.5));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      if (!this.walkable[this.cellIndex(x, z)]) return false;
    }
    return true;
  }

  /** Random walkable point within a radius (used for patrol/idle roaming). */
  randomPointNear(x: number, z: number, radius: number, rand: () => number, attempts = 20): { x: number; z: number } {
    for (let i = 0; i < attempts; i++) {
      const ang = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * radius;
      const px = x + Math.cos(ang) * r;
      const pz = z + Math.sin(ang) * r;
      if (this.isWalkable(px, pz)) return { x: px, z: pz };
    }
    return { x, z };
  }
}
