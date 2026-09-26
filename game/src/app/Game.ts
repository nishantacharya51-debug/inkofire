import { Engine, type FrameInfo } from '../core/Engine';
import { Input } from '../core/Input';
import { settings } from '../core/Settings';
import { save } from '../core/SaveManager';
import { gameState } from '../core/GameState';
import { bus } from '../core/EventBus';
import { generateTerrain, WORLD_SIZE, TERRAIN_RES, type TerrainData } from '../world/Terrain';
import { generateLayout, type MapLayout } from '../world/MapLayout';
import { CombatWorld, type CombatHooks } from '../modes/CombatWorld';
import { BattleRoyale, type BRConfig } from '../modes/BattleRoyale';
import { ArenaMode, type ArenaConfig } from '../modes/Arena';
import { PlayerController } from '../player/PlayerController';
import { CameraRig } from '../camera/CameraRig';
import { WorldRenderer } from '../render/WorldRenderer';
import { ActorRenderer } from '../render/ActorRenderer';
import { CombatEffects } from '../render/CombatEffects';
import { AudioSystem } from '../audio/AudioSystem';
import { NetworkSession, LocalTransport } from '../network/NetworkSession';
import { Ui, type MatchSetup, type UiHost } from '../ui/Ui';
import { Hud } from '../ui/Hud';
import { precacheTextures } from '../utils/textures';
import { clamp } from '../utils/mathx';

type ActiveMode = BattleRoyale | ArenaMode;

/** Snapshot of match state — used by the debug console and automated QA. */
export interface GameStatus {
  ready: boolean;
  screen: string;
  overlay: string;
  mode: MatchSetup['mode'];
  world: {
    time: number;
    actors: number;
    alive: number;
    loot: number;
    vehicles: number;
    localHp: number;
    localState: string;
    kills: number;
    damage: number;
    shotsFired: number;
    shotsHit: number;
    armed: boolean;
  } | null;
  br: { phase: string; alive: number; placement: number; victory: boolean } | null;
  arena: {
    kind: string;
    phase: string;
    round: number;
    scoreUs: number;
    scoreThem: number;
    matchOver: boolean;
  } | null;
}

/**
 * Game orchestrator: owns the engine, the active mode, the renderers and the UI,
 * and is the only place that knows how a match is built and torn down.
 */
export class Game implements UiHost {
  private engine: Engine;
  private input: Input;
  private ui: Ui;
  private audio = new AudioSystem();
  private effects: CombatEffects | null = null;
  private worldRenderer: WorldRenderer | null = null;
  private actorRenderer: ActorRenderer | null = null;
  private hud: Hud | null = null;
  private cameraRig: CameraRig | null = null;
  private controller: PlayerController | null = null;
  private network: NetworkSession | null = null;
  private terrain: TerrainData | null = null;
  private layout: MapLayout | null = null;
  private world: CombatWorld | null = null;
  private mode: ActiveMode | null = null;
  private modeKind: MatchSetup['mode'] = 'BR';
  private setup: MatchSetup = {
    mode: 'BR', teamSize: 1, playerCount: 30,
    difficulty: 'NORMAL', roundTarget: 4, startCash: 800, dummies: 'STATIC'
  };
  private paused = false;
  private disposed = false;
  /** True once terrain, layout, textures and the main menu are all ready. */
  private booted = false;
  /** Resolves once terrain, layout and textures are ready (menu is showing). */
  readonly ready: Promise<void>;
  private fpsEl: HTMLElement | null = null;
  private lastMatchRecorded = false;

  /** Virtual touch input (kept in the host so the UI stays dumb). */
  readonly touchInput = {
    stick: { x: 0, y: 0, active: false },
    press: (action: string) => this.input.virtualPress(action),
    release: (action: string) => this.input.virtualRelease(action)
  };

  constructor(private root: HTMLElement, canvas: HTMLCanvasElement, opts: { headless?: boolean } = {}) {
    settings.load();
    save.load();
    gameState.force('LOADING');

    this.engine = new Engine({ canvas, headless: opts.headless });
    this.input = new Input(canvas);
    this.ui = new Ui(root, this);
    this.bindGlobalEvents();

    this.ready = this.boot();
  }

  /**
   * Headless automation surface (used by scripts/qa.ts). Never touched during
   * normal play: it only stops the rAF loop and steps the fixed simulation by
   * hand so an entire match can be played out inside Node.
   */
  readonly automation = {
    stopLoop: (): void => this.engine.stop(),
    advance: (seconds: number, step = 1 / 60): void => {
      const steps = Math.max(1, Math.round(seconds / step));
      for (let i = 0; i < steps; i++) this.engine.advance(step);
    },
    press: (action: string): void => this.input.virtualPress(action),
    release: (action: string): void => this.input.virtualRelease(action)
  };

  /** Read-only telemetry for QA and the debug console. */
  status(): GameStatus {
    const world = this.world;
    const local = world?.localPlayer ?? null;
    return {
      ready: this.booted,
      screen: this.ui.screen,
      overlay: this.ui.overlay,
      mode: this.modeKind,
      world: world
        ? {
            time: world.time,
            actors: world.actors.length,
            alive: world.actors.filter((a) => a.lifeState !== 'DEAD').length,
            loot: world.loot.items.length,
            vehicles: world.vehicles.vehicles.length,
            localHp: local ? Math.round(local.health) : 0,
            localState: local ? local.lifeState : 'NONE',
            kills: local?.kills ?? 0,
            damage: Math.round(local?.damageDealt ?? 0),
            shotsFired: local?.shotsFired ?? 0,
            shotsHit: local?.shotsHit ?? 0,
            armed: !!local?.inventory.active
          }
        : null,
      br:
        this.mode instanceof BattleRoyale
          ? {
              phase: this.mode.phase,
              alive: this.mode.aliveCount,
              placement: this.mode.placement,
              victory: this.mode.victory
            }
          : null,
      arena:
        this.mode instanceof ArenaMode
          ? {
              kind: this.mode.config.kind,
              phase: this.mode.phase,
              round: this.mode.round,
              scoreUs: this.mode.scoreUs,
              scoreThem: this.mode.scoreThem,
              matchOver: this.mode.matchOver
            }
          : null
    };
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                               */
  /* ------------------------------------------------------------------ */

  private async boot(): Promise<void> {
    this.ui.showScreen('loading');
    this.ui.setLoading(0.05, 'Loading profile…');
    await nextFrame();

    this.ui.setLoading(0.18, 'Generating island terrain…');
    await nextFrame();
    const seed = (Math.random() * 0x7fffffff) | 0;
    this.terrain = generateTerrain(seed, WORLD_SIZE, TERRAIN_RES);

    this.ui.setLoading(0.45, 'Building towns, roads and loot…');
    await nextFrame();
    this.layout = generateLayout(this.terrain, seed);

    this.ui.setLoading(0.68, 'Baking textures…');
    await nextFrame();
    precacheTextures();

    this.ui.setLoading(0.86, 'Preparing renderer…');
    await nextFrame();
    this.engine.applyQuality();
    this.cameraRigless();

    this.ui.setLoading(1, 'Ready');
    await nextFrame();
    this.input.requestPointerLock();
    this.audio.startMusic();
    this.showMainMenu();
    this.engine.onFixedUpdate((info) => this.step(info));
    this.engine.start();
    this.booted = true;
  }

  private cameraRigless(): void {
    // Menu camera: slow orbit over the island so the background is alive.
    this.engine.camera.position.set(180, 140, 180);
    this.engine.camera.lookAt(0, 20, 0);
  }

  private showMainMenu(): void {
    gameState.force('MAIN_MENU');
    this.teardownMatch();
    this.ui.hideAllOverlays();
    this.ui.showScreen('menu');
    this.audio.setMuffled(true);
  }

  /* ------------------------------------------------------------------ */
  /* UiHost                                                             */
  /* ------------------------------------------------------------------ */

  getSetup(): MatchSetup {
    return { ...this.setup, difficulty: settings.data.botDifficulty };
  }

  /** Stores setup choices without starting a match (menu segmented controls). */
  setSetup(partial: Partial<MatchSetup>): void {
    this.setup = { ...this.setup, ...partial };
  }

  startMatch(setup: MatchSetup): void {
    this.setup = { ...this.setup, ...setup, difficulty: settings.data.botDifficulty };
    this.buildMatch(this.setup);
  }

  readyUp(): void {
    this.launchMatch();
  }

  private buildMatch(setup: MatchSetup): void {
    if (!this.terrain || !this.layout || !this.booted) {
      console.warn('[Game] match requested before the island finished loading');
      return;
    }
    this.teardownMatch();
    this.setup = setup;
    this.modeKind = setup.mode;
    this.lastMatchRecorded = false;
    gameState.force('LOADING');
    this.ui.showScreen('lobby');
    this.audio.setMuffled(false);

    const hooks = this.buildHooks();
    if (setup.mode === 'BR') {
      const config: BRConfig = {
        mode: setup.teamSize === 1 ? 'BR_SOLO' : setup.teamSize === 2 ? 'BR_DUO' : 'BR_SQUAD',
        playerCount: clamp(setup.playerCount, 10, 60),
        difficulty: setup.difficulty,
        teamSize: setup.teamSize,
        seed: (Math.random() * 0x7fffffff) | 0,
        lobbySeconds: 12
      };
      const br = new BattleRoyale(this.terrain, this.layout, config, hooks);
      this.mode = br;
      this.world = br.world;
      br.startLobby(config.lobbySeconds);
      this.enterWorld();
      // The lobby (matchmaking countdown) sits on top of the live world.
      this.ui.showScreen('lobby');
      this.ui.setLobbyCountdown(config.lobbySeconds);
      return;
    } else {
      const kind = setup.mode === 'TRAINING' ? 'TRAINING' : setup.mode === 'LONE' ? 'LONE' : 'CLASH';
      const config: ArenaConfig = {
        kind,
        roundsToWin: setup.roundTarget,
        startCash: setup.startCash,
        roundSeconds: kind === 'TRAINING' ? 99999 : 120,
        buySeconds: 15,
        seed: (Math.random() * 0x7fffffff) | 0,
        difficulty: setup.difficulty,
        teamSize: kind === 'LONE' ? 1 : 4,
        dummies: setup.dummies
      };
      const arena = new ArenaMode(this.terrain, this.layout, hooks, config);
      this.mode = arena;
      this.world = arena.world;
      this.ui.showScreen('menu'); // lobby overlay is unnecessary for arenas
      this.ui.showScreen('loading');
      this.enterWorld();
      return;
    }
    this.enterWorld();
  }

  private launchMatch(): void {
    if (this.mode instanceof BattleRoyale) {
      this.mode.launch();
      this.ui.closeScreens();
      if (!this.worldRenderer) this.enterWorld();
    }
  }

  /** Builds renderers, controller, HUD and starts the actual fight. */
  private enterWorld(): void {
    if (!this.world || !this.terrain || !this.layout) return;
    this.disposeView();
    this.ui.clearMatchUi();
    this.ui.closeScreens();

    const scene = this.engine.scene;
    this.worldRenderer = new WorldRenderer(scene, this.terrain, this.layout);
    this.actorRenderer = new ActorRenderer(scene);
    this.effects = new CombatEffects(scene);
    this.cameraRig = new CameraRig(this.engine.camera, this.world);
    this.controller = new PlayerController(this.input, this.world, {
      onToggleInventory: () => this.toggleInventory(),
      onToggleMap: () => this.toggleMap(),
      onScoreboard: (visible) => this.ui.toggleOverlay('scoreboard', visible),
      onSpectate: (dir) => this.cycleSpectate(dir)
    }, () => this.ui.isBlocking() || this.paused);
    this.controller.reset(this.world.localPlayer);

    this.ui.buildMatchOverlays(this.world);
    this.hud = this.ui.createHud(this.world);
    this.hud.attachCamera(this.engine.camera);
    this.network = new NetworkSession(this.world, new LocalTransport(), false);
    this.worldRenderer.buildVehicles(this.world.vehicles.vehicles.map((v) => ({
      id: v.id, type: v.type, x: v.x, y: v.y, z: v.z, yaw: v.yaw, colorIndex: v.id % 6
    })));

    const local = this.world.localPlayer;
    if (local) {
      this.engine.camera.position.set(local.position.x, local.position.y + 3, local.position.z + 6);
      if (this.mode instanceof BattleRoyale && this.mode.phase !== 'AIRCRAFT' && this.mode.phase !== 'COUNTDOWN') {
        gameState.force('PLAYING');
      }
    }
    this.audio.stopMusic();
  }

  getClashState(): { active: boolean; cash: number; round: number; scoreUs: number; scoreThem: number } | null {
    if (!(this.mode instanceof ArenaMode)) return null;
    if (this.mode.config.kind === 'TRAINING') return null;
    return {
      active: true,
      cash: this.mode.cash,
      round: this.mode.round,
      scoreUs: this.mode.scoreUs,
      scoreThem: this.mode.scoreThem
    };
  }

  buyItem(id: string, price: number, kind: string): boolean {
    if (!(this.mode instanceof ArenaMode) || !this.world) return false;
    const actor = this.world.localPlayer;
    if (!actor) return false;
    const ok = this.mode.purchase(actor, id, kind, price);
    if (ok) {
      this.ui.refreshBuyMenu(this.mode.cash, this.mode.phaseTimer, this.mode.round);
      this.ui.refreshInventory(this.world);
    }
    return ok;
  }

  startRoundNow(): void {
    if (this.mode instanceof ArenaMode && this.mode.phase === 'BUY') {
      this.mode.beginRound();
      this.ui.toggleOverlay('buy', false);
      this.ui.toggleOverlay('round', false);
      gameState.force('PLAYING');
    }
  }

  continueRound(): void {
    this.ui.toggleOverlay('round', false);
    if (this.mode instanceof ArenaMode) {
      if (this.mode.matchOver) this.finishArena();
      else gameState.force('PLAYING');
    }
  }

  resume(): void {
    this.paused = false;
    this.ui.toggleOverlay('pause', false);
    this.input.requestPointerLock();
  }

  leaveMatch(): void {
    this.audio.startMusic();
    this.showMainMenu();
  }

  playAgain(): void {
    const setup = { ...this.setup };
    this.showMainMenu();
    window.setTimeout(() => this.buildMatch(setup), 30);
  }

  toMainMenu(): void {
    this.showMainMenu();
  }

  onSettingsChanged(): void {
    this.engine.applyQuality();
    this.audio.applyVolumes();
    if (this.world) this.world.autoPickupEnabledFlag(settings.data.autoPickup);
  }

  dropWeapon(slot: number): void {
    if (!this.world) return;
    const actor = this.world.localPlayer;
    if (!actor) return;
    const w = actor.inventory.dropWeapon(slot);
    if (w) {
      this.world.loot.dropNear(actor.position.x, actor.position.y + 0.3, actor.position.z, w.defId, w.rarity, 1, 'WEAPON');
      this.ui.refreshInventory(this.world);
      bus.emit('ui:toast', { text: 'Weapon dropped', kind: 'info' });
    }
  }

  setCallsign(name: string): void {
    save.setName(name);
  }

  isTouch(): boolean {
    return this.input.isTouch;
  }

  /* ------------------------------------------------------------------ */
  /* Hooks                                                              */
  /* ------------------------------------------------------------------ */

  private buildHooks(): CombatHooks {
    return {
      onImpact: (x, y, z, nx, ny, nz, surface, isLocal) => {
        this.effects?.impact(x, y, z, nx, ny, nz, surface, isLocal);
        this.audio.impact(surface, isLocal, x, y, z);
      },
      onActorHit: (actor, damage, _part, weaponId, isLocal, killed, headshot) => {
        this.effects?.bloodBurst(
          actor.position.x, actor.position.y + actor.bodyHeight * 0.6, actor.position.z,
          0, 0.2, 0, headshot ? 1.5 : 1
        );
        this.actorRenderer?.flinch(actor.id, headshot ? 1.4 : 1);
        this.audio.actorHit(isLocal);
        if (isLocal) {
          this.hud?.spawnDamageNumber(
            actor.position.x, actor.position.y + actor.bodyHeight, actor.position.z,
            damage, headshot ? 'head' : 'out'
          );
        } else {
          const local = this.world?.localPlayer;
          if (local && this.hud) {
            this.hud.spawnDamageNumber(
              local.position.x, local.position.y + local.bodyHeight, local.position.z,
              damage, 'in'
            );
          }
        }
        void weaponId;
        void killed;
      },
      onExplosion: (ev) => {
        this.effects?.explosion(ev);
        this.audio.explosion(ev.x, ev.y, ev.z);
        const cam = this.engine.camera.position;
        const d = Math.hypot(ev.x - cam.x, ev.y - cam.y, ev.z - cam.z);
        if (d < ev.radius * 3) this.cameraRig?.addShake(clamp(1.4 - d / (ev.radius * 3), 0, 1.2));

      },
      onTracer: (x0, y0, z0, x1, y1, z1, isLocal) => {
        this.effects?.tracer(x0, y0, z0, x1, y1, z1, isLocal);
      },
      onWeaponSound: (actor, weaponId, suppressed, isLocal) => {
        this.audio.gunshot(actor, weaponId, suppressed, isLocal);
      },
      onMuzzleFlash: (actor, origin, dir, weaponId) => {
        this.effects?.muzzleFlash(actor, origin, dir, weaponId);
      },
      onShellEject: (actor) => this.effects?.shellEject(actor),
      onDryFire: () => this.audio.click(0.8),
      onHealStart: () => this.audio.play('revive', 0.6),
      onReviveStart: () => this.audio.play('revive'),
      onVehicleEvent: (kind) => {
        if (kind === 'crash') this.audio.play('crash', 0.8);
        else this.audio.play('vehicle', 0.7);
      }
    };
  }

  /* ------------------------------------------------------------------ */
  /* Frame loop                                                         */
  /* ------------------------------------------------------------------ */

  private step(info: FrameInfo): void {
    if (this.disposed) return;
    const dt = info.dt;

    if (!this.world || !this.mode) {
      this.menuCameraUpdate(info.elapsed);
      this.input.endFrame();
      return;
    }

    // Pause handling
    if (this.input.keyPressed('Escape')) {
      if (this.paused) this.resume();
      else this.setPaused(true);
    }
    if (this.paused) {
      this.input.endFrame();
      return;
    }

    this.controller?.updateLook();
    this.controller?.step(dt);
    const playerInput = this.controller ? this.controller.input : null;

    if (this.mode instanceof BattleRoyale) {
      if (this.input.wasPressed('jump') && this.mode.phase === 'AIRCRAFT') {
        this.mode.requestJump();
      }
      this.mode.update(dt, playerInput);
      this.syncBrState();
    } else {
      this.mode.update(dt, playerInput);
      this.syncArenaState();
    }

    // Escalating shot reporting to a (future) server.
    const local = this.world.localPlayer;
    this.network?.update(dt, local);

    // Render-side systems
    const camera = this.engine.camera;
    const spectator = this.spectatorTarget();
    if (this.world.localPlayer && this.world.localPlayer.lifeState !== 'DEAD') {
      this.cameraRig?.update(dt, this.world.localPlayer, this.controller?.yaw ?? 0, this.controller?.pitch ?? 0);
    } else if (spectator) {
      this.cameraRig?.updateSpectator(
        dt, spectator,
        this.controller?.yaw ?? 0, this.controller?.pitch ?? 0,
        this.input.moveAxes()
      );
    }
    camera.updateMatrixWorld();

    this.actorRenderer?.sync(this.world.actors, dt, camera.position, this.world.localPlayer ?? null);
    this.effects?.update(dt, camera.position);
    this.worldRenderer?.update(dt, camera.position, this.world.loot.items);
    this.worldRenderer?.updateVehicles(this.world.vehicles.vehicles, camera.position);
    this.audio.setListener(camera.position.x, camera.position.y, camera.position.z);

    this.updateHud(dt, spectator);
    this.updateFps();
    this.input.endFrame();
  }

  private menuCameraUpdate(elapsed: number): void {
    const radius = 420;
    const angle = elapsed * 0.03;
    this.engine.camera.position.set(Math.cos(angle) * radius, 150, Math.sin(angle) * radius);
    this.engine.camera.lookAt(0, 30, 0);
  }

  private setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.ui.refreshPause();
      this.ui.toggleOverlay('pause', true);
      this.input.exitPointerLock();
    } else {
      this.ui.toggleOverlay('pause', false);
      this.input.requestPointerLock();
    }
  }

  private toggleInventory(): void {
    if (!this.world) return;
    if (this.ui.overlay === 'inventory') {
      this.ui.toggleOverlay('inventory', false);
      this.input.requestPointerLock();
      return;
    }
    this.ui.refreshInventory(this.world);
    this.ui.toggleOverlay('inventory', true);
    this.input.exitPointerLock();
  }

  private toggleMap(): void {
    if (!this.world) return;
    if (this.ui.overlay === 'map') {
      this.ui.toggleOverlay('map', false);
      this.input.requestPointerLock();
      return;
    }
    this.ui.toggleOverlay('map', true);
    this.input.exitPointerLock();
  }

  private spectatorTarget(): import('../entity/Actor').Actor | null {
    if (!this.world) return null;
    const local = this.world.localPlayer;
    if (!local || local.lifeState !== 'DEAD') return null;
    const alive = this.world.actors.filter((a) => a.lifeState !== 'DEAD');
    if (alive.length === 0) return null;
    const index = ((this.controller?.spectateIndex ?? 0) % alive.length + alive.length) % alive.length;
    return alive[index];
  }

  private cycleSpectate(dir: number): void {
    if (!this.world) return;
    const alive = this.world.actors.filter((a) => a.lifeState !== 'DEAD');
    if (alive.length === 0) return;
    const next = (((this.controller?.spectateIndex ?? 0) + dir) % alive.length + alive.length) % alive.length;
    if (this.controller) this.controller.spectateIndex = next;
    const target = alive[next];
    bus.emit('spectate:target', { id: target.id, name: target.name });
  }

  private syncBrState(): void {
    const br = this.mode as BattleRoyale;
    if (br.phase === 'LOBBY' || br.phase === 'COUNTDOWN') {
      this.ui.setLobbyCountdown(br.countdown);
      return;
    }
    if (this.ui.screen === 'lobby') this.ui.closeScreens();
    const zone = br.zone;
    this.hud?.setZone(zone.phase, zone.radius, Math.max(0, zone.timeLeft), zone.shrinking);
    this.hud?.setAlive(br.aliveCount, br.playerCount);

    // State machine mirrors the match phase so UI can react.
    switch (br.phase) {
      case 'AIRCRAFT':
        if (gameState.is('PLAYING', 'SKYDIVING', 'PARACHUTING', 'DEAD', 'SPECTATING')) gameState.force('AIRCRAFT');
        break;
      case 'SKYDIVE':
        if (!gameState.is('SKYDIVING', 'DEAD')) gameState.force('SKYDIVING');
        break;
      case 'PARACHUTE':
        if (!gameState.is('PARACHUTING', 'DEAD')) gameState.force('PARACHUTING');
        break;
      case 'GROUND':
        if (!gameState.is('PLAYING', 'DEAD', 'SPECTATING')) gameState.force('PLAYING');
        break;
      case 'ENDED':
        this.finishBattleRoyale();
        break;
      default:
        break;
    }
    const local = this.world?.localPlayer;
    if (local && local.lifeState === 'DEAD' && gameState.is('PLAYING', 'SKYDIVING', 'PARACHUTING')) {
      gameState.force('SPECTATING');
    }
  }

  private syncArenaState(): void {
    const arena = this.mode as ArenaMode;
    if (arena.config.kind === 'TRAINING') return;
    const inBuy = arena.phase === 'BUY';
    if (inBuy && this.ui.overlay !== 'buy') {
      this.ui.refreshBuyMenu(arena.cash, arena.phaseTimer, arena.round);
      this.ui.toggleOverlay('buy', true);
    } else if (inBuy) {
      this.ui.updateBuyTimer(arena.phaseTimer);
    } else if (this.ui.overlay === 'buy') {
      this.ui.toggleOverlay('buy', false);
    }
    if (arena.phase === 'ROUND_END' && this.ui.overlay !== 'round') {
      this.ui.showRoundBanner(arena.round, arena.scoreUs, arena.scoreThem, arena.roundWinner === 0);
    }
    if (arena.phase === 'COUNTDOWN') {
      this.hud?.setZone(0, 0, arena.phaseTimer, false);
    }
  }

  private finishArena(): void {
    const arena = this.mode as ArenaMode;
    this.recordAndShowResults({
      victory: arena.playerVictory,
      placement: arena.playerVictory ? 1 : 2,
      kills: arena.kills,
      damage: arena.damage,
      survivalTime: this.world?.time ?? 0
    });
  }

  private finishBattleRoyale(): void {
    const br = this.mode as BattleRoyale;
    this.recordAndShowResults({
      victory: br.victory,
      placement: br.placement || Math.max(1, br.aliveCount),
      kills: this.world?.localPlayer?.kills ?? 0,
      damage: this.world?.localPlayer?.damageDealt ?? 0,
      survivalTime: this.world?.localPlayer?.survivalTime ?? 0
    });
  }

  private recordAndShowResults(result: {
    victory: boolean;
    placement: number;
    kills: number;
    damage: number;
    survivalTime: number;
  }): void {
    if (this.lastMatchRecorded) return;
    this.lastMatchRecorded = true;
    const local = this.world?.localPlayer;
    const modeName = this.modeKind === 'BR' ? 'Battle Royale' : this.modeKind === 'CLASH' ? 'Clash Squad' : this.modeKind === 'LONE' ? 'Lone Wolf' : 'Training';
    const record = {
      mode: modeName,
      placement: result.placement,
      kills: result.kills,
      damage: result.damage,
      survivalTime: result.survivalTime,
      victory: result.victory,
      timestamp: Date.now(),
      xp: 0
    };
    const rewards = save.recordMatch(record);
    const accuracy = local && local.shotsFired > 0 ? (local.shotsHit / local.shotsFired) * 100 : 0;
    gameState.force(result.victory ? 'VICTORY' : 'DEFEAT');
    this.ui.hideAllOverlays();
    this.ui.destroyHud();
    this.hud = null;
    this.input.exitPointerLock();
    this.audio.startMusic();
    this.ui.showResults({
      victory: result.victory,
      placement: result.placement,
      kills: result.kills,
      damage: result.damage,
      headshots: local?.headshotKills ?? 0,
      survivalTime: result.survivalTime,
      accuracy,
      revives: local?.revives ?? 0,
      xp: rewards.xp,
      coins: rewards.coins,
      level: save.profile.level,
      unlocked: rewards.unlocked,
      mode: modeName
    });
    gameState.force('RESULTS');
  }

  private updateHud(dt: number, spectator: import('../entity/Actor').Actor | null): void {
    if (!this.hud || !this.world) return;
    this.hud.update(dt, spectator, { paused: this.paused });
    if (this.controller) {
      const prompt = this.controller.promptText();
      this.hud.setPrompt(spectator ? null : prompt);
      if (spectator) {
        const alive = this.world.actors.filter((a) => a.lifeState !== 'DEAD');
        const idx = clamp(this.controller.spectateIndex, 0, Math.max(0, alive.length - 1));
        this.hud.showSpectateTarget(spectator.name, idx, alive.length, spectator.isLocal);
      }
    }
  }

  private updateFps(): void {
    if (!settings.data.showFps) {
      if (this.fpsEl) {
        this.fpsEl.remove();
        this.fpsEl = null;
      }
      return;
    }
    if (!this.fpsEl) {
      this.fpsEl = document.createElement('div');
      this.fpsEl.className = 'fps-pill';
      this.root.appendChild(this.fpsEl);
    }
    const info = this.engine.getInfo();
    this.fpsEl.textContent = `${info.fps.toFixed(0)} fps · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris · scale ${(info.renderScale * 100).toFixed(0)}%`;
  }

  /* ------------------------------------------------------------------ */
  /* Global events                                                      */
  /* ------------------------------------------------------------------ */

  private bindGlobalEvents(): void {
    const unlock = (): void => {
      this.audio.unlock();
      this.audio.applyVolumes();
      if (!this.world || gameState.is('MAIN_MENU', 'MATCHMAKING', 'LOBBY')) this.audio.startMusic();
    };
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });

    bus.on('killfeed', (e) => {
      if (e.isLocalKiller) {
        this.audio.hitmarker(true, true);
        this.showKillBanner(`${e.victim} eliminated`);
      }
      this.audio.hitmarker(false, false);
    });
    bus.on('vehicle:destroyed', () => this.audio.play('crash'));
    bus.on('match:ended', () => {
      if (this.mode instanceof BattleRoyale) this.finishBattleRoyale();
      else if (this.mode instanceof ArenaMode) this.finishArena();
    });
    bus.on('loot:pickup', () => this.audio.pickup());
  }

  private showKillBanner(text: string): void {
    const el = document.createElement('div');
    el.className = 'kill-banner show';
    el.textContent = text;
    this.root.appendChild(el);
    window.setTimeout(() => el.classList.remove('show'), 1300);
    window.setTimeout(() => el.remove(), 1700);
  }

  /* ------------------------------------------------------------------ */
  /* Teardown                                                           */
  /* ------------------------------------------------------------------ */

  /** Drops everything that draws or drives the current match (keep the world). */
  private disposeView(): void {
    this.ui.clearMatchUi();
    this.hud = null;
    this.network?.dispose();
    this.network = null;
    this.worldRenderer?.dispose();
    this.worldRenderer = null;
    this.actorRenderer?.dispose();
    this.actorRenderer = null;
    this.effects?.dispose();
    this.effects = null;
    this.controller = null;
    this.cameraRig = null;
  }

  private teardownMatch(): void {
    this.disposeView();
    this.mode?.world.dispose();
    this.mode = null;
    this.world = null;
    this.paused = false;
  }

  dispose(): void {
    this.disposed = true;
    this.teardownMatch();
    this.audio.dispose();
    this.input.dispose();
    this.engine.dispose();
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else window.setTimeout(resolve, 0);
  });
}

export { CombatWorld, settings, save };
