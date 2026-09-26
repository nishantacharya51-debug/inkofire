import * as THREE from 'three';
import type { CombatWorld } from '../modes/CombatWorld';
import type { Actor } from '../entity/Actor';
import type { ControllerInput } from '../player/Locomotion';
import { bus } from '../core/EventBus';
import { RNG } from '../utils/rng';
import { clamp, wrapAngle } from '../utils/mathx';
import { sampleHeight, sampleSlope } from '../world/Terrain';

export type VehicleType = 'car' | 'bike' | 'buggy';

export interface VehicleSpec {
  type: VehicleType;
  name: string;
  maxSpeed: number;
  acceleration: number;
  brakeForce: number;
  turnRate: number;
  health: number;
  seats: number;
  mass: number;
  seatOffsets: [number, number][];
}

export const VEHICLE_SPECS: Record<VehicleType, VehicleSpec> = {
  car: {
    type: 'car', name: 'Roamer Sedan', maxSpeed: 22.5, acceleration: 8.5, brakeForce: 18,
    turnRate: 1.9, health: 420, seats: 4, mass: 1,
    seatOffsets: [[0, 0], [-0.7, -1.5], [0.7, -1.5], [0, 1.6]]
  },
  bike: {
    type: 'bike', name: 'Dust Runner', maxSpeed: 26.5, acceleration: 11, brakeForce: 20,
    turnRate: 2.5, health: 180, seats: 2, mass: 0.6,
    seatOffsets: [[0, 0], [0, -0.9]]
  },
  buggy: {
    type: 'buggy', name: 'Trail Brute', maxSpeed: 19.5, acceleration: 9.5, brakeForce: 16,
    turnRate: 2.1, health: 520, seats: 4, mass: 1.25,
    seatOffsets: [[0, 0], [-0.75, -1.4], [0.75, -1.4], [0, 1.5]]
  }
};

export interface Vehicle {
  id: number;
  type: VehicleType;
  spec: VehicleSpec;
  x: number; y: number; z: number;
  yaw: number;
  speed: number;
  velocityX: number;
  velocityZ: number;
  health: number;
  maxHealth: number;
  occupants: (Actor | null)[];
  destroyed: boolean;
  destroyedAt: number;
  colorIndex: number;
  /** Wheel steer angle for rendering. */
  steer: number;
  engineLoad: number;
  lastCrashTime: number;
}

export interface VehicleLike {
  id: number;
  type: VehicleType;
  x: number;
  y: number;
  z: number;
}

/**
 * Arcade vehicle physics. Vehicles follow the terrain, collide with the static
 * world (crash damage), run over/against actors, and can be destroyed.
 */
export class VehicleSystem {
  vehicles: Vehicle[] = [];
  private nextId = 1;

  constructor(private world: CombatWorld, private rng: RNG) {}

  spawnFromLayout(): void {
    this.vehicles.length = 0;
    for (const spawn of this.world.layout.vehicleSpawns) {
      const spec = VEHICLE_SPECS[spawn.type];
      this.vehicles.push({
        id: this.nextId++,
        type: spawn.type,
        spec,
        x: spawn.x,
        y: sampleHeight(this.world.terrain, spawn.x, spawn.z) + 0.35,
        z: spawn.z,
        yaw: spawn.rotY,
        speed: 0,
        velocityX: 0,
        velocityZ: 0,
        health: spec.health,
        maxHealth: spec.health,
        occupants: new Array(spec.seats).fill(null),
        destroyed: false,
        destroyedAt: 0,
        colorIndex: this.rng.int(0, 5),
        steer: 0,
        engineLoad: 0,
        lastCrashTime: -99
      });
    }
  }

  get count(): number {
    return this.vehicles.length;
  }

  byId(id: number): Vehicle | null {
    return this.vehicles.find((v) => v.id === id) ?? null;
  }

  nearestEnterable(actor: Actor): Vehicle | null {
    let best: Vehicle | null = null;
    let bestD = 4.2 * 4.2;
    for (const v of this.vehicles) {
      if (v.destroyed) continue;
      if (!v.occupants.some((o) => o === null)) continue;
      const d = (v.x - actor.position.x) ** 2 + (v.z - actor.position.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  enter(actor: Actor, vehicle: Vehicle): boolean {
    if (vehicle.destroyed) return false;
    const seat = vehicle.occupants.findIndex((o) => o === null);
    if (seat < 0) return false;
    vehicle.occupants[seat] = actor;
    actor.vehicleId = vehicle.id;
    actor.moveState = 'DRIVE';
    actor.velocity.set(0, 0, 0);
    if (actor.isLocal) {
      bus.emit('vehicle:entered', { vehicleId: vehicle.id, type: vehicle.type });
      bus.emit('ui:toast', { text: `Entered ${vehicle.spec.name}`, kind: 'info' });
    }
    if (actor.isBot) (actor.ai as { onEvent?: (s: string) => void } | null)?.onEvent?.('vehicle');
    return true;
  }

  exit(actor: Actor, force = false): void {
    if (actor.vehicleId === null) return;
    const vehicle = this.byId(actor.vehicleId);
    actor.vehicleId = null;
    actor.moveState = 'IDLE';
    if (!vehicle) return;
    const seat = vehicle.occupants.indexOf(actor);
    if (seat >= 0) vehicle.occupants[seat] = null;
    // Place the actor beside the vehicle, on the ground.
    const side = seat % 2 === 0 ? 1 : -1;
    const offX = Math.cos(vehicle.yaw) * 2.0 * side;
    const offZ = -Math.sin(vehicle.yaw) * 2.0 * side;
    actor.position.set(
      vehicle.x + offX,
      sampleHeight(this.world.terrain, vehicle.x + offX, vehicle.z + offZ) + 0.1,
      vehicle.z + offZ
    );
    actor.velocity.set(0, 0, 0);
    if (actor.isLocal && !force) bus.emit('vehicle:exited', {});
  }

  get driverOf(): (v: Vehicle) => Actor | null {
    return (v: Vehicle) => v.occupants[0] ?? null;
  }

  /** Input for an actor riding a vehicle (bot driving logic or neutral). */
  controlInputFor(actor: Actor): ControllerInput {
    const neutral: ControllerInput = {
      moveX: 0, moveY: 0, lookYaw: actor.yaw, lookPitch: actor.pitch,
      jump: false, crouch: false, prone: false, sprint: false, walkSlow: false, locked: true
    };
    if (actor.isLocal) return neutral;
    const zone = this.world.zoneSource;
    if (!zone) return neutral;
    // Bots drive toward the safe zone.
    const dx = zone.x - actor.position.x;
    const dz = zone.z - actor.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < zone.radius * 0.5) {
      neutral.moveY = 0;
      return neutral;
    }
    const desiredYaw = Math.atan2(dx, dz);
    const delta = wrapAngle(desiredYaw - actor.yaw);
    neutral.lookYaw = actor.yaw + clamp(delta, -0.05, 0.05);
    neutral.moveX = clamp(-delta * 1.6, -1, 1);
    neutral.moveY = 1;
    neutral.sprint = true;
    return neutral;
  }

  updateOccupiedActor(actor: Actor, _dt: number): void {
    const vehicle = actor.vehicleId !== null ? this.byId(actor.vehicleId) : null;
    if (!vehicle) {
      actor.vehicleId = null;
      return;
    }
    const seat = vehicle.occupants.indexOf(actor);
    const spec = vehicle.spec;
    const [ox, oz] = spec.seatOffsets[Math.max(0, seat)] ?? [0, 0];
    const cos = Math.cos(vehicle.yaw);
    const sin = Math.sin(vehicle.yaw);
    actor.position.x = vehicle.x + ox * cos + oz * sin;
    actor.position.z = vehicle.z - ox * sin + oz * cos;
    actor.position.y = vehicle.y + 0.55;
    actor.yaw = vehicle.yaw;
    actor.moveState = 'DRIVE';
    actor.onGround = true;
    void _dt;
  }

  update(dt: number): void {
    for (const v of this.vehicles) {
      if (v.destroyed) continue;
      const driver = v.occupants[0];
      let throttle = 0;
      let steer = 0;
      let brake = false;

      if (driver) {
        const input = driver.isLocal ? this.playerVehicleInput : this.controlInputFor(driver);
        throttle = clamp(input.moveY, -1, 1);
        steer = clamp(input.moveX, -1, 1);
        brake = input.jump;
      }

      // Longitudinal physics
      const targetSpeed = throttle * v.spec.maxSpeed * (brake ? 0.25 : 1);
      const accel = throttle !== 0 ? v.spec.acceleration : 0;
      if (Math.abs(targetSpeed) > Math.abs(v.speed)) {
        v.speed += Math.sign(targetSpeed) * accel * dt;
      } else {
        const decel = throttle === 0 || brake ? v.spec.brakeForce * 1.4 : v.spec.brakeForce * 0.5;
        if (v.speed > 0) v.speed = Math.max(targetSpeed, v.speed - decel * dt);
        else v.speed = Math.min(targetSpeed, v.speed + decel * dt);
      }
      // Off-road drag on steep terrain
      const slope = sampleSlope(this.world.terrain, v.x, v.z);
      v.speed *= 1 - clamp(slope * 0.28, 0, 0.42) * dt * 2;

      // Steering: scales with speed, inverted when reversing
      const speedFactor = clamp(Math.abs(v.speed) / 8, 0, 1);
      const turn = steer * v.spec.turnRate * speedFactor * dt * Math.sign(v.speed || 1);
      v.yaw = wrapAngle(v.yaw + turn);
      v.steer += (steer - v.steer) * Math.min(1, dt * 8);
      v.engineLoad = Math.abs(throttle);

      // Integrate position
      const forwardX = Math.sin(v.yaw);
      const forwardZ = Math.cos(v.yaw);
      let nx = v.x + forwardX * v.speed * dt;
      let nz = v.z + forwardZ * v.speed * dt;

      // Static collision: sample a point ahead; on hit, crash.
      const probe = 2.0 + Math.abs(v.speed) * 0.08;
      const hit = this.world.collision.raycast(
        v.x, v.y + 0.8, v.z,
        forwardX, 0, forwardZ,
        probe
      );
      if (hit) {
        const impactSpeed = Math.abs(v.speed);
        if (impactSpeed > 5) {
          this.damageVehicle(v, impactSpeed * 4, null);
          for (const occupant of v.occupants) {
            if (!occupant) continue;
            occupant.applyDamage(impactSpeed * 1.1, 'TORSO', null, 'crash', this.world.time);
          }
          this.world.hooks.onVehicleEvent('crash', v.id, driver);
        }
        v.speed = -v.speed * 0.22;
        nx = v.x + forwardX * v.speed * dt * 0.4;
        nz = v.z + forwardZ * v.speed * dt * 0.4;
      }

      // Keep vehicles inside the map
      const half = this.world.terrain.half - 4;
      nx = clamp(nx, -half, half);
      nz = clamp(nz, -half, half);

      v.x = nx;
      v.z = nz;
      const groundY = sampleHeight(this.world.terrain, v.x, v.z);
      // In water, vehicles slow down hard.
      if (groundY < this.world.terrain.waterLevel) {
        v.speed *= 1 - Math.min(0.9, dt * 2.2);
      }
      v.y += (groundY + 0.35 - v.y) * Math.min(1, dt * 9);

      // Run over actors
      for (const actor of this.world.actors) {
        if (actor.lifeState === 'DEAD') continue;
        if (v.occupants.includes(actor)) continue;
        const d = Math.hypot(actor.position.x - v.x, actor.position.z - v.z);
        if (d < 2.1 && Math.abs(v.speed) > 6) {
          const dmg = Math.abs(v.speed) * 3.2;
          actor.applyDamage(dmg, 'LEG', driver, 'vehicle', this.world.time);
          // Knock the actor away from the vehicle
          const kx = (actor.position.x - v.x) / (d || 1);
          const kz = (actor.position.z - v.z) / (d || 1);
          actor.velocity.set(kx * 8, 4, kz * 8);
        }
      }

      // Flip check: terrain too steep at speed
      if (Math.abs(v.speed) > 14 && sampleSlope(this.world.terrain, v.x, v.z) > 0.85) {
        this.damageVehicle(v, 30 * dt * 10, driver);
        v.speed *= 0.92;
      }
    }
  }

  playerVehicleInput: ControllerInput = {
    moveX: 0, moveY: 0, lookYaw: 0, lookPitch: 0,
    jump: false, crouch: false, prone: false, sprint: false, walkSlow: false
  };

  damageVehicle(v: Vehicle, amount: number, source: Actor | null): void {
    if (v.destroyed) return;
    v.health -= amount;
    if (v.health <= 0) {
      v.health = 0;
      this.destroyVehicle(v, source);
    }
  }

  private destroyVehicle(v: Vehicle, source: Actor | null): void {
    v.destroyed = true;
    v.destroyedAt = this.world.time;
    v.speed = 0;
    // Occupants are thrown clear (light damage, no instant death).
    for (let i = 0; i < v.occupants.length; i++) {
      const occupant = v.occupants[i];
      if (!occupant) continue;
      this.exit(occupant, true);
      occupant.applyDamage(24, 'TORSO', source, 'vehicle_explosion', this.world.time);
    }
    // Explosion damage to everyone nearby
    for (const actor of this.world.actors) {
      if (actor.lifeState === 'DEAD') continue;
      const d = Math.hypot(actor.position.x - v.x, actor.position.z - v.z);
      if (d < 7) {
        actor.applyDamage(60 * (1 - d / 7), 'TORSO', source, 'vehicle_explosion', this.world.time);
      }
    }
    this.world.hooks.onVehicleEvent('destroyed', v.id, source);
    this.world.hooks.onExplosion({ x: v.x, y: v.y + 0.6, z: v.z, radius: 8, kind: 'EXPLOSIVE', shooterIsLocal: source?.isLocal ?? false });
    bus.emit('vehicle:destroyed', { vehicleId: v.id });
  }

  /** Bullet damage from the ballistics layer. */
  hitTest(x: number, y: number, z: number, radius: number): Vehicle | null {
    for (const v of this.vehicles) {
      if (v.destroyed) continue;
      const d = Math.hypot(v.x - x, v.z - z);
      if (d < 1.6 + radius && Math.abs(v.y - y) < 1.6) return v;
    }
    return null;
  }

  dispose(): void {
    this.vehicles.length = 0;
  }
}

export function vehicleMarkerColor(v: Vehicle): string {
  const colors = ['#d9534f', '#4a90d9', '#e0c341', '#5cb85c', '#9b59b6', '#e08a3c'];
  return colors[v.colorIndex % colors.length];
}

export type { THREE };
