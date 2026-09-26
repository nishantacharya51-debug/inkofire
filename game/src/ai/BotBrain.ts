import * as THREE from 'three';
import type { Actor } from '../entity/Actor';
import type { ControllerInput } from '../player/Locomotion';
import type { NavGrid } from './NavGrid';
import type { CollisionWorld } from '../world/Collision';
import { CONSUMABLES } from '../items/Items';
import { clamp, damp, wrapAngle } from '../utils/mathx';
import { RNG } from '../utils/rng';

export type BotState =
  | 'ROAM'
  | 'LOOT'
  | 'ENGAGE'
  | 'TAKE_COVER'
  | 'HEAL'
  | 'INVESTIGATE'
  | 'REVIVE'
  | 'ROTATE'
  | 'AIRBORNE';

export type DifficultyName = 'EASY' | 'NORMAL' | 'HARD' | 'ELITE';

export interface BotDifficulty {
  name: DifficultyName;
  reactionTime: number;
  /** Lateral aim error in metres while idle / while firing. */
  aimError: number;
  aimErrorFiring: number;
  aimSpeed: number;
  viewDistance: number;
  fov: number;
  hearingRange: number;
  coverUse: number;
  healThreshold: number;
  aggression: number;
  thinkInterval: number;
  grenadeChance: number;
  accuracyDrift: number;
  leadFactor: number;
}

export const DIFFICULTIES: Record<DifficultyName, BotDifficulty> = {
  EASY: {
    name: 'EASY', reactionTime: 0.62, aimError: 0.80, aimErrorFiring: 1.05, aimSpeed: 3.4,
    viewDistance: 85, fov: 100, hearingRange: 26, coverUse: 0.25, healThreshold: 45,
    aggression: 0.45, thinkInterval: 0.20, grenadeChance: 0.05, accuracyDrift: 0.05, leadFactor: 0.35
  },
  NORMAL: {
    name: 'NORMAL', reactionTime: 0.38, aimError: 0.45, aimErrorFiring: 0.60, aimSpeed: 5.2,
    viewDistance: 115, fov: 115, hearingRange: 36, coverUse: 0.5, healThreshold: 55,
    aggression: 0.62, thinkInterval: 0.14, grenadeChance: 0.12, accuracyDrift: 0.032, leadFactor: 0.55
  },
  HARD: {
    name: 'HARD', reactionTime: 0.24, aimError: 0.28, aimErrorFiring: 0.38, aimSpeed: 7.4,
    viewDistance: 150, fov: 128, hearingRange: 48, coverUse: 0.72, healThreshold: 62,
    aggression: 0.78, thinkInterval: 0.10, grenadeChance: 0.22, accuracyDrift: 0.02, leadFactor: 0.78
  },
  ELITE: {
    name: 'ELITE', reactionTime: 0.15, aimError: 0.16, aimErrorFiring: 0.22, aimSpeed: 9.5,
    viewDistance: 200, fov: 145, hearingRange: 62, coverUse: 0.88, healThreshold: 70,
    aggression: 0.9, thinkInterval: 0.07, grenadeChance: 0.32, accuracyDrift: 0.012, leadFactor: 1.0
  }
};

export interface NoiseEvent {
  x: number;
  y: number;
  z: number;
  radius: number;
  team: number;
  time: number;
}

export interface LootTarget {
  id: number;
  x: number;
  y: number;
  z: number;
  tier: number;
  claimed: number;
}

export interface BotContext {
  actors: Actor[];
  nav: NavGrid;
  world: CollisionWorld;
  time: number;
  zone: { x: number; z: number; radius: number; nextX: number; nextZ: number; nextRadius: number; phase: number; shrinking: boolean };
  noises: NoiseEvent[];
  loot: LootTarget[];
  /** Building positions useful as loot destinations. */
  buildings: { x: number; y: number; z: number; radius: number; tier: number }[];
  landingZones: { x: number; z: number; y: number }[];
  terrainHeight: (x: number, z: number) => number;
  isSquadMode: boolean;
  /** Take a loot item (returns true when consumed). */
  claimLoot: (actor: Actor, lootId: number) => boolean;
  /** Feed enemy contacts to the squad network. */
  reportContact: (actor: Actor, enemy: Actor) => void;
  onBotEvent?: (actor: Actor, kind: 'shot' | 'threw' | 'healed' | 'revived' | 'entered_vehicle') => void;
}

const tmpEye = new THREE.Vector3();
const tmpForward = new THREE.Vector3();
const tmpFeet = new THREE.Vector3();

/**
 * Bot brain: senses, decides and produces the same ControllerInput the player
 * uses, so bots are subject to identical physics, spread and recoil.
 */
export class BotBrain {
  actor: Actor;
  difficulty: BotDifficulty;
  state: BotState = 'ROAM';

  target: Actor | null = null;
  targetAwareness = 0;
  lastSeenPos = new THREE.Vector3();
  lastSeenTime = -999;
  lastNoisePos = new THREE.Vector3();
  lastNoiseTime = -999;

  path: { x: number; z: number }[] = [];
  pathIndex = 0;
  pathAge = 999;
  goal: { x: number; z: number; y?: number } | null = null;
  goalKind: 'loot' | 'roam' | 'zone' | 'cover' | 'lootBuilding' | 'flank' | 'ally' = 'roam';

  aimYaw = 0;
  aimPitch = 0;
  desiredYaw = 0;
  desiredPitch = 0;
  private aimNoise = 0;
  private burstPause = 0;
  private strafeDir = 1;
  private strafeTimer = 0;
  private stateTimer = 0;
  private coverPoint: { x: number; z: number } | null = null;
  private investigateFailures = 0;
  private lootClaimed = 0;
  private jumpTimer = 0;
  private lastPathGoal: { x: number; z: number } | null = null;
  private stuckTimer = 0;
  private lastPos = new THREE.Vector3();
  private grenadeCooldown = 0;

  input: ControllerInput = {
    moveX: 0, moveY: 0, lookYaw: 0, lookPitch: 0,
    jump: false, crouch: false, prone: false, sprint: false, walkSlow: false
  };

  /** Set true while the bot wants to press the trigger. */
  wantsFire = false;
  wantsAds = false;

  constructor(actor: Actor, difficulty: BotDifficulty, private rng: RNG) {
    this.actor = actor;
    this.difficulty = difficulty;
    this.aimYaw = actor.yaw;
    this.aimPitch = actor.pitch;
    this.desiredYaw = actor.yaw;
    actor.ai = this;
  }

  onEvent(name: string): void {
    if (name === 'downed') {
      this.state = 'HEAL';
    }
  }

  /** Called when the bot takes damage — used to snap awareness. */
  onDamaged(attacker: Actor | null): void {
    if (!attacker || attacker === this.actor) return;
    if (attacker.team === this.actor.team) return;
    this.target = attacker;
    this.targetAwareness = Math.max(this.targetAwareness, 0.85);
    this.lastSeenPos.copy(attacker.position);
    this.lastSeenTime = 0;
    this.lastSeenTime = -1; // resolved on next think with the real clock
    if (this.state === 'ROAM' || this.state === 'LOOT') this.state = 'ENGAGE';
  }

  /* ---------------------------------------------------------------- */
  /* Main tick                                                         */
  /* ---------------------------------------------------------------- */

  update(dt: number, ctx: BotContext): ControllerInput {
    const a = this.actor;
    this.stateTimer += dt;
    this.grenadeCooldown = Math.max(0, this.grenadeCooldown - dt);
    this.burstPause = Math.max(0, this.burstPause - dt);
    this.jumpTimer = Math.max(0, this.jumpTimer - dt);

    if (a.lifeState === 'DEAD') {
      this.input.moveX = 0; this.input.moveY = 0; this.input.jump = false;
      this.wantsFire = false;
      return this.input;
    }

    // Riding the aircraft: no input until the jump.
    if (a.moveState === 'AIRCRAFT') {
      this.input.moveX = 0; this.input.moveY = 0; this.input.jump = false;
      this.wantsFire = false;
      this.input.lookYaw = a.yaw; this.input.lookPitch = a.pitch;
      return this.input;
    }

    // Airborne: steer toward the landing spot.
    if (a.moveState === 'SKYDIVE' || a.moveState === 'PARACHUTE' || a.moveState === 'FALL' || a.moveState === 'JUMP') {
      this.updateAirborne(dt, ctx);
      return this.input;
    }

    // Perception runs every frame (cheap), decisions on an interval.
    this.sense(dt, ctx);

    if (this.stateTimer >= this.difficulty.thinkInterval) {
      this.stateTimer = 0;
      this.decide(ctx);
    }

    this.act(dt, ctx);
    return this.input;
  }

  /* ---------------------------------------------------------------- */
  /* Perception                                                        */
  /* ---------------------------------------------------------------- */

  private sense(dt: number, ctx: BotContext): void {
    const a = this.actor;
    const d = this.difficulty;
    const cosFov = Math.cos((d.fov * Math.PI) / 180 * 0.5);
    let bestTarget: Actor | null = null;
    let bestScore = -Infinity;

    if (a.lifeState === 'ALIVE') {
      const eye = tmpEye.set(a.position.x, a.position.y + a.eyeHeight, a.position.z);
      const forward = tmpForward.set(-Math.sin(a.yaw), 0, -Math.cos(a.yaw));
      for (const other of ctx.actors) {
        if (other === a || !other.active) continue;
        if (other.team === a.team && other.team >= 0) continue;
        const dx = other.position.x - eye.x;
        const dy = other.position.y + other.bodyHeight * 0.6 - eye.y;
        const dz = other.position.z - eye.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > d.viewDistance) continue;
        const flatDist = Math.hypot(dx, dz) || 1e-4;
        const facing = (dx * forward.x + dz * forward.z) / flatDist;
        // A downed or recently-damaged enemy is noticed even outside the cone.
        const alerted = this.targetAwareness > 0.5 || dist < 12;
        if (facing < cosFov && !alerted) continue;
        if (!ctx.world.lineOfSight(eye.x, eye.y, eye.z, other.position.x, other.position.y + other.bodyHeight * 0.62, other.position.z)) continue;
        // Prefer close, centred targets.
        const score = -dist * 0.1 + facing * 2 + (other.lifeState === 'DOWNED' ? -0.4 : 0);
        if (score > bestScore) {
          bestScore = score;
          bestTarget = other;
        }
      }
    }

    if (bestTarget) {
      const wasTarget = this.target === bestTarget;
      this.target = bestTarget;
      const gain = dt / Math.max(0.05, this.difficulty.reactionTime) * (wasTarget ? 1.6 : 1);
      this.targetAwareness = Math.min(1, this.targetAwareness + gain);
      if (this.targetAwareness >= 0.99) {
        this.lastSeenPos.copy(bestTarget.position);
        this.lastSeenTime = ctx.time;
        ctx.reportContact(this.actor, bestTarget);
      }
    } else {
      this.targetAwareness = Math.max(0, this.targetAwareness - dt * 0.85);
      if (this.targetAwareness <= 0.02) this.target = null;
    }

    // Hearing
    for (const n of ctx.noises) {
      if (n.team === this.actor.team && n.team >= 0) continue;
      const dist = Math.hypot(n.x - a.position.x, n.z - a.position.z);
      if (dist > Math.min(n.radius, this.difficulty.hearingRange)) continue;
      if (n.time < this.lastNoiseTime) continue;
      this.lastNoisePos.set(n.x, n.y, n.z);
      this.lastNoiseTime = n.time;
      if (!this.target && (this.state === 'ROAM' || this.state === 'LOOT')) {
        this.state = 'INVESTIGATE';
        this.stateTimer = 0;
        this.investigateFailures = 0;
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Decision making                                                   */
  /* ---------------------------------------------------------------- */

  private decide(ctx: BotContext): void {
    const a = this.actor;
    const health = a.health / a.maxHealth;
    const hasWeapon = a.inventory.active !== null;
    const outsideZone = Math.hypot(a.position.x - ctx.zone.x, a.position.z - ctx.zone.z) > ctx.zone.radius - 12;
    const inNextZone = Math.hypot(a.position.x - ctx.zone.nextX, a.position.z - ctx.zone.nextZ) > ctx.zone.nextRadius * 0.75;

    // 0. Squad revive takes priority when a mate is down next to us.
    if (ctx.isSquadMode) {
      const downed = ctx.actors.find((o) =>
        o.team === a.team && o !== a && o.lifeState === 'DOWNED' &&
        Math.hypot(o.position.x - a.position.x, o.position.z - a.position.z) < 26 &&
        ctx.world.lineOfSight(a.position.x, a.position.y + 1.2, a.position.z, o.position.x, o.position.y + 0.8, o.position.z)
      );
      if (downed && (!this.target || this.targetAwareness < 0.6)) {
        this.state = 'REVIVE';
        this.goalKind = 'ally';
        this.goal = { x: downed.position.x, z: downed.position.z };
        return;
      }
    }

    // Weaponless bots do not pick fights: they run for loot instead.
    const armed = a.inventory.active !== null;
    if (!armed && this.target && this.targetAwareness > 0.3) {
      // Flee away from the threat while continuing to loot on the way.
      this.state = 'LOOT';
      this.pickLootGoal(ctx, true);
      const dx = a.position.x - this.target.position.x;
      const dz = a.position.z - this.target.position.z;
      const len = Math.hypot(dx, dz) || 1;
      if (this.goal && Math.hypot(this.goal.x - this.target.position.x, this.goal.z - this.target.position.z) < 25) {
        const alt = ctx.nav.randomPointNear(a.position.x + (dx / len) * 45, a.position.z + (dz / len) * 45, 40, () => this.rng.next());
        this.goal = alt;
        this.path.length = 0;
      }
      return;
    }

    // 1. Engage a visible enemy.
    if (armed && this.target && this.targetAwareness > 0.55 && this.target.lifeState !== 'DEAD') {
      if (this.state !== 'ENGAGE') {
        this.state = 'ENGAGE';
        this.stateTimer = 0;
        this.strafeDir = this.rng.bool() ? 1 : -1;
      }
      return;
    }

    // 2. Under fire / heard something → investigate.
    if (this.target && this.targetAwareness > 0.2) {
      this.state = 'INVESTIGATE';
      this.lastNoisePos.copy(this.target.position);
      this.lastNoiseTime = ctx.time;
      this.goal = { x: this.lastNoisePos.x, z: this.lastNoisePos.z };
      this.goalKind = 'roam';
      return;
    }

    // 3. Heal when hurt and relatively safe.
    if (health < this.difficulty.healThreshold / 100 && this.hasHealingItem()) {
      this.state = 'HEAL';
      return;
    }

    // 4. No weapon → loot aggressively.
    if (!hasWeapon) {
      this.state = 'LOOT';
      if (this.stateTimer <= this.difficulty.thinkInterval + 0.001 || !this.goal || this.path.length === 0) {
        this.pickLootGoal(ctx, true);
      }
      return;
    }

    // 5. Zone pressure: get inside the next circle.
    if (outsideZone || (inNextZone && this.rng.bool(0.35))) {
      this.state = 'ROTATE';
      const ang = Math.atan2(a.position.z - ctx.zone.nextZ, a.position.x - ctx.zone.nextX);
      const targetR = ctx.zone.nextRadius * (this.rng.next() * 0.55);
      this.goal = { x: ctx.zone.nextX + Math.cos(ang) * targetR, z: ctx.zone.nextZ + Math.sin(ang) * targetR };
      this.goalKind = 'zone';
      return;
    }

    // 6. Otherwise: loot nearby, or patrol toward a POI.
    const wantsLoot = this.rng.next() < 0.55 && this.lootGoalAvailable(ctx);
    if (wantsLoot) {
      this.state = 'LOOT';
      this.pickLootGoal(ctx, false);
    } else if (this.state !== 'ROAM' || !this.goal || this.path.length === 0) {
      this.state = 'ROAM';
      this.pickRoamGoal(ctx);
    }
  }

  private hasHealingItem(): boolean {
    return this.actor.inventory.consumables.some((s) => s.count > 0 && CONSUMABLES[s.itemId]?.healAmount);
  }

  private lootGoalAvailable(ctx: BotContext): boolean {
    const a = this.actor;
    for (const l of ctx.loot) {
      if (l.claimed > 0) continue;
      if (Math.hypot(l.x - a.position.x, l.z - a.position.z) < 70) return true;
    }
    return false;
  }

  private pickLootGoal(ctx: BotContext, urgent: boolean): void {
    const a = this.actor;
    let best: LootTarget | null = null;
    let bestScore = -Infinity;
    const range = urgent ? 150 : 90;
    for (const l of ctx.loot) {
      if (l.claimed > 0) continue;
      const dist = Math.hypot(l.x - a.position.x, l.z - a.position.z);
      if (dist > range) continue;
      // Slight preference for richer tiers and for loot inside buildings early on.
      const score = -dist + l.tier * (urgent ? 12 : 6) - l.claimed * 5;
      if (score > bestScore) {
        bestScore = score;
        best = l;
      }
    }
    if (best) {
      this.goal = { x: best.x, z: best.z };
      this.goalKind = 'loot';
      return;
    }
    // Fall back to the nearest structure worth looting.
    let bestB: { x: number; z: number } | null = null;
    let bestBD = Infinity;
    for (const b of ctx.buildings) {
      const d = Math.hypot(b.x - a.position.x, b.z - a.position.z);
      if (d < bestBD) {
        bestBD = d;
        bestB = { x: b.x, z: b.z };
      }
    }
    if (bestB && bestBD < 220) {
      this.goal = bestB;
      this.goalKind = 'lootBuilding';
    } else {
      this.pickRoamGoal(ctx);
    }
  }

  private pickRoamGoal(ctx: BotContext): void {
    const a = this.actor;
    // Bias roaming toward the safe zone so bots naturally converge.
    const ang = this.rng.next() * Math.PI * 2;
    const r = this.rng.next() * ctx.zone.radius * 0.7;
    const targetX = ctx.zone.x + Math.cos(ang) * r;
    const targetZ = ctx.zone.z + Math.sin(ang) * r;
    const point = ctx.nav.nearestWalkable(targetX, targetZ, 10) ?? { x: targetX, z: targetZ };
    if (Math.hypot(point.x - a.position.x, point.z - a.position.z) < 30) {
      // Too close to be interesting: pick a nearby spot instead.
      const near = ctx.nav.randomPointNear(a.position.x, a.position.z, 60, () => this.rng.next());
      this.goal = near;
    } else {
      this.goal = point;
    }
    this.goalKind = 'roam';
  }

  /* ---------------------------------------------------------------- */
  /* Action                                                            */
  /* ---------------------------------------------------------------- */

  private act(dt: number, ctx: BotContext): void {
    const a = this.actor;
    const input = this.input;
    input.jump = false;
    input.crouch = false;
    input.prone = false;
    input.sprint = false;
    input.walkSlow = false;
    this.wantsFire = false;

    switch (this.state) {
      case 'ENGAGE':
        this.actEngage(dt, ctx);
        break;
      case 'TAKE_COVER':
        this.actTakeCover(dt, ctx);
        break;
      case 'LOOT':
        this.actLoot(dt, ctx);
        break;
      case 'HEAL':
        this.actHeal(dt, ctx);
        break;
      case 'INVESTIGATE':
        this.actInvestigate(dt, ctx);
        break;
      case 'REVIVE':
        this.actRevive(dt, ctx);
        break;
      case 'ROTATE':
      case 'ROAM':
      default:
        this.actMoveToGoal(dt, ctx, this.state === 'ROTATE');
        break;
    }

    // Look direction follows the aim target (smoothed by turn speed).
    const turn = this.difficulty.aimSpeed * (this.state === 'ENGAGE' ? 1 : 0.6);
    const yawDelta = wrapAngle(this.desiredYaw - this.aimYaw);
    const maxTurn = turn * dt * 3;
    this.aimYaw = wrapAngle(this.aimYaw + clamp(yawDelta, -maxTurn, maxTurn));
    a.yaw = this.aimYaw;
    const pitchDelta = this.desiredPitch - this.aimPitch;
    this.aimPitch += clamp(pitchDelta, -maxTurn * 0.75, maxTurn * 0.75);
    a.pitch = clamp(this.aimPitch, -1.2, 1.2);
    input.lookYaw = a.yaw;
    input.lookPitch = a.pitch;

    // Unstick: if we have not moved for a while, pick a new goal.
    if (a.speed < 0.35 && (this.input.moveX !== 0 || this.input.moveY !== 0) && a.onGround) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 1.6) {
        this.stuckTimer = 0;
        this.path.length = 0;
        this.goal = null;
        this.desiredYaw += (this.rng.next() - 0.5) * 2.4;
        this.jumpTimer = 0.1;
        this.input.jump = true;
      }
    } else {
      this.stuckTimer = 0;
    }
    void this.lastPos;
  }

  private actEngage(dt: number, ctx: BotContext): void {
    const a = this.actor;
    const t = this.target;
    if (!t || t.lifeState === 'DEAD') {
      this.state = 'ROAM';
      return;
    }
    const stats = a.activeWeaponStats();
    const cls = stats?.def.cls ?? 'PISTOL';
    const dist = Math.hypot(t.position.x - a.position.x, t.position.z - a.position.z);

    // Preferred engagement distance per weapon class.
    const preferred = cls === 'SHOTGUN' ? 7 : cls === 'SMG' ? 14 : cls === 'PISTOL' ? 11
      : cls === 'SNIPER' ? 90 : cls === 'DMR' ? 60 : cls === 'LMG' ? 32 : 26;

    // Aim at the upper chest / head with difficulty-scaled error.
    this.aimAt(t, dt, ctx, preferred);

    // Movement: hold preferred range, strafe, and use cover when hurt/reloading.
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = 0.7 + this.rng.next() * 1.3;
      this.strafeDir = this.rng.bool() ? 1 : -1;
    }
    const health = a.health / a.maxHealth;
    const needsCover = (health < 0.45 && this.rng.next() < this.difficulty.coverUse) ||
      (a.inventory.active && a.inventory.active.ammoInMag === 0 && a.reloadTimer > 0);
    if (needsCover && this.difficulty.coverUse > 0.2 && this.rng.next() < this.difficulty.coverUse * 0.5) {
      this.state = 'TAKE_COVER';
      this.stateTimer = 0;
      this.findCover(ctx);
      return;
    }

    // Keep preferred distance.
    let forward = 0;
    if (dist > preferred * 1.25) forward = 1;
    else if (dist < preferred * 0.6) forward = -1;
    this.input.moveY = forward * 0.85;
    this.input.moveX = this.strafeDir * 0.75;
    this.input.sprint = forward > 0 && dist > preferred * 1.8;
    this.input.crouch = dist > preferred * 1.4 && this.rng.next() < 0.1;

    // Reload when empty, heal when critical.
    if (a.inventory.active && a.inventory.active.ammoInMag === 0 && a.reloadTimer <= 0) {
      this.reload();
      this.state = 'TAKE_COVER';
      this.stateTimer = 0;
      this.findCover(ctx);
      return;
    }

    // Grenades: flush out stationary targets at mid range.
    if (this.grenadeCooldown <= 0 && dist > 14 && dist < 34 && this.rng.next() < this.difficulty.grenadeChance * 0.08) {
      const frag = a.inventory.throwables.find((s) => s.itemId === 'frag' && s.count > 0);
      if (frag) {
        this.grenadeCooldown = 8 + this.rng.next() * 8;
        ctx.onBotEvent?.(a, 'threw');
        a.throwRequest = { itemId: 'frag', x: t.position.x, y: t.position.y + 0.4, z: t.position.z };
      }
    }

    // Fire control: only shoot when the muzzle is actually pointed at the
    // target. The tolerance is a *lateral* error budget (≈0.85 m at the
    // current distance) so bots strafe and settle before firing instead of
    // spraying while still 6° off target.
    const aimTolerance = clamp(0.85 / Math.max(4, dist), 0.012, 0.10);
    const aimReady = Math.abs(wrapAngle(this.desiredYaw - a.yaw)) < aimTolerance
      && Math.abs(this.desiredPitch - a.pitch) < aimTolerance * 1.6;
    // Never spray outside the weapon's practical envelope: bots inside their
    // class range keep the fight close enough to actually connect.
    const effectiveRange = Math.min(stats ? stats.def.falloffEnd * 1.05 : 45, preferred * 2.6 + 12);
    const inRange = dist < Math.max(24, effectiveRange);
    const e = tmpFeet.set(a.position.x, a.position.y + a.eyeHeight, a.position.z);
    const losClear = ctx.world.lineOfSight(e.x, e.y, e.z,
      t.position.x, t.position.y + t.bodyHeight * 0.62, t.position.z);
    if (aimReady && inRange && losClear && this.burstPause <= 0) {
      this.wantsFire = true;
      // Burst discipline: pause between bursts so bots are not laser beams.
      if (this.rng.next() < 0.35) {
        this.burstPause = 0.12 + this.rng.next() * 0.35 * (1 - this.difficulty.aggression * 0.5);
      }
    } else if (!losClear || !inRange) {
      // Reposition toward the target instead of shooting walls.
      this.input.moveY = 1;
      this.input.sprint = true;
      this.goal = { x: t.position.x, z: t.position.z };
      this.goalKind = 'roam';
      this.moveAlongPath(dt, ctx, false);
    }
    this.wantsAds = dist > 22 && this.rng.next() < 0.9;
  }

  private aimAt(t: Actor, dt: number, ctx: BotContext, preferred: number): void {
    const a = this.actor;
    const eye = tmpEye.set(a.position.x, a.position.y + a.eyeHeight, a.position.z);
    // Aim for the head at close range, centre mass further out.
    const dist = Math.hypot(t.position.x - a.position.x, t.position.z - a.position.z);
    const aimHigh = dist < 40 ? 0.85 : 0.62;
    const aimY = t.position.y + t.bodyHeight * aimHigh;

    // Lead moving targets.
    const lead = this.difficulty.leadFactor * clamp(dist / 300, 0, 0.4);
    const px = t.position.x + t.velocity.x * lead * 3;
    const pz = t.position.z + t.velocity.z * lead * 3;

    const dx = px - eye.x;
    const dy = aimY - eye.y;
    const dz = pz - eye.z;
    const flat = Math.hypot(dx, dz) || 1e-4;
    this.desiredYaw = Math.atan2(-dx, -dz);
    this.desiredPitch = Math.atan2(dy, flat);

    // Aim error is an error *budget in metres* converted to an angle for the
    // current distance: bots stay competent at medium range and get steadily
    // worse at long range, instead of being hopeless everywhere.
    this.aimNoise = damp(this.aimNoise, (this.rng.next() - 0.5) * 2, 3.5, dt);
    const errBase = this.wantsFire ? this.difficulty.aimErrorFiring : this.difficulty.aimError;
    const movementErr = 1 + Math.min(1, t.speed / 6) * 0.35;
    const lateral = errBase * movementErr;
    const err = clamp(lateral / Math.max(6, dist), 0.0032, 0.085) * this.aimNoise;
    this.desiredYaw += err;
    this.desiredPitch += err * 0.7;
    void preferred;
    void ctx;
  }

  private findCover(ctx: BotContext): void {
    const a = this.actor;
    // Threat position as plain numbers (this.target and lastNoisePos are different types).
    const threatX = this.target ? this.target.position.x : this.lastNoisePos.x;
    const threatY = this.target ? this.target.position.y + 1.4 : this.lastNoisePos.y + 1.4;
    const threatZ = this.target ? this.target.position.z : this.lastNoisePos.z;
    this.coverPoint = null;
    let best: { x: number; z: number } | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 14; i++) {
      const ang = (i / 14) * Math.PI * 2;
      const r = 4 + this.rng.next() * 7;
      const px = a.position.x + Math.cos(ang) * r;
      const pz = a.position.z + Math.sin(ang) * r;
      if (!ctx.nav.isWalkable(px, pz)) continue;
      // Cover means: cannot be seen from the threat, and close to us.
      const blocked = !ctx.world.lineOfSight(threatX, threatY, threatZ, px, ctx.terrainHeight(px, pz) + 1.1, pz);
      if (!blocked) continue;
      const score = -Math.hypot(px - a.position.x, pz - a.position.z);
      if (score > bestScore) {
        bestScore = score;
        best = { x: px, z: pz };
      }
    }
    if (best) {
      this.coverPoint = best;
      this.goal = best;
    } else {
      this.goal = { x: a.position.x, z: a.position.z };
    }
  }

  private actTakeCover(dt: number, ctx: BotContext): void {
    const a = this.actor;
    if (!this.coverPoint) this.findCover(ctx);
    if (this.coverPoint) {
      const d = Math.hypot(this.coverPoint.x - a.position.x, this.coverPoint.z - a.position.z);
      if (d > 2.2) {
        this.actMoveToGoal(dt, ctx, true);
      } else {
        this.input.moveX = 0;
        this.input.moveY = 0;
        this.input.crouch = true;
      }
    }
    // Reload / heal while in cover.
    if (a.reloadTimer <= 0 && a.inventory.active && a.inventory.active.ammoInMag < 4) this.reload();
    if (a.health < a.maxHealth * (this.difficulty.healThreshold / 100) && a.healTimer <= 0 && this.hasHealingItem()) {
      const item = a.inventory.consumables.find((s) => s.count > 0 && CONSUMABLES[s.itemId]?.healAmount);
      if (item) a.useRequest = item.itemId;
    }
    // Look toward the threat while in cover.
    const t = this.target;
    if (t) {
      this.desiredYaw = Math.atan2(-(t.position.x - a.position.x), -(t.position.z - a.position.z));
      this.desiredPitch = 0;
      if (a.inventory.active && a.inventory.active.ammoInMag > 0 && this.rng.next() < 0.5) {
        // Peek and fire
        this.input.crouch = false;
        const e2 = tmpFeet.set(a.position.x, a.position.y + a.eyeHeight, a.position.z);
        const los = ctx.world.lineOfSight(e2.x, e2.y, e2.z, t.position.x, t.position.y + 1.0, t.position.z);
        if (los) this.wantsFire = true;
      }
    }
    this.stateTimer += dt;
    if (this.stateTimer > 2.5 + this.rng.next() * 2) {
      this.state = this.target ? 'ENGAGE' : 'ROAM';
      this.stateTimer = 0;
    }
  }

  private actLoot(dt: number, ctx: BotContext): void {
    const a = this.actor;
    // Grab anything we are standing on.
    let claimed = false;
    for (const l of ctx.loot) {
      if (l.claimed > 0) continue;
      if (Math.hypot(l.x - a.position.x, l.z - a.position.z) < 3.2 && Math.abs(l.y - a.position.y) < 3.0) {
        if (ctx.claimLoot(a, l.id)) {
          claimed = true;
          this.lootClaimed++;
          break;
        }
      }
    }
    if (claimed) {
      this.lootClaimed = 0;
      this.goal = null;
      this.path.length = 0;
    }
    this.actMoveToGoal(dt, ctx, true);
    if (!this.goal) this.pickLootGoal(ctx, a.inventory.active === null);
    // Keep an eye out
    if (this.target) this.desiredYaw = Math.atan2(-(this.target.position.x - a.position.x), -(this.target.position.z - a.position.z));
  }

  private actHeal(dt: number, ctx: BotContext): void {
    const a = this.actor;
    if (a.healTimer <= 0) {
      const item = a.inventory.consumables.find((s) => s.count > 0 && CONSUMABLES[s.itemId]?.healAmount);
      if (item) a.useRequest = item.itemId;
      else {
        this.state = 'ROAM';
        return;
      }
    }
    // Back away from the last known threat while healing.
    if (this.target) {
      const dx = a.position.x - this.target.position.x;
      const dz = a.position.z - this.target.position.z;
      const len = Math.hypot(dx, dz) || 1;
      this.goal = { x: a.position.x + (dx / len) * 18, z: a.position.z + (dz / len) * 18 };
      this.actMoveToGoal(dt, ctx, true);
      this.desiredYaw = Math.atan2(-(this.target.position.x - a.position.x), -(this.target.position.z - a.position.z));
    } else {
      this.input.moveX = 0;
      this.input.moveY = 0;
      this.input.crouch = true;
    }
    if (a.health >= a.maxHealth * 0.92 || a.healTimer <= 0) {
      this.state = this.target ? 'ENGAGE' : 'ROAM';
    }
    this.wantsFire = false;
  }

  private actInvestigate(dt: number, ctx: BotContext): void {
    const a = this.actor;
    const goal = this.lastSeenTime > 0 && this.target ? this.lastSeenPos : this.lastNoisePos;
    this.goal = { x: goal.x, z: goal.z };
    this.goalKind = 'roam';
    this.actMoveToGoal(dt, ctx, true);
    const arrived = Math.hypot(goal.x - a.position.x, goal.z - a.position.z) < 4;
    if (arrived) {
      this.investigateFailures++;
      if (this.investigateFailures >= 2) {
        this.investigateFailures = 0;
        this.state = 'ROAM';
        this.goal = null;
      } else {
        const near = ctx.nav.randomPointNear(a.position.x, a.position.z, 18, () => this.rng.next());
        this.goal = near;
        this.path.length = 0;
      }
    } else if (this.path.length === 0 && this.pathAge > 2.5) {
      this.state = this.target ? 'ENGAGE' : 'ROAM';
    }
    // Look around while moving.
    if (this.path.length > 1 && this.rng.next() < 0.05) {
      this.desiredYaw += (this.rng.next() - 0.5) * 1.2;
    }
    if (a.inventory.active && a.inventory.active.ammoInMag === 0) this.reload();
  }

  private actRevive(dt: number, ctx: BotContext): void {
    const a = this.actor;
    const mate = ctx.actors.find((o) => o.team === a.team && o !== a && o.lifeState === 'DOWNED');
    if (!mate) {
      this.state = 'ROAM';
      return;
    }
    const dist = Math.hypot(mate.position.x - a.position.x, mate.position.z - a.position.z);
    if (dist > 2.2) {
      this.goal = { x: mate.position.x, z: mate.position.z };
      this.actMoveToGoal(dt, ctx, true);
    } else {
      this.input.moveX = 0;
      this.input.moveY = 0;
      a.reviveRequest = mate.id;
      this.desiredYaw = Math.atan2(-(mate.position.x - a.position.x), -(mate.position.z - a.position.z));
      if (mate.lifeState === 'ALIVE') {
        this.state = this.target ? 'ENGAGE' : 'ROAM';
        a.reviveRequest = -1;
      }
    }
    if (this.target && this.targetAwareness > 0.7) {
      this.state = 'ENGAGE';
      a.reviveRequest = -1;
    }
    void ctx;
  }

  /* ---------------------------------------------------------------- */
  /* Movement                                                          */
  /* ---------------------------------------------------------------- */

  private actMoveToGoal(dt: number, ctx: BotContext, allowSprint: boolean): void {
    if (!this.goal) {
      this.input.moveX = 0;
      this.input.moveY = 0;
      return;
    }
    const a = this.actor;
    const goalMoved = !this.lastPathGoal || Math.hypot(this.goal.x - this.lastPathGoal.x, this.goal.z - this.lastPathGoal.z) > 6;
    this.pathAge += dt;
    if (this.path.length === 0 || goalMoved || this.pathAge > 3.5) {
      this.repath(ctx);
    }
    this.moveAlongPath(dt, ctx, allowSprint);
    void a;
  }

  private repath(ctx: BotContext): void {
    if (!this.goal) return;
    const a = this.actor;
    this.path = ctx.nav.findPath(a.position.x, a.position.z, this.goal.x, this.goal.z);
    this.pathIndex = 0;
    this.pathAge = 0;
    this.lastPathGoal = { x: this.goal.x, z: this.goal.z };
  }

  private moveAlongPath(dt: number, ctx: BotContext, allowSprint: boolean): void {
    const a = this.actor;
    if (this.path.length === 0) {
      // No path: nudge toward the goal directly, with local steering.
      if (this.goal) {
        this.steerToward(this.goal.x, this.goal.z, ctx, dt, allowSprint);
      }
      return;
    }
    while (this.pathIndex < this.path.length - 1) {
      const wp = this.path[this.pathIndex];
      if (Math.hypot(wp.x - a.position.x, wp.z - a.position.z) < 3.0) this.pathIndex++;
      else break;
    }
    const wp = this.path[Math.min(this.pathIndex, this.path.length - 1)];
    this.steerToward(wp.x, wp.z, ctx, dt, allowSprint);
    // Reached the end of the path?
    if (this.pathIndex >= this.path.length - 1) {
      const goal = this.goal;
      if (goal && Math.hypot(goal.x - a.position.x, goal.z - a.position.z) < 3.5) {
        this.path.length = 0;
        if (this.goalKind === 'loot') {
          // Nothing there: forget it.
          this.goal = null;
        }
      }
    }
  }

  private steerToward(tx: number, tz: number, ctx: BotContext, _dt: number, allowSprint: boolean): void {
    const a = this.actor;
    const dx = tx - a.position.x;
    const dz = tz - a.position.z;
    const dist = Math.hypot(dx, dz) || 1e-4;
    const dirX = dx / dist;
    const dirZ = dz / dist;

    // Local steering: three feelers, pick a clear direction.
    const feeler = 2.6;
    const front = this.clearAhead(ctx, dirX, dirZ, feeler);
    let steerX = dirX;
    let steerZ = dirZ;
    if (!front) {
      const leftX = -dirZ;
      const leftZ = dirX;
      const leftClear = this.clearAhead(ctx, leftX, leftZ, feeler);
      const rightClear = this.clearAhead(ctx, -leftX, -leftZ, feeler);
      if (leftClear && !rightClear) {
        steerX = leftX; steerZ = leftZ;
      } else if (rightClear && !leftClear) {
        steerX = -leftX; steerZ = -leftZ;
      } else if (leftClear && rightClear) {
        const side = ((a.id + Math.floor(ctx.time)) % 2 === 0) ? 1 : -1;
        steerX = (dirX + leftX * side * 0.9);
        steerZ = (dirZ + leftZ * side * 0.9);
      } else {
        steerX = -dirZ; steerZ = dirX;
      }
      // Jump over low obstacles.
      if (a.onGround && this.jumpTimer <= 0) {
        this.input.jump = true;
        this.jumpTimer = 0.6;
      }
    }
    const len = Math.hypot(steerX, steerZ) || 1;
    steerX /= len;
    steerZ /= len;

    // Convert world direction into the character's local movement axes.
    const cosY = Math.cos(a.yaw);
    const sinY = Math.sin(a.yaw);
    const fx = -sinY;
    const fz = -cosY;
    const rx = cosY;
    const rz = -sinY;
    const forward = steerX * fx + steerZ * fz;
    const right = steerX * rx + steerZ * rz;
    this.input.moveX = clamp(right, -1, 1);
    this.input.moveY = clamp(forward, -1, 1);
    this.input.sprint = allowSprint && dist > 12 && forward > 0.5 && a.stamina > 15;
    // Face the movement direction when not in combat.
    if (this.state !== 'ENGAGE' && this.state !== 'TAKE_COVER') {
      this.desiredYaw = Math.atan2(-steerX, -steerZ);
      if (this.rng.next() < 0.02) this.desiredYaw += (this.rng.next() - 0.5) * 0.6;
    }
    if (this.target && this.targetAwareness > 0.4) {
      this.desiredYaw = Math.atan2(-(this.target.position.x - a.position.x), -(this.target.position.z - a.position.z));
    }
    if (a.inventory.active && a.inventory.active.ammoInMag === 0 && a.reloadTimer <= 0 && this.state !== 'ENGAGE') {
      this.reload();
    }
  }

  private clearAhead(ctx: BotContext, dirX: number, dirZ: number, dist: number): boolean {
    const a = this.actor;
    const eyeY = a.position.y + a.bodyHeight * 0.55;
    return !ctx.world.raycast(a.position.x, eyeY, a.position.z, dirX, 0, dirZ, dist);
  }

  private updateAirborne(dt: number, ctx: BotContext): void {
    const a = this.actor;
    const input = this.input;
    const glide = a.moveState === 'PARACHUTE';
    const target = this.landingTarget ?? (this.landingTarget = this.pickLandingSpot(ctx));
    const dx = target.x - a.position.x;
    const dz = target.z - a.position.z;
    const dist = Math.hypot(dx, dz) || 1e-4;

    input.lookYaw = a.yaw;
    input.lookPitch = a.pitch;
    this.desiredYaw = Math.atan2(-dx, -dz);
    const yawDelta = wrapAngle(this.desiredYaw - a.yaw);
    a.yaw = wrapAngle(a.yaw + clamp(yawDelta, -2.4 * dt, 2.4 * dt));
    input.lookYaw = a.yaw;

    // Steer into the dive / glide direction.
    const cosY = Math.cos(a.yaw);
    const sinY = Math.sin(a.yaw);
    const fx = -sinY;
    const fz = -cosY;
    const forward = (dx * fx + dz * fz) / dist;
    const right = (dx * cosY + dz * -sinY) / dist;
    input.moveY = clamp(forward * 1.2, -1, 1);
    input.moveX = clamp(right * 0.8, -1, 1);
    input.jump = false;
    input.sprint = !glide && dist > 30;
    input.crouch = glide && dist < 12;
    // Deploy the parachute at a sane height.
    if (!glide && a.position.y - a.groundHeight < 120 && a.moveState === 'SKYDIVE') {
      a.deployChuteRequest = true;
    }
    if (glide && a.position.y - a.groundHeight < 3.5) {
      // Flare for landing
      input.moveY = Math.min(input.moveY, 0);
    }
    void dt;
    void ctx;
  }

  /** Chosen parachute landing spot (set by the match director or the brain). */
  landingTarget: { x: number; z: number } | null = null;

  pickLandingSpot(ctx: BotContext): { x: number; z: number } {
    // Bots spread across POIs / buildings rather than stacking on one roof.
    const candidates = ctx.buildings.length > 0 ? ctx.buildings : ctx.landingZones;
    let best: { x: number; z: number } | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 6; i++) {
      const c = candidates[Math.floor(this.rng.next() * candidates.length)];
      if (!c) continue;
      const jitterX = (this.rng.next() - 0.5) * 30;
      const jitterZ = (this.rng.next() - 0.5) * 30;
      const x = c.x + jitterX;
      const z = c.z + jitterZ;
      if (!ctx.nav.isWalkable(x, z)) continue;
      const distFromStart = Math.hypot(x - ctx.zone.x, z - ctx.zone.z);
      // Prefer being inside the first circle but not piled on the exact centre.
      const score = (ctx.zone.radius - distFromStart) * 0.01 + this.rng.next() * 2;
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
    return best ?? { x: ctx.zone.x, z: ctx.zone.z };
  }

  /* ---------------------------------------------------------------- */
  /* Small actions                                                     */
  /* ---------------------------------------------------------------- */

  private reload(): void {
    if (this.actor.reloadRequest) return;
    this.actor.reloadRequest = true;
  }

  /** Called by the director when the bot lands. */
  onLanded(): void {
    this.state = 'LOOT';
    this.goal = null;
    this.path.length = 0;
    this.stateTimer = 999;
  }
}
