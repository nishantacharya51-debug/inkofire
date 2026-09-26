import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Actor } from '../entity/Actor';
import { clamp, damp, lerp } from '../utils/mathx';

/**
 * Procedural humanoid operator.
 *
 * Everything is generated in code — no external models, no ripped assets. The
 * body is built from smooth primitives (capsules, tapered lathes, bevelled
 * plates) rather than boxes so it reads as a person at gameplay distance:
 * ~1.82 m tall, ~7.6 heads, real anatomical landmarks (shoulders, elbows,
 * waist, knees, ankles) so the procedural animation has something believable
 * to rotate.
 *
 * Geometry is *shared*: every rig with the same cosmetic variant references one
 * cached set of merged meshes, so a 60-operator match costs one build instead
 * of sixty. Only per-actor materials differ (palette colours come from the
 * shared material cache as well).
 */

export interface CharacterPalette {
  skin: number;
  hair: number;
  shirt: number;
  pants: number;
  boots: number;
  vest: number;
  helmet: number;
  accent: number;
}

export const SKINS: CharacterPalette[] = [
  { skin: 0xd8a882, hair: 0x241a12, shirt: 0x4a5460, pants: 0x3a4048, boots: 0x2a2a2c, vest: 0x39424d, helmet: 0x33383f, accent: 0x7ad0b0 },
  { skin: 0xa9714c, hair: 0x1a1310, shirt: 0x5a4a3a, pants: 0x3d3a34, boots: 0x26221e, vest: 0x4a4436, helmet: 0x3a352c, accent: 0xd0a05a },
  { skin: 0xe8c39e, hair: 0x6a4a28, shirt: 0x35485a, pants: 0x2f3a44, boots: 0x232629, vest: 0x2d3a44, helmet: 0x2a3138, accent: 0x5a9ad0 },
  { skin: 0x8a5b3a, hair: 0x120d0a, shirt: 0x44543f, pants: 0x3a4034, boots: 0x22241f, vest: 0x3a4534, helmet: 0x2f382c, accent: 0x9ad05a },
  { skin: 0xc9967a, hair: 0x3a2a1a, shirt: 0x5a3540, pants: 0x33303a, boots: 0x26222a, vest: 0x453040, helmet: 0x3a2a38, accent: 0xd05a7a },
  { skin: 0xf0d0b0, hair: 0xc8b070, shirt: 0x6a6a72, pants: 0x44444c, boots: 0x2c2c33, vest: 0x55555e, helmet: 0x44444d, accent: 0xf0d05a }
];

/* ------------------------------------------------------------------ */
/* Shared material + geometry pools                                    */
/* ------------------------------------------------------------------ */

const matCache = new Map<string, THREE.MeshStandardMaterial>();

function mat(color: number, roughness = 0.75, metalness = 0.05, key = ''): THREE.MeshStandardMaterial {
  const k = `${color}_${roughness}_${metalness}_${key}`;
  let m = matCache.get(k);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    matCache.set(k, m);
  }
  return m;
}

function cloth(color: number): THREE.MeshStandardMaterial { return mat(color, 0.88, 0.02, 'cloth'); }
function leather(color: number): THREE.MeshStandardMaterial { return mat(color, 0.62, 0.06, 'leather'); }
function gear(color: number): THREE.MeshStandardMaterial { return mat(color, 0.55, 0.22, 'gear'); }
function metal(color: number): THREE.MeshStandardMaterial { return mat(color, 0.34, 0.85, 'metal'); }
function skinMat(color: number): THREE.MeshStandardMaterial { return mat(color, 0.58, 0.0, 'skin'); }

/** Geometry cache — keyed by a stable string, shared between all rigs. */
const geomCache = new Map<string, THREE.BufferGeometry>();

function shared(key: string, build: () => THREE.BufferGeometry | null): THREE.BufferGeometry {
  let g = geomCache.get(key);
  if (!g) {
    g = build() ?? new THREE.BufferGeometry();
    geomCache.set(key, g);
  }
  return g;
}

function meshOf(key: string, build: () => THREE.BufferGeometry | null, material: THREE.Material, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(shared(key, build), material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  return mesh;
}

/* ------------------------------------------------------------------ */
/* Primitive builders (all return geometry centred on the given point) */
/* ------------------------------------------------------------------ */

/** Smooth tapered cylinder — the workhorse for limbs and torsos. */
function taper(rTop: number, rBot: number, h: number, x: number, y: number, z: number, seg = 11, squashZ = 1): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, false);
  if (squashZ !== 1) g.scale(1, 1, squashZ);
  g.translate(x, y, z);
  return g;
}

/** Capsule limb segment; `axis` picks the bone direction it lies along. */
function capsule(r: number, len: number, x: number, y: number, z: number, axis: 'y' | 'x' | 'z' = 'y', seg = 9, capSeg = 3): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(r, len, capSeg, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}

function sphereG(r: number, x: number, y: number, z: number, wSeg = 11, hSeg = 8, scale?: [number, number, number]): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, wSeg, hSeg);
  if (scale) g.scale(scale[0], scale[1], scale[2]);
  g.translate(x, y, z);
  return g;
}

/** Beveled box: rounded silhouette in XY plus rounded depth edges. */
function roundBox(w: number, h: number, d: number, r: number, x: number, y: number, z: number, bevel = 0.01): THREE.BufferGeometry {
  const radius = Math.max(0.004, Math.min(r, Math.min(w, h) / 2 - 0.004));
  const hw = w / 2;
  const hh = h / 2;
  const s = new THREE.Shape();
  s.moveTo(-hw + radius, -hh);
  s.lineTo(hw - radius, -hh);
  s.quadraticCurveTo(hw, -hh, hw, -hh + radius);
  s.lineTo(hw, hh - radius);
  s.quadraticCurveTo(hw, hh, hw - radius, hh);
  s.lineTo(-hw + radius, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - radius);
  s.lineTo(-hw, -hh + radius);
  s.quadraticCurveTo(-hw, -hh, -hw + radius, -hh);
  const depth = Math.max(0.004, d - bevel * 2);
  const g = new THREE.ExtrudeGeometry(s, {
    depth,
    bevelEnabled: bevel > 0.001,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 3,
    steps: 1
  });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  g.translate(x, y, z);
  return g;
}

/** Half-sphere shell, used for helmets, hair caps and shoulders. */
function dome(r: number, x: number, y: number, z: number, phiLength = Math.PI * 2, scale?: [number, number, number], wSeg = 12, hSeg = 7): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, wSeg, hSeg, 0, phiLength, 0, Math.PI * 0.55);
  if (scale) g.scale(scale[0], scale[1], scale[2]);
  g.translate(x, y, z);
  return g;
}

/** Flat ring — straps, belts, scope rings. */
function band(rOuter: number, rInner: number, h: number, x: number, y: number, z: number, squashZ = 1, seg = 12): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rOuter, rOuter, h, seg, 1, true);
  const inner = new THREE.CylinderGeometry(rInner, rInner, h, seg, 1, true);
  const merged = mergeGeometries([g, inner], false);
  g.dispose();
  inner.dispose();
  const out = merged ?? new THREE.BufferGeometry();
  if (squashZ !== 1) out.scale(1, 1, squashZ);
  out.translate(x, y, z);
  return out;
}

/**
 * Merges primitives safely.
 *
 * ExtrudeGeometry (the bevelled plates) is non-indexed while capsules,
 * cylinders and spheres are indexed, and `mergeGeometries` refuses mixed
 * input — it returns null and the part silently disappears. Normalising the
 * index state keeps every body part present in the merged mesh.
 */
function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const anyIndexed = parts.some((p) => p.index !== null);
  const anyPlain = parts.some((p) => p.index === null);
  const list = anyIndexed && anyPlain ? parts.map((p) => (p.index ? p.toNonIndexed() : p)) : parts;
  const merged = mergeGeometries(list, false) ?? new THREE.BufferGeometry();
  for (const p of parts) p.dispose();
  if (list !== parts) for (const p of list) if (!parts.includes(p)) p.dispose();
  if (!merged.attributes.position) {
    console.warn('[CharacterRig] geometry merge produced an empty mesh', parts.length);
  }
  return merged;
}

/** Segment density. Menus render exactly one character, so they can afford it. */
export type RigDetail = 'low' | 'high';

export interface RigBones {
  root: THREE.Group;
  hips: THREE.Group;
  spine: THREE.Group;
  chest: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  foreL: THREE.Group;
  foreR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  shinL: THREE.Group;
  shinR: THREE.Group;
  weaponAnchor: THREE.Group;
  chute: THREE.Group | null;
}

interface BodyParts {
  pelvis: THREE.Mesh;
  torso: THREE.Mesh;
  vest: THREE.Mesh;
  belt: THREE.Mesh;
  pack: THREE.Mesh;
  neck: THREE.Mesh;
  shoulderL: THREE.Mesh;
  shoulderR: THREE.Mesh;
  upperL: THREE.Mesh;
  upperR: THREE.Mesh;
  foreL: THREE.Mesh;
  foreR: THREE.Mesh;
  thighL: THREE.Mesh;
  thighR: THREE.Mesh;
  shinL: THREE.Mesh;
  shinR: THREE.Mesh;
  head: THREE.Mesh;
  visor: THREE.Mesh;
  handL: THREE.Mesh;
  handR: THREE.Mesh;
  headGear: THREE.Mesh;
  face: THREE.Mesh;
  accent: THREE.Mesh;
}

const bodyCache = new Map<string, BodyParts>();

function variantKey(useHelmet: boolean, useVest: boolean): string {
  return `${useHelmet ? 'H' : 'h'}${useVest ? 'V' : 'v'}`;
}

/**
 * Builds (once per variant) the full set of body meshes. Meshes reference
 * shared geometry, so clones are cheap — only the materials differ per rig.
 */
function bodyFor(palette: CharacterPalette, useHelmet: boolean, useVest: boolean, detail: RigDetail = 'low'): BodyParts {
  const key = `${variantKey(useHelmet, useVest)}_${detail}_${palette.shirt}_${palette.vest}_${palette.pants}_${palette.boots}_${palette.helmet}_${palette.skin}_${palette.hair}_${palette.accent}`;
  const cached = bodyCache.get(key);
  if (cached) return cached;

  const p = palette;
  // Radial segment counts: doubled-up in the lobby, trimmed in a 60-player match.
  const SEG = detail === 'high' ? { limb: 14, cap: 6, torso: 18, ball: 16, body: 14, band: 20 } : { limb: 9, cap: 3, torso: 11, ball: 11, body: 12, band: 12 };
  const cap = (r: number, len: number, x: number, y: number, z: number, axis: 'y' | 'x' | 'z' = 'y'): THREE.BufferGeometry =>
    capsule(r, len, x, y, z, axis, SEG.limb, SEG.cap);
  const tap = (rTop: number, rBot: number, h: number, x: number, y: number, z: number, squashZ = 1): THREE.BufferGeometry =>
    taper(rTop, rBot, h, x, y, z, SEG.torso, squashZ);
  const ball = (r: number, x: number, y: number, z: number, scale?: [number, number, number]): THREE.BufferGeometry =>
    sphereG(r, x, y, z, SEG.ball, Math.max(6, Math.round(SEG.ball * 0.72)), scale);

  /* ---- pelvis + belt ---- */
  const pelvis = meshOf(`pelvis|${key}`, () => mergeAll([
    tap(0.155, 0.135, 0.24, 0, 0.0, 0, 0.72),
    roundBox(0.30, 0.10, 0.23, 0.05, 0, -0.10, 0.005) // hip pads
  ]), cloth(p.pants), 'pelvis');

  const belt = meshOf(`belt|${key}`, () => mergeAll([
    band(0.176, 0.16, 0.055, 0, 0.055, 0, 0.74, SEG.band),
    roundBox(0.075, 0.075, 0.045, 0.018, 0.10, 0.03, -0.135),  // pouch
    roundBox(0.075, 0.075, 0.045, 0.018, -0.10, 0.03, -0.135), // pouch
    roundBox(0.05, 0.05, 0.03, 0.012, 0, 0.035, 0.145)         // buckle
  ]), leather(p.boots), 'belt');

  /* ---- torso ---- */
  const torso = meshOf(`torso|${key}`, () => mergeAll([
    tap(0.185, 0.152, 0.40, 0, 0.20, 0, 0.66),   // ribcage → waist
    tap(0.16, 0.185, 0.09, 0, 0.02, 0, 0.7),     // waist join
    ball(0.112, 0, 0.40, 0, [1.34, 0.66, 0.70]), // upper chest mass
    roundBox(0.225, 0.035, 0.155, 0.015, 0, 0.45, 0)       // collar bone shelf
  ]), cloth(p.shirt), 'torso');

  const vestParts: THREE.BufferGeometry[] = [
    tap(0.188, 0.172, 0.29, 0, 0.245, 0, 0.70),   // carrier body
    roundBox(0.215, 0.155, 0.04, 0.016, 0, 0.275, -0.118), // front plate
    roundBox(0.20, 0.15, 0.038, 0.015, 0, 0.275, 0.11),   // back plate
    roundBox(0.075, 0.055, 0.028, 0.011, 0.075, 0.345, -0.138), // mag pouch
    roundBox(0.075, 0.055, 0.028, 0.011, -0.02, 0.345, -0.138),
    roundBox(0.055, 0.085, 0.032, 0.011, -0.115, 0.325, -0.132), // radio
    roundBox(0.16, 0.022, 0.02, 0.008, 0, 0.185, -0.155),   // molle row
    roundBox(0.16, 0.022, 0.02, 0.008, 0, 0.225, -0.155),
    roundBox(0.05, 0.16, 0.03, 0.012, 0.145, 0.33, -0.10),
    roundBox(0.05, 0.16, 0.03, 0.012, -0.145, 0.33, -0.10)
  ];
  const vest = meshOf(`vest|${key}`, () => mergeAll(vestParts), gear(p.vest), 'vest');

  const pack = meshOf(`pack|${key}`, () => mergeAll([
    roundBox(0.235, 0.26, 0.095, 0.035, 0, 0.30, 0.155),   // main body
    roundBox(0.20, 0.075, 0.055, 0.018, 0, 0.40, 0.145),   // top lid
    roundBox(0.035, 0.20, 0.03, 0.01, 0.075, 0.32, 0.105), // compression strap
    roundBox(0.035, 0.20, 0.03, 0.01, -0.075, 0.32, 0.105)
  ]), leather(p.boots), 'pack');

  /* ---- arms ---- */
  const shoulder = (mirror: number): THREE.Mesh => meshOf(`shoulder|${key}`, () => mergeAll([
    ball(0.069, 0, 0, 0, [1.02, 0.95, 1.0]),
    // Deltoid pad strapped over the joint.
    ball(0.071, mirror * 0.009, 0.011, 0, [1.0, 0.55, 1.0])
  ]), gear(p.vest), 'shoulder');

  const upper = (): THREE.Mesh => meshOf(`upper|${key}`, () => mergeAll([
    cap(0.062, 0.20, 0, -0.15, 0),
    ball(0.058, 0, -0.285, 0) // elbow
  ]), cloth(p.shirt), 'upper');

  // Sleeved forearm — identical on both arms so the operator reads as a unit.
  const fore = (): THREE.Mesh => meshOf(`fore|${key}`, () => mergeAll([
    cap(0.055, 0.175, 0, -0.115, 0),
    ball(0.05, 0, -0.006, 0) // elbow cuff
  ]), cloth(p.shirt), 'fore');

  // Gloved hand: palm, three fingers, thumb and a wrist strap.
  const glove = (): THREE.Mesh => meshOf(`glove|${key}`, () => mergeAll([
    roundBox(0.082, 0.092, 0.045, 0.025, 0, -0.255, 0.004),
    capsule(0.0145, 0.045, -0.022, -0.325, 0.0, 'y', detail === 'high' ? 6 : 4, 2),
    capsule(0.0145, 0.048, 0.012, -0.328, 0.0, 'y', detail === 'high' ? 6 : 4, 2),
    capsule(0.013, 0.036, 0.045, -0.272, 0.012, 'y', detail === 'high' ? 6 : 4, 2),
    roundBox(0.035, 0.03, 0.03, 0.012, 0, -0.20, -0.035)
  ]), leather(p.boots), 'glove');

  /* ---- legs ---- */
  const thigh = (): THREE.Mesh => meshOf(`thigh|${key}`, () => mergeAll([
    cap(0.09, 0.30, 0, -0.20, 0),
    ball(0.075, 0, -0.40, 0) // knee
  ]), cloth(p.pants), 'thigh');

  const kneePad = meshOf(`knee|${key}`, () => mergeAll([
    roundBox(0.115, 0.10, 0.075, 0.03, 0, 0.02, -0.05)
  ]), gear(p.vest), 'knee');

  const shin = (): THREE.Mesh => meshOf(`shin|${key}`, () => mergeAll([
    cap(0.072, 0.26, 0, -0.17, 0),
    // boot: ankle collar, foot, sole, toe cap
    tap(0.078, 0.072, 0.10, 0, -0.35, 0, 0.9),
    roundBox(0.093, 0.072, 0.225, 0.028, 0, -0.412, -0.038),
    roundBox(0.099, 0.024, 0.235, 0.011, 0, -0.455, -0.038),
    roundBox(0.087, 0.046, 0.04, 0.018, 0, -0.42, -0.145)
  ]), leather(p.boots), 'shin');

  /* ---- head ---- */
  const headParts: THREE.BufferGeometry[] = [
    ball(0.108, 0, 0.02, 0, [0.95, 1.06, 1.02]), // cranium
    tap(0.082, 0.055, 0.13, 0, -0.055, -0.012, 0.88),  // jaw
    ball(0.05, 0, -0.02, 0.078),                    // occiput
    ball(0.028, 0.098, 0.0, 0.008, [0.5, 1.1, 0.8]), // ears
    ball(0.028, -0.098, 0.0, 0.008, [0.5, 1.1, 0.8]),
    roundBox(0.03, 0.04, 0.03, 0.011, 0, -0.012, -0.113),  // nose
    roundBox(0.058, 0.02, 0.02, 0.008, 0, -0.08, -0.097)   // chin
  ];
  const head = meshOf(`head|${key}`, () => mergeAll(headParts), skinMat(p.skin), 'head');

  const faceParts: THREE.BufferGeometry[] = [
    sphereG(0.0185, 0.042, 0.028, -0.098, 8, 7, [1, 1, 0.72]), // eyes
    sphereG(0.0185, -0.042, 0.028, -0.098, 8, 7, [1, 1, 0.72]),
    sphereG(0.0072, 0.042, 0.028, -0.112, 8, 6),               // pupils
    sphereG(0.0072, -0.042, 0.028, -0.112, 8, 6),
    roundBox(0.05, 0.011, 0.018, 0.004, 0.042, 0.056, -0.104), // brows
    roundBox(0.05, 0.011, 0.018, 0.004, -0.042, 0.056, -0.104),
    roundBox(0.034, 0.011, 0.014, 0.004, 0, -0.072, -0.094)    // mouth
  ];
  const face = meshOf(`face|${key}`, () => mergeAll(faceParts), mat(0x241d19, 0.42, 0.02, 'face'), 'face');

  const gearParts: THREE.BufferGeometry[] = useHelmet
    ? [
        dome(0.118, 0, 0.035, 0, Math.PI * 2, [0.97, 1.0, 1.06]),    // shell
        band(0.122, 0.108, 0.028, 0, 0.012, 0, 1.04, SEG.band),      // retention strap
        roundBox(0.155, 0.032, 0.045, 0.014, 0, 0.042, -0.108),      // brim
        roundBox(0.034, 0.042, 0.05, 0.012, 0, 0.088, -0.082),       // nvg mount
        roundBox(0.024, 0.024, 0.055, 0.009, 0.098, 0.028, 0.012),   // side rail
        roundBox(0.024, 0.024, 0.055, 0.009, -0.098, 0.028, 0.012),  // side rail
        // headset: ear cups + boom mic
        tap(0.038, 0.038, 0.042, 0.102, -0.008, 0.0, 1),
        tap(0.038, 0.038, 0.042, -0.102, -0.008, 0.0, 1),
        roundBox(0.01, 0.01, 0.095, 0.004, -0.095, -0.042, -0.042)
      ]
    : [
        dome(0.113, 0, 0.032, 0.004, Math.PI * 2, [1.0, 0.84, 1.03], 14, 8), // hair
        roundBox(0.165, 0.035, 0.135, 0.016, 0, 0.05, 0.028)         // hair volume
      ];
  const headGear = meshOf(`headgear|${key}`, () => mergeAll(gearParts), useHelmet ? gear(p.helmet) : mat(p.hair, 0.92, 0.02, 'hair'), 'headGear');

  // Goggles sit across the eyes; only worn with the helmet.
  const visor = meshOf(`visor|${key}`, () => mergeAll([
    roundBox(0.135, 0.04, 0.042, 0.014, 0, 0.016, -0.098),
    roundBox(0.15, 0.018, 0.026, 0.007, 0, 0.038, -0.092),
    roundBox(0.05, 0.022, 0.02, 0.008, 0.078, 0.006, -0.03)
  ]), mat(0x16212b, 0.18, 0.45, 'visor'), 'visor');

  const accent = meshOf(`accent|${key}`, () => mergeAll([
    roundBox(0.1, 0.026, 0.022, 0.009, 0.052, 0.372, -0.152),          // chest chevron
    roundBox(0.068, 0.025, 0.018, 0.007, 0.115, 0.402, -0.082),  // shoulder tab
    roundBox(0.068, 0.025, 0.018, 0.007, -0.115, 0.402, -0.082)
  ]), mat(p.accent, 0.5, 0.25, 'accent'), 'accent');

  const neck = meshOf(`neck|${key}`, () => mergeAll([
    tap(0.05, 0.06, 0.135, 0, 0.425, 0.006, 0.9)
  ]), skinMat(p.skin), 'neck');

  const parts: BodyParts = {
    pelvis, torso, vest, belt, pack, neck,
    shoulderL: shoulder(1), shoulderR: shoulder(-1),
    upperL: upper(), upperR: upper(),
    foreL: fore(), foreR: fore(),
    thighL: thigh(), thighR: thigh(),
    shinL: shin(), shinR: shin(),
    head, headGear, face, accent, visor,
    handL: glove(), handR: glove()
  };
  void kneePad;
  bodyCache.set(key, parts);
  return parts;
}

/* ------------------------------------------------------------------ */
/* Rig                                                                 */
/* ------------------------------------------------------------------ */

/** Hip height of the standing pose — the model's anchor against the hitboxes. */
const HIP_Y = 0.98;

export class CharacterRig {
  readonly root = new THREE.Group();
  readonly bones: RigBones;
  /** Simplified low-cost body used at distance. */
  readonly simpleRoot = new THREE.Group();
  private simpleBody: THREE.Mesh;
  private simpleHead: THREE.Mesh;
  private weaponMesh: THREE.Mesh | null = null;
  private weaponId = '';
  private parachute: THREE.Mesh | null = null;
  private animTime = 0;
  private breathPhase = 0;
  private aimBlend = 0;
  private fireKick = 0;
  private reloadBlend = 0;
  private lastShot = -99;
  private palette: CharacterPalette;
  private lodLevel = 0;
  private flinchTimer = 0;
  private deathProgress = 0;
  private showcase = false;
  private showcasePhase = 0;

  constructor(paletteIndex = 0, cosmetic: { helmet?: boolean; vest?: boolean; detail?: RigDetail } = {}) {
    this.palette = SKINS[Math.abs(paletteIndex) % SKINS.length];
    const p = this.palette;
    const useHelmet = cosmetic.helmet ?? true;
    const useVest = cosmetic.vest ?? true;
    const body = bodyFor(p, useHelmet, useVest, cosmetic.detail ?? 'low');

    /* ---------------- Hierarchy (real anatomical pivots) ---------------- */
    const root = this.root;
    root.name = 'character';

    const hips = new THREE.Group();
    hips.position.y = HIP_Y;
    root.add(hips);

    const spine = new THREE.Group();
    hips.add(spine);

    const chest = new THREE.Group();
    chest.position.y = 0.14;
    spine.add(chest);

    const head = new THREE.Group();
    head.position.y = 0.46;
    chest.add(head);

    const armL = new THREE.Group();
    armL.position.set(0.215, 0.375, 0);
    chest.add(armL);
    const armR = new THREE.Group();
    armR.position.set(-0.215, 0.375, 0);
    chest.add(armR);

    const foreL = new THREE.Group();
    foreL.position.y = -0.30;
    armL.add(foreL);
    const foreR = new THREE.Group();
    foreR.position.y = -0.30;
    armR.add(foreR);

    const legL = new THREE.Group();
    legL.position.set(0.098, -0.045, 0);
    hips.add(legL);
    const legR = new THREE.Group();
    legR.position.set(-0.098, -0.045, 0);
    hips.add(legR);

    const shinL = new THREE.Group();
    shinL.position.y = -0.465;
    legL.add(shinL);
    const shinR = new THREE.Group();
    shinR.position.y = -0.465;
    legR.add(shinR);

    // +90° about X maps the weapon's barrel (+Z) onto the forearm's -Y axis,
    // so the gun points where the hand points instead of floating beside it.
    const weaponAnchor = new THREE.Group();
    weaponAnchor.position.set(0, -0.235, 0.012);
    weaponAnchor.rotation.x = Math.PI / 2;
    foreR.add(weaponAnchor);

    this.bones = { root, hips, spine, chest, head, armL, armR, foreL, foreR, legL, legR, shinL, shinR, weaponAnchor, chute: null };

    /* ---------------- Assembly ---------------- */
    hips.add(body.pelvis, body.belt);
    chest.add(body.torso, body.vest, body.pack, body.accent, body.neck);
    armL.add(body.shoulderL, body.upperL);
    armR.add(body.shoulderR, body.upperR);
    foreL.add(body.foreL, body.handL);
    foreR.add(body.foreR, body.handR);
    legL.add(body.thighL);
    legR.add(body.thighR);
    shinL.add(body.shinL);
    shinR.add(body.shinR);
    head.add(body.head, body.face, body.headGear);
    if (useHelmet) head.add(body.visor);

    /* ---------------- Far LOD body ---------------- */
    const simpleGeoms: THREE.BufferGeometry[] = [
      taper(0.18, 0.145, 0.46, 0, 1.28, 0, 8, 0.7),
      taper(0.15, 0.13, 0.24, 0, 0.98, 0, 8, 0.72),
      capsule(0.07, 0.24, 0.205, 1.36, 0, 'y', 7, 3),
      capsule(0.07, 0.24, -0.205, 1.36, 0, 'y', 7, 3),
      capsule(0.09, 0.34, 0.10, 0.74, 0, 'y', 7, 3),
      capsule(0.09, 0.34, -0.10, 0.74, 0, 'y', 7, 3),
      capsule(0.075, 0.30, 0.10, 0.32, 0, 'y', 7, 3),
      capsule(0.075, 0.30, -0.10, 0.32, 0, 'y', 7, 3),
      roundBox(0.10, 0.078, 0.23, 0.028, 0.10, 0.05, -0.04),
      roundBox(0.10, 0.078, 0.23, 0.028, -0.10, 0.05, -0.04)
    ];
    this.simpleBody = new THREE.Mesh(shared(`simpleBody|${variantKey(useHelmet, useVest)}`, () => mergeAll(simpleGeoms)), cloth(useVest ? p.vest : p.shirt));
    this.simpleBody.castShadow = true;
    this.simpleRoot.add(this.simpleBody);
    this.simpleHead = new THREE.Mesh(
      shared(`simpleHead|${variantKey(useHelmet, useVest)}`, () => mergeAll([sphereG(0.11, 0, 1.72, 0, 10, 8, [0.95, 1.08, 1.02])])),
      useHelmet ? gear(p.helmet) : skinMat(p.skin)
    );
    this.simpleHead.castShadow = true;
    this.simpleRoot.add(this.simpleHead);
    this.simpleRoot.visible = false;
  }

  /** Swaps the held weapon model (geometry is shared per weapon id). */
  setWeapon(weaponId: string | null, scale = 1): void {
    if (weaponId === this.weaponId) return;
    this.weaponId = weaponId ?? '';
    if (this.weaponMesh) {
      this.bones.weaponAnchor.remove(this.weaponMesh);
      this.weaponMesh = null;
    }
    if (!weaponId) return;
    const geo = shared(`weapon|${weaponId}`, () => buildWeaponGeometry(weaponId));
    if (!geo.attributes.position) return;
    const m = new THREE.Mesh(geo, metal(0x33383f));
    m.castShadow = true;
    m.scale.setScalar(scale);
    this.bones.weaponAnchor.add(m);
    this.weaponMesh = m;
  }

  /** Deploys or hides the parachute canopy. */
  setParachute(visible: boolean): void {
    if (visible && !this.parachute) {
      const geo = shared('chute', () => mergeAll([
        new THREE.SphereGeometry(1.65, 16, 9, 0, Math.PI * 2, 0, Math.PI * 0.5),
        taper(0.02, 0.02, 1.3, 0.62, -0.65, 0, 6),
        taper(0.02, 0.02, 1.3, -0.62, -0.65, 0, 6),
        taper(0.02, 0.02, 1.3, 0, -0.65, 0.62, 6),
        taper(0.02, 0.02, 1.3, 0, -0.65, -0.62, 6)
      ]));
      const m = new THREE.Mesh(geo, cloth(this.palette.accent));
      m.position.y = 2.05;
      m.scale.set(1, 0.6, 1);
      m.castShadow = true;
      this.root.add(m);
      this.parachute = m;
    } else if (!visible && this.parachute) {
      this.root.remove(this.parachute);
      this.parachute = null;
    }
  }

  /** Small torso/head jolt when the character takes a hit. */
  flinch(strength = 1): void {
    this.flinchTimer = Math.min(0.4, 0.22 + strength * 0.08);
  }

  setLod(level: number): void {
    if (level === this.lodLevel) return;
    this.lodLevel = level;
    this.root.visible = level === 0;
    this.simpleRoot.visible = level > 0;
  }

  /**
   * Lobby / showcase stance: weapon carried across the chest, weight on one
   * leg, slow breathing. Used behind the main menu and the pre-match lobby.
   */
  setShowcase(on: boolean): void {
    this.showcase = on;
    if (!on) this.showcasePhase = 0;
  }

  /* ---------------- Pose helpers ---------------- */

  private resetPose(): void {
    const b = this.bones;
    b.hips.position.set(0, HIP_Y, 0);
    b.hips.rotation.set(0, 0, 0);
    b.spine.rotation.set(0, 0, 0);
    b.chest.rotation.set(0, 0, 0);
    b.head.rotation.set(0, 0, 0);
    b.armL.rotation.set(0, 0, 0);
    b.armR.rotation.set(0, 0, 0);
    b.foreL.rotation.set(0, 0, 0);
    b.foreR.rotation.set(0, 0, 0);
    b.legL.rotation.set(0, 0, 0);
    b.legR.rotation.set(0, 0, 0);
    b.shinL.rotation.set(0, 0, 0);
    b.shinR.rotation.set(0, 0, 0);
  }

  /**
   * Two-handed weapon carry: right hand on the grip, left hand under the
   * handguard. `amount` blends with the one-handed/idle pose.
   */
  private holdWeapon(amount: number, ads: number): void {
    if (amount <= 0.001) return;
    const b = this.bones;
    const a = amount;
    // Right arm pulls the weapon up into the shoulder pocket.
    b.armR.rotation.x = lerp(b.armR.rotation.x, -0.75 - ads * 0.12, a);
    b.armR.rotation.z = lerp(b.armR.rotation.z, -0.22 + ads * 0.16, a);
    b.armR.rotation.y = lerp(b.armR.rotation.y, 0.18, a);
    b.foreR.rotation.x = lerp(b.foreR.rotation.x, -0.95 - ads * 0.25, a);
    // Left arm crosses to the foregrip.
    const support = 0.95 - ads * 0.35;
    b.armL.rotation.x = lerp(b.armL.rotation.x, -0.95 - ads * 0.12, a);
    b.armL.rotation.y = lerp(b.armL.rotation.y, support, a);
    b.armL.rotation.z = lerp(b.armL.rotation.z, 0.62 - ads * 0.30, a);
    b.foreL.rotation.x = lerp(b.foreL.rotation.x, -0.55 - ads * 0.3, a);
    b.foreL.rotation.y = lerp(b.foreL.rotation.y, -0.35, a);
  }

  /**
   * Poses the rig for the current actor state.
   * `dt` is the frame delta, `aimPitch` the desired upper-body aim.
   */
  update(actor: Actor, dt: number, aimPitch = 0): void {
    this.animTime += dt;
    const speed = actor.speed;
    const state = actor.moveState;
    const t = this.animTime;
    const b = this.bones;

    if (this.showcase) {
      this.updateShowcase(dt);
      return;
    }

    const running = clamp((speed - 3.6) / 3.6, 0, 1);
    const moving = clamp(speed / 4.0, 0, 1);
    const cycle = state === 'SPRINT' ? 11.2 : state === 'RUN' ? 8.4 : state === 'CROUCH_WALK' ? 5.2 : 6.2;
    const phase = t * cycle;

    const armed = this.weaponId !== '';
    const ads = clamp(actor.adsProgress, 0, 1);
    const targetAim = armed ? (actor.isLocal ? Math.max(0.62, ads) : ads > 0.4 ? ads : 0.55 + 0.3 * moving) : 0;
    this.aimBlend = damp(this.aimBlend, targetAim, 9, dt);

    if (actor.reloadTimer > 0) this.reloadBlend = Math.min(1, this.reloadBlend + dt * 4);
    else this.reloadBlend = Math.max(0, this.reloadBlend - dt * 4);

    if (actor.lastShotTime > this.lastShot) {
      this.fireKick = 1;
      this.lastShot = actor.lastShotTime;
    }
    this.fireKick = Math.max(0, this.fireKick - dt * 9);
    if (this.flinchTimer > 0) this.flinchTimer = Math.max(0, this.flinchTimer - dt);

    this.resetPose();
    const lean = state === 'SPRINT' ? 0.24 : state === 'RUN' ? 0.15 : 0;

    switch (state) {
      case 'IDLE':
      case 'CROUCH_IDLE':
      case 'RELOAD':
      case 'HEAL': {
        // Breathing + micro weight shifts keep the idle from looking frozen.
        this.breathPhase += dt * 1.5;
        const breath = Math.sin(this.breathPhase) * 0.012;
        const sway = Math.sin(this.breathPhase * 0.43) * 0.02;
        b.chest.rotation.x = -0.02 + breath;
        b.chest.rotation.y = sway;
        b.hips.rotation.y = -sway * 0.5;
        b.legL.rotation.x = 0.03;
        b.legR.rotation.x = -0.03;
        b.legL.rotation.z = 0.035;
        b.legR.rotation.z = -0.035;
        b.armL.rotation.x = 0.16;
        b.armR.rotation.x = 0.2;
        b.foreL.rotation.x = -0.3;
        b.foreR.rotation.x = -0.42;
        b.head.rotation.y = sway * 1.4;
        if (state === 'CROUCH_IDLE') {
          b.hips.position.y = HIP_Y - 0.20;
          b.legL.rotation.x = -0.95;
          b.legR.rotation.x = -0.85;
          b.shinL.rotation.x = 1.55;
          b.shinR.rotation.x = 1.45;
          b.legL.rotation.z = 0.10;
          b.legR.rotation.z = -0.10;
          b.spine.rotation.x = 0.26;
        }
        if (state === 'HEAL') {
          b.armL.rotation.x = 0.95;
          b.foreL.rotation.x = -1.6;
          b.armR.rotation.x = 0.7;
        }
        break;
      }
      case 'WALK':
      case 'RUN':
      case 'SPRINT': {
        const swing = state === 'SPRINT' ? 1.0 : state === 'RUN' ? 0.78 : 0.48;
        const legSwing = Math.sin(phase) * swing;
        const legSwing2 = Math.sin(phase + Math.PI) * swing;
        b.legL.rotation.x = legSwing;
        b.legR.rotation.x = legSwing2;
        // Knees only bend backwards and plant on contact.
        b.shinL.rotation.x = Math.max(0, -Math.cos(phase)) * swing * 1.6 + 0.1;
        b.shinR.rotation.x = Math.max(0, -Math.cos(phase + Math.PI)) * swing * 1.6 + 0.1;
        b.hips.position.y = HIP_Y + Math.abs(Math.sin(phase)) * 0.04 * moving - 0.045 * running;
        b.hips.rotation.y = Math.sin(phase) * 0.1 * moving;
        b.hips.rotation.z = Math.sin(phase * 2) * 0.02 * moving;
        b.spine.rotation.x = lean;
        b.chest.rotation.y = -Math.sin(phase) * 0.14 * moving;
        b.chest.rotation.z = -Math.sin(phase) * 0.03 * moving;
        // Arms counter-swing, but freeze into the weapon carry as aim rises.
        const free = 1 - this.aimBlend;
        b.armL.rotation.x = -legSwing * 0.85 * free;
        b.armR.rotation.x = -legSwing2 * 0.85 * free;
        b.armL.rotation.z = 0.16;
        b.armR.rotation.z = -0.16;
        b.foreL.rotation.x = -0.45 - 0.5 * this.aimBlend;
        b.foreR.rotation.x = -0.6 - 0.6 * this.aimBlend;
        break;
      }
      case 'CROUCH_WALK': {
        const p2 = t * 5.0;
        b.hips.position.y = HIP_Y - 0.20 + Math.abs(Math.sin(p2)) * 0.02;
        b.legL.rotation.x = -0.9 + Math.sin(p2) * 0.5;
        b.legR.rotation.x = -0.9 + Math.sin(p2 + Math.PI) * 0.5;
        b.shinL.rotation.x = 1.55 - Math.sin(p2) * 0.5;
        b.shinR.rotation.x = 1.55 - Math.sin(p2 + Math.PI) * 0.5;
        b.legL.rotation.z = 0.1;
        b.legR.rotation.z = -0.1;
        b.spine.rotation.x = 0.3;
        break;
      }
      case 'PRONE': {
        b.hips.position.y = 0.3;
        b.hips.rotation.x = -Math.PI / 2 + 0.12;
        b.legL.rotation.x = 0.12;
        b.legR.rotation.x = 0.16;
        b.shinL.rotation.x = 0.2;
        b.shinR.rotation.x = 0.1;
        b.spine.rotation.x = -0.28;
        b.head.rotation.x = -0.2;
        break;
      }
      case 'JUMP':
      case 'FALL': {
        const rising = state === 'JUMP';
        b.legL.rotation.x = rising ? -0.55 : 0.3;
        b.legR.rotation.x = rising ? 0.4 : -0.18;
        b.shinL.rotation.x = rising ? 0.75 : 0.4;
        b.shinR.rotation.x = rising ? 0.25 : 0.45;
        b.spine.rotation.x = rising ? -0.12 : 0.18;
        b.armL.rotation.z = 0.45 * (1 - this.aimBlend * 0.6);
        b.armR.rotation.z = -0.45 * (1 - this.aimBlend * 0.6);
        if (this.aimBlend < 0.3) {
          b.armL.rotation.x = -0.9;
          b.armR.rotation.x = -1.1;
        }
        break;
      }
      case 'LAND': {
        const k = Math.min(1, actor.landingImpact / 16);
        b.hips.position.y = HIP_Y - 0.32 * k;
        b.legL.rotation.x = -0.9 * k;
        b.legR.rotation.x = -0.9 * k;
        b.legL.rotation.z = 0.12 * k;
        b.legR.rotation.z = -0.12 * k;
        b.shinL.rotation.x = 1.65 * k;
        b.shinR.rotation.x = 1.65 * k;
        b.spine.rotation.x = 0.42 * k;
        break;
      }
      case 'SLIDE': {
        b.hips.position.y = 0.56;
        b.hips.rotation.x = -0.5;
        b.legL.rotation.x = -1.25;
        b.legR.rotation.x = -0.5;
        b.shinL.rotation.x = 1.25;
        b.shinR.rotation.x = 0.4;
        b.spine.rotation.x = 0.3;
        b.armL.rotation.x = -0.4;
        b.armR.rotation.x = 0.5;
        break;
      }
      case 'SWIM': {
        const p3 = t * 3.4;
        b.hips.position.y = 0.5;
        b.hips.rotation.x = -0.72;
        b.legL.rotation.x = Math.sin(p3) * 0.6;
        b.legR.rotation.x = Math.sin(p3 + Math.PI) * 0.6;
        b.shinL.rotation.x = 0.5;
        b.shinR.rotation.x = 0.5;
        b.armL.rotation.x = -1.4 + Math.sin(p3) * 0.85;
        b.armR.rotation.x = -1.4 + Math.sin(p3 + Math.PI) * 0.85;
        b.armL.rotation.z = 0.45;
        b.armR.rotation.z = -0.45;
        b.spine.rotation.x = -0.2;
        break;
      }
      case 'SKYDIVE': {
        b.hips.rotation.x = -1.1;
        b.spine.rotation.x = -0.3;
        b.head.rotation.x = -0.35;
        b.legL.rotation.x = 0.4;
        b.legR.rotation.x = 0.34;
        b.shinL.rotation.x = 0.5;
        b.shinR.rotation.x = 0.45;
        b.armL.rotation.z = 1.4;
        b.armR.rotation.z = -1.4;
        b.armL.rotation.x = -0.45;
        b.armR.rotation.x = -0.45;
        break;
      }
      case 'PARACHUTE': {
        b.hips.rotation.x = -0.32;
        b.legL.rotation.x = 0.55;
        b.legR.rotation.x = 0.4;
        b.shinL.rotation.x = 0.85;
        b.shinR.rotation.x = 0.72;
        b.armL.rotation.z = 1.5;
        b.armR.rotation.z = -1.5;
        b.armL.rotation.x = -2.35;
        b.armR.rotation.x = -2.35;
        break;
      }
      case 'DOWNED': {
        b.hips.position.y = 0.32;
        b.hips.rotation.x = -1.25;
        b.legL.rotation.x = 0.3;
        b.legR.rotation.x = 0.45;
        b.spine.rotation.x = -0.3;
        const crawl = Math.sin(t * 4) * 0.2;
        b.armL.rotation.z = 0.75 + crawl;
        b.armR.rotation.z = -0.75 - crawl;
        b.armL.rotation.x = -0.55;
        b.armR.rotation.x = -0.5;
        break;
      }
      case 'DEAD': {
        this.deathProgress = Math.min(1, this.deathProgress + dt * 2.2);
        const k = this.deathProgress;
        b.hips.position.y = lerp(HIP_Y, 0.24, k);
        b.hips.rotation.x = lerp(0, -1.5, k);
        b.legL.rotation.x = lerp(0, 0.3, k);
        b.legR.rotation.x = lerp(0, 0.55, k);
        b.armL.rotation.z = lerp(0, 1.35, k);
        b.armR.rotation.z = lerp(0, -1.15, k);
        b.armL.rotation.x = lerp(0, -0.5, k);
        b.armR.rotation.x = lerp(0, -0.35, k);
        b.head.rotation.x = lerp(0, 0.45, k);
        break;
      }
      case 'DRIVE': {
        b.hips.position.y = 0.6;
        b.legL.rotation.x = -1.15;
        b.legR.rotation.x = -1.15;
        b.shinL.rotation.x = 1.2;
        b.shinR.rotation.x = 1.2;
        b.spine.rotation.x = 0.1;
        break;
      }
      case 'CLIMB': {
        b.armL.rotation.x = -2.45;
        b.armR.rotation.x = -2.25;
        b.legL.rotation.x = -1.25;
        b.legR.rotation.x = -0.4;
        b.shinL.rotation.x = 1.35;
        b.spine.rotation.x = 0.3;
        break;
      }
      case 'AIRCRAFT':
      default: {
        b.armL.rotation.x = -2.55;
        b.armR.rotation.x = -2.55;
        b.legL.rotation.x = 0.15;
        b.legR.rotation.x = 0.12;
        break;
      }
    }

    // Two-handed carry and aim follow-through.
    const holdable = state === 'IDLE' || state === 'WALK' || state === 'RUN' || state === 'SPRINT' ||
      state === 'CROUCH_IDLE' || state === 'CROUCH_WALK' || state === 'JUMP' || state === 'FALL' ||
      state === 'LAND' || state === 'RELOAD' || state === 'HEAL';
    if (holdable && actor.vehicleId === null) this.holdWeapon(this.aimBlend, ads);

    // Upper-body aim: chest twists toward the pitch, head follows the target.
    const aimPitchClamped = clamp(aimPitch, -1.2, 1.2);
    if (this.aimBlend > 0.02 && holdable) {
      b.chest.rotation.x += aimPitchClamped * -0.5 * this.aimBlend;
      b.head.rotation.x += aimPitchClamped * -0.4 * this.aimBlend;
    }

    if (this.fireKick > 0.01) {
      b.foreR.rotation.x += this.fireKick * 0.24;
      b.armR.rotation.x += this.fireKick * 0.2;
      b.chest.rotation.x += this.fireKick * 0.07;
    }
    if (this.reloadBlend > 0.01) {
      const rp = Math.sin(this.animTime * 9) * 0.5 + 0.5;
      b.armL.rotation.x += this.reloadBlend * (-0.95 + rp * 0.5);
      b.foreL.rotation.x += this.reloadBlend * (-1.45 + rp * 0.9);
      b.foreL.rotation.z += this.reloadBlend * 0.4;
      b.armR.rotation.x += this.reloadBlend * 0.2;
    }
    if (this.flinchTimer > 0.01) {
      const f = this.flinchTimer * 2.2;
      b.chest.rotation.x -= f * 0.12;
      b.spine.rotation.x -= f * 0.06;
      b.armL.rotation.x -= f * 0.2;
      b.armR.rotation.x -= f * 0.15;
    }

    this.root.rotation.y = actor.yaw;
    this.root.position.set(actor.position.x, actor.position.y, actor.position.z);
    this.simpleRoot.rotation.y = actor.yaw;
    this.simpleRoot.position.copy(this.root.position);
    this.setParachute(state === 'PARACHUTE');
  }

  /**
   * Lobby pose: standing at rest with the weapon carried diagonally across the
   * chest, breathing and shifting weight so the model never looks like a
   * mannequin on the platform.
   */
  private updateShowcase(dt: number): void {
    const b = this.bones;
    this.showcasePhase += dt;
    const t = this.showcasePhase;
    const breath = Math.sin(t * 1.15) * 0.014;
    const sway = Math.sin(t * 0.37) * 0.035;
    this.resetPose();

    b.hips.position.y = HIP_Y + breath * 0.5;
    b.hips.rotation.y = sway;
    b.hips.rotation.z = 0.03;
    b.spine.rotation.x = 0.03 + breath * 0.4;
    b.spine.rotation.y = sway * 0.4;
    b.chest.rotation.x = -0.04 + breath;
    b.chest.rotation.y = -sway * 0.6;
    b.head.rotation.y = sway * 1.6;
    b.head.rotation.x = Math.sin(t * 0.53) * 0.05;

    // Weight on the right leg, left leg relaxed forward.
    b.legR.rotation.x = 0.02;
    b.legR.rotation.z = -0.05;
    b.shinR.rotation.x = 0.08;
    b.legL.rotation.x = -0.18;
    b.legL.rotation.z = 0.12;
    b.shinL.rotation.x = 0.26;

    if (this.weaponId) {
      // Low-ready hero carry: both hands on the weapon, muzzle down and across.
      this.holdWeapon(1, 0);
      b.armR.rotation.x += 0.16 + breath * 0.6;
      b.armR.rotation.y -= 0.1;
      b.foreR.rotation.x += 0.18;
      b.armL.rotation.x += 0.18 + breath * 0.5;
      b.foreL.rotation.x += 0.22;
      b.spine.rotation.y = -0.16;
      b.spine.rotation.x += 0.02;
      b.chest.rotation.y = -0.14;
      // Cant the weapon inboard so the muzzle points to the deck, not the sky.
      this.bones.weaponAnchor.rotation.set(Math.PI / 2 - 0.45, 0.42, 0);
      this.bones.weaponAnchor.position.set(0.01, -0.235, 0.012);
    } else {
      b.armL.rotation.x = 0.06 + breath;
      b.armR.rotation.x = 0.06 + breath;
      b.armL.rotation.z = 0.10;
      b.armR.rotation.z = -0.10;
      b.foreL.rotation.x = -0.22;
      b.foreR.rotation.x = -0.22;
    }

    this.root.rotation.y = 0;
    this.root.position.set(0, 0, 0);
    this.setParachute(false);
  }

  /** Advances the lobby/showcase pose without an Actor (menus own the rig). */
  tickShowcase(dt: number): void {
    if (!this.showcase) return;
    this.updateShowcase(dt);
  }

  /** Which weapon model is currently attached. */
  get currentWeapon(): string {
    return this.weaponId;
  }

  /** Death pose progress reset (when respawning). */
  reset(): void {
    this.deathProgress = 0;
    this.animTime = 0;
    this.bones.weaponAnchor.rotation.set(Math.PI / 2, 0, 0);
    this.bones.weaponAnchor.position.set(0, -0.235, 0.012);
  }

  /** Geometry is shared between rigs, so there is nothing per-rig to free. */
  dispose(): void {
    if (this.weaponMesh) {
      this.bones.weaponAnchor.remove(this.weaponMesh);
      this.weaponMesh = null;
    }
    this.parachute = null;
  }
}

/* ------------------------------------------------------------------ */
/* Original weapon shapes                                              */
/* ------------------------------------------------------------------ */

/** Smooth primitives keep the weapons consistent with the body style. */
function wbox(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return roundBox(w, h, d, Math.min(w, h) * 0.22, x, y, z, Math.min(0.008, w * 0.15));
}
function wcyl(rTop: number, rBot: number, h: number, x: number, y: number, z: number, rotX = 0, seg = 10): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  if (rotX) g.rotateX(rotX);
  g.translate(x, y, z);
  return g;
}

/** Original weapon shapes, matched to the weapon class. */
/**
 * Where the hand closes on each weapon class, in the model's own space.
 * The merged mesh is translated by the negative of this so the *grip* becomes
 * the origin — then the hand's weapon anchor only has to orient the model, and
 * the gun automatically sits in the fist instead of floating beside it.
 */
const GRIP_POINT: Record<string, [number, number, number]> = {
  AR: [0, -0.055, -0.16],
  SMG: [0, -0.05, -0.13],
  SHOTGUN: [0, -0.06, -0.24],
  DMR: [0, -0.055, -0.2],
  SNIPER: [0, -0.10, -0.05],
  LMG: [0, -0.06, -0.2],
  PISTOL: [0, -0.095, -0.03],
  MELEE: [0, 0, -0.05]
};

export function buildWeaponGeometry(weaponId: string): THREE.BufferGeometry | null {
  const cls = weaponClassOf(weaponId);
  const geoms: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry): void => { geoms.push(g); };
  const stock = (len: number, y: number): THREE.BufferGeometry => wbox(0.05, 0.075, len, 0, y, -0.30 - len / 2 + 0.06);
  const optic = (): THREE.BufferGeometry[] => [
    wcyl(0.026, 0.026, 0.11, 0, 0.085, 0.02, Math.PI / 2, 10),
    wbox(0.05, 0.035, 0.06, 0, 0.062, 0.02),
    wbox(0.03, 0.03, 0.02, 0, 0.085, 0.1)
  ];

  switch (cls) {
    case 'AR':
      add(wbox(0.062, 0.095, 0.5, 0, 0, 0));
      add(wbox(0.048, 0.15, 0.085, 0, -0.105, 0.04));      // curved mag
      add(wcyl(0.019, 0.019, 0.26, 0, 0.005, 0.32, Math.PI / 2)); // barrel
      add(wbox(0.042, 0.075, 0.11, 0, -0.055, -0.16));     // grip
      add(stock(0.20, -0.005));
      add(wbox(0.05, 0.05, 0.13, 0, -0.045, 0.16));        // handguard
      for (const g of optic()) add(g);
      break;
    case 'SMG':
      add(wbox(0.058, 0.085, 0.34, 0, 0, 0));
      add(wcyl(0.032, 0.032, 0.19, 0, -0.12, 0.02, Math.PI / 2));  // fat can mag
      add(wcyl(0.016, 0.016, 0.16, 0, 0, 0.22, Math.PI / 2));
      add(wbox(0.04, 0.07, 0.10, 0, -0.05, -0.13));
      add(wbox(0.045, 0.055, 0.16, 0, -0.005, -0.22));     // folded stock
      add(wbox(0.045, 0.05, 0.12, 0, -0.04, 0.12));
      break;
    case 'SHOTGUN':
      add(wbox(0.07, 0.095, 0.66, 0, 0, 0));
      add(wcyl(0.024, 0.024, 0.5, 0, 0.05, 0.34, Math.PI / 2));   // twin tubes
      add(wcyl(0.024, 0.024, 0.44, 0, -0.01, 0.30, Math.PI / 2));
      add(wbox(0.05, 0.095, 0.16, 0, -0.06, -0.24));
      add(wbox(0.055, 0.045, 0.14, 0, -0.015, 0.14));      // pump
      break;
    case 'DMR':
      add(wbox(0.062, 0.09, 0.64, 0, 0, 0));
      add(wbox(0.05, 0.17, 0.095, 0, -0.115, 0.04));
      add(wcyl(0.017, 0.017, 0.5, 0, 0.01, 0.44, Math.PI / 2));
      add(wbox(0.042, 0.075, 0.13, 0, -0.055, -0.2));
      add(stock(0.28, 0));
      for (const g of optic()) add(g);
      break;
    case 'SNIPER':
      add(wbox(0.06, 0.10, 0.88, 0, 0, 0));
      add(wcyl(0.015, 0.015, 0.78, 0, 0.015, 0.68, Math.PI / 2));
      add(wbox(0.042, 0.14, 0.09, 0, -0.10, 0.05));
      add(stock(0.34, -0.01));
      add(wcyl(0.03, 0.03, 0.3, 0, 0.105, 0.03, Math.PI / 2));  // scope tube
      add(wcyl(0.045, 0.045, 0.05, 0, 0.105, -0.11, Math.PI / 2)); // eyepiece
      add(wcyl(0.04, 0.04, 0.05, 0, 0.105, 0.19, Math.PI / 2));
      add(wbox(0.03, 0.06, 0.03, 0, 0.07, 0.03));
      add(wbox(0.03, 0.06, 0.03, 0, 0.07, -0.03));
      break;
    case 'LMG':
      add(wbox(0.075, 0.115, 0.66, 0, 0, 0));
      add(wbox(0.085, 0.19, 0.15, 0, -0.145, 0.03));       // box mag
      add(wcyl(0.022, 0.022, 0.44, 0, 0.012, 0.52, Math.PI / 2));
      add(wbox(0.045, 0.075, 0.15, 0, -0.06, -0.2));
      add(stock(0.26, -0.005));
      add(wbox(0.055, 0.05, 0.16, 0, -0.05, 0.16));
      break;
    case 'PISTOL':
      add(wbox(0.042, 0.085, 0.19, 0, 0, 0));
      add(wbox(0.038, 0.115, 0.05, 0, -0.095, -0.03));
      add(wcyl(0.011, 0.011, 0.09, 0, 0.005, 0.13, Math.PI / 2));
      add(wbox(0.02, 0.02, 0.03, 0, 0.05, -0.06));
      break;
    case 'MELEE':
      add(wbox(0.032, 0.032, 0.13, 0, 0, -0.05));          // handle
      add(wbox(0.014, 0.09, 0.28, 0, 0.02, 0.14));         // blade
      add(wbox(0.07, 0.025, 0.04, 0, 0, -0.11));           // guard
      break;
    default:
      return null;
  }
  const merged = mergeAll(geoms);
  const grip = GRIP_POINT[cls] ?? [0, 0, 0];
  merged.translate(-grip[0], -grip[1], -grip[2]);
  return merged;
}

export function weaponClassOf(weaponId: string): string {
  if (!weaponId) return 'AR';
  const map: Record<string, string> = {
    vk77: 'AR', ar4: 'AR', tempest: 'AR',
    hornet9: 'SMG', vex45: 'SMG',
    breach12: 'SHOTGUN', auto12: 'SHOTGUN',
    bolt7: 'DMR', specter: 'SNIPER', longshot: 'SNIPER',
    bulwark: 'LMG', p9: 'PISTOL', raven50: 'PISTOL',
    blade: 'MELEE', crowbar: 'MELEE'
  };
  return map[weaponId] ?? 'AR';
}
