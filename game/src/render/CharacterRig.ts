import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Actor } from '../entity/Actor';
import { clamp, damp, lerp } from '../utils/mathx';

/**
 * Procedural humanoid character.
 *
 * Built entirely from generated geometry (no external models): realistic-ish
 * proportions (~7.5 heads tall), tactical clothing layers, hands with fingers,
 * boots, and a head with facial features. Animation is procedural — walk/run/
 * sprint cycles, crouch, prone, jump/land, aim, reload, swim, skydive, chute,
 * downed and death poses — blended by a state machine driven from Actor.
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

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function cyl(rTop: number, rBot: number, h: number, x: number, y: number, z: number, seg = 8, rotX = 0, rotZ = 0): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  if (rotX) g.rotateX(rotX);
  if (rotZ) g.rotateZ(rotZ);
  g.translate(x, y, z);
  return g;
}

function sphere(r: number, x: number, y: number, z: number, wSeg = 10, hSeg = 8): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, wSeg, hSeg);
  g.translate(x, y, z);
  return g;
}

function mergeTo(geoms: THREE.BufferGeometry[], material: THREE.Material, name: string): THREE.Mesh {
  const merged = mergeGeometries(geoms, false);
  for (const g of geoms) g.dispose();
  const mesh = new THREE.Mesh(merged ?? new THREE.BufferGeometry(), material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  return mesh;
}

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
  /** Hit-reaction impulse, decays quickly (see `flinch`). */
  private flinchTimer = 0;

  constructor(paletteIndex = 0, cosmetic: { helmet?: boolean; vest?: boolean } = {}) {
    this.palette = SKINS[paletteIndex % SKINS.length];
    const p = this.palette;
    const useHelmet = cosmetic.helmet ?? true;
    const useVest = cosmetic.vest ?? true;

    /* ---------------- Hierarchy ---------------- */
    const root = this.root;
    root.name = 'character';
    const hips = new THREE.Group();
    hips.position.y = 0.94;
    root.add(hips);

    const spine = new THREE.Group();
    hips.add(spine);

    const chest = new THREE.Group();
    chest.position.y = 0.14;
    spine.add(chest);

    const head = new THREE.Group();
    head.position.y = 0.44;
    chest.add(head);

    const armL = new THREE.Group();
    armL.position.set(0.235, 0.32, 0);
    chest.add(armL);
    const armR = new THREE.Group();
    armR.position.set(-0.235, 0.32, 0);
    chest.add(armR);

    const foreL = new THREE.Group();
    foreL.position.y = -0.30;
    armL.add(foreL);
    const foreR = new THREE.Group();
    foreR.position.y = -0.30;
    armR.add(foreR);

    const legL = new THREE.Group();
    legL.position.set(0.105, -0.02, 0);
    hips.add(legL);
    const legR = new THREE.Group();
    legR.position.set(-0.105, -0.02, 0);
    hips.add(legR);

    const shinL = new THREE.Group();
    shinL.position.y = -0.44;
    legL.add(shinL);
    const shinR = new THREE.Group();
    shinR.position.y = -0.44;
    legR.add(shinR);

    const weaponAnchor = new THREE.Group();
    weaponAnchor.position.set(0, -0.32, -0.12);
    foreR.add(weaponAnchor);

    this.bones = { root, hips, spine, chest, head, armL, armR, foreL, foreR, legL, legR, shinL, shinR, weaponAnchor, chute: null };

    /* ---------------- Body parts ---------------- */
    // Hips / pelvis
    const pelvis = mergeTo([
      box(0.30, 0.20, 0.20, 0, 0.02, 0),
      box(0.32, 0.10, 0.22, 0, -0.08, 0)
    ], mat(p.pants, 0.85), 'pelvis');
    hips.add(pelvis);

    // Torso: shirt + chest volume + plate carrier
    const torsoGeoms: THREE.BufferGeometry[] = [
      box(0.36, 0.34, 0.22, 0, 0.20, 0),
      box(0.34, 0.16, 0.21, 0, 0.40, 0),
      box(0.30, 0.10, 0.20, 0, 0.02, 0)
    ];
    if (useVest) {
      torsoGeoms.push(box(0.40, 0.30, 0.26, 0, 0.22, 0)); // plate carrier
      torsoGeoms.push(box(0.12, 0.12, 0.05, 0.14, 0.34, -0.14)); // pouch
      torsoGeoms.push(box(0.12, 0.12, 0.05, -0.14, 0.30, -0.14));
    }
    const torso = mergeTo(torsoGeoms, mat(useVest ? p.vest : p.shirt, 0.82), 'torso');
    chest.add(torso);

    // Shoulders
    const shoulderL = mergeTo([sphere(0.105, 0, 0, 0, 8, 6)], mat(p.shirt, 0.85), 'shoulderL');
    armL.add(shoulderL);
    const shoulderR = mergeTo([sphere(0.105, 0, 0, 0, 8, 6)], mat(p.shirt, 0.85), 'shoulderR');
    armR.add(shoulderR);

    // Upper arms
    const upperL = mergeTo([cyl(0.075, 0.065, 0.30, 0, -0.15, 0, 8)], mat(p.shirt, 0.82), 'upperL');
    armL.add(upperL);
    const upperR = mergeTo([cyl(0.075, 0.065, 0.30, 0, -0.15, 0, 8)], mat(p.shirt, 0.82), 'upperR');
    armR.add(upperR);

    // Forearms + hands with fingers
    const handGeoms = (side: number): THREE.BufferGeometry[] => {
      const g: THREE.BufferGeometry[] = [
        cyl(0.062, 0.055, 0.26, 0, -0.13, 0, 8), // forearm
        box(0.075, 0.10, 0.045, 0, -0.29, 0) // palm
      ];
      // four fingers + thumb
      for (let f = 0; f < 4; f++) {
        const off = -0.027 + f * 0.018;
        g.push(box(0.016, 0.055, 0.028, off, -0.355, 0));
      }
      g.push(box(0.02, 0.045, 0.03, side * 0.045, -0.30, 0.005));
      return g;
    };
    foreL.add(mergeTo(handGeoms(1), mat(p.skin, 0.72), 'forearmL'));
    foreR.add(mergeTo(handGeoms(-1), mat(p.skin, 0.72), 'forearmR'));

    // Legs
    const thighL = mergeTo([cyl(0.095, 0.082, 0.42, 0, -0.21, 0, 8)], mat(p.pants, 0.85), 'thighL');
    legL.add(thighL);
    const thighR = mergeTo([cyl(0.095, 0.082, 0.42, 0, -0.21, 0, 8)], mat(p.pants, 0.85), 'thighR');
    legR.add(thighR);

    const shinGeoms: THREE.BufferGeometry[] = [
      cyl(0.075, 0.06, 0.42, 0, -0.21, 0, 8),
      box(0.11, 0.09, 0.24, 0, -0.44, -0.04) // boot
    ];
    shinL.add(mergeTo(shinGeoms.map((g) => g), mat(p.boots, 0.7, 0.08), 'shinL'));
    shinR.add(mergeTo([cyl(0.075, 0.06, 0.42, 0, -0.21, 0, 8), box(0.11, 0.09, 0.24, 0, -0.44, -0.04)], mat(p.boots, 0.7, 0.08), 'shinR'));

    // Head: skull, jaw, nose, eyes, brows, ears, hair/helmet
    const headGeoms: THREE.BufferGeometry[] = [
      sphere(0.115, 0, 0.02, 0, 12, 10),
      box(0.16, 0.10, 0.17, 0, -0.045, 0),   // jaw
      box(0.035, 0.045, 0.03, 0, -0.005, -0.11) // nose
    ];
    const headMesh = mergeTo(headGeoms, mat(p.skin, 0.68), 'head');
    head.add(headMesh);

    const faceGeoms: THREE.BufferGeometry[] = [
      sphere(0.019, 0.045, 0.035, -0.098, 7, 6),  // eye
      sphere(0.019, -0.045, 0.035, -0.098, 7, 6),
      box(0.05, 0.012, 0.02, 0.045, 0.062, -0.10), // brow
      box(0.05, 0.012, 0.02, -0.045, 0.062, -0.10),
      box(0.03, 0.02, 0.02, 0, -0.055, -0.098)     // mouth line
    ];
    head.add(mergeTo(faceGeoms, mat(0x1a1614, 0.5), 'face'));

    if (useHelmet) {
      const helmet = mergeTo([
        sphere(0.135, 0, 0.03, 0, 12, 10),
        box(0.22, 0.06, 0.20, 0, 0.02, 0.02)
      ], mat(p.helmet, 0.55, 0.15), 'helmet');
      helmet.scale.set(1, 0.92, 1.06);
      head.add(helmet);
      const goggles = mergeTo([box(0.17, 0.05, 0.05, 0, 0.03, -0.10)], mat(0x1e2a33, 0.25, 0.4), 'goggles');
      head.add(goggles);
    } else {
      const hair = mergeTo([sphere(0.122, 0, 0.035, 0.006, 12, 8)], mat(p.hair, 0.9), 'hair');
      hair.scale.set(1, 0.85, 1.02);
      head.add(hair);
    }
    const ears = mergeTo([sphere(0.028, 0.115, 0.01, 0.01, 6, 5), sphere(0.028, -0.115, 0.01, 0.01, 6, 5)], mat(p.skin, 0.7), 'ears');
    head.add(ears);
    // Neck
    chest.add(mergeTo([cyl(0.055, 0.06, 0.10, 0, 0.42, 0, 8)], mat(p.skin, 0.7), 'neck'));

    /* ---------------- Simplified LOD body ---------------- */
    const simpleGeoms: THREE.BufferGeometry[] = [
      box(0.34, 0.34, 0.22, 0, 1.24, 0),
      box(0.30, 0.20, 0.20, 0, 0.96, 0),
      cyl(0.075, 0.065, 0.30, 0.22, 1.24, 0, 6),
      cyl(0.075, 0.065, 0.30, -0.22, 1.24, 0, 6),
      cyl(0.09, 0.08, 0.44, 0.105, 0.68, 0, 6),
      cyl(0.09, 0.08, 0.44, -0.105, 0.68, 0, 6),
      box(0.11, 0.09, 0.2, 0.105, 0.24, -0.03),
      box(0.11, 0.09, 0.2, -0.105, 0.24, -0.03)
    ];
    const simpleBodyGeom = mergeGeometries(simpleGeoms, false);
    for (const g of simpleGeoms) g.dispose();
    this.simpleBody = new THREE.Mesh(simpleBodyGeom ?? new THREE.BufferGeometry(), mat(useVest ? p.vest : p.shirt, 0.82));
    this.simpleBody.castShadow = true;
    this.simpleRoot.add(this.simpleBody);
    const simpleHeadGeom = mergeGeometries([sphere(0.12, 0, 1.63, 0, 8, 6)], false);
    this.simpleHead = new THREE.Mesh(simpleHeadGeom ?? new THREE.BufferGeometry(), mat(useHelmet ? p.helmet : p.skin, 0.6));
    this.simpleHead.castShadow = true;
    this.simpleRoot.add(this.simpleHead);
    this.simpleRoot.visible = false;

    // Team/identification band (original "squad marker" design)
    const band = mergeTo([box(0.42, 0.045, 0.24, 0, 1.34, 0)], mat(p.accent, 0.6, 0.3), 'band');
    chest.add(band);
  }

  /** Swaps the held weapon model. */
  setWeapon(weaponId: string | null, scale = 1): void {
    if (weaponId === this.weaponId) return;
    this.weaponId = weaponId ?? '';
    if (this.weaponMesh) {
      this.bones.weaponAnchor.remove(this.weaponMesh);
      this.weaponMesh.geometry.dispose();
      this.weaponMesh = null;
    }
    if (!weaponId) return;
    const geo = buildWeaponGeometry(weaponId);
    if (!geo) return;
    const m = new THREE.Mesh(geo, mat(0x2e3238, 0.5, 0.55));
    m.castShadow = true;
    m.scale.setScalar(scale);
    this.bones.weaponAnchor.add(m);
    this.weaponMesh = m;
  }

  /** Deploys or hides the parachute canopy. */
  setParachute(visible: boolean): void {
    if (visible && !this.parachute) {
      const canopyGeom = mergeGeometries([
        new THREE.SphereGeometry(1.7, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
        box(0.06, 1.4, 0.06, 0.7, -0.7, 0),
        box(0.06, 1.4, 0.06, -0.7, -0.7, 0),
        box(0.06, 1.4, 0.06, 0, -0.7, 0.7),
        box(0.06, 1.4, 0.06, 0, -0.7, -0.7)
      ], false);
      const m = new THREE.Mesh(canopyGeom ?? new THREE.BufferGeometry(), mat(this.palette.accent, 0.95, 0));
      m.position.y = 2.15;
      m.scale.set(1, 0.62, 1);
      m.castShadow = true;
      this.root.add(m);
      this.parachute = m;
    } else if (!visible && this.parachute) {
      this.root.remove(this.parachute);
      this.parachute.geometry.dispose();
      this.parachute = null;
    }
  }

  /** Chooses full or simplified representation based on camera distance. */
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
   * Poses the rig for the current actor state.
   * `dt` is the frame delta, `aimYaw`/`aimPitch` the desired upper-body aim.
   */
  update(actor: Actor, dt: number, aimPitch = 0): void {
    this.animTime += dt;
    const speed = actor.speed;
    const state = actor.moveState;
    const t = this.animTime;
    const b = this.bones;

    // Blend helpers
    const running = clamp((speed - 3.6) / 3.6, 0, 1);
    const moving = clamp(speed / 4.0, 0, 1);
    const cycle = state === 'SPRINT' ? 11.5 : state === 'RUN' ? 8.6 : state === 'CROUCH_WALK' ? 5.2 : 6.4;
    const phase = t * cycle;

    this.aimBlend = damp(this.aimBlend, actor.adsProgress > 0.4 || actor.isLocal ? actor.adsProgress : 0.35 * clamp(speed / 4, 0, 1), 8, dt);

    // Weapon switching / reload animation state
    if (actor.reloadTimer > 0) this.reloadBlend = Math.min(1, this.reloadBlend + dt * 4);
    else this.reloadBlend = Math.max(0, this.reloadBlend - dt * 4);

    if (actor.lastShotTime > this.lastShot) {
      this.fireKick = 1;
      this.lastShot = actor.lastShotTime;
    }
    this.fireKick = Math.max(0, this.fireKick - dt * 9);
    if (this.flinchTimer > 0) this.flinchTimer = Math.max(0, this.flinchTimer - dt);

    // Reset base pose each frame
    b.hips.position.set(0, 0.94, 0);
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

    const lean = state === 'SPRINT' ? 0.22 : state === 'RUN' ? 0.14 : 0;

    switch (state) {
      case 'IDLE':
      case 'CROUCH_IDLE':
      case 'RELOAD':
      case 'HEAL': {
        this.breathPhase += dt * 1.6;
        const breath = Math.sin(this.breathPhase) * 0.012;
        b.chest.rotation.x = -0.02 + breath;
        b.armL.rotation.x = 0.16;
        b.armR.rotation.x = 0.2;
        b.foreL.rotation.x = -0.25;
        b.foreR.rotation.x = -0.35;
        b.legL.rotation.x = 0.02;
        b.legR.rotation.x = -0.02;
        if (state === 'CROUCH_IDLE') {
          b.hips.position.y = 0.72;
          b.legL.rotation.x = -0.9;
          b.legR.rotation.x = -0.9;
          b.shinL.rotation.x = 1.5;
          b.shinR.rotation.x = 1.5;
          b.spine.rotation.x = 0.24;
        }
        if (state === 'HEAL') {
          b.armL.rotation.x = 0.9;
          b.foreL.rotation.x = -1.5;
          b.armR.rotation.x = 0.7;
        }
        break;
      }
      case 'WALK':
      case 'RUN':
      case 'SPRINT': {
        const swing = state === 'SPRINT' ? 0.95 : state === 'RUN' ? 0.72 : 0.45;
        const legSwing = Math.sin(phase) * swing;
        const legSwing2 = Math.sin(phase + Math.PI) * swing;
        b.legL.rotation.x = legSwing;
        b.legR.rotation.x = legSwing2;
        b.shinL.rotation.x = Math.max(0, -Math.cos(phase)) * swing * 1.5 + 0.12;
        b.shinR.rotation.x = Math.max(0, -Math.cos(phase + Math.PI)) * swing * 1.5 + 0.12;
        b.hips.position.y = 0.94 + Math.abs(Math.sin(phase)) * 0.035 * moving - 0.03 * running;
        b.hips.rotation.y = Math.sin(phase) * 0.09 * moving;
        b.spine.rotation.x = lean;
        b.chest.rotation.y = -Math.sin(phase) * 0.12 * moving;
        // Arms counter-swing (less when aiming)
        const armSwing = (1 - this.aimBlend * 0.75) * swing * 1.1;
        b.armL.rotation.x = -legSwing * 0.9 * (1 - this.aimBlend) + this.aimBlend * 0.6;
        b.armR.rotation.x = -legSwing2 * 0.9 * (1 - this.aimBlend) + this.aimBlend * 0.85;
        b.armL.rotation.z = 0.14 + this.aimBlend * 0.35;
        b.armR.rotation.z = -0.14 - this.aimBlend * 0.35;
        b.foreL.rotation.x = -0.5 - this.aimBlend * 0.6;
        b.foreR.rotation.x = -0.7 - this.aimBlend * 0.8;
        void armSwing;
        break;
      }
      case 'CROUCH_WALK': {
        const p2 = t * 5.0;
        b.hips.position.y = 0.72 + Math.abs(Math.sin(p2)) * 0.02;
        b.legL.rotation.x = -0.85 + Math.sin(p2) * 0.5;
        b.legR.rotation.x = -0.85 + Math.sin(p2 + Math.PI) * 0.5;
        b.shinL.rotation.x = 1.5 - Math.sin(p2) * 0.5;
        b.shinR.rotation.x = 1.5 - Math.sin(p2 + Math.PI) * 0.5;
        b.spine.rotation.x = 0.3;
        b.armL.rotation.x = 0.3;
        b.armR.rotation.x = 0.4;
        b.foreL.rotation.x = -0.8;
        b.foreR.rotation.x = -1.0;
        break;
      }
      case 'PRONE': {
        b.hips.position.y = 0.28;
        b.hips.rotation.x = -Math.PI / 2 + 0.12;
        b.legL.rotation.x = 0.12;
        b.legR.rotation.x = 0.16;
        b.shinL.rotation.x = 0.2;
        b.shinR.rotation.x = 0.1;
        b.spine.rotation.x = -0.25;
        b.armL.rotation.x = -0.5;
        b.armR.rotation.x = -0.55;
        b.foreL.rotation.x = -1.0;
        b.foreR.rotation.x = -1.1;
        break;
      }
      case 'JUMP':
      case 'FALL': {
        const rising = state === 'JUMP';
        b.legL.rotation.x = rising ? -0.5 : 0.25;
        b.legR.rotation.x = rising ? 0.35 : -0.15;
        b.shinL.rotation.x = rising ? 0.7 : 0.35;
        b.shinR.rotation.x = rising ? 0.2 : 0.4;
        b.armL.rotation.x = -0.9 + this.aimBlend;
        b.armR.rotation.x = -1.1 + this.aimBlend * 0.5;
        b.armL.rotation.z = 0.5;
        b.armR.rotation.z = -0.5;
        b.foreL.rotation.x = -0.6;
        b.foreR.rotation.x = -0.8;
        b.spine.rotation.x = rising ? -0.1 : 0.16;
        break;
      }
      case 'LAND': {
        const k = Math.min(1, actor.landingImpact / 16);
        b.hips.position.y = 0.94 - 0.3 * k;
        b.legL.rotation.x = -0.9 * k;
        b.legR.rotation.x = -0.9 * k;
        b.shinL.rotation.x = 1.6 * k;
        b.shinR.rotation.x = 1.6 * k;
        b.spine.rotation.x = 0.4 * k;
        b.armL.rotation.x = 0.6 * k;
        b.armR.rotation.x = 0.6 * k;
        break;
      }
      case 'SLIDE': {
        b.hips.position.y = 0.55;
        b.hips.rotation.x = -0.5;
        b.legL.rotation.x = -1.2;
        b.legR.rotation.x = -0.5;
        b.shinL.rotation.x = 1.2;
        b.shinR.rotation.x = 0.4;
        b.spine.rotation.x = 0.3;
        b.armL.rotation.x = -0.4;
        b.armR.rotation.x = 0.5;
        break;
      }
      case 'SWIM': {
        const p3 = t * 3.4;
        b.hips.position.y = 0.5;
        b.hips.rotation.x = -0.7;
        b.legL.rotation.x = Math.sin(p3) * 0.6;
        b.legR.rotation.x = Math.sin(p3 + Math.PI) * 0.6;
        b.shinL.rotation.x = 0.5;
        b.shinR.rotation.x = 0.5;
        b.armL.rotation.x = -1.4 + Math.sin(p3) * 0.8;
        b.armR.rotation.x = -1.4 + Math.sin(p3 + Math.PI) * 0.8;
        b.armL.rotation.z = 0.4;
        b.armR.rotation.z = -0.4;
        b.spine.rotation.x = -0.2;
        break;
      }
      case 'SKYDIVE': {
        b.hips.rotation.x = -1.15;
        b.spine.rotation.x = -0.25;
        b.legL.rotation.x = 0.35;
        b.legR.rotation.x = 0.3;
        b.shinL.rotation.x = 0.5;
        b.shinR.rotation.x = 0.45;
        b.armL.rotation.z = 1.35;
        b.armR.rotation.z = -1.35;
        b.armL.rotation.x = -0.4;
        b.armR.rotation.x = -0.4;
        b.foreL.rotation.x = -0.5;
        b.foreR.rotation.x = -0.5;
        break;
      }
      case 'PARACHUTE': {
        b.hips.rotation.x = -0.35;
        b.legL.rotation.x = 0.5;
        b.legR.rotation.x = 0.35;
        b.shinL.rotation.x = 0.8;
        b.shinR.rotation.x = 0.7;
        b.armL.rotation.z = 1.5;
        b.armR.rotation.z = -1.5;
        b.armL.rotation.x = -2.4;
        b.armR.rotation.x = -2.4;
        b.foreL.rotation.x = -0.3;
        b.foreR.rotation.x = -0.35;
        break;
      }
      case 'DOWNED': {
        b.hips.position.y = 0.3;
        b.hips.rotation.x = -1.2;
        b.legL.rotation.x = 0.3;
        b.legR.rotation.x = 0.45;
        b.armL.rotation.x = -0.6;
        b.armR.rotation.x = -0.5;
        b.spine.rotation.x = -0.3;
        const crawl = Math.sin(t * 4) * 0.2;
        b.armL.rotation.z = 0.7 + crawl;
        b.armR.rotation.z = -0.7 - crawl;
        break;
      }
      case 'DEAD': {
        this.deathProgress = Math.min(1, this.deathProgress + dt * 2.2);
        const k = this.deathProgress;
        b.hips.position.y = lerp(0.94, 0.26, k);
        b.hips.rotation.x = lerp(0, -1.45, k);
        b.legL.rotation.x = lerp(0, 0.25, k);
        b.legR.rotation.x = lerp(0, 0.5, k);
        b.armL.rotation.z = lerp(0, 1.3, k);
        b.armR.rotation.z = lerp(0, -1.1, k);
        b.armL.rotation.x = lerp(0, -0.5, k);
        b.armR.rotation.x = lerp(0, -0.35, k);
        b.head.rotation.x = lerp(0, 0.4, k);
        break;
      }
      case 'DRIVE': {
        b.hips.position.y = 0.6;
        b.legL.rotation.x = -1.1;
        b.legR.rotation.x = -1.1;
        b.shinL.rotation.x = 1.2;
        b.shinR.rotation.x = 1.2;
        b.armL.rotation.x = -1.2;
        b.armR.rotation.x = -1.2;
        b.foreL.rotation.x = -0.7;
        b.foreR.rotation.x = -0.7;
        break;
      }
      case 'CLIMB': {
        b.armL.rotation.x = -2.4;
        b.armR.rotation.x = -2.2;
        b.legL.rotation.x = -1.2;
        b.legR.rotation.x = -0.4;
        b.shinL.rotation.x = 1.3;
        b.spine.rotation.x = 0.3;
        break;
      }
      case 'AIRCRAFT':
      default: {
        b.armL.rotation.x = -2.6;
        b.armR.rotation.x = -2.6;
        b.legL.rotation.x = 0.15;
        b.legR.rotation.x = 0.12;
        break;
      }
    }

    // Upper body aim: rotate the chest toward the aim pitch and roll shoulders.
    const aimPitchClamped = clamp(aimPitch, -1.2, 1.2);
    if (this.aimBlend > 0.02 && (state === 'IDLE' || state === 'WALK' || state === 'RUN' || state === 'SPRINT' || state === 'CROUCH_IDLE' || state === 'CROUCH_WALK')) {
      b.chest.rotation.x += aimPitchClamped * -0.55 * this.aimBlend;
      b.head.rotation.x += aimPitchClamped * -0.35 * this.aimBlend;
      b.armR.rotation.x += this.aimBlend * -0.5;
      b.armL.rotation.x += this.aimBlend * -0.35;
      b.armR.rotation.z += this.aimBlend * -0.25;
      b.armL.rotation.z += this.aimBlend * 0.28;
    }

    // Fire kick on the weapon arm
    if (this.fireKick > 0.01) {
      b.foreR.rotation.x += this.fireKick * 0.22;
      b.armR.rotation.x += this.fireKick * 0.18;
      b.chest.rotation.x += this.fireKick * 0.06;
    }
    // Reload motion: hand travels to the magazine
    if (this.reloadBlend > 0.01) {
      const rp = Math.sin(this.animTime * 9) * 0.5 + 0.5;
      b.armL.rotation.x += this.reloadBlend * (-0.9 + rp * 0.5);
      b.foreL.rotation.x += this.reloadBlend * (-1.4 + rp * 0.9);
      b.foreL.rotation.z += this.reloadBlend * 0.4;
      b.armR.rotation.x += this.reloadBlend * 0.18;
    }

    // Whole-body orientation follows the actor's yaw.
    this.root.rotation.y = actor.yaw;
    this.root.position.set(actor.position.x, actor.position.y, actor.position.z);
    this.simpleRoot.rotation.y = actor.yaw;
    this.simpleRoot.position.copy(this.root.position);
    this.setParachute(state === 'PARACHUTE');
  }

  private deathProgress = 0;

  /** Death pose progress reset (when respawning). */
  reset(): void {
    this.deathProgress = 0;
    this.animTime = 0;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    this.simpleRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
  }
}

/** Original weapon shapes, matched to the weapon class. */
export function buildWeaponGeometry(weaponId: string): THREE.BufferGeometry | null {
  const cls = weaponClassOf(weaponId);
  const geoms: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry): void => {
    geoms.push(g);
  };
  switch (cls) {
    case 'AR':
      add(box(0.075, 0.10, 0.55, 0, 0, 0));
      add(box(0.05, 0.16, 0.09, 0, -0.11, 0.06));      // magazine
      add(box(0.045, 0.045, 0.20, 0, 0.01, 0.34));      // barrel
      add(box(0.04, 0.07, 0.12, 0, -0.06, -0.18));      // grip
      add(box(0.05, 0.06, 0.20, 0, -0.01, -0.28));      // stock
      add(box(0.03, 0.05, 0.08, 0, 0.08, 0.05));        // optic
      break;
    case 'SMG':
      add(box(0.065, 0.09, 0.36, 0, 0, 0));
      add(box(0.045, 0.20, 0.07, 0, -0.13, 0.02));
      add(box(0.035, 0.035, 0.14, 0, 0, 0.24));
      add(box(0.04, 0.06, 0.10, 0, -0.05, -0.14));
      add(box(0.05, 0.05, 0.14, 0, 0, -0.20));
      break;
    case 'SHOTGUN':
      add(box(0.08, 0.10, 0.72, 0, 0, 0));
      add(box(0.055, 0.055, 0.5, 0, 0.055, 0.35));
      add(box(0.05, 0.10, 0.18, 0, -0.07, -0.26));
      add(box(0.06, 0.05, 0.16, 0, -0.02, 0.16));
      break;
    case 'DMR':
      add(box(0.07, 0.10, 0.70, 0, 0, 0));
      add(box(0.05, 0.18, 0.10, 0, -0.12, 0.05));
      add(box(0.04, 0.05, 0.55, 0, 0.02, 0.5));
      add(box(0.045, 0.07, 0.14, 0, -0.06, -0.22));
      add(box(0.05, 0.08, 0.30, 0, -0.01, -0.40));
      add(box(0.045, 0.06, 0.16, 0, 0.10, 0.02));
      break;
    case 'SNIPER':
      add(box(0.07, 0.11, 0.95, 0, 0, 0));
      add(box(0.05, 0.05, 0.85, 0, 0.02, 0.75));
      add(box(0.045, 0.15, 0.10, 0, -0.11, 0.06));
      add(box(0.05, 0.09, 0.34, 0, -0.02, -0.45));
      add(box(0.05, 0.06, 0.26, 0, 0.11, 0.05));  // scope tube
      add(box(0.07, 0.07, 0.05, 0, 0.11, -0.08));
      break;
    case 'LMG':
      add(box(0.09, 0.13, 0.72, 0, 0, 0));
      add(box(0.09, 0.20, 0.16, 0, -0.15, 0.05));  // box mag
      add(box(0.05, 0.05, 0.45, 0, 0.02, 0.55));
      add(box(0.05, 0.08, 0.16, 0, -0.07, -0.22));
      add(box(0.05, 0.07, 0.28, 0, -0.01, -0.42));
      break;
    case 'PISTOL':
      add(box(0.05, 0.09, 0.22, 0, 0, 0));
      add(box(0.04, 0.12, 0.05, 0, -0.10, -0.02));
      add(box(0.04, 0.045, 0.10, 0, 0.005, 0.14));
      break;
    case 'MELEE':
      add(box(0.045, 0.045, 0.14, 0, 0, -0.04));  // handle
      add(box(0.02, 0.11, 0.30, 0, 0.02, 0.16));  // blade
      add(box(0.10, 0.03, 0.05, 0, 0, -0.10));    // guard
      break;
    default:
      return null;
  }
  const merged = mergeGeometries(geoms, false);
  for (const g of geoms) g.dispose();
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
