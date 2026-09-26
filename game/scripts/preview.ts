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
  /** Tight framing on the head, used to review the face and hair. */
  headshot?: boolean;
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
    label: 'MALE · SPIKY',
    view: { yaw: 150, pitch: 3, dist: 3.15, targetY: 0.95 },
    build: () => {
      const rig = new CharacterRig(0, { helmet: false, vest: true, detail: 'high', variant: 'male', hair: 'spiky' });
      rig.setShowcase(true);
      rig.setWeapon('');
      rig.tickShowcase(0.9);
      return rig;
    }
  },
  {
    label: 'FEMALE · PONYTAIL',
    view: { yaw: 150, pitch: 3, dist: 3.05, targetY: 0.9 },
    build: () => {
      const rig = new CharacterRig(4, { helmet: false, vest: true, detail: 'high', variant: 'female', hair: 'ponytail' });
      rig.setShowcase(true);
      rig.setWeapon('');
      rig.tickShowcase(0.9);
      return rig;
    }
  },
  {
    label: 'FEMALE · HELMET + RIFLE',
    view: { yaw: 152, pitch: 4, dist: 3.2, targetY: 0.9 },
    build: () => {
      const rig = new CharacterRig(2, { helmet: true, vest: true, detail: 'high', variant: 'female', hair: 'bob' });
      rig.setShowcase(true);
      rig.setWeapon('vk77');
      rig.tickShowcase(1.2);
      return rig;
    }
  },
  {
    label: 'MATCH · LOW DETAIL',
    view: { yaw: 205, pitch: 6, dist: 3.7, targetY: 0.95 },
    build: () => {
      const rig = new CharacterRig(8, { helmet: true, vest: true, detail: 'low', variant: 'male', hair: 'short' });
      rig.setWeapon('hornet9');
      const a = actor('RUN', 5.5);
      for (let i = 0; i < 18; i++) rig.update(a, 1 / 60, -0.06);
      return rig;
    }
  },
  {
    label: 'PRONE',
    view: { yaw: 250, pitch: 18, dist: 2.7, targetY: 0.34 },
    build: () => {
      const rig = new CharacterRig(6, { helmet: true, vest: true, detail: 'high', variant: 'male', hair: 'short' });
      rig.setWeapon('specter');
      const a = actor('PRONE', 0);
      a.stance = 'PRONE';
      for (let i = 0; i < 25; i++) rig.update(a, 1 / 60, 0);
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
    const spec = material.metalness > 0.3 ? 0.22 : material.roughness > 0.8 ? 0.04 : 0.1;
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
  const fov = 30;
  const f = 1 / Math.tan((fov * Math.PI) / 360);
  return { view, eye, f, aspect };
}

function renderRig(rig: CharacterRig, yawDeg: number, pitchDeg: number, dist: number, targetY: number): Uint8Array {
  return renderRigSized(rig, yawDeg, pitchDeg, dist, targetY, PANEL_W, PANEL_H);
}

function renderRigSized(rig: CharacterRig, yawDeg: number, pitchDeg: number, dist: number, targetY: number, panelW: number, panelH: number): Uint8Array {
  const w = panelW * SS;
  const h = panelH * SS;
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
  // Key light comes from the camera side (raised and offset to the right) so the
  // surface facing the viewer is always readable; a cool rim light separates the
  // silhouette from the background.
  const yawR = (yawDeg * Math.PI) / 180;
  const light = new THREE.Vector3(Math.sin(yawR + 0.5) * 0.75, 0.62, Math.cos(yawR + 0.5) * 0.75).normalize();
  const rim = new THREE.Vector3(-Math.sin(yawR), 0.15, -Math.cos(yawR)).normalize();
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
    const shade = 0.3 + ndl * 0.72 + rimF;
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
  const out = new Uint8Array(panelW * panelH * 3);
  for (let y = 0; y < panelH; y++) {
    for (let x = 0; x < panelW; x++) {
      let r = 0; let gg = 0; let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx2 = 0; sx2 < SS; sx2++) {
          const i = (((y * SS + sy) * w) + (x * SS + sx2)) * 3;
          r += color[i]; gg += color[i + 1]; b += color[i + 2];
        }
      }
      const n = SS * SS;
      const o = (y * panelW + x) * 3;
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

  // Head close-ups (face + hair review) as a second image.
  const heads = [
    { label: 'MALE · SPIKY', idx: 0, variant: 'male' as const, hair: 'spiky' as const },
    { label: 'MALE · SHORT', idx: 3, variant: 'male' as const, hair: 'short' as const },
    { label: 'FEMALE · BOB', idx: 2, variant: 'female' as const, hair: 'bob' as const },
    { label: 'FEMALE · PONYTAIL', idx: 4, variant: 'female' as const, hair: 'ponytail' as const },
    { label: 'MALE · BUN (HELMET OFF)', idx: 8, variant: 'male' as const, hair: 'long' as const }
  ];
  const headW = 300;
  const headH = 340;
  const headSheet = new Uint8Array(headW * heads.length * headH * 3);
  heads.forEach((h, i) => {
    const rig = new CharacterRig(h.idx, { helmet: false, vest: true, detail: 'high', variant: h.variant, hair: h.hair });
    rig.setShowcase(true);
    rig.tickShowcase(0.7);
    const panel = renderRigSized(rig, 178, 2, 0.82, 1.62, headW, headH);
    for (let y = 0; y < headH; y++) {
      const src = y * headW * 3;
      const dst = (y * headW * heads.length + i * headW) * 3;
      headSheet.set(panel.subarray(src, src + headW * 3), dst);
    }
    for (let y = 0; y < headH; y++) {
      const o = (y * headW * heads.length + i * headW) * 3;
      headSheet[o] = 40; headSheet[o + 1] = 46; headSheet[o + 2] = 54;
    }
    console.log(`   HEAD ${h.label}`);
  });
  const headPath = path.join(process.cwd(), 'docs', 'operator-faces.png');
  fs.writeFileSync(headPath, encodePng(headW * heads.length, headH, headSheet));
  console.log(`wrote ${path.relative(process.cwd(), headPath)} (${headW * heads.length}x${headH})`);

  const outPath = path.join(process.cwd(), 'docs', 'operator-preview.png');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, encodePng(sheetW, sheetH, sheet));
  console.log(`\nwrote ${path.relative(process.cwd(), outPath)} (${sheetW}x${sheetH}, ${(fs.statSync(outPath).size / 1024).toFixed(1)} kB)`);
  console.log(`poses: ${poses.map((p) => p.label).join(' | ')}`);
}

main();
