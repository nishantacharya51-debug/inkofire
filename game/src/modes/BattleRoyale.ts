import * as THREE from 'three';
import { CombatWorld, emptyHooks, type CombatHooks } from './CombatWorld';
import { ZoneSystem } from '../zone/ZoneSystem';
import type { Actor } from '../entity/Actor';
import type { MapLayout } from '../world/MapLayout';
import type { TerrainData } from '../world/Terrain';
import type { ControllerInput } from '../player/Locomotion';
import { sampleHeight } from '../world/Terrain';
import { RNG } from '../utils/rng';
import { bus } from '../core/EventBus';
import { clamp, wrapAngle } from '../utils/mathx';
import type { DifficultyName } from '../ai/BotBrain';

export type BRPhase = 'LOBBY' | 'COUNTDOWN' | 'AIRCRAFT' | 'SKYDIVE' | 'PARACHUTE' | 'GROUND' | 'ENDED';

export interface BRConfig {
  mode: 'BR_SOLO' | 'BR_DUO' | 'BR_SQUAD';
  playerCount: number;
  difficulty: DifficultyName;
  teamSize: number;
  seed: number;
  /** Elapsed seconds of the lobby countdown before the plane launches. */
  lobbySeconds: number;
}

export interface AircraftState {
  x: number;
  y: number;
  z: number;
  dirX: number;
  dirZ: number;
  speed: number;
  progress: number;
  startX: number;
  startZ: number;
  endX: number;
  endZ: number;
}

const BOT_NAMES = [
  'Kestrel', 'Vantablack', 'Ironhide', 'Sable', 'Quartz', 'Nomad', 'Halcyon', 'Rook', 'Cinder', 'Vega',
  'Meridian', 'Onyx', 'Talon', 'Zenith', 'Bramble', 'Kite', 'Static', 'Wraith', 'Pallas', 'Juno',
  'Corvid', 'Drifter', 'Echo', 'Fable', 'Grit', 'Harrow', 'Indigo', 'Jasper', 'Kelvin', 'Lark',
  'Mica', 'Nimbus', 'Orion', 'Pyre', 'Quill', 'Rift', 'Slate', 'Thorn', 'Umber', 'Vortex',
  'Wisp', 'Xenon', 'Yarrow', 'Zephyr', 'Ash', 'Basalt', 'Cygnus', 'Dune', 'Ember', 'Flint'
];

const BOT_TITLES = ['', '_77', '.exe', '-01', 'X', '_Prime', '-II', '.gg', '_Ace', '_V'];

/**
 * Complete Battle Royale match: aircraft deployment, skydiving, parachutes,
 * landing, shrinking zone, looting, combat and win/lose resolution.
 */
export class BattleRoyale {
  world: CombatWorld;
  zone: ZoneSystem;
  phase: BRPhase = 'LOBBY';
  aircraft: AircraftState;
  playerCount: number;
  aliveCount: number;
  teamCount: number;
  matchTime = 0;
  countdown = 0;
  placement = 0;
  victory = false;
  ended = false;
  playerJumped = false;
  canJump = false;
  /** Statistics for the results screen. */
  firstBloodTime = -1;

  private rng: RNG;
  private config: BRConfig;
  private botJumpPlan: { id: number; jumpAt: number; landing: { x: number; z: number } }[] = [];
  private zoneTicker = 0;
  private endCheckTicker = 0;

  constructor(
    terrain: TerrainData,
    layout: MapLayout,
    config: BRConfig,
    hooks: CombatHooks = emptyHooks(),
    private onLanded?: (actor: Actor) => void
  ) {
    this.config = config;
    this.rng = new RNG(config.seed);
    this.world = new CombatWorld(terrain, layout, hooks, config.seed);
    this.zone = new ZoneSystem(terrain.size, this.rng);
    this.world.zoneSource = this.zone;
    this.world.squadRules = config.mode !== 'BR_SOLO';
    this.playerCount = clamp(config.playerCount, 2, 60);
    this.aliveCount = this.playerCount;
    this.teamCount = Math.ceil(this.playerCount / config.teamSize);

    // Aircraft flies a straight line between two random map edges.
    const edgePad = terrain.half * 0.92;
    const angle = this.rng.range(0, Math.PI * 2);
    const startX = Math.cos(angle) * edgePad;
    const startZ = Math.sin(angle) * edgePad;
    const endX = -startX * 0.85 + (this.rng.next() - 0.5) * 300;
    const endZ = -startZ * 0.85 + (this.rng.next() - 0.5) * 300;
    const len = Math.hypot(endX - startX, endZ - startZ) || 1;
    this.aircraft = {
      x: startX, y: 430, z: startZ,
      dirX: (endX - startX) / len, dirZ: (endZ - startZ) / len,
      speed: 92, progress: 0, startX, startZ, endX, endZ
    };

    this.spawnActors(layout);
    this.zone.reset();
    bus.emit('match:started', { mode: config.mode, players: this.playerCount });
  }

  private spawnActors(layout: MapLayout): void {
    const zones = layout.botLandingZones;
    const names = [...BOT_NAMES];
    this.rng.shuffle(names);
    const teams = Math.max(1, Math.ceil(this.playerCount / this.config.teamSize));

    // Local player is team 0 (slot 0); teammates (in squad modes) share team 0.
    for (let i = 0; i < this.playerCount; i++) {
      const isLocal = i === 0;
      const team = Math.floor(i / this.config.teamSize);
      let x: number;
      let z: number;
      if (isLocal || team === 0) {
        // Player team starts aboard the aircraft; position updated each frame.
        x = this.aircraft.x;
        z = this.aircraft.z;
      } else {
        const zone = zones[this.rng.int(0, zones.length - 1)] ?? { x: 0, z: 0, y: 0, poi: 'Open' };
        const ang = this.rng.range(0, Math.PI * 2);
        const rad = this.rng.range(0, 60);
        x = zone.x + Math.cos(ang) * rad;
        z = zone.z + Math.sin(ang) * rad;
      }
      const name = isLocal ? 'You' : `${names[i % names.length]}${BOT_TITLES[this.rng.int(0, BOT_TITLES.length - 1)]}`;
      const actor = this.world.spawnActor({
        x, z,
        y: this.aircraft.y,
        yaw: this.rng.range(0, Math.PI * 2),
        name,
        team,
        isBot: !isLocal,
        isLocal,
        difficulty: this.config.difficulty
      });
      actor.moveState = 'AIRCRAFT';
      if (!isLocal) {
        // Bots plan staggered jumps spread across the real flight duration so
        // they spread along the whole flight path (never pile onto one spot).
        const flightSeconds = this.flightDuration;
        const jumpAt = this.rng.range(flightSeconds * 0.06, flightSeconds * 0.9);
        const t = clamp(jumpAt / flightSeconds, 0, 1);
        const px = this.aircraft.startX + (this.aircraft.endX - this.aircraft.startX) * t;
        const pz = this.aircraft.startZ + (this.aircraft.endZ - this.aircraft.startZ) * t;
        const spot = this.world.nav.nearestWalkable(
          px + this.rng.range(-120, 120),
          pz + this.rng.range(-120, 120),
          10
        );
        this.botJumpPlan.push({
          id: actor.id,
          jumpAt,
          landing: spot ?? { x: px, z: pz }
        });
      }
    }
    void teams;
  }

  get localPlayer(): Actor | null {
    return this.world.localPlayer;
  }

  get aliveTeams(): number {
    const teams = new Set<number>();
    for (const a of this.world.actors) {
      if (a.lifeState === 'DEAD') continue;
      teams.add(a.team);
    }
    return teams.size;
  }

  /* ---------------------------------------------------------------- */
  /* Phase control                                                     */
  /* ---------------------------------------------------------------- */

  startLobby(seconds: number): void {
    this.phase = 'COUNTDOWN';
    this.countdown = seconds;
  }

  launch(): void {
    if (this.phase !== 'COUNTDOWN' && this.phase !== 'LOBBY') return;
    this.phase = 'AIRCRAFT';
    this.aircraft.progress = 0;
    this.canJump = true;
    for (const actor of this.world.actors) {
      actor.position.set(this.aircraft.x, this.aircraft.y, this.aircraft.z);
      actor.velocity.set(0, 0, 0);
      actor.moveState = 'AIRCRAFT';
      actor.hasJumped = false;
      actor.onGround = false;
    }
    for (const plan of this.botJumpPlan) plan.jumpAt = Math.max(0.5, plan.jumpAt);
  }

  /** Player presses jump during the aircraft phase. */
  requestJump(): boolean {
    if (this.phase !== 'AIRCRAFT') return false;
    const p = this.localPlayer;
    if (!p) return false;
    this.playerJumped = true;
    this.phase = 'SKYDIVE';
    bus.emit('player:jumped', {});
    this.jumpActor(p);
    // Bots that planned to jump around this point go too.
    return true;
  }

  private jumpActor(actor: Actor): void {
    actor.hasJumped = true;
    actor.position.set(this.aircraft.x, this.aircraft.y - 2, this.aircraft.z);
    // Carry the aircraft's momentum into the dive.
    actor.velocity.set(this.aircraft.dirX * this.aircraft.speed, -6, this.aircraft.dirZ * this.aircraft.speed);
    actor.moveState = 'SKYDIVE';
    actor.onGround = false;
    actor.parachuteOpen = false;
    actor.deployAltitude = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Main update                                                       */
  /* ---------------------------------------------------------------- */

  update(dt: number, playerInput: ControllerInput | null): void {
    if (this.ended) {
      // Keep the world ticking briefly for ragdolls/spectating.
      this.world.setPlayerInput(null);
      this.world.update(dt);
      return;
    }
    this.matchTime += dt;

    switch (this.phase) {
      case 'COUNTDOWN':
        this.countdown -= dt;
        if (this.countdown <= 0) this.launch();
        break;
      case 'AIRCRAFT':
        break;
      case 'SKYDIVE':
      case 'PARACHUTE':
      case 'GROUND':
      default:
        break;
    }

    // The transport keeps flying after the player jumps so bots can bail out
    // along the rest of the path.
    if (this.aircraft.progress < 1) this.updateAircraft(dt);
    this.updateAboardActors(dt);
    this.autoBailBots();

    // Airborne physics (freefall + parachutes) — only once the actor has jumped.
    for (const actor of this.world.actors) {
      if (!actor.hasJumped) continue;
      if (actor.moveState === 'SKYDIVE' || actor.moveState === 'PARACHUTE') {
        this.updateAirborne(actor, dt, actor.isLocal ? playerInput : null);
      }
    }

    // Ground actors get normal input
    this.world.setPlayerInput(playerInput);
    this.world.update(dt);

    // Zone
    this.zoneTicker += dt;
    if (this.zoneTicker >= dt) {
      this.zoneTicker = 0;
      this.zone.update(dt, this.world.actors, this.world.time);
    }

    // Squad revive support: downed bots bleed out slower if a mate is close.
    this.endCheckTicker += dt;
    if (this.endCheckTicker > 0.35) {
      this.endCheckTicker = 0;
      this.updateMatchState();
    }

    // Track the current BR phase from the local player's state.
    const p = this.localPlayer;
    if (p && p.hasJumped) {
      if (p.lifeState === 'DEAD' && this.phase !== 'ENDED') {
        // The player is out; the match continues so they can spectate.
        this.placement = Math.max(this.placement, this.aliveCount + 1);
      }
      if (p.moveState === 'SKYDIVE' && this.phase === 'AIRCRAFT') this.phase = 'SKYDIVE';
      if (p.moveState === 'PARACHUTE') this.phase = 'PARACHUTE';
      if (p.moveState !== 'SKYDIVE' && p.moveState !== 'PARACHUTE' && p.moveState !== 'AIRCRAFT'
        && (this.phase === 'SKYDIVE' || this.phase === 'PARACHUTE')) {
        this.phase = 'GROUND';
      }
    }
  }

  private updateAircraft(dt: number): void {
    const a = this.aircraft;
    const dist = Math.hypot(a.endX - a.startX, a.endZ - a.startZ);
    a.x += a.dirX * a.speed * dt;
    a.z += a.dirZ * a.speed * dt;
    a.progress = clamp(Math.hypot(a.x - a.startX, a.z - a.startZ) / (dist || 1), 0, 1);

    // Auto-eject the player near the end of the flight path.
    if (this.phase === 'AIRCRAFT') {
      if (!this.playerJumped && a.progress > 0.86) this.requestJump();
      if (a.progress >= 1) this.requestJump();
    }
  }

  /** Bots scheduled to jump do so even after the player has already left. */
  private autoBailBots(): void {
    for (const plan of this.botJumpPlan) {
      if (plan.jumpAt <= 0) continue;
      if (this.matchTime < plan.jumpAt) continue;
      plan.jumpAt = 0;
      const actor = this.world.actors.find((x) => x.id === plan.id);
      if (!actor || actor.hasJumped || actor.lifeState === 'DEAD') continue;
      this.jumpActor(actor);
      const brain = this.world.brains.get(actor.id);
      if (brain) {
        brain.landingTarget = plan.landing;
        brain.onLanded();
      }
    }
  }

  /** Time the aircraft needs to cross the island (seconds). */
  get flightDuration(): number {
    const dist = Math.hypot(this.aircraft.endX - this.aircraft.startX, this.aircraft.endZ - this.aircraft.startZ);
    return dist / this.aircraft.speed;
  }

  private updateAboardActors(dt: number): void {
    if (this.phase !== 'AIRCRAFT') return;
    for (const actor of this.world.actors) {
      if (actor.moveState !== 'AIRCRAFT' || actor.hasJumped) continue;
      actor.position.set(this.aircraft.x, this.aircraft.y, this.aircraft.z);
      actor.velocity.set(0, 0, 0);
      void dt;
    }
  }

  /**
   * Skydiving + parachute physics.
   * Freefall: fast gravity, high terminal velocity when diving, limited steering.
   * Parachute: slow descent with forward glide and flaring.
   */
  private updateAirborne(actor: Actor, dt: number, input: ControllerInput | null): void {
    const isChute = actor.moveState === 'PARACHUTE';
    const groundY = sampleHeight(this.world.terrain, actor.position.x, actor.position.z);
    const altitude = actor.position.y - groundY;

    if (!input && actor.isBot) {
      // Bots steer via their brain (already produced input in CombatWorld.update).
      input = this.localInputForBot(actor);
    }

    if (!isChute) {
      // ---- Freefall ----
      const dive = input && input.moveY > 0.35;
      const glide = input && input.moveY < -0.35;
      const terminal = dive ? 92 : glide ? 42 : 62;
      const accel = 34;
      actor.velocity.y = Math.max(actor.velocity.y - accel * dt, -terminal);
      // Steering authority: better when diving forward (belly-to-earth)
      const authority = dive ? 26 : 18;
      if (input) {
        const wantX = (-Math.sin(input.lookYaw) * input.moveY + Math.cos(input.lookYaw) * input.moveX);
        const wantZ = (-Math.cos(input.lookYaw) * input.moveY - Math.sin(input.lookYaw) * input.moveX);
        actor.velocity.x += (wantX * authority - actor.velocity.x) * Math.min(1, dt * 1.5);
        actor.velocity.z += (wantZ * authority - actor.velocity.z) * Math.min(1, dt * 1.5);
        actor.yaw = input.lookYaw;
        actor.pitch = clamp(input.lookPitch, -1.2, 1.2);
      } else {
        actor.velocity.x *= 1 - Math.min(1, dt * 0.6);
        actor.velocity.z *= 1 - Math.min(1, dt * 0.6);
      }
      // Auto-deploy at a safe height
      const autoDeploy = 165;
      if (altitude <= autoDeploy || actor.deployChuteRequest) {
        this.deployParachute(actor);
      }
    } else {
      // ---- Under canopy ----
      const flare = input && input.crouch;
      const descent = flare ? 5.0 : 11.5;
      actor.velocity.y += (-descent - actor.velocity.y) * Math.min(1, dt * 3);
      const glideSpeed = flare ? 6 : 22;
      if (input) {
        const wantX = -Math.sin(input.lookYaw) * input.moveY + Math.cos(input.lookYaw) * input.moveX;
        const wantZ = -Math.cos(input.lookYaw) * input.moveY - Math.sin(input.lookYaw) * input.moveX;
        actor.velocity.x += (wantX * glideSpeed - actor.velocity.x) * Math.min(1, dt * 2.2);
        actor.velocity.z += (wantZ * glideSpeed - actor.velocity.z) * Math.min(1, dt * 2.2);
        actor.yaw = input.lookYaw;
      } else {
        actor.velocity.x *= 1 - Math.min(1, dt * 0.8);
        actor.velocity.z *= 1 - Math.min(1, dt * 0.8);
      }
    }

    actor.position.x += actor.velocity.x * dt;
    actor.position.y += actor.velocity.y * dt;
    actor.position.z += actor.velocity.z * dt;

    // Keep flyers inside the map
    const half = this.world.terrain.half - 6;
    actor.position.x = clamp(actor.position.x, -half, half);
    actor.position.z = clamp(actor.position.z, -half, half);

    // Landing
    if (actor.position.y <= groundY + 0.02) {
      actor.position.y = groundY;
      const impact = -actor.velocity.y;
      actor.velocity.set(0, 0, 0);
      actor.onGround = true;
      actor.parachuteOpen = false;
      actor.moveState = 'LAND';
      actor.landingImpact = impact;
      // Hard landings hurt (freefall without a chute is lethal).
      if (!isChute && impact > 30) {
        actor.applyDamage(120, 'TORSO', null, 'fall', this.world.time);
      } else if (isChute && impact > 12) {
        actor.applyDamage(Math.max(0, impact - 12) * 1.6, 'LEG', null, 'fall', this.world.time);
      }
      // Landing in deep water = swim
      const depth = this.world.terrain.waterLevel - groundY;
      if (depth > 1.6) actor.moveState = 'SWIM';
      else actor.moveState = 'IDLE';

      const brain = this.world.brains.get(actor.id);
      if (brain) {
        brain.onLanded();
        brain.landingTarget = null;
      }
      if (actor.isLocal) {
        this.phase = 'GROUND';
        bus.emit('player:landed', {});
        this.onLanded?.(actor);
      }
    }
  }

  private localInputForBot(actor: Actor): ControllerInput | null {
    const brain = this.world.brains.get(actor.id);
    return brain ? brain.input : null;
  }

  deployParachute(actor: Actor): void {
    if (actor.moveState === 'PARACHUTE') return;
    actor.moveState = 'PARACHUTE';
    actor.parachuteOpen = true;
    // Bleed off dive speed when the canopy opens.
    actor.velocity.y = Math.max(actor.velocity.y, -9);
    actor.velocity.x *= 0.55;
    actor.velocity.z *= 0.55;
    if (actor.isLocal) {
      this.phase = 'PARACHUTE';
      bus.emit('parachute:deployed', {});
    }
  }

  /** Player-triggered parachute deploy (Space during freefall). */
  requestParachute(): boolean {
    const p = this.localPlayer;
    if (!p || p.moveState !== 'SKYDIVE') return false;
    this.deployParachute(p);
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Match state                                                       */
  /* ---------------------------------------------------------------- */

  private updateMatchState(): void {
    let alive = 0;
    const teamSet = new Set<number>();
    for (const a of this.world.actors) {
      if (a.lifeState === 'DEAD') continue;
      alive++;
      teamSet.add(a.team);
    }
    this.aliveCount = alive;
    this.teamCount = teamSet.size;

    if (this.firstBloodTime < 0) {
      const dead = this.world.actors.filter((a) => a.lifeState === 'DEAD').length;
      if (dead > 0) this.firstBloodTime = this.matchTime;
    }

    const local = this.localPlayer;
    if (this.ended) return;

    // Victory: last team standing (or last player in solo).
    const teamsToWin = this.config.mode === 'BR_SOLO' ? 1 : 1;
    if (teamSet.size <= teamsToWin && !this.ended) {
      this.finishMatch(local !== null && local.lifeState !== 'DEAD' && local.team === this.lastTeam());
    }
    // If the player is dead and their team is wiped, the match is over for them.
    if (local && local.lifeState === 'DEAD' && !teamSet.has(local.team)) {
      this.placement = Math.max(this.placement, alive + 1);
    }
    void teamsToWin;
  }

  private lastTeam(): number {
    for (const a of this.world.actors) if (a.lifeState !== 'DEAD') return a.team;
    return -1;
  }

  private finishMatch(victory: boolean): void {
    this.ended = true;
    this.phase = 'ENDED';
    this.victory = victory;
    const local = this.localPlayer;
    if (victory) this.placement = 1;
    else if (local) this.placement = Math.max(1, this.aliveCount + 1);
    if (local && local.lifeState !== 'DEAD') {
      local.placement = this.placement;
    }
    bus.emit('match:ended', { victory, placement: this.placement });
  }

  /** Used when the player is eliminated but the match may continue. */
  forceEndForPlayer(): void {
    if (this.ended) return;
    this.finishMatch(false);
  }

  get alivePlayerNames(): string[] {
    return this.world.actors.filter((a) => a.lifeState !== 'DEAD').map((a) => a.name);
  }
}

export { wrapAngle };
export type { THREE };
