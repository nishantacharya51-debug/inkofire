import { RNG } from '../utils/rng';
import type { MapLayout } from '../world/MapLayout';
import { rollLoot, rollRarity } from '../items/LootTables';
import { GEAR, WEAPONS, type Rarity } from '../items/Items';
import type { Actor } from '../entity/Actor';
import { CONSUMABLES, THROWABLES, ATTACHMENTS, AMMO } from '../items/Items';
import { bus } from '../core/EventBus';

export interface LootItem {
  id: number;
  x: number;
  y: number;
  z: number;
  itemId: string;
  count: number;
  rarity: Rarity;
  /** 0 = available, >0 = reserved by an AI (prevents bots stacking on one item). */
  claimed: number;
  claimedAt: number;
  /** Loot tier of the spot it spawned in (drives AI desirability). */
  tier: number;
  /** Deterministic spin for the world model. */
  spin: number;
  kind: 'WEAPON' | 'AMMO' | 'GEAR' | 'CONSUMABLE' | 'THROWABLE' | 'ATTACHMENT';
}

/**
 * World loot. Items are plain data; the renderer builds instanced meshes from
 * the same list, and the AI reads it through the same array (structurally
 * compatible with BotContext.loot).
 */
const LOOT_CELL = 64;

export class LootSystem {
  items: LootItem[] = [];
  private nextId = 1;
  private activeCount = 0;
  /** Coarse spatial index so per-frame "nearest item" queries stay cheap. */
  private cells = new Map<number, LootItem[]>();
  private half = 0;
  private dim = 1;

  constructor(private rng: RNG, worldSize = 2048) {
    this.half = worldSize / 2;
    this.dim = Math.ceil(worldSize / LOOT_CELL) + 2;
  }

  private cellKey(x: number, z: number): number {
    const ix = Math.floor((x + this.half) / LOOT_CELL) + 1;
    const iz = Math.floor((z + this.half) / LOOT_CELL) + 1;
    return ix * this.dim + iz;
  }

  private index(item: LootItem): void {
    const key = this.cellKey(item.x, item.z);
    let arr = this.cells.get(key);
    if (!arr) {
      arr = [];
      this.cells.set(key, arr);
    }
    arr.push(item);
  }

  /** Items in the cells overlapping a circle, appended to `out`. */
  private gather(x: number, z: number, radius: number, out: LootItem[]): LootItem[] {
    out.length = 0;
    const r = Math.ceil(radius / LOOT_CELL);
    const cx = Math.floor((x + this.half) / LOOT_CELL) + 1;
    const cz = Math.floor((z + this.half) / LOOT_CELL) + 1;
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const arr = this.cells.get(ix * this.dim + iz);
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) out.push(arr[i]);
      }
    }
    return out;
  }

  private queryScratch: LootItem[] = [];

  spawnFromLayout(layout: MapLayout): void {
    this.items.length = 0;
    this.cells.clear();
    this.nextId = 1;
    for (const spot of layout.lootSpots) {
      const rolls = this.rng.next() < 0.22 ? 2 : 1;
      for (let i = 0; i < rolls; i++) {
        const entry = rollLoot(this.rng, spot.tier);
        const jitter = spot.indoor ? 0.9 : 1.6;
        this.items.push({
          id: this.nextId++,
          x: spot.x + (this.rng.next() - 0.5) * jitter,
          y: spot.y + 0.24,
          z: spot.z + (this.rng.next() - 0.5) * jitter,
          itemId: entry.itemId,
          count: entry.count,
          rarity: entry.rarity,
          claimed: 0,
          claimedAt: 0,
          tier: spot.tier,
          spin: this.rng.next() * Math.PI * 2,
          kind: entry.kind
        });
      }
    }
    for (const item of this.items) this.index(item);
    // Guaranteed mid-tier weapon near each POI so every drop has a fighting chance.
    for (const poi of layout.pois) {
      const weaponPool = Object.values(WEAPONS).filter((w) => w.cls !== 'MELEE' && w.tier >= 2);
      const w = this.rng.pick(weaponPool);
      const ang = this.rng.next() * Math.PI * 2;
      const rad = this.rng.next() * poi.radius * 0.5;
      this.items.push({
        id: this.nextId++,
        x: poi.x + Math.cos(ang) * rad,
        y: poi.y + 0.3,
        z: poi.z + Math.sin(ang) * rad,
        itemId: w.id,
        count: 1,
        rarity: rollRarity(this.rng, Math.min(4, poi.lootTier + 1)),
        claimed: 0,
        claimedAt: 0,
        tier: poi.lootTier,
        spin: this.rng.next() * Math.PI * 2,
        kind: 'WEAPON'
      });
      this.index(this.items[this.items.length - 1]);
    }
    this.activeCount = this.items.length;
  }

  get remaining(): number {
    return this.activeCount;
  }

  /**
   * Attempts to give a world item to an actor.
   * Returns true when something was actually taken.
   */
  claim(actor: Actor, id: number): boolean {
    const item = this.items[id - 1];
    if (!item || item.claimed > 0) return false;
    if (item.id !== id) {
      // Fall back to a lookup (ids are stable but be defensive).
      const found = this.items.find((i) => i.id === id);
      if (!found || found.claimed > 0) return false;
      return this.give(actor, found);
    }
    return this.give(actor, item);
  }

  private give(actor: Actor, item: LootItem): boolean {
    const inv = actor.inventory;
    let taken = false;

    switch (item.kind) {
      case 'WEAPON': {
        const slot = inv.bestSlotFor(item.itemId);
        if (slot >= 0) {
          const replaced = inv.dropWeapon(slot);
          inv.addWeapon(item.itemId, item.rarity, slot);
          // Give the dropped gun back to the world for others to find.
          if (replaced) {
            this.dropNear(item.x, item.y, item.z, replaced.defId, replaced.rarity, 1, 'WEAPON');
          }
          // Found weapons come loaded — use carried reserves first, and if the
          // actor has none, the weapon still arrives with a full magazine so a
          // fresh drop is never a dead end.
          const inst = inv.weapons[slot];
          if (inst) {
            const def = WEAPONS[inst.defId];
            const fromReserve = Math.min(inv.ammo[def.ammo], def.magSize);
            if (fromReserve > 0) inv.takeAmmo(def.ammo, fromReserve);
            inst.ammoInMag = Math.max(fromReserve, fromReserve === 0 ? Math.ceil(def.magSize * 0.5) : fromReserve);
            if (inv.ammo[def.ammo] === 0) inv.addAmmoBySpace(def.ammo, def.magSize * 2);
          }
          taken = true;
        }
        break;
      }
      case 'AMMO': {
        const added = inv.addAmmoBySpace(item.itemId as keyof typeof AMMO, item.count);
        if (added > 0) {
          item.count -= added;
          taken = item.count <= 0;
          if (!taken) item.claimed = 0;
        }
        break;
      }
      case 'GEAR': {
        const res = inv.equipGear(item.itemId);
        if (res.equipped) {
          if (res.replaced) this.dropNear(item.x, item.y, item.z, res.replaced, 'COMMON', 1, 'GEAR');
          taken = true;
        }
        break;
      }
      case 'CONSUMABLE': {
        const added = inv.addConsumable(item.itemId, item.count);
        if (added > 0) {
          item.count -= added;
          taken = item.count <= 0;
          if (!taken) item.claimed = 0;
        }
        break;
      }
      case 'THROWABLE': {
        const added = inv.addThrowable(item.itemId, item.count);
        if (added > 0) {
          item.count -= added;
          taken = item.count <= 0;
          if (!taken) item.claimed = 0;
        }
        break;
      }
      case 'ATTACHMENT': {
        const added = inv.addAttachment(item.itemId, 1);
        if (added > 0) taken = true;
        break;
      }
      default:
        break;
    }

    if (taken) {
      item.claimed = actor.id;
      item.claimedAt = performance.now();
      this.activeCount = Math.max(0, this.activeCount - 1);
      if (actor.isLocal) {
        bus.emit('loot:pickup', { itemId: item.itemId, name: displayName(item.itemId) });
      }
      bus.emit('inventory:changed', {});
    }
    return taken;
  }

  /** Drops an item into the world (used for swaps and player drops). */
  drop(itemId: string, count: number, rarity: Rarity, x: number, y: number, z: number, kind?: LootItem['kind']): void {
    const k = kind ?? guessKind(itemId);
    const item: LootItem = {
      id: this.nextId++,
      x, y, z, itemId, count, rarity, claimed: 0, claimedAt: 0, tier: 2,
      spin: this.rng.next() * Math.PI * 2, kind: k
    };
    this.items.push(item);
    this.index(item);
    this.activeCount++;
  }

  dropNear(x: number, y: number, z: number, itemId: string, rarity: Rarity, count: number, kind: LootItem['kind']): void {
    const ang = this.rng.next() * Math.PI * 2;
    const r = 0.7 + this.rng.next() * 0.8;
    this.drop(itemId, count, rarity, x + Math.cos(ang) * r, y, z + Math.sin(ang) * r, kind);
  }

  /** Nearest available item to a point (used by auto-pickup and AI). */
  nearest(x: number, y: number, z: number, radius: number): LootItem | null {
    let best: LootItem | null = null;
    let bestD = radius * radius;
    const candidates = this.gather(x, z, radius, this.queryScratch);
    for (const item of candidates) {
      if (item.claimed > 0) continue;
      const d = (item.x - x) ** 2 + (item.z - z) ** 2 + (item.y - y) ** 2 * 0.5;
      if (d < bestD) {
        bestD = d;
        best = item;
      }
    }
    return best;
  }

  /** Items available within a radius, for the interaction prompt. */
  nearby(x: number, y: number, z: number, radius: number, out: LootItem[] = []): LootItem[] {
    out.length = 0;
    const r2 = radius * radius;
    const candidates = this.gather(x, z, radius, this.queryScratch);
    for (const item of candidates) {
      if (item.claimed > 0) continue;
      const d = (item.x - x) ** 2 + (item.z - z) ** 2;
      if (d < r2 && Math.abs(item.y - y) < 3) out.push(item);
    }
    return out;
  }
}

export function displayName(itemId: string): string {
  return WEAPONS[itemId]?.name
    ?? GEAR[itemId]?.name
    ?? CONSUMABLES[itemId]?.name
    ?? THROWABLES[itemId]?.name
    ?? ATTACHMENTS[itemId]?.name
    ?? AMMO[itemId as keyof typeof AMMO]?.name
    ?? itemId;
}

function guessKind(itemId: string): LootItem['kind'] {
  if (WEAPONS[itemId]) return 'WEAPON';
  if (GEAR[itemId]) return 'GEAR';
  if (CONSUMABLES[itemId]) return 'CONSUMABLE';
  if (THROWABLES[itemId]) return 'THROWABLE';
  if (ATTACHMENTS[itemId]) return 'ATTACHMENT';
  return 'AMMO';
}
