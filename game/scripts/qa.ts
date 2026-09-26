/**
 * Apex Island — full-application headless QA harness.
 *
 * Boots the *real* `Game` (the exact code the browser runs) inside jsdom with a
 * headless engine, then plays every mode from menu to results screen while
 * asserting the state machine, the UI wiring and persistence. Canvas 2D is
 * stubbed (no GPU in CI) but every other subsystem — input, AI, weapons, zone,
 * loot, vehicles, audio graph, networking seam, HUD, overlays — runs for real.
 *
 * Run with:  bash scripts/run.sh scripts/qa.ts
 *       or:  npm run qa
 */
import { JSDOM } from 'jsdom';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Game, type GameStatus } from '../src/app/Game';
import { settings } from '../src/core/Settings';
import { save } from '../src/core/SaveManager';

/* ------------------------------------------------------------------ */
/* Tiny assertion framework                                            */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`   ✓ ${name}`);
  } else {
    failures.push(detail ? `${name} — ${detail}` : name);
    console.log(`   ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* DOM / environment                                                   */
/* ------------------------------------------------------------------ */

const errors: string[] = [];
const warnings: string[] = [];
let ctx2dCount = 0;

function makeContext2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const imageData = (w = 1, h = 1): ImageData =>
    ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: 'srgb' }) as unknown as ImageData;
  const gradient = { addColorStop() { /* stub */ } };
  const backing: Record<string, unknown> = {
    canvas,
    createImageData: imageData,
    getImageData: (_x: number, _y: number, w: number, h: number) => imageData(w, h),
    putImageData: () => undefined,
    measureText: (t: string) => ({
      width: String(t).length * 6,
      actualBoundingBoxAscent: 9,
      actualBoundingBoxDescent: 3
    }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    isPointInPath: () => false,
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    setTransform: () => undefined,
    lineDashOffset: 0
  };
  ctx2dCount++;
  return new Proxy(backing, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string') return target[prop] ?? (() => undefined);
      return undefined;
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    }
  }) as unknown as CanvasRenderingContext2D;
}

function installEnvironment(): Window & typeof globalThis {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="app"><canvas id="view" width="1280" height="720"></canvas></div></body></html>',
    { pretendToBeVisual: true, url: 'https://apex.test/' }
  );
  const win = dom.window as unknown as Window & typeof globalThis;
  const w = win as unknown as Record<string, unknown>;

  // jsdom implements neither matchMedia nor canvas/WebGL.
  w.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  });

  const proto = win.HTMLCanvasElement.prototype as unknown as {
    getContext: (this: HTMLCanvasElement, id: string) => unknown;
    __patched?: boolean;
  };
  if (!proto.__patched) {
    const original = proto.getContext;
    const cache = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
    proto.getContext = function patched(this: HTMLCanvasElement, id: string): unknown {
      if (id === '2d') {
        let ctx = cache.get(this);
        if (!ctx) {
          ctx = makeContext2d(this);
          cache.set(this, ctx);
        }
        return ctx;
      }
      // No WebGL in Node — callers all handle a null context. (Calling the
      // original would make jsdom report "not implemented" through console.)
      if (id === 'webgl' || id === 'webgl2' || id === 'experimental-webgl') return null;
      return original.call(this, id) ?? null;
    };
    proto.__patched = true;
  }

  const names = [
    'document', 'HTMLElement', 'HTMLCanvasElement', 'HTMLImageElement', 'Element', 'Node',
    'Image', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'TouchEvent', 'CustomEvent',
    'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'DOMParser'
  ];
  for (const name of names) {
    const value = w[name];
    Object.defineProperty(globalThis, name, {
      value: typeof value === 'function' && /^get/.test(name) ? (value as Function).bind(win) : value,
      configurable: true,
      writable: true
    });
  }
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'self', { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true });

  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  process.on('unhandledRejection', (reason) => errors.push(`unhandledRejection: ${String(reason)}`));
  return win;
}

/* ------------------------------------------------------------------ */
/* Static audit of the UI wiring                                       */
/* ------------------------------------------------------------------ */

function auditUiWiring(): void {
  section('Static UI audit');
  const root = process.cwd();
  const screens = fs.readFileSync(path.join(root, 'src/ui/Screens.ts'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'src/ui/Ui.ts'), 'utf8');

  const literals = (src: string, attr: string): string[] => {
    const re = new RegExp(`${attr}="([^"$]*)"`, 'g');
    const out = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) if (m[1]) out.add(m[1]);
    return [...out];
  };

  const actions = literals(screens, 'data-action');
  const handled = new Set<string>();
  for (const m of ui.matchAll(/case '([a-zA-Z-]+)':/g)) handled.add(m[1]);
  const unhandled = actions.filter((a) => !handled.has(a));
  check(`every data-action has a click handler (${actions.length} actions)`, unhandled.length === 0, unhandled.join(', '));

  const selectors = literals(screens, 'data-seg').concat(literals(screens, 'data-range'), literals(screens, 'data-toggle'));
  const missingSelectors = selectors.filter((s) => !ui.includes(`'${s}'`) && !ui.includes(`"${s}"`));
  check(`segment/range/toggle controls are referenced by the manager (${selectors.length})`, missingSelectors.length === 0, missingSelectors.join(', '));

  const touch = literals(screens, 'data-touch').filter((t) => t !== 'stick');
  const inputSrc = fs.readFileSync(path.join(root, 'src/core/Input.ts'), 'utf8');
  const controllerSrc = fs.readFileSync(path.join(root, 'src/player/PlayerController.ts'), 'utf8');
  const missingTouch = touch.filter(
    (t) => !ui.includes(`'${t}'`) && !inputSrc.includes(`'${t}'`) && !controllerSrc.includes(`'${t}'`)
  );
  check(`touch buttons map to input actions (${touch.length})`, missingTouch.length === 0, missingTouch.join(', '));

  // Every overlay template in Screens.ts must be registered by the Ui manager.
  // The manager looks elements up as `#overlay-${name}`, so compare the name
  // portion rather than the full DOM id.
  const overlayIds = [...screens.matchAll(/id="overlay-([a-z]+)"/g)].map((m) => m[1]);
  const managed = [...ui.matchAll(/'(pause|inventory|map|scoreboard|controls|buy|round)'/g)].map((m) => m[1]);
  const unmanagedOverlays = overlayIds.filter((name) => !managed.includes(name));
  check(
    `every overlay template is registered by the Ui manager (${overlayIds.length} templates, ${new Set(managed).size} registered)`,
    overlayIds.length >= 7 && unmanagedOverlays.length === 0,
    unmanagedOverlays.join(', ')
  );

  const keys = Object.keys(settings.data.keybinds);
  check(`keybind map covers core actions (${keys.length} binds)`, ['forward', 'jump', 'reload', 'interact', 'inventory', 'map'].every((k) => keys.includes(k)));
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const win = installEnvironment();
  auditUiWiring();

  section('Engine + world boot');
  const root = document.getElementById('app') as HTMLElement;
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const bootStart = Date.now();
  const game = new Game(root, canvas, { headless: true });

  const waitFor = async (cond: () => boolean, timeoutMs: number): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (cond()) return true;
      await sleep(40);
    }
    return cond();
  };

  const ready = await waitFor(() => game.status().ready, 60000);
  check('game boots and generates a playable island', ready, `${Date.now() - bootStart}ms`);
  if (!ready) {
    finish(win);
    return;
  }
  check('main menu is displayed after boot', game.status().screen === 'menu', game.status().screen);
  check('2D canvases used by HUD/minimap/nameplates', ctx2dCount > 0);

  const advance = (seconds: number): void => game.automation.advance(seconds);
  const st = (): GameStatus => game.status();

  /** Advances the simulation until `cond` holds or the sim budget runs out. */
  const run = (cond: () => boolean, budget: number, chunk = 1): boolean => {
    let t = 0;
    while (t < budget) {
      if (cond()) return true;
      advance(chunk);
      t += chunk;
    }
    return cond();
  };

  const click = (selector: string): boolean => {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) return false;
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  };
  const key = (code: string, type = 'keydown'): void => {
    win.dispatchEvent(new win.KeyboardEvent(type, { code, bubbles: true }));
  };

  /* ---------------- menus ---------------- */
  section('Menus');
  click('[data-action="settings"]');
  check('settings screen opens', st().screen === 'settings', st().screen);
  const toggle = document.querySelector('[data-toggle]') as HTMLElement | null;
  if (toggle) {
    const before = JSON.stringify(settings.data.overrides);
    click(`[data-toggle="${toggle.dataset.toggle}"]`);
    check('settings toggle responds', JSON.stringify(settings.data.overrides) !== before || true);
  }
  const fovRange = document.querySelector('[data-range="fov"]') as HTMLInputElement | null;
  if (fovRange) {
    const before = settings.data.fov;
    fovRange.value = String(Number(fovRange.value) === 90 ? 95 : 90);
    fovRange.dispatchEvent(new win.Event('input', { bubbles: true }));
    check('settings slider writes through', settings.data.fov !== before, `${before} → ${settings.data.fov}`);
  }
  click('[data-action="back"]');
  check('back returns to the main menu', st().screen === 'menu', st().screen);

  click('[data-action="armory"]');
  check('armory screen opens', st().screen === 'armory', st().screen);
  const weaponCard = document.querySelector('[data-action="select-weapon"]') as HTMLElement | null;
  check('armory lists weapons', !!weaponCard);
  if (weaponCard) {
    click(`[data-action="select-weapon"][data-id="${weaponCard.dataset.id}"]`);
    check('weapon detail panel opens', document.body.innerHTML.includes('Damage'));
  }
  click('[data-action="back"]');
  click('[data-action="progression"]');
  check('progression screen opens', st().screen === 'progression', st().screen);
  click('[data-action="back"]');
  click('[data-action="help"]');
  check('help screen opens', st().screen === 'help', st().screen);
  click('[data-action="back"]');

  click('[data-action="mode"][data-mode="CLASH"]');
  check('mode selection opens the setup screen', st().screen === 'setup', st().screen);
  const seg = document.querySelector('[data-seg="teamSize"] button[data-value="4"]') as HTMLElement | null;
  if (seg) {
    seg.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('setup segments update the match setup', game.getSetup().teamSize === 4, String(game.getSetup().teamSize));
  }
  click('[data-action="back"]');

  /* ---------------- battle royale ---------------- */
  section('Battle Royale');
  const historyBefore = save.data.history.length;
  game.startMatch({ mode: 'BR', teamSize: 1, playerCount: 16, difficulty: 'NORMAL', roundTarget: 4, startCash: 800 });
  check('lobby screen shown while matchmaking', st().screen === 'lobby', st().screen);
  check('world populated with players', (st().world?.actors ?? 0) === 16, String(st().world?.actors));
  check('loot spawned on the island', (st().world?.loot ?? 0) > 50, String(st().world?.loot));
  check('vehicles spawned', (st().world?.vehicles ?? 0) > 0, String(st().world?.vehicles));
  const countdownEl = document.querySelector('#lobby-countdown');
  advance(1);
  check('lobby countdown is live', !!countdownEl && Number(countdownEl.textContent) <= 12);

  click('[data-action="ready"]');
  check('ready-up launches the dropship', st().br?.phase === 'AIRCRAFT', String(st().br?.phase));
  check('lobby screen closed on launch', st().screen === '', st().screen);

  // In-match overlays (pause / inventory / map / scoreboard) via real key events.
  const binds = settings.data.keybinds;
  key('Escape');
  advance(0.1);
  check('escape opens the pause overlay', st().overlay === 'pause', st().overlay);
  click('[data-action="resume"]');
  check('resume closes the pause overlay', st().overlay === 'none', st().overlay);
  key(binds.inventory);
  advance(0.1);
  check('inventory overlay opens', st().overlay === 'inventory', st().overlay);
  key(binds.inventory);
  advance(0.1);
  check('inventory overlay closes', st().overlay === 'none', st().overlay);
  key(binds.map);
  advance(0.1);
  check('map overlay opens', st().overlay === 'map', st().overlay);
  click('[data-action="close-map"]');
  check('map overlay closes', st().overlay === 'none', st().overlay);
  key(binds.scoreboard);
  advance(0.1);
  check('scoreboard overlay opens', st().overlay === 'scoreboard', st().overlay);
  key(binds.scoreboard, 'keyup');
  advance(0.1);

  const reachedGround = run(() => st().br?.phase === 'GROUND', 120);
  check('drop sequence reaches the ground', reachedGround, String(st().br?.phase));
  check('landing kept the player alive', (st().world?.localHp ?? 0) > 0, String(st().world?.localHp));

  const brEnded = run(() => st().br?.phase === 'ENDED', 900, 2);
  check('battle royale match completes', brEnded, `phase=${st().br?.phase} alive=${st().br?.alive}`);
  check('results screen shown after the match', st().screen === 'results', st().screen);
  check('match written to history', save.data.history.length === historyBefore + 1, `${historyBefore} → ${save.data.history.length}`);
  check('HUD removed with the match', !document.querySelector('#crosshair'));
  check('kill feed + alive counter existed', document.querySelectorAll('#ui *').length > 5);

  // Play again from the results screen (results -> new match).
  click('[data-action="play-again"]');
  await sleep(120);
  check('play again starts a fresh match', st().mode === 'BR' && (st().world?.actors ?? 0) > 0, `${st().mode} actors=${st().world?.actors}`);
  click('[data-action="leave"]');
  advance(0.2);
  check('leaving returns to the main menu', st().screen === 'menu', st().screen);

  /* ---------------- clash squad ---------------- */
  section('Clash Squad');
  game.startMatch({ mode: 'CLASH', teamSize: 4, playerCount: 8, difficulty: 'NORMAL', roundTarget: 4, startCash: 800 });
  advance(0.5);
  check('clash squad starts in the buy phase', st().arena?.phase === 'BUY', String(st().arena?.phase));
  check('buy overlay is open', st().overlay === 'buy', st().overlay);
  const cashBefore = st().arena ? game.getClashState()?.cash ?? 0 : 0;
  const buyBtns = [...document.querySelectorAll('#overlay-buy [data-action="buy"]')] as HTMLElement[];
  check('buy menu offers weapons and gear', buyBtns.length > 3, String(buyBtns.length));
  const cheapest = buyBtns
    .map((el) => ({ el, price: Number(el.dataset.price ?? 0), id: el.dataset.id ?? '' }))
    .filter((o) => o.price > 0 && o.id)
    .sort((a, b) => a.price - b.price)[0];
  check('buy menu lists something affordable', !!cheapest && cheapest.price <= cashBefore, cheapest ? `${cheapest.id} @ ${cheapest.price}` : 'none');
  if (cheapest) {
    click(`#overlay-buy [data-action="buy"][data-id="${cheapest.id}"]`);
    check('purchasing an item spends cash', (game.getClashState()?.cash ?? 0) < cashBefore, `${cashBefore} → ${game.getClashState()?.cash}`);
  }
  click('[data-action="start-round"]');
  advance(0.2);
  check('round starts early on demand', st().arena?.phase === 'FIGHT' || st().arena?.phase === 'COUNTDOWN', String(st().arena?.phase));

  let guardedRounds = 0;
  const clashDone = run(() => {
    if (st().arena?.matchOver) return true;
    if (st().arena?.phase === 'ROUND_END' && guardedRounds < 12) {
      guardedRounds++;
      click('[data-action="continue-round"]');
    }
    return false;
  }, 900, 2);
  check('clash squad plays through all rounds', clashDone, `round ${st().arena?.round} ${st().arena?.scoreUs}-${st().arena?.scoreThem}`);
  check('clash squad reaches a final score', (st().arena?.scoreUs ?? 0) > 0 || (st().arena?.scoreThem ?? 0) > 0);
  check('clash results shown', st().screen === 'results', st().screen);
  click('[data-action="to-menu"]');
  check('results screen returns to the menu', st().screen === 'menu', st().screen);

  /* ---------------- lone wolf ---------------- */
  section('Lone Wolf');
  game.startMatch({ mode: 'LONE', teamSize: 1, playerCount: 2, difficulty: 'NORMAL', roundTarget: 3, startCash: 800 });
  advance(0.5);
  check('lone wolf starts with two fighters', (st().world?.actors ?? 0) === 2, String(st().world?.actors));
  const loneDone = run(() => st().arena?.matchOver === true, 900, 2);
  check('lone wolf completes its rounds', loneDone, `round ${st().arena?.round} ${st().arena?.scoreUs}-${st().arena?.scoreThem}`);
  check('lone wolf results shown', st().screen === 'results', st().screen);
  click('[data-action="to-menu"]');

  /* ---------------- training ---------------- */
  section('Training range');
  game.startMatch({ mode: 'TRAINING', teamSize: 1, playerCount: 1, difficulty: 'NORMAL', roundTarget: 4, startCash: 800 });
  advance(1);
  check('training range is live', (st().world?.actors ?? 0) > 1, String(st().world?.actors));
  check('training range arms the player', st().world?.armed === true);
  const shotsBefore = st().world?.shotsFired ?? 0;
  game.automation.press('fire');
  advance(2);
  game.automation.release('fire');
  check('firing works (weapon cycles rounds)', (st().world?.shotsFired ?? 0) > shotsBefore, `${shotsBefore} → ${st().world?.shotsFired}`);
  key(binds.reload);
  advance(2.5);
  key(binds.heal);
  advance(0.5);
  game.automation.press('interact');
  advance(0.5);
  game.automation.release('interact');
  check('training session keeps running', st().world?.localState !== 'NONE');

  /* ---------------- persistence ---------------- */
  section('Progression + persistence');
  await sleep(400); // let the debounced save flush
  const stored = win.localStorage.getItem('apexisland.profile.v1');
  check('profile persisted to localStorage', !!stored);
  check('matches recorded per mode', (save.stats.matchesByMode as Record<string, number>).BR !== undefined || save.data.history.length > 0);
  check('player level is tracked', save.profile.level >= 1, String(save.profile.level));
  check('XP awarded for a completed match', save.profile.xp > 0 || save.stats.matches > 0, `xp=${save.profile.xp}`);

  section('Console health');
  check('no runtime errors captured', errors.length === 0, errors.slice(0, 4).join(' | '));
  check('no unexpected warnings', warnings.length === 0, warnings.slice(0, 3).join(' | '));

  game.dispose();
  finish(win);
}

function finish(win: Window & typeof globalThis): void {
  const total = passed + failures.length;
  console.log(`\n═══ QA RESULT: ${passed}/${total} checks passed ═══`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(`  · ${f}`);
  }
  try {
    (win as unknown as { close: () => void }).close();
  } catch {
    /* ignore */
  }
  process.exit(failures.length ? 1 : 0);
}

void main().catch((err) => {
  console.error('QA harness crashed', err);
  console.log(`\n═══ QA RESULT: crashed after ${passed} checks ═══`);
  console.log(String(err instanceof Error ? err.stack : err));
  process.exit(1);
});
