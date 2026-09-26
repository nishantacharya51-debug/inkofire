import { rayCapsule, raySphere } from '../utils/mathx';
import type { Actor } from '../entity/Actor';
import type { CollisionWorld, RayHit } from '../world/Collision';
import { falloffMultiplier } from '../entity/Actor';
import { bus } from '../core/EventBus';
import { THROWABLES } from '../items/Items';

/**
 * Projectile simulation.
 *
 * Bullets travel (not hitscan) so travel time, lead and drop are real, and each
 * projectile is swept in short segments so fast rounds cannot tunnel through
 * thin walls. Tracers are pooled and reused.
 */

export interface Projectile {
  active: boolean;
  x: number; y: number; z: number;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  damage: number;
  speed: number;
  travelled: number;
  maxRange: number;
  falloffStart: number;
  falloffEnd: number;
  falloffMin: number;
  weaponId: string;
  ownerId: number;
  team: number;
  isLocal: boolean;
  gravity: number;
  tracer: boolean;
  kind: 'BULLET' | 'PELLET' | 'MELEE';
  life: number;
}

export interface Grenade {
  active: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  fuse: number;
  itemId: string;
  ownerId: number;
  team: number;
  isLocal: boolean;
  bounces: number;
  resting: boolean;
}

export interface ExplosionEvent {
  x: number; y: number; z: number;
  radius: number;
  kind: 'EXPLOSIVE' | 'FLASH';
  shooterIsLocal: boolean;
}

interface BallisticsHooks {
  onImpact(x: number, y: number, z: number, nx: number, ny: number, nz: number, surface: string, isLocal: boolean): void;
  onActorHit(actor: Actor, damage: number, part: string, weaponId: string, isLocal: boolean, killed: boolean, headshot: boolean): void;
  onExplosion(ev: ExplosionEvent): void;
  onTracer(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, isLocal: boolean): void;
}

const MAX_PROJECTILES = 320;
const MAX_GRENADES = 40;
const SEGMENT = 3.5;
const GRAVITY_BULLET = 3.2;

export class Ballistics {
  projectiles: Projectile[] = [];
  grenades: Grenade[] = [];
  freeProjectiles: number[] = [];
  freeGrenades: number[] = [];
  activeCount = 0;

  private hitScratch: RayHit = { dist: 0, nx: 0, ny: 0, nz: 0, kind: 'world', index: -1 };

  constructor(private hooks: BallisticsHooks) {
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      this.projectiles.push(this.makeProjectile());
      this.freeProjectiles.push(i);
    }
    for (let i = 0; i < MAX_GRENADES; i++) {
      this.grenades.push(this.makeGrenade());
      this.freeGrenades.push(i);
    }
  }

  private makeProjectile(): Projectile {
    return {
      active: false, x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0,
      vx: 0, vy: 0, vz: 0, damage: 0, speed: 0, travelled: 0, maxRange: 300,
      falloffStart: 50, falloffEnd: 150, falloffMin: 0.6, weaponId: '', ownerId: -1,
      team: -1, isLocal: false, gravity: GRAVITY_BULLET, tracer: true, kind: 'BULLET', life: 4
    };
  }

  private makeGrenade(): Grenade {
    return {
      active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, fuse: 3, itemId: 'frag',
      ownerId: -1, team: -1, isLocal: false, bounces: 0, resting: false
    };
  }

  spawn(shot: {
    originX: number; originY: number; originZ: number;
    dirX: number; dirY: number; dirZ: number;
    damage: number; speed: number; weaponId: string;
    range: number; falloffStart: number; falloffEnd: number; falloffMin: number;
    ownerId: number; team: number; isLocal: boolean;
    pellets?: number; kind?: Projectile['kind'];
  }): void {
    if (this.freeProjectiles.length === 0) return;
    const idx = this.freeProjectiles.pop() as number;
    const p = this.projectiles[idx];
    p.active = true;
    p.x = p.px = shot.originX;
    p.y = p.py = shot.originY;
    p.z = p.pz = shot.originZ;
    p.vx = shot.dirX * shot.speed;
    p.vy = shot.dirY * shot.speed;
    p.vz = shot.dirZ * shot.speed;
    p.damage = shot.damage;
    p.speed = shot.speed;
    p.travelled = 0;
    p.maxRange = shot.range;
    p.falloffStart = shot.falloffStart;
    p.falloffEnd = shot.falloffEnd;
    p.falloffMin = shot.falloffMin;
    p.weaponId = shot.weaponId;
    p.ownerId = shot.ownerId;
    p.team = shot.team;
    p.isLocal = shot.isLocal;
    p.gravity = shot.kind === 'MELEE' ? 0 : GRAVITY_BULLET;
    p.tracer = shot.speed > 380 && (shot.kind ?? 'BULLET') !== 'MELEE';
    p.kind = shot.kind ?? 'BULLET';
    p.life = shot.range / Math.max(1, shot.speed) + 0.2;
    this.activeCount++;
  }

  throwGrenade(
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    itemId: string, ownerId: number, team: number, isLocal: boolean, power = 22
  ): void {
    if (this.freeGrenades.length === 0) return;
    const def = THROWABLES[itemId];
    const idx = this.freeGrenades.pop() as number;
    const g = this.grenades[idx];
    g.active = true;
    g.x = x; g.y = y; g.z = z;
    const speed = power * (def ? 1 : 1);
    g.vx = dx * speed;
    g.vy = dy * speed + 2.6;
    g.vz = dz * speed;
    g.fuse = def ? def.fuse : 3;
    g.itemId = itemId;
    g.ownerId = ownerId;
    g.team = team;
    g.isLocal = isLocal;
    g.bounces = 0;
    g.resting = false;
  }

  /**
   * Steps all projectiles. Collision uses swept segments so a 1.1 km/s round
   * cannot skip a 0.3 m wall at 60 Hz.
   */
  update(dt: number, world: CollisionWorld, actors: Actor[], now: number, terrainHeight: (x: number, z: number) => number): void {
    for (let i = 0; i < this.projectiles.length; i++) {
      const p = this.projectiles[i];
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        this.retire(p, i);
        continue;
      }
      const step = p.speed * dt;
      const segments = Math.max(1, Math.ceil(step / SEGMENT));
      const sub = dt / segments;
      let done = false;

      for (let s = 0; s < segments && !done; s++) {
        p.px = p.x; p.py = p.y; p.pz = p.z;

        // Gravity drop
        p.vy -= p.gravity * sub;
        p.x += p.vx * sub;
        p.y += p.vy * sub;
        p.z += p.vz * sub;

        const dx = p.x - p.px;
        const dy = p.y - p.py;
        const dz = p.z - p.pz;
        const segLen = Math.hypot(dx, dy, dz);
        if (segLen < 1e-6) continue;
        const ndx = dx / segLen;
        const ndy = dy / segLen;
        const ndz = dz / segLen;

        // Actors first (so a body in front of a wall registers)
        let bestActor: Actor | null = null;
        let bestDist = segLen;
        let bestPart = 'TORSO';
        for (let a = 0; a < actors.length; a++) {
          const target = actors[a];
          if (!target.active) continue;
          if (target.id === p.ownerId) continue;
          if (target.team === p.team && p.team >= 0) continue;
          const d2 = (target.position.x - p.px) ** 2 + (target.position.z - p.pz) ** 2;
          if (d2 > (segLen + 2.5) ** 2) continue;
          const hit = target.raycastHitboxes(p.px, p.py, p.pz, ndx, ndy, ndz, bestDist, rayCapsule, raySphere);
          if (hit && hit.dist < bestDist) {
            bestDist = hit.dist;
            bestActor = target;
            bestPart = hit.part;
          }
        }

        // World
        const hit = world.raycast(p.px, p.py, p.pz, ndx, ndy, ndz, bestActor ? bestDist : segLen, this.hitScratch);

        if (bestActor && (!hit || bestDist <= hit.dist)) {
          this.registerActorHit(p, bestActor, bestPart, now);
          done = true;
          break;
        }

        if (hit) {
          const hx = p.px + ndx * hit.dist;
          const hy = p.py + ndy * hit.dist;
          const hz = p.pz + ndz * hit.dist;
          this.hooks.onImpact(hx, hy, hz, hit.nx, hit.ny, hit.nz, surfaceFromIndex(world, hit.index), p.isLocal);
          if (p.tracer) this.hooks.onTracer(p.px, p.py, p.pz, hx, hy, hz, p.isLocal);
          bus.emit('bullet:impact', { x: hx, y: hy, z: hz, surface: 'world', isLocal: p.isLocal });
          done = true;
          break;
        }

        // Terrain
        const groundY = terrainHeight(p.x, p.z);
        if (p.y <= groundY) {
          const hx = p.x;
          const hy = groundY;
          const hz = p.z;
          this.hooks.onImpact(hx, hy, hz, 0, 1, 0, 'dirt', p.isLocal);
          if (p.tracer) this.hooks.onTracer(p.px, p.py, p.pz, hx, hy, hz, p.isLocal);
          bus.emit('bullet:impact', { x: hx, y: hy, z: hz, surface: 'dirt', isLocal: p.isLocal });
          done = true;
          break;
        }

        p.travelled += segLen;
        if (p.travelled > p.maxRange) {
          done = true;
          break;
        }
      }

      if (done) this.retire(p, i);
    }

    this.updateGrenades(dt, world, actors, now, terrainHeight);
  }

  private registerActorHit(p: Projectile, target: Actor, part: string, now: number): void {
    const dist = p.travelled;
    const falloff = dist <= p.falloffStart ? 1
      : dist >= p.falloffEnd ? p.falloffMin
        : 1 + (p.falloffMin - 1) * ((dist - p.falloffStart) / (p.falloffEnd - p.falloffStart));
    const damage = p.damage * falloff;
    const attacker = findActorById(this.lastActors, p.ownerId);
    const result = target.applyDamage(damage, part as 'HEAD' | 'TORSO' | 'ARM' | 'LEG', attacker, p.weaponId, now);
    if (attacker) attacker.shotsHit++;
    this.hooks.onActorHit(target, result.damage, part, p.weaponId, p.isLocal, result.killed, result.headshot);
    if (p.tracer) this.hooks.onTracer(p.px, p.py, p.pz, p.x, p.y, p.z, p.isLocal);
  }

  private lastActors: Actor[] = [];

  private updateGrenades(dt: number, world: CollisionWorld, actors: Actor[], now: number, terrainHeight: (x: number, z: number) => number): void {
    for (let i = 0; i < this.grenades.length; i++) {
      const g = this.grenades[i];
      if (!g.active) continue;
      g.fuse -= dt;
      if (!g.resting) {
        g.vy -= 22 * dt;
        const nx = g.x + g.vx * dt;
        const ny = g.y + g.vy * dt;
        const nz = g.z + g.vz * dt;

        const dirx = nx - g.x;
        const diry = ny - g.y;
        const dirz = nz - g.z;
        const len = Math.hypot(dirx, diry, dirz) || 1;
        const hit = world.raycast(g.x, g.y, g.z, dirx / len, diry / len, dirz / len, len + 0.12, this.hitScratch);
        const groundY = terrainHeight(nx, nz);

        if (ny <= groundY + 0.1) {
          g.x = nx; g.z = nz; g.y = groundY + 0.1;
          g.vy = Math.abs(g.vy) * 0.32;
          g.vx *= 0.62; g.vz *= 0.62;
          g.bounces++;
        } else if (hit) {
          g.x += (dirx / len) * Math.max(0, hit.dist - 0.12);
          g.y += (diry / len) * Math.max(0, hit.dist - 0.12);
          g.z += (dirz / len) * Math.max(0, hit.dist - 0.12);
          const dot = g.vx * hit.nx + g.vy * hit.ny + g.vz * hit.nz;
          g.vx -= 2 * dot * hit.nx;
          g.vy -= 2 * dot * hit.ny;
          g.vz -= 2 * dot * hit.nz;
          g.vx *= 0.42; g.vy *= 0.42; g.vz *= 0.42;
          g.bounces++;
        } else {
          g.x = nx; g.y = ny; g.z = nz;
        }
        const speed = Math.hypot(g.vx, g.vy, g.vz);
        if (g.bounces > 6 && speed < 1.2) g.resting = true;
      }

      if (g.fuse <= 0) {
        this.detonate(g, actors, now);
        this.retireGrenade(g, i);
      }
    }
  }

  private detonate(g: Grenade, actors: Actor[], now: number): void {
    const def = THROWABLES[g.itemId];
    if (!def) return;
    if (def.effect === 'SMOKE') {
      this.hooks.onExplosion({ x: g.x, y: g.y, z: g.z, radius: def.radius, kind: 'EXPLOSIVE', shooterIsLocal: g.isLocal });
      // Smoke is handled by the effects layer via the explosion event with radius.
      this.smokeEvents.push({ x: g.x, y: g.y, z: g.z, radius: def.radius, duration: def.duration });
      return;
    }
    if (def.effect === 'FLASH') {
      this.flashEvents.push({ x: g.x, y: g.y, z: g.z, radius: def.radius, duration: def.duration });
      this.hooks.onExplosion({ x: g.x, y: g.y, z: g.z, radius: def.radius, kind: 'FLASH', shooterIsLocal: g.isLocal });
      return;
    }
    // Explosive: radial damage with line-of-sight occlusion.
    const attacker = findActorById(this.lastActors, g.ownerId);
    for (const actor of actors) {
      if (!actor.active) continue;
      if (actor.team === g.team && g.team >= 0) continue;
      const d = actor.distanceTo(g.x, g.y, g.z);
      if (d > def.radius) continue;
      const t = 1 - d / def.radius;
      const damage = def.damage * t * t;
      if (damage < 3) continue;
      const blocked = !world_los(this.losWorld, g.x, g.y + 0.3, g.z, actor.position.x, actor.position.y + actor.bodyHeight * 0.5, actor.position.z);
      if (blocked) continue;
      const result = actor.applyDamage(damage, 'TORSO', attacker, 'frag', now);
      void result;
    }
    this.hooks.onExplosion({ x: g.x, y: g.y, z: g.z, radius: def.radius, kind: 'EXPLOSIVE', shooterIsLocal: g.isLocal });
  }

  smokeEvents: { x: number; y: number; z: number; radius: number; duration: number }[] = [];
  flashEvents: { x: number; y: number; z: number; radius: number; duration: number }[] = [];
  losWorld: CollisionWorld | null = null;

  private retire(p: Projectile, index: number): void {
    if (!p.active) return;
    p.active = false;
    this.freeProjectiles.push(index);
    this.activeCount--;
  }

  private retireGrenade(g: Grenade, index: number): void {
    if (!g.active) return;
    g.active = false;
    this.freeGrenades.push(index);
  }

  /** Called once per frame so bullets can credit their shooter. */
  setActors(actors: Actor[], world: CollisionWorld): void {
    this.lastActors = actors;
    this.losWorld = world;
  }

  clear(): void {
    for (let i = 0; i < this.projectiles.length; i++) {
      this.projectiles[i].active = false;
      this.freeProjectiles.push(i);
    }
    for (let i = 0; i < this.grenades.length; i++) {
      this.grenades[i].active = false;
      this.freeGrenades.push(i);
    }
    this.activeCount = 0;
    this.smokeEvents.length = 0;
    this.flashEvents.length = 0;
  }
}

function world_los(world: CollisionWorld | null, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  if (!world) return true;
  return world.lineOfSight(ax, ay, az, bx, by, bz);
}

function findActorById(actors: Actor[], id: number): Actor | null {
  for (const a of actors) if (a.id === id) return a;
  return null;
}

function surfaceFromIndex(world: CollisionWorld, index: number): string {
  return world.materialOf(index);
}

export { falloffMultiplier };
