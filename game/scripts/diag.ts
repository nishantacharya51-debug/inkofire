import { generateTerrain, WORLD_SIZE, TERRAIN_RES } from '../src/world/Terrain';
import { generateMapLayout } from '../src/world/MapLayout';
import { BattleRoyale } from '../src/modes/BattleRoyale';
import { emptyHooks } from '../src/modes/CombatWorld';
import type { BotBrain } from '../src/ai/BotBrain';

const SEED = 20260926;
const terrain = generateTerrain(SEED, WORLD_SIZE, TERRAIN_RES);
const layout = generateMapLayout(terrain, SEED);
const br = new BattleRoyale(terrain, layout, { mode: 'BR_SOLO', playerCount: 12, difficulty: 'NORMAL', teamSize: 1, seed: SEED, lobbySeconds: 0 }, emptyHooks());
br.startLobby(0.01);
const dt = 1/60;
for (let i = 0; i < 120 * 60; i++) {
  br.update(dt, null);
  if (i === 45 * 60 || i === 75 * 60) {
    console.log(`--- t=${(i*dt).toFixed(0)}s  armed=${br.world.actors.filter(a=>a.inventory.active).length}/${br.world.actors.length} claimed=${br.world.loot.items.filter(l=>l.claimed>0).length} ---`);
    for (const a of br.world.actors.slice(0, 5)) {
      const b = br.world.brains.get(a.id) as BotBrain | undefined;
      const nearest = br.world.loot.nearest(a.position.x, a.position.y + 0.6, a.position.z, 30);
      console.log(`  ${a.name.padEnd(14)} mv=${a.moveState.padEnd(10)} br=${(b?.state ?? '-').padEnd(10)} pos=(${a.position.x.toFixed(0)},${a.position.y.toFixed(1)},${a.position.z.toFixed(0)}) onG=${a.onGround} spd=${a.speed.toFixed(1)} dist=${a.distanceTravelled.toFixed(0)} goal=${b?.goal?`(${b.goal.x.toFixed(0)},${b.goal.z.toFixed(0)})/${b.goalKind}`:'-'} path=${b?.path.length ?? 0} loot@${nearest?nearest.itemId+'/'+Math.hypot(nearest.x-a.position.x,nearest.z-a.position.z).toFixed(0)+'m':'-'}`);
    }
  }
}
