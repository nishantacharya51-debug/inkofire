/**
 * Throwaway aim diagnostic.
 * Separates "bots aim badly" from "bullets do not register" by measuring, for
 * every shot, the closest approach of the shot ray to any visible enemy.
 */
import * as THREE from 'three';
import { generateTerrain, WORLD_SIZE, TERRAIN_RES } from '../src/world/Terrain';
import { generateLayout } from '../src/world/MapLayout';
import { BattleRoyale } from '../src/modes/BattleRoyale';
import { emptyHooks, type CombatHooks } from '../src/modes/CombatWorld';
import type { Actor } from '../src/entity/Actor';

const SEED = Number(process.argv[2] ?? 20260926);
const PLAYERS = Number(process.argv[3] ?? 12);
const SECONDS = Number(process.argv[4] ?? 200);
const DIFF = (process.argv[5] ?? 'NORMAL') as 'EASY' | 'NORMAL' | 'HARD' | 'ELITE';

const terrain = generateTerrain(SEED, WORLD_SIZE, TERRAIN_RES);
const layout = generateLayout(terrain, SEED);

let shots = 0;
let aimed = 0;
let hits = 0;
let kills = 0;
let selfHits = 0;
let impacts = 0;
const aimMiss: number[] = [];
const hitDist: number[] = [];
let brRef: BattleRoyale | null = null;

const hooks: CombatHooks = {
  ...emptyHooks(),
  onWeaponSound: (actor) => {
    shots++;
    const world = brRef?.world;
    if (!world) return;
    const dir = actor.getAimDirection(new THREE.Vector3());
    const o = actor.eyePosition;
    let best = Infinity;
    let bestActor: Actor | null = null;
    for (const t of world.actors) {
      if (t.id === actor.id || t.lifeState === 'DEAD') continue;
      const d = rayToActor(o.x, o.y, o.z, dir.x, dir.y, dir.z, t);
      if (d < best) { best = d; bestActor = t; }
    }
    void bestActor;
    aimMiss.push(best);
    if (best < 0.7) aimed++;
  },
  onActorHit: (actor, _dmg, _part, _weapon, _isLocal, killed) => {
    hits++;
    if (killed) kills++;
    void actor;
  },
  onImpact: () => { impacts++; },
  onTracer: (x0, y0, z0, x1, y1, z1) => {
    hitDist.push(Math.hypot(x1 - x0, y1 - y0, z1 - z0));
  }
};

const br = new BattleRoyale(terrain, layout, {
  mode: 'BR_SOLO', playerCount: PLAYERS, difficulty: DIFF, teamSize: 1, seed: SEED, lobbySeconds: 0
}, hooks);
brRef = br;
br.startLobby(0);

const dt = 1 / 60;
for (let i = 0; i < Math.round(SECONDS / dt); i++) br.update(dt, null);

const sortP = (arr: number[], q: number): number => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

console.log(`difficulty ${DIFF}  players ${PLAYERS}  simulated ${SECONDS}s`);
console.log(`shots ${shots}   impacts ${impacts}   actor hits ${hits}   kills ${kills}`);
if (shots) console.log(`raw hit rate ${((100 * hits) / shots).toFixed(1)}%   impacts include world collisions`);
if (aimMiss.length) {
  console.log(`closest approach of the shot ray to an enemy: p10 ${sortP(aimMiss, 0.1).toFixed(2)} m  p50 ${sortP(aimMiss, 0.5).toFixed(2)} m  p90 ${sortP(aimMiss, 0.9).toFixed(2)} m`);
  console.log(`shots actually pointed at someone (<0.7 m): ${aimed} (${((100 * aimed) / shots).toFixed(1)}%)`);
  console.log(`hit registration: ${aimed ? ((100 * hits) / aimed).toFixed(1) : '0'}% of aimed shots hit`);
}
void selfHits;
if (hitDist.length) {
  const avg = hitDist.reduce((a, b) => a + b, 0) / hitDist.length;
  console.log(`avg tracer segment ${avg.toFixed(2)} m (per-substep, not bullet range)`);
}
console.log(`alive ${br.aliveCount}/${PLAYERS}  phase ${br.phase}`);

/** Closest approach (metres) of a ray to an actor's torso capsule, ignoring points behind the origin. */
function rayToActor(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, a: Actor
): number {
  const cx = a.position.x;
  const cy = a.position.y + a.bodyHeight * 0.55;
  const cz = a.position.z;
  // Ray/point distance, clamped to the segment in front of the muzzle.
  const vx = cx - ox, vy = cy - oy, vz = cz - oz;
  const t = vx * dx + vy * dy + vz * dz;
  if (t < 0) return Math.hypot(vx, vy, vz);
  const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
  return Math.hypot(cx - px, cy - py, cz - pz);
}
