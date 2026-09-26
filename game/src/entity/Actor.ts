import * as THREE from 'three';
import { Inventory, effectiveStats, type WeaponInstance } from '../inventory/Inventory';
import { WEAPONS, type Rarity } from '../items/Items';
import { bus } from '../core/EventBus';

export type BodyPart = 'HEAD' | 'TORSO' | 'ARM' | 'LEG';
export type Stance = 'STAND' | 'CROUCH' | 'PRONE';
export type LifeState = 'ALIVE' | 'DOWNED' | 'DEAD';

/** Locomotion / animation state shared by the rig and the network layer. */
export type MoveState =
  | 'IDLE' | 'WALK' | 'RUN' | 'SPRINT' | 'CROUCH_IDLE' | 'CROUCH_WALK' | 'PRONE'
  | 'JUMP' | 'FALL' | 'LAND' | 'SLIDE' | 'SWIM' | 'SKYDIVE' | 'PARACHUTE' | 'AIRCRAFT'
  | 'DOWNED' | 'DEAD' | 'DRIVE' | 'CLIMB' | 'RELOAD' | 'HEAL';

export interface ActorConfig {
  id: number;
  name: string;
  team: number;
  isBot: boolean;
  isLocal: boolean;
}

const HEAD_RADIUS = 0.145;
const TORSO_RADIUS = 0.235;
const ARM_RADIUS = 0.105;
const LEG_RADIUS = 0.185;

export interface HitboxHit {
  part: BodyPart;
  dist: number;
}

/**
 * Shared actor model for the local player, AI bots and (later) remote players.
 * Positions are authoritative here; rendering reads from the same object.
 */
export class Actor {
  readonly id: number;
  readonly name: string;
  readonly team: number;
  readonly isBot: boolean;
  readonly isLocal: boolean;

  position = new THREE.Vector3();
  velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;

  health = 100;
  maxHealth = 100;
  lifeState: LifeState = 'ALIVE';
  downHealth = 100;
  downedAt = 0;
  stance: Stance = 'STAND';
  moveState: MoveState = 'IDLE';
  onGround = true;
  inWater = false;
  groundHeight = 0;
  landingImpact = 0;

  inventory = new Inventory();

  /* Weapon runtime */
  fireCooldown = 0;
  reloadTimer = 0;
  reloadDuration = 0;
  burstRemaining = 0;
  burstCooldown = 0;
  adsProgress = 0;
  sprintBlocked = 0;
  switchTimer = 0;
  /** Current aim deviation in radians (world space), from recoil + spread. */
  aimPitchOffset = 0;
  aimYawOffset = 0;
  recoilPitchVel = 0;
  recoilYawVel = 0;
  spreadBloom = 0;
  lastShotTime = -999;
  shotsInBurst = 0;
  /** Muzzle flash timer for VFX. */
  muzzleTimer = 0;
  /** Weapon heat for LMG-style mechanics / UI. */
  heat = 0;

  /* Combat bookkeeping */
  lastDamageTime = -999;
  lastDamageDirection = 0;
  attackerId = -1;
  kills = 0;
  headshotKills = 0;
  damageDealt = 0;
  damageTaken = 0;
  shotsFired = 0;
  shotsHit = 0;
  survivalTime = 0;
  distanceTravelled = 0;
  revives = 0;
  placement = 0;
  eliminations: { killer: string; victim: string; weapon: string; headshot: boolean }[] = [];

  /* Movement helpers */
  jumpCooldown = 0;
  /** Time the actor has been pressed against geometry while trying to move. */
  stuckTimer = 0;
  slideTimer = 0;
  slideDirection = new THREE.Vector3();
  vaultTimer = 0;
  fallStartY = 0;
  wasSprinting = false;
  footstepPhase = 0;
  stamina = 100;
  /** Set while the actor is inside a vehicle. */
  vehicleId: number | null = null;
  /** Parachute / skydive state */
  parachuteOpen = false;
  deployAltitude = 0;
  /** False while riding the aircraft; true once the actor has jumped. */
  hasJumped = false;

  /* Revive state (squad modes) */
  reviveProgress = 0;
  revivingId = -1;
  lastHealItem: string | null = null;

  /* Ability cooldowns */
  healTimer = 0;
  healAmountTotal = 0;
  healRate = 0;
  usingConsumable: string | null = null;

  /** AI brain attaches here (kept loose so the render layer never imports AI). */
  ai: unknown = null;

  /* One-frame "requests" written by AI (or input mapping) and consumed by the
     match systems. Keeping them on the actor avoids extra plumbing. */
  reloadRequest = false;
  useRequest: string | null = null;
  reviveRequest = -1;
  deployChuteRequest = false;
  /** Request a thrown item toward a world point (bots) or along the aim (player). */
  throwRequest: { itemId: string; x: number; y: number; z: number } | null = null;
  /** Vehicle the actor wants to enter. */
  interactRequest = -1;

  /** Reusable vectors for hitbox maths. */
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  constructor(cfg: ActorConfig) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.team = cfg.team;
    this.isBot = cfg.isBot;
    this.isLocal = cfg.isLocal;
  }

  get alive(): boolean {
    return this.lifeState === 'ALIVE';
  }

  get active(): boolean {
    return this.lifeState !== 'DEAD';
  }

  get isDowned(): boolean {
    return this.lifeState === 'DOWNED';
  }

  /** Collision height of the current stance. */
  get bodyHeight(): number {
    if (this.moveState === 'PRONE') return 0.62;
    if (this.stance === 'CROUCH') return 1.28;
    if (this.moveState === 'SKYDIVE') return 1.5;
    return 1.8;
  }

  get eyeHeight(): number {
    if (this.moveState === 'PRONE') return 0.44;
    if (this.stance === 'CROUCH') return 1.05;
    return 1.62;
  }

  get bodyRadius(): number {
    return this.moveState === 'PRONE' ? 0.4 : 0.36;
  }

  get eyePosition(): THREE.Vector3 {
    return this.tmpA.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  get center(): THREE.Vector3 {
    return this.tmpB.set(this.position.x, this.position.y + this.bodyHeight * 0.55, this.position.z);
  }

  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Total aim direction including recoil offsets. */
  getAimDirection(out: THREE.Vector3): THREE.Vector3 {
    const pitch = this.pitch + this.aimPitchOffset;
    const yaw = this.yaw + this.aimYawOffset;
    const cosP = Math.cos(pitch);
    out.set(-Math.sin(yaw) * cosP, Math.sin(pitch), -Math.cos(yaw) * cosP);
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Hitboxes                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Ray/hitbox test. Returns the nearest body part hit and the distance, or null.
   * Parts are real capsules so headshots require actual aim, and limbs can be
   * clipped while peeking cover.
   */
  raycastHitboxes(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    rayCapsule: (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number) => number,
    raySphere: (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, r: number) => number
  ): HitboxHit | null {
    if (this.lifeState === 'DEAD') return null;
    const px = this.position.x;
    const py = this.position.y;
    const pz = this.position.z;
    const h = this.bodyHeight;
    const prone = this.moveState === 'PRONE';
    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);
    // Shoulder offsets rotate with the body.
    const armOffX = prone ? 0 : cosY * 0.245;
    const armOffZ = prone ? 0 : -sinY * 0.245;

    let best = maxDist;
    let part: BodyPart | null = null;

    const test = (p: BodyPart, capsule: [number, number, number, number, number, number, number] | null, sphere: [number, number, number, number] | null): void => {
      let t = -1;
      if (capsule) {
        t = rayCapsule(ox, oy, oz, dx, dy, dz, capsule[0], capsule[1], capsule[2], capsule[3], capsule[4], capsule[5], capsule[6]);
      } else if (sphere) {
        t = raySphere(ox, oy, oz, dx, dy, dz, sphere[0], sphere[1], sphere[2], sphere[3]);
      }
      if (t >= 0 && t < best) {
        best = t;
        part = p;
      }
    };

    // Head
    const headY = prone ? py + 0.42 : py + h - HEAD_RADIUS - 0.06;
    test('HEAD', null, [px, headY, pz, HEAD_RADIUS + (prone ? 0 : 0.02)]);
    // Torso
    const torsoLow = prone ? py + 0.16 : py + h * 0.46;
    const torsoHigh = prone ? py + 0.34 : py + h * 0.82;
    test('TORSO', [px, torsoLow, pz, px, torsoHigh, pz, TORSO_RADIUS], null);
    // Legs
    if (!prone) {
      test('LEG', [px - sinY * 0.11, py + 0.10, pz - cosY * 0.11, px - sinY * 0.11, py + h * 0.45, pz - cosY * 0.11, LEG_RADIUS], null);
      test('LEG', [px + sinY * 0.11, py + 0.10, pz + cosY * 0.11, px + sinY * 0.11, py + h * 0.45, pz + cosY * 0.11, LEG_RADIUS], null);
    } else {
      test('LEG', [px, py + 0.04, pz, px, py + 0.18, pz, 0.3], null);
    }
    // Arms
    if (!prone) {
      test('ARM', [px + armOffX, py + h * 0.58, pz + armOffZ, px + armOffX, py + h * 0.78, pz + armOffZ, ARM_RADIUS], null);
      test('ARM', [px - armOffX, py + h * 0.58, pz - armOffZ, px - armOffX, py + h * 0.78, pz - armOffZ, ARM_RADIUS], null);
    }

    if (!part) return null;
    return { part, dist: best };
  }

  /** Distance from a point to the actor's body (for melee/explosions). */
  distanceTo(x: number, y: number, z: number): number {
    const cy = this.position.y + this.bodyHeight * 0.5;
    return Math.hypot(this.position.x - x, cy - y, this.position.z - z);
  }

  /* ---------------------------------------------------------------- */
  /* Damage                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Applies damage with body-part multipliers, armor and helmet mitigation.
   * `distanceFalloff` is expected to be pre-computed by the caller.
   */
  applyDamage(amount: number, part: BodyPart, attacker: Actor | null, weaponId: string, now: number, allowDown = true): { killed: boolean; downed: boolean; damage: number; headshot: boolean } {
    if (this.lifeState === 'DEAD') return { killed: false, downed: false, damage: 0, headshot: false };
    const weapon = WEAPONS[weaponId];
    let dmg = amount;

    if (part === 'HEAD') {
      dmg *= weapon ? weapon.headMult : 2.2;
      if (this.inventory.helmetReduction > 0) dmg *= 1 - this.inventory.helmetReduction;
    } else if (part === 'ARM') {
      dmg *= weapon ? weapon.limbMult : 0.85;
      dmg = this.inventory.absorbDamage(dmg);
    } else if (part === 'LEG') {
      dmg *= weapon ? weapon.limbMult * 0.92 : 0.78;
      dmg = this.inventory.absorbDamage(dmg);
    } else {
      dmg = this.inventory.absorbDamage(dmg);
    }

    dmg = Math.max(1, Math.round(dmg * 10) / 10);
    this.damageTaken += dmg;
    this.health -= dmg;
    this.lastDamageTime = now;
    if (attacker) {
      const dx = this.position.x - attacker.position.x;
      const dz = this.position.z - attacker.position.z;
      this.lastDamageDirection = Math.atan2(dx, dz);
      this.attackerId = attacker.id;
      attacker.damageDealt += dmg;
    }

    bus.emit('actor:damaged', {
      id: this.id,
      amount: dmg,
      part,
      attackerId: attacker?.id ?? -1,
      isLocal: this.isLocal
    });

    if (this.health <= 0) {
      this.health = 0;
      const squadMode = allowDown && this.canBeDowned();
      if (squadMode) {
        this.lifeState = 'DOWNED';
        this.downHealth = 100;
        this.downedAt = now;
        this.velocity.set(0, this.velocity.y, 0);
        bus.emit('actor:knocked', { id: this.id, isLocal: this.isLocal });
        if (this.isLocal) bus.emit('player:downed', {});
        this.ai && notifyAi(this.ai, 'downed');
        return { killed: false, downed: true, damage: dmg, headshot: part === 'HEAD' };
      }
      return { killed: this.eliminate(attacker, weaponId, part === 'HEAD', now), downed: false, damage: dmg, headshot: part === 'HEAD' };
    }
    return { killed: false, downed: false, damage: dmg, headshot: part === 'HEAD' };
  }

  /**
   * Squad rules (DUO/SQUAD/CLASH) enable the downed state; the match manager
   * sets `squadRules` when the mode starts.
   */
  squadRules = false;
  canBeDowned(): boolean {
    return this.squadRules;
  }

  markEliminated(): void {
    this.lifeState = 'DEAD';
    this.health = 0;
  }

  eliminate(attacker: Actor | null, weaponId: string, headshot: boolean, now: number): boolean {
    if (this.lifeState === 'DEAD') return false;
    this.lifeState = 'DEAD';
    this.health = 0;
    this.moveState = 'DEAD';
    this.velocity.set(0, 0, 0);
    if (attacker && attacker !== this) {
      attacker.kills++;
      if (headshot) attacker.headshotKills++;
      this.eliminations.push({ killer: attacker.name, victim: this.name, weapon: weaponId, headshot });
    } else {
      this.eliminations.push({ killer: 'Zone', victim: this.name, weapon: 'ENVIRONMENT', headshot: false });
    }
    bus.emit('actor:eliminated', {
      id: this.id,
      killerId: attacker?.id ?? -1,
      weaponId,
      isLocal: this.isLocal,
      name: this.name
    });
    bus.emit('killfeed', {
      killer: attacker?.name ?? 'The Zone',
      victim: this.name,
      weapon: weaponId,
      headshot,
      isLocalKiller: attacker?.isLocal ?? false,
      isLocalVictim: this.isLocal
    });
    this.ai && notifyAi(this.ai, 'eliminated');
    void now;
    return true;
  }

  heal(amount: number): number {
    if (this.lifeState !== 'ALIVE') return 0;
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    return this.health - before;
  }

  reviveFromDown(healthAfter = 40): void {
    this.lifeState = 'ALIVE';
    this.downHealth = 100;
    this.health = healthAfter;
    bus.emit('actor:revived', { id: this.id });
  }


  /* ---------------------------------------------------------------- */
  /* Weapon helpers                                                   */
  /* ---------------------------------------------------------------- */

  get activeWeapon(): WeaponInstance | null {
    return this.inventory.active;
  }

  activeWeaponStats(): ReturnType<typeof effectiveStats> | null {
    const w = this.inventory.active;
    if (!w) return null;
    return effectiveStats(w);
  }

  /** Effective spread in degrees for the current weapon and movement. */
  currentSpread(): number {
    const w = this.inventory.active;
    if (!w) return 0;
    const s = effectiveStats(w);
    const ads = this.adsProgress;
    const base = s.spreadHip + (s.spreadAds - s.spreadHip) * ads;
    const moveFactor = 1 + Math.min(1, this.speed / 6.5) * (s.def.spreadMoveMultiplier - 1) * (1 - ads * 0.55);
    const airFactor = this.onGround ? 1 : 1.6;
    const stanceFactor = this.stance === 'CROUCH' ? 0.86 : this.moveState === 'PRONE' ? 0.7 : 1;
    return (base * moveFactor * airFactor * stanceFactor + this.spreadBloom) * (this.reloadTimer > 0 ? 1.6 : 1);
  }

  reset(): void {
    this.health = this.maxHealth;
    this.lifeState = 'ALIVE';
    this.moveState = 'IDLE';
    this.stance = 'STAND';
    this.velocity.set(0, 0, 0);
    this.inventory = new Inventory(this.name);
    this.kills = 0;
    this.damageDealt = 0;
    this.damageTaken = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.adsProgress = 0;
    this.aimPitchOffset = 0;
    this.aimYawOffset = 0;
    this.spreadBloom = 0;
    this.reloadTimer = 0;
    this.fireCooldown = 0;
    this.vehicleId = null;
    this.parachuteOpen = false;
    this.eliminations = [];
    this.lastDamageTime = -999;
  }
}

function notifyAi(ai: unknown, eventName: string): void {
  const maybe = ai as { onEvent?: (name: string) => void };
  if (maybe && typeof maybe.onEvent === 'function') maybe.onEvent(eventName);
}

/** Utility: damage falloff multiplier for a distance. */
export function falloffMultiplier(stats: ReturnType<typeof effectiveStats>, distance: number): number {
  const { def } = stats;
  if (distance <= def.falloffStart) return 1;
  if (distance >= def.falloffEnd) return def.falloffMin;
  const t = (distance - def.falloffStart) / (def.falloffEnd - def.falloffStart);
  return 1 + (def.falloffMin - 1) * t;
}

export function isRarePlus(r: Rarity): boolean {
  return r === 'RARE' || r === 'EPIC' || r === 'LEGENDARY';
}
