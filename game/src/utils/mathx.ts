import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return b === a ? 0 : (v - a) / (b - a);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential smoothing. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Wrap angle into [-PI, PI]. */
export function wrapAngle(a: number): number {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return wrapAngle(current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt)));
}

/** Shortest-path angular move with maximum turn rate (rad/s). */
export function rotateTowards(current: number, target: number, maxDelta: number): number {
  const d = angleDelta(current, target);
  if (Math.abs(d) <= maxDelta) return wrapAngle(target);
  return wrapAngle(current + Math.sign(d) * maxDelta);
}

export function randRange(rng: () => number, a: number, b: number): number {
  return a + rng() * (b - a);
}

export function dist2D(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

export function distSq2D(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/* ------------------------------------------------------------------ */
/* Ray casting primitives (used by the headless simulation as well)    */
/* ------------------------------------------------------------------ */

/** Distance along ray to plane-ish AABB; returns -1 when no hit. */
export function rayAABB(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  min: THREE.Vector3, max: THREE.Vector3,
  maxDist: number
): number {
  let tmin = 0;
  let tmax = maxDist;
  for (let i = 0; i < 3; i++) {
    const o = i === 0 ? ox : i === 1 ? oy : oz;
    const d = i === 0 ? dx : i === 1 ? dy : dz;
    const lo = i === 0 ? min.x : i === 1 ? min.y : min.z;
    const hi = i === 0 ? max.x : i === 1 ? max.y : max.z;
    if (Math.abs(d) < 1e-8) {
      if (o < lo || o > hi) return -1;
    } else {
      const inv = 1 / d;
      let t1 = (lo - o) * inv;
      let t2 = (hi - o) * inv;
      if (t1 > t2) {
        const t = t1;
        t1 = t2;
        t2 = t;
      }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

export function raySphere(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number,
  radius: number
): number {
  const mx = ox - cx;
  const my = oy - cy;
  const mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - radius * radius;
  if (c > 0 && b > 0) return -1;
  const discr = b * b - c;
  if (discr < 0) return -1;
  const t = -b - Math.sqrt(discr);
  return t < 0 ? 0 : t;
}

/** Ray vs capsule (segment a→b, radius). Returns distance or -1. */
export function rayCapsule(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  radius: number
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const aox = ox - ax;
  const aoy = oy - ay;
  const aoz = oz - az;
  const abLenSq = abx * abx + aby * aby + abz * abz;

  let best = Number.POSITIVE_INFINITY;

  // Cylinder body: solve (m + t d) perpendicular component.
  const dDotAb = dx * abx + dy * aby + dz * abz;
  const aoDotAb = aox * abx + aoy * aby + aoz * abz;
  const ab2 = abLenSq || 1e-6;

  const mx = aox - (abx * aoDotAb) / ab2;
  const my = aoy - (aby * aoDotAb) / ab2;
  const mz = aoz - (abz * aoDotAb) / ab2;
  const nx = dx - (abx * dDotAb) / ab2;
  const ny = dy - (aby * dDotAb) / ab2;
  const nz = dz - (abz * dDotAb) / ab2;

  const A = nx * nx + ny * ny + nz * nz;
  const B = 2 * (mx * nx + my * ny + mz * nz);
  const C = mx * mx + my * my + mz * mz - radius * radius;

  if (A > 1e-9) {
    const discr = B * B - 4 * A * C;
    if (discr >= 0) {
      const sq = Math.sqrt(discr);
      const t1 = (-B - sq) / (2 * A);
      const t2 = (-B + sq) / (2 * A);
      for (const t of [t1, t2]) {
        if (t < 0) continue;
        const px = aox + dx * t;
        const py = aoy + dy * t;
        const pz = aoz + dz * t;
        const proj = (px * abx + py * aby + pz * abz) / ab2;
        if (proj >= 0 && proj <= 1 && t < best) best = t;
      }
    }
  }

  // End caps
  const s1 = raySphere(ox, oy, oz, dx, dy, dz, ax, ay, az, radius);
  if (s1 >= 0 && s1 < best) best = s1;
  const s2 = raySphere(ox, oy, oz, dx, dy, dz, bx, by, bz, radius);
  if (s2 >= 0 && s2 < best) best = s2;

  return best === Number.POSITIVE_INFINITY ? -1 : best;
}

export function closestPointOnSegment(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  out: THREE.Vector3
): THREE.Vector3 {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const denom = abx * abx + aby * aby + abz * abz || 1e-6;
  let t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / denom;
  t = clamp(t, 0, 1);
  out.set(ax + abx * t, ay + aby * t, az + abz * t);
  return out;
}

/** Squared distance from point to segment. */
export function distSqPointSegment(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const denom = abx * abx + aby * aby + abz * abz || 1e-6;
  let t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / denom;
  t = clamp(t, 0, 1);
  const cx = ax + abx * t - px;
  const cy = ay + aby * t - py;
  const cz = az + abz * t - pz;
  return cx * cx + cy * cy + cz * cz;
}

export interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export function aabbOverlap(a: AABB, b: AABB): boolean {
  return (
    a.minX <= b.maxX && a.maxX >= b.minX &&
    a.minY <= b.maxY && a.maxY >= b.minY &&
    a.minZ <= b.maxZ && a.maxZ >= b.minZ
  );
}

export function aabbContains(a: AABB, x: number, y: number, z: number): boolean {
  return x >= a.minX && x <= a.maxX && y >= a.minY && y <= a.maxY && z >= a.minZ && z <= a.maxZ;
}

/**
 * Push a vertical capsule out of an AABB on the horizontal plane.
 * Returns true when a correction was applied. Used for building collision.
 */
export function resolveCapsuleAABB(
  pos: THREE.Vector3,
  radius: number,
  height: number,
  box: AABB,
  outNormal: THREE.Vector3
): boolean {
  const feetY = pos.y;
  const headY = pos.y + height;
  if (headY < box.minY || feetY > box.maxY) return false;

  const cx = clamp(pos.x, box.minX, box.maxX);
  const cz = clamp(pos.z, box.minZ, box.maxZ);
  const dx = pos.x - cx;
  const dz = pos.z - cz;
  const d2 = dx * dx + dz * dz;

  if (d2 > radius * radius) return false;

  if (d2 > 1e-8) {
    const d = Math.sqrt(d2);
    const push = radius - d;
    pos.x += (dx / d) * push;
    pos.z += (dz / d) * push;
    outNormal.set(dx / d, 0, dz / d);
  } else {
    // Center is inside the box: eject along the smallest penetration axis.
    const toMinX = pos.x - box.minX;
    const toMaxX = box.maxX - pos.x;
    const toMinZ = pos.z - box.minZ;
    const toMaxZ = box.maxZ - pos.z;
    const m = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
    if (m === toMinX) {
      pos.x = box.minX - radius;
      outNormal.set(-1, 0, 0);
    } else if (m === toMaxX) {
      pos.x = box.maxX + radius;
      outNormal.set(1, 0, 0);
    } else if (m === toMinZ) {
      pos.z = box.minZ - radius;
      outNormal.set(0, 0, -1);
    } else {
      pos.z = box.maxZ + radius;
      outNormal.set(0, 0, 1);
    }
  }
  return true;
}

/** Deterministic per-entity jitter (cheap, no allocation). */
export function hash11(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
