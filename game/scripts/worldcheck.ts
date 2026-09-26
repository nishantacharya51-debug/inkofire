import { generateTerrain, sampleHeight, WORLD_SIZE, TERRAIN_RES } from '../src/world/Terrain.ts';
import { generateMapLayout } from '../src/world/MapLayout.ts';

const t0 = Date.now();
const terrain = generateTerrain(20260926, WORLD_SIZE, TERRAIN_RES);
const t1 = Date.now();
const layout = generateMapLayout(terrain, 20260926);
const t2 = Date.now();

console.log(`terrain gen: ${t1 - t0}ms   layout gen: ${t2 - t1}ms`);
console.log('POIs:', layout.pois.map(p => `${p.name}(${p.type})`).join(', '));
console.log('boxes:', layout.boxes.length, ' buildings:', layout.buildings.length, ' loot:', layout.lootSpots.length);
console.log('trees:', layout.trees.length, 'rocks:', layout.rocks.length, 'bushes:', layout.bushes.length);
console.log('spawnPoints:', layout.spawnPoints.length, 'landingZones:', layout.botLandingZones.length, 'vehicles:', layout.vehicleSpawns.length, 'roads:', layout.roads.length, 'landmarks:', layout.landmarks.length);
const collide = layout.boxes.filter(b => b.collide).length;
console.log('collide boxes:', collide);
// sanity: any box with NaN?
let bad = 0;
for (const b of layout.boxes) if (!isFinite(b.x) || !isFinite(b.y) || !isFinite(b.z) || !isFinite(b.w) || !isFinite(b.h) || !isFinite(b.d)) bad++;
console.log('NaN boxes:', bad);
// loot spots must be on land
let below = 0;
for (const l of layout.lootSpots) { const h = sampleHeight(terrain, l.x, l.z); if (h < 0.5) below++; }
console.log('loot under water:', below);
// tri estimate
const tris = layout.boxes.length * 12;
console.log('static tris ~', tris);
const treeTris = layout.trees.length * 64 + layout.rocks.length * 60 + layout.bushes.length * 40;
console.log('veg tris ~', treeTris);
let maxH = -1e9, minH = 1e9;
for (let i = 0; i < terrain.heights.length; i++) { maxH = Math.max(maxH, terrain.heights[i]); minH = Math.min(minH, terrain.heights[i]); }
console.log('height range', minH.toFixed(1), maxH.toFixed(1));

// Structure sanity: interior loot must sit inside a building footprint.
let interior = 0;
let inside = 0;
for (const l of layout.lootSpots) {
  if (!l.indoor) continue;
  interior++;
  for (const b of layout.buildings) {
    if (Math.abs(l.x - b.x) < b.radius && Math.abs(l.z - b.z) < b.radius && l.y > b.y - 0.5) { inside++; break; }
  }
}
console.log('interior loot:', interior, 'inside a building footprint:', inside);
const perPoi = new Map<string, number>();
for (const b of layout.buildings) {
  let best = layout.pois[0], bestD = Infinity;
  for (const p of layout.pois) { const d = (p.x-b.x)**2 + (p.z-b.z)**2; if (d < bestD) { bestD = d; best = p; } }
  perPoi.set(best.name, (perPoi.get(best.name) ?? 0) + 1);
}
console.log('buildings per POI:', [...perPoi.entries()].map(([k,v]) => `${k}:${v}`).join(' '));
