/**
 * Headless match simulator — runs a real Battle Royale end-to-end with no
 * renderer, using the exact same simulation code the browser runs.
 * This is the primary automated QA gate for gameplay logic.
 */
import { generateTerrain, WORLD_SIZE, TERRAIN_RES } from '../src/world/Terrain';
import { generateMapLayout } from '../src/world/MapLayout';
import { BattleRoyale } from '../src/modes/BattleRoyale';
import { BotBrain, DIFFICULTIES } from '../src/ai/BotBrain';
import { RNG } from '../src/utils/rng';
import { emptyHooks, type CombatHooks } from '../src/modes/CombatWorld';

const SEED = Number(process.argv[2] ?? 20260926);
const PLAYERS = Number(process.argv[3] ?? 30);
const MAX_SECONDS = Number(process.argv[4] ?? 900);
const DIFFICULTY = (process.argv[5] ?? 'NORMAL') as 'EASY' | 'NORMAL' | 'HARD' | 'ELITE';

const t0 = Date.now();
const terrain = generateTerrain(SEED, WORLD_SIZE, TERRAIN_RES);
const layout = generateMapLayout(terrain, SEED);
const genMs = Date.now() - t0;

let shots = 0;
let hits = 0;
let kills = 0;
let explosions = 0;
let throws = 0;
const hooks: CombatHooks = {
  ...emptyHooks(),
  onWeaponSound: () => { shots++; },
  onActorHit: (_a, _d, _p, _w, _l, killed) => { hits++; if (killed) kills++; },
  onExplosion: () => { explosions++; }
};

const br = new BattleRoyale(terrain, layout, {
  mode: 'BR_SOLO',
  playerCount: PLAYERS,
  difficulty: DIFFICULTY,
  teamSize: 1,
  seed: SEED,
  lobbySeconds: 0
}, hooks);

// Give the local player a brain so the harness can play the match like a bot.
const rng = new RNG(SEED + 7);
const player = br.localPlayer!;
const brain = new BotBrain(player, DIFFICULTIES.NORMAL, rng);

br.startLobby(0.01);
const dt = 1 / 60;
let steps = 0;
let maxAlive = 0;
const phaseTimes: Record<string, number> = {};
let lastPhase = br.phase;
const wallStart = Date.now();

while (!br.ended && steps * dt < MAX_SECONDS) {
  const ctx = br.world.aiContext();
  const input = brain.update(dt, ctx);
  // Mirror how the game layer maps player intent into the combat world.
  br.world.localWantsAds = brain.wantsAds;
  br.world.localWantsFire = brain.wantsFire;
  br.world.localTriggerHeld = brain.wantsFire;
  br.update(dt, input);
  steps++;
  if (br.phase !== lastPhase) {
    phaseTimes[lastPhase] = steps * dt;
    lastPhase = br.phase;
  }
  maxAlive = Math.max(maxAlive, br.aliveCount);
  // Fail fast on corruption
  if (!isFinite(player.position.x) || !isFinite(player.position.y)) {
    throw new Error(`Non-finite player position at t=${(steps * dt).toFixed(1)}s`);
  }
  if (steps % 3600 === 0) {
    const armed = br.world.actors.filter(a => a.inventory.active !== null).length;
    const alive = br.world.actors.filter(a => a.lifeState !== 'DEAD').length;
    console.log(`  t=${(steps * dt).toFixed(0)}s alive=${alive} armed=${armed} zone=phase${br.zone.phase + 1} r=${br.zone.radius.toFixed(0)} playerHP=${player.health.toFixed(0)} kills=${player.kills}`);
    // kill AI throws for the log
    void throws;
  }
}

const simMs = Date.now() - wallStart;
const simSeconds = steps * dt;
const armed = br.world.actors.filter(a => a.inventory.active !== null).length;
const alive = br.world.actors.filter(a => a.lifeState !== 'DEAD').length;
const lootTaken = layout.lootSpots.length; // rough
void lootTaken;

console.log('\n===== SIMULATION REPORT =====');
console.log(`world gen:            ${genMs} ms`);
console.log(`simulated:            ${simSeconds.toFixed(1)} s  (${(simSeconds / (simMs / 1000)).toFixed(1)}x realtime)`);
console.log(`match ended:          ${br.ended}   victory=${br.victory}  placement=${br.placement}`);
console.log(`alive at end:         ${alive} / ${PLAYERS}   (teams left ${br.teamCount})`);
console.log(`armed bots:           ${armed}`);
console.log(`player:               kills=${player.kills} damage=${player.damageDealt.toFixed(0)} hp=${player.health.toFixed(0)} state=${player.lifeState} move=${player.moveState}`);
console.log(`shots/hits:           ${shots} / ${hits}  (${shots ? ((hits / shots) * 100).toFixed(1) : '0'}% hit rate incl. pellet spread)`);
console.log(`eliminations (hook):  ${kills}   explosions=${explosions}`);
console.log(`phase transitions:    ${JSON.stringify(phaseTimes)}`);
console.log(`aircraft path:        (${br.aircraft.startX.toFixed(0)},${br.aircraft.startZ.toFixed(0)}) -> (${br.aircraft.endX.toFixed(0)},${br.aircraft.endZ.toFixed(0)})`);
console.log(`zone:                 phase ${br.zone.phase + 1} radius ${br.zone.radius.toFixed(0)}`);
const stuckBots = br.world.actors.filter(a => a.lifeState !== 'DEAD' && a.distanceTravelled < 5).length;
console.log(`idle alive bots:      ${stuckBots} (should be small; zone forces movement)`);
console.log(`peak alive:           ${maxAlive}`);
