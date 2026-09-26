import './ui/styles.css';
import { Game } from './app/Game';
import { bus } from './core/EventBus';

/**
 * Entry point.
 *
 * Keeps the failure paths honest: if WebGL is unavailable or anything throws
 * during boot, the player gets a readable message instead of a blank canvas.
 */

function showBootError(message: string, detail = ''): void {
  const box = document.getElementById('boot-error');
  const msg = document.getElementById('boot-error-msg');
  const det = document.getElementById('boot-error-detail');
  if (msg) msg.textContent = message;
  if (det) det.textContent = detail;
  if (box) box.style.display = 'flex';
}

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    return !!gl;
  } catch {
    return false;
  }
}

function boot(): void {
  const app = document.getElementById('app');
  const canvas = document.getElementById('view') as HTMLCanvasElement | null;
  if (!app || !canvas) {
    showBootError('The game container is missing from the page.');
    return;
  }
  if (!hasWebGL()) {
    showBootError('WebGL is not available in this browser.');
    return;
  }

  // Surface gameplay toasts on screen even if the HUD is not built yet.
  bus.on('ui:toast', (e) => {
    if (e.kind !== 'bad') return;
    console.warn('[game]', e.text);
  });

  canvas.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    showBootError('The graphics context was lost.', 'Reload the page to continue playing.');
  });

  try {
    const game = new Game(app, canvas);
    // Expose for debugging from the console (handy for QA and issue reports).
    (window as unknown as { apexGame?: Game; apexBus?: typeof bus }).apexGame = game;
    (window as unknown as { apexGame?: Game; apexBus?: typeof bus }).apexBus = bus;
  } catch (err) {
    console.error('[boot] failed', err);
    showBootError('Apex Island failed to start.', err instanceof Error ? err.message : String(err));
  }
}

window.addEventListener('error', (e) => {
  console.error('[uncaught]', e.error ?? e.message);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
