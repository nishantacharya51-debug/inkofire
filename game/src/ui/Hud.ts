import * as THREE from 'three';
import type { Actor } from '../entity/Actor';
import type { CombatWorld } from '../modes/CombatWorld';
import { settings } from '../core/Settings';
import { bus } from '../core/EventBus';
import { Minimap } from './Minimap';
import { WEAPONS, AMMO, CONSUMABLES, THROWABLES, RARITY_COLOR } from '../items/Items';
import { displayName } from '../loot/LootSystem';
import { clamp } from '../utils/mathx';

/**
 * In-match HUD: health/armor, weapon + ammo readouts, dynamic crosshair,
 * killfeed, minimap, zone status, squad panel, interaction prompt, floating
 * damage numbers and the big overlays (inventory / map / scoreboard / pause).
 */

interface DamageNumber {
  el: HTMLElement;
  worldX: number;
  worldY: number;
  worldZ: number;
  life: number;
  vy: number;
}

export class Hud {
  readonly root: HTMLDivElement;
  private crosshair!: HTMLDivElement;
  private hitmarker!: HTMLDivElement;
  private healthFill!: HTMLDivElement;
  private healthText!: HTMLDivElement;
  private armorFill!: HTMLDivElement;
  private armorText!: HTMLDivElement;
  private weaponName!: HTMLDivElement;
  private weaponAmmo!: HTMLDivElement;
  private weaponMode!: HTMLDivElement;
  private slots: HTMLDivElement[] = [];
  private killfeed!: HTMLDivElement;
  private aliveCount!: HTMLDivElement;
  private zoneInfo!: HTMLDivElement;
  private timerText!: HTMLDivElement;
  private prompt!: HTMLDivElement;
  private toasts!: HTMLDivElement;
  private squad!: HTMLDivElement;
  private compass!: HTMLDivElement;
  private damageLayer!: HTMLDivElement;
  private spectateBar!: HTMLDivElement;
  private lowHealth!: HTMLDivElement;
  private vignette!: HTMLDivElement;
  private consumables!: HTMLDivElement;
  private markerLayer!: HTMLDivElement;
  private minimap: Minimap;
  private minimapCanvas!: HTMLCanvasElement;
  private damageNumbers: DamageNumber[] = [];
  private lastHitTime = 0;
  private markersEnabled = true;

  constructor(
    private container: HTMLElement,
    private world: CombatWorld
  ) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = TEMPLATE;
    this.container.appendChild(this.root);
    this.bindElements();
    this.minimap = new Minimap(this.minimapCanvas, this.world.layout, this.world.terrain.size);
    this.bindEvents();
  }

  private bindElements(): void {
    const q = <T extends HTMLElement>(sel: string): T => {
      const el = this.root.querySelector(sel) as T | null;
      if (!el) throw new Error(`HUD element missing: ${sel}`);
      return el;
    };
    this.crosshair = q('#crosshair');
    this.hitmarker = q('#hitmarker');
    this.healthFill = q('#hpFill');
    this.healthText = q('#hpText');
    this.armorFill = q('#armorFill');
    this.armorText = q('#armorText');
    this.weaponName = q('#weaponName');
    this.weaponAmmo = q('#weaponAmmo');
    this.weaponMode = q('#weaponMode');
    this.slots = [q('#slot0'), q('#slot1'), q('#slot2'), q('#slot3')];
    this.killfeed = q('#killfeed');
    this.aliveCount = q('#aliveCount');
    this.zoneInfo = q('#zoneInfo');
    this.timerText = q('#zoneTimer');
    this.prompt = q('#prompt');
    this.toasts = q('#toasts');
    this.squad = q('#squad');
    this.compass = q('#compass');
    this.damageLayer = q('#damageNumbers');
    this.spectateBar = q('#spectateBar');
    this.lowHealth = q('#lowHealth');
    this.vignette = q('#vignette');
    this.consumables = q('#consumables');
    this.markerLayer = q('#objectiveMarkers');
    this.minimapCanvas = q<HTMLCanvasElement>('#minimapCanvas');
  }

  private bindEvents(): void {
    bus.on('killfeed', (e) => this.addKill(e.killer, e.victim, e.weapon, e.headshot, e.isLocalKiller, e.isLocalVictim));
    bus.on('hitmarker', (e) => this.showHitmarker(e.headshot, e.killed));
    bus.on('actor:damaged', (e) => {
      if (e.isLocal) this.flashDamage();
    });
    bus.on('ui:toast', (e) => this.toast(e.text, e.kind));
    bus.on('zone:warning', (e) => this.zoneWarning(e.level));
    bus.on('loot:pickup', (e) => this.toast(`+ ${e.name}`, 'good'));
    bus.on('ammo:empty', () => this.toast('Reload!', 'warn'));
    bus.on('player:downed', () => this.toast('You are down — hold on for a revive', 'bad'));
    bus.on('parachute:deployed', () => this.toast('Parachute deployed', 'info'));
  }

  setMinimapMarkersEnabled(v: boolean): void {
    this.markersEnabled = v;
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame                                                          */
  /* ------------------------------------------------------------------ */

  update(dt: number, spectator: Actor | null, opts: { paused?: boolean; matchTime?: number } = {}): void {
    const local = this.world.localPlayer;
    const actor = spectator ?? local;
    if (!actor) return;
    this.updateVitals(actor, local);
    if (!spectator) {
      this.updateWeapon(actor);
      this.updateSlots(actor);
      this.updateCrosshair(actor);
      this.updateConsumables(actor);
    }
    this.updateDamageNumbers(dt);
    this.updateSquad(local, actor);
    this.updateCompass(actor, local);

    // Minimap
    const yaw = actor.yaw;
    this.minimap.draw({
      actors: this.world.actors,
      vehicles: this.world.vehicles.vehicles,
      localActor: local,
      spectator,
      yaw,
      zone: this.world.zoneSnapshot(),
      full: false,
      time: this.world.time,
      los: (x, y, z) => {
        const viewer = local ?? actor;
        const eye = viewer.eyePosition;
        const dx = x - eye.x;
        const dy = y - eye.y;
        const dz = z - eye.z;
        const dist = Math.hypot(dx, dy, dz) || 1;
        const hit = this.world.collision.raycast(eye.x, eye.y, eye.z, dx / dist, dy / dist, dz / dist, dist);
        return !hit || hit.dist >= dist - 0.4;
      }
    });

    this.updateObjectiveMarkers(actor);
    this.spectateBar.style.display = spectator ? 'flex' : 'none';
    this.lowHealth.style.opacity = local && local.lifeState !== 'DEAD' && local.health < 35 ? '1' : '0';
    this.vignette.style.opacity = local && local.lifeState !== 'DEAD' && local.health < 55 ? String(clamp((55 - local.health) / 55, 0, 0.55)) : '0';
    void dt;
    void opts;
  }

  private updateVitals(actor: Actor, local: Actor | null): void {
    const hp = clamp(actor.health / actor.maxHealth, 0, 1);
    this.healthFill.style.width = `${hp * 100}%`;
    this.healthFill.style.background = hp > 0.55 ? 'linear-gradient(90deg,#39d98a,#7ef0b0)' : hp > 0.28 ? 'linear-gradient(90deg,#f0b429,#ffd166)' : 'linear-gradient(90deg,#e5484d,#ff7b72)';
    this.healthText.textContent = String(Math.max(0, Math.round(actor.health)));

    const armorMax = actor.inventory.maxArmorPoints;
    const armorPts = actor.inventory.armorPoints;
    const armorRatio = armorMax > 0 ? clamp(armorPts / armorMax, 0, 1) : 0;
    this.armorFill.style.width = `${armorRatio * 100}%`;
    this.armorText.textContent = armorMax > 0 ? String(Math.round(armorPts)) : '—';
    void local;
  }

  private updateWeapon(actor: Actor): void {
    const active = actor.inventory.active;
    const def = active ? WEAPONS[active.defId] : null;
    if (!def) {
      this.weaponName.textContent = 'UNARMED';
      this.weaponAmmo.textContent = '—';
      this.weaponMode.textContent = '';
      return;
    }
    this.weaponName.textContent = def.name.toUpperCase();
    this.weaponName.style.color = RARITY_COLOR[active?.rarity ?? 'COMMON'] ?? '#e6edf3';
    const reserve = actor.inventory.ammo[def.ammo] ?? 0;
    this.weaponAmmo.innerHTML = `<b>${active?.ammoInMag ?? 0}</b><span>${reserve}</span>`;
    this.weaponMode.textContent = `${def.fireModes[0]}${actor.adsProgress > 0.5 ? ' · ADS' : ''}${actor.reloadTimer > 0 ? ' · RELOADING' : ''}`;
    void AMMO;
  }

  private updateSlots(actor: Actor): void {
    for (let i = 0; i < this.slots.length; i++) {
      const inst = actor.inventory.weapons[i] as import('../inventory/Inventory').WeaponInstance | undefined;
      const el = this.slots[i];
      const label = el.querySelector('.slot-name') as HTMLElement;
      const key = el.querySelector('.slot-key') as HTMLElement;
      key.textContent = String(i + 1);
      if (!inst) {
        label.textContent = '— empty —';
        el.classList.remove('active', 'filled');
        continue;
      }
      const def = WEAPONS[inst.defId];
      label.textContent = def ? def.name : inst.defId;
      el.classList.add('filled');
      el.classList.toggle('active', actor.inventory.activeSlot === i);
      el.style.borderLeftColor = RARITY_COLOR[inst.rarity] ?? '#666';
      const mag = `${inst.ammoInMag}`;
      const res = inst.defId ? (actor.inventory.ammo[WEAPONS[inst.defId].ammo] ?? 0) : 0;
      (el.querySelector('.slot-ammo') as HTMLElement).textContent = `${mag} / ${res}`;
    }
  }

  private updateCrosshair(actor: Actor): void {
    if (!settings.data.showCrosshair || actor.adsProgress > 0.85) {
      this.crosshair.style.opacity = '0';
      return;
    }
    this.crosshair.style.opacity = '1';
    const def = actor.inventory.active ? WEAPONS[actor.inventory.active.defId] : null;
    const spread = actor.currentSpread();
    const size = 6 + spread * 220 + (def?.cls === 'SHOTGUN' ? 6 : 0);
    this.crosshair.style.setProperty('--gap', `${Math.min(46, size).toFixed(1)}px`);
    this.crosshair.style.color = settings.data.crosshairColor;
    this.crosshair.classList.toggle('hidden', actor.adsProgress > 0.5);
    void def;
  }

  private updateConsumables(actor: Actor): void {
    const items: string[] = [];
    for (const stack of actor.inventory.consumables) {
      if (stack.count > 0) items.push(`${CONSUMABLES[stack.itemId]?.name ?? stack.itemId} <b>${stack.count}</b>`);
    }
    for (const stack of actor.inventory.throwables) {
      if (stack.count > 0) items.push(`${THROWABLES[stack.itemId]?.name ?? stack.itemId} <b>${stack.count}</b>`);
    }
    this.consumables.innerHTML = items.map((t) => `<div class="chip">${t}</div>`).join('');
  }

  private updateSquad(local: Actor | null, focus: Actor): void {
    if (!local || local.team === undefined) {
      this.squad.style.display = 'none';
      return;
    }
    const mates = this.world.actors.filter((a) => a.team === local.team);
    if (mates.length <= 1) {
      this.squad.style.display = 'none';
      return;
    }
    this.squad.style.display = 'grid';
    this.squad.innerHTML = mates
      .map((m) => {
        const isFocus = m.id === focus.id;
        const cls = m.lifeState === 'DOWNED' ? 'down' : m.lifeState === 'DEAD' ? 'dead' : 'alive';
        const dist = Math.round(m.distanceTo((local ?? focus).position.x, (local ?? focus).position.y, (local ?? focus).position.z));
        return `<div class="mate ${cls}${isFocus ? ' focus' : ''}">
          <span class="mate-name">${escapeHtml(m.name)}</span>
          <span class="mate-bar"><i style="width:${clamp(m.health, 0, 100)}%"></i></span>
          <span class="mate-dist">${classOf(m) === 'alive' ? `${dist}m` : cls.toUpperCase()}</span>
        </div>`;
      })
      .join('');
  }

  private updateCompass(actor: Actor, local: Actor | null): void {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const yaw = actor.yaw;
    const heading = ((-yaw * 180) / Math.PI + 360) % 360;
    const idx = Math.round(heading / 45) % 8;
    const focus = local ?? actor;
    const waypoint = this.nearestLandmark(focus);
    let arrow = '';
    if (waypoint) {
      const dx = waypoint.x - focus.position.x;
      const dz = waypoint.z - focus.position.z;
      const bearing = Math.atan2(dx, -dz) - yaw;
      const deg = (bearing * 180) / Math.PI;
      const dist = Math.round(Math.hypot(dx, dz));
      arrow = `<span class="waypoint" style="transform:rotate(${deg.toFixed(0)}deg)">▲</span><span class="wp-label">${escapeHtml(waypoint.label)} ${dist}m</span>`;
    }
    this.compass.innerHTML = `<span class="heading">${dirs[idx]} ${Math.round(heading)}°</span>${arrow}`;
  }

  private nearestLandmark(actor: Actor): { x: number; z: number; label: string } | null {
    if (!this.markersEnabled) return null;
    let best: { x: number; z: number; label: string } | null = null;
    let bestDist = 1e9;
    for (const lm of this.world.layout.landmarks) {
      const d = (lm.x - actor.position.x) ** 2 + (lm.z - actor.position.z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = { x: lm.x, z: lm.z, label: lm.name };
      }
    }
    return best;
  }

  private updateObjectiveMarkers(actor: Actor): void {
    // Nearby loot + vehicles become world-anchored HUD chips (helps new players).
    const items = this.world.loot.nearby(actor.position.x, actor.position.y, actor.position.z, 22);
    const shown = items.slice(0, 6);
    this.markerLayer.innerHTML = shown
      .map((item) => {
        const dx = item.x - actor.position.x;
        const dz = item.z - actor.position.z;
        const dist = Math.hypot(dx, dz);
        const cls = item.rarity === 'LEGENDARY' || item.rarity === 'EPIC' ? 'rare' : '';
        return `<div class="loot-chip ${cls}" data-x="${item.x.toFixed(1)}" data-y="${item.y.toFixed(1)}" data-z="${item.z.toFixed(1)}">
          <span class="loot-name">${escapeHtml(displayName(item.itemId))}</span>
          <span class="loot-dist">${dist.toFixed(0)}m</span>
        </div>`;
      })
      .join('');
  }

  /** Floats a damage number in world space (projected each frame). */
  spawnDamageNumber(x: number, y: number, z: number, amount: number, kind: 'out' | 'in' | 'head' = 'out'): void {
    const el = document.createElement('div');
    el.className = `dmg ${kind}`;
    el.textContent = kind === 'in' ? `-${Math.round(amount)}` : `${Math.round(amount)}`;
    this.damageLayer.appendChild(el);
    this.damageNumbers.push({ el, worldX: x, worldY: y, worldZ: z, life: 1.1, vy: 1.4 });
    if (this.damageNumbers.length > 40) {
      const old = this.damageNumbers.shift();
      old?.el.remove();
    }
  }

  private updateDamageNumbers(dt: number): void {
    if (this.damageNumbers.length === 0) return;
    const cam = this.cameraRef;
    if (!cam) return;
    const v = new THREE.Vector3();
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const d = this.damageNumbers[i];
      d.life -= dt;
      d.worldY += d.vy * dt;
      d.vy *= 0.92;
      v.set(d.worldX, d.worldY, d.worldZ).project(cam);
      const x = (v.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
      d.el.style.transform = `translate(-50%,-50%) translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
      d.el.style.opacity = String(clamp(d.life, 0, 1));
      if (d.life <= 0 || v.z > 1) {
        d.el.remove();
        this.damageNumbers.splice(i, 1);
      }
    }
  }

  /** Wired by the game layer so damage numbers can be projected. */
  private cameraRef: THREE.PerspectiveCamera | null = null;

  attachCamera(camera: THREE.PerspectiveCamera): void {
    this.cameraRef = camera;
  }

  /* ------------------------------------------------------------------ */
  /* Feed / prompts                                                     */
  /* ------------------------------------------------------------------ */

  private addKill(killer: string, victim: string, weapon: string, headshot: boolean, isLocalKiller: boolean, isLocalVictim: boolean): void {
    const el = document.createElement('div');
    el.className = `kill ${isLocalKiller ? 'mine' : ''} ${isLocalVictim ? 'victim' : ''}`;
    const wname = WEAPONS[weapon]?.name ?? weapon;
    el.innerHTML = `<span class="k">${escapeHtml(killer)}</span>
      <span class="w">${headshot ? '<i class="hs">HS</i>' : ''}${escapeHtml(wname)}</span>
      <span class="v">${escapeHtml(victim)}</span>`;
    this.killfeed.appendChild(el);
    window.setTimeout(() => el.classList.add('fade'), 5200);
    window.setTimeout(() => el.remove(), 6000);
    while (this.killfeed.children.length > 6) this.killfeed.firstChild?.remove();
  }

  private showHitmarker(headshot: boolean, killed: boolean): void {
    this.hitmarker.className = `hitmarker show${headshot ? ' head' : ''}${killed ? ' kill' : ''}`;
    this.lastHitTime = performance.now();
    window.setTimeout(() => {
      if (performance.now() - this.lastHitTime >= 90) this.hitmarker.className = 'hitmarker';
    }, 90);
  }

  private flashDamage(): void {
    const el = document.createElement('div');
    el.className = 'dmg-flash';
    this.root.appendChild(el);
    window.setTimeout(() => el.remove(), 420);
  }

  private toast(text: string, kind: 'info' | 'warn' | 'good' | 'bad'): void {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 5) this.toasts.firstChild?.remove();
    window.setTimeout(() => el.classList.add('out'), 2600);
    window.setTimeout(() => el.remove(), 3200);
  }

  private zoneWarning(level: number): void {
    const text = level >= 3 ? 'Zone closing — move now!' : level === 2 ? 'Zone is shrinking' : 'Zone timing updated';
    this.toast(text, level >= 3 ? 'bad' : 'warn');
    this.zoneInfo.classList.add('warn');
    window.setTimeout(() => this.zoneInfo.classList.remove('warn'), 1800);
  }

  setZone(phase: number, radius: number, seconds: number, shrinking: boolean): void {
    this.zoneInfo.textContent = `PHASE ${phase + 1} · ${Math.round(radius)}m ${shrinking ? '· CLOSING' : ''}`;
    const m = Math.floor(Math.max(0, seconds) / 60);
    const s = Math.floor(Math.max(0, seconds) % 60);
    this.timerText.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    this.timerText.classList.toggle('urgent', seconds < 15);
  }

  setAlive(count: number, total: number): void {
    this.aliveCount.innerHTML = `<b>${count}</b> / ${total} <span>ALIVE</span>`;
  }

  setPrompt(text: string | null): void {
    this.prompt.textContent = text ?? '';
    this.prompt.style.opacity = text ? '1' : '0';
  }

  /* ------------------------------------------------------------------ */
  /* Overlays                                                           */
  /* ------------------------------------------------------------------ */

  showSpectateTarget(name: string, index: number, total: number, isSelf: boolean): void {
    this.spectateBar.innerHTML = `<span class="spec-label">SPECTATING</span>
      <span class="spec-name">${escapeHtml(name)}${isSelf ? ' (you)' : ''}</span>
      <span class="spec-nav">[click] next · [Q] previous · ${index + 1}/${total}</span>`;
  }

  dispose(): void {
    for (const d of this.damageNumbers) d.el.remove();
    this.damageNumbers.length = 0;
    this.root.remove();
  }
}

function classOf(m: Actor): 'alive' | 'down' | 'dead' {
  if (m.lifeState === 'DEAD') return 'dead';
  if (m.lifeState === 'DOWNED') return 'down';
  return 'alive';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const TEMPLATE = /* html */ `
<div id="vignette"></div>
<div id="crosshair" class="crosshair"><i></i><i></i><i></i><i></i><span class="dot"></span></div>
<div id="hitmarker" class="hitmarker"><i></i><i></i><i></i><i></i></div>
<div id="damageNumbers" class="damage-numbers"></div>
<div id="objectiveMarkers" class="loot-chips"></div>

<div class="top-bar">
  <div id="aliveCount" class="alive">0 / 0 <span>ALIVE</span></div>
  <div id="compass" class="compass"></div>
  <div class="zone">
    <div id="zoneInfo" class="zone-info">PHASE 1</div>
    <div id="zoneTimer" class="zone-timer">0:00</div>
  </div>
</div>

<div id="killfeed" class="killfeed"></div>
<div id="toasts" class="toasts"></div>

<div class="bottom-left">
  <div class="vitals">
    <div class="bar hp"><i id="hpFill"></i><span id="hpText">100</span><label>HEALTH</label></div>
    <div class="bar armor"><i id="armorFill"></i><span id="armorText">0</span><label>ARMOR</label></div>
  </div>
  <div id="consumables" class="consumables"></div>
</div>

<div class="bottom-right">
  <div class="weapon-panel">
    <div id="slots">
      <div class="slot" id="slot0"><span class="slot-key">1</span><span class="slot-name">— empty —</span><span class="slot-ammo"></span></div>
      <div class="slot" id="slot1"><span class="slot-key">2</span><span class="slot-name">— empty —</span><span class="slot-ammo"></span></div>
      <div class="slot" id="slot2"><span class="slot-key">3</span><span class="slot-name">— empty —</span><span class="slot-ammo"></span></div>
      <div class="slot" id="slot3"><span class="slot-key">4</span><span class="slot-name">— empty —</span><span class="slot-ammo"></span></div>
    </div>
    <div class="weapon-current">
      <div id="weaponName" class="weapon-name">UNARMED</div>
      <div id="weaponAmmo" class="weapon-ammo"><b>0</b><span>0</span></div>
      <div id="weaponMode" class="weapon-mode"></div>
    </div>
  </div>
  <div class="minimap-wrap">
    <canvas id="minimapCanvas" width="220" height="220"></canvas>
  </div>
</div>

<div id="squad" class="squad"></div>
<div id="prompt" class="prompt"></div>
<div id="spectateBar" class="spectate-bar"></div>
<div id="lowHealth" class="low-health"></div>
`;

export { escapeHtml };
