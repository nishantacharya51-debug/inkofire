import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Textures } from './textures';

/**
 * Static world geometry batching.
 *
 * The whole island (thousands of boxes) is merged into a handful of meshes —
 * one per material — which keeps draw calls extremely low. Collision boxes are
 * emitted separately as cheap AABBs, and never depend on the render meshes.
 */

export type SurfaceKind =
  | 'concrete' | 'brick' | 'wood' | 'metal' | 'asphalt' | 'sand'
  | 'grass' | 'rock' | 'roof' | 'fabric' | 'crate' | 'glass' | 'foliage'
  | 'tarp' | 'rust' | 'paintRed' | 'paintBlue' | 'paintYellow' | 'paintGreen'
  | 'dark' | 'white' | 'steelDark' | 'container1' | 'container2' | 'container3';

export interface SurfaceDef {
  color: number;
  roughness: number;
  metalness: number;
  map?: THREE.Texture;
  normalMap?: THREE.Texture;
  roughnessMap?: THREE.Texture;
  emissive?: number;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  alphaTest?: number;
}

export function surfaceDef(kind: SurfaceKind): SurfaceDef {
  switch (kind) {
    case 'concrete':
      return { color: 0xffffff, roughness: 0.94, metalness: 0.02, map: Textures.concrete(), normalMap: Textures.concreteNormal(), roughnessMap: Textures.concreteRough() };
    case 'brick':
      return { color: 0xffffff, roughness: 0.9, metalness: 0.0, map: Textures.brick(), normalMap: Textures.brickNormal() };
    case 'wood':
      return { color: 0xffffff, roughness: 0.85, metalness: 0.0, map: Textures.wood(), normalMap: Textures.woodNormal() };
    case 'metal':
      return { color: 0xffffff, roughness: 0.42, metalness: 0.72, map: Textures.metal(), normalMap: Textures.metalNormal(), roughnessMap: Textures.metalRough() };
    case 'steelDark':
      return { color: 0x6a7078, roughness: 0.36, metalness: 0.86, map: Textures.metal(), normalMap: Textures.metalNormal() };
    case 'rust':
      return { color: 0x8a5a3a, roughness: 0.86, metalness: 0.4, map: Textures.metal(), normalMap: Textures.metalNormal() };
    case 'asphalt':
      return { color: 0xffffff, roughness: 0.96, metalness: 0.0, map: Textures.asphalt() };
    case 'sand':
      return { color: 0xffffff, roughness: 0.98, metalness: 0.0, map: Textures.sand(), normalMap: Textures.sandNormal() };
    case 'grass':
      return { color: 0xffffff, roughness: 0.97, metalness: 0.0, map: Textures.grass(), normalMap: Textures.grassNormal() };
    case 'rock':
      return { color: 0xffffff, roughness: 0.92, metalness: 0.0, map: Textures.rock(), normalMap: Textures.rockNormal() };
    case 'roof':
      return { color: 0xffffff, roughness: 0.8, metalness: 0.0, map: Textures.roof(), normalMap: Textures.roofNormal() };
    case 'fabric':
    case 'tarp':
      return { color: 0xffffff, roughness: 0.95, metalness: 0.0, map: Textures.fabric(), normalMap: Textures.fabricNormal(), side: THREE.DoubleSide };
    case 'crate':
      return { color: 0xb08a5a, roughness: 0.86, metalness: 0.0, map: Textures.wood(), normalMap: Textures.woodNormal() };
    case 'glass':
      return { color: 0x9fc4d6, roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.34, side: THREE.DoubleSide };
    case 'foliage':
      return { color: 0xffffff, roughness: 0.9, metalness: 0.0, map: Textures.foliage(), transparent: true, alphaTest: 0.35, side: THREE.DoubleSide };
    case 'paintRed':
      return { color: 0x8d2f2b, roughness: 0.72, metalness: 0.06 };
    case 'paintBlue':
      return { color: 0x2d4d7a, roughness: 0.72, metalness: 0.06 };
    case 'paintYellow':
      return { color: 0xbf9a2c, roughness: 0.72, metalness: 0.06 };
    case 'paintGreen':
      return { color: 0x3f6b45, roughness: 0.72, metalness: 0.06 };
    case 'container1':
      return { color: 0x3f6f8a, roughness: 0.68, metalness: 0.35, map: Textures.metal(), normalMap: Textures.metalNormal() };
    case 'container2':
      return { color: 0x9a4a35, roughness: 0.68, metalness: 0.35, map: Textures.metal(), normalMap: Textures.metalNormal() };
    case 'container3':
      return { color: 0x6a7a4a, roughness: 0.68, metalness: 0.35, map: Textures.metal(), normalMap: Textures.metalNormal() };
    case 'dark':
      return { color: 0x2a2c30, roughness: 0.8, metalness: 0.2 };
    case 'white':
    default:
      return { color: 0xd8d8d4, roughness: 0.85, metalness: 0.02 };
  }
}

const materialCache = new Map<SurfaceKind, THREE.MeshStandardMaterial>();

export function surfaceMaterial(kind: SurfaceKind): THREE.MeshStandardMaterial {
  let m = materialCache.get(kind);
  if (!m) {
    const def = surfaceDef(kind);
    m = new THREE.MeshStandardMaterial({
      color: def.color,
      roughness: def.roughness,
      metalness: def.metalness,
      map: def.map ?? null,
      normalMap: def.normalMap ?? null,
      roughnessMap: def.roughnessMap ?? null,
      emissive: def.emissive ?? 0x000000,
      emissiveIntensity: def.emissiveIntensity ?? 1,
      transparent: def.transparent ?? false,
      opacity: def.opacity ?? 1,
      side: def.side ?? THREE.FrontSide,
      alphaTest: def.alphaTest ?? 0
    });
    materialCache.set(kind, m);
  }
  return m;
}

/**
 * Box geometry with world-scaled UVs so a single shared texture tiles
 * correctly at any box size (this is what lets us share materials).
 */
export function boxUV(w: number, h: number, d: number, tile = 2): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // Face order: +X, -X, +Y, -Y, +Z, -Z (4 verts each)
  const sizes: [number, number][] = [
    [d / tile, h / tile],
    [d / tile, h / tile],
    [w / tile, d / tile],
    [w / tile, d / tile],
    [w / tile, h / tile],
    [w / tile, h / tile]
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = sizes[f];
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, uv.getX(idx) * su, uv.getY(idx) * sv);
    }
  }
  uv.needsUpdate = true;
  return g;
}

export interface BoxOptions {
  rotY?: number;
  tile?: number;
  /** Offset the UVs (helps break up repetition between identical walls). */
  uvShift?: [number, number];
}

export function makeBox(
  cx: number, cy: number, cz: number,
  w: number, h: number, d: number,
  opts: BoxOptions = {}
): THREE.BufferGeometry {
  const g = boxUV(w, h, d, opts.tile ?? 2);
  if (opts.uvShift) {
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) + opts.uvShift[0], uv.getY(i) + opts.uvShift[1]);
    }
  }
  const m = new THREE.Matrix4();
  if (opts.rotY) m.makeRotationY(opts.rotY);
  m.setPosition(cx, cy, cz);
  g.applyMatrix4(m);
  return g;
}

/**
 * Collects geometry into per-material buckets and merges them into
 * one mesh per material. Also records collision AABBs.
 */
export class StaticBatcher {
  private buckets = new Map<SurfaceKind, THREE.BufferGeometry[]>();
  private colliders: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }[] = [];
  private group: THREE.Group;
  private meshes: THREE.Mesh[] = [];

  constructor(name = 'static') {
    this.group = new THREE.Group();
    this.group.name = name;
  }

  get object(): THREE.Object3D {
    return this.group;
  }

  get colliderList(): readonly { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }[] {
    return this.colliders;
  }

  add(kind: SurfaceKind, geom: THREE.BufferGeometry, collider?: boolean): void {
    let arr = this.buckets.get(kind);
    if (!arr) {
      arr = [];
      this.buckets.set(kind, arr);
    }
    arr.push(geom);
    if (collider) {
      geom.computeBoundingBox();
      const bb = geom.boundingBox;
      if (bb) {
        this.colliders.push({
          minX: bb.min.x, minY: bb.min.y, minZ: bb.min.z,
          maxX: bb.max.x, maxY: bb.max.y, maxZ: bb.max.z
        });
      }
    }
  }

  addBox(kind: SurfaceKind, cx: number, cy: number, cz: number, w: number, h: number, d: number, opts: BoxOptions = {}, collider = true): void {
    this.add(kind, makeBox(cx, cy, cz, w, h, d, opts), collider);
    if (!collider) return;
  }

  /** Wall along X with a rectangular doorway gap. */
  addWallWithDoor(
    kind: SurfaceKind,
    cx: number, cy: number, cz: number,
    length: number, height: number, thickness: number,
    doorOffset: number, doorWidth: number, doorHeight: number,
    horizontal: boolean, rotY = 0
  ): void {
    const half = length / 2;
    const left = doorOffset - doorWidth / 2;
    const right = doorOffset + doorWidth / 2;
    const segs: [number, number][] = [];
    if (left + half > 0.05) segs.push([-half, left]);
    if (half - right > 0.05) segs.push([right, half]);
    for (const [a, b] of segs) {
      const w = b - a;
      const off = (a + b) / 2;
      if (horizontal) {
        this.addBox(kind, cx + off, cy + height / 2, cz, w, height, thickness, { rotY });
      } else {
        this.addBox(kind, cx, cy + height / 2, cz + off, thickness, height, w, { rotY });
      }
    }
    if (doorHeight < height) {
      const h = height - doorHeight;
      if (horizontal) {
        this.addBox(kind, cx + doorOffset, cy + doorHeight + h / 2, cz, doorWidth, h, thickness, { rotY });
      } else {
        this.addBox(kind, cx, cy + doorHeight + h / 2, cz + doorOffset, thickness, h, doorWidth, { rotY });
      }
    }
  }

  /** Build merged meshes and attach them to the group. */
  finalize(): THREE.Group {
    for (const [kind, geoms] of this.buckets) {
      if (geoms.length === 0) continue;
      const merged = mergeGeometries(geoms, false);
      for (const g of geoms) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, surfaceMaterial(kind));
      mesh.castShadow = kind !== 'glass';
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.name = `static_${kind}`;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
    this.buckets.clear();
    return this.group;
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      (m.parent as THREE.Object3D | null)?.remove(m);
    }
    this.meshes.length = 0;
    for (const geoms of this.buckets.values()) for (const g of geoms) g.dispose();
    this.buckets.clear();
    this.colliders.length = 0;
  }
}
