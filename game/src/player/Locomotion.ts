import * as THREE from 'three';
import type { Actor, MoveState } from '../entity/Actor';
import type { CollisionWorld } from '../world/Collision';
import { sampleHeight, sampleSlope, sampleNormal, type TerrainData } from '../world/Terrain';
import { clamp } from '../utils/mathx';

/**
 * Character locomotion shared by the local player and AI bots.
 * Identical physics for everyone keeps fights fair and makes the sim
 * deterministic enough to test headlessly.
 */

export interface ControllerInput {
  /** -1..1 strafe (right positive) */
  moveX: number;
  /** -1..1 forward (forward positive) */
  moveY: number;
  /** Desired absolute yaw (radians). */
  lookYaw: number;
  /** Desired absolute pitch (radians, clamped). */
  lookPitch: number;
  jump: boolean;
  crouch: boolean;
  prone: boolean;
  sprint: boolean;
  /** Walk slowly (hold breath / quiet approach) */
  walkSlow: boolean;
  /** Movement locked (healing, reviving, driving) */
  locked?: boolean;
}

export interface LocomotionConfig {
  walkSpeed: number;
  runSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  proneSpeed: number;
  adsSpeedMult: number;
  jumpVelocity: number;
  gravity: number;
  groundAccel: number;
  airAccel: number;
  waterAccel: number;
  swimSpeed: number;
  friction: number;
  slideImpulse: number;
  slideDuration: number;
  turnSpeed: number;
  stepUpHeight: number;
  fallDamageThreshold: number;
  terrain: TerrainData;
  waterLevel: number;
}

export const DEFAULT_LOCOMOTION: Omit<LocomotionConfig, 'terrain' | 'waterLevel'> = {
  walkSpeed: 4.3,
  runSpeed: 5.7,
  sprintSpeed: 7.5,
  crouchSpeed: 2.5,
  proneSpeed: 1.15,
  adsSpeedMult: 0.62,
  jumpVelocity: 6.7,
  gravity: 22,
  groundAccel: 46,
  airAccel: 9,
  waterAccel: 18,
  swimSpeed: 3.0,
  friction: 13,
  slideImpulse: 9.6,
  slideDuration: 0.72,
  turnSpeed: 22,
  stepUpHeight: 0.66,
  fallDamageThreshold: 13.5
};

const tmpVec = new THREE.Vector3();
const tmpNormal = { x: 0, y: 1, z: 0 };

export class Locomotion {
  cfg: LocomotionConfig;

  constructor(private world: CollisionWorld, terrain: TerrainData, waterLevel: number, overrides: Partial<LocomotionConfig> = {}) {
    this.cfg = { ...DEFAULT_LOCOMOTION, terrain, waterLevel, ...overrides };
  }

  private get terrain(): TerrainData {
    return this.cfg.terrain;
  }

  groundHeight(x: number, z: number): number {
    return sampleHeight(this.terrain, x, z);
  }

  waterDepth(x: number, z: number): number {
    return this.cfg.waterLevel - sampleHeight(this.terrain, x, z);
  }

  /**
   * Advances an actor by one fixed step.
   * Returns the resulting move state for the animation layer.
   */
  step(actor: Actor, input: ControllerInput, dt: number): MoveState {
    // Skip normal locomotion while aboard the aircraft, flying or parachuting.
    if (actor.moveState === 'AIRCRAFT' || actor.moveState === 'SKYDIVE' || actor.moveState === 'PARACHUTE') {
      return actor.moveState;
    }
    if (actor.isDowned) {
      actor.velocity.x *= 1 - Math.min(1, dt * 6);
      actor.velocity.z *= 1 - Math.min(1, dt * 6);
      actor.position.x += actor.velocity.x * dt;
      actor.position.z += actor.velocity.z * dt;
      this.snapToGround(actor, dt);
      actor.moveState = 'DOWNED';
      return 'DOWNED';
    }
    if (actor.moveState === 'DEAD') return 'DEAD';

    // Look direction
    actor.yaw = input.lookYaw;
    actor.pitch = clamp(input.lookPitch, -1.45, 1.45);

    // Stance
    const wantProne = input.prone && actor.onGround && actor.speed < 3.5;
    if (wantProne) actor.stance = 'PRONE';
    else if (input.crouch) actor.stance = 'CROUCH';
    else actor.stance = 'STAND';

    const groundY = this.groundHeight(actor.position.x, actor.position.z);
    const depth = this.cfg.waterLevel - groundY;
    const inDeepWater = actor.position.y < this.cfg.waterLevel + 0.2 && depth > 1.5;
    actor.inWater = actor.position.y < this.cfg.waterLevel - 0.05;

    const locked = input.locked ?? false;
    let mx = locked ? 0 : input.moveX;
    let my = locked ? 0 : input.moveY;
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }

    // Movement basis from yaw
    const cosY = Math.cos(actor.yaw);
    const sinY = Math.sin(actor.yaw);
    const fx = -sinY;
    const fz = -cosY;
    const rx = cosY;
    const rz = -sinY;

    // Slide
    if (actor.slideTimer > 0) {
      actor.slideTimer -= dt;
      const t = clamp(actor.slideTimer / this.cfg.slideDuration, 0, 1);
      const speed = this.cfg.slideImpulse * (0.35 + t * 0.65);
      actor.velocity.x = actor.slideDirection.x * speed;
      actor.velocity.z = actor.slideDirection.z * speed;
      actor.stance = 'CROUCH';
    } else if (input.crouch && actor.wasSprinting && actor.onGround && actor.speed > this.cfg.runSpeed * 0.9) {
      actor.slideTimer = this.cfg.slideDuration;
      actor.slideDirection.set(fx * my + rx * mx, 0, fz * my + rz * mx).normalize();
      if (actor.slideDirection.lengthSq() < 0.01) actor.slideDirection.set(fx, 0, fz);
      actor.velocity.x = actor.slideDirection.x * this.cfg.slideImpulse;
      actor.velocity.z = actor.slideDirection.z * this.cfg.slideImpulse;
    } else {
      // Target speed for the current stance / facing
      let speed = this.cfg.runSpeed;
      if (actor.stance === 'PRONE') speed = this.cfg.proneSpeed;
      else if (actor.stance === 'CROUCH') speed = this.cfg.crouchSpeed;
      else if (input.walkSlow) speed = this.cfg.walkSpeed;
      else if (input.sprint && my > 0.1 && actor.stamina > 1) speed = this.cfg.sprintSpeed;

      // Weapon weight
      const stats = actor.activeWeaponStats();
      if (stats) speed *= stats.def.moveMult;
      speed *= 1 - actor.adsProgress * (1 - this.cfg.adsSpeedMult);
      if (actor.speed < 1.2) speed *= 0.94;

      // Terrain slope penalty (uphill is slower)
      if (actor.onGround) {
        sampleNormal(this.terrain, actor.position.x, actor.position.z, tmpNormal);
        const slope = sampleSlope(this.terrain, actor.position.x, actor.position.z);
        // Move slower uphill than down for a natural feel.
        const uphillDot = -(tmpNormal.x * fx * my + tmpNormal.z * fz * my);
        const slopePenalty = Math.min(0.45, slope * 0.34) * (uphillDot > 0 ? 1 : 0.35);
        speed *= 1 - slopePenalty;
      }

      if (inDeepWater) {
        // Swimming: buoyant, limited speed
        actor.velocity.y += (this.cfg.gravity * 0.62) * dt;
        const swimTarget = this.cfg.swimSpeed;
        const desiredX = (fx * my + rx * mx) * swimTarget;
        const desiredZ = (fz * my + rz * mx) * swimTarget;
        actor.velocity.x += (desiredX - actor.velocity.x) * Math.min(1, this.cfg.waterAccel * dt * 0.4);
        actor.velocity.z += (desiredZ - actor.velocity.z) * Math.min(1, this.cfg.waterAccel * dt * 0.4);
        actor.velocity.y *= 1 - Math.min(1, dt * 2.2);
        if (actor.velocity.y > 1.2) actor.velocity.y = 1.2;
        if (actor.velocity.y < -1.4) actor.velocity.y = -1.4;
        // Bob on the surface
        const surfaceY = this.cfg.waterLevel - 1.28;
        if (actor.position.y < surfaceY) actor.velocity.y += (surfaceY - actor.position.y) * 6 * dt;
      } else {
        const desiredX = (fx * my + rx * mx) * speed;
        const desiredZ = (fz * my + rz * mx) * speed;
        const accel = actor.onGround ? this.cfg.groundAccel : this.cfg.airAccel;
        const blend = Math.min(1, accel * dt * 0.2);
        actor.velocity.x += (desiredX - actor.velocity.x) * blend;
        actor.velocity.z += (desiredZ - actor.velocity.z) * blend;
        if (mag < 0.02 && actor.onGround) {
          const f = Math.max(0, 1 - this.cfg.friction * dt * 0.35);
          actor.velocity.x *= f;
          actor.velocity.z *= f;
        }
        actor.velocity.y -= this.cfg.gravity * dt;
      }
    }

    // Jump
    if (input.jump && actor.onGround && actor.jumpCooldown <= 0 && !inDeepWater && actor.slideTimer <= 0) {
      // Vault assist: if a wall of climbing height is directly ahead, boost over it
      const aheadX = actor.position.x + fx * 0.85;
      const aheadZ = actor.position.z + fz * 0.85;
      const wallHeight = this.obstacleHeight(actor, aheadX, aheadZ, actor.bodyHeight);
      if (wallHeight > 0.75 && wallHeight < 1.55 && actor.speed > 1.2) {
        actor.velocity.y = Math.sqrt(2 * this.cfg.gravity * (wallHeight + 0.28));
        actor.vaultTimer = 0.45;
        actor.moveState = 'CLIMB';
      } else {
        actor.velocity.y = this.cfg.jumpVelocity;
      }
      actor.onGround = false;
      actor.jumpCooldown = 0.24;
      actor.stamina = Math.max(0, actor.stamina - 6);
    }
    actor.jumpCooldown = Math.max(0, actor.jumpCooldown - dt);
    actor.vaultTimer = Math.max(0, actor.vaultTimer - dt);

    // Integrate
    actor.position.x += actor.velocity.x * dt;
    actor.position.y += actor.velocity.y * dt;
    actor.position.z += actor.velocity.z * dt;

    const startX = actor.position.x;
    const startZ = actor.position.z;

    // Static world collision (horizontal push-out + step up assist)
    tmpVec.copy(actor.position);
    if (this.world.resolveCapsule(actor.position, actor.bodyRadius, actor.bodyHeight, tmpVec, true, this.cfg.stepUpHeight)) {
      // Kill the velocity component pushing into the surface so the actor
      // slides along walls instead of grinding into them.
      const nx = actor.position.x - tmpVec.x;
      const nz = actor.position.z - tmpVec.z;
      const nl = Math.hypot(nx, nz);
      if (nl > 1e-5) {
        const ux = nx / nl;
        const uz = nz / nl;
        const dot = actor.velocity.x * ux + actor.velocity.z * uz;
        if (dot < 0) {
          actor.velocity.x -= ux * dot;
          actor.velocity.z -= uz * dot;
        }
      }
      if (actor.position.y !== tmpVec.y && actor.velocity.y < 0) actor.velocity.y = 0;
    }

    this.snapToGround(actor, dt);
    this.updateStamina(actor, input, dt);

    const travelled = Math.hypot(actor.position.x - startX, actor.position.z - startZ);
    actor.distanceTravelled += travelled;

    // Wedge recovery: an actor pressed against geometry for over a second while
    // trying to move gets nudged to the nearest free space.
    const wantsMove = mag > 0.15;
    if (wantsMove && travelled < 0.008) {
      actor.stuckTimer += dt;
      if (actor.stuckTimer > 1.2) {
        actor.stuckTimer = 0;
        this.unstick(actor);
      }
    } else {
      actor.stuckTimer = 0;
    }

    return this.resolveMoveState(actor, input, mag, travelled, dt);
  }

  /**
   * Keeps the actor on the surface it is standing on.
   *
   * Support is the highest of the terrain heightfield and any static geometry
   * top directly beneath the feet — this is what makes rooftops, crates and
   * staircases solid floors instead of places where characters float.
   */
  private snapToGround(actor: Actor, _dt: number): void {
    const terrainY = this.groundHeight(actor.position.x, actor.position.z);
    let supportY = terrainY;

    const probeFrom = actor.position.y + 0.55;
    const hit = this.world.raycast(actor.position.x, probeFrom, actor.position.z, 0, -1, 0, 0.55 + 0.45);
    if (hit) {
      const topY = probeFrom - hit.dist;
      if (topY > terrainY - 0.02 && topY <= actor.position.y + 0.45) {
        supportY = Math.max(supportY, topY);
      }
    }

    actor.groundHeight = supportY;
    const feet = actor.position.y;
    const gap = feet - supportY;

    if (gap <= 0.02) {
      // Standing (or slightly embedded): snap up onto the surface.
      const impact = -actor.velocity.y;
      if (!actor.onGround && impact > 4) {
        actor.landingImpact = impact;
        if (impact > this.cfg.fallDamageThreshold) {
          const dmg = (impact - this.cfg.fallDamageThreshold) * 7.5;
          actor.applyDamage(dmg, 'LEG', null, 'fall', 0);
        }
      }
      actor.position.y = supportY;
      actor.onGround = true;
      if (actor.velocity.y < 0) actor.velocity.y = 0;
    } else if (gap <= 0.22 && actor.velocity.y <= 0.05) {
      // Small ledge / step down: stick to the surface instead of floating.
      const stepDown = Math.min(gap, 0.22);
      actor.position.y -= stepDown;
      actor.onGround = true;
      if (actor.velocity.y < 0) actor.velocity.y = 0;
    } else {
      actor.onGround = false;
    }
  }

  /** Moves an actor out of geometry it has become wedged in. */
  private unstick(actor: Actor): void {
    const dirs = 12;
    const probe = new THREE.Vector3();
    const normal = new THREE.Vector3();
    for (const radius of [1.4, 2.6, 4.0]) {
      for (let i = 0; i < dirs; i++) {
        const ang = (i / dirs) * Math.PI * 2 + actor.id;
        const x = actor.position.x + Math.cos(ang) * radius;
        const z = actor.position.z + Math.sin(ang) * radius;
        if (!this.world.isWalkableTerrain(x, z)) continue;
        probe.set(x, this.groundHeight(x, z), z);
        if (!this.world.resolveCapsule(probe, actor.bodyRadius, actor.bodyHeight, normal, false, 0)) {
          actor.position.set(probe.x, probe.y, probe.z);
          actor.velocity.set(0, 0, 0);
          actor.onGround = true;
          return;
        }
      }
    }
    // Worse case: lift the actor a couple of metres and let gravity sort it out.
    actor.position.y += 2.6;
    actor.velocity.set(0, 0, 0);
    actor.onGround = false;
  }

  private updateStamina(actor: Actor, input: ControllerInput, dt: number): void {
    const sprinting = input.sprint && actor.speed > this.cfg.runSpeed * 1.02 && actor.onGround;
    actor.wasSprinting = sprinting;
    if (sprinting) {
      actor.stamina = Math.max(0, actor.stamina - dt * 12);
    } else {
      actor.stamina = Math.min(100, actor.stamina + dt * 16);
    }
  }

  /** Height of the first obstacle at a point, or 0 when clear. */
  private obstacleHeight(actor: Actor, x: number, z: number, maxHeight: number): number {
    const box = { minX: x - 0.3, minY: actor.position.y, minZ: z - 0.3, maxX: x + 0.3, maxY: actor.position.y + maxHeight, maxZ: z + 0.3 };
    const candidates: number[] = [];
    this.world.queryBoxes(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ, candidates);
    let height = 0;
    for (const idx of candidates) {
      const b = this.world.getBox(idx);
      if (b.minY > actor.position.y + maxHeight) continue;
      if (b.maxY > actor.position.y) {
        height = Math.max(height, b.maxY - actor.position.y);
      }
    }
    return height;
  }

  private resolveMoveState(actor: Actor, input: ControllerInput, mag: number, travelled: number, dt: number): MoveState {
    let state: MoveState;
    if (actor.reloadTimer > 0 && actor.onGround && actor.speed < 0.6) {
      state = 'RELOAD';
    } else if (actor.healTimer > 0 && actor.onGround && actor.speed < 0.6) {
      state = 'HEAL';
    } else if (actor.slideTimer > 0) {
      state = 'SLIDE';
    } else if (actor.vaultTimer > 0) {
      state = 'CLIMB';
    } else if (actor.moveState === 'DRIVE') {
      state = 'DRIVE';
    } else if (actor.inWater && this.waterDepth(actor.position.x, actor.position.z) > 1.4) {
      state = 'SWIM';
    } else if (!actor.onGround) {
      state = actor.velocity.y > 0.2 ? 'JUMP' : 'FALL';
    } else if (actor.stance === 'PRONE') {
      state = 'PRONE';
    } else if (actor.stance === 'CROUCH') {
      state = mag > 0.05 || actor.speed > 0.4 ? 'CROUCH_WALK' : 'CROUCH_IDLE';
    } else if (actor.speed < 0.35) {
      state = 'IDLE';
    } else if (actor.speed > this.cfg.runSpeed * 1.05 && input.sprint) {
      state = 'SPRINT';
    } else if (actor.speed > this.cfg.walkSpeed * 1.05) {
      state = 'RUN';
    } else {
      state = 'WALK';
    }

    // Footsteps for the local player only (bots are simulated by AI audio cues)
    if (actor.onGround && (state === 'WALK' || state === 'RUN' || state === 'SPRINT' || state === 'CROUCH_WALK')) {
      actor.footstepPhase += travelled;
      const stride = state === 'SPRINT' ? 2.1 : state === 'RUN' ? 1.75 : state === 'CROUCH_WALK' ? 1.1 : 1.5;
      if (actor.footstepPhase > stride) {
        actor.footstepPhase = 0;
        // Footsteps are both an audio cue and an AI "hearing" event.
        noiseCallback?.(actor, state === 'CROUCH_WALK' ? 11 : state === 'WALK' ? 17 : state === 'SPRINT' ? 34 : 26);
      }
    }
    void dt;
    actor.moveState = state;
    return state;
  }
}

/** Set by the game to broadcast footstep noise to the AI hearing system. */
export let noiseCallback: ((actor: Actor, radius: number) => void) | null = null;

export function setNoiseCallback(cb: (actor: Actor, radius: number) => void): void {
  noiseCallback = cb;
}
