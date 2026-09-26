import * as THREE from 'three';
import { Biome, sampleHeight, type TerrainData } from '../world/Terrain';
import type { MapLayout } from '../world/MapLayout';
import { StaticBatcher, makeBox, type SurfaceKind } from '../utils/geo';
import { Textures } from '../utils/textures';
import { settings } from '../core/Settings';

/**
 * Builds and draws the island: chunked terrain with LOD, sky, water, batched
 * static geometry, chunked instanced vegetation, loot pickups and vehicles.
 */

const CHUNKS = 10;
const TREE_CHUNKS = 12;

interface TerrainChunk {
  lod0: THREE.Mesh;
  lod1: THREE.Mesh;
  centerX: number;
  centerZ: number;
  radius: number;
}

interface VegChunk {
  group: THREE.Group;
  centerX: number;
  centerZ: number;
  radius: number;
}

export interface VehicleVisual {
  id: number;
  body: THREE.Mesh;
  wheels: THREE.Mesh[];
  group: THREE.Group;
  wreck: THREE.Mesh | null;
}

const SKY_VERT = `
varying vec3 vWorldPosition;
void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = `
uniform vec3 topColor;
uniform vec3 bottomColor;
uniform vec3 sunDirection;
uniform vec3 sunColor;
varying vec3 vWorldPosition;
void main() {
  vec3 dir = normalize(vWorldPosition);
  float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 sky = mix(bottomColor, topColor, pow(h, 0.72));
  float sun = max(dot(dir, normalize(sunDirection)), 0.0);
  sky += sunColor * pow(sun, 240.0) * 1.6;
  sky += sunColor * pow(sun, 8.0) * 0.14;
  gl_FragColor = vec4(sky, 1.0);
}`;

const RARITY_HEX: Record<string, number> = {
  COMMON: 0xb9c2cb,
  UNCOMMON: 0x5fd07a,
  RARE: 0x4aa8ff,
  EPIC: 0xc07bff,
  LEGENDARY: 0xffb347
};

export class WorldRenderer {
  readonly root = new THREE.Group();
  readonly staticGroup: THREE.Group;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly ambient: THREE.AmbientLight;
  private terrainChunks: TerrainChunk[] = [];
  private vegChunks: VegChunk[] = [];
  private water: THREE.Mesh | null = null;
  private sky: THREE.Mesh | null = null;
  private lootMeshes: THREE.InstancedMesh[] = [];
  private lootBeams: THREE.InstancedMesh | null = null;
  private lootIds: number[][] = [];
  private lootDummy = new THREE.Object3D();
  private vehicleVisuals: VehicleVisual[] = [];
  private lootRefreshTimer = 0;
  private vegTimer = 0;
  private staticMeshes: THREE.Mesh[] = [];
  private totalTriangles = 0;
  private vehicleIndex = new Map<number, VehicleVisual>();

  constructor(
    private scene: THREE.Scene,
    private terrain: TerrainData,
    private layout: MapLayout
  ) {
    this.staticGroup = new THREE.Group();
    this.staticGroup.name = 'staticWorld';
    this.root.add(this.staticGroup);

    // Lighting
    this.hemi = new THREE.HemisphereLight(0xbcd4e6, 0x50533f, 0.55);
    this.scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.18);
    this.scene.add(this.ambient);
    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.05);
    const sunDir = new THREE.Vector3(0.45, 0.72, -0.52).normalize();
    this.sun.position.copy(sunDir).multiplyScalar(220);
    this.sun.castShadow = settings.graphics.shadows;
    this.sun.shadow.mapSize.set(settings.graphics.shadowQuality || 1024, settings.graphics.shadowQuality || 1024);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 520;
    const shadowSpan = settings.resolvedQuality === 'LOW' ? 42 : settings.resolvedQuality === 'MEDIUM' ? 62 : settings.resolvedQuality === 'HIGH' ? 80 : 96;
    this.sun.shadow.camera.left = -shadowSpan;
    this.sun.shadow.camera.right = shadowSpan;
    this.sun.shadow.camera.top = shadowSpan;
    this.sun.shadow.camera.bottom = -shadowSpan;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.buildSky(sunDir);
    this.buildTerrainChunks();
    this.buildWater();
    this.buildStaticGeometry();
    this.buildVegetation();
    this.buildLootVisuals();
    this.scene.add(this.root);
  }

  /* ---------------------------------------------------------------- */
  /* Sky + water                                                      */
  /* ---------------------------------------------------------------- */

  private buildSky(sunDir: THREE.Vector3): void {
    const geo = new THREE.SphereGeometry(2600, 24, 16);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x2c5d92) },
        bottomColor: { value: new THREE.Color(0xc9d9e4) },
        sunDirection: { value: sunDir.clone() },
        sunColor: { value: new THREE.Color(0xfff0d0) }
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.root.add(this.sky);
    this.scene.fog = new THREE.FogExp2(0xa9c1d4, 0.0016);
  }

  private buildWater(): void {
    const geo = new THREE.PlaneGeometry(this.terrain.size * 3, this.terrain.size * 3, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const normalMap = Textures.waterNormal();
    normalMap.repeat.set(90, 90);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2c6f8c,
      roughness: 0.18,
      metalness: 0.35,
      transparent: true,
      opacity: 0.82,
      normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6)
    });
    this.water = new THREE.Mesh(geo, mat);
    this.water.position.y = this.terrain.waterLevel;
    this.water.receiveShadow = false;
    this.water.renderOrder = 1;
    this.root.add(this.water);
  }

  /* ---------------------------------------------------------------- */
  /* Terrain                                                          */
  /* ---------------------------------------------------------------- */

  private biomeColor(biome: number, height: number, out: THREE.Color): void {
    switch (biome) {
      case Biome.WATER: out.setHex(0x39566b); break;
      case Biome.BEACH: out.setHex(0xc9b487); break;
      case Biome.GRASS: out.setHex(0x5c7a44); break;
      case Biome.FOREST: out.setHex(0x3f6034); break;
      case Biome.ROCK: out.setHex(0x6e6a63); break;
      case Biome.MOUNTAIN: out.setHex(0x8a877f); break;
      case Biome.SNOW: out.setHex(0xd8dde2); break;
      case Biome.DIRT: out.setHex(0x6f5f45); break;
      case Biome.ASPHALT: out.setHex(0x4a4a4c); break;
      default: out.setHex(0x5c7a44); break;
    }
    // Slight height-based variation keeps flat areas from looking painted.
    const shade = 0.92 + (height / 120) * 0.16;
    out.multiplyScalar(shade);
  }

  private buildChunkGeometry(step: number, i0: number, j0: number, cells: number): THREE.BufferGeometry {
    const t = this.terrain;
    const res = t.res;
    const vertsPerSide = Math.floor(cells / step) + 1;
    const positions = new Float32Array(vertsPerSide * vertsPerSide * 3);
    const normals = new Float32Array(vertsPerSide * vertsPerSide * 3);
    const uvs = new Float32Array(vertsPerSide * vertsPerSide * 2);
    const colors = new Float32Array(vertsPerSide * vertsPerSide * 3);
    const indices: number[] = [];
    const color = new THREE.Color();
    const normal = { x: 0, y: 1, z: 0 };

    for (let vj = 0; vj < vertsPerSide; vj++) {
      for (let vi = 0; vi < vertsPerSide; vi++) {
        const ci = Math.min(res, i0 + vi * step);
        const cj = Math.min(res, j0 + vj * step);
        const x = -t.half + ci * t.cell;
        const z = -t.half + cj * t.cell;
        const y = t.heights[cj * (res + 1) + ci];
        const idx = (vj * vertsPerSide + vi) * 3;
        positions[idx] = x;
        positions[idx + 1] = y;
        positions[idx + 2] = z;

        // Cheap analytic normal from neighbour samples.
        const hL = t.heights[cj * (res + 1) + Math.max(0, ci - 1)];
        const hR = t.heights[cj * (res + 1) + Math.min(res, ci + 1)];
        const hD = t.heights[Math.max(0, cj - 1) * (res + 1) + ci];
        const hU = t.heights[Math.min(res, cj + 1) * (res + 1) + ci];
        normal.x = (hL - hR) / (2 * t.cell);
        normal.z = (hD - hU) / (2 * t.cell);
        normal.y = 1;
        const len = Math.hypot(normal.x, normal.y, normal.z);
        normals[idx] = normal.x / len;
        normals[idx + 1] = normal.y / len;
        normals[idx + 2] = normal.z / len;

        uvs[(vj * vertsPerSide + vi) * 2] = x / 26;
        uvs[(vj * vertsPerSide + vi) * 2 + 1] = z / 26;

        this.biomeColor(t.biome[cj * (res + 1) + ci], y, color);
        colors[idx] = color.r;
        colors[idx + 1] = color.g;
        colors[idx + 2] = color.b;
      }
    }
    for (let vj = 0; vj < vertsPerSide - 1; vj++) {
      for (let vi = 0; vi < vertsPerSide - 1; vi++) {
        const a = vj * vertsPerSide + vi;
        const b = a + 1;
        const c = a + vertsPerSide;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return geo;
  }

  private buildTerrainChunks(): void {
    const t = this.terrain;
    const cellsPerChunk = Math.floor(t.res / CHUNKS);
    const detail = Textures.grass();
    detail.repeat.set(1, 1);
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      map: detail,
      normalMap: Textures.grassNormal(),
      normalScale: new THREE.Vector2(0.45, 0.45)
    });

    for (let cj = 0; cj < CHUNKS; cj++) {
      for (let ci = 0; ci < CHUNKS; ci++) {
        const i0 = ci * cellsPerChunk;
        const j0 = cj * cellsPerChunk;
        const lod0 = new THREE.Mesh(this.buildChunkGeometry(1, i0, j0, cellsPerChunk), mat);
        const lod1 = new THREE.Mesh(this.buildChunkGeometry(2, i0, j0, cellsPerChunk), mat);
        lod0.receiveShadow = true;
        lod1.receiveShadow = true;
        lod1.visible = false;
        lod0.matrixAutoUpdate = false;
        lod1.matrixAutoUpdate = false;
        lod0.updateMatrix();
        lod1.updateMatrix();
        const centerX = -t.half + (i0 + cellsPerChunk / 2) * t.cell;
        const centerZ = -t.half + (j0 + cellsPerChunk / 2) * t.cell;
        const radius = cellsPerChunk * t.cell * 0.72;
        this.root.add(lod0, lod1);
        this.terrainChunks.push({ lod0, lod1, centerX, centerZ, radius });
        const tris = lod0.geometry.index ? lod0.geometry.index.count / 3 : 0;
        this.totalTriangles += tris;
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Static geometry                                                  */
  /* ---------------------------------------------------------------- */

  private buildStaticGeometry(): void {
    const batcher = new StaticBatcher('island');
    for (const b of this.layout.boxes) {
      batcher.add(b.kind, makeBox(b.x, b.y, b.z, b.w, b.h, b.d, { rotY: b.rotY ?? 0, tile: b.tile ?? 2 }), false);
    }
    // Roads: thin slabs following the road polylines.
    for (const road of this.layout.roads) {
      if (road.kind === 'runway') continue;
      const half = road.width / 2;
      for (let i = 0; i < road.points.length - 1; i++) {
        const a = road.points[i];
        const b = road.points[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.5) continue;
        const rotY = Math.atan2(dz, dx);
        const cx = (a.x + b.x) / 2;
        const cz = (a.z + b.z) / 2;
        const y = (sampleHeight(this.terrain, a.x, a.z) + sampleHeight(this.terrain, b.x, b.z)) / 2 + 0.08;
        const surface: SurfaceKind = road.kind === 'trail' ? 'sand' : 'asphalt';
        batcher.add(surface, makeBox(cx, y, cz, len, 0.16, half * 2, { rotY, tile: 4 }), false);
      }
    }
    // Foliage-style ground detail: hedges / bushes as batched cards is handled by
    // the instanced vegetation pass instead.
    const group = batcher.finalize();
    this.staticGroup.add(group);
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) this.staticMeshes.push(m);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Vegetation (chunked instancing)                                  */
  /* ---------------------------------------------------------------- */

  private buildVegetation(): void {
    const density = settings.graphics.vegetationDensity;
    const treesByChunk = new Map<number, typeof this.layout.trees>();
    const chunkSize = this.terrain.size / TREE_CHUNKS;
    const key = (x: number, z: number): number => {
      const ix = Math.floor((x + this.terrain.half) / chunkSize);
      const iz = Math.floor((z + this.terrain.half) / chunkSize);
      return ix * TREE_CHUNKS + iz;
    };
    for (const tree of this.layout.trees) {
      const k = key(tree.x, tree.z);
      let arr = treesByChunk.get(k);
      if (!arr) {
        arr = [];
        treesByChunk.set(k, arr);
      }
      arr.push(tree);
    }

    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 3.4, 6, 1, false);
    trunkGeo.translate(0, 1.7, 0);
    const canopyGeo = new THREE.IcosahedronGeometry(1.7, 0);
    canopyGeo.translate(0, 4.1, 0);
    const canopyGeo2 = new THREE.IcosahedronGeometry(1.25, 0);
    canopyGeo2.translate(0, 5.3, 0);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x53422e, roughness: 0.92 });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x3d6b34, roughness: 0.88, flatShading: true });
    const rockGeo = new THREE.IcosahedronGeometry(1, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x7a756c, roughness: 0.94, flatShading: true, map: Textures.rock() });
    const bushGeo = new THREE.IcosahedronGeometry(0.7, 0);
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x46632f, roughness: 0.95, flatShading: true });

    const dust = new THREE.Object3D();
    const maxPerChunk = 260;

    for (const [, trees] of treesByChunk) {
      const group = new THREE.Group();
      const list = trees.filter((_, i) => (i % 100) / 100 < density || density >= 1);
      if (list.length === 0) continue;

      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, Math.min(list.length, maxPerChunk));
      const canopies = new THREE.InstancedMesh(canopyGeo, leafMat, Math.min(list.length, maxPerChunk));
      const canopies2 = new THREE.InstancedMesh(canopyGeo2, leafMat, Math.min(list.length, maxPerChunk));
      let n = 0;
      for (const tree of list) {
        if (n >= maxPerChunk) break;
        dust.position.set(tree.x, tree.y - 0.2, tree.z);
        dust.rotation.set(0, tree.rotY, 0);
        dust.scale.setScalar(tree.scale);
        dust.updateMatrix();
        trunks.setMatrixAt(n, dust.matrix);
        canopies.setMatrixAt(n, dust.matrix);
        canopies2.setMatrixAt(n, dust.matrix);
        // Slight per-tree colour variation
        const shade = 0.8 + ((tree.x * 13 + tree.z * 7) % 40) / 100;
        canopies.setColorAt(n, new THREE.Color(0.35 * shade + 0.15, 0.62 * shade + 0.18, 0.3 * shade + 0.12));
        canopies2.setColorAt(n, new THREE.Color(0.33 * shade + 0.14, 0.58 * shade + 0.16, 0.28 * shade + 0.1));
        n++;
      }
      trunks.count = n;
      canopies.count = n;
      canopies2.count = n;
      trunks.castShadow = true;
      canopies.castShadow = true;
      canopies2.castShadow = false;
      trunks.instanceMatrix.needsUpdate = true;
      canopies.instanceMatrix.needsUpdate = true;
      canopies2.instanceMatrix.needsUpdate = true;
      if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
      if (canopies2.instanceColor) canopies2.instanceColor.needsUpdate = true;
      group.add(trunks, canopies, canopies2);
      const first = list[0];
      this.vegChunks.push({ group, centerX: first.x, centerZ: first.z, radius: chunkSize * 0.75 });
      this.root.add(group);
    }

    // Rocks + bushes as two global instanced sets (they are static and cheap).
    if (this.layout.rocks.length > 0) {
      const count = Math.floor(this.layout.rocks.length * Math.max(0.35, density));
      const mesh = new THREE.InstancedMesh(rockGeo, rockMat, count);
      for (let i = 0; i < count; i++) {
        const r = this.layout.rocks[i];
        dust.position.set(r.x, r.y + r.scale * 0.35, r.z);
        dust.rotation.set(0, r.rotY, 0);
        dust.scale.set(r.scale * 1.1, r.scale * 0.8, r.scale * 1.1);
        dust.updateMatrix();
        mesh.setMatrixAt(i, dust.matrix);
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      this.root.add(mesh);
    }
    if (this.layout.bushes.length > 0) {
      const count = Math.floor(this.layout.bushes.length * Math.max(0.3, density));
      const mesh = new THREE.InstancedMesh(bushGeo, bushMat, count);
      for (let i = 0; i < count; i++) {
        const b = this.layout.bushes[i];
        dust.position.set(b.x, b.y + b.scale * 0.3, b.z);
        dust.rotation.set(0, b.rotY, 0);
        dust.scale.set(b.scale, b.scale * 0.8, b.scale);
        dust.updateMatrix();
        mesh.setMatrixAt(i, dust.matrix);
      }
      mesh.castShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      this.root.add(mesh);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Loot visuals                                                     */
  /* ---------------------------------------------------------------- */

  private buildLootVisuals(): void {
    const boxGeo = new THREE.BoxGeometry(0.36, 0.36, 0.36);
    const beamGeo = new THREE.CylinderGeometry(0.06, 0.16, 3.2, 6, 1, true);
    beamGeo.translate(0, 1.6, 0);

    const rarities = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'];
    for (const rarity of rarities) {
      const mat = new THREE.MeshStandardMaterial({
        color: RARITY_HEX[rarity],
        emissive: RARITY_HEX[rarity],
        emissiveIntensity: 0.55,
        roughness: 0.4,
        metalness: 0.35
      });
      const inst = new THREE.InstancedMesh(boxGeo, mat, 220);
      inst.count = 0;
      inst.frustumCulled = false;
      inst.castShadow = false;
      this.root.add(inst);
      this.lootMeshes.push(inst);
      this.lootIds.push([]);
    }
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this.lootBeams = new THREE.InstancedMesh(beamGeo, beamMat, 200);
    this.lootBeams.count = 0;
    this.lootBeams.frustumCulled = false;
    this.root.add(this.lootBeams);
  }

  /** Rebuilds loot instance matrices for items near the camera. */
  refreshLoot(items: { id: number; x: number; y: number; z: number; rarity: string; claimed: number; spin: number }[], cameraPos: THREE.Vector3, radius = 150): void {
    const counts = [0, 0, 0, 0, 0];
    const rarityIndex: Record<string, number> = { COMMON: 0, UNCOMMON: 1, RARE: 2, EPIC: 3, LEGENDARY: 4 };
    let beamCount = 0;
    const r2 = radius * radius;
    const dummy = this.lootDummy;
    for (const item of items) {
      if (item.claimed > 0) continue;
      const d2 = (item.x - cameraPos.x) ** 2 + (item.z - cameraPos.z) ** 2;
      if (d2 > r2) continue;
      const ri = rarityIndex[item.rarity] ?? 0;
      const inst = this.lootMeshes[ri];
      if (counts[ri] >= inst.instanceMatrix.count) continue;
      dummy.position.set(item.x, item.y + 0.22 + Math.sin(item.spin + performance.now() * 0.002) * 0.03, item.z);
      dummy.rotation.set(0, item.spin + performance.now() * 0.0012, 0);
      dummy.updateMatrix();
      inst.setMatrixAt(counts[ri]++, dummy.matrix);
      if (this.lootBeams && beamCount < this.lootBeams.instanceMatrix.count && ri >= 2) {
        dummy.position.set(item.x, item.y, item.z);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        this.lootBeams.setMatrixAt(beamCount++, dummy.matrix);
      }
    }
    for (let i = 0; i < this.lootMeshes.length; i++) {
      this.lootMeshes[i].count = counts[i];
      this.lootMeshes[i].instanceMatrix.needsUpdate = true;
    }
    if (this.lootBeams) {
      this.lootBeams.count = beamCount;
      this.lootBeams.instanceMatrix.needsUpdate = true;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Vehicles                                                         */
  /* ---------------------------------------------------------------- */

  buildVehicles(vehicles: { id: number; type: string; x: number; y: number; z: number; yaw: number; colorIndex: number }[]): void {
    const bodyColors = [0xa8443f, 0x3f6ba8, 0xbfa23f, 0x4f8a52, 0x7a4f9a, 0xb06a34];
    for (const v of vehicles) {
      const group = new THREE.Group();
      const isBike = v.type === 'bike';
      const w = isBike ? 0.5 : 1.9;
      const l = isBike ? 1.9 : 4.2;
      const h = isBike ? 0.7 : 1.0;
      const bodyGeoms: THREE.BufferGeometry[] = [
        makeBox(0, h * 0.55, 0, w, h, l, { tile: 2 }),
        makeBox(0, h * 1.15, isBike ? 0.3 : -0.2, w * 0.82, h * 0.75, l * 0.45, { tile: 2 })
      ];
      if (isBike) bodyGeoms.push(makeBox(0, h * 1.5, -0.4, 0.28, 0.5, 0.5, { tile: 1 }));
      const bodyMesh = new THREE.Mesh(
        bodyGeoms.length > 1 ? mergeSimple(bodyGeoms) : bodyGeoms[0],
        new THREE.MeshStandardMaterial({ color: bodyColors[v.colorIndex % bodyColors.length], roughness: 0.45, metalness: 0.45 })
      );
      bodyMesh.castShadow = true;
      group.add(bodyMesh);

      const wheels: THREE.Mesh[] = [];
      const wheelGeo = new THREE.CylinderGeometry(isBike ? 0.34 : 0.4, isBike ? 0.34 : 0.4, 0.26, 10);
      wheelGeo.rotateZ(Math.PI / 2);
      const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.9 });
      const offsets: [number, number][] = isBike ? [[0, 0.85], [0, -0.85]] : [[w * 0.52, l * 0.34], [-w * 0.52, l * 0.34], [w * 0.52, -l * 0.34], [-w * 0.52, -l * 0.34]];
      for (const [ox, oz] of offsets) {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.position.set(ox, 0.4, oz);
        wheel.castShadow = true;
        group.add(wheel);
        wheels.push(wheel);
      }
      group.position.set(v.x, v.y, v.z);
      group.rotation.y = v.yaw;
      this.root.add(group);
      const visual: VehicleVisual = { id: v.id, body: bodyMesh, wheels, group, wreck: null };
      this.vehicleVisuals.push(visual);
      this.vehicleIndex.set(v.id, visual);
    }
  }

  /** Syncs vehicle transforms + wheel spin from the simulation. */
  updateVehicles(vehicles: { id: number; x: number; y: number; z: number; yaw: number; speed: number; destroyed: boolean }[], cameraPos: THREE.Vector3): void {
    for (const v of vehicles) {
      const visual = this.vehicleIndex.get(v.id);
      if (!visual) continue;
      const d2 = (v.x - cameraPos.x) ** 2 + (v.z - cameraPos.z) ** 2;
      const visible = d2 < 600 * 600;
      visual.group.visible = visible;
      if (!visible) continue;
      visual.group.position.set(v.x, v.y, v.z);
      visual.group.rotation.y = v.yaw;
      const spin = v.speed * 0.35;
      for (const wheel of visual.wheels) wheel.rotation.x -= spin * 0.05;
      if (v.destroyed) {
        visual.body.rotation.z = Math.min(0.35, visual.body.rotation.z + 0.004);
        visual.group.position.y = v.y - 0.15;
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Per-frame update                                                 */
  /* ---------------------------------------------------------------- */

  update(dt: number, cameraPos: THREE.Vector3, lootItems: { id: number; x: number; y: number; z: number; rarity: string; claimed: number; spin: number }[]): void {
    // Sun + shadow volume follows the camera
    this.sun.target.position.copy(cameraPos);
    this.sun.position.set(cameraPos.x + 120 * 0.45, cameraPos.y + 120 * 0.72, cameraPos.z - 120 * 0.52);
    this.sun.target.updateMatrixWorld();

    // Terrain LOD
    const lodDistance = settings.resolvedQuality === 'LOW' ? 260 : settings.resolvedQuality === 'MEDIUM' ? 420 : 620;
    for (const chunk of this.terrainChunks) {
      const d = Math.hypot(chunk.centerX - cameraPos.x, chunk.centerZ - cameraPos.z);
      const useLow = d > lodDistance;
      chunk.lod0.visible = !useLow;
      chunk.lod1.visible = useLow;
    }

    // Vegetation chunk culling
    this.vegTimer += dt;
    if (this.vegTimer > 0.2) {
      this.vegTimer = 0;
      const vegDistance = settings.graphics.viewDistance * 0.85;
      for (const chunk of this.vegChunks) {
        const d = Math.hypot(chunk.centerX - cameraPos.x, chunk.centerZ - cameraPos.z);
        chunk.group.visible = d < vegDistance + chunk.radius;
      }
    }

    // Loot refresh (throttled)
    this.lootRefreshTimer += dt;
    if (this.lootRefreshTimer > 0.12) {
      this.lootRefreshTimer = 0;
      this.refreshLoot(lootItems, cameraPos);
    }

    // Water shimmer
    if (this.water) {
      const mat = this.water.material as THREE.MeshStandardMaterial;
      if (mat.normalMap) {
        mat.normalMap.offset.set(performance.now() * 0.000021, performance.now() * 0.000013);
      }
    }
    if (this.sky) this.sky.position.copy(cameraPos);
  }

  /** Rough triangle count of the terrain + static pass, used by the QA HUD. */
  get terrainTriangles(): number {
    return this.totalTriangles;
  }

  get staticMeshCount(): number {
    return this.staticMeshes.length;
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.scene.remove(this.sun);
    this.scene.remove(this.sun.target);
    this.scene.remove(this.hemi);
    this.scene.remove(this.ambient);
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) for (const m of mesh.material) m.dispose();
        else (mesh.material as THREE.Material).dispose();
      }
    });
    this.terrainChunks.length = 0;
    this.vegChunks.length = 0;
    this.vehicleVisuals.length = 0;
    this.lootMeshes.length = 0;
  }
}

function mergeSimple(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Small local merge to avoid another import for two or three boxes.
  let total = 0;
  for (const g of geoms) total += (g.index ? g.index.count : g.attributes.position.count);
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  const index: number[] = [];
  let vOffset = 0;
  for (const g of geoms) {
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nor = g.attributes.normal as THREE.BufferAttribute;
    const uv = g.attributes.uv as THREE.BufferAttribute | undefined;
    for (let i = 0; i < pos.count; i++) {
      positions[(vOffset + i) * 3] = pos.getX(i);
      positions[(vOffset + i) * 3 + 1] = pos.getY(i);
      positions[(vOffset + i) * 3 + 2] = pos.getZ(i);
      normals[(vOffset + i) * 3] = nor.getX(i);
      normals[(vOffset + i) * 3 + 1] = nor.getY(i);
      normals[(vOffset + i) * 3 + 2] = nor.getZ(i);
      if (uv) {
        uvs[(vOffset + i) * 2] = uv.getX(i);
        uvs[(vOffset + i) * 2 + 1] = uv.getY(i);
      }
    }
    const gi = g.index;
    if (gi) for (let i = 0; i < gi.count; i++) index.push(gi.getX(i) + vOffset);
    else for (let i = 0; i < pos.count; i++) index.push(i + vOffset);
    vOffset += pos.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  out.setIndex(index);
  out.computeBoundingSphere();
  for (const g of geoms) g.dispose();
  return out;
}

export { mergeSimple };
