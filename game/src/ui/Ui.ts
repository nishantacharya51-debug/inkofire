import { settings, type QualityLevel } from '../core/Settings';
import { save } from '../core/SaveManager';
import { bus } from '../core/EventBus';
import { WEAPONS, GEAR, CONSUMABLES, THROWABLES, AMMO, type Rarity } from '../items/Items';
import { Hud } from './Hud';
import type { CombatWorld } from '../modes/CombatWorld';
import * as S from './Screens';

/**
 * Screen + overlay manager.
 *
 * Every clickable element carries `data-action`; a single delegated listener
 * routes it to the host (the Game). That makes it trivial to see which controls
 * are wired, and guarantees no button is a dead end.
 */

export type GameModeId = 'BR' | 'CLASH' | 'LONE' | 'TRAINING';

export interface MatchSetup {
  mode: GameModeId;
  teamSize: number;
  playerCount: number;
  difficulty: 'EASY' | 'NORMAL' | 'HARD' | 'ELITE';
  roundTarget: number;
  startCash: number;
  /** Training range only: static targets or patrolling ones. */
  dummies?: 'STATIC' | 'MOVING';
}

export interface UiHost {
  startMatch(setup: MatchSetup): void;
  setSetup(partial: Partial<MatchSetup>): void;
  readyUp(): void;
  leaveMatch(): void;
  resume(): void;
  playAgain(): void;
  toMainMenu(): void;
  onSettingsChanged(): void;
  getSetup(): MatchSetup;
  getClashState(): { active: boolean; cash: number; round: number; scoreUs: number; scoreThem: number } | null;
  buyItem(id: string, price: number, kind: string): boolean;
  startRoundNow(): void;
  continueRound(): void;
  dropWeapon(slot: number): void;
  setCallsign(name: string): void;
  isTouch(): boolean;
  touchInput: { press(action: string): void; release(action: string): void; stick: { x: number; y: number; active: boolean } };
}

type OverlayName = 'pause' | 'inventory' | 'map' | 'scoreboard' | 'controls' | 'buy' | 'round' | 'none';

export class Ui {
  private root: HTMLDivElement;
  private screenEl: HTMLElement | null = null;
  private currentScreen = '';
  private overlays = new Map<OverlayName, HTMLElement>();
  private hud: Hud | null = null;
  private selectedWeapon = 'raven50';
  private fullMapCanvas: HTMLCanvasElement | null = null;
  private activeOverlay: OverlayName = 'none';
  private loadingProgress = 0;
  private touchStickEl: HTMLElement | null = null;

  constructor(
    private container: HTMLElement,
    private host: UiHost
  ) {
    this.root = document.createElement('div');
    this.root.id = 'ui';
    this.root.style.position = 'absolute';
    this.root.style.inset = '0';
    this.root.style.pointerEvents = 'none';
    this.container.appendChild(this.root);
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('input', (e) => this.onInput(e as Event));
    document.body.classList.toggle('touch', this.host.isTouch());
    this.bindTouch();
  }

  /* ------------------------------------------------------------------ */
  /* Screen management                                                  */
  /* ------------------------------------------------------------------ */

  showScreen(name: 'loading' | 'menu' | 'setup' | 'lobby' | 'settings' | 'armory' | 'progression' | 'results' | 'help', setup?: MatchSetup): void {
    this.currentScreen = name;
    if (this.screenEl) this.screenEl.remove();
    const ctx = this.menuContext();
    let html = '';
    switch (name) {
      case 'loading':
        html = S.loadingScreen(this.loadingProgress, 'Tip: grabbing a weapon early beats looting a whole building.');
        break;
      case 'menu':
        html = S.mainMenuScreen(ctx);
        break;
      case 'setup':
        html = S.setupScreen(setup?.mode ?? this.host.getSetup().mode, ctx);
        break;
      case 'lobby':
        html = S.lobbyScreen({
          mode: this.host.getSetup().mode === 'BR' ? 'Battle Royale' : this.host.getSetup().mode,
          teamSize: this.host.getSetup().teamSize,
          playerCount: this.host.getSetup().playerCount,
          seconds: 12,
          mapName: 'Apex Island',
          difficulty: this.host.getSetup().difficulty
        });
        break;
      case 'settings':
        html = S.settingsScreen({
          quality: settings.data.quality,
          fov: settings.data.fov,
          sensitivity: settings.data.sensitivity,
          adsSensitivity: settings.data.adsSensitivity,
          invertY: settings.data.invertY,
          volumes: {
            master: settings.data.masterVolume,
            music: settings.data.musicVolume,
            sfx: settings.data.sfxVolume,
            voice: settings.data.voiceVolume
          },
          toggles: {
            showCrosshair: settings.data.showCrosshair,
            damageNumbers: settings.data.damageNumbers,
            damageIndicators: settings.data.damageIndicators,
            autoPickup: settings.data.autoPickup,
            autoReload: settings.data.autoReload,
            showFps: settings.data.showFps,
            minimapRotate: settings.data.minimapRotate,
            showBlood: settings.data.showBlood,
            firstPerson: settings.data.firstPerson
          },
          keybinds: settings.data.keybinds
        });
        break;
      case 'armory':
        html = S.armoryScreen({ ...ctx, selected: this.selectedWeapon });
        break;
      case 'progression':
        html = S.progressionScreen(ctx);
        break;
      case 'results':
        html = '';
        break;
      case 'help':
        html = S.helpScreen();
        break;
    }
    if (html) {
      const wrapper = document.createElement('div');
      wrapper.style.pointerEvents = 'auto';
      wrapper.innerHTML = html;
      this.screenEl = wrapper.firstElementChild as HTMLElement;
      this.root.appendChild(this.screenEl);
      this.applySegmentState();
    }
  }

  /** Name of the full-screen menu currently displayed ('' when in-game). */
  get screen(): string {
    return this.currentScreen;
  }

  /** Removes any full-screen menu (used when a match takes over the canvas). */
  closeScreens(): void {
    if (this.screenEl) {
      this.screenEl.remove();
      this.screenEl = null;
    }
    this.currentScreen = '';
  }

  /** Updates the big countdown inside the lobby screen. */
  setLobbyCountdown(seconds: number): void {
    const el = this.screenEl?.querySelector('#lobby-countdown') as HTMLElement | null;
    if (el) el.textContent = String(Math.max(0, Math.ceil(seconds)));
  }

  setLoading(progress: number, status: string): void {
    this.loadingProgress = progress;
    const bar = this.screenEl?.querySelector('.loading-bar i') as HTMLElement | null;
    if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
    const text = this.screenEl?.querySelector('#loading-status');
    if (text) text.textContent = status;
  }

  showResults(result: Parameters<typeof S.resultsScreen>[0]): void {
    if (this.screenEl) this.screenEl.remove();
    const wrapper = document.createElement('div');
    wrapper.style.pointerEvents = 'auto';
    wrapper.innerHTML = S.resultsScreen(result);
    this.screenEl = wrapper.firstElementChild as HTMLElement;
    this.root.appendChild(this.screenEl);
    this.currentScreen = 'results';
  }

  private menuContext(): S.MenuContext {
    return {
      profile: save.profile,
      stats: save.stats,
      history: save.data.history,
      botDifficulty: settings.data.botDifficulty,
      quality: settings.data.quality,
      mode: this.host.getSetup().mode
    };
  }

  /* ------------------------------------------------------------------ */
  /* Overlays                                                           */
  /* ------------------------------------------------------------------ */

  buildMatchOverlays(world: CombatWorld): void {
    const wrap = document.createElement('div');
    wrap.style.pointerEvents = 'auto';
    wrap.innerHTML =
      S.pauseMenuScreen(this.host.getSetup().mode, this.host.getClashState()) +
      S.inventoryOverlay(this.inventorySnapshot(world)) +
      S.mapOverlay() +
      S.scoreboardOverlay([], 0, 0) +
      S.controlsOverlay() +
      S.buyMenuScreen(0, this.buyOffers(0), 0, 1) +
      S.roundBanner(1, 0, 0, null) +
      S.touchControls();
    this.root.appendChild(wrap);
    for (const name of ['pause', 'inventory', 'map', 'scoreboard', 'controls', 'buy', 'round'] as OverlayName[]) {
      const el = wrap.querySelector(`#overlay-${name}`) as HTMLElement | null;
      if (el) this.overlays.set(name, el);
    }
    this.fullMapCanvas = wrap.querySelector('#fullmapCanvas');
    this.touchStickEl = wrap.querySelector('[data-touch="stick"]');
  }

  toggleOverlay(name: OverlayName, show?: boolean): void {
    const el = this.overlays.get(name);
    if (!el) return;
    const shouldShow = show ?? el.classList.contains('hidden');
    if (name !== 'none') {
      // Only one gameplay overlay at a time.
      if (shouldShow) {
        for (const [other, otherEl] of this.overlays) {
          if (other !== name) otherEl.classList.add('hidden');
        }
      }
      el.classList.toggle('hidden', !shouldShow);
      this.activeOverlay = shouldShow ? name : 'none';
    }
  }

  get overlay(): OverlayName {
    return this.activeOverlay;
  }

  isBlocking(): boolean {
    return this.activeOverlay !== 'none' || this.currentScreen !== '' && this.currentScreen !== 'loading';
  }

  hideAllOverlays(): void {
    for (const [, el] of this.overlays) el.classList.add('hidden');
    this.activeOverlay = 'none';
  }

  refreshInventory(world: CombatWorld): void {
    const el = this.overlays.get('inventory');
    if (!el) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = S.inventoryOverlay(this.inventorySnapshot(world));
    const fresh = wrapper.firstElementChild as HTMLElement;
    fresh.classList.toggle('hidden', el.classList.contains('hidden'));
    el.replaceWith(fresh);
    this.overlays.set('inventory', fresh);
    this.fullMapCanvas = this.root.querySelector('#fullmapCanvas') as HTMLCanvasElement | null;
  }

  private inventorySnapshot(world: CombatWorld): Parameters<typeof S.inventoryOverlay>[0] {
    const actor = world.localPlayer;
    if (!actor) {
      return {
        weapons: [], items: [], gear: { armor: '—', helmet: '—', backpack: '—' },
        capacity: { used: 0, max: 1 }, ammo: []
      };
    }
    const inv = actor.inventory;
    return {
      weapons: inv.weapons
        .map((w, slot) => {
          if (!w) return null;
          const def = WEAPONS[w.defId];
          return {
            slot,
            name: def?.name ?? w.defId,
            rarity: (w.rarity ?? 'COMMON') as Rarity,
            ammo: `${w.ammoInMag} / ${def ? inv.ammo[def.ammo] ?? 0 : 0}`,
            attachments: Object.values(w.attachments ?? {}).filter(Boolean) as string[]
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
      items: [
        ...inv.consumables.filter((c) => c.count > 0).map((c) => ({ name: CONSUMABLES[c.itemId]?.name ?? c.itemId, count: c.count })),
        ...inv.throwables.filter((t) => t.count > 0).map((t) => ({ name: THROWABLES[t.itemId]?.name ?? t.itemId, count: t.count }))
      ],
      gear: {
        armor: inv.armor ? GEAR[inv.armor]?.name ?? inv.armor : '—',
        helmet: inv.helmet ? GEAR[inv.helmet]?.name ?? inv.helmet : '—',
        backpack: inv.backpack ? GEAR[inv.backpack]?.name ?? inv.backpack : '—'
      },
      capacity: { used: Math.round(inv.used), max: inv.capacity },
      ammo: (Object.keys(AMMO) as (keyof typeof AMMO)[]).map((t) => ({ type: t, count: inv.ammo[t] ?? 0 }))
    };
  }

  refreshScoreboard(world: CombatWorld): void {
    const el = this.overlays.get('scoreboard');
    if (!el) return;
    const alive = world.actors.filter((a) => a.lifeState !== 'DEAD').length;
    const rows = world.actors.map((a) => ({
      name: a.name,
      kills: a.kills,
      damage: a.damageDealt,
      alive: a.lifeState !== 'DEAD',
      isYou: a.isLocal,
      team: a.team
    }));
    const wrapper = document.createElement('div');
    wrapper.innerHTML = S.scoreboardOverlay(rows, alive, world.actors.length);
    const fresh = wrapper.firstElementChild as HTMLElement;
    fresh.classList.toggle('hidden', el.classList.contains('hidden'));
    el.replaceWith(fresh);
    this.overlays.set('scoreboard', fresh);
  }

  /** Re-renders the pause overlay so clash economy info stays accurate. */
  refreshPause(): void {
    const el = this.overlays.get('pause');
    if (!el) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = S.pauseMenuScreen(this.host.getSetup().mode, this.host.getClashState());
    const fresh = wrapper.firstElementChild as HTMLElement;
    fresh.classList.toggle('hidden', el.classList.contains('hidden'));
    el.replaceWith(fresh);
    this.overlays.set('pause', fresh);
  }

  /* ------------------------------------------------------------------ */
  /* Clash Squad economy                                                */
  /* ------------------------------------------------------------------ */

  buyOffers(cash: number): Parameters<typeof S.buyMenuScreen>[1] {
    const offers: Parameters<typeof S.buyMenuScreen>[1] = [];
    const weaponPool = ['hornet9', 'vector45', 'raven50', 'lmg76', 'scrapper12', 'huntsman762', 'sabre556', 'longbow'];
    for (const id of weaponPool) {
      const def = WEAPONS[id];
      if (!def) continue;
      offers.push({
        id, name: def.name, price: Math.round(450 + def.tier * 420), kind: 'WEAPON',
        sub: `${def.cls} · ${def.damage} dmg · ${def.magSize} rounds`,
        rarity: def.tier >= 4 ? 'EPIC' : def.tier === 3 ? 'RARE' : def.tier === 2 ? 'UNCOMMON' : 'COMMON'
      });
    }
    for (const id of ['vest2', 'vest3', 'helmet2', 'helmet3', 'pack2']) {
      const gear = GEAR[id];
      if (!gear) continue;
      offers.push({
        id, name: gear.name, price: id.startsWith('pack') ? 380 : Math.round(gear.value * 4.2), kind: 'GEAR',
        sub: `${gear.slot} · level ${gear.level}`, rarity: gear.rarity
      });
    }
    offers.push({ id: 'medkit', name: 'Trauma Kit', price: 320, kind: 'MEDICAL', sub: 'Heals 75 over 5 s', rarity: 'RARE' });
    offers.push({ id: 'frag', name: 'Frag Charge', price: 240, kind: 'THROWABLE', sub: '92 damage · 8 m radius', rarity: 'RARE' });
    offers.push({ id: 'smoke', name: 'Veil Smoke', price: 160, kind: 'THROWABLE', sub: '16 s smoke screen', rarity: 'UNCOMMON' });
    void cash;
    return offers;
  }

  refreshBuyMenu(cash: number, seconds: number, round: number): void {
    const el = this.overlays.get('buy');
    if (!el) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = S.buyMenuScreen(cash, this.buyOffers(cash), seconds, round);
    const fresh = wrapper.firstElementChild as HTMLElement;
    fresh.classList.toggle('hidden', el.classList.contains('hidden'));
    el.replaceWith(fresh);
    this.overlays.set('buy', fresh);
  }

  updateBuyTimer(seconds: number): void {
    const el = this.overlays.get('buy')?.querySelector('#buy-timer');
    if (el) el.textContent = String(Math.max(0, Math.ceil(seconds)));
  }

  showRoundBanner(round: number, scoreUs: number, scoreThem: number, won: boolean | null): void {
    const el = this.overlays.get('round');
    if (!el) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = S.roundBanner(round, scoreUs, scoreThem, won);
    const fresh = wrapper.firstElementChild as HTMLElement;
    fresh.classList.remove('hidden');
    el.replaceWith(fresh);
    this.overlays.set('round', fresh);
    this.activeOverlay = 'round';
    // Clear the other overlays so the banner is readable.
    for (const [name, other] of this.overlays) if (name !== 'round') other.classList.add('hidden');
  }

  /* ------------------------------------------------------------------ */
  /* HUD                                                                */
  /* ------------------------------------------------------------------ */

  createHud(world: CombatWorld): Hud {
    this.destroyHud();
    this.hud = new Hud(this.root, world);
    return this.hud;
  }

  get hudRef(): Hud | null {
    return this.hud;
  }

  destroyHud(): void {
    this.hud?.dispose();
    this.hud = null;
  }

  clearMatchUi(): void {
    this.destroyHud();
    for (const [, el] of this.overlays) {
      const parent = el.parentElement;
      if (parent) parent.remove();
    }
    this.overlays.clear();
    this.fullMapCanvas = null;
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                             */
  /* ------------------------------------------------------------------ */

  private onClick(e: MouseEvent): void {
    const target = (e.target as HTMLElement | null)?.closest('[data-action]') as HTMLElement | null;
    if (!target) return;
    const action = target.dataset.action ?? '';
    const mode = target.dataset.mode as GameModeId | undefined;

    switch (action) {
      case 'quickplay': {
        const setup = this.host.getSetup();
        this.host.startMatch({ ...setup, mode: 'BR', teamSize: 1 });
        return;
      }
      case 'mode':
        if (mode) this.showScreen(mode === 'TRAINING' ? 'setup' : 'setup', { ...this.host.getSetup(), mode });
        return;
      case 'start':
        if (mode) this.host.startMatch({ ...this.host.getSetup(), mode });
        return;
      case 'ready':
        this.host.readyUp();
        return;
      case 'back':
        this.showScreen(this.currentScreen === 'setup' ? 'menu' : 'menu');
        return;
      case 'leave':
        this.host.leaveMatch();
        return;
      case 'settings':
        this.showScreen('settings');
        return;
      case 'armory':
        this.showScreen('armory');
        return;
      case 'progression':
        this.showScreen('progression');
        return;
      case 'help':
        this.showScreen('help');
        return;
      case 'select-weapon':
        this.selectedWeapon = target.dataset.id ?? this.selectedWeapon;
        this.showScreen('armory');
        return;
      case 'set-name': {
        const input = this.screenEl?.querySelector('#name-input') as HTMLInputElement | null;
        if (input) {
          this.host.setCallsign(input.value.trim() || 'Operator');
          bus.emit('ui:toast', { text: 'Callsign updated', kind: 'good' });
        }
        return;
      }
      case 'reset-keybinds':
        settings.resetKeybinds();
        this.host.onSettingsChanged();
        this.showScreen('settings');
        bus.emit('ui:toast', { text: 'Keybinds reset', kind: 'info' });
        return;
      case 'reset-settings':
        settings.resetAll();
        this.host.onSettingsChanged();
        this.showScreen('settings');
        bus.emit('ui:toast', { text: 'Settings reset to defaults', kind: 'info' });
        return;
      case 'resume':
        this.host.resume();
        return;
      case 'controls':
        this.toggleOverlay('controls', true);
        return;
      case 'close-controls':
        this.toggleOverlay('controls', false);
        return;
      case 'close-map':
        this.toggleOverlay('map', false);
        return;
      case 'drop-weapon':
        this.host.dropWeapon(Number(target.dataset.slot ?? -1));
        return;
      case 'buy': {
        const price = Number(target.dataset.price ?? 0);
        const id = target.dataset.id ?? '';
        const kind = target.dataset.kind ?? 'WEAPON';
        if (!this.host.buyItem(id, price, kind)) {
          bus.emit('ui:toast', { text: 'Not enough cash', kind: 'warn' });
        }
        return;
      }
      case 'start-round':
        this.host.startRoundNow();
        return;
      case 'continue-round':
        this.host.continueRound();
        return;
      case 'play-again':
        this.host.playAgain();
        return;
      case 'to-menu':
        this.host.toMainMenu();
        return;
      default:
        break;
    }
  }

  private onInput(e: Event): void {
    const el = e.target as HTMLElement;
    const range = el.dataset?.range;
    if (range) {
      const value = Number((el as HTMLInputElement).value);
      const label = this.root.querySelector(`[data-range-val="${range}"]`);
      if (label) label.textContent = value.toFixed(value < 3 ? 2 : 0);
      switch (range) {
        case 'sensitivity': settings.set('sensitivity', value); break;
        case 'adsSensitivity': settings.set('adsSensitivity', value); break;
        case 'fov': settings.set('fov', value); break;
        case 'master': settings.set('masterVolume', value); break;
        case 'music': settings.set('musicVolume', value); break;
        case 'sfx': settings.set('sfxVolume', value); break;
        case 'voice': settings.set('voiceVolume', value); break;
        default: break;
      }
      this.host.onSettingsChanged();
    }
  }

  /** Segmented controls + toggles need direct listeners (they are not actions). */
  private bindSegments(): void {
    if (!this.screenEl) return;
    for (const seg of Array.from(this.screenEl.querySelectorAll<HTMLElement>('[data-seg]'))) {
      seg.addEventListener('click', (ev) => {
        const btn = (ev.target as HTMLElement).closest('button') as HTMLButtonElement | null;
        if (!btn) return;
        const key = seg.dataset.seg as string;
        const value = btn.dataset.value as string;
        for (const b of Array.from(seg.querySelectorAll('button'))) b.classList.toggle('on', b === btn);
        this.applySettingValue(key, value);
      });
    }
    for (const toggle of Array.from(this.screenEl.querySelectorAll<HTMLElement>('[data-toggle]'))) {
      toggle.addEventListener('click', () => {
        const key = toggle.dataset.toggle as string;
        toggle.classList.toggle('on');
        const on = toggle.classList.contains('on');
        this.applyToggleValue(key, on);
      });
    }
  }

  private applySegmentState(): void {
    this.bindSegments();
  }

  private applySettingValue(key: string, value: string): void {
    switch (key) {
      case 'quality': settings.set('quality', value as QualityLevel | 'AUTO'); this.host.onSettingsChanged(); break;
      case 'difficulty': settings.set('botDifficulty', value as 'EASY' | 'NORMAL' | 'HARD' | 'ELITE'); break;
      case 'teamSize': this.host.setSetup({ teamSize: Number(value) }); break;
      case 'playerCount': this.host.setSetup({ playerCount: Number(value) }); break;
      case 'roundTarget': this.host.setSetup({ roundTarget: Number(value) }); break;
      case 'startCash': this.host.setSetup({ startCash: Number(value) }); break;
      case 'dummies': this.host.setSetup({ dummies: value === 'moving' ? 'MOVING' : 'STATIC' }); break;
      default: break;
    }
  }

  private applyToggleValue(key: string, on: boolean): void {
    switch (key) {
      case 'showCrosshair': settings.set('showCrosshair', on); break;
      case 'damageNumbers': settings.set('damageNumbers', on); break;
      case 'damageIndicators': settings.set('damageIndicators', on); break;
      case 'autoPickup': settings.set('autoPickup', on); break;
      case 'autoReload': settings.set('autoReload', on); break;
      case 'minimapRotate': settings.set('minimapRotate', on); break;
      case 'showBlood': settings.set('showBlood', on); break;
      case 'firstPerson': settings.set('firstPerson', on); break;
      case 'invertY': settings.set('invertY', on); break;
      case 'showFps': settings.set('showFps', on); break;
      default: break;
    }
    this.host.onSettingsChanged();
  }

  /* ------------------------------------------------------------------ */
  /* Touch (architecturally present for mobile)                          */
  /* ------------------------------------------------------------------ */

  private bindTouch(): void {
    if (!this.host.isTouch()) return;
    const stick = this.touchStickEl;
    if (stick) {
      let active = false;
      let originX = 0;
      let originY = 0;
      const knob = stick.querySelector('i') as HTMLElement;
      const onStart = (e: PointerEvent): void => {
        active = true;
        originX = e.clientX;
        originY = e.clientY;
        stick.setPointerCapture(e.pointerId);
      };
      const onMove = (e: PointerEvent): void => {
        if (!active) return;
        const dx = e.clientX - originX;
        const dy = e.clientY - originY;
        const max = 48;
        const len = Math.hypot(dx, dy) || 1;
        const cx = (dx / len) * Math.min(max, len);
        const cy = (dy / len) * Math.min(max, len);
        knob.style.transform = `translate(${cx}px, ${cy}px)`;
        this.host.touchInput.stick.x = cx / max;
        this.host.touchInput.stick.y = cy / max;
        this.host.touchInput.stick.active = true;
      };
      const onEnd = (): void => {
        active = false;
        knob.style.transform = '';
        this.host.touchInput.stick.x = 0;
        this.host.touchInput.stick.y = 0;
        this.host.touchInput.stick.active = false;
      };
      stick.addEventListener('pointerdown', onStart);
      stick.addEventListener('pointermove', onMove);
      stick.addEventListener('pointerup', onEnd);
      stick.addEventListener('pointercancel', onEnd);
    }
    for (const btn of Array.from(this.root.querySelectorAll<HTMLElement>('[data-touch]'))) {
      const action = btn.dataset.touch as string;
      if (action === 'stick') continue;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.host.touchInput.press(action);
      });
      btn.addEventListener('pointerup', () => this.host.touchInput.release(action));
      btn.addEventListener('pointercancel', () => this.host.touchInput.release(action));
    }
  }

  get fullMap(): HTMLCanvasElement | null {
    return this.fullMapCanvas;
  }
}
