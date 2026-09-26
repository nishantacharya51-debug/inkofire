import { generateTerrain, WORLD_SIZE, TERRAIN_RES } from '../src/world/Terrain';
import { generateMapLayout } from '../src/world/MapLayout';
import { BattleRoyale } from '../src/modes/BattleRoyale';
import { BotBrain, DIFFICULTIES } from '../src/ai/BotBrain';
import { emptyHooks } from '../src/modes/CombatWorld';
import { RNG } from '../src/utils/rng';
import type { BotBrain as BB } from '../src/ai/BotBrain';

const SEED = 20260926;
const terrain = generateTerrain(SEED, WORLD_SIZE, TERRAIN_RES);
const layout = generateMapLayout(terrain, SEED);
const br = new BattleRoyale(terrain, layout, { mode: 'BR_SOLO', playerCount: 20, difficulty: 'NORMAL', teamSize: 1, seed: SEED, lobbySeconds: 0 }, emptyHooks());
const p = br.localPlayer!;
const brain = new BotBrain(p, DIFFICULTIES.NORMAL, new RNG(SEED + 7));
br.startLobby(0.01);
const dt = 1/60;
for (let i = 0; i < 240 * 60; i++) {
  const input = brain.update(dt, br.world.aiContext());
  br.world.localWantsAds = brain.wantsAds;
  br.world.localWantsFire = brain.wantsFire;
  br.world.localTriggerHeld = brain.wantsFire;
  br.update(dt, input);
  if (i % (20 * 60) === 0) {
    const b = brain as BB;
    console.log(`t=${(i*dt).toFixed(0)}s hp=${p.health.toFixed(0)} state=${p.lifeState} mv=${p.moveState} pos=(${p.position.x.toFixed(0)},${p.position.y.toFixed(0)},${p.position.z.toFixed(0)}) brain=${b.state} target=${b.target ? b.target.name : '-'} aw=${b.targetAwareness.toFixed(2)} wantsFire=${brain.wantsFire} weapon=${p.inventory.active?.defId ?? 'NONE'} mag=${p.inventory.active?.ammoInMag ?? 0} shotsFired=${p.shotsFired} dmg=${p.damageDealt.toFixed(0)} kills=${p.kills} goal=${b.goal?`(${b.goal.x.toFixed(0)},${b.goal.z.toFixed(0)})/${b.goalKind}`:'-'} dist=${p.distanceTravelled.toFixed(0)}`);
  }
  if (p.lifeState === 'DEAD') { console.log('player died at', (i*dt).toFixed(0), 's'); break; }
}
