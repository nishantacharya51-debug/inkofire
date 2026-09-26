import { bus } from './EventBus';

/**
 * Central game state machine.
 * Transitions are validated against an explicit table — invalid transitions are
 * rejected (and logged) instead of silently corrupting the match flow.
 */
export const GameStates = [
  'BOOT',
  'LOADING',
  'MAIN_MENU',
  'MATCHMAKING',
  'LOBBY',
  'AIRCRAFT',
  'SKYDIVING',
  'PARACHUTING',
  'PLAYING',
  'SPECTATING',
  'DEAD',
  'ROUND_RESULT',
  'VICTORY',
  'DEFEAT',
  'RESULTS'
] as const;

export type GameState = (typeof GameStates)[number];

const TRANSITIONS: Record<GameState, GameState[]> = {
  BOOT: ['LOADING'],
  LOADING: ['MAIN_MENU', 'BOOT'],
  MAIN_MENU: ['MATCHMAKING', 'LOADING', 'MAIN_MENU'],
  MATCHMAKING: ['LOBBY', 'MAIN_MENU'],
  LOBBY: ['AIRCRAFT', 'PLAYING', 'MAIN_MENU'],
  AIRCRAFT: ['SKYDIVING', 'MAIN_MENU', 'PLAYING'],
  SKYDIVING: ['PARACHUTING', 'PLAYING', 'SPECTATING', 'DEAD', 'MAIN_MENU'],
  PARACHUTING: ['PLAYING', 'DEAD', 'SPECTATING', 'MAIN_MENU'],
  PLAYING: ['DEAD', 'SPECTATING', 'VICTORY', 'DEFEAT', 'ROUND_RESULT', 'RESULTS', 'LOBBY', 'MAIN_MENU'],
  DEAD: ['SPECTATING', 'RESULTS', 'ROUND_RESULT', 'LOBBY', 'MAIN_MENU'],
  SPECTATING: ['RESULTS', 'ROUND_RESULT', 'PLAYING', 'MAIN_MENU', 'VICTORY', 'DEFEAT'],
  ROUND_RESULT: ['PLAYING', 'RESULTS', 'MAIN_MENU', 'LOBBY'],
  VICTORY: ['RESULTS', 'MAIN_MENU', 'PLAYING'],
  DEFEAT: ['RESULTS', 'MAIN_MENU', 'PLAYING'],
  RESULTS: ['MATCHMAKING', 'MAIN_MENU', 'PLAYING', 'LOBBY']
};

export class GameStateMachine {
  private _state: GameState = 'BOOT';
  private history: GameState[] = ['BOOT'];

  get state(): GameState {
    return this._state;
  }

  get previous(): GameState {
    return this.history.length > 1 ? this.history[this.history.length - 2] : 'BOOT';
  }

  canTransition(to: GameState): boolean {
    return TRANSITIONS[this._state].includes(to);
  }

  /**
   * Attempt a transition. Returns true when applied.
   * Always allowed: re-entering the same state.
   */
  transition(to: GameState): boolean {
    if (to === this._state) return true;
    if (!this.canTransition(to)) {
      console.warn(`[GameState] rejected invalid transition ${this._state} -> ${to}`);
      return false;
    }
    const from = this._state;
    this._state = to;
    this.history.push(to);
    if (this.history.length > 40) this.history.shift();
    bus.emit('state:changed', { from, to });
    return true;
  }

  /** Force a transition (used by hard resets / returning to menu from anywhere). */
  force(to: GameState): void {
    const from = this._state;
    this._state = to;
    this.history.push(to);
    bus.emit('state:changed', { from, to });
  }

  is(...states: GameState[]): boolean {
    return states.includes(this._state);
  }

  /** True while the player is in the world and can act. */
  get isInWorld(): boolean {
    return this.is('PLAYING', 'AIRCRAFT', 'SKYDIVING', 'PARACHUTING', 'DEAD', 'SPECTATING', 'ROUND_RESULT');
  }
}

export const gameState = new GameStateMachine();
