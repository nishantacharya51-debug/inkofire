import type { MapLayout } from '../world/MapLayout';
import type { Actor } from '../entity/Actor';
import type { Vehicle } from '../vehicles/VehicleSystem';
import { settings } from '../core/Settings';
import { Biome } from '../world/Terrain';
import { wrapAngle } from '../utils/mathx';

/**
 * Canvas minimap / full map.
 *
 * The island is baked once into an offscreen canvas (terrain colours + POIs +
 * roads), then each frame we draw the rotating zone, teammates, spotted enemies
 * and the player. Drawing is a handful of blits, so it stays cheap even on
 * integrated GPUs.
 */

export interface MinimapMarker {
  x: number;
  z: number;
  kind: 'enemy' | 'teammate' | 'loot' | 'vehicle' | 'objective' | 'landmark';
  label?: string;
  tier?: number;
}

export class Minimap {
  private base: HTMLCanvasElement;
  /** Null when the browser refuses a 2D context — the radar then draws nothing. */
  private baseCtx: CanvasRenderingContext2D | null;
  private baseScale: number;

  constructor(
    private canvas: HTMLCanvasElement,
    private layout: MapLayout,
    private worldSize: number
  ) {
    this.base = document.createElement('canvas');
    this.baseScale = 512;
    this.base.width = this.baseScale;
    this.base.height = this.baseScale;
    this.baseCtx = this.base.getContext ? this.base.getContext('2d') : null;
    if (this.baseCtx) this.bakeIsland();
  }

  private bakeIsland(): void {
    const ctx = this.baseCtx;
    if (!ctx) return;
    const t = this.layout.terrain;
    const res = t.res;
    const img = ctx.createImageData(res, res);
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const h = t.heights[j * (res + 1) + i];
        const biome = t.biome[j * (res + 1) + i];
        let r = 60, g = 90, b = 55;
        if (h < t.waterLevel) { r = 26; g = 54; b = 78; }
        else if (biome === Biome.BEACH) { r = 176; g = 156; b = 112; }
        else if (biome === Biome.GRASS) { r = 74; g = 106; b = 58; }
        else if (biome === Biome.FOREST) { r = 52; g = 84; b = 46; }
        else if (biome === Biome.ROCK) { r = 96; g = 92; b = 86; }
        else if (biome === Biome.MOUNTAIN) { r = 118; g = 114; b = 106; }
        else if (biome === Biome.SNOW) { r = 200; g = 206; b = 212; }
        else if (biome === Biome.ASPHALT) { r = 52; g = 52; b = 56; }
        else if (biome === Biome.DIRT) { r = 104; g = 88; b = 64; }
        // Simple hillshade so the map reads as terrain, not a flat blob.
        const hx = t.heights[j * (res + 1) + Math.min(res, i + 1)] - t.heights[j * (res + 1) + Math.max(0, i - 1)];
        const hz = t.heights[Math.min(res, j + 1) * (res + 1) + i] - t.heights[Math.max(0, j - 1) * (res + 1) + i];
        const shade = 1 + (hx + hz) * 0.02;
        const k = (j * res + i) * 4;
        img.data[k] = Math.max(0, Math.min(255, r * shade));
        img.data[k + 1] = Math.max(0, Math.min(255, g * shade));
        img.data[k + 2] = Math.max(0, Math.min(255, b * shade));
        img.data[k + 3] = 255;
      }
    }
    const tmp = document.createElement('canvas');
    tmp.width = res;
    tmp.height = res;
    tmp.getContext('2d')?.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, this.baseScale, this.baseScale);
    ctx.drawImage(tmp, 0, 0, res, res, 0, 0, this.baseScale, this.baseScale);
  }

  /**
   * Draws the radar. `range` is the visible radius in metres when rotating
   * (local) mode is used; the full map uses the whole island.
   */
  draw(opts: {
    actors: Actor[];
    vehicles: Vehicle[];
    localActor: Actor | null;
    yaw: number;
    zone: { x: number; z: number; radius: number; nextX: number; nextZ: number; nextRadius: number } | null;
    markers?: MinimapMarker[];
    full?: boolean;
    spectator?: Actor | null;
    /** Simulation time, used for "fired recently" radar pings. */
    time?: number;
    /** Line-of-sight test from the viewer's eye to a point. */
    los?: (x: number, y: number, z: number) => boolean;
  }): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const size = this.canvas.width;
    const centre = size / 2;
    const focus = opts.spectator ?? opts.localActor;
    const range = opts.full ? this.worldSize / 2 : 190;
    const scale = size / (range * 2);
    const rotate = !opts.full && settings.data.minimapRotate;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    // Circular clip for the radar, square for the full map.
    ctx.beginPath();
    if (opts.full) ctx.rect(0, 0, size, size);
    else ctx.arc(centre, centre, centre - 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#070a0d';
    ctx.fillRect(0, 0, size, size);

    const originX = focus ? focus.position.x : 0;
    const originZ = focus ? focus.position.z : 0;
    const rot = rotate && focus ? -opts.yaw - Math.PI / 2 : 0;
    // Small map-view rotation helper: world → map pixel.
    const project = (x: number, z: number): { px: number; py: number } => {
      let dx = (x - originX) * scale;
      let dz = (z - originZ) * scale;
      if (rot !== 0) {
        const c = Math.cos(rot);
        const s = Math.sin(rot);
        const rx = dx * c - dz * s;
        const rz = dx * s + dz * c;
        dx = rx;
        dz = rz;
      }
      return { px: centre + dx, py: centre + dz };
    };

    // Island bitmap
    const tl = project(-this.worldSize / 2, -this.worldSize / 2);
    const br = project(this.worldSize / 2, this.worldSize / 2);
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.95;
    ctx.drawImage(this.base, tl.px, tl.py, br.px - tl.px, br.py - tl.py);
    ctx.globalAlpha = 1;

    // Roads + POI labels
    ctx.strokeStyle = 'rgba(20,22,26,0.75)';
    ctx.lineWidth = opts.full ? 4 : 2;
    for (const road of this.layout.roads) {
      if (road.points.length < 2) continue;
      ctx.beginPath();
      road.points.forEach((p, i) => {
        const { px, py } = project(p.x, p.z);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    // Zone circle
    if (opts.zone) {
      const c = project(opts.zone.x, opts.zone.z);
      ctx.beginPath();
      ctx.arc(c.px, c.py, opts.zone.radius * scale, 0, Math.PI * 2);
      ctx.strokeStyle = '#63d7ff';
      ctx.lineWidth = opts.full ? 3 : 2;
      ctx.stroke();
      ctx.fillStyle = 'rgba(99,215,255,0.06)';
      ctx.fill();
      if (opts.zone.nextRadius > 0) {
        const n = project(opts.zone.nextX, opts.zone.nextZ);
        ctx.beginPath();
        ctx.arc(n.px, n.py, opts.zone.nextRadius * scale, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.setLineDash([6, 6]);
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Landmarks
    ctx.font = `${opts.full ? 14 : 10}px "Rajdhani", "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    for (const lm of this.layout.landmarks) {
      const { px, py } = project(lm.x, lm.z);
      if (px < -60 || py < -60 || px > size + 60 || py > size + 60) continue;
      ctx.fillStyle = 'rgba(240,244,248,0.35)';
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
      if (opts.full || scale > 0.35) {
        ctx.fillStyle = 'rgba(226,232,240,0.62)';
        ctx.fillText(lm.name.toUpperCase(), px, py - 6);
      }
    }

    // Markers (loot / vehicles / objectives)
    for (const m of opts.markers ?? []) {
      const { px, py } = project(m.x, m.z);
      if (px < -10 || py < -10 || px > size + 10 || py > size + 10) continue;
      switch (m.kind) {
        case 'loot':
          ctx.fillStyle = m.tier && m.tier >= 3 ? '#ffb347' : 'rgba(180,190,200,0.6)';
          ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
          break;
        case 'vehicle':
          ctx.fillStyle = 'rgba(140,200,255,0.8)';
          ctx.fillRect(px - 2, py - 2, 4, 4);
          break;
        case 'objective':
          ctx.fillStyle = '#f3c04a';
          ctx.beginPath();
          ctx.arc(px, py, 4, 0, Math.PI * 2);
          ctx.fill();
          break;
        default:
          break;
      }
    }

    // Vehicles from the sim (drivable markers)
    if (opts.full) {
      ctx.fillStyle = 'rgba(140,200,255,0.65)';
      for (const v of opts.vehicles) {
        if (v.destroyed) continue;
        const { px, py } = project(v.x, v.z);
        if (px < 0 || py < 0 || px > size || py > size) continue;
        ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
      }
    }

    // Actors
    const local = opts.localActor;
    for (const a of opts.actors) {
      if (a.lifeState === 'DEAD') continue;
      const isSelf = local ? a.id === local.id : false;
      const sameTeam = local ? a.team === local.team : false;
      // Enemies ping the radar when they fire (loud) or when they are close and
      // in line of sight; teammates are always shown.
      if (!isSelf && !sameTeam && !opts.full) {
        const viewer = opts.spectator ?? local;
        if (!viewer) continue;
        const dist = Math.hypot(a.position.x - viewer.position.x, a.position.z - viewer.position.z);
        const now = opts.time ?? 0;
        const firedLoud = now - a.lastShotTime < 2.5;
        const hurtRecently = Math.abs(a.health) < 1000 && now - a.lastDamageTime < 3.5;
        const visible = dist < 65 && (opts.los ? opts.los(a.position.x, a.position.y + 1.2, a.position.z) : true);
        const pinged = (firedLoud || hurtRecently) && dist < 140;
        if (!visible && !pinged) continue;
      }
      const { px, py } = project(a.position.x, a.position.z);
      if (px < -12 || py < -12 || px > size + 12 || py > size + 12) continue;
      let color = '#ff5d4d';
      if (isSelf) color = '#ffffff';
      else if (sameTeam) color = '#63d7ff';
      ctx.fillStyle = color;
      if (isSelf) {
        // Direction wedge for the local player
        const angle = rot !== 0 ? 0 : -opts.yaw + Math.PI / 2;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(-angle);
        ctx.beginPath();
        ctx.moveTo(0, -7);
        ctx.lineTo(5, 6);
        ctx.lineTo(-5, 6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(px, py, sameTeam ? 4 : 4.5, 0, Math.PI * 2);
        ctx.fill();
        if (sameTeam) {
          ctx.strokeStyle = 'rgba(10,14,18,0.9)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    // Spectated player ring
    if (opts.spectator) {
      const { px, py } = project(opts.spectator.position.x, opts.spectator.position.z);
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    if (!opts.full) {
      // Radar frame
      ctx.strokeStyle = 'rgba(150,170,190,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(centre, centre, centre - 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** Bearing of a world point relative to a viewer — used by waypoint arrows. */
  projectDirectional(x: number, z: number, viewerX: number, viewerZ: number, yaw: number): { bearing: number; distance: number } {
    const dx = x - viewerX;
    const dz = z - viewerZ;
    return { bearing: wrapAngle(Math.atan2(dx, -dz) - yaw), distance: Math.hypot(dx, dz) };
  }
}
