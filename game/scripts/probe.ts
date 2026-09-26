/** Throwaway diagnostic: BR launch + key handling under the QA harness. */
import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  '<!doctype html><html><body><div id="app"><canvas id="view" width="1280" height="720"></canvas></div></body></html>',
  { pretendToBeVisual: true, url: 'https://apex.test/' }
);
const win = dom.window as unknown as Window & typeof globalThis;
const w = win as unknown as Record<string, unknown>;
w.matchMedia = (q: string) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
const proto = win.HTMLCanvasElement.prototype as unknown as { getContext: (id: string) => unknown };
proto.getContext = () => null;
for (const name of ['document', 'HTMLElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
  const v = w[name];
  Object.defineProperty(globalThis, name, { value: typeof v === 'function' && /^get/.test(name) ? (v as Function).bind(win) : v, configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true });
Object.defineProperty(globalThis, 'self', { value: win, configurable: true, writable: true });
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true });

import { Game } from '../src/app/Game';

const root = document.getElementById('app') as HTMLElement;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const game = new Game(root, canvas, { headless: true });

async function main(): Promise<void> {
  const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    return cond();
  };

  console.log('ready:', await waitFor(() => game.status().ready, 60000), 'screen:', game.status().screen);
  game.automation.stopLoop();

  game.startMatch({ mode: 'BR', teamSize: 1, playerCount: 12, difficulty: 'NORMAL', roundTarget: 4, startCash: 800 });
  console.log('after startMatch:', JSON.stringify(game.status()).slice(0, 200));
  game.automation.advance(0.25);
  console.log('countdown after 0.25s:', document.querySelector('#lobby-countdown')?.textContent, game.status().br);

  const ready = document.querySelector('[data-action="ready"]') as HTMLElement | null;
  console.log('ready button present:', !!ready);
  ready?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  console.log('after ready click:', game.status().br);

  for (let t = 0; t < 70; t += 5) {
  game.automation.advance(5);
  const s = game.status();
  console.log(`  sim ${(t + 5).toString().padStart(3)}s → br=${s.br?.phase} alive=${s.br?.alive} hp=${s.world?.localHp} overlay=${s.overlay} screen=${s.screen}`);
  }

  console.log('--- key handling ---');
  win.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
  game.automation.advance(0.1);
  console.log('after Escape:', game.status().overlay, game.status().screen);
  const resume = document.querySelector('[data-action="resume"]') as HTMLElement | null;
  console.log('resume button:', !!resume);
  win.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
  game.automation.advance(0.1);
  console.log('after 2nd Escape:', game.status().overlay);
  console.log('overlay elements:', [...document.querySelectorAll('[id^="overlay-"]')].map((e) => e.id));
  console.log('ctx2d probes ok');

  game.dispose();
  process.exit(0);
}

void main();
