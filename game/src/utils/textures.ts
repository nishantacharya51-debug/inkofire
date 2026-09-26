import * as THREE from 'three';
import { Noise2D, RNG } from './rng';

/**
 * 100% procedurally generated textures (canvas based).
 * No external image assets are used anywhere in this project.
 */

type Ctx = CanvasRenderingContext2D;

/**
 * Headless / restricted environments (automated tests, blocklisted canvas) have
 * no 2D context. Rather than crash, every drawing call becomes a no-op and the
 * generated textures simply come out flat — the game still runs.
 */
function makeNullCtx(): Ctx {
  const noop = (): unknown => undefined;
  const imageData = (w = 1, h = 1): ImageData =>
    ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: 'srgb' }) as unknown as ImageData;
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_target, prop) => {
      if (prop === 'createImageData') return imageData;
      if (prop === 'getImageData') return () => imageData(1, 1);
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop: noop });
      if (prop === 'canvas') return undefined;
      return noop;
    },
    set: () => true
  };
  return new Proxy({}, handler) as unknown as Ctx;
}

function canvas(size: number, sizeY = size): { c: HTMLCanvasElement; ctx: Ctx } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = sizeY;
  const raw = c.getContext ? c.getContext('2d') : null;
  return { c, ctx: (raw as Ctx | null) ?? makeNullCtx() };
}

function fillNoise(
  ctx: Ctx,
  size: number,
  sizeY: number,
  scale: number,
  octaves: number,
  seed: number,
  colorA: [number, number, number],
  colorB: [number, number, number],
  contrast = 1
): void {
  const n = new Noise2D(seed);
  const img = ctx.createImageData(size, sizeY);
  const d = img.data;
  for (let y = 0; y < sizeY; y++) {
    for (let x = 0; x < size; x++) {
      let v = (n.fbm((x / size) * scale, (y / sizeY) * scale, octaves) + 1) * 0.5;
      v = Math.min(1, Math.max(0, (v - 0.5) * contrast + 0.5));
      const i = (y * size + x) * 4;
      d[i] = colorA[0] + (colorB[0] - colorA[0]) * v;
      d[i + 1] = colorA[1] + (colorB[1] - colorA[1]) * v;
      d[i + 2] = colorA[2] + (colorB[2] - colorA[2]) * v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Speckle grain overlay. */
function speckle(ctx: Ctx, size: number, count: number, seed: number, alpha: number, light = 0.5): void {
  const rng = new RNG(seed);
  for (let i = 0; i < count; i++) {
    const x = rng.next() * size;
    const y = rng.next() * size;
    const r = 0.4 + rng.next() * 1.7;
    const v = Math.floor(255 * (light + (rng.next() - 0.5) * 0.5));
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Sobel-filtered normal map derived from the luminance of a height canvas. */
function normalFromCanvas(src: HTMLCanvasElement, strength = 2.2): HTMLCanvasElement {
  const size = src.width;
  const sctx = src.getContext ? src.getContext('2d') : null;
  let data: Uint8ClampedArray;
  try {
    if (!sctx) throw new Error('no 2d context');
    data = sctx.getImageData(0, 0, size, size).data;
  } catch {
    // Browsers can block pixel reads (tainted/software canvas) and headless
    // environments have no context at all — fall back to a flat normal map.
    return canvas(size).c;
  }
  const { c: out, ctx: octx } = canvas(size);
  const img = octx.createImageData(size, size);
  const od = img.data;
  const lum = (x: number, y: number): number => {
    const xx = (x + size) % size;
    const yy = (y + size) % size;
    const i = (yy * size + xx) * 4;
    return (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        lum(x + 1, y - 1) + 2 * lum(x + 1, y) + lum(x + 1, y + 1) -
        (lum(x - 1, y - 1) + 2 * lum(x - 1, y) + lum(x - 1, y + 1));
      const dy =
        lum(x - 1, y + 1) + 2 * lum(x, y + 1) + lum(x + 1, y + 1) -
        (lum(x - 1, y - 1) + 2 * lum(x, y - 1) + lum(x + 1, y - 1));
      let nx = -dx * strength;
      let ny = -dy * strength;
      let nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * size + x) * 4;
      od[i] = (nx * 0.5 + 0.5) * 255;
      od[i + 1] = (ny * 0.5 + 0.5) * 255;
      od[i + 2] = (nz * 0.5 + 0.5) * 255;
      od[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function toTexture(c: HTMLCanvasElement, opts: { srgb?: boolean; aniso?: number } = {}): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = opts.aniso ?? 4;
  t.needsUpdate = true;
  return t;
}

function toDataTexture(c: HTMLCanvasElement): THREE.Texture {
  const t = toTexture(c, { srgb: false });
  return t;
}

/* ------------------------------------------------------------------ */
/* Individual surface generators                                       */
/* ------------------------------------------------------------------ */

function genConcrete(size = 256): { albedo: THREE.Texture; normal: THREE.Texture; roughness: THREE.Texture } {
  const { c, ctx } = canvas(size);
  fillNoise(ctx, size, size, 3.5, 5, 11, [116, 116, 112], [168, 167, 160], 1.25);
  speckle(ctx, size, 900, 3, 0.16, 0.45);
  // subtle panel seams
  ctx.strokeStyle = 'rgba(60,60,58,0.35)';
  ctx.lineWidth = 1.4;
  ctx.strokeRect(2, 2, size - 4, size - 4);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.strokeRect(4, 4, size - 8, size - 8);
  // cracks
  const rng = new RNG(99);
  ctx.strokeStyle = 'rgba(52,52,50,0.5)';
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    let x = rng.next() * size;
    let y = rng.next() * size;
    ctx.moveTo(x, y);
    for (let s = 0; s < 6; s++) {
      x += (rng.next() - 0.5) * 60;
      y += (rng.next() - 0.5) * 60;
      ctx.lineTo(x, y);
    }
    ctx.lineWidth = 0.7;
    ctx.stroke();
  }
  const { c: rc, ctx: rctx } = canvas(size);
  fillNoise(rctx, size, size, 5, 4, 17, [200, 200, 200], [240, 240, 240], 1.1);
  return { albedo: toTexture(c), normal: toDataTexture(normalFromCanvas(c, 1.4)), roughness: toDataTexture(rc) };
}

function genBrick(size = 256): { albedo: THREE.Texture; normal: THREE.Texture } {
  const { c, ctx } = canvas(size);
  ctx.fillStyle = '#c9bfae';
  ctx.fillRect(0, 0, size, size);
  speckle(ctx, size, 600, 5, 0.12, 0.5);
  const rows = 8;
  const bh = size / rows;
  const bw = size / 4;
  const rng = new RNG(21);
  for (let r = 0; r < rows; r++) {
    const offset = r % 2 === 0 ? 0 : bw / 2;
    for (let i = -1; i < 5; i++) {
      const x = i * bw + offset + 1.5;
      const y = r * bh + 1.5;
      const w = bw - 3;
      const h = bh - 3;
      const tone = 0.72 + rng.next() * 0.35;
      const rr = Math.floor(150 * tone);
      const gg = Math.floor(84 * tone);
      const bb = Math.floor(66 * tone);
      ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = `rgba(255,255,255,${0.05 + rng.next() * 0.06})`;
      ctx.fillRect(x, y, w, 2);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(x, y + h - 3, w, 3);
      // pitting
      for (let p = 0; p < 6; p++) {
        ctx.fillStyle = `rgba(0,0,0,${0.05 + rng.next() * 0.08})`;
        ctx.beginPath();
        ctx.arc(x + rng.next() * w, y + rng.next() * h, rng.next() * 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return { albedo: toTexture(c), normal: toDataTexture(normalFromCanvas(c, 2.6)) };
}

function genWood(size = 256): { albedo: THREE.Texture; normal: THREE.Texture } {
  const { c, ctx } = canvas(size);
  ctx.fillStyle = '#7a5734';
  ctx.fillRect(0, 0, size, size);
  const rng = new RNG(41);
  for (let i = 0; i < 420; i++) {
    const x = rng.next() * size;
    const w = 0.6 + rng.next() * 3.2;
    const tone = rng.next();
    ctx.fillStyle = `rgba(${tone > 0.5 ? 120 : 60},${tone > 0.5 ? 88 : 42},${tone > 0.5 ? 52 : 24},${0.12 + rng.next() * 0.3})`;
    ctx.fillRect(x, 0, w, size);
  }
  // plank seams
  ctx.fillStyle = 'rgba(30,18,10,0.55)';
  for (let i = 1; i < 4; i++) ctx.fillRect(0, (i * size) / 4 - 1.5, size, 3);
  speckle(ctx, size, 300, 7, 0.1, 0.35);
  return { albedo: toTexture(c), normal: toDataTexture(normalFromCanvas(c, 2.0)) };
}

function genMetal(size = 256): { albedo: THREE.Texture; roughness: THREE.Texture; normal: THREE.Texture } {
  const { c, ctx } = canvas(size);
  ctx.fillStyle = '#8e949c';
  ctx.fillRect(0, 0, size, size);
  const rng = new RNG(55);
  // brushed streaks
  for (let i = 0; i < 1600; i++) {
    const y = rng.next() * size;
    ctx.strokeStyle = `rgba(255,255,255,${rng.next() * 0.06})`;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.lineWidth = rng.next() * 1.4;
    ctx.stroke();
  }
  // rivets
  ctx.fillStyle = 'rgba(120,126,134,1)';
  for (let x = 8; x < size; x += 32) {
    for (let y = 8; y < size; y += 32) {
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      ctx.arc(x - 0.7, y - 0.7, 1.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(120,126,134,1)';
    }
  }
  // rust patches
  for (let i = 0; i < 10; i++) {
    const x = rng.next() * size;
    const y = rng.next() * size;
    const r = 8 + rng.next() * 26;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(120,66,34,0.5)');
    g.addColorStop(1, 'rgba(120,66,34,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const { c: rc, ctx: rctx } = canvas(size);
  fillNoise(rctx, size, size, 6, 4, 61, [110, 110, 110], [190, 190, 190], 1.2);
  return { albedo: toTexture(c), roughness: toDataTexture(rc), normal: toDataTexture(normalFromCanvas(c, 1.2)) };
}

function genAsphalt(size = 256): { albedo: THREE.Texture; roughness: THREE.Texture } {
  const { c, ctx } = canvas(size);
  fillNoise(ctx, size, size, 4, 4, 71, [42, 42, 44], [78, 78, 80], 1.3);
  speckle(ctx, size, 2200, 73, 0.22, 0.5);
  const { c: rc, ctx: rctx } = canvas(size);
  fillNoise(rctx, size, size, 7, 4, 79, [170, 170, 170], [230, 230, 230], 1.1);
  return { albedo: toTexture(c), roughness: toDataTexture(rc) };
}

function genSand(size = 256): { albedo: THREE.Texture; normal: THREE.Texture } {
  const { c, ctx } = canvas(size);
  fillNoise(ctx, size, size, 8, 5, 83, [190, 170, 128], [231, 214, 172], 1.4);
  speckle(ctx, size, 2600, 87, 0.16, 0.7);
  // ripples
  ctx.globalAlpha = 0.16;
  const rng = new RNG(91);
  for (let i = 0; i < 26; i++) {
    ctx.strokeStyle = rng.bool() ? '#fff' : '#8a7452';
    ctx.lineWidth = 1 + rng.next() * 2;
    ctx.beginPath();
    const y0 = rng.next() * size;
    ctx.moveTo(0, y0);
    for (let x = 0; x <= size; x += 16) ctx.lineTo(x, y0 + Math.sin(x * 0.05 + i) * 6);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return { albedo: toTexture(c), normal: toDataTexture(normalFromCanvas(c, 1.6)) };
}

function genGrassGround(size = 256): { albedo: THREE.Texture; normal: THREE.Texture } {
  const { c, ctx } = canvas(size);
  fillNoise(ctx, size, size, 6, 5, 101, [58, 82, 44], [104, 132, 62], 1.5);
  const rng = new RNG(103);
  for (let i = 0; i < 2400; i++) {
    const x = rng.next() * size;
    const y = rng.next() * size;
    const tone = 0.6 + rng.next() * 0.7;
    ctx.strokeStyle = `rgba(${Math.floor(70 * tone)},${Math.floor(110 * tone)},${Math.floor(50 * tone)},${0.25 + rng.next() * 0.4})`;
    ctx.lineWidth = 0.7 + rng.next();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rng.next() - 0.5) * 5, y - 3 - rng.next() * 6);
    ctx.stroke();
  }
  return { albedo: toTexture(c), normal: toDataTexture(normalFromCanvas(c, 1.5)) };
}

function genRock(size = 256): { albedo: THREE.Texture; normal: THREE.Texture; roughness: THREE.Texture } {
  const { c, ctx } = canvas(size);
  fillNoise(ctx, size, size, 4, 6, 113, [78, 76, 72], [152, 148, 140], 1.6);
  speckle(ctx, size, 1400, 117, 0.2, 0.45);
  const { c: rc, ctx: rctx } = canvas(size);
  fillNoise(rctx, size, size, 9, 4, 127, [190, 190, 190], [250, 250, 250], 1.1);
  return { albedo: toTexture(c), normal: toDataTexture(normalFromCanvas(c, 3.0)), roughness: toDataTexture(rc) };
}

function genFabric(size = 256): { albedo: THREE.Texture; normal: THREE.Texture } {
  const { c, ctx } = canvas(size);
  fillNoise(ctx, size, size, 10, 4, 131, [58, 60, 58], [86, 88, 84], 1.2);
  ctx.globalAlpha = 0.22;
  for (let i = 0; i < size; i += 3) {
    ctx.fillStyle = i % 6 === 0 ? '#fff' : '#000';
    ctx.fillRect(i, 0, 1, size);
    ctx.fillRect(0, i, size, 1);
  }
  ctx.globalAlpha = 1;
  return { albedo: toTexture(c), normal: toDataTexture(normalFromCanvas(c, 1.1)) };
}

function genRoofTile(size = 256): { albedo: THREE.Texture; normal: THREE.Texture } {
  const { c, ctx } = canvas(size);
  ctx.fillStyle = '#6b4238';
  ctx.fillRect(0, 0, size, size);
  const rng = new RNG(149);
  const rows = 10;
  const h = size / rows;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < 10; i++) {
      const w = size / 10;
      const x = i * w + (r % 2 ? w / 2 : 0);
      const tone = 0.75 + rng.next() * 0.4;
      ctx.fillStyle = `rgb(${Math.floor(122 * tone)},${Math.floor(70 * tone)},${Math.floor(58 * tone)})`;
      ctx.fillRect(x + 1, r * h + 1, w - 2, h - 1.5);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(x + 1, r * h + h - 2.5, w - 2, 2);
    }
  }
  return { albedo: toTexture(c), normal: toDataTexture(normalFromCanvas(c, 2.2)) };
}

/** Leaf-cluster billboard texture with alpha (used for foliage LOD + bushes). */
function genFoliage(size = 128): THREE.Texture {
  const { c, ctx } = canvas(size);
  ctx.clearRect(0, 0, size, size);
  const rng = new RNG(163);
  for (let i = 0; i < 130; i++) {
    const x = size / 2 + (rng.next() - 0.5) * size * 0.86;
    const y = size / 2 + (rng.next() - 0.5) * size * 0.86;
    const r = 5 + rng.next() * 13;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const tone = 0.55 + rng.next() * 0.6;
    g.addColorStop(0, `rgba(${Math.floor(56 * tone)},${Math.floor(96 * tone)},${Math.floor(44 * tone)},1)`);
    g.addColorStop(0.7, `rgba(${Math.floor(38 * tone)},${Math.floor(70 * tone)},${Math.floor(32 * tone)},0.92)`);
    g.addColorStop(1, 'rgba(30,58,26,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = toTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Soft radial particle sprite (smoke, dust, muzzle glow). */
function genParticle(size = 64, inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)'): THREE.Texture {
  const { c, ctx } = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.45, inner.replace(/[\d.]+\)$/, '0.55)'));
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = toTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Water normal map with two crossing ripple wave patterns. */
function genWaterNormal(size = 256): THREE.Texture {
  const { c, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const n1 = new Noise2D(311);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const h =
        Math.sin((u * 7 + v * 3) * Math.PI * 2) * 0.4 +
        Math.sin((u * 3 - v * 6) * Math.PI * 2) * 0.3 +
        n1.fbm(u * 6, v * 6, 3) * 0.6;
      const hx =
        Math.cos((u * 7 + v * 3) * Math.PI * 2) * 0.4 * 7 +
        Math.cos((u * 3 - v * 6) * Math.PI * 2) * 0.3 * 3;
      const hy =
        Math.cos((u * 7 + v * 3) * Math.PI * 2) * 0.4 * 3 -
        Math.cos((u * 3 - v * 6) * Math.PI * 2) * 0.3 * 6;
      let nx = -hx * 0.05;
      let ny = -hy * 0.05;
      let nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
      void h;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = toDataTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

const albedoCache = new Map<string, THREE.Texture>();
const dataCache = new Map<string, THREE.Texture>();
let foliageTex: THREE.Texture | null = null;
let waterNormalTex: THREE.Texture | null = null;
const particleCache = new Map<string, THREE.Texture>();

export const Textures = {
  concrete(): THREE.Texture {
    return albedo('concrete', () => genConcrete().albedo);
  },
  concreteNormal(): THREE.Texture {
    return data('concreteN', () => genConcrete().normal);
  },
  concreteRough(): THREE.Texture {
    return data('concreteR', () => genConcrete().roughness);
  },
  brick(): THREE.Texture {
    return albedo('brick', () => genBrick().albedo);
  },
  brickNormal(): THREE.Texture {
    return data('brickN', () => genBrick().normal);
  },
  wood(): THREE.Texture {
    return albedo('wood', () => genWood().albedo);
  },
  woodNormal(): THREE.Texture {
    return data('woodN', () => genWood().normal);
  },
  metal(): THREE.Texture {
    return albedo('metal', () => genMetal().albedo);
  },
  metalNormal(): THREE.Texture {
    return data('metalN', () => genMetal().normal);
  },
  metalRough(): THREE.Texture {
    return data('metalR', () => genMetal().roughness);
  },
  asphalt(): THREE.Texture {
    return albedo('asphalt', () => genAsphalt().albedo);
  },
  sand(): THREE.Texture {
    return albedo('sand', () => genSand().albedo);
  },
  sandNormal(): THREE.Texture {
    return data('sandN', () => genSand().normal);
  },
  grass(): THREE.Texture {
    return albedo('grass', () => genGrassGround().albedo);
  },
  grassNormal(): THREE.Texture {
    return data('grassN', () => genGrassGround().normal);
  },
  rock(): THREE.Texture {
    return albedo('rock', () => genRock().albedo);
  },
  rockNormal(): THREE.Texture {
    return data('rockN', () => genRock().normal);
  },
  fabric(): THREE.Texture {
    return albedo('fabric', () => genFabric().albedo);
  },
  fabricNormal(): THREE.Texture {
    return data('fabricN', () => genFabric().normal);
  },
  roof(): THREE.Texture {
    return albedo('roof', () => genRoofTile().albedo);
  },
  roofNormal(): THREE.Texture {
    return data('roofN', () => genRoofTile().normal);
  },
  foliage(): THREE.Texture {
    if (!foliageTex) foliageTex = genFoliage();
    return foliageTex;
  },
  waterNormal(): THREE.Texture {
    if (!waterNormalTex) waterNormalTex = genWaterNormal();
    return waterNormalTex;
  },
  particle(kind: 'smoke' | 'dust' | 'spark' | 'flare' | 'blood' | 'ring' = 'smoke'): THREE.Texture {
    const cached = particleCache.get(kind);
    if (cached) return cached;
    let t: THREE.Texture;
    switch (kind) {
      case 'dust':
        t = genParticle(64, 'rgb(196,186,166)', 'rgba(196,186,166,0)');
        break;
      case 'spark':
        t = genParticle(32, 'rgb(255,224,140)', 'rgba(255,180,80,0)');
        break;
      case 'flare':
        t = genParticle(64, 'rgb(255,240,190)', 'rgba(255,160,60,0)');
        break;
      case 'blood':
        t = genParticle(32, 'rgb(150,30,30)', 'rgba(120,20,20,0)');
        break;
      case 'ring':
        t = genParticle(64, 'rgba(255,255,255,0.0)', 'rgba(255,255,255,0)');
        break;
      case 'smoke':
      default:
        t = genParticle(64, 'rgb(120,120,118)', 'rgba(120,120,118,0)');
        break;
    }
    particleCache.set(kind, t);
    return t;
  }
};

function albedo(key: string, make: () => THREE.Texture): THREE.Texture {
  let t = albedoCache.get(key);
  if (!t) {
    t = make();
    albedoCache.set(key, t);
  }
  return t;
}

function data(key: string, make: () => THREE.Texture): THREE.Texture {
  let t = dataCache.get(key);
  if (!t) {
    t = make();
    dataCache.set(key, t);
  }
  return t;
}

/** Warm up the texture generators (called during the loading screen). */
export function precacheTextures(): void {
  Textures.concrete(); Textures.concreteNormal(); Textures.concreteRough();
  Textures.brick(); Textures.brickNormal();
  Textures.wood(); Textures.woodNormal();
  Textures.metal(); Textures.metalNormal(); Textures.metalRough();
  Textures.asphalt();
  Textures.sand(); Textures.sandNormal();
  Textures.grass(); Textures.grassNormal();
  Textures.rock(); Textures.rockNormal();
  Textures.fabric(); Textures.fabricNormal();
  Textures.roof(); Textures.roofNormal();
  Textures.foliage();
  Textures.waterNormal();
  Textures.particle('smoke');
  Textures.particle('dust');
  Textures.particle('flare');
}

export { normalFromCanvas, canvas as makeCanvas, toTexture };
