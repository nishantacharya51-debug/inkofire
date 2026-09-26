import {
  AMMO, ATTACHMENTS, BASE_CAPACITY, CONSUMABLES, GEAR, THROWABLES, WEAPONS,
  type AmmoType, type AttachmentSlot, type Rarity, type WeaponDef
} from '../items/Items';
import { bus } from '../core/EventBus';

/** A weapon the actor is carrying, with its rolled rarity and attachments. */
export interface WeaponInstance {
  uid: number;
  defId: string;
  rarity: Rarity;
  attachments: Partial<Record<AttachmentSlot, string>>;
  ammoInMag: number;
  fireModeIndex: number;
  /** 0..1 heat used purely for UI feedback. */
  heat: number;
}

export interface Stack {
  itemId: string;
  count: number;
  rarity: Rarity;
}

let uidCounter = 1;
export function nextUid(): number {
  return uidCounter++;
}

/** Applies attachment modifiers to a base weapon definition. */
export function effectiveStats(inst: WeaponInstance): {
  def: WeaponDef;
  damage: number;
  magSize: number;
  reloadTime: number;
  spreadHip: number;
  spreadAds: number;
  spreadPerShot: number;
  recoilVertical: number;
  recoilHorizontal: number;
  recoilRecovery: number;
  adsZoom: number;
  adsTime: number;
  bulletSpeed: number;
  suppressed: boolean;
  noise: number;
} {
  const def = WEAPONS[inst.defId];
  let damage = def.damage;
  let magSize = def.magSize;
  let reloadTime = def.reloadTime;
  let spreadHip = def.spreadHip;
  let spreadAds = def.spreadAds;
  let spreadPerShot = def.spreadPerShot;
  let recoilVertical = def.recoilVertical;
  let recoilHorizontal = def.recoilHorizontal;
  let recoilRecovery = def.recoilRecovery;
  let adsZoom = def.adsZoom;
  let adsTime = def.adsTime;
  let bulletSpeed = def.bulletSpeed;
  let suppressed = def.suppressed ?? false;
  let noise = 1;

  for (const slot of Object.keys(inst.attachments) as AttachmentSlot[]) {
    const id = inst.attachments[slot];
    if (!id) continue;
    const att = ATTACHMENTS[id];
    if (!att) continue;
    const m = att.mods;
    if (m.spreadAds) spreadAds *= m.spreadAds;
    if (m.spreadHip) spreadHip *= m.spreadHip;
    if (m.spreadPerShot) spreadPerShot *= m.spreadPerShot;
    if (m.recoilVertical) recoilVertical *= m.recoilVertical;
    if (m.recoilHorizontal) recoilHorizontal *= m.recoilHorizontal;
    if (m.recoilRecovery) recoilRecovery *= m.recoilRecovery;
    if (m.magBonus) magSize += m.magBonus;
    if (m.reloadMult) reloadTime *= m.reloadMult;
    if (m.adsZoom) adsZoom *= m.adsZoom;
    if (m.adsTime) adsTime *= m.adsTime;
    if (m.bulletSpeed) bulletSpeed *= m.bulletSpeed;
    if (m.suppressed) suppressed = true;
    if (m.noise) noise *= m.noise;
  }
  return {
    def, damage, magSize, reloadTime, spreadHip, spreadAds, spreadPerShot,
    recoilVertical, recoilHorizontal, recoilRecovery, adsZoom, adsTime,
    bulletSpeed, suppressed, noise
  };
}

export interface InventorySnapshot {
  weapons: (WeaponInstance | null)[];
  activeSlot: number;
  ammo: Record<AmmoType, number>;
  gear: { armor: string | null; helmet: string | null; backpack: string | null };
  armorPoints: number;
  maxArmorPoints: number;
  helmetReduction: number;
  capacity: number;
  used: number;
  consumables: Stack[];
  throwables: Stack[];
  attachments: Stack[];
}

/**
 * Actor inventory. Two weapon slots + melee/pistol side slot, ammo pools,
 * gear, throwables, consumables and loose attachments, all limited by a
 * backpack capacity in the classic extraction-shooter style.
 */
export class Inventory {
  weapons: (WeaponInstance | null)[] = [null, null, null];
  activeSlot = 0;
  ammo: Record<AmmoType, number> = { LIGHT: 0, HEAVY: 0, SHELL: 0, SNIPER: 0, PISTOL: 0 };
  armor: string | null = null;
  helmet: string | null = null;
  backpack: string | null = null;
  armorPoints = 0;
  consumables: Stack[] = [];
  throwables: Stack[] = [];
  attachments: Stack[] = [];
  /** Attachments the player has picked but not installed, by slot. */
  quickSlots: (string | null)[] = [];

  constructor(public ownerName = 'Operator') {}

  get capacity(): number {
    const pack = this.backpack ? GEAR[this.backpack] : null;
    return pack ? pack.value : BASE_CAPACITY;
  }

  get maxArmorPoints(): number {
    const v = this.armor ? GEAR[this.armor] : null;
    return v ? v.value : 0;
  }

  get helmetReduction(): number {
    const h = this.helmet ? GEAR[this.helmet] : null;
    return h ? h.value : 0;
  }

  get used(): number {
    let used = 0;
    for (const w of this.weapons) if (w) used += WEAPONS[w.defId].weight * 12;
    for (const a of Object.keys(this.ammo) as AmmoType[]) used += this.ammo[a] * AMMO[a].weight;
    for (const s of this.consumables) used += (CONSUMABLES[s.itemId]?.weight ?? 1) * s.count;
    for (const s of this.throwables) used += (THROWABLES[s.itemId]?.weight ?? 1) * s.count;
    for (const s of this.attachments) used += (ATTACHMENTS[s.itemId]?.weight ?? 0.5) * s.count;
    if (this.armor) used += GEAR[this.armor].weight * 6;
    if (this.helmet) used += GEAR[this.helmet].weight * 4;
    if (this.backpack) used += GEAR[this.backpack].weight * 2;
    return Math.round(used);
  }

  get freeSpace(): number {
    return Math.max(0, this.capacity - this.used);
  }

  get hasWeapon(): boolean {
    return this.active !== null;
  }

  get active(): WeaponInstance | null {
    return this.weapons[this.activeSlot] ?? null;
  }

  get activeDef(): WeaponDef | null {
    const w = this.active;
    return w ? WEAPONS[w.defId] : null;
  }

  snapshot(): InventorySnapshot {
    return {
      weapons: this.weapons.slice(),
      activeSlot: this.activeSlot,
      ammo: { ...this.ammo },
      gear: { armor: this.armor, helmet: this.helmet, backpack: this.backpack },
      armorPoints: this.armorPoints,
      maxArmorPoints: this.maxArmorPoints,
      helmetReduction: this.helmetReduction,
      capacity: this.capacity,
      used: this.used,
      consumables: this.consumables.map((s) => ({ ...s })),
      throwables: this.throwables.map((s) => ({ ...s })),
      attachments: this.attachments.map((s) => ({ ...s }))
    };
  }

  /* ---------------------------------------------------------------- */
  /* Weapons                                                           */
  /* ---------------------------------------------------------------- */

  canAcceptWeapon(): number {
    if (!this.weapons[0]) return 0;
    if (!this.weapons[1]) return 1;
    return -1;
  }

  addWeapon(defId: string, rarity: Rarity, slot?: number): WeaponInstance | null {
    const def = WEAPONS[defId];
    if (!def) return null;
    const target = slot ?? this.canAcceptWeapon();
    if (target < 0) return null;
    const inst: WeaponInstance = {
      uid: nextUid(),
      defId,
      rarity,
      attachments: {},
      ammoInMag: def.magSize,
      fireModeIndex: 0,
      heat: 0
    };
    this.weapons[target] = inst;
    if (def.melee && target === 2) this.weapons[target] = inst;
    if (!this.weapons[this.activeSlot]) this.activeSlot = target;
    bus.emit('inventory:changed', {});
    return inst;
  }

  dropWeapon(slot: number): WeaponInstance | null {
    const w = this.weapons[slot];
    if (!w) return null;
    this.weapons[slot] = null;
    if (this.activeSlot === slot) {
      const next = this.weapons.findIndex((x) => x !== null);
      this.activeSlot = next >= 0 ? next : 0;
    }
    bus.emit('inventory:changed', {});
    return w;
  }

  /** Best available weapon slot index for auto-equip priority. */
  bestSlotFor(defId: string): number {
    const def = WEAPONS[defId];
    if (!def) return -1;
    if (def.melee) return !this.weapons[2] ? 2 : -1;
    if (!this.weapons[0]) return 0;
    if (!this.weapons[1]) return 1;
    // Replace the weaker primary unless the new gun is clearly worse.
    const score = (w: WeaponInstance | null): number => {
      if (!w) return -1;
      const d = WEAPONS[w.defId];
      return (d.damage * d.rpm) / 60 * (d.falloffMin + 0.4) * (1 + (d.tier - 1) * 0.12);
    };
    const newScore = (def.damage * def.rpm) / 60 * (def.falloffMin + 0.4) * (1 + (def.tier - 1) * 0.12);
    const s0 = score(this.weapons[0]);
    const s1 = score(this.weapons[1]);
    const worst = s0 <= s1 ? 0 : 1;
    const worstScore = Math.min(s0, s1);
    return newScore > worstScore * 1.05 ? worst : -1;
  }

  setActiveSlot(slot: number): boolean {
    if (slot < 0 || slot > 2) return false;
    if (!this.weapons[slot]) return false;
    if (this.activeSlot === slot) return false;
    this.activeSlot = slot;
    bus.emit('inventory:changed', {});
    return true;
  }

  cycleSlot(dir: number): void {
    for (let i = 1; i <= 3; i++) {
      const s = (this.activeSlot + dir * i + 3) % 3;
      if (this.weapons[s]) {
        this.activeSlot = s;
        bus.emit('inventory:changed', {});
        return;
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Ammo                                                             */
  /* ---------------------------------------------------------------- */

  addAmmo(type: AmmoType, count: number): number {
    const before = this.ammo[type];
    const max = AMMO[type].maxStack;
    const room = Math.max(0, max - before);
    const added = Math.min(room, count);
    this.ammo[type] = before + added;
    if (added > 0) bus.emit('inventory:changed', {});
    return added;
  }

  addAmmoBySpace(type: AmmoType, count: number): number {
    let added = 0;
    for (let i = 0; i < count; i++) {
      if (this.freeSpace < AMMO[type].weight) break;
      const room = AMMO[type].maxStack - this.ammo[type];
      if (room <= 0) break;
      this.ammo[type]++;
      added++;
    }
    if (added > 0) bus.emit('inventory:changed', {});
    return added;
  }

  takeAmmo(type: AmmoType, count: number): number {
    const taken = Math.min(this.ammo[type], count);
    this.ammo[type] -= taken;
    return taken;
  }

  /* ---------------------------------------------------------------- */
  /* Consumables / throwables / attachments                            */
  /* ---------------------------------------------------------------- */

  addConsumable(itemId: string, count = 1): number {
    const def = CONSUMABLES[itemId];
    if (!def) return 0;
    let stack = this.consumables.find((s) => s.itemId === itemId);
    if (!stack) {
      stack = { itemId, count: 0, rarity: def.rarity };
      this.consumables.push(stack);
    }
    const room = def.stackable - stack.count;
    const spaceLeft = Math.floor(this.freeSpace / def.weight);
    const added = Math.max(0, Math.min(count, room, spaceLeft));
    stack.count += added;
    if (added > 0) bus.emit('inventory:changed', {});
    return added;
  }

  useConsumable(itemId: string): boolean {
    const stack = this.consumables.find((s) => s.itemId === itemId);
    if (!stack || stack.count <= 0) return false;
    stack.count--;
    if (stack.count <= 0) this.consumables = this.consumables.filter((s) => s !== stack);
    bus.emit('inventory:changed', {});
    return true;
  }

  addThrowable(itemId: string, count = 1): number {
    const def = THROWABLES[itemId];
    if (!def) return 0;
    let stack = this.throwables.find((s) => s.itemId === itemId);
    if (!stack) {
      stack = { itemId, count: 0, rarity: def.rarity };
      this.throwables.push(stack);
    }
    const room = def.stackable - stack.count;
    const spaceLeft = Math.floor(this.freeSpace / def.weight);
    const added = Math.max(0, Math.min(count, room, spaceLeft));
    stack.count += added;
    if (added > 0) bus.emit('inventory:changed', {});
    return added;
  }

  useThrowable(itemId: string): boolean {
    const stack = this.throwables.find((s) => s.itemId === itemId);
    if (!stack || stack.count <= 0) return false;
    stack.count--;
    if (stack.count <= 0) this.throwables = this.throwables.filter((s) => s !== stack);
    bus.emit('inventory:changed', {});
    return true;
  }

  addAttachment(itemId: string, count = 1): number {
    const def = ATTACHMENTS[itemId];
    if (!def) return 0;
    let stack = this.attachments.find((s) => s.itemId === itemId);
    if (!stack) {
      stack = { itemId, count: 0, rarity: 'UNCOMMON' };
      this.attachments.push(stack);
    }
    const room = 5 - stack.count;
    const spaceLeft = Math.floor(this.freeSpace / def.weight);
    const added = Math.max(0, Math.min(count, room, spaceLeft));
    stack.count += added;
    if (added > 0) bus.emit('inventory:changed', {});
    return added;
  }

  /** Installs an attachment on the active weapon, returning the replaced one. */
  installAttachment(itemId: string, slotIdx = this.activeSlot): string | null {
    const att = ATTACHMENTS[itemId];
    const weapon = this.weapons[slotIdx];
    if (!att || !weapon) return null;
    const def = WEAPONS[weapon.defId];
    if (!def.attachments.includes(att.slot)) return null;
    if (!att.fits.includes(def.cls)) return null;
    const stack = this.attachments.find((s) => s.itemId === itemId);
    if (!stack || stack.count <= 0) return null;
    const prev = weapon.attachments[att.slot] ?? null;
    weapon.attachments[att.slot] = itemId;
    stack.count--;
    if (stack.count <= 0) this.attachments = this.attachments.filter((s) => s !== stack);
    if (prev) this.addAttachment(prev, 1);
    bus.emit('inventory:changed', {});
    return prev;
  }

  removeAttachment(slot: AttachmentSlot, slotIdx = this.activeSlot): string | null {
    const weapon = this.weapons[slotIdx];
    if (!weapon) return null;
    const id = weapon.attachments[slot];
    if (!id) return null;
    delete weapon.attachments[slot];
    this.addAttachment(id, 1);
    bus.emit('inventory:changed', {});
    return id;
  }

  /* ---------------------------------------------------------------- */
  /* Gear                                                             */
  /* ---------------------------------------------------------------- */

  /** Returns true when the new gear was an upgrade and got equipped. */
  equipGear(itemId: string): { equipped: boolean; replaced: string | null } {
    const gear = GEAR[itemId];
    if (!gear) return { equipped: false, replaced: null };
    let replaced: string | null = null;
    if (gear.slot === 'ARMOR') {
      const current = this.armor ? GEAR[this.armor] : null;
      if (current && current.level >= gear.level) return { equipped: false, replaced: null };
      replaced = this.armor;
      this.armor = itemId;
      this.armorPoints = Math.max(this.armorPoints, gear.value * 0.55);
    } else if (gear.slot === 'HELMET') {
      const current = this.helmet ? GEAR[this.helmet] : null;
      if (current && current.level >= gear.level) return { equipped: false, replaced: null };
      replaced = this.helmet;
      this.helmet = itemId;
    } else {
      const current = this.backpack ? GEAR[this.backpack] : null;
      if (current && current.level >= gear.level) return { equipped: false, replaced: null };
      replaced = this.backpack;
      this.backpack = itemId;
    }
    bus.emit('inventory:changed', {});
    return { equipped: true, replaced };
  }

  addArmorPoints(points: number): void {
    this.armorPoints = Math.min(this.maxArmorPoints, this.armorPoints + points);
    bus.emit('inventory:changed', {});
  }

  /** Armor absorbs part of incoming damage, degrading as it does. */
  absorbDamage(amount: number): number {
    if (this.armorPoints <= 0 || this.maxArmorPoints <= 0) return amount;
    const absorbed = Math.min(this.armorPoints, amount * 0.5);
    this.armorPoints = Math.max(0, this.armorPoints - absorbed * 1.35);
    bus.emit('inventory:changed', {});
    return amount - absorbed;
  }

  clear(): void {
    this.weapons = [null, null, null];
    this.activeSlot = 0;
    this.ammo = { LIGHT: 0, HEAVY: 0, SHELL: 0, SNIPER: 0, PISTOL: 0 };
    this.armor = null;
    this.helmet = null;
    this.backpack = null;
    this.armorPoints = 0;
    this.consumables = [];
    this.throwables = [];
    this.attachments = [];
    bus.emit('inventory:changed', {});
  }
}
