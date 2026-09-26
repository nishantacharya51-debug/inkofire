/**
 * Item database — 100% original weapon/gear designs for Apex Island.
 * Nothing here is derived from any commercial game's assets or stats tables.
 */

export type Rarity = 'COMMON' | 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY';
export type WeaponClass = 'AR' | 'SMG' | 'SHOTGUN' | 'SNIPER' | 'DMR' | 'PISTOL' | 'MELEE' | 'LMG';
export type AmmoType = 'LIGHT' | 'HEAVY' | 'SHELL' | 'SNIPER' | 'PISTOL';
export type AttachmentSlot = 'MUZZLE' | 'SIGHT' | 'GRIP' | 'MAGAZINE' | 'STOCK';
export type ItemCategory = 'WEAPON' | 'AMMO' | 'ARMOR' | 'HELMET' | 'MEDICAL' | 'THROWABLE' | 'ATTACHMENT' | 'BACKPACK' | 'UTILITY';
export type FireMode = 'AUTO' | 'SEMI' | 'BURST' | 'PUMP';

export const RARITY_ORDER: Rarity[] = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'];

export const RARITY_COLOR: Record<Rarity, string> = {
  COMMON: '#b9c2cb',
  UNCOMMON: '#5fd07a',
  RARE: '#4aa8ff',
  EPIC: '#c07bff',
  LEGENDARY: '#ffb347'
};

/** Damage bonus applied by a weapon's loot rarity. */
export const RARITY_DAMAGE_BONUS: Record<Rarity, number> = {
  COMMON: 0,
  UNCOMMON: 0.04,
  RARE: 0.08,
  EPIC: 0.13,
  LEGENDARY: 0.19
};

export interface AmmoDef {
  id: AmmoType;
  name: string;
  short: string;
  color: string;
  maxStack: number;
  weight: number;
}

export const AMMO: Record<AmmoType, AmmoDef> = {
  LIGHT: { id: 'LIGHT', name: '5.6mm Light', short: '5.6', color: '#d8c07a', maxStack: 240, weight: 0.6 },
  HEAVY: { id: 'HEAVY', name: '7.6mm Heavy', short: '7.6', color: '#c98a5a', maxStack: 200, weight: 0.8 },
  SHELL: { id: 'SHELL', name: '12ga Shell', short: '12g', color: '#d05a4a', maxStack: 80, weight: 1.1 },
  SNIPER: { id: 'SNIPER', name: '.40 Magnum', short: '.40', color: '#8a7ad0', maxStack: 60, weight: 1.4 },
  PISTOL: { id: 'PISTOL', name: '9mm Pistol', short: '9mm', color: '#7ad0c0', maxStack: 180, weight: 0.4 }
};

export interface WeaponDef {
  id: string;
  name: string;
  cls: WeaponClass;
  ammo: AmmoType;
  /** Body damage per bullet at effective range. */
  damage: number;
  /** Rounds per minute. */
  rpm: number;
  magSize: number;
  reloadTime: number;
  reloadEmptyTime: number;
  /** Spread in degrees. */
  spreadHip: number;
  spreadAds: number;
  spreadMoveMultiplier: number;
  spreadPerShot: number;
  spreadRecover: number;
  /** Recoil in degrees. */
  recoilVertical: number;
  recoilHorizontal: number;
  recoilRecovery: number;
  bulletSpeed: number;
  /** Metres at which damage begins to fall off, and the residual multiplier. */
  falloffStart: number;
  falloffEnd: number;
  falloffMin: number;
  /** Pellet count for shotguns. */
  pellets: number;
  fireModes: FireMode[];
  /** Weapon class restrictions for attachments. */
  attachments: AttachmentSlot[];
  /** ADS zoom factor (1 = no zoom). */
  adsZoom: number;
  adsTime: number;
  /** Movement speed multiplier while holding. */
  moveMult: number;
  /** Damage multiplier for body parts. */
  headMult: number;
  limbMult: number;
  weight: number;
  switchTime: number;
  /** Base rarity bias — better guns roll higher rarity more often. */
  tier: number;
  suppressed?: boolean;
  melee?: boolean;
  burstCount?: number;
  /** Audio character: lower = deeper boom. */
  soundPitch: number;
  soundGain: number;
  description: string;
}

const W = (def: WeaponDef): WeaponDef => def;

export const WEAPONS: Record<string, WeaponDef> = {
  /* ---------------- Assault rifles ---------------- */
  'vk77': W({
    id: 'vk77', name: 'VK-77 Ranger', cls: 'AR', ammo: 'HEAVY', damage: 27, rpm: 585, magSize: 30,
    reloadTime: 2.35, reloadEmptyTime: 3.0, spreadHip: 3.4, spreadAds: 0.75, spreadMoveMultiplier: 1.85,
    spreadPerShot: 0.34, spreadRecover: 6.2, recoilVertical: 1.32, recoilHorizontal: 0.62, recoilRecovery: 5.2,
    bulletSpeed: 780, falloffStart: 55, falloffEnd: 165, falloffMin: 0.62, pellets: 1,
    fireModes: ['AUTO', 'SEMI'], attachments: ['MUZZLE', 'SIGHT', 'GRIP', 'MAGAZINE', 'STOCK'],
    adsZoom: 1.25, adsTime: 0.30, moveMult: 0.94, headMult: 2.25, limbMult: 0.86, weight: 3.6,
    switchTime: 0.72, tier: 2, soundPitch: 0.92, soundGain: 1,
    description: 'Hard-hitting battle rifle. Punishing recoil, rewarding recoil control.'
  }),
  'ar4': W({
    id: 'ar4', name: 'AR-4 Vector', cls: 'AR', ammo: 'LIGHT', damage: 21, rpm: 700, magSize: 30,
    reloadTime: 2.1, reloadEmptyTime: 2.7, spreadHip: 2.9, spreadAds: 0.55, spreadMoveMultiplier: 1.7,
    spreadPerShot: 0.24, spreadRecover: 7.4, recoilVertical: 0.92, recoilHorizontal: 0.44, recoilRecovery: 6.4,
    bulletSpeed: 860, falloffStart: 65, falloffEnd: 190, falloffMin: 0.68, pellets: 1,
    fireModes: ['AUTO', 'BURST'], attachments: ['MUZZLE', 'SIGHT', 'GRIP', 'MAGAZINE', 'STOCK'],
    adsZoom: 1.25, adsTime: 0.27, moveMult: 0.96, headMult: 2.2, limbMult: 0.86, weight: 3.2,
    switchTime: 0.66, tier: 2, burstCount: 3, soundPitch: 1.0, soundGain: 0.92,
    description: 'Light, controllable general-purpose rifle. Fast follow-up shots.'
  }),
  'tempest': W({
    id: 'tempest', name: 'Tempest Bullpup', cls: 'AR', ammo: 'LIGHT', damage: 24, rpm: 640, magSize: 30,
    reloadTime: 2.25, reloadEmptyTime: 2.85, spreadHip: 3.0, spreadAds: 0.6, spreadMoveMultiplier: 1.6,
    spreadPerShot: 0.22, spreadRecover: 7.8, recoilVertical: 1.0, recoilHorizontal: 0.38, recoilRecovery: 6.8,
    bulletSpeed: 900, falloffStart: 80, falloffEnd: 230, falloffMin: 0.74, pellets: 1,
    fireModes: ['AUTO'], attachments: ['MUZZLE', 'SIGHT', 'GRIP', 'MAGAZINE', 'STOCK'],
    adsZoom: 1.35, adsTime: 0.28, moveMult: 0.95, headMult: 2.3, limbMult: 0.88, weight: 3.4,
    switchTime: 0.7, tier: 3, soundPitch: 0.98, soundGain: 0.95,
    description: 'Rear-heavy bullpup with excellent ranged accuracy.'
  }),
  /* ---------------- SMG ---------------- */
  'hornet9': W({
    id: 'hornet9', name: 'Hornet SM-9', cls: 'SMG', ammo: 'PISTOL', damage: 16, rpm: 900, magSize: 25,
    reloadTime: 1.75, reloadEmptyTime: 2.3, spreadHip: 2.6, spreadAds: 1.1, spreadMoveMultiplier: 1.35,
    spreadPerShot: 0.3, spreadRecover: 9.5, recoilVertical: 0.72, recoilHorizontal: 0.5, recoilRecovery: 9,
    bulletSpeed: 520, falloffStart: 22, falloffEnd: 70, falloffMin: 0.42, pellets: 1,
    fireModes: ['AUTO'], attachments: ['MUZZLE', 'SIGHT', 'GRIP', 'MAGAZINE'],
    adsZoom: 1.1, adsTime: 0.2, moveMult: 1.02, headMult: 2.05, limbMult: 0.9, weight: 2.5,
    switchTime: 0.5, tier: 1, soundPitch: 1.18, soundGain: 0.74,
    description: 'Shreds at close range, falls off hard past 30 metres.'
  }),
  'vex45': W({
    id: 'vex45', name: 'Vex-45 Storm', cls: 'SMG', ammo: 'LIGHT', damage: 19, rpm: 760, magSize: 32,
    reloadTime: 1.95, reloadEmptyTime: 2.5, spreadHip: 2.8, spreadAds: 0.95, spreadMoveMultiplier: 1.4,
    spreadPerShot: 0.26, spreadRecover: 8.4, recoilVertical: 0.8, recoilHorizontal: 0.47, recoilRecovery: 8,
    bulletSpeed: 600, falloffStart: 30, falloffEnd: 88, falloffMin: 0.5, pellets: 1,
    fireModes: ['AUTO', 'SEMI'], attachments: ['MUZZLE', 'SIGHT', 'GRIP', 'MAGAZINE', 'STOCK'],
    adsZoom: 1.15, adsTime: 0.23, moveMult: 1.0, headMult: 2.1, limbMult: 0.9, weight: 2.7,
    switchTime: 0.54, tier: 2, soundPitch: 1.1, soundGain: 0.78,
    description: 'Balanced storm SMG that stays usable just past close quarters.'
  }),
  /* ---------------- Shotguns ---------------- */
  'breach12': W({
    id: 'breach12', name: 'Breach SG-12', cls: 'SHOTGUN', ammo: 'SHELL', damage: 17, rpm: 72, magSize: 6,
    reloadTime: 2.8, reloadEmptyTime: 1.6, spreadHip: 5.2, spreadAds: 3.4, spreadMoveMultiplier: 1.2,
    spreadPerShot: 0.6, spreadRecover: 5, recoilVertical: 2.6, recoilHorizontal: 0.8, recoilRecovery: 4.2,
    bulletSpeed: 420, falloffStart: 9, falloffEnd: 26, falloffMin: 0.22, pellets: 9,
    fireModes: ['PUMP'], attachments: ['MUZZLE', 'SIGHT', 'STOCK'],
    adsZoom: 1.05, adsTime: 0.3, moveMult: 0.92, headMult: 1.75, limbMult: 0.85, weight: 3.5,
    switchTime: 0.8, tier: 2, soundPitch: 0.72, soundGain: 1.25,
    description: 'Pump shotgun. One-shot inside a doorway, useless across a field.'
  }),
  'auto12': W({
    id: 'auto12', name: 'Autoshot B2', cls: 'SHOTGUN', ammo: 'SHELL', damage: 11, rpm: 180, magSize: 8,
    reloadTime: 3.0, reloadEmptyTime: 2.2, spreadHip: 5.8, spreadAds: 3.8, spreadMoveMultiplier: 1.25,
    spreadPerShot: 0.7, spreadRecover: 6, recoilVertical: 1.9, recoilHorizontal: 0.95, recoilRecovery: 5.5,
    bulletSpeed: 400, falloffStart: 8, falloffEnd: 22, falloffMin: 0.18, pellets: 8,
    fireModes: ['SEMI'], attachments: ['MUZZLE', 'SIGHT', 'MAGAZINE', 'STOCK'],
    adsZoom: 1.05, adsTime: 0.28, moveMult: 0.92, headMult: 1.6, limbMult: 0.85, weight: 3.8,
    switchTime: 0.82, tier: 2, soundPitch: 0.78, soundGain: 1.2,
    description: 'Semi-auto breaching shotgun. Two quick shells in a hallway.'
  }),
  /* ---------------- DMR / Sniper ---------------- */
  'bolt7': W({
    id: 'bolt7', name: 'Bolt-7 Marksman', cls: 'DMR', ammo: 'HEAVY', damage: 46, rpm: 215, magSize: 15,
    reloadTime: 2.6, reloadEmptyTime: 3.2, spreadHip: 4.2, spreadAds: 0.32, spreadMoveMultiplier: 2.0,
    spreadPerShot: 0.85, spreadRecover: 5.5, recoilVertical: 1.85, recoilHorizontal: 0.55, recoilRecovery: 4.6,
    bulletSpeed: 900, falloffStart: 120, falloffEnd: 320, falloffMin: 0.82, pellets: 1,
    fireModes: ['SEMI'], attachments: ['MUZZLE', 'SIGHT', 'GRIP', 'MAGAZINE', 'STOCK'],
    adsZoom: 2.0, adsTime: 0.36, moveMult: 0.88, headMult: 2.5, limbMult: 0.88, weight: 4.2,
    switchTime: 0.85, tier: 3, soundPitch: 0.86, soundGain: 1.15,
    description: 'Semi-automatic marksman rifle. Two body shots or one to the head.'
  }),
  'specter': W({
    id: 'specter', name: 'Specter SR', cls: 'SNIPER', ammo: 'SNIPER', damage: 62, rpm: 110, magSize: 10,
    reloadTime: 3.0, reloadEmptyTime: 3.6, spreadHip: 5.5, spreadAds: 0.16, spreadMoveMultiplier: 2.4,
    spreadPerShot: 1.5, spreadRecover: 4.6, recoilVertical: 2.4, recoilHorizontal: 0.4, recoilRecovery: 3.8,
    bulletSpeed: 1000, falloffStart: 200, falloffEnd: 480, falloffMin: 0.9, pellets: 1,
    fireModes: ['SEMI'], attachments: ['MUZZLE', 'SIGHT', 'MAGAZINE', 'STOCK'],
    adsZoom: 2.6, adsTime: 0.42, moveMult: 0.85, headMult: 2.6, limbMult: 0.9, weight: 4.8,
    switchTime: 0.95, tier: 3, soundPitch: 0.8, soundGain: 1.2,
    description: 'Semi-auto marksman rifle built for long sightlines.'
  }),
  'longshot': W({
    id: 'longshot', name: 'Longshot .40', cls: 'SNIPER', ammo: 'SNIPER', damage: 96, rpm: 42, magSize: 5,
    reloadTime: 3.4, reloadEmptyTime: 3.9, spreadHip: 7.0, spreadAds: 0.06, spreadMoveMultiplier: 2.8,
    spreadPerShot: 2.2, spreadRecover: 3.6, recoilVertical: 3.4, recoilHorizontal: 0.3, recoilRecovery: 3.0,
    bulletSpeed: 1100, falloffStart: 300, falloffEnd: 700, falloffMin: 0.95, pellets: 1,
    fireModes: ['SEMI'], attachments: ['MUZZLE', 'SIGHT', 'MAGAZINE', 'STOCK'],
    adsZoom: 3.4, adsTime: 0.55, moveMult: 0.8, headMult: 2.75, limbMult: 0.92, weight: 5.6,
    switchTime: 1.15, tier: 4, soundPitch: 0.7, soundGain: 1.35,
    description: 'Bolt-action anti-materiel rifle. A single chest shot ends most fights.'
  }),
  /* ---------------- LMG ---------------- */
  'bulwark': W({
    id: 'bulwark', name: 'Bulwark LM-60', cls: 'LMG', ammo: 'HEAVY', damage: 29, rpm: 660, magSize: 60,
    reloadTime: 4.6, reloadEmptyTime: 5.2, spreadHip: 4.6, spreadAds: 1.0, spreadMoveMultiplier: 2.4,
    spreadPerShot: 0.28, spreadRecover: 5.4, recoilVertical: 1.15, recoilHorizontal: 0.6, recoilRecovery: 4.8,
    bulletSpeed: 800, falloffStart: 70, falloffEnd: 200, falloffMin: 0.66, pellets: 1,
    fireModes: ['AUTO'], attachments: ['MUZZLE', 'SIGHT', 'GRIP', 'STOCK'],
    adsZoom: 1.2, adsTime: 0.5, moveMult: 0.8, headMult: 2.05, limbMult: 0.88, weight: 6.4,
    switchTime: 1.2, tier: 4, soundPitch: 0.9, soundGain: 1.25,
    description: 'Belt-fed suppression weapon. Slow hands, endless fire.'
  }),
  /* ---------------- Pistols ---------------- */
  'p9': W({
    id: 'p9', name: 'P9 Compact', cls: 'PISTOL', ammo: 'PISTOL', damage: 18, rpm: 400, magSize: 15,
    reloadTime: 1.5, reloadEmptyTime: 2.0, spreadHip: 2.4, spreadAds: 0.7, spreadMoveMultiplier: 1.3,
    spreadPerShot: 0.42, spreadRecover: 9, recoilVertical: 0.95, recoilHorizontal: 0.42, recoilRecovery: 9.5,
    bulletSpeed: 480, falloffStart: 25, falloffEnd: 70, falloffMin: 0.5, pellets: 1,
    fireModes: ['SEMI'], attachments: ['MUZZLE', 'SIGHT', 'MAGAZINE'],
    adsZoom: 1.1, adsTime: 0.16, moveMult: 1.04, headMult: 2.1, limbMult: 0.9, weight: 1.4,
    switchTime: 0.35, tier: 1, soundPitch: 1.25, soundGain: 0.7,
    description: 'Standard sidearm. Always better than empty hands.'
  }),
  'raven50': W({
    id: 'raven50', name: 'Raven .50', cls: 'PISTOL', ammo: 'SNIPER', damage: 40, rpm: 150, magSize: 7,
    reloadTime: 2.1, reloadEmptyTime: 2.6, spreadHip: 3.4, spreadAds: 0.5, spreadMoveMultiplier: 1.6,
    spreadPerShot: 1.2, spreadRecover: 5.5, recoilVertical: 2.5, recoilHorizontal: 0.7, recoilRecovery: 5.2,
    bulletSpeed: 620, falloffStart: 45, falloffEnd: 120, falloffMin: 0.62, pellets: 1,
    fireModes: ['SEMI'], attachments: ['MUZZLE', 'SIGHT'],
    adsZoom: 1.15, adsTime: 0.22, moveMult: 1.0, headMult: 2.4, limbMult: 0.9, weight: 2.0,
    switchTime: 0.45, tier: 3, soundPitch: 0.95, soundGain: 1.1,
    description: 'Hand cannon. Snaps heads at close range, kicks like a mule.'
  }),
  /* ---------------- Melee ---------------- */
  'blade': W({
    id: 'blade', name: 'Kestrel Blade', cls: 'MELEE', ammo: 'PISTOL', damage: 58, rpm: 110, magSize: 1,
    reloadTime: 0, reloadEmptyTime: 0, spreadHip: 0, spreadAds: 0, spreadMoveMultiplier: 1,
    spreadPerShot: 0, spreadRecover: 1, recoilVertical: 0.4, recoilHorizontal: 0.2, recoilRecovery: 8,
    bulletSpeed: 100, falloffStart: 2.6, falloffEnd: 3.4, falloffMin: 0.4, pellets: 1,
    fireModes: ['SEMI'], attachments: [],
    adsZoom: 1, adsTime: 0.2, moveMult: 1.1, headMult: 1.5, limbMult: 0.9, weight: 1.0,
    switchTime: 0.4, tier: 2, melee: true, soundPitch: 1.6, soundGain: 0.5,
    description: 'Silent, fast and lethal in a stairwell.'
  }),
  'crowbar': W({
    id: 'crowbar', name: 'Breaching Bar', cls: 'MELEE', ammo: 'PISTOL', damage: 44, rpm: 90, magSize: 1,
    reloadTime: 0, reloadEmptyTime: 0, spreadHip: 0, spreadAds: 0, spreadMoveMultiplier: 1,
    spreadPerShot: 0, spreadRecover: 1, recoilVertical: 0.5, recoilHorizontal: 0.25, recoilRecovery: 8,
    bulletSpeed: 100, falloffStart: 2.4, falloffEnd: 3.2, falloffMin: 0.4, pellets: 1,
    fireModes: ['SEMI'], attachments: [],
    adsZoom: 1, adsTime: 0.2, moveMult: 1.08, headMult: 1.5, limbMult: 0.9, weight: 1.2,
    switchTime: 0.42, tier: 1, melee: true, soundPitch: 1.4, soundGain: 0.45,
    description: 'Improvised melee weapon from the docks.'
  })
};

export const WEAPON_LIST = Object.values(WEAPONS);

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

export interface AttachmentMods {
  spreadAds?: number;
  spreadHip?: number;
  spreadPerShot?: number;
  recoilVertical?: number;
  recoilHorizontal?: number;
  recoilRecovery?: number;
  magBonus?: number;
  reloadMult?: number;
  adsZoom?: number;
  adsTime?: number;
  bulletSpeed?: number;
  suppressed?: boolean;
  noise?: number;
}

export interface AttachmentDef {
  id: string;
  name: string;
  slot: AttachmentSlot;
  mods: AttachmentMods;
  fits: WeaponClass[];
  weight: number;
  description: string;
}

const A = (def: AttachmentDef): AttachmentDef => def;

export const ATTACHMENTS: Record<string, AttachmentDef> = {
  muzzle_suppressor: A({ id: 'muzzle_suppressor', name: 'Whisper Suppressor', slot: 'MUZZLE', fits: ['AR', 'SMG', 'DMR', 'SNIPER', 'PISTOL'], weight: 0.6, mods: { recoilVertical: 0.94, recoilHorizontal: 0.92, suppressed: true, noise: 0.35, bulletSpeed: 0.96 }, description: 'Hides muzzle flash and muffles the shot. Slightly reduces velocity.' }),
  muzzle_compensator: A({ id: 'muzzle_compensator', name: 'Compensator', slot: 'MUZZLE', fits: ['AR', 'SMG', 'DMR', 'LMG'], weight: 0.5, mods: { recoilVertical: 0.82, recoilHorizontal: 0.95 }, description: 'Cuts vertical climb at the cost of a louder report.' }),
  muzzle_brake: A({ id: 'muzzle_brake', name: 'Barrel Brake', slot: 'MUZZLE', fits: ['AR', 'DMR', 'SNIPER', 'LMG', 'SHOTGUN'], weight: 0.55, mods: { recoilHorizontal: 0.78, recoilVertical: 0.94 }, description: 'Tames horizontal kick for consistent tap fire.' }),
  sight_reddot: A({ id: 'sight_reddot', name: 'Trident Red Dot', slot: 'SIGHT', fits: ['AR', 'SMG', 'DMR', 'PISTOL', 'LMG', 'SHOTGUN'], weight: 0.3, mods: { spreadAds: 0.88, adsTime: 0.96 }, description: 'Clean 1.3x optic. Faster target acquisition.' }),
  sight_holo: A({ id: 'sight_holo', name: 'Halo Holographic', slot: 'SIGHT', fits: ['AR', 'SMG', 'LMG', 'DMR'], weight: 0.35, mods: { spreadAds: 0.84 }, description: 'Wide holographic reticle for tracking moving targets.' }),
  sight_2x: A({ id: 'sight_2x', name: 'Vector 2x', slot: 'SIGHT', fits: ['AR', 'SMG', 'DMR', 'LMG', 'SNIPER'], weight: 0.45, mods: { adsZoom: 1.6, spreadAds: 0.8, adsTime: 1.08 }, description: 'Mid-range magnification.' }),
  sight_4x: A({ id: 'sight_4x', name: 'Vector 4x', slot: 'SIGHT', fits: ['AR', 'DMR', 'SNIPER', 'LMG'], weight: 0.7, mods: { adsZoom: 3.2, spreadAds: 0.62, adsTime: 1.2 }, description: 'Long-range scope with a rangefinder reticle.' }),
  sight_6x: A({ id: 'sight_6x', name: 'Vector 6x', slot: 'SIGHT', fits: ['SNIPER', 'DMR'], weight: 0.9, mods: { adsZoom: 5.0, spreadAds: 0.5, adsTime: 1.32 }, description: 'High-power scope for cross-map shots.' }),
  grip_vertical: A({ id: 'grip_vertical', name: 'Vertical Grip', slot: 'GRIP', fits: ['AR', 'SMG', 'LMG', 'DMR'], weight: 0.35, mods: { spreadHip: 0.85, spreadAds: 0.9 }, description: 'Improves stability from the hip.' }),
  grip_angled: A({ id: 'grip_angled', name: 'Angled Grip', slot: 'GRIP', fits: ['AR', 'SMG', 'LMG', 'DMR'], weight: 0.35, mods: { recoilVertical: 0.88, recoilRecovery: 1.12 }, description: 'Dampens muzzle climb during sustained fire.' }),
  mag_extended: A({ id: 'mag_extended', name: 'Extended Mag', slot: 'MAGAZINE', fits: ['AR', 'SMG', 'DMR', 'PISTOL', 'LMG'], weight: 0.5, mods: { magBonus: 10, reloadMult: 1.12 }, description: '+10 rounds per magazine with a slower reload.' }),
  mag_quickdraw: A({ id: 'mag_quickdraw', name: 'Quickdraw Mag', slot: 'MAGAZINE', fits: ['AR', 'SMG', 'PISTOL'], weight: 0.4, mods: { reloadMult: 0.76 }, description: 'Cuts reload time by a quarter.' }),
  stock_tactical: A({ id: 'stock_tactical', name: 'Tactical Stock', slot: 'STOCK', fits: ['AR', 'SMG', 'DMR', 'SNIPER', 'LMG'], weight: 0.5, mods: { recoilHorizontal: 0.85, spreadPerShot: 0.85, recoilRecovery: 1.06, adsTime: 0.94 }, description: 'Stabilises horizontal drift and recoil bloom.' }),
  stock_light: A({ id: 'stock_light', name: 'Lightweight Stock', slot: 'STOCK', fits: ['AR', 'SMG', 'DMR'], weight: 0.2, mods: { adsTime: 0.86, adsZoom: 1.05 }, description: 'Faster ADS at a small accuracy cost.' })
};

export const ATTACHMENT_LIST = Object.values(ATTACHMENTS);

/* ------------------------------------------------------------------ */
/* Consumables, armor, throwables, packs                              */
/* ------------------------------------------------------------------ */

export interface ConsumableDef {
  id: string;
  name: string;
  category: 'MEDICAL' | 'UTILITY';
  healAmount: number;
  healTime: number;
  /** Armor points restored. */
  armorAmount: number;
  stackable: number;
  weight: number;
  rarity: Rarity;
  description: string;
}

export const CONSUMABLES: Record<string, ConsumableDef> = {
  bandage: { id: 'bandage', name: 'Field Bandage', category: 'MEDICAL', healAmount: 22, healTime: 2.2, armorAmount: 0, stackable: 5, weight: 1, rarity: 'COMMON', description: 'Quick patch. Stops the bleeding.' },
  medkit: { id: 'medkit', name: 'Trauma Kit', category: 'MEDICAL', healAmount: 75, healTime: 5.0, armorAmount: 0, stackable: 3, weight: 2.5, rarity: 'RARE', description: 'Full trauma treatment over five seconds.' },
  stimpack: { id: 'stimpack', name: 'Combat Stim', category: 'MEDICAL', healAmount: 45, healTime: 1.4, armorAmount: 0, stackable: 4, weight: 1.2, rarity: 'UNCOMMON', description: 'Fast-acting stim. Heals while you sprint for cover.' },
  plate: { id: 'plate', name: 'Armor Plate', category: 'UTILITY', healAmount: 0, healTime: 2.6, armorAmount: 40, stackable: 4, weight: 1.6, rarity: 'UNCOMMON', description: 'Repairs your vest in the field.' },
  battery: { id: 'battery', name: 'Shield Cell', category: 'UTILITY', healAmount: 0, healTime: 1.8, armorAmount: 25, stackable: 5, weight: 1.1, rarity: 'COMMON', description: 'Recharges light plating quickly.' }
};

export interface ThrowableDef {
  id: string;
  name: string;
  damage: number;
  radius: number;
  fuse: number;
  effect: 'EXPLOSIVE' | 'SMOKE' | 'FLASH';
  duration: number;
  stackable: number;
  weight: number;
  rarity: Rarity;
  description: string;
}

export const THROWABLES: Record<string, ThrowableDef> = {
  frag: { id: 'frag', name: 'Frag Charge', damage: 92, radius: 8.0, fuse: 3.0, effect: 'EXPLOSIVE', duration: 0, stackable: 3, weight: 1.5, rarity: 'RARE', description: 'Timed fragmentation charge. Bounces off walls.' },
  smoke: { id: 'smoke', name: 'Veil Smoke', damage: 0, radius: 7.5, fuse: 1.4, effect: 'SMOKE', duration: 16, stackable: 3, weight: 1.2, rarity: 'UNCOMMON', description: 'Dense smoke screen for revives and rotations.' },
  flash: { id: 'flash', name: 'Sunburst', damage: 12, radius: 11, fuse: 1.6, effect: 'FLASH', duration: 3.4, stackable: 2, weight: 1.0, rarity: 'UNCOMMON', description: 'Blinds anyone looking at it. Rush windows open.' }
};

export interface GearDef {
  id: string;
  name: string;
  slot: 'ARMOR' | 'HELMET' | 'BACKPACK';
  level: number;
  /** Armor points (ARMOR), damage reduction (HELMET) or capacity (BACKPACK). */
  value: number;
  rarity: Rarity;
  weight: number;
  description: string;
}

export const GEAR: Record<string, GearDef> = {
  vest1: { id: 'vest1', name: 'Scout Vest', slot: 'ARMOR', level: 1, value: 60, rarity: 'COMMON', weight: 2, description: 'Light plating, absorbs a little punishment.' },
  vest2: { id: 'vest2', name: 'Ranger Vest', slot: 'ARMOR', level: 2, value: 95, rarity: 'RARE', weight: 3, description: 'Standard issue combat armor.' },
  vest3: { id: 'vest3', name: 'Juggernaut Vest', slot: 'ARMOR', level: 3, value: 140, rarity: 'EPIC', weight: 4, description: 'Heavy composite plating for frontline pushes.' },
  helmet1: { id: 'helmet1', name: 'Bump Helmet', slot: 'HELMET', level: 1, value: 0.25, rarity: 'COMMON', weight: 1.2, description: 'Reduces headshot damage by 25%.' },
  helmet2: { id: 'helmet2', name: 'Combat Helmet', slot: 'HELMET', level: 2, value: 0.4, rarity: 'RARE', weight: 1.6, description: 'Reduces headshot damage by 40%.' },
  helmet3: { id: 'helmet3', name: 'Aegis Helmet', slot: 'HELMET', level: 3, value: 0.55, rarity: 'EPIC', weight: 2.0, description: 'Reduces headshot damage by 55%.' },
  pack1: { id: 'pack1', name: 'Assault Pack', slot: 'BACKPACK', level: 1, value: 260, rarity: 'UNCOMMON', weight: 1.5, description: 'Adds 60 storage space.' },
  pack2: { id: 'pack2', name: 'Raider Pack', slot: 'BACKPACK', level: 2, value: 340, rarity: 'RARE', weight: 2.2, description: 'Adds 140 storage space.' },
  pack3: { id: 'pack3', name: 'Mule Pack', slot: 'BACKPACK', level: 3, value: 440, rarity: 'EPIC', weight: 3.0, description: 'Adds 240 storage space. Loot everything.' }
};

export const BASE_CAPACITY = 200;

/* ------------------------------------------------------------------ */
/* Unified item reference                                             */
/* ------------------------------------------------------------------ */

export type ItemKind = 'WEAPON' | 'AMMO' | 'GEAR' | 'CONSUMABLE' | 'THROWABLE' | 'ATTACHMENT';

export interface ItemDef {
  id: string;
  kind: ItemKind;
  name: string;
  category: ItemCategory;
  rarity: Rarity;
  weight: number;
  /** Damage/duration stats for weapons; n/a otherwise. */
  weapon?: WeaponDef;
  ammo?: AmmoDef;
  gear?: GearDef;
  consumable?: ConsumableDef;
  throwable?: ThrowableDef;
  attachment?: AttachmentDef;
}

export function itemDef(id: string): ItemDef | null {
  if (WEAPONS[id]) return { id, kind: 'WEAPON', name: WEAPONS[id].name, category: 'WEAPON', rarity: 'COMMON', weight: WEAPONS[id].weight, weapon: WEAPONS[id] };
  if (ATTACHMENTS[id]) return { id, kind: 'ATTACHMENT', name: ATTACHMENTS[id].name, category: 'ATTACHMENT', rarity: 'UNCOMMON', weight: ATTACHMENTS[id].weight, attachment: ATTACHMENTS[id] };
  if (CONSUMABLES[id]) return { id, kind: 'CONSUMABLE', name: CONSUMABLES[id].name, category: 'MEDICAL', rarity: CONSUMABLES[id].rarity, weight: CONSUMABLES[id].weight, consumable: CONSUMABLES[id] };
  if (THROWABLES[id]) return { id, kind: 'THROWABLE', name: THROWABLES[id].name, category: 'THROWABLE', rarity: THROWABLES[id].rarity, weight: THROWABLES[id].weight, throwable: THROWABLES[id] };
  if (GEAR[id]) return { id, kind: 'GEAR', name: GEAR[id].name, category: GEAR[id].slot, rarity: GEAR[id].rarity, weight: GEAR[id].weight, gear: GEAR[id] };
  if (AMMO[id as AmmoType]) {
    const a = AMMO[id as AmmoType];
    return { id, kind: 'AMMO', name: a.name, category: 'AMMO', rarity: 'COMMON', weight: a.weight, ammo: a };
  }
  return null;
}

export function rarityRank(r: Rarity): number {
  return RARITY_ORDER.indexOf(r);
}
