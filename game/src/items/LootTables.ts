import { RNG } from '../utils/rng';
import { ATTACHMENT_LIST, CONSUMABLES, GEAR, THROWABLES, WEAPONS, type Rarity } from './Items';

/**
 * Loot distribution. `tier` comes from the POI the loot spawned in
 * (1 = rural, 2 = village/coast, 3 = city/industrial, 4 = high-value landmark).
 */

export interface LootEntry {
  itemId: string;
  count: number;
  rarity: Rarity;
  kind: 'WEAPON' | 'AMMO' | 'GEAR' | 'CONSUMABLE' | 'THROWABLE' | 'ATTACHMENT';
}

const RARITY_WEIGHTS_BY_TIER: Record<number, number[]> = {
  //            COMMON UNCOMMON RARE  EPIC  LEGENDARY
  1: [62, 26, 9, 2.6, 0.4],
  2: [46, 30, 16, 6.5, 1.5],
  3: [32, 30, 22, 12, 4],
  4: [20, 27, 26, 19, 8]
};

export function rollRarity(rng: RNG, tier: number, luck = 0): Rarity {
  const table = RARITY_WEIGHTS_BY_TIER[Math.max(1, Math.min(4, Math.round(tier)))] ?? RARITY_WEIGHTS_BY_TIER[1];
  const weights = table.map((w, i) => w * (1 + luck * i * 0.25));
  const rarities: Rarity[] = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'];
  return rng.weighted(rarities, weights);
}

const tierOfWeapon = (id: string): number => WEAPONS[id].tier;

export function rollLoot(rng: RNG, tier: number): LootEntry {
  const roll = rng.next();
  const rarity = rollRarity(rng, tier);

  // 34% weapons, 26% ammo, 14% consumables, 10% gear, 8% throwables, 8% attachments
  if (roll < 0.34) {
    // Pick a weapon whose tier roughly matches the requested tier.
    const candidates = Object.values(WEAPONS).filter((w) => !w.melee || tier <= 2);
    const weights = candidates.map((w) => {
      const diff = Math.abs(w.tier - tier);
      const base = Math.max(0.12, 1.6 - diff * 0.42);
      // Rarity also gates strong guns.
      const rarityGate = rarity === 'COMMON' ? (w.tier >= 4 ? 0.12 : w.tier >= 3 ? 0.55 : 1.3)
        : rarity === 'LEGENDARY' ? (w.tier >= 3 ? 2.6 : 0.5)
          : 1;
      return base * rarityGate;
    });
    const def = rng.weighted(candidates, weights);
    return { itemId: def.id, count: 1, rarity, kind: 'WEAPON' };
  }

  if (roll < 0.60) {
    const ammoTypes = ['LIGHT', 'HEAVY', 'SHELL', 'SNIPER', 'PISTOL'] as const;
    const t = rng.weighted(ammoTypes, [34, 26, 12, 8, 20]);
    const amount = t === 'SNIPER' ? rng.int(6, 12) : t === 'SHELL' ? rng.int(8, 18) : rng.int(20, 45);
    void tierOfWeapon;
    return { itemId: t, count: amount, rarity: 'COMMON', kind: 'AMMO' };
  }

  if (roll < 0.74) {
    const ids = Object.keys(CONSUMABLES);
    const id = rng.weighted(ids, ids.map((i) => (CONSUMABLES[i].rarity === 'COMMON' ? 3 : CONSUMABLES[i].rarity === 'RARE' ? 0.8 : 1.6)));
    return { itemId: id, count: rng.int(1, CONSUMABLES[id].stackable), rarity: CONSUMABLES[id].rarity, kind: 'CONSUMABLE' };
  }

  if (roll < 0.84) {
    const slots = tier >= 3 ? ['ARMOR', 'HELMET', 'BACKPACK'] : ['ARMOR', 'HELMET'];
    const maxLevel = tier >= 4 ? 3 : tier >= 3 ? 3 : tier >= 2 ? 2 : 1;
    const candidates = Object.values(GEAR).filter((g) => slots.includes(g.slot) && g.level <= maxLevel);
    const weights = candidates.map((g) => 1 / (g.level * g.level));
    const g = rng.weighted(candidates, weights);
    return { itemId: g.id, count: 1, rarity: g.rarity, kind: 'GEAR' };
  }

  if (roll < 0.92) {
    const ids = Object.keys(THROWABLES);
    const id = rng.pick(ids);
    return { itemId: id, count: rng.int(1, 2), rarity: THROWABLES[id].rarity, kind: 'THROWABLE' };
  }

  const att = rng.pick(ATTACHMENT_LIST);
  return { itemId: att.id, count: 1, rarity: tier >= 3 ? 'RARE' : 'UNCOMMON', kind: 'ATTACHMENT' };
}

/** Starting inventory for Clash Squad / Lone Wolf rounds. */
export function loadoutForTier(tier: number, rng: RNG): { primary: string; secondary: string; armorLevel: number; helmetLevel: number; gadgets: string[] } {
  const primaries = Object.values(WEAPONS).filter((w) => w.cls !== 'MELEE');
  const pool = tier >= 3
    ? primaries.filter((w) => w.tier >= 3)
    : tier === 2
      ? primaries.filter((w) => w.tier === 2)
      : primaries.filter((w) => w.tier <= 2);
  const primary = rng.pick(pool.length ? pool : primaries);
  const secondary = rng.pick(Object.values(WEAPONS).filter((w) => w.cls === 'PISTOL' || w.cls === 'MELEE'));
  return {
    primary: primary.id,
    secondary: secondary.id,
    armorLevel: Math.min(3, Math.max(1, tier - 1)),
    helmetLevel: Math.min(3, Math.max(1, tier - 1)),
    gadgets: tier >= 3 ? ['frag', 'medkit', 'smoke'] : tier === 2 ? ['frag', 'bandage'] : ['bandage', 'battery']
  };
}
