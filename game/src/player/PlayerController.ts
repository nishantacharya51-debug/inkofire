import * as THREE from 'three';
import type { CombatWorld } from '../modes/CombatWorld';
import type { Actor } from '../entity/Actor';
import type { ControllerInput } from './Locomotion';
import { Input } from '../core/Input';
import { settings } from '../core/Settings';
import { bus } from '../core/EventBus';
import { clamp } from '../utils/mathx';
import { displayName } from '../loot/LootSystem';
import { CONSUMABLES } from '../items/Items';

/**
 * Translates raw input into the shared `ControllerInput` contract and drives
 * every local-player-only interaction (looting, doors, vehicles, revives,
 * inventory actions, spectating).
 *
 * The simulation never reads this class directly: it only ever sees the
 * ControllerInput object it produces, exactly like a bot brain does.
 */

const PITCH_LIMIT = 1.48;

function vehicleDistance(vehicle: { x: number; y: number; z: number }, actor: Actor): number {
  return Math.hypot(vehicle.x - actor.position.x, vehicle.y - actor.position.y, vehicle.z - actor.position.z);
}
const INTERACT_RANGE = 2.8;

export interface ControllerCallbacks {
  onToggleInventory: () => void;
  onToggleMap: () => void;
  onScoreboard: (visible: boolean) => void;
  onSpectate: (dir: number) => void;
}

export class PlayerController {
  yaw = 0;
  pitch = 0;
  /** Set while the player is spectating after death. */
  spectateIndex = 0;
  /** True while the scoreboard overlay is held open. */
  private scoreboardVisible = false;
  spectating = false;

  private wantsJump = false;
  private crouchHeld = false;
  private proneHeld = false;

  readonly input: ControllerInput = {
    moveX: 0, moveY: 0, lookYaw: 0, lookPitch: 0,
    jump: false, crouch: false, prone: false, sprint: false, walkSlow: false
  };

  constructor(
    private input0: Input,
    private world: CombatWorld,
    private callbacks: ControllerCallbacks,
    private isUiBlocking: () => boolean = () => false
  ) {}

  get actor(): Actor | null {
    return this.world.localPlayer;
  }

  /** Resets view angles for a fresh match. */
  reset(actor: Actor | null): void {
    this.yaw = actor ? actor.yaw : 0;
    this.pitch = 0;
    this.spectating = false;
    this.spectateIndex = 0;
  }

  /** Applies mouse/touch look deltas. Called once per rendered frame. */
  updateLook(): void {
    const sens = settings.data.sensitivity * (this.world.localWantsAds ? settings.data.adsSensitivity : 1);
    this.yaw -= this.input0.mouseDX * sens;
    this.pitch -= this.input0.mouseDY * sens;
    this.pitch = clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** Produces the ControllerInput for this fixed step and handles actions. */
  step(dt: number): void {
    const input = this.input;
    const actor = this.actor;
    const uiBlocking = this.isUiBlocking();

    if (!actor || actor.lifeState === 'DEAD') {
      this.spectating = true;
      input.moveX = 0;
      input.moveY = 0;
      input.jump = false;
      input.sprint = false;
      input.crouch = false;
      input.prone = false;
      this.world.setPlayerInput(input);
      this.world.localWantsFire = false;
      this.world.localTriggerHeld = false;
      this.handleUiKeys();
      if (!uiBlocking) this.handleSpectateInput();
      return;
    }

    const axes = uiBlocking ? { x: 0, y: 0 } : this.input0.moveAxes();
    input.moveX = axes.x;
    input.moveY = -axes.y; // screen-up is forward
    input.lookYaw = this.yaw;
    input.lookPitch = this.pitch;
    input.sprint = !uiBlocking && this.input0.isDown('sprint') && input.moveY > 0.1;
    input.crouch = this.crouchHeld;
    input.prone = this.proneHeld;
    input.walkSlow = this.input0.isDown('crouch') && false;

    if (this.wantsJump && actor.onGround && actor.stance === 'STAND') {
      input.jump = true;
    } else {
      input.jump = false;
    }
    this.wantsJump = false;

    // Aiming / firing intent (consumed by CombatWorld each step).
    const ads = !uiBlocking && (this.input0.aimDown() || (settings.data.firstPerson && this.input0.aimDown()));
    this.world.localWantsAds = ads;
    this.world.localTriggerHeld = !uiBlocking && this.input0.fireDown();
    this.world.localWantsFire = !uiBlocking && this.input0.firePressed();

    this.world.setPlayerInput(input);

    // Crouch / prone toggles
    if (this.input0.wasPressed('crouch')) this.crouchHeld = !this.crouchHeld;
    if (this.input0.wasPressed('prone')) {
      this.proneHeld = !this.proneHeld;
      if (this.proneHeld) this.crouchHeld = false;
    }
    if (input.sprint) this.crouchHeld = false;

    // Overlay keys must work even while an overlay is open, otherwise the
    // inventory could be opened and never closed again.
    this.handleUiKeys();
    if (!uiBlocking) this.handleActions(actor, dt);
    void dt;
  }

  /** Inventory / map / scoreboard keys — always processed, overlay or not. */
  private handleUiKeys(): void {
    const i = this.input0;
    if (i.wasPressed('inventory')) this.callbacks.onToggleInventory();
    if (i.wasPressed('map')) this.callbacks.onToggleMap();
    if (i.wasPressed('scoreboard')) {
      this.scoreboardVisible = true;
      this.callbacks.onScoreboard(true);
    } else if (this.scoreboardVisible && !i.isDown('scoreboard')) {
      this.scoreboardVisible = false;
      this.callbacks.onScoreboard(false);
    }
  }

  private handleActions(actor: Actor, _dt: number): void {
    const i = this.input0;
    const world = this.world;

    if (i.wasPressed('slot1')) world.weapons.switchTo(actor, 0);
    if (i.wasPressed('slot2')) world.weapons.switchTo(actor, 1);
    if (i.wasPressed('slot3')) world.weapons.switchTo(actor, 2);
    if (i.wasPressed('slot4')) world.weapons.switchTo(actor, 3);
    if (i.wheel !== 0) actor.inventory.cycleSlot(Math.sign(i.wheel));

    if (i.wasPressed('reload')) actor.reloadRequest = true;
    if (i.wasPressed('fireMode')) {
      const mode = world.weapons.cycleFireMode(actor);
      if (mode) bus.emit('ui:toast', { text: `Fire mode: ${mode}`, kind: 'info' });
    }
    if (i.wasPressed('jump')) this.wantsJump = true;

    // Interact: vehicles first, then loot, then revives.
    if (i.wasPressed('interact')) this.interact(actor);

    // Healing: best available item first (medkit > stimpack > bandage > plate).
    if (i.wasPressed('heal')) {
      const order = ['medkit', 'stimpack', 'bandage', 'plate', 'battery'];
      const hurt = actor.health < actor.maxHealth;
      let used = false;
      for (const item of order) {
        const stack = actor.inventory.consumables.find((c) => c.itemId === item && c.count > 0);
        if (!stack) continue;
        const isHeal = (CONSUMABLES[item]?.healAmount ?? 0) > 0;
        if (isHeal && !hurt && actor.inventory.armorPoints >= actor.inventory.maxArmorPoints) continue;
        if (world.beginConsumable(actor, item)) { used = true; break; }
      }
      if (!used) bus.emit('ui:toast', { text: hurt ? 'No healing items' : 'Nothing to use', kind: 'warn' });
    }

    // Grenades: throw toward the aim point (collision-aware, capped distance).
    if (i.wasPressed('grenade')) {
      const kinds = ['frag', 'smoke', 'flash'];
      for (const kind of kinds) {
        const stack = actor.inventory.throwables.find((t) => t.itemId === kind && t.count > 0);
        if (!stack) continue;
        const dir = actor.getAimDirection(new THREE.Vector3());
        const throwPoint = this.findThrowPoint(actor, dir);
        actor.throwRequest = { itemId: kind, x: throwPoint.x, y: throwPoint.y, z: throwPoint.z };
        bus.emit('ui:toast', { text: `Throwing ${kind}`, kind: 'info' });
        break;
      }
    }

    if (i.wasPressed('reload') && actor.inventory.active && actor.inventory.active.ammoInMag === 0) {
      actor.reloadRequest = true;
    }

    // Hold-to-revive: press F near a downed teammate.
    if (i.isDown('interact')) {
      const downed = this.nearestDownedTeammate(actor);
      if (downed) actor.reviveRequest = downed.id;
    }

    // Exit vehicle
    if (actor.vehicleId !== null && i.wasPressed('vehicle')) {
      const vehicle = this.world.vehicles.byId(actor.vehicleId);
      if (vehicle) this.world.vehicles.exit(actor, true);
    }
  }

  /** Aim point used by grenade throws: first world hit, or 30 m along the aim. */
  private findThrowPoint(actor: Actor, dir: THREE.Vector3): { x: number; y: number; z: number } {
    const origin = actor.eyePosition.clone();
    const maxDist = 34;
    const hit = this.world.collision.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist);
    const dist = hit ? Math.max(2, hit.dist - 0.4) : maxDist;
    return {
      x: origin.x + dir.x * dist,
      y: origin.y + dir.y * dist,
      z: origin.z + dir.z * dist
    };
  }

  private nearestDownedTeammate(actor: Actor): Actor | null {
    let best: Actor | null = null;
    let bestDist = 2.6;
    for (const other of this.world.actors) {
      if (other.id === actor.id) continue;
      if (other.team !== actor.team) continue;
      if (other.lifeState !== 'DOWNED') continue;
      const d = other.distanceTo(actor.position.x, actor.position.y, actor.position.z);
      if (d < bestDist) {
        bestDist = d;
        best = other;
      }
    }
    return best;
  }

  /** The single interact button: vehicle, then loot, then revive prompt. */
  private interact(actor: Actor): void {
    const world = this.world;
    if (actor.vehicleId !== null) {
      const vehicle = world.vehicles.byId(actor.vehicleId);
      if (vehicle) world.vehicles.exit(actor, true);
      return;
    }
    // Teammates first — saving a life beats looting.
    const buddy = this.nearestDownedTeammate(actor);
    if (buddy) {
      actor.reviveRequest = buddy.id;
      return;
    }
    const vehicle = world.vehicles.nearestEnterable(actor);
    if (vehicle && vehicleDistance(vehicle, actor) < 4.5) {
      world.vehicles.enter(actor, vehicle);
      return;
    }
    const item = world.loot.nearest(actor.position.x, actor.position.y + 0.6, actor.position.z, INTERACT_RANGE);
    if (item) {
      world.loot.claim(actor, item.id);
      bus.emit('ui:toast', { text: `Picked up ${displayName(item.itemId)}`, kind: 'good' });
      return;
    }
    bus.emit('ui:toast', { text: 'Nothing to pick up', kind: 'warn' });
  }

  private handleSpectateInput(): void {
    const i = this.input0;
    if (i.wasPressed('interact') || i.mousePressed.has(0) || i.wasPressed('jump')) {
      this.callbacks.onSpectate(1);
    }
    if (i.keyPressed('KeyQ')) this.callbacks.onSpectate(-1);
    const axes = i.moveAxes();
    if (Math.abs(axes.x) > 0.5 || Math.abs(axes.y) > 0.5) {
      // let the free-cam in the camera rig use the axes
    }
  }

  /**
   * The prompt shown above the crosshair ("Pick up …", "Enter …", "Revive …").
   */
  promptText(): string | null {
    const actor = this.actor;
    if (!actor || actor.lifeState === 'DEAD') return null;
    if (actor.vehicleId !== null) return 'Exit vehicle  [F]';
    const waypoint = this.nearestDownedTeammate(actor);
    if (waypoint) return `Revive ${waypoint.name}  [hold F]`;
    const vehicle = this.world.vehicles.nearestEnterable(actor);
    if (vehicle && vehicleDistance(vehicle, actor) < 4.5) return 'Enter vehicle  [F]';
    const item = this.world.loot.nearest(actor.position.x, actor.position.y + 0.6, actor.position.z, INTERACT_RANGE);
    if (item) return `Pick up ${displayName(item.itemId)}  [F]`;
    if (actor.lifeState === 'DOWNED') return 'Waiting for a revive…';
    return null;
  }

  /** Nearest usable consumable, used to enable/disable the HUD heal button. */
  hasHeal(): boolean {
    const actor = this.actor;
    if (!actor) return false;
    return actor.inventory.consumables.some((c) => c.count > 0 && (CONSUMABLES[c.itemId]?.healAmount ?? 0) > 0);
  }
}
