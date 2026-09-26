/**
 * Apex Island — GPU-free model preview.
 *
 * Rasterises the procedurally generated operator with a tiny software renderer
 * (z-buffer + interpolated normals) and writes a PNG contact sheet. This is how
 * the character is reviewed without a browser in the loop:
 *
 *     bash scripts/run.sh scripts/preview.ts            # -> docs/operator-preview.png
 *
 * It also doubles as a smoke test for the rig: if a merged body part comes out
 * empty, the silhouette visibly loses a limb.
 */
import { JSDOM } from 'jsdom';
import * as zlib from 'node:zlib';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import { CharacterRig } from '../src/render/CharacterRig';
import { Actor } from '../src/entity/Actor';

/* ------------------------------------------------------------------ */
/* Minimal setup: the rig touches `document` for its shadow helpers.   */
/* ------------------------------------------------------------------ */

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const g = globalThis as unknown as Record<string, unknown>;
g.document = dom.window.document;
g.window = dom.window;

const PANEL_W = 340;
const PANEL_H = 680;
const SS = 2; // supersampling factor

interface Pose {
  label: string;
  /** `yaw` orbits the camera, `dist` frames the body. */
  view?: { yaw: number; pitch: number; dist: number; targetY: number };
  build: () => CharacterRig;
}

function actor(moveState: string, speed: number): Actor {
  const a = new Actor({ id: 1, name: 'preview', team: 0, isBot: false, isLocal: true });
  a.moveState = moveState as Actor['moveState'];
  // `speed` is derived from velocity, so drive the velocity itself.
  a.velocity.set(0, 0, -speed);
  a.yaw = 0;
  a.position.set(0, 0, 0);
  return a;
}

const poses: Pose[] = [
  {
    label: 'FRONT · NO HELMET',
    view: { yaw: 180, pitch: 2, dist: 3.1, targetY: 0.95 },
    build: () => {
      const rig = new CharacterRig(3, { helmet: false, vest: true, detail: 'high' });
      rig.setShowcase(true);
      rig.setWeapon('');
      rig.tickShowcase(0.8);
      return rig;
    }
  },
  {
    label: 'LOBBY HERO POSE',
    view: { yaw: 145, pitch: 4, dist: 3.2, targetY: 0.95 },
    build: () => {
      const rig = new CharacterRig(0, { helmet: true, vest: true });
      rig.setShowcase(true);
      rig.setWeapon('vk77');
      rig.tickShowcase(1.4);
      return rig;
    }
  },
  {
    label: 'RUN · WEAPON UP',
    build: () => {
      const rig = new CharacterRig(2, { helmet: true, vest: true });
      rig.setWeapon('vk77');
      const a = actor('RUN', 6.2);
      for (let i = 0; i < 30; i++) rig.update(a, 1 / 60, -0.15);
      return rig;
    }
  },
  {
    label: 'CROUCH · AIMING',
    build: () => {
      const rig = new CharacterRig(4, { helmet: true, vest: false });
      rig.setWeapon('hornet9');
      const a = actor('CROUCH_IDLE', 0);
      a.stance = 'CROUCH';
      a.adsProgress = 0.9;
      for (let i = 0; i < 30; i++) rig.update(a, 1 / 60, -0.05);
      return rig;
    }
  },
  {
    label: 'MATCH · LOW DETAIL',
    view: { yaw: 200, pitch: 6, dist: 3.9, targetY: 0.95 },
    build: () => {
      const rig = new CharacterRig(5, { helmet: true, vest: true, detail: 'low' });
      rig.setWeapon('hornet9');
      const a = actor('IDLE', 0);
      for (let i = 0; i < 12; i++) rig.update(a, 1 / 60, -0.05);
      return rig;
    }
  },
  {
    label: 'PRONE',
    view: { yaw: 252, pitch: 20, dist: 2.7, targetY: 0.34 },
    build: () => {
      const rig = new CharacterRig(1, { helmet: false, vest: true });
      rig.setWeapon('specter');
      const a = actor('PRONE', 0);
      a.stance = 'PRONE';
      for (let i = 0; i < 30; i++) rig.update(a, 1 / 60, 0);
      return rig;
    }
  }
];

/* ------------------------------------------------------------------ */
/* Rasteriser                                                          */
/* ------------------------------------------------------------------ */

interface Tri {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number;
  nx: number; ny: number; nz: number;
  r: number; gg: number; b: number;
}

function collect(rig: CharacterRig): Tri[] {
  rig.root.updateMatrixWorld(true);
  const tris: Tri[] = [];
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const nA = new THREE.Vector3();
  const nB = new THREE.Vector3();
  const nC = new THREE.Vector3();

  rig.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    if (!pos) return;
    const index = geo.index;
    const count = index ? index.count : pos.count;
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    const color = material.color ?? new THREE.Color(0x808080);
    // Slight per-triangle tone variation reads like fabric/skin grain.
    const spec = material.metalness > 0.3 ? 0.35 : material.roughness > 0.8 ? 0.06 : 0.16;
    for (let i = 0; i < count; i += 3) {
      const i0 = index ? index.getX(i) : i;
      const i1 = index ? index.getX(i + 1) : i + 1;
      const i2 = index ? index.getX(i + 2) : i + 2;
      vA.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      vB.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      vC.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
      if (nor) {
        nA.fromBufferAttribute(nor, i0).transformDirection(mesh.matrixWorld);
        nB.fromBufferAttribute(nor, i1).transformDirection(mesh.matrixWorld);
        nC.fromBufferAttribute(nor, i2).transformDirection(mesh.matrixWorld);
      } else {
        nA.set(0, 1, 0); nB.set(0, 1, 0); nC.set(0, 1, 0);
      }
      tris.push({
        ax: vA.x, ay: vA.y, az: vA.z,
        bx: vB.x, by: vB.y, bz: vB.z,
        cx: vC.x, cy: vC.y, cz: vC.z,
        nx: (nA.x + nB.x + nC.x) / 3, ny: (nA.y + nB.y + nC.y) / 3, nz: (nA.z + nB.z + nC.z) / 3,
        r: color.r * (1 + spec), gg: color.g * (1 + spec), b: color.b * (1 + spec)
      });
    }
  });
  return tris;
}

/** Simple orbit camera around a target, returning view-space coordinates. */
function makeView(yawDeg: number, pitchDeg: number, dist: number, targetY: number, aspect: number) {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const eye = new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch) * dist,
    targetY + Math.sin(pitch) * dist,
    Math.cos(yaw) * Math.cos(pitch) * dist
  );
  const target = new THREE.Vector3(0, targetY, 0);
  // World -> camera: rotate by the camera basis, then translate by -eye.
  // `Matrix4.lookAt` only produces the rotation, so the translation is added
  // explicitly (without it the camera would sit at the world origin).
  const rotation = new THREE.Matrix4().lookAt(eye, target, new THREE.Vector3(0, 1, 0)).invert();
  const view = rotation.multiply(new THREE.Matrix4().makeTranslation(-eye.x, -eye.y, -eye.z));
  const fov = 34;
  const f = 1 / Math.tan((fov * Math.PI) / 360);
  return { view, eye, f, aspect };
}

function renderRig(rig: CharacterRig, yawDeg: number, pitchDeg: number, dist: number, targetY: number): Uint8Array {
  const w = PANEL_W * SS;
  const h = PANEL_H * SS;
  const aspect = w / h;
  const color = new Float32Array(w * h * 3);
  const depth = new Float32Array(w * h).fill(Infinity);

  // Background: vertical gradient so the silhouette is easy to read.
  for (let y = 0; y < h; y++) {
    const t = y / h;
    const r = 0.045 + 0.05 * (1 - t);
    const gg = 0.06 + 0.09 * (1 - t);
    const b = 0.08 + 0.14 * (1 - t);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      color[i] = r; color[i + 1] = gg; color[i + 2] = b;
    }
  }

  const { view, eye, f, aspect: asp } = makeView(yawDeg, pitchDeg, dist, targetY, aspect);
  const light = new THREE.Vector3(-0.45, 0.86, 0.6).normalize();
  const rim = new THREE.Vector3(0.7, 0.2, -0.65).normalize();
  const pm = new THREE.Matrix4().makePerspective(-1, 1, 1, -1, 1, 40);
  void pm;
  void asp;

  for (const t of collect(rig)) {
    // To view space.
    const a = new THREE.Vector3(t.ax, t.ay, t.az).applyMatrix4(view);
    const bb = new THREE.Vector3(t.bx, t.by, t.bz).applyMatrix4(view);
    const c = new THREE.Vector3(t.cx, t.cy, t.cz).applyMatrix4(view);
    // Clip triangles that reach behind the camera.
    if (a.z > -0.05 || bb.z > -0.05 || c.z > -0.05) continue;

    // Perspective divide, then map NDC to pixels (y flipped).
    const sx = (v: THREE.Vector3): [number, number, number] => {
      const inv = 1 / -v.z;
      const ndcX = (v.x * f * inv) / asp;
      const ndcY = v.y * f * inv;
      return [(ndcX + 1) * 0.5 * w, (1 - ndcY) * 0.5 * h, -v.z];
    };
    const [ax, ay, az] = sx(a);
    const [bx, by, bz] = sx(bb);
    const [cx, cy, cz] = sx(c);

    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
    if (minX > maxX || minY > maxY) continue;

    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) continue;
    const invArea = 1 / area;

    const wn = new THREE.Vector3(t.nx, t.ny, t.nz).normalize();
    const ndl = Math.max(0, wn.dot(light));
    const rimF = Math.pow(Math.max(0, wn.dot(rim)), 2) * 0.5;
    const shade = 0.24 + ndl * 0.86 + rimF;
    const lit = [t.r * shade, t.gg * shade, t.b * shade];

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * invArea;
        const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) * invArea;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * az + w1 * bz + w2 * cz;
        const di = y * w + x;
        if (z >= depth[di]) continue;
        depth[di] = z;
        const ci = di * 3;
        color[ci] = lit[0];
        color[ci + 1] = lit[1];
        color[ci + 2] = lit[2];
      }
    }
  }
  void eye;

  // Downsample, tone-map and encode.
  const out = new Uint8Array(PANEL_W * PANEL_H * 3);
  for (let y = 0; y < PANEL_H; y++) {
    for (let x = 0; x < PANEL_W; x++) {
      let r = 0; let gg = 0; let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx2 = 0; sx2 < SS; sx2++) {
          const i = (((y * SS + sy) * w) + (x * SS + sx2)) * 3;
          r += color[i]; gg += color[i + 1]; b += color[i + 2];
        }
      }
      const n = SS * SS;
      const o = (y * PANEL_W + x) * 3;
      out[o] = gamma(r / n);
      out[o + 1] = gamma(gg / n);
      out[o + 2] = gamma(b / n);
    }
  }
  return out;
}

/** Filmic-ish curve so highlights roll off instead of clipping. */
function gamma(v: number): number {
  const x = Math.max(0, v);
  const t = x / (1 + x * 0.72);
  return Math.min(255, Math.round(Math.pow(Math.min(1, t), 1 / 2.2) * 255));
}

/* ------------------------------------------------------------------ */
/* PNG writer                                                          */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ */
/* Contact sheet                                                       */
/* ------------------------------------------------------------------ */

function main(): void {
  const sheetW = PANEL_W * poses.length;
  const sheetH = PANEL_H;
  const sheet = new Uint8Array(sheetW * sheetH * 3);

  poses.forEach((pose, i) => {
    const rig = pose.build();
    const started = Date.now();
    const v = pose.view ?? { yaw: 138, pitch: 5, dist: 3.35, targetY: 0.95 };
    const panel = renderRig(rig, v.yaw, v.pitch, v.dist, v.targetY);
    console.log(`   ${pose.label.padEnd(20)} rendered in ${Date.now() - started} ms`);
    for (let y = 0; y < PANEL_H; y++) {
      const src = y * PANEL_W * 3;
      const dst = (y * sheetW + i * PANEL_W) * 3;
      sheet.set(panel.subarray(src, src + PANEL_W * 3), dst);
    }
    // Divider line between panels.
    for (let y = 0; y < PANEL_H; y++) {
      const o = (y * sheetW + i * PANEL_W) * 3;
      sheet[o] = 40; sheet[o + 1] = 46; sheet[o + 2] = 54;
    }
  });

  const outPath = path.join(process.cwd(), 'docs', 'operator-preview.png');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, encodePng(sheetW, sheetH, sheet));
  console.log(`\nwrote ${path.relative(process.cwd(), outPath)} (${sheetW}x${sheetH}, ${(fs.statSync(outPath).size / 1024).toFixed(1)} kB)`);
  console.log(`poses: ${poses.map((p) => p.label).join(' | ')}`);
}

main();
