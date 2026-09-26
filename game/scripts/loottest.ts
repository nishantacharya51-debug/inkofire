import { generateTerrain, WORLD_SIZE, TERRAIN_RES, sampleHeight } from '../src/world/Terrain';
import { generateMapLayout } from '../src/world/MapLayout';
import { CombatWorld, emptyHooks } from '../src/modes/CombatWorld';
import { RNG } from '../src/utils/rng';

const SEED = 20260926;
const terrain = generateTerrain(SEED, WORLD_SIZE, TERRAIN_RES);
const layout = generateMapLayout(terrain, SEED);
const world = new CombatWorld(terrain, layout, emptyHooks(), SEED);

console.log('loot items in world:', world.loot.items.length);
console.log('vehicles:', world.vehicles.count);
const weaponItems = world.loot.items.filter(i => i.kind === 'WEAPON');
console.log('weapon items:', weaponItems.length);

// Test claim: put an actor exactly on the first weapon item
const item = weaponItems[0];
console.log('first weapon item:', item.itemId, item.rarity, 'at', item.x.toFixed(1), item.y.toFixed(1), item.z.toFixed(1));
const actor = world.spawnActor({ x: item.x, y: sampleHeight(terrain, item.x, item.z), z: item.z, isBot: false, isLocal: true, name: 'Tester' });
console.log('actor created, pos', actor.position.x.toFixed(1), actor.position.y.toFixed(1), actor.position.z.toFixed(1));
const ok = world.loot.claim(actor, item.id);
console.log('claim returned:', ok, 'active weapon:', actor.inventory.active?.defId ?? 'none', 'slot0:', actor.inventory.weapons[0]?.defId ?? 'empty');

// Test auto pickup path
const item2 = world.loot.items.find(i => i.kind === 'WEAPON' && i.claimed === 0);
if (item2) {
  const a2 = world.spawnActor({ x: item2.x, y: sampleHeight(terrain, item2.x, item2.z), z: item2.z, isBot: true, name: 'Bot' });
  a2.position.y = item2.y - 0.6;
  world.autoPickupEnabledFlag(true);
  for (let i = 0; i < 10; i++) world.update(1/60);
  console.log('bot after 10 steps: weapon =', a2.inventory.active?.defId ?? 'none', ' pos.y', a2.position.y.toFixed(2), ' item.y', item2.y.toFixed(2));
  console.log('nearest to bot:', world.loot.nearest(a2.position.x, a2.position.y + 0.6, a2.position.z, 2.3)?.itemId ?? 'nothing');
}

// Weapon fire test
const shooter = world.spawnActor({ x: 40, y: sampleHeight(terrain, 40, 0), z: 0, isBot: false, isLocal: true, name: 'Shooter' });
shooter.position.y = sampleHeight(terrain, 40, 0);
world.giveLoadout(shooter, 'ar4', 'p9', { armorLevel: 2, helmetLevel: 2 });
console.log('shooter loadout:', shooter.inventory.weapons.map(w => w?.defId ?? '-').join(','), 'ammo', JSON.stringify(shooter.inventory.ammo));
const target = world.spawnActor({ x: 40, y: sampleHeight(terrain, 40, -25), z: -25, isBot: false, name: 'Target' });
target.position.y = sampleHeight(terrain, 40, -25);
shooter.yaw = Math.atan2(-(target.position.x - shooter.position.x), -(target.position.z - shooter.position.z));
shooter.pitch = 0;

let shots = 0, hits = 0;
world.hooks.onActorHit = (a, dmg) => { hits++; console.log('  HIT', a.name, dmg.toFixed(1)); };
world.hooks.onWeaponSound = () => { shots++; };

world.setPlayerInput({ moveX: 0, moveY: 0, lookYaw: shooter.yaw, lookPitch: 0, jump: false, crouch: false, prone: false, sprint: false, walkSlow: false });
world.localTriggerHeld = true;
for (let i = 0; i < 240; i++) {
  world.localTriggerHeld = true;
  world.update(1/60);
  if (i === 120) { console.log('  shots so far', shots, 'hits', hits, 'target hp', target.health.toFixed(1)); }
}
console.log('after 4s of fire: shots =', shots, 'hits =', hits, 'target hp =', target.health.toFixed(1), 'target state', target.lifeState);
