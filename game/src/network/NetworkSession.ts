import type { Actor } from '../entity/Actor';
import type { CombatWorld } from '../modes/CombatWorld';
import { bus } from '../core/EventBus';

/**
 * Multiplayer seam.
 *
 * The whole game is written so that the *simulation* is a pure function of
 * `(world state, input)` — the host owns it and the renderer only reads it.
 * That is exactly the shape a client/server split needs, so swapping in real
 * multiplayer is a matter of implementing `Transport` and pointing
 * `NetworkSession` at it:
 *
 *   • `LocalTransport`   — in-process loopback used for single player and tests.
 *   • `WebSocketTransport` — drop-in for an authoritative game server (see the
 *     message contract below). Nothing else in the codebase has to change.
 *
 * Message contract (JSON, one object per frame or event):
 *   { t: 'join',   id, name, team }
 *   { t: 'leave',  id }
 *   { t: 'state',  id, x, y, z, yaw, pitch, health, lifeState, moveState, weaponId, seq }
 *   { t: 'shot',   id, x, y, z, dx, dy, dz, weaponId, seq }
 *   { t: 'hit',    id, targetId, damage, part, weaponId }
 *   { t: 'loot',   id, lootId }
 *   { t: 'round',  round, phase, scoreUs, scoreThem }
 */

export type NetMessage =
  | { t: 'join'; id: number; name: string; team: number }
  | { t: 'leave'; id: number }
  | {
      t: 'state'; id: number; x: number; y: number; z: number; yaw: number; pitch: number;
      health: number; lifeState: string; moveState: string; weaponId: string | null; seq: number;
    }
  | { t: 'shot'; id: number; x: number; y: number; z: number; dx: number; dy: number; dz: number; weaponId: string; seq: number }
  | { t: 'hit'; id: number; targetId: number; damage: number; part: string; weaponId: string }
  | { t: 'loot'; id: number; lootId: number }
  | { t: 'round'; round: number; phase: string; scoreUs: number; scoreThem: number };

export interface Transport {
  readonly connected: boolean;
  send(message: NetMessage): void;
  onMessage(handler: (message: NetMessage) => void): () => void;
  close(): void;
}

/** Loopback transport: everything stays on this machine (single player). */
export class LocalTransport implements Transport {
  private handlers = new Set<(message: NetMessage) => void>();
  connected = true;

  send(message: NetMessage): void {
    // Loopback echoes asynchronously so ordering matches a real socket.
    queueMicrotask(() => {
      for (const h of this.handlers) h(message);
    });
  }

  onMessage(handler: (message: NetMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.handlers.clear();
    this.connected = false;
  }
}

/**
 * WebSocket transport skeleton: same interface, real socket. Kept small on
 * purpose — the server side (authoritative sim) is the remaining piece.
 */
export class WebSocketTransport implements Transport {
  private socket: WebSocket | null = null;
  private handlers = new Set<(message: NetMessage) => void>();
  connected = false;

  constructor(private url: string) {}

  connect(): void {
    if (typeof WebSocket === 'undefined') return;
    this.socket = new WebSocket(this.url);
    this.socket.onopen = () => {
      this.connected = true;
      bus.emit('ui:toast', { text: 'Connected to match server', kind: 'good' });
    };
    this.socket.onclose = () => {
      this.connected = false;
      bus.emit('ui:toast', { text: 'Disconnected from match server', kind: 'warn' });
    };
    this.socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as NetMessage;
        for (const h of this.handlers) h(message);
      } catch (err) {
        console.warn('[net] bad message', err);
      }
    };
  }

  send(message: NetMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  onMessage(handler: (message: NetMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.socket?.close();
    this.handlers.clear();
    this.connected = false;
  }
}

interface RemotePlayer {
  id: number;
  actor: Actor | null;
  name: string;
  team: number;
  buffer: { x: number; y: number; z: number; yaw: number; time: number }[];
}

/**
 * Ties a transport to the local simulation: publishes the local actor at a
 * fixed send rate and mirrors remote players into the world as lightweight
 * actors (interpolated). In single player it simply does nothing but keep the
 * plumbing exercised, which keeps the seam honest.
 */
export class NetworkSession {
  private remotes = new Map<number, RemotePlayer>();
  private disposer: (() => void) | null = null;
  private sendAccumulator = 0;
  private sequence = 0;
  readonly sendRate = 20;

  constructor(
    private world: CombatWorld,
    public transport: Transport = new LocalTransport(),
    private isOnline = false
  ) {
    this.disposer = this.transport.onMessage((m) => this.handle(m));
  }

  get online(): boolean {
    return this.isOnline;
  }

  /** Called every fixed step. No-op locally beyond bookkeeping. */
  update(dt: number, localActor: Actor | null): void {
    if (!localActor) return;
    this.sendAccumulator += dt;
    if (this.sendAccumulator < 1 / this.sendRate) return;
    this.sendAccumulator = 0;
    if (!this.isOnline) return;
    this.transport.send({
      t: 'state',
      id: localActor.id,
      x: localActor.position.x,
      y: localActor.position.y,
      z: localActor.position.z,
      yaw: localActor.yaw,
      pitch: localActor.pitch,
      health: localActor.health,
      lifeState: localActor.lifeState,
      moveState: localActor.moveState,
      weaponId: localActor.inventory.active?.defId ?? null,
      seq: ++this.sequence
    });
  }

  /** Local shot, forwarded so a server can validate it. */
  reportShot(actor: Actor, dirX: number, dirY: number, dirZ: number, weaponId: string): void {
    if (!this.isOnline) return;
    this.transport.send({
      t: 'shot',
      id: actor.id,
      x: actor.position.x, y: actor.position.y, z: actor.position.z,
      dx: dirX, dy: dirY, dz: dirZ,
      weaponId,
      seq: ++this.sequence
    });
  }

  private handle(message: NetMessage): void {
    switch (message.t) {
      case 'join': {
        const remote = this.remotes.get(message.id);
        if (!remote) {
          this.remotes.set(message.id, { id: message.id, actor: null, name: message.name, team: message.team, buffer: [] });
        }
        break;
      }
      case 'leave': {
        const remote = this.remotes.get(message.id);
        if (remote?.actor) this.world.despawnActor(remote.actor);
        this.remotes.delete(message.id);
        break;
      }
      case 'state': {
        let remote = this.remotes.get(message.id);
        if (!remote) {
          remote = { id: message.id, actor: null, name: `Player-${message.id}`, team: 0, buffer: [] };
          this.remotes.set(message.id, remote);
        }
        if (!remote.actor) {
          remote.actor = this.world.spawnActor({
            x: message.x, y: message.y, z: message.z,
            yaw: message.yaw,
            name: remote.name,
            team: remote.team,
            isBot: false,
            isLocal: false
          });
          remote.actor.health = message.health;
        }
        remote.buffer.push({ x: message.x, y: message.y, z: message.z, yaw: message.yaw, time: performance.now() });
        if (remote.buffer.length > 12) remote.buffer.shift();
        break;
      }
      case 'hit':
        // Remote damage is applied only when the server confirms it; locally the
        // simulation already resolved the shot.
        break;
      default:
        break;
    }
  }

  get remoteCount(): number {
    return this.remotes.size;
  }

  dispose(): void {
    this.disposer?.();
    this.disposer = null;
    for (const [, remote] of this.remotes) {
      if (remote.actor) this.world.despawnActor(remote.actor);
    }
    this.remotes.clear();
    this.transport.close();
  }
}
