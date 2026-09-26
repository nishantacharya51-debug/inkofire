import * as THREE from 'three';
import { rayAABB, rayCapsule, resolveCapsuleAABB, type AABB } from '../utils/mathx';

/**
 * Broadphase + narrowphase collision for the static world.
 *
 * Static geometry is a uniform-grid spatial hash of AABBs plus vertical
 * cylinders (trees, silos, poles). Terrain is queried analytically from the
 * heightfield, so no mesh collision is needed.
 */

export interface RayHit {
  dist: number;
  nx: number;
  ny: number;
  nz: number;
  kind: 'world' | 'cylinder' | 'water';
  index: number;
}

const CELL = 8;

/** Material classes drive impact VFX/SFX selection. */
export const MATERIALS = ['concrete', 'metal', 'wood', 'dirt', 'glass', 'foliage', 'fabric', 'rock'] as const;
export type MaterialName = (typeof MATERIALS)[number];

export class CollisionWorld {
  private boxes: AABB[] = [];
  private kinds: Uint8Array = new Uint8Array(0);
  private cellMap = new Map<number, number[]>();
  private materials: Uint8Array = new Uint8Array(0);
  private cylinders: { x: number; z: number; r: number; y0: number; y1: number; material: number }[] = [];
  private cylinderCells = new Map<number, number[]>();
  private gridDim = 1;
  private half = 0;
  private scratch: number[] = [];
  private scratchSeen: Int32Array = new Int32Array(0);
  private stamp = 0;
  private cylScratch: number[] = [];
  private cylSeen: Int32Array = new Int32Array(0);
  private cylStamp = 0;
  /** Reusable vectors — raycasts run thousands of times per second. */
  private vMin = new THREE.Vector3();
  private vMax = new THREE.Vector3();

  constructor(worldSize: number) {
    this.half = worldSize / 2;
    this.gridDim = Math.ceil(worldSize / CELL) + 2;
    this.scratchSeen = new Int32Array(65536);
    this.cylSeen = new Int32Array(65536);
  }

  get boxCount(): number {
    return this.boxes.length;
  }

  get cylinderCount(): number {
    return this.cylinders.length;
  }

  private cellKey(ix: number, iz: number): number {
    return ix * this.gridDim + iz;
  }

  private cellOf(v: number): number {
    return Math.floor((v + this.half) / CELL) + 1;
  }

  addBox(box: AABB, kind: 0 | 1 | 2 = 0, material = 0): number {
    const index = this.boxes.length;
    this.boxes.push(box);
    if (this.kinds.length <= index) {
      const next = new Uint8Array(Math.max(index + 1, this.kinds.length * 2, 64));
      next.set(this.kinds);
      this.kinds = next;
      const nextMat = new Uint8Array(next.length);
      nextMat.set(this.materials);
      this.materials = nextMat;
    }
    this.kinds[index] = kind;
    this.materials[index] = material;
    const ix0 = this.cellOf(box.minX);
    const ix1 = this.cellOf(box.maxX);
    const iz0 = this.cellOf(box.minZ);
    const iz1 = this.cellOf(box.maxZ);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const key = this.cellKey(ix, iz);
        let arr = this.cellMap.get(key);
        if (!arr) {
          arr = [];
          this.cellMap.set(key, arr);
        }
        arr.push(index);
      }
    }
    return index;
  }

  addCylinder(x: number, z: number, r: number, y0: number, y1: number, material = 2): void {
    const index = this.cylinders.length;
    this.cylinders.push({ x, z, r, y0, y1, material });
    const ix0 = this.cellOf(x - r);
    const ix1 = this.cellOf(x + r);
    const iz0 = this.cellOf(z - r);
    const iz1 = this.cellOf(z + r);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const key = this.cellKey(ix, iz);
        let arr = this.cylinderCells.get(key);
        if (!arr) {
          arr = [];
          this.cylinderCells.set(key, arr);
        }
        arr.push(index);
      }
    }
  }

  /** Indices of boxes potentially overlapping the given AABB. */
  queryBoxes(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, out: number[]): number[] {
    out.length = 0;
    const ix0 = this.cellOf(minX);
    const ix1 = this.cellOf(maxX);
    const iz0 = this.cellOf(minZ);
    const iz1 = this.cellOf(maxZ);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const arr = this.cellMap.get(this.cellKey(ix, iz));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const idx = arr[i];
          if (this.scratchSeen[idx] === this.stamp) continue;
          this.scratchSeen[idx] = this.stamp + 1;
          out.push(idx);
        }
      }
    }
    this.stamp += 2;
    if (this.stamp > 60000) {
      this.scratchSeen.fill(0);
      this.stamp = 0;
    }
    void minY;
    void maxY;
    return out;
  }

  getBox(index: number): AABB {
    return this.boxes[index];
  }

  /** Material name for impact effects. */
  materialOf(index: number): MaterialName {
    if (index < -1) {
      const ci = -2 - index;
      const c = this.cylinders[ci];
      return c ? MATERIALS[c.material] ?? 'metal' : 'metal';
    }
    if (index < 0) return 'dirt';
    return MATERIALS[this.materials[index]] ?? 'concrete';
  }

  /**
   * Push a vertical capsule (player/bot body) out of static geometry.
   * Returns true when a correction occurred. Also fills `normalOut`.
   */
  resolveCapsule(pos: THREE.Vector3, radius: number, height: number, normalOut: THREE.Vector3, canStepUp = true, stepHeight = 0.62): boolean {
    const candidates = this.queryBoxes(
      pos.x - radius - 0.2, pos.y - 0.2, pos.z - radius - 0.2,
      pos.x + radius + 0.2, pos.y + height + 0.2, pos.z + radius + 0.2,
      this.scratch
    );
    let corrected = false;
    for (let i = 0; i < candidates.length; i++) {
      const box = this.boxes[candidates[i]];
      if (box.maxY <= pos.y + 0.05) continue;
      if (box.minY >= pos.y + height) continue;
      if (this.kinds[candidates[i]] === 2) continue; // bullets-only (foliage)
      // Step-up assist: low ledges are climbed instead of blocking movement.
      if (canStepUp && box.maxY - pos.y <= stepHeight && box.maxY > pos.y + 0.02) {
        const cx = Math.min(Math.max(pos.x, box.minX), box.maxX);
        const cz = Math.min(Math.max(pos.z, box.minZ), box.maxZ);
        const dx = pos.x - cx;
        const dz = pos.z - cz;
        if (dx * dx + dz * dz < radius * radius) {
          pos.y = box.maxY + 0.001;
          corrected = true;
          continue;
        }
      }
      if (resolveCapsuleAABB(pos, radius, height, box, normalOut)) corrected = true;
    }
    // Cylinders (trees, poles, silos)
    const cCands = this.queryCylinders(pos.x - radius - 0.2, pos.z - radius - 0.2, pos.x + radius + 0.2, pos.z + radius + 0.2);
    for (let i = 0; i < cCands.length; i++) {
      const c = this.cylinders[cCands[i]];
      if (c.y1 < pos.y + 0.05 || c.y0 > pos.y + height) continue;
      const dx = pos.x - c.x;
      const dz = pos.z - c.z;
      const rr = c.r + radius;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-9) {
        const d = Math.sqrt(d2);
        const push = rr - d;
        pos.x += (dx / d) * push;
        pos.z += (dz / d) * push;
        normalOut.set(dx / d, 0, dz / d);
        corrected = true;
      }
    }
    return corrected;
  }

  private queryCylinders(minX: number, minZ: number, maxX: number, maxZ: number): number[] {
    const out = this.cylScratch;
    out.length = 0;
    const ix0 = this.cellOf(minX);
    const ix1 = this.cellOf(maxX);
    const iz0 = this.cellOf(minZ);
    const iz1 = this.cellOf(maxZ);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const arr = this.cylinderCells.get(this.cellKey(ix, iz));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const idx = arr[k];
          if (this.cylSeen[idx] === this.cylStamp + 1) continue;
          this.cylSeen[idx] = this.cylStamp + 1;
          out.push(idx);
        }
      }
    }
    this.cylStamp += 2;
    if (this.cylStamp > 60000) {
      this.cylSeen.fill(0);
      this.cylStamp = 0;
    }
    return out;
  }

  /** Nearest hit of a ray against static geometry. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number, hitOut?: RayHit): RayHit | null {
    let bestT = maxDist;
    let bestNormal = 0;
    let bestIndex = -1;
    let bestKind: RayHit['kind'] = 'world';

    // Grid DDA over the 2D footprint
    const ix0 = this.cellOf(ox);
    const iz0 = this.cellOf(oz);
    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const invDx = Math.abs(dx) < 1e-9 ? Infinity : 1 / Math.abs(dx);
    const invDz = Math.abs(dz) < 1e-9 ? Infinity : 1 / Math.abs(dz);
    const nextBoundX = (ix0 - 1) * CELL - this.half + (dx > 0 ? CELL : 0);
    const nextBoundZ = (iz0 - 1) * CELL - this.half + (dz > 0 ? CELL : 0);
    let tMaxX = Math.abs(dx) < 1e-9 ? Infinity : Math.abs((nextBoundX - ox) * invDx);
    let tMaxZ = Math.abs(dz) < 1e-9 ? Infinity : Math.abs((nextBoundZ - oz) * invDz);
    const tDeltaX = Math.abs(dx) < 1e-9 ? Infinity : CELL * invDx;
    const tDeltaZ = Math.abs(dz) < 1e-9 ? Infinity : CELL * invDz;
    let ix = ix0;
    let iz = iz0;
    let travelled = 0;
    let iterations = 0;

    while (travelled <= maxDist && iterations++ < 256) {
      const key = this.cellKey(ix, iz);
      const arr = this.cellMap.get(key);
      if (arr) {
        for (let i = 0; i < arr.length; i++) {
          const idx = arr[i];
          if (idx === bestIndex) continue;
          const box = this.boxes[idx];
          this.vMin.set(box.minX, box.minY, box.minZ);
          this.vMax.set(box.maxX, box.maxY, box.maxZ);
          const t = rayAABB(ox, oy, oz, dx, dy, dz, this.vMin, this.vMax, bestT);
          if (t >= 0 && t < bestT) {
            bestT = t;
            bestIndex = idx;
            bestKind = 'world';
            const px = ox + dx * t;
            const py = oy + dy * t;
            const pz = oz + dz * t;
            // Determine dominant face normal
            const ex = Math.min(Math.abs(px - box.minX), Math.abs(px - box.maxX));
            const ey = Math.min(Math.abs(py - box.minY), Math.abs(py - box.maxY));
            const ez = Math.min(Math.abs(pz - box.minZ), Math.abs(pz - box.maxZ));
            if (ex <= ey && ex <= ez) bestNormal = px - box.minX < box.maxX - px ? 0 : 1;
            else if (ey <= ez) bestNormal = py - box.minY < box.maxY - py ? 2 : 3;
            else bestNormal = pz - box.minZ < box.maxZ - pz ? 4 : 5;
          }
        }
      }
      const carr = this.cylinderCells.get(key);
      if (carr) {
        for (let i = 0; i < carr.length; i++) {
          const idx = carr[i];
          const c = this.cylinders[idx];
          const t = rayCapsule(ox, oy, oz, dx, dy, dz, c.x, c.y0, c.z, c.x, c.y1, c.z, c.r);
          if (t >= 0 && t < bestT) {
            bestT = t;
            bestIndex = -2 - idx;
            bestKind = 'cylinder';
            bestNormal = 6;
          }
        }
      }
      if (tMaxX < tMaxZ) {
        travelled = tMaxX;
        tMaxX += tDeltaX;
        ix += stepX;
      } else {
        travelled = tMaxZ;
        tMaxZ += tDeltaZ;
        iz += stepZ;
      }
      if (travelled > bestT) break;
      if (ix < -1 || iz < -1 || ix > this.gridDim || iz > this.gridDim) break;
    }

    if (bestIndex === -1) return null;
    const nx = bestNormal === 0 ? -1 : bestNormal === 1 ? 1 : 0;
    const ny = bestNormal === 2 ? -1 : bestNormal === 3 ? 1 : 0;
    const nz = bestNormal === 4 ? -1 : bestNormal === 5 ? 1 : 0;
    const hit: RayHit = {
      dist: bestT,
      nx: bestKind === 'cylinder' ? 0 : nx,
      ny: bestKind === 'cylinder' ? 0 : ny,
      nz: bestKind === 'cylinder' ? 0 : nz,
      kind: bestKind,
      index: bestIndex
    };
    if (hitOut) {
      hitOut.dist = hit.dist;
      hitOut.nx = hit.nx;
      hitOut.ny = hit.ny;
      hitOut.nz = hit.nz;
      hitOut.kind = hit.kind;
      hitOut.index = hit.index;
      return hitOut;
    }
    return hit;
  }

  /** Vertical clearance test used by the unstick logic (no terrain knowledge). */
  isWalkableTerrain(x: number, z: number): boolean {
    return Math.abs(x) < this.half - 2 && Math.abs(z) < this.half - 2;
  }

  /** True when nothing blocks the straight line between two points. */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number, ignoreWater = true): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.01) return true;
    const inv = 1 / dist;
    const hit = this.raycast(ax, ay, az, dx * inv, dy * inv, dz * inv, dist - 0.25);
    if (!hit) return true;
    if (ignoreWater && hit.kind === 'water') return true;
    return false;
  }

  dispose(): void {
    this.boxes.length = 0;
    this.cylinders.length = 0;
    this.materials = new Uint8Array(0);
    this.cellMap.clear();
    this.cylinderCells.clear();
  }
}

/** Cheap uniform-grid broadphase for dynamic actors. */
export class ActorGrid<T extends { position: THREE.Vector3 }> {
  private cells = new Map<number, T[]>();
  private cellSize: number;
  private dim: number;
  private half: number;

  constructor(worldSize: number, cellSize = 24) {
    this.cellSize = cellSize;
    this.half = worldSize / 2;
    this.dim = Math.ceil(worldSize / cellSize) + 2;
  }

  clear(): void {
    for (const arr of this.cells.values()) arr.length = 0;
  }

  private key(x: number, z: number): number {
    const ix = Math.floor((x + this.half) / this.cellSize) + 1;
    const iz = Math.floor((z + this.half) / this.cellSize) + 1;
    return ix * this.dim + iz;
  }

  insert(item: T): void {
    const k = this.key(item.position.x, item.position.z);
    let arr = this.cells.get(k);
    if (!arr) {
      arr = [];
      this.cells.set(k, arr);
    }
    arr.push(item);
  }

  query(x: number, z: number, radius: number, out: T[]): T[] {
    out.length = 0;
    const r = Math.ceil(radius / this.cellSize);
    const cx = Math.floor((x + this.half) / this.cellSize) + 1;
    const cz = Math.floor((z + this.half) / this.cellSize) + 1;
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const arr = this.cells.get(ix * this.dim + iz);
        if (!arr) continue;
        for (const item of arr) out.push(item);
      }
    }
    return out;
  }
}
