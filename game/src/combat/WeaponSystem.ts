import * as THREE from 'three';
import { type Actor } from '../entity/Actor';
import { effectiveStats, type WeaponInstance } from '../inventory/Inventory';
import { RARITY_DAMAGE_BONUS } from '../items/Items';
import { bus } from '../core/EventBus';
import { clamp } from '../utils/mathx';

/**
 * Weapon handling: firing, reloading, recoil, spread and fire-mode logic.
 * Bullet simulation lives in Ballistics; this module only decides *when* and
 * *where* a projectile leaves the barrel.
 */

export interface ShotSpawn {
  originX: number; originY: number; originZ: number;
  dirX: number; dirY: number; dirZ: number;
  damage: number;
  speed: number;
  weaponId: string;
  rarity: string;
  range: number;
  falloffStart: number;
  falloffEnd: number;
  falloffMin: number;
  ownerId: number;
  team: number;
  suppressed: boolean;
  isLocal: boolean;
}

export interface WeaponSystemHooks {
  spawnProjectile(shot: ShotSpawn): void;
  playSound(actor: Actor, weaponId: string, suppressed: boolean, isLocal: boolean, position: THREE.Vector3): void;
  muzzleFlash(actor: Actor, origin: THREE.Vector3, dir: THREE.Vector3, weaponId: string): void;
  ejectShell(actor: Actor): void;
  onDryFire(actor: Actor): void;
  /** Extra spread the environment adds (e.g. moving vehicle platform). */
  extraSpread?(actor: Actor): number;
}

const tmpDir = new THREE.Vector3();
const tmpOrigin = new THREE.Vector3();

export class WeaponSystem {
  time = 0;

  constructor(private hooks: WeaponSystemHooks) {}

  /** Per-frame weapon update: cooldowns, reloads, recoil recovery, ADS. */
  update(actor: Actor, dt: number, wantsAds: boolean, wantsFire: boolean, triggerHeld: boolean): void {
    this.time += dt;
    const inv = actor.inventory;
    const weapon = inv.active;

    actor.fireCooldown = Math.max(0, actor.fireCooldown - dt);
    actor.switchTimer = Math.max(0, actor.switchTimer - dt);
    actor.burstCooldown = Math.max(0, actor.burstCooldown - dt);
    actor.muzzleTimer = Math.max(0, actor.muzzleTimer - dt);

    // Recoil recovery (spring back toward centre)
    const recovery = weapon ? effectiveStats(weapon).recoilRecovery : 6;
    actor.recoilPitchVel *= Math.exp(-recovery * dt);
    actor.recoilYawVel *= Math.exp(-recovery * dt);
    const returnRate = 1 - Math.exp(-recovery * 0.85 * dt);
    actor.aimPitchOffset += actor.recoilPitchVel * dt;
    actor.aimYawOffset += actor.recoilYawVel * dt;
    actor.aimPitchOffset -= actor.aimPitchOffset * returnRate * 0.65;
    actor.aimYawOffset -= actor.aimYawOffset * returnRate * 0.9;

    // Spread bloom recovery
    const stats = weapon ? effectiveStats(weapon) : null;
    if (stats) {
      actor.spreadBloom = Math.max(0, actor.spreadBloom - stats.def.spreadRecover * dt * 0.55);
    } else {
      actor.spreadBloom = Math.max(0, actor.spreadBloom - 6 * dt);
    }

    // ADS blending
    const canAds = !!weapon && stats!.def.cls !== 'MELEE';
    const target = wantsAds && canAds && actor.reloadTimer <= 0 ? 1 : 0;
    const adsTime = stats ? Math.max(0.08, stats.adsTime) : 0.2;
    const rate = target > actor.adsProgress ? dt / adsTime : dt / (adsTime * 1.4);
    actor.adsProgress = clamp(actor.adsProgress + (target - actor.adsProgress > 0 ? rate : -rate), 0, 1);
    if (target === 0 && actor.adsProgress < 0) actor.adsProgress = 0;

    // Reload
    if (actor.reloadTimer > 0) {
      actor.reloadTimer -= dt;
      if (actor.reloadTimer <= 0) this.finishReload(actor);
    }

    if (!weapon) {
      actor.moveState = actor.moveState;
      return;
    }

    // Fire-mode / trigger handling
    if (actor.reloadTimer > 0 || actor.switchTimer > 0) return;
    const def = stats!.def;

    const mode = def.fireModes[clamp(weapon.fireModeIndex, 0, def.fireModes.length - 1)];
    const wantsToShoot = mode === 'AUTO' ? triggerHeld : wantsFire;

    if (actor.burstRemaining > 0) {
      if (actor.fireCooldown <= 0 && actor.burstCooldown <= 0) {
        this.fireOnce(actor);
        actor.burstRemaining--;
        if (actor.burstRemaining <= 0) actor.burstCooldown = 0.24;
      }
      return;
    }

    if (wantsToShoot && actor.fireCooldown <= 0) {
      if (weapon.ammoInMag <= 0) {
        this.hooks.onDryFire(actor);
        actor.fireCooldown = 0.32;
        if (actor.isLocal) bus.emit('ammo:empty', {});
        this.tryAutoReload(actor);
      } else if (mode === 'BURST') {
        actor.burstRemaining = def.burstCount ?? 3;
      } else {
        this.fireOnce(actor);
      }
    }
  }

  private tryAutoReload(actor: Actor): void {
    const weapon = actor.inventory.active;
    if (!weapon) return;
    const def = effectiveStats(weapon).def;
    if (actor.inventory.ammo[def.ammo] > 0) this.beginReload(actor);
  }

  /** Fires one projectile (or one shotgun shell pattern). */
  private fireOnce(actor: Actor): void {
    const weapon = actor.inventory.active;
    if (!weapon) return;
    const stats = effectiveStats(weapon);
    const def = stats.def;

    if (weapon.ammoInMag <= 0) {
      this.hooks.onDryFire(actor);
      return;
    }
    weapon.ammoInMag--;
    weapon.heat = Math.min(1, weapon.heat + 0.05);
    actor.heat = weapon.heat;
    actor.shotsFired++;
    actor.lastShotTime = this.time;
    actor.fireCooldown = 60 / def.rpm;
    actor.muzzleTimer = 0.055;

    // Aim direction from actor orientation + recoil offset
    actor.getAimDirection(tmpDir);

    // Spread (deg → rad), reduced while ADS
    const spreadDeg = actor.currentSpread() + (this.hooks.extraSpread?.(actor) ?? 0);
    const spreadRad = (spreadDeg * Math.PI) / 180;

    // Origin at the muzzle, offset forward/right from the eye
    const eye = actor.eyePosition;
    const right = tmpOrigin.set(Math.cos(actor.yaw), 0, -Math.sin(actor.yaw));
    tmpOrigin.set(
      eye.x + tmpDir.x * 0.42 + right.x * 0.16,
      eye.y + tmpDir.y * 0.42 - 0.06,
      eye.z + tmpDir.z * 0.42 + right.z * 0.16
    );

    const rarityBonus = 1 + RARITY_DAMAGE_BONUS[weapon.rarity];
    const pelletCount = def.pellets;

    for (let i = 0; i < pelletCount; i++) {
      let dx = tmpDir.x;
      let dy = tmpDir.y;
      let dz = tmpDir.z;
      if (spreadRad > 0) {
        // Random offset inside the spread cone, using a stable basis.
        const theta = Math.random() * Math.PI * 2;
        const mag = Math.sqrt(Math.random()) * Math.tan(spreadRad);
        // right = normalize(cross(dir, up)), up' = cross(right, dir)
        let rx = dz * 1 - 0 * dy;
        let ry = 0 * dx - dx * 0;
        let rz = 0 * dy - dz * 0;
        rx = dz;
        ry = 0;
        rz = -dx;
        const rl = Math.hypot(rx, ry, rz) || 1;
        rx /= rl; ry /= rl; rz /= rl;
        const ux = ry * dz - rz * dy;
        const uy = rz * dx - rx * dz;
        const uz = rx * dy - ry * dx;
        const c = Math.cos(theta) * mag;
        const sn = Math.sin(theta) * mag;
        dx += rx * c + ux * sn;
        dy += ry * c + uy * sn;
        dz += rz * c + uz * sn;
        const l = Math.hypot(dx, dy, dz) || 1;
        dx /= l; dy /= l; dz /= l;
      }
      this.hooks.spawnProjectile({
        originX: tmpOrigin.x,
        originY: tmpOrigin.y,
        originZ: tmpOrigin.z,
        dirX: dx, dirY: dy, dirZ: dz,
        damage: stats.damage * rarityBonus,
        speed: stats.bulletSpeed,
        weaponId: def.id,
        rarity: weapon.rarity,
        range: def.falloffEnd * 1.6,
        falloffStart: def.falloffStart,
        falloffEnd: def.falloffEnd,
        falloffMin: def.falloffMin,
        ownerId: actor.id,
        team: actor.team,
        suppressed: stats.suppressed,
        isLocal: actor.isLocal
      });
    }

    // Recoil kick
    const recoilScale = 1 - actor.adsProgress * 0.28;
    const stanceScale = actor.stance === 'CROUCH' ? 0.86 : actor.moveState === 'PRONE' ? 0.6 : 1;
    const moving = 1 + Math.min(1, actor.speed / 6) * 0.35;
    actor.recoilPitchVel += stats.recoilVertical * recoilScale * stanceScale * moving * (Math.PI / 180) * 9;
    actor.recoilYawVel += (Math.random() - 0.5) * 2 * stats.recoilHorizontal * recoilScale * moving * (Math.PI / 180) * 9;
    actor.spreadBloom += stats.spreadPerShot;

    this.hooks.muzzleFlash(actor, tmpOrigin, tmpDir, def.id);
    this.hooks.ejectShell(actor);
    this.hooks.playSound(actor, def.id, stats.suppressed, actor.isLocal, tmpOrigin);

    bus.emit('shot:fired', {
      actorId: actor.id,
      weaponId: def.id,
      isLocal: actor.isLocal,
      position: [tmpOrigin.x, tmpOrigin.y, tmpOrigin.z],
      suppressed: stats.suppressed
    });

    if (actor.isLocal) {
      // Keep the camera kick readable even at high RPM.
      actor.recoilPitchVel = Math.min(actor.recoilPitchVel, 0.55);
      actor.recoilYawVel = clamp(actor.recoilYawVel, -0.4, 0.4);
    }

    // Auto-reload when the mag runs dry
    if (weapon.ammoInMag <= 0 && actor.isLocal) {
      bus.emit('ammo:empty', {});
    }
  }

  beginReload(actor: Actor): boolean {
    const weapon = actor.inventory.active;
    if (!weapon || actor.reloadTimer > 0) return false;
    const stats = effectiveStats(weapon);
    const def = stats.def;
    if (def.melee) return false;
    if (weapon.ammoInMag >= stats.magSize) return false;
    const reserve = actor.inventory.ammo[def.ammo];
    if (reserve <= 0) return false;
    actor.reloadTimer = weapon.ammoInMag > 0 ? stats.reloadTime : stats.reloadTime * 1.15;
    actor.reloadDuration = actor.reloadTimer;
    actor.moveState = 'RELOAD';
    return true;
  }

  cancelReload(actor: Actor): void {
    if (actor.reloadTimer > 0) {
      actor.reloadTimer = 0;
      actor.reloadDuration = 0;
    }
  }

  private finishReload(actor: Actor): void {
    const weapon = actor.inventory.active;
    actor.reloadTimer = 0;
    if (!weapon) return;
    const stats = effectiveStats(weapon);
    const def = stats.def;
    const need = stats.magSize - weapon.ammoInMag;
    const taken = actor.inventory.takeAmmo(def.ammo, need);
    weapon.ammoInMag += taken;
    bus.emit('weapon:reloaded', { actorId: actor.id, weaponId: def.id });
    bus.emit('inventory:changed', {});
  }

  cycleFireMode(actor: Actor): string | null {
    const weapon = actor.inventory.active;
    if (!weapon) return null;
    const def = effectiveStats(weapon).def;
    if (def.fireModes.length <= 1) return def.fireModes[0];
    weapon.fireModeIndex = (weapon.fireModeIndex + 1) % def.fireModes.length;
    return def.fireModes[weapon.fireModeIndex];
  }

  switchTo(actor: Actor, slot: number): boolean {
    const inv = actor.inventory;
    if (slot < 0 || slot > 2) return false;
    if (!inv.weapons[slot] || inv.activeSlot === slot) return false;
    this.cancelReload(actor);
    inv.setActiveSlot(slot);
    const w = inv.weapons[slot] as WeaponInstance;
    actor.switchTimer = effectiveStats(w).def.switchTime;
    actor.adsProgress = 0;
    bus.emit('weapon:changed', { slot, weaponId: w.defId });
    return true;
  }
}
