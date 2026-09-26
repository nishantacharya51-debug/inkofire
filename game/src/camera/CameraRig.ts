import * as THREE from 'three';
import type { Actor } from '../entity/Actor';
import type { CombatWorld } from '../modes/CombatWorld';
import { settings } from '../core/Settings';
import { bus } from '../core/EventBus';
import { clamp, damp } from '../utils/mathx';

/**
 * Third-person / first-person camera with shoulder offset, ADS zoom, weapon
 * recoil kick, explosion shake and wall-avoidance (so the camera never ends up
 * inside a building).
 */

const TPS_DISTANCE = 3.4;
const TPS_ADS_DISTANCE = 1.35;
const FPS_OFFSET = 0.16;

export class CameraRig {
  shake = 0;
  private shakeTime = 0;
  private distance = TPS_DISTANCE;
  private appliedDistance = TPS_DISTANCE;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private world: CombatWorld
  ) {
    this.bind();
  }

  private bind(): void {
    bus.on('actor:damaged', (e) => {
      if (!e.isLocal) return;
      this.shake = Math.min(1.2, this.shake + 0.35 * Math.min(1, e.amount / 22));
      this.shakeTime = 0.35;
    });
    bus.on('shot:fired', (e) => {
      if (!e.isLocal) return;
      this.recoilPitch += 0.012;
      this.recoilYaw += (Math.random() - 0.5) * 0.01;
    });
    bus.on('hitmarker', () => {
      this.shake = Math.min(1.1, this.shake + 0.05);
    });
  }

  /** Explosion / vehicle impacts push the camera. */
  addShake(amount: number): void {
    this.shake = Math.min(1.5, this.shake + amount);
    this.shakeTime = 0.4;
  }

  /** Orbiting spectator camera: follows the target, or flies free without one. */
  updateSpectator(dt: number, target: Actor | null, yaw: number, pitch: number, move: { x: number; y: number }): void {
    this.camera.rotation.set(pitch, yaw, 0, 'YXZ');
    if (target) {
      const eye = target.eyePosition.clone();
      const dist = 4.6;
      const desired = this.tmp.set(
        eye.x + Math.sin(yaw) * dist * Math.cos(pitch),
        eye.y - Math.sin(pitch) * dist + 0.35,
        eye.z + Math.cos(yaw) * dist * Math.cos(pitch)
      );
      this.camera.position.lerp(desired, 1 - Math.exp(-9 * dt));
    } else {
      const speed = 14;
      this.camera.getWorldDirection(this.tmp2);
      this.camera.position.addScaledVector(this.tmp2, move.y * speed * dt);
      this.tmp.set(-Math.cos(yaw), 0, Math.sin(yaw));
      this.camera.position.addScaledVector(this.tmp, move.x * speed * dt);
      this.camera.position.y = Math.max(this.camera.position.y, -18);
    }
    this.applyShake(dt);
  }

  update(dt: number, actor: Actor | null, yaw: number, pitch: number): void {
    if (!actor) return;
    const inVehicle = actor.vehicleId !== null;
    const firstPerson = settings.data.firstPerson || inVehicle;
    const ads = clamp(actor.adsProgress, 0, 1);
    const eye = actor.eyePosition.clone();

    if (firstPerson) {
      this.camera.position.set(eye.x, eye.y + 0.06, eye.z);
      const vehicleBob = inVehicle ? Math.sin(performance.now() * 0.008) * 0.012 : 0;
      this.camera.position.y += vehicleBob;
    } else {
      const target = ads > 0.02 ? TPS_ADS_DISTANCE : TPS_DISTANCE;
      this.distance = damp(this.distance, target, 9, dt);
      const shoulder = 0.55 * (1 - ads * 0.5);
      const back = this.tmp2.set(
        Math.sin(yaw) * this.distance + Math.cos(yaw) * shoulder,
        Math.sin(-pitch * 0.55) * this.distance * 0.32 + 0.25,
        Math.cos(yaw) * this.distance - Math.sin(yaw) * shoulder
      );
      // Wall avoidance
      let allowed = 1;
      const hit = this.world.collision.raycast(eye.x, eye.y, eye.z, back.x / this.distance, back.y / this.distance, back.z / this.distance, this.distance + 0.4);
      if (hit) allowed = clamp((hit.dist - 0.32) / this.distance, 0.25, 1);
      this.appliedDistance = damp(this.appliedDistance, this.distance * allowed, 16, dt);
      const scale = this.appliedDistance / this.distance;
      this.camera.position.set(
        eye.x + back.x * scale,
        Math.max(eye.y + back.y * scale, actor.position.y + 0.45),
        eye.z + back.z * scale
      );
    }

    this.recoilPitch = damp(this.recoilPitch, 0, 9, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, 9, dt);

    const aimPitchOffset = actor.aimPitchOffset * 0.55;
    const aimYawOffset = actor.aimYawOffset * 0.55;
    this.camera.rotation.set(
      clamp(pitch + this.recoilPitch + aimPitchOffset, -1.52, 1.52),
      yaw + this.recoilYaw + aimYawOffset,
      this.rollForStance(actor),
      'YXZ'
    );

    // FOV: slight sprint widen, ADS zoom.
    const baseFov = settings.data.fov;
    const sprintFov = actor.sprintBlocked > 0 || actor.speed > 6.6 ? 4 : 0;
    const targetFov = (baseFov + sprintFov) * (1 - ads * 0.28);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = damp(this.camera.fov, targetFov, 12, dt);
      this.camera.updateProjectionMatrix();
    }

    this.applyShake(dt);
    void FPS_OFFSET;
  }

  private rollForStance(actor: Actor): number {
    if (actor.stance === 'PRONE') return 0.12;
    if (actor.stance === 'CROUCH') return 0.03;
    return 0;
  }

  private applyShake(dt: number): void {
    if (this.shake <= 0.001) return;
    this.shakeTime = Math.max(0, this.shakeTime - dt);
    const power = this.shake * (this.shakeTime > 0 ? 1 : 0.25);
    this.camera.position.x += (Math.random() - 0.5) * 0.06 * power;
    this.camera.position.y += (Math.random() - 0.5) * 0.06 * power;
    this.camera.rotation.z += (Math.random() - 0.5) * 0.03 * power;
    this.shake = Math.max(0, this.shake - dt * 2.4);
    if (this.shakeTime <= 0 && this.shake < 0.02) this.shake = 0;
  }
}
