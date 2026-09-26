import { CombatWorld, type CombatHooks } from './CombatWorld';
import type { Actor } from '../entity/Actor';
import type { MapLayout } from '../world/MapLayout';
import type { TerrainData } from '../world/Terrain';
import { sampleHeight } from '../world/Terrain';
import { RNG } from '../utils/rng';
import { bus } from '../core/EventBus';
import { WEAPONS, GEAR, CONSUMABLES, THROWABLES } from '../items/Items';
import { clamp } from '../utils/mathx';

/**
 * Round-based arena modes built on the same CombatWorld as Battle Royale:
 *
 *  - ClashSquad: 4v4, economy + buy phase, first to N round wins.
 *  - LoneWolf:   1v1 duel, mirrored loadouts, best of N.
 *  - Training:   free-play range with every weapon and a respawning target set.
 *
 * All three share the round loop below, so the flow (buy → countdown → fight →
 * round result → next round → match result) is identical and cannot dead-lock.
 */

export type ArenaKind = 'CLASH' | 'LONE' | 'TRAINING';
export type ArenaPhase = 'BUY' | 'COUNTDOWN' | 'FIGHT' | 'ROUND_END' | 'MATCH_END';

export interface ArenaConfig {
  /** Training only: 'MOVING' makes the range targets patrol left and right. */
  dummies?: 'STATIC' | 'MOVING';
  kind: ArenaKind;
  roundsToWin: number;
  startCash: number;
  roundSeconds: number;
  buySeconds: number;
  seed: number;
  difficulty: 'EASY' | 'NORMAL' | 'HARD' | 'ELITE';
  teamSize: number;
}

export interface BuyOffer {
  id: string;
  kind: 'WEAPON' | 'GEAR' | 'MEDICAL' | 'THROWABLE';
  price: number;
}

/** Weapon pool used by the arena economy (cheap → expensive). */
const BUY_POOL: { id: string; price: number }[] = [
  { id: 'hornet9', price: 500 },
  { id: 'vector45', price: 900 },
  { id: 'scrapper12', price: 1100 },
  { id: 'raven50', price: 1400 },
  { id: 'sabre556', price: 1700 },
  { id: 'huntsman762', price: 2100 },
  { id: 'lmg76', price: 2400 },
  { id: 'longbow', price: 2900 }
];

const GEAR_POOL: { id: string; price: number; kind: BuyOffer['kind'] }[] = [
  { id: 'vest2', price: 700, kind: 'GEAR' },
  { id: 'vest3', price: 1200, kind: 'GEAR' },
  { id: 'helmet2', price: 600, kind: 'GEAR' },
  { id: 'helmet3', price: 1000, kind: 'GEAR' },
  { id: 'medkit', price: 400, kind: 'MEDICAL' },
  { id: 'bandage', price: 150, kind: 'MEDICAL' },
  { id: 'frag', price: 300, kind: 'THROWABLE' },
  { id: 'smoke', price: 200, kind: 'THROWABLE' }
];

export function buyOffers(): BuyOffer[] {
  return [
    ...BUY_POOL.map((w) => ({ id: w.id, kind: 'WEAPON' as const, price: w.price })),
    ...GEAR_POOL.map((g) => ({ id: g.id, kind: g.kind, price: g.price }))
  ];
}

export function offerPrice(id: string): number {
  const w = BUY_POOL.find((x) => x.id === id);
  if (w) return w.price;
  return GEAR_POOL.find((x) => x.id === id)?.price ?? 0;
}

export class ArenaMode {
  world: CombatWorld;
  phase: ArenaPhase = 'BUY';
  round = 1;
  scoreUs = 0;
  scoreThem = 0;
  cash = 800;
  phaseTimer = 0;
  roundWinner: number | null = null;
  matchOver = false;
  playerVictory = false;
  kills = 0;
  damage = 0;
  private rng: RNG;
  private playerSpawn = { x: 0, y: 0, z: 0 };
  private enemySpawn = { x: 0, y: 0, z: 0 };
  private buyMap = new Map<string, string[]>();
  private targetDummies: Actor[] = [];
  private dummiesMoving = false;
  private dummyDrift = 0;

  constructor(
    public readonly terrain: TerrainData,
    public readonly layout: MapLayout,
    hooks: CombatHooks,
    public readonly config: ArenaConfig
  ) {
    this.rng = new RNG(config.seed);
    this.world = new CombatWorld(terrain, layout, hooks, config.seed);
    this.world.squadRules = config.kind === 'CLASH';
    this.cash = config.startCash;
    this.pickArena();
    this.spawnTeams();
    this.phase = config.kind === 'TRAINING' ? 'FIGHT' : 'BUY';
    this.phaseTimer = config.kind === 'TRAINING' ? 0 : config.buySeconds;
    bus.emit('match:started', { mode: config.kind, players: this.world.actors.length });
  }

  /** Chooses a flat, cover-rich area near the training range for the arena. */
  private pickArena(): void {
    const centre = this.layout.rangeCentre;
    const spots: { x: number; y: number; z: number }[] = [];
    for (const poi of this.layout.pois) {
      if (poi.type !== 'CITY' && poi.type !== 'INDUSTRIAL') continue;
      spots.push({ x: poi.x, y: poi.y, z: poi.z });
    }
    const base = spots.length > 0 ? spots[this.rng.int(0, spots.length - 1)] : centre;
    const spread = 34;
    this.playerSpawn = this.findSpawn(base.x - spread, base.z - spread, 14);
    this.enemySpawn = this.findSpawn(base.x + spread, base.z + spread, 14);
  }

  private findSpawn(x: number, z: number, radius: number): { x: number; y: number; z: number } {
    for (let attempt = 0; attempt < 40; attempt++) {
      const ang = this.rng.range(0, Math.PI * 2);
      const dist = this.rng.range(0, radius);
      const sx = x + Math.cos(ang) * dist;
      const sz = z + Math.sin(ang) * dist;
      const sy = sampleHeight(this.terrain, sx, sz);
      if (sy < 1.5) continue;
      return { x: sx, y: sy, z: sz };
    }
    return { x, y: sampleHeight(this.terrain, x, z), z };
  }

  private spawnTeams(): void {
    const { kind, teamSize } = this.config;
    if (kind === 'TRAINING') {
      this.spawnTrainingRange();
      return;
    }
    const isLone = kind === 'LONE';
    const locals = isLone ? 1 : teamSize;

    for (let i = 0; i < locals; i++) {
      const spawn = i === 0 ? this.playerSpawn : this.offset(this.playerSpawn, i);
      const actor = this.world.spawnActor({
        x: spawn.x, y: spawn.y + 0.4, z: spawn.z,
        yaw: Math.atan2(this.enemySpawn.x - spawn.x, this.enemySpawn.z - spawn.z),
        name: i === 0 ? 'You' : `Ally-${i}`,
        team: 0,
        isBot: i !== 0,
        isLocal: i === 0,
        difficulty: this.config.difficulty
      });
      actor.hasJumped = true;
      actor.squadRules = !isLone;
    }
    const enemies = isLone ? 1 : teamSize;
    for (let i = 0; i < enemies; i++) {
      const spawn = i === 0 ? this.enemySpawn : this.offset(this.enemySpawn, i);
      const actor = this.world.spawnActor({
        x: spawn.x, y: spawn.y + 0.4, z: spawn.z,
        yaw: Math.atan2(this.playerSpawn.x - spawn.x, this.playerSpawn.z - spawn.z),
        name: `Rival-${i + 1}`,
        team: 1,
        isBot: true,
        isLocal: false,
        difficulty: this.config.difficulty
      });
      actor.hasJumped = true;
      actor.squadRules = !isLone;
    }
    this.applyLoadouts();
  }

  private offset(spawn: { x: number; y: number; z: number }, index: number): { x: number; y: number; z: number } {
    const ang = (index / 4) * Math.PI * 2;
    const x = spawn.x + Math.cos(ang) * 3.5;
    const z = spawn.z + Math.sin(ang) * 3.5;
    return { x, y: sampleHeight(this.terrain, x, z), z };
  }

  /** Free-play range: local player + static target dummies + a couple of vehicles. */
  private spawnTrainingRange(): void {
    const c = this.layout.rangeCentre;
    const actor = this.world.spawnActor({
      x: c.x, y: c.y + 0.4, z: c.z + 18,
      yaw: Math.PI,
      name: 'You', team: 0, isBot: false, isLocal: true
    });
    actor.hasJumped = true;
    this.world.giveLoadout(actor, 'raven50', 'hornet9', {
      armorLevel: 3, helmetLevel: 3, backpackLevel: 3, ammoMult: 12,
      gadgets: ['medkit', 'bandage', 'frag', 'smoke']
    });
    // Dummies are stationary bots with no brain so they never shoot back.
    for (let i = 0; i < 6; i++) {
      const x = c.x - 16.5 + i * 6.6;
      for (const dist of [22, 40, 62]) {
        const z = c.z + 14 - dist;
        const dummy = this.world.spawnActor({
          x, y: sampleHeight(this.terrain, x, z) + 0.2, z,
          yaw: 0,
          name: `Target-${i + 1}`,
          team: 1,
          isBot: false,
          isLocal: false
        });
        dummy.hasJumped = true;
        this.targetDummies.push(dummy);
      }
    }
    this.respawnDummies();
  }

  private respawnDummies(): void {
    for (const dummy of this.targetDummies) {
      dummy.health = dummy.maxHealth;
      dummy.inventory.armorPoints = 0;
      dummy.lifeState = 'ALIVE';
      dummy.moveState = 'IDLE';
      dummy.velocity.set(0, 0, 0);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Loadouts + economy                                                 */
  /* ------------------------------------------------------------------ */

  private loadoutFor(actor: Actor): { primary: string; secondary: string } {
    const owned = this.buyMap.get(actor.isLocal ? 'local' : `bot-${actor.id}`) ?? [];
    const purchased = owned.filter((id) => WEAPONS[id]);
    const primary = purchased[purchased.length - 1] ?? (this.config.kind === 'LONE' ? 'raven50' : 'hornet9');
    const secondary = purchased.length > 1 ? purchased[0] : 'p9';
    void actor;
    return { primary, secondary };
  }

  private applyLoadouts(): void {
    for (const actor of this.world.actors) {
      if (this.config.kind === 'TRAINING') continue;
      const { primary, secondary } = this.loadoutFor(actor);
      const owned = this.buyMap.get(actor.isLocal ? 'local' : `bot-${actor.id}`) ?? [];
      const armorLevel = owned.includes('vest3') ? 3 : owned.includes('vest2') ? 2 : 1;
      const helmetLevel = owned.includes('helmet3') ? 3 : owned.includes('helmet2') ? 2 : 1;
      const packLevel = this.config.kind === 'LONE' ? 2 : 1;
      this.world.giveLoadout(actor, primary, secondary, {
        armorLevel,
        helmetLevel,
        backpackLevel: packLevel,
        ammoMult: 4,
        gadgets: ['medkit', 'bandage', 'frag', 'smoke'],
        primaryRarity: this.config.kind === 'LONE' ? 'RARE' : 'COMMON'
      });
      // Bots spend their cash on a sensible loadout each round.
      if (!actor.isLocal) this.botShopping(actor);
    }
  }

  /** Bots auto-buy so the arena economy stays believable. */
  private botShopping(actor: Actor): void {
    const key = `bot-${actor.id}`;
    const owned = this.buyMap.get(key) ?? [];
    let budget = Math.min(this.cash + 900, 4200);
    const wants: string[] = [];
    const weapon = BUY_POOL[clamp(Math.floor((this.round + this.rng.int(0, 2)) / 1.6), 0, BUY_POOL.length - 1)];
    if (this.config.kind !== 'LONE' && !owned.some((id) => WEAPONS[id])) {
      if (budget >= weapon.price) {
        wants.push(weapon.id);
        budget -= weapon.price;
      }
    }
    for (const gear of GEAR_POOL) {
      if (gear.kind !== 'GEAR') continue;
      if (owned.includes(gear.id)) continue;
      if (budget >= gear.price) {
        wants.push(gear.id);
        budget -= gear.price;
        break;
      }
    }
    if (wants.length > 0) this.buyMap.set(key, [...owned, ...wants]);
  }

  /** Player purchase during the buy phase. */
  purchase(actor: Actor, id: string, kind: string, price: number): boolean {
    if (price > this.cash) return false;
    const key = actor.isLocal ? 'local' : `bot-${actor.id}`;
    const owned = this.buyMap.get(key) ?? [];
    this.cash -= price;
    if (kind === 'WEAPON' || kind === 'GEAR') {
      this.buyMap.set(key, [...owned.filter((x) => x !== id), id]);
    } else if (kind === 'MEDICAL') {
      actor.inventory.addConsumable(id, 1);
    } else if (kind === 'THROWABLE') {
      actor.inventory.addThrowable(id, 1);
    }
    bus.emit('ui:toast', { text: `Purchased ${WEAPONS[id]?.name ?? GEAR[id]?.name ?? CONSUMABLES[id]?.name ?? THROWABLES[id]?.name ?? id}`, kind: 'good' });
    return true;
  }

  beginRound(): void {
    this.roundWinner = null;
    this.phase = 'COUNTDOWN';
    this.phaseTimer = 3;
    this.applyLoadouts();

  }

  startFight(): void {
    this.phase = 'FIGHT';
    this.phaseTimer = this.config.roundSeconds;
    bus.emit('round:started', { round: this.round });
  }

  /* ------------------------------------------------------------------ */
  /* Round loop                                                         */
  /* ------------------------------------------------------------------ */

  update(dt: number, playerInput: unknown): void {
    this.world.setPlayerInput(playerInput as never);
    this.world.update(dt);
    if (this.config.kind === 'TRAINING') {
      this.updateTraining(dt);
      return;
    }
    this.phaseTimer -= dt;

    switch (this.phase) {
      case 'BUY':
        if (this.phaseTimer <= 0) this.beginRound();
        break;
      case 'COUNTDOWN':
        if (this.phaseTimer <= 0) this.startFight();
        break;
      case 'FIGHT': {
        const us = this.world.actors.filter((a) => a.team === 0 && a.lifeState !== 'DEAD').length;
        const them = this.world.actors.filter((a) => a.team === 1 && a.lifeState !== 'DEAD').length;
        if (them === 0 && us > 0) this.endRound(0);
        else if (us === 0 && them > 0) this.endRound(1);
        else if (us === 0 && them === 0) this.endRound(-1);
        else if (this.phaseTimer <= 0) this.endRound(us >= them ? 0 : 1);
        break;
      }
      case 'ROUND_END': {
        if (this.phaseTimer <= 0) this.nextRound();
        break;
      }
      case 'MATCH_END':
        break;
    }
  }

  private updateTraining(dt: number): void {
    if (this.dummiesMoving) {
      this.dummyDrift += dt;
      for (let i = 0; i < this.targetDummies.length; i++) {
        const d = this.targetDummies[i];
        if (d.lifeState === 'DEAD') continue;
        const lane = (i % 6) * 6.6;
        const phase = (i / 6) * 1.1;
        const x = this.layout.rangeCentre.x - 16.5 + lane + Math.sin(this.dummyDrift * 0.6 + phase) * 5.5;
        const z = d.position.z;
        d.position.x = x;
        d.position.y = sampleHeight(this.terrain, x, z) + 0.2;
        d.yaw = Math.cos(this.dummyDrift * 0.6 + phase) > 0 ? Math.PI / 2 : -Math.PI / 2;
      }
    }
    const anyDead = this.targetDummies.some((d) => d.lifeState === 'DEAD');
    if (anyDead) this.respawnDummies();
    const player = this.world.localPlayer;
    if (player) {
      this.kills = player.kills;
      this.damage = player.damageDealt;
    }
  }

  private endRound(winner: number): void {
    this.phase = 'ROUND_END';
    this.phaseTimer = 3.2;
    this.roundWinner = winner;
    if (winner === 0) this.scoreUs++;
    else if (winner === 1) this.scoreThem++;
    // Economy: winning team earns more, losers get a comeback bonus.
    this.cash = clamp(this.cash + (winner === 0 ? 1400 : 900) + this.round * 120, 0, 9000);
    bus.emit('round:ended', { round: this.round, winnerTeam: winner });
    const local = this.world.localPlayer;
    if (local) {
      this.kills = local.kills;
      this.damage = local.damageDealt;
    }
    if (this.scoreUs >= this.config.roundsToWin || this.scoreThem >= this.config.roundsToWin) {
      this.matchOver = true;
      this.playerVictory = this.scoreUs > this.scoreThem;
      this.phase = 'MATCH_END';
      bus.emit('match:ended', { victory: this.playerVictory, placement: this.playerVictory ? 1 : 2 });
    }
  }

  private nextRound(): void {
    this.round++;
    this.buyMap.set('local', this.buyMap.get('local') ?? []);
    // Reset both teams to spawn and restore health/armor.
    const us = this.world.actors.filter((a) => a.team === 0);
    const them = this.world.actors.filter((a) => a.team === 1);
    us.forEach((a, i) => this.resetActor(a, this.offset(this.playerSpawn, i)));
    them.forEach((a, i) => this.resetActor(a, this.offset(this.enemySpawn, i)));
    this.phase = 'BUY';
    this.phaseTimer = this.config.buySeconds;
    bus.emit('round:started', { round: this.round });
  }

  private resetActor(actor: Actor, spawn: { x: number; y: number; z: number }): void {
    actor.lifeState = 'ALIVE';
    actor.health = actor.maxHealth;
    actor.downHealth = 100;
    actor.moveState = 'IDLE';
    actor.stance = 'STAND';
    actor.velocity.set(0, 0, 0);
    actor.position.set(spawn.x, spawn.y + 0.4, spawn.z);
    actor.yaw = Math.atan2(
      (actor.team === 0 ? this.enemySpawn.x : this.playerSpawn.x) - spawn.x,
      (actor.team === 0 ? this.enemySpawn.z : this.playerSpawn.z) - spawn.z
    );
    actor.healTimer = 0;
    actor.reviveProgress = 0;
    actor.reviveProgress = 0;
    actor.vehicleId = null;
    actor.hasJumped = true;
    this.world.giveLoadout(actor, this.loadoutFor(actor).primary, this.loadoutFor(actor).secondary, {
      armorLevel: 2, helmetLevel: 2, backpackLevel: 1, ammoMult: 4,
      gadgets: ['medkit', 'frag']
    });
  }

  /** Round/match summary for the UI. */
  summary(): { round: number; scoreUs: number; scoreThem: number; phase: ArenaPhase; matchOver: boolean; victory: boolean } {
    return {
      round: this.round,
      scoreUs: this.scoreUs,
      scoreThem: this.scoreThem,
      phase: this.phase,
      matchOver: this.matchOver,
      victory: this.playerVictory
    };
  }
}
