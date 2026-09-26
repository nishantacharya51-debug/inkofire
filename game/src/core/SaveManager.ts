import { bus } from './EventBus';

export interface PlayerStats {
  matches: number;
  wins: number;
  top10: number;
  kills: number;
  deaths: number;
  damage: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
  survivalTime: number;
  longestMatch: number;
  revives: number;
  distanceTravelled: number;
  vehiclesUsed: number;
  clashWins: number;
  loneWolfWins: number;
  matchesByMode: Record<string, number>;
}

export interface MatchRecord {
  mode: string;
  placement: number;
  kills: number;
  damage: number;
  survivalTime: number;
  victory: boolean;
  timestamp: number;
  xp: number;
}

export interface CosmeticSlotState {
  equipped: Record<string, string>;
  unlocked: string[];
}

export interface Profile {
  name: string;
  level: number;
  xp: number;
  coins: number;
  cosmetics: CosmeticSlotState;
  achievements: string[];
  loadouts: Record<string, string[]>;
  selectedMode: string;
}

export interface SaveData {
  version: number;
  stats: PlayerStats;
  profile: Profile;
  history: MatchRecord[];
}

const STORAGE_KEY = 'apexisland.profile.v1';

const DEFAULT_STATS: PlayerStats = {
  matches: 0, wins: 0, top10: 0, kills: 0, deaths: 0, damage: 0, headshots: 0,
  shotsFired: 0, shotsHit: 0, survivalTime: 0, longestMatch: 0, revives: 0,
  distanceTravelled: 0, vehiclesUsed: 0, clashWins: 0, loneWolfWins: 0,
  matchesByMode: {}
};

export const ACHIEVEMENTS: { id: string; name: string; desc: string; check: (s: PlayerStats, h: MatchRecord[]) => boolean }[] = [
  { id: 'first_blood', name: 'First Blood', desc: 'Score your first elimination', check: (s) => s.kills >= 1 },
  { id: 'champion', name: 'Island Champion', desc: 'Win a Battle Royale match', check: (s) => s.wins >= 1 },
  { id: 'sharpshooter', name: 'Sharpshooter', desc: 'Land 25 headshots', check: (s) => s.headshots >= 25 },
  { id: 'veteran', name: 'Veteran', desc: 'Play 10 matches', check: (s) => s.matches >= 10 },
  { id: 'survivor', name: 'Long Haul', desc: 'Survive 15 minutes in one match', check: (s) => s.longestMatch >= 900 },
  { id: 'road_trip', name: 'Road Trip', desc: 'Drive 5 vehicles', check: (s) => s.vehiclesUsed >= 5 },
  { id: 'medic', name: 'Combat Medic', desc: 'Revive 3 teammates', check: (s) => s.revives >= 3 },
  { id: 'clash_champ', name: 'Clash Champion', desc: 'Win a Clash Squad match', check: (s) => s.clashWins >= 1 },
  { id: 'lone_wolf', name: 'Lone Wolf', desc: 'Win a Lone Wolf match', check: (s) => s.loneWolfWins >= 1 },
  { id: 'shredder', name: 'Heavy Hitter', desc: 'Deal 10,000 lifetime damage', check: (s) => s.damage >= 10000 }
];

const DEFAULT_PROFILE: Profile = {
  name: 'Operator',
  level: 1,
  xp: 0,
  coins: 500,
  cosmetics: { equipped: {}, unlocked: ['skin_default', 'outfit_default', 'chute_default', 'vehicle_default'] },
  achievements: [],
  loadouts: {},
  selectedMode: 'BR_SOLO'
};

function defaultData(): SaveData {
  return {
    version: 1,
    stats: { ...DEFAULT_STATS, matchesByMode: {} },
    profile: { ...DEFAULT_PROFILE, cosmetics: { equipped: {}, unlocked: ['skin_default', 'outfit_default', 'chute_default', 'vehicle_default'] } },
    history: []
  };
}

class SaveManager {
  data: SaveData = defaultData();
  private writeTimer: number | null = null;

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SaveData>;
        const base = defaultData();
        this.data = {
          version: 1,
          stats: { ...base.stats, ...(parsed.stats ?? {}), matchesByMode: { ...(parsed.stats?.matchesByMode ?? {}) } },
          profile: {
            ...base.profile,
            ...(parsed.profile ?? {}),
            cosmetics: { ...base.profile.cosmetics, ...(parsed.profile?.cosmetics ?? {}) },
            achievements: parsed.profile?.achievements ?? []
          },
          history: (parsed.history ?? []).slice(-40)
        };
      }
    } catch (err) {
      console.warn('[Save] load failed, resetting profile', err);
      this.data = defaultData();
    }
  }

  /** Debounced write so rapid stat updates do not thrash localStorage. */
  private scheduleSave(): void {
    if (this.writeTimer !== null) return;
    this.writeTimer = window.setTimeout(() => {
      this.writeTimer = null;
      this.flush();
    }, 400);
  }

  flush(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (err) {
      console.warn('[Save] persist failed', err);
    }
  }

  get stats(): PlayerStats {
    return this.data.stats;
  }

  get profile(): Profile {
    return this.data.profile;
  }

  addStat<K extends keyof PlayerStats>(key: K, amount: number): void {
    const v = this.data.stats[key];
    this.data.stats[key] = ((typeof v === 'number' ? v : 0) + amount) as PlayerStats[K];
    this.scheduleSave();
  }

  /** Called once per completed match. Returns XP/coin reward + new achievements. */
  recordMatch(record: MatchRecord): { xp: number; coins: number; unlocked: string[] } {
    const s = this.data.stats;
    s.matches += 1;
    s.kills += record.kills;
    s.damage += record.damage;
    s.survivalTime += record.survivalTime;
    s.longestMatch = Math.max(s.longestMatch, record.survivalTime);
    s.matchesByMode[record.mode] = (s.matchesByMode[record.mode] ?? 0) + 1;
    if (record.victory) s.wins += 1;
    if (record.placement <= 10) s.top10 += 1;
    if (record.mode.startsWith('CLASH') && record.victory) s.clashWins += 1;
    if (record.mode.startsWith('LONE') && record.victory) s.loneWolfWins += 1;

    const xp = Math.round(record.kills * 45 + record.damage * 0.35 + (record.victory ? 320 : record.placement <= 10 ? 140 : 45) + record.survivalTime * 0.22);
    const coins = Math.round(xp * 0.35 + record.kills * 8);
    record.xp = xp;
    this.data.profile.xp += xp;
    this.data.profile.coins += coins;

    let leveled = false;
    while (this.data.profile.xp >= this.xpForLevel(this.data.profile.level)) {
      this.data.profile.xp -= this.xpForLevel(this.data.profile.level);
      this.data.profile.level += 1;
      leveled = true;
    }

    this.data.history.push(record);
    if (this.data.history.length > 40) this.data.history.shift();

    const unlocked: string[] = [];
    for (const a of ACHIEVEMENTS) {
      if (this.data.profile.achievements.includes(a.id)) continue;
      try {
        if (a.check(this.data.stats, this.data.history)) {
          this.data.profile.achievements.push(a.id);
          unlocked.push(a.name);
          bus.emit('achievement:unlocked', { id: a.id, name: a.name });
        }
      } catch (err) {
        console.warn('[Save] achievement check failed', a.id, err);
      }
    }
    if (leveled) bus.emit('ui:toast', { text: `Level up! Now level ${this.data.profile.level}`, kind: 'good' });
    this.scheduleSave();
    bus.emit('stats:changed', {});
    return { xp, coins, unlocked };
  }

  xpForLevel(level: number): number {
    return 800 + (level - 1) * 450;
  }

  unlockCosmetic(id: string): boolean {
    if (this.data.profile.cosmetics.unlocked.includes(id)) return false;
    this.data.profile.cosmetics.unlocked.push(id);
    this.scheduleSave();
    return true;
  }

  equipCosmetic(slot: string, id: string): void {
    this.data.profile.cosmetics.equipped[slot] = id;
    if (!this.data.profile.cosmetics.unlocked.includes(id)) this.data.profile.cosmetics.unlocked.push(id);
    this.scheduleSave();
    bus.emit('stats:changed', {});
  }

  saveLoadout(mode: string, items: string[]): void {
    this.data.profile.loadouts[mode] = items;
    this.scheduleSave();
  }

  getLoadout(mode: string): string[] | undefined {
    return this.data.profile.loadouts[mode];
  }

  setName(name: string): void {
    this.data.profile.name = name.slice(0, 16) || 'Operator';
    this.scheduleSave();
    bus.emit('stats:changed', {});
  }

  setMode(mode: string): void {
    this.data.profile.selectedMode = mode;
    this.scheduleSave();
  }

  resetAll(): void {
    this.data = defaultData();
    this.flush();
    bus.emit('stats:changed', {});
  }
}

export const save = new SaveManager();
