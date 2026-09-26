/** Tiny typed event bus used to decouple gameplay systems from the UI layer. */

export type Handler<T> = (payload: T) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class EventBus<Events extends Record<string, any>> {
  private handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => this.off(event, handler);
  }

  off<K extends keyof Events>(event: K, handler: Handler<Events[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) {
      try {
        (h as Handler<Events[K]>)(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${String(event)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

/** Global game events. UI, audio and effects subscribe to these. */
export interface GameEvents {
  'state:changed': { from: string; to: string };
  'actor:damaged': { id: number; amount: number; part: string; attackerId: number; isLocal: boolean };
  'actor:knocked': { id: number; isLocal: boolean };
  'actor:eliminated': { id: number; killerId: number; weaponId: string; isLocal: boolean; name: string };
  'actor:revived': { id: number };
  'shot:fired': { actorId: number; weaponId: string; isLocal: boolean; position: [number, number, number]; suppressed: boolean };
  'bullet:impact': { x: number; y: number; z: number; surface: string; isLocal: boolean };
  'hitmarker': { headshot: boolean; killed: boolean };
  'killfeed': { killer: string; victim: string; weapon: string; headshot: boolean; isLocalKiller: boolean; isLocalVictim: boolean };
  'zone:phase': { phase: number; x: number; z: number; radius: number; waitTime: number };
  'zone:warning': { level: number };
  'loot:pickup': { itemId: string; name: string };
  'inventory:changed': Record<string, never>;
  'weapon:changed': { slot: number; weaponId: string };
  'weapon:reloaded': { actorId: number; weaponId: string };
  'ammo:empty': Record<string, never>;
  'match:started': { mode: string; players: number };
  'match:ended': { victory: boolean; placement: number };
  'round:started': { round: number };
  'round:ended': { round: number; winnerTeam: number };
  'player:downed': Record<string, never>;
  'player:landed': Record<string, never>;
  'player:jumped': Record<string, never>;
  'parachute:deployed': Record<string, never>;
  'vehicle:entered': { vehicleId: number; type: string };
  'vehicle:exited': Record<string, never>;
  'vehicle:destroyed': { vehicleId: number };
  'interact:prompt': { text: string } | null;
  'ui:toast': { text: string; kind: 'info' | 'warn' | 'good' | 'bad' };
  'spectate:target': { id: number; name: string };
  'settings:changed': Record<string, never>;
  'audio:enabled': { enabled: boolean };
  'stats:changed': Record<string, never>;
  'achievement:unlocked': { id: string; name: string };
}

export const bus = new EventBus<GameEvents>();
