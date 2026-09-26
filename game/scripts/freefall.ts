import { generateTerrain, WORLD_SIZE, TERRAIN_RES } from '../src/world/Terrain';
import { generateMapLayout } from '../src/world/MapLayout';
import { BattleRoyale } from '../src/modes/BattleRoyale';
import { emptyHooks } from '../src/modes/CombatWorld';

const SEED = 20260926;
const terrain = generateTerrain(SEED, WORLD_SIZE, TERRAIN_RES);
const layout = generateMapLayout(terrain, SEED);
const br = new BattleRoyale(terrain, layout, { mode: 'BR_SOLO', playerCount: 4, difficulty: 'NORMAL', teamSize: 1, seed: SEED, lobbySeconds: 0 }, emptyHooks());
br.startLobby(0.01);
const dt = 1/60;
for (let i = 0; i < 40 * 60; i++) {
  br.update(dt, null);
  if (i % 60 === 0) {
    const p = br.localPlayer!;
    console.log(`t=${(i*dt).toFixed(1)} phase=${br.phase} jump=${p.hasJumped} move=${p.moveState} y=${p.position.y.toFixed(1)} vy=${p.velocity.y.toFixed(1)} ground=${p.groundHeight.toFixed(1)} chute=${p.parachuteOpen} hp=${p.health.toFixed(0)}`);
  }
}
