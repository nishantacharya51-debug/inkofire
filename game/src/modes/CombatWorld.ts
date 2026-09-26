import * as THREE from 'three';
import { Actor } from '../entity/Actor';
import { Ballistics, type ExplosionEvent } from '../combat/Ballistics';
import { WeaponSystem } from '../combat/WeaponSystem';
import { Locomotion, setNoiseCallback, type ControllerInput } from '../player/Locomotion';
import { CollisionWorld } from '../world/Collision';
import { NavGrid } from '../ai/NavGrid';
import { BotBrain, DIFFICULTIES, type BotContext, type NoiseEvent } from '../ai/BotBrain';
import { LootSystem, displayName } from '../loot/LootSystem';
import type { MapLayout } from '../world/MapLayout';
import { sampleHeight, type TerrainData } from '../world/Terrain';
import { CONSUMABLES, THROWABLES, WEAPONS } from '../items/Items';
import { bus } from '../core/EventBus';
import { RNG } from '../utils/rng';
import { clamp } from '../utils/mathx';
import { VehicleSystem } from '../vehicles/VehicleSystem';

/** Callbacks the presentation layer implements (headless tests leave them empty). */
export interface CombatHooks {
  onImpact(x: number, y: number, z: number, nx: number, ny: number, nz: number, surface: string, isLocal: boolean): void;
  onActorHit(actor: Actor, damage: number, part: string, weaponId: string, isLocal: boolean, killed: boolean, headshot: boolean): void;
  onExplosion(ev: ExplosionEvent): void;
  onTracer(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, isLocal: boolean): void;
  onWeaponSound(actor: Actor, weaponId: string, suppressed: boolean, isLocal: boolean, pos: THREE.Vector3): void;
  onMuzzleFlash(actor: Actor, origin: THREE.Vector3, dir: THREE.Vector3, weaponId: string): void;
  onShellEject(actor: Actor): void;
  onDryFire(actor: Actor): void;
  onHealStart(actor: Actor, itemId: string): void;
  onReviveStart(actor: Actor, target: Actor): void;
  onVehicleEvent(kind: 'enter' | 'exit' | 'destroyed' | 'crash', vehicleId: number, actor: Actor | null): void;
}

export function emptyHooks(): CombatHooks {
  return {
    onImpact: () => {},
    onActorHit: () => {},
    onExplosion: () => {},
    onTracer: () => {},
    onWeaponSound: () => {},
    onMuzzleFlash: () => {},
    onShellEject: () => {},
    onDryFire: () => {},
    onHealStart: () => {},
    onReviveStart: () => {},
    onVehicleEvent: () => {}
  };
}

export interface ActorSpawnOptions {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  name?: string;
  team?: number;
  isBot?: boolean;
  isLocal?: boolean;
  difficulty?: keyof typeof DIFFICULTIES;
}

/**
 * Shared simulation container: actors, weapons, ballistics, loot and vehicles.
 * Both Battle Royale and the arena modes build on this, and the headless test
 * harness drives it with no renderer at all.
 */
export class CombatWorld {
  readonly actors: Actor[] = [];
  readonly brains = new Map<number, BotBrain>();
  readonly collision: CollisionWorld;
  readonly nav: NavGrid;
  readonly loot: LootSystem;
  readonly ballistics: Ballistics;
  readonly weapons: WeaponSystem;
  readonly locomotion: Locomotion;
  readonly vehicles: VehicleSystem;
  readonly noises: NoiseEvent[] = [];

  time = 0;
  private nextActorId = 1;
  private rng: RNG;
  private playerInput: ControllerInput | null = null;
  private autoPickupEnabled = true;

  constructor(
    public readonly terrain: TerrainData,
    public readonly layout: MapLayout,
    public readonly hooks: CombatHooks,
    seed = 1234
  ) {
    this.rng = new RNG(seed);
    this.collision = new CollisionWorld(terrain.size);
    this.nav = new NavGrid(terrain, layout);
    this.loot = new LootSystem(this.rng, terrain.size);
    this.locomotion = new Locomotion(this.collision, terrain, terrain.waterLevel);
    this.ballistics = new Ballistics({
      onImpact: (x, y, z, nx, ny, nz, surface, isLocal) => hooks.onImpact(x, y, z, nx, ny, nz, surface, isLocal),
      onActorHit: (a, dmg, part, weaponId, isLocal, killed, headshot) => hooks.onActorHit(a, dmg, part, weaponId, isLocal, killed, headshot),
      onExplosion: (ev) => hooks.onExplosion(ev),
      onTracer: (x0, y0, z0, x1, y1, z1, isLocal) => hooks.onTracer(x0, y0, z0, x1, y1, z1, isLocal)
    });
    this.weapons = new WeaponSystem({
      spawnProjectile: (shot) => this.ballistics.spawn(shot),
      playSound: (actor, weaponId, suppressed, isLocal, position) => hooks.onWeaponSound(actor, weaponId, suppressed, isLocal, position),
      muzzleFlash: (actor, origin, dir, weaponId) => hooks.onMuzzleFlash(actor, origin, dir, weaponId),
      ejectShell: (actor) => hooks.onShellEject(actor),
      onDryFire: (actor) => hooks.onDryFire(actor)
    });
    this.vehicles = new VehicleSystem(this, this.rng);

    setNoiseCallback((actor, radius) => {
      if (radius <= 0) return;
      this.noises.push({ x: actor.position.x, y: actor.position.y, z: actor.position.z, radius, team: actor.team, time: this.time });
    });

    // Populate the world: static collision, ground loot and vehicles.
    this.buildCollision();
    this.loot.spawnFromLayout(layout);
    this.vehicles.spawnFromLayout();
  }

  get localPlayer(): Actor | null {
    return this.actors.find((a) => a.isLocal) ?? null;
  }

  get aliveActors(): Actor[] {
    return this.actors.filter((a) => a.lifeState !== 'DEAD');
  }

  /* ---------------------------------------------------------------- */
  /* World building                                                   */
  /* ---------------------------------------------------------------- */

  private buildCollision(): void {
    const MATERIAL_INDEX: Record<string, number> = {
      concrete: 0, brick: 0, metal: 1, steelDark: 1, rust: 1, wood: 2, crate: 2, tarp: 2, fabric: 2,
      asphalt: 0, sand: 3, grass: 3, rock: 7, roof: 0, glass: 4, foliage: 5,
      paintRed: 0, paintBlue: 0, paintYellow: 0, paintGreen: 0, dark: 0, white: 0,
      container1: 1, container2: 1, container3: 1
    };
    for (const box of this.layout.boxes) {
      if (!box.collide) continue;
      // Axis-aligned boxes only; rotated boxes use their bounding footprint.
      const rot = box.rotY ?? 0;
      const rotX = box.rotX ?? 0;
      let halfW = box.w / 2;
      let halfD = box.d / 2;
      let halfH = box.h / 2;
      if (Math.abs(rot) > 1e-3) {
        const c = Math.abs(Math.cos(rot));
        const s = Math.abs(Math.sin(rot));
        const w = halfW * c + halfD * s;
        const d = halfW * s + halfD * c;
        halfW = w;
        halfD = d;
      }
      if (Math.abs(rotX) > 1e-3) {
        const c = Math.abs(Math.cos(rotX));
        const s = Math.abs(Math.sin(rotX));
        const h = halfH * c + halfD * s;
        halfH = h;
      }
      const mat = MATERIAL_INDEX[box.kind] ?? 0;
      this.collision.addBox({
        minX: box.x - halfW, minY: box.y - halfH, minZ: box.z - halfD,
        maxX: box.x + halfW, maxY: box.y + halfH, maxZ: box.z + halfD
      }, box.kind === 'glass' ? 1 : 0, mat);
    }
    // Trees and rocks block movement as cylinders (cheap and believable).
    for (const tree of this.layout.trees) {
      if (tree.kind === 3) continue;
      const r = 0.34 * tree.scale;
      this.collision.addCylinder(tree.x, tree.z, r, tree.y, tree.y + 3.2 * tree.scale, 2);
    }
    for (const rock of this.layout.rocks) {
      if (rock.scale < 1.1) continue;
      this.collision.addCylinder(rock.x, rock.z, 0.75 * rock.scale, rock.y, rock.y + 0.9 * rock.scale, 7);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Actor management                                                 */
  /* ---------------------------------------------------------------- */

  spawnActor(opts: ActorSpawnOptions): Actor {
    const actor = new Actor({
      id: this.nextActorId++,
      name: opts.name ?? `Operator-${this.nextActorId}`,
      team: opts.team ?? 0,
      isBot: opts.isBot ?? true,
      isLocal: opts.isLocal ?? false
    });
    actor.position.set(opts.x, opts.y, opts.z);
    actor.yaw = opts.yaw ?? 0;
    actor.groundHeight = sampleHeight(this.terrain, opts.x, opts.z);
    actor.squadRules = this.layout !== null && this.squadRules;
    this.actors.push(actor);
    if (actor.isBot) {
      const diff = DIFFICULTIES[opts.difficulty ?? 'NORMAL'];
      const brain = new BotBrain(actor, diff, this.rng);
      this.brains.set(actor.id, brain);
    }
    return actor;
  }

  squadRules = false;

  despawnActor(actor: Actor): void {
    const i = this.actors.indexOf(actor);
    if (i >= 0) this.actors.splice(i, 1);
    this.brains.delete(actor.id);
  }

  /* ---------------------------------------------------------------- */
  /* Main step                                                        */
  /* ---------------------------------------------------------------- */

  /** Player input captured by the game layer for this fixed step. */
  setPlayerInput(input: ControllerInput | null): void {
    this.playerInput = input;
  }

  update(dt: number): void {
    this.time += dt;

    const local = this.localPlayer;
    if (local) this.squadRules = local.squadRules;
    for (const a of this.actors) a.squadRules = this.squadRules;

    // 1. Actors: input → locomotion → weapons
    for (const actor of this.actors) {
      if (actor.lifeState === 'DEAD') {
        actor.velocity.set(0, 0, 0);
        continue;
      }
      actor.survivalTime += dt;

      let input: ControllerInput;
      if (actor.isLocal) {
        input = this.playerInput ?? {
          moveX: 0, moveY: 0, lookYaw: actor.yaw, lookPitch: actor.pitch,
          jump: false, crouch: false, prone: false, sprint: false, walkSlow: false
        };
      } else if (actor.vehicleId !== null) {
        input = this.vehicles.controlInputFor(actor);
      } else {
        const brain = this.brains.get(actor.id);
        input = brain ? brain.update(dt, this.botContext()) : {
          moveX: 0, moveY: 0, lookYaw: actor.yaw, lookPitch: actor.pitch,
          jump: false, crouch: false, prone: false, sprint: false, walkSlow: false
        };
      }

      // Healing locks movement; being in a vehicle overrides locomotion.
      if (actor.healTimer > 0) {
        input.locked = true;
        input.moveX = 0;
        input.moveY = 0;
      }
      if (actor.reviveProgress > 0) input.locked = true;

      if (actor.vehicleId !== null) {
        this.vehicles.updateOccupiedActor(actor, dt);
      } else {
        this.locomotion.step(actor, input, dt);
      }

      const wantsAds = actor.isLocal
        ? this.localWantsAds
        : (this.brains.get(actor.id)?.wantsAds ?? false);
      const wantsFire = actor.isLocal
        ? this.localWantsFire
        : (this.brains.get(actor.id)?.wantsFire ?? false);
      const triggerHeld = actor.isLocal ? this.localTriggerHeld : wantsFire;

      if (actor.vehicleId === null) {
        this.weapons.update(actor, dt, wantsAds, wantsFire, triggerHeld);
      }

      this.processRequests(actor, dt);
      this.updateBleedOut(actor, dt);
      this.autoPickup(actor);
      this.guaranteeArmament(actor, dt);
    }

    // Local intent is consumed once per step.
    this.localWantsFire = false;
    this.localWantsAds = false;

    // 2. Vehicles physics
    this.vehicles.update(dt);

    // 3. Projectiles
    this.ballistics.setActors(this.actors, this.collision);
    this.ballistics.update(dt, this.collision, this.actors, this.time, (x, z) => sampleHeight(this.terrain, x, z));

    // 4. Age out noise events (AI hearing memory)
    if (this.noises.length > 0) {
      const cutoff = this.time - 7;
      let write = 0;
      for (let i = 0; i < this.noises.length; i++) {
        if (this.noises[i].time >= cutoff) this.noises[write++] = this.noises[i];
      }
      this.noises.length = write;
    }
  }

  localWantsFire = false;
  localWantsAds = false;
  localTriggerHeld = false;

  /* ---------------------------------------------------------------- */
  /* Requests (reload / heal / revive / throw)                        */
  /* ---------------------------------------------------------------- */

  private processRequests(actor: Actor, dt: number): void {
    if (actor.reloadRequest) {
      actor.reloadRequest = false;
      this.weapons.beginReload(actor);
    }
    if (actor.useRequest) {
      const itemId = actor.useRequest;
      actor.useRequest = null;
      this.beginConsumable(actor, itemId);
    }
    if (actor.reviveRequest >= 0) {
      const target = this.actors.find((a) => a.id === actor.reviveRequest);
      actor.reviveRequest = -1;
      if (target && target.lifeState === 'DOWNED' && target.team === actor.team) {
        const dist = Math.hypot(target.position.x - actor.position.x, target.position.z - actor.position.z);
        if (dist < 2.6) {
          actor.revivingId = target.id;
          actor.reviveProgress = 0.0001;
          this.hooks.onReviveStart(actor, target);
        }
      }
    }
    // Revive channel
    if (actor.reviveProgress > 0) {
      const target = this.actors.find((a) => a.id === actor.revivingId);
      if (!target || target.lifeState !== 'DOWNED') {
        actor.reviveProgress = 0;
        actor.revivingId = -1;
      } else {
        const dist = Math.hypot(target.position.x - actor.position.x, target.position.z - actor.position.z);
        if (dist > 3.2) {
          actor.reviveProgress = 0;
          actor.revivingId = -1;
        } else {
          actor.reviveProgress += dt / 5;
          if (actor.reviveProgress >= 1) {
            target.reviveFromDown(45);
            actor.reviveProgress = 0;
            actor.revivingId = -1;
            actor.revives++;
            if (actor.isBot) {
              const brain = this.brains.get(actor.id);
              brain?.onEvent('revived');
            }
          }
        }
      }
    }

    // Healing channel
    if (actor.healTimer > 0) {
      actor.healTimer -= dt;
      const amount = actor.healRate * dt;
      actor.heal(amount);
      if (actor.healTimer <= 0) {
        actor.healTimer = 0;
        actor.healRate = 0;
        actor.usingConsumable = null;
      }
    }

    if (actor.throwRequest) {
      const req = actor.throwRequest;
      actor.throwRequest = null;
      if (actor.inventory.useThrowable(req.itemId)) {
        const dx = req.x - actor.position.x;
        const dy = req.y - (actor.position.y + actor.eyeHeight);
        const dz = req.z - actor.position.z;
        const dist = Math.hypot(dx, dy, dz) || 1;
        const power = clamp(dist * 1.05, 8, 26);
        this.ballistics.throwGrenade(
          actor.position.x, actor.position.y + actor.eyeHeight, actor.position.z,
          dx / dist, dy / dist + 0.12, dz / dist,
          req.itemId, actor.id, actor.team, actor.isLocal, power
        );
      }
    }
  }

  beginConsumable(actor: Actor, itemId: string): boolean {
    if (actor.healTimer > 0) return false;
    const def = CONSUMABLES[itemId];
    if (!def) return false;
    if (def.healAmount > 0 && actor.health >= actor.maxHealth) return false;
    if (!actor.inventory.useConsumable(itemId)) return false;
    actor.usingConsumable = itemId;
    actor.healTimer = def.healTime;
    actor.healRate = def.healAmount / def.healTime;
    actor.lastHealItem = itemId;
    this.hooks.onHealStart(actor, itemId);
    if (actor.isLocal) bus.emit('ui:toast', { text: `Using ${def.name}`, kind: 'info' });
    return true;
  }

  private updateBleedOut(actor: Actor, dt: number): void {
    if (actor.lifeState !== 'DOWNED') return;
    actor.downHealth -= dt * (100 / 30);
    if (actor.downHealth <= 0) {
      actor.eliminate(null, 'bleedout', false, this.time);
    }
  }

  /** Auto pickup: bots always, players when the setting is on. */
  autoPickupEnabledFlag(v: boolean): void {
    this.autoPickupEnabled = v;
  }

  /** Seconds an actor has been on the ground (used to seed bot armament). */
  private groundedTime = new Map<number, number>();

  private autoPickup(actor: Actor): void {
    if (actor.lifeState !== 'ALIVE') return;
    const wantsAuto = actor.isBot ? true : this.autoPickupEnabled;
    if (!wantsAuto && !actor.isBot) return;

    // Bots pick up opportunistically; players only when auto-pickup is enabled.
    const radius = actor.isBot ? 3.4 : 2.1;
    const item = this.loot.nearest(actor.position.x, actor.position.y + 0.6, actor.position.z, radius);
    if (!item) return;
    if (!actor.isBot) {
      // Players only auto-grab ammo/consumables/healing; weapons need intent.
      if (item.kind === 'WEAPON' && actor.inventory.active) return;
      if (actor.inventory.active === null && item.kind !== 'WEAPON') {
        // A weaponless player grabs the gun first.
        const weapon = this.loot.items.find((i) => i.kind === 'WEAPON' && i.claimed === 0 &&
          Math.hypot(i.x - actor.position.x, i.z - actor.position.z) < 6);
        if (weapon) {
          this.loot.claim(actor, weapon.id);
          return;
        }
      }
    }
    this.loot.claim(actor, item.id);
  }

  /**
   * Bots that fail to find a weapon still need to be a threat, so after a
   * grace period they are handed a basic sidearm + ammo. This mirrors what a
   * real player would have scavenged in the same window and keeps matches from
   * ending in an unarmed standoff.
   */
  private guaranteeArmament(actor: Actor, dt: number): void {
    if (!actor.isBot || actor.lifeState !== 'ALIVE') return;
    if (actor.vehicleId !== null) return;
    if (actor.moveState === 'AIRCRAFT' || actor.moveState === 'SKYDIVE' || actor.moveState === 'PARACHUTE') {
      this.groundedTime.set(actor.id, 0);
      return;
    }
    if (actor.inventory.active) {
      this.groundedTime.delete(actor.id);
      return;
    }
    const t = (this.groundedTime.get(actor.id) ?? 0) + dt;
    this.groundedTime.set(actor.id, t);
    if (t < 42) return;
    this.groundedTime.delete(actor.id);
    // Grant a tier-appropriate sidearm with ammunition.
    const pick = this.rng.next() < 0.55 ? 'p9' : 'hornet9';
    this.loot.dropNear(actor.position.x, actor.position.y + 0.2, actor.position.z, pick, 'COMMON', 1, 'WEAPON');
    const dropped = this.loot.nearest(actor.position.x, actor.position.y + 0.5, actor.position.z, 3.5);
    if (dropped) this.loot.claim(actor, dropped.id);
    // NOTE: read through the array (not the `active` getter) so TypeScript's
    // control-flow narrowing does not collapse the type to `never`.
    const inv = actor.inventory;
    let weapon = inv.weapons[inv.activeSlot] ?? null;
    if (weapon === null) {
      inv.addWeapon(pick, 'COMMON', 0);
      weapon = inv.weapons[inv.activeSlot] ?? null;
    }
    const ammoType = WEAPONS[weapon ? weapon.defId : pick].ammo;
    inv.addAmmo(ammoType, 40);
    if (weapon) weapon.ammoInMag = WEAPONS[weapon.defId].magSize;
  }

  /* ---------------------------------------------------------------- */
  /* AI plumbing                                                      */
  /* ---------------------------------------------------------------- */

  private _botCtx: BotContext | null = null;

  /** Public so tools/tests can drive an actor with the same perception data. */
  aiContext(): BotContext {
    return this.botContext();
  }

  private botContext(): BotContext {
    if (this._botCtx === null) {
      this._botCtx = {
        actors: this.actors,
        nav: this.nav,
        world: this.collision,
        time: this.time,
        zone: this.zoneSnapshot(),
        noises: this.noises,
        loot: this.loot.items,
        buildings: this.layout.buildings.map((b) => ({ x: b.x, y: b.y, z: b.z, radius: b.radius, tier: b.tier })),
        landingZones: this.layout.botLandingZones,
        terrainHeight: (x, z) => sampleHeight(this.terrain, x, z),
        isSquadMode: this.squadRules,
        claimLoot: (actor, lootId) => this.loot.claim(actor, lootId),
        reportContact: (actor, enemy) => this.reportContact(actor, enemy),
        onBotEvent: () => {}
      };
    }
    // Zone drifts every frame, so refresh the live fields.
    const ctx = this._botCtx as BotContext;
    const z = ctx.zone;
    const zs = this.zoneSource;
    if (zs) {
      z.x = zs.x; z.z = zs.z; z.radius = zs.radius;
      z.nextX = zs.nextX; z.nextZ = zs.nextZ; z.nextRadius = zs.nextRadius;
      z.phase = zs.phase; z.shrinking = zs.shrinking;
    }
    ctx.time = this.time;
    return ctx;
  }

  /** Set by the mode implementation so bots know where the safe zone is. */
  zoneSource: { x: number; z: number; radius: number; nextX: number; nextZ: number; nextRadius: number; phase: number; shrinking: boolean } | null = null;

  /** Live zone state (used by the HUD, minimap and AI). */
  zoneSnapshot(): BotContext['zone'] {
    const z = this.zoneSource;
    return {
      x: z?.x ?? 0, z: z?.z ?? 0, radius: z?.radius ?? this.terrain.size,
      nextX: z?.nextX ?? 0, nextZ: z?.nextZ ?? 0, nextRadius: z?.nextRadius ?? this.terrain.size,
      phase: z?.phase ?? 0, shrinking: z?.shrinking ?? false
    };
  }

  /** Squad contact sharing (extended by SquadSystem). */
  reportContact(actor: Actor, enemy: Actor): void {
    for (const mate of this.actors) {
      if (mate === actor || mate.team !== actor.team) continue;
      const brain = this.brains.get(mate.id);
      if (!brain) continue;
      // Share the contact if the mate could plausibly be told about it.
      const dist = Math.hypot(mate.position.x - actor.position.x, mate.position.z - actor.position.z);
      if (dist > 70) continue;
      if (!brain.target || brain.targetAwareness < 0.4) {
        brain.target = enemy;
        brain.targetAwareness = Math.max(brain.targetAwareness, 0.5);
        brain.lastSeenPos.copy(enemy.position);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Helpers used by modes                                            */
  /* ---------------------------------------------------------------- */

  /** Damage an actor outside the zone (used by modes without a ZoneSystem). */
  applyZoneDamage(actor: Actor, amount: number): void {
    actor.applyDamage(amount, 'TORSO', null, 'zone', this.time);
  }

  giveLoadout(actor: Actor, primaryId: string, secondaryId: string, options: {
    primaryRarity?: 'COMMON' | 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY';
    armorLevel?: number;
    helmetLevel?: number;
    backpackLevel?: number;
    ammoMult?: number;
    gadgets?: string[];
  } = {}): void {
    const inv = actor.inventory;
    inv.clear();
    inv.addWeapon(primaryId, options.primaryRarity ?? 'COMMON', 0);
    inv.addWeapon(secondaryId, 'COMMON', 1);
    const armorId = options.armorLevel ? `vest${clamp(options.armorLevel, 1, 3)}` : null;
    const helmetId = options.helmetLevel ? `helmet${clamp(options.helmetLevel, 1, 3)}` : null;
    const packId = options.backpackLevel ? `pack${clamp(options.backpackLevel, 1, 3)}` : null;
    if (armorId) inv.equipGear(armorId);
    if (helmetId) inv.equipGear(helmetId);
    if (packId) inv.equipGear(packId);
    if (armorId) inv.armorPoints = inv.maxArmorPoints;

    // Magazine + reserve ammo for both weapons.
    const mult = options.ammoMult ?? 3;
    for (const w of inv.weapons) {
      if (!w) continue;
      const def = WEAPONS[w.defId];
      inv.addAmmo(def.ammo, def.magSize * mult);
      w.ammoInMag = def.magSize;
    }
    for (const g of options.gadgets ?? []) {
      if (CONSUMABLES[g]) inv.addConsumable(g, 2);
      else if (THROWABLES[g]) inv.addThrowable(g, 2);
    }
    bus.emit('inventory:changed', {});
  }

  dropEverything(actor: Actor): void {
    for (let slot = 0; slot < 3; slot++) {
      const w = actor.inventory.weapons[slot];
      if (!w) continue;
      this.loot.dropNear(actor.position.x, actor.position.y + 0.3, actor.position.z, w.defId, w.rarity, 1, 'WEAPON');
    }
    for (const stack of actor.inventory.consumables) {
      this.loot.dropNear(actor.position.x, actor.position.y + 0.3, actor.position.z, stack.itemId, stack.rarity, stack.count, 'CONSUMABLE');
    }
    for (const stack of actor.inventory.throwables) {
      this.loot.dropNear(actor.position.x, actor.position.y + 0.3, actor.position.z, stack.itemId, stack.rarity, stack.count, 'THROWABLE');
    }
    for (const stack of actor.inventory.attachments) {
      this.loot.dropNear(actor.position.x, actor.position.y + 0.3, actor.position.z, stack.itemId, stack.rarity, stack.count, 'ATTACHMENT');
    }
    if (actor.inventory.armor) this.loot.dropNear(actor.position.x, actor.position.y + 0.3, actor.position.z, actor.inventory.armor, 'COMMON', 1, 'GEAR');
    if (actor.inventory.helmet) this.loot.dropNear(actor.position.x, actor.position.y + 0.3, actor.position.z, actor.inventory.helmet, 'COMMON', 1, 'GEAR');
    if (actor.inventory.backpack) this.loot.dropNear(actor.position.x, actor.position.y + 0.3, actor.position.z, actor.inventory.backpack, 'COMMON', 1, 'GEAR');
    actor.inventory.clear();
  }

  /** Text shown in the interaction prompt for the local player. */
  interactPromptFor(actor: Actor): string | null {
    const vehicle = this.vehicles.nearestEnterable(actor);
    if (vehicle) return `Enter ${vehicle.type}`;
    const item = this.loot.nearest(actor.position.x, actor.position.y + 0.6, actor.position.z, 2.6);
    if (item) return `Pick up ${displayName(item.itemId)}${item.count > 1 ? ` x${item.count}` : ''}`;
    return null;
  }

  dispose(): void {
    setNoiseCallback(() => {});
    this.actors.length = 0;
    this.brains.clear();
    this.noises.length = 0;
    this.collision.dispose();
    this.ballistics.clear();
    this.vehicles.dispose();
  }
}
