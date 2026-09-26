import { bus } from '../core/EventBus';
import { RNG } from '../utils/rng';

export interface ZonePhase {
  /** Seconds before the circle starts closing. */
  waitTime: number;
  /** Seconds the circle takes to close. */
  shrinkTime: number;
  /** Radius multiplier applied to the current circle. */
  radiusFactor: number;
  /** Damage per second outside the circle. */
  damagePerSecond: number;
  /** How far the next centre can drift toward the current circle edge (0..1). */
  drift: number;
}

/** Original 7-phase ring plan tuned for ~8 minute matches. */
export const BR_ZONE_PHASES: ZonePhase[] = [
  { waitTime: 70, shrinkTime: 42, radiusFactor: 0.65, damagePerSecond: 0.7, drift: 0.55 },
  { waitTime: 48, shrinkTime: 36, radiusFactor: 0.62, damagePerSecond: 1.1, drift: 0.5 },
  { waitTime: 42, shrinkTime: 32, radiusFactor: 0.58, damagePerSecond: 1.6, drift: 0.45 },
  { waitTime: 36, shrinkTime: 28, radiusFactor: 0.55, damagePerSecond: 2.3, drift: 0.42 },
  { waitTime: 32, shrinkTime: 24, radiusFactor: 0.5, damagePerSecond: 3.2, drift: 0.4 },
  { waitTime: 30, shrinkTime: 22, radiusFactor: 0.45, damagePerSecond: 4.5, drift: 0.35 },
  { waitTime: 30, shrinkTime: 20, radiusFactor: 0.32, damagePerSecond: 6.5, drift: 0.3 }
];

export class ZoneSystem {
  x = 0;
  z = 0;
  radius = 800;
  nextX = 0;
  nextZ = 0;
  nextRadius = 800;
  phase = 0;
  shrinking = false;
  timeLeft = 0;
  private phaseTimer = 0;
  private damageAccumulator = 0;
  finished = false;
  private lastWarning = -1;

  constructor(private size: number, private rng: RNG, private phases: ZonePhase[] = BR_ZONE_PHASES) {
    this.reset();
  }

  reset(): void {
    this.phase = 0;
    this.finished = false;
    this.shrinking = false;
    this.lastWarning = -1;
    // Start centred on the island with a generous first circle.
    const spread = this.size * 0.11;
    this.x = (this.rng.next() - 0.5) * spread;
    this.z = (this.rng.next() - 0.5) * spread;
    this.radius = this.size * 0.44;
    this.nextX = this.x;
    this.nextZ = this.z;
    this.nextRadius = this.radius;
    this.planNext();
  }

  private planNext(): void {
    if (this.phase >= this.phases.length) {
      this.finished = true;
      this.nextX = this.x;
      this.nextZ = this.z;
      this.nextRadius = Math.max(18, this.radius * 0.3);
      return;
    }
    const p = this.phases[this.phase];
    this.nextRadius = Math.max(16, this.radius * p.radiusFactor);
    // Drift the next centre inside the current circle.
    const maxDrift = (this.radius - this.nextRadius) * p.drift;
    const ang = this.rng.next() * Math.PI * 2;
    const dist = this.rng.next() * maxDrift;
    this.nextX = this.x + Math.cos(ang) * dist;
    this.nextZ = this.z + Math.sin(ang) * dist;
    this.phaseTimer = p.waitTime;
    this.timeLeft = p.waitTime;
    this.shrinking = false;
    bus.emit('zone:phase', {
      phase: this.phase + 1,
      x: this.nextX,
      z: this.nextZ,
      radius: this.nextRadius,
      waitTime: p.waitTime
    });
  }

  update(
    dt: number,
    actors: {
      position: { x: number; y: number; z: number };
      applyDamage: (amount: number, part: 'TORSO', attacker: null, weaponId: string, now: number) => unknown;
      isLocal: boolean;
      lifeState: string;
      moveState: string;
    }[],
    now: number
  ): void {
    if (this.finished && !this.shrinking && Math.abs(this.radius - this.nextRadius) < 0.5) {
      // Final circle closed: still apply damage.
    } else {
      this.phaseTimer -= dt;
      this.timeLeft = Math.max(0, this.phaseTimer);
      if (!this.shrinking && this.phaseTimer <= 0) {
        this.shrinking = true;
        const p = this.phases[Math.min(this.phase, this.phases.length - 1)];
        this.phaseTimer = p.shrinkTime;
        this.timeLeft = p.shrinkTime;
        this.startX = this.x;
        this.startZ = this.z;
        this.startRadius = this.radius;
      } else if (this.shrinking && this.phaseTimer <= 0) {
        // Snap and plan the next phase.
        this.x = this.nextX;
        this.z = this.nextZ;
        this.radius = this.nextRadius;
        this.shrinking = false;
        this.phase++;
        if (this.phase >= this.phases.length) {
          this.finished = true;
          this.nextX = this.x;
          this.nextZ = this.z;
          this.nextRadius = this.radius;
        } else {
          this.planNext();
        }
      }
      if (this.shrinking) {
        const p = this.phases[Math.min(this.phase, this.phases.length - 1)];
        const t = 1 - Math.max(0, this.phaseTimer) / p.shrinkTime;
        this.x = this.startX + (this.nextX - this.startX) * t;
        this.z = this.startZ + (this.nextZ - this.startZ) * t;
        this.radius = this.startRadius + (this.nextRadius - this.startRadius) * t;
      }
    }

    // Warning escalation for the local player
    const local = actors.find((a) => a.isLocal);
    if (local) {
      const dist = Math.hypot(local.position.x - this.x, local.position.z - this.z);
      const outside = dist > this.radius;
      const level = outside ? 2 : dist > this.radius * 0.9 ? 1 : 0;
      if (level !== this.lastWarning) {
        this.lastWarning = level;
        bus.emit('zone:warning', { level });
      }
    }

    // Zone damage
    const dps = this.phases[Math.min(this.phase, this.phases.length - 1)].damagePerSecond;
    this.damageAccumulator += dt;
    if (this.damageAccumulator >= 0.5) {
      this.damageAccumulator = 0;
      const tickDamage = dps * 0.5;
      for (const a of actors) {
        if (a.lifeState === 'DEAD') continue;
        // Riders aboard the aircraft are immune until they jump.
        if (a.moveState === 'AIRCRAFT') continue;
        const dist = Math.hypot(a.position.x - this.x, a.position.z - this.z);
        if (dist > this.radius) {
          a.applyDamage(tickDamage, 'TORSO', null, 'zone', now);
        }
      }
    }
  }

  private startX = 0;
  private startZ = 0;
  private startRadius = 0;

  isOutside(x: number, z: number): boolean {
    return Math.hypot(x - this.x, z - this.z) > this.radius;
  }

  distanceToEdge(x: number, z: number): number {
    return this.radius - Math.hypot(x - this.x, z - this.z);
  }

  get phaseLabel(): string {
    if (this.finished) return 'FINAL ZONE';
    return `PHASE ${Math.min(this.phase + 1, this.phases.length)}`;
  }
}
