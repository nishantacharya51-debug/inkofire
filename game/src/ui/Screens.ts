import { WEAPONS, ATTACHMENTS, GEAR, RARITY_COLOR, type WeaponClass, type WeaponDef, type Rarity } from '../items/Items';
import { QUALITY_PRESETS, DEFAULT_KEYBINDS, type QualityLevel } from '../core/Settings';
import { ACHIEVEMENTS, type Profile, type PlayerStats, type MatchRecord } from '../core/SaveManager';

/**
 * Every HTML template in the game, as pure string builders.
 *
 * Keeping them in one place makes it obvious which buttons exist and what each
 * one is wired to (`data-action`), so no screen can ship with a dead control.
 */

const BRIEFING = [
  '<b>Land smart.</b> Hot POIs hold the best loot and the most enemies — pick a quiet compound and rotate in.',
  '<b>Grab a gun first.</b> Anything beats bare hands; a pistol now is worth more than a rifle three blocks away.',
  '<b>Mind the ring.</b> The zone out-damages everything early. Stay inside it and use it to force fights on your terms.',
  '<b>Squads revive.</b> A knocked teammate can be picked up — push only when you can still get them back.',
  '<b>Drive, don\'t walk.</b> Vehicles cross the island in seconds and make hard cover when they blow.'
] as const;

const QUICK_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['Move', 'W A S D'],
  ['Fire / ADS', 'LMB / RMB'],
  ['Sprint · Crouch · Prone', 'SHIFT · C · Z'],
  ['Jump · Slide', 'SPACE · C'],
  ['Reload · Interact', 'R · F'],
  ['Heal · Grenade', 'H · G'],
  ['Inventory · Map', 'TAB · M'],
  ['Vehicle · Scoreboard', 'E · P']
] as const;

export interface MenuContext {
  profile: Profile;
  stats: PlayerStats;
  history: MatchRecord[];
  botDifficulty: string;
  quality: string;
  mode: string;
}

const MODE_INFO = [
  {
    id: 'BR',
    name: 'Battle Royale',
    tag: 'Classic · 60 players',
    body: 'Drop from the dropship, loot the island and outlast everyone as the ring closes.',
    meta: ['SOLO / DUO / SQUAD', 'FULL MAP', 'RANKED READY']
  },
  {
    id: 'CLASH',
    name: 'Clash Squad',
    tag: '4v4 · Best of 7',
    body: 'Round-based firefights with an economy. Buy weapons between rounds, wipe the enemy team to score.',
    meta: ['4 v 4', 'BUY PHASE', 'BEST OF 7']
  },
  {
    id: 'LONE',
    name: 'Lone Wolf',
    tag: '1v1 · Best of 5',
    body: 'Pure duel mode. Both players get the same loadout and fight for every round.',
    meta: ['1 v 1', 'FIXED LOADOUT', 'BEST OF 5']
  },
  {
    id: 'TRAINING',
    name: 'Training',
    tag: 'Range · Free play',
    body: 'Weapon range with targets, an armoury table and vehicles to practice driving.',
    meta: ['NO PRESSURE', 'ALL WEAPONS', 'DRIVING PAD']
  }
] as const;

export function loadingScreen(progress: number, tip: string): string {
  return `
  <div class="screen" id="screen-loading">
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;">
      <div class="brand" style="flex-direction:column;align-items:center;gap:6px;">
        <div class="brand-mark" style="font-size:44px;">APEX<span>ISLAND</span></div>
        <div class="brand-sub">Tactical Battle Royale</div>
      </div>
      <div class="loading-bar"><i style="width:${Math.round(progress * 100)}%"></i></div>
      <div class="hint" id="loading-status">Generating island…</div>
      <div class="tips" style="max-width:520px;text-align:center;">${tip}</div>
    </div>
  </div>`;
}

export function mainMenuScreen(ctx: MenuContext): string {
  const { profile, stats } = ctx;
  const kd = stats.deaths > 0 ? (stats.kills / stats.deaths).toFixed(2) : stats.kills.toFixed(2);
  return `
  <div class="screen" id="screen-menu">
    <div class="top-strip">
      <div class="brand">
        <div class="brand-mark">APEX<span>ISLAND</span></div>
        <div class="brand-sub">Tactical Battle Royale</div>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        <div class="profile-chip">
          <span class="name">${esc(profile.name)}</span>
          <span class="level">LVL ${profile.level}</span>
          <span class="coins">◈ ${profile.coins}</span>
        </div>
        <button class="btn ghost" data-action="settings" style="width:auto;padding:9px 14px;">Settings</button>
      </div>
    </div>
    <div class="menu-body">
      <div style="display:flex;flex-direction:column;gap:18px;min-width:0;">
        <div class="panel">
          <div class="panel-title">Career</div>
          <div class="xp-bar" style="margin-bottom:10px;"><i style="width:${xpPercent(ctx)}%"></i></div>
          <div class="kv"><span>Matches played</span><span>${stats.matches}</span></div>
          <div class="kv"><span>Victories</span><span>${stats.wins}</span></div>
          <div class="kv"><span>K/D ratio</span><span>${kd}</span></div>
          <div class="kv"><span>Top 10 finishes</span><span>${stats.top10}</span></div>
          <div class="kv"><span>Damage dealt</span><span>${Math.round(stats.damage).toLocaleString()}</span></div>
          <div class="btn-row" style="margin-top:14px;">
            <button class="btn" data-action="armory">Armory</button>
            <button class="btn" data-action="progression">Progression</button>
          </div>
        </div>
        <div class="panel">
          <div class="panel-title">Matchmaking</div>
          <div class="opt-row">
            <label>Bot difficulty</label>
            <div class="seg" data-seg="difficulty">
              ${segButton('EASY', ctx.botDifficulty)}
              ${segButton('NORMAL', ctx.botDifficulty)}
              ${segButton('HARD', ctx.botDifficulty)}
              ${segButton('ELITE', ctx.botDifficulty)}
            </div>
          </div>
          <div class="opt-row">
            <label>Graphics</label>
            <div class="seg" data-seg="quality">
              ${segButton('AUTO', ctx.quality)}
              ${segButton('LOW', ctx.quality)}
              ${segButton('MEDIUM', ctx.quality)}
              ${segButton('HIGH', ctx.quality)}
              ${segButton('ULTRA', ctx.quality)}
            </div>
          </div>
          <div class="hint" style="margin-top:10px;">Auto-detect reads your GPU, cores and memory, then picks a preset. You can override everything in Settings.</div>
        </div>
        <div class="panel">
          <div class="panel-title">Drop briefing</div>
          <div class="briefing">
            ${BRIEFING.map((b, i) => `<div class="briefing-item"><span class="n">0${i + 1}</span><span>${b}</span></div>`).join('')}
          </div>
        </div>
      </div>
      <div class="scroll-area" style="display:flex;flex-direction:column;gap:16px;">
        <div class="panel" style="background:linear-gradient(180deg, rgba(16,23,32,0.7), rgba(8,12,16,0.7));">
          <div class="panel-title">Select mode</div>
          <button class="btn primary" data-action="quickplay">▶ Deploy — Battle Royale Solo</button>
        </div>
        <div class="mode-grid">
          ${MODE_INFO.map((m) => `
            <div class="mode-card" role="button" tabindex="0" data-action="mode" data-mode="${m.id}">
              <div class="mode-tag">${m.tag}</div>
              <h3>${m.name}</h3>
              <p>${m.body}</p>
              <div class="mode-meta">${m.meta.map((x) => `<span>${x}</span>`).join('')}</div>
            </div>`).join('')}
        </div>
        <div class="panel">
          <div class="panel-title">Recent matches</div>
          ${ctx.history.length === 0
            ? '<div class="hint">No matches yet. Drop in and make some history.</div>'
            : `<table class="stats">${ctx.history.slice(-6).reverse().map((h) => `
                <tr>
                  <td>${esc(h.mode)} ${h.victory ? '<span class="badge good">WIN</span>' : ''}</td>
                  <td>#${h.placement} · ${h.kills} kills · ${Math.round(h.damage)} dmg</td>
                </tr>`).join('')}</table>`}
        </div>
        <div class="panel">
          <div class="panel-title">Field manual</div>
          <div class="key-grid">
            ${QUICK_KEYS.map(([label, key]) => `<div class="key-row"><span>${label}</span><kbd>${key}</kbd></div>`).join('')}
          </div>
          <button class="btn" data-action="help" style="margin-top:14px;">Open full controls &amp; rules</button>
        </div>
      </div>
    </div>
    <div class="menu-foot">
      <span><span class="dot"></span>All systems nominal · offline bots ready</span>
      <span>v1.0 · original build · desktop first</span>
    </div>
  </div>`;
}

function xpPercent(ctx: MenuContext): number {
  const need = 500 + ctx.profile.level * 250;
  return Math.max(3, Math.min(100, (ctx.profile.xp / need) * 100));
}

function segButton(value: string, current: string): string {
  return `<button data-value="${value}" class="${value === current ? 'on' : ''}">${value}</button>`;
}

export function setupScreen(mode: 'BR' | 'CLASH' | 'LONE' | 'TRAINING', ctx: MenuContext): string {
  const title = mode === 'BR' ? 'Battle Royale' : mode === 'CLASH' ? 'Clash Squad' : mode === 'LONE' ? 'Lone Wolf' : 'Training';
  const sub = mode === 'BR'
    ? 'Choose your squad size and drop difficulty, then board the dropship.'
    : mode === 'CLASH'
      ? 'Four versus four. Buy phase between rounds, first to four round wins takes it.'
      : mode === 'LONE'
        ? 'One versus one duel. Identical loadouts, best of five rounds.'
        : 'Warm up on the range: every weapon, unlimited ammo, targets at three distances.';
  return `
  <div class="screen" id="screen-setup">
    ${topStrip('Back', 'back')}
    <div class="menu-body" style="grid-template-columns:minmax(320px,460px) 1fr;">
      <div class="panel">
        <div class="panel-title">${title}</div>
        <p class="tips" style="margin-bottom:16px;">${sub}</p>
        ${mode === 'BR' ? `
        <div class="opt-row">
          <label>Squad</label>
          <div class="seg" data-seg="teamSize">
            <button data-value="1" class="on">SOLO</button>
            <button data-value="2">DUO</button>
            <button data-value="4">SQUAD</button>
          </div>
        </div>
        <div class="opt-row">
          <label>Lobby size</label>
          <div class="seg" data-seg="playerCount">
            <button data-value="20">20</button>
            <button data-value="30" class="on">30</button>
            <button data-value="50">50</button>
            <button data-value="60">60</button>
          </div>
        </div>` : ''}
        ${mode === 'CLASH' ? `
        <div class="opt-row">
          <label>Round target</label>
          <div class="seg" data-seg="roundTarget">
            <button data-value="4" class="on">FIRST TO 4</button>
            <button data-value="5">FIRST TO 5</button>
          </div>
        </div>
        <div class="opt-row">
          <label>Starting cash</label>
          <div class="seg" data-seg="startCash">
            <button data-value="800" class="on">800</button>
            <button data-value="1200">1200</button>
            <button data-value="2000">2000</button>
          </div>
        </div>` : ''}
        ${mode === 'LONE' ? `
        <div class="opt-row">
          <label>Rounds</label>
          <div class="seg" data-seg="roundTarget">
            <button data-value="3" class="on">BEST OF 3</button>
            <button data-value="5">BEST OF 5</button>
          </div>
        </div>` : ''}
        ${mode === 'TRAINING' ? `
        <div class="opt-row">
          <label>Dummies</label>
          <div class="seg" data-seg="dummies">
            <button data-value="static" class="on">STATIC</button>
            <button data-value="moving">MOVING</button>
          </div>
        </div>` : ''}
        <div class="opt-row">
          <label>Bot difficulty</label>
          <div class="seg" data-seg="difficulty">
            ${segButton('EASY', ctx.botDifficulty)}
            ${segButton('NORMAL', ctx.botDifficulty)}
            ${segButton('HARD', ctx.botDifficulty)}
            ${segButton('ELITE', ctx.botDifficulty)}
          </div>
        </div>
        <button class="btn primary" data-action="start" data-mode="${mode}" style="margin-top:18px;">▶ Start</button>
      </div>
      <div class="panel">
        <div class="panel-title">Briefing</div>
        <div class="tips">
          ${mode === 'BR' ? `
            <p><b>Dropship:</b> you spawn aboard. Press <code>Space</code> to jump, then hold <code>W</code> while falling to glide.</p>
            <p><b>Chute:</b> it deploys automatically at low altitude — or press <code>Space</code> early to open it yourself.</p>
            <p><b>Zone:</b> the ring shrinks in seven phases. Watch the timer in the top-right and rotate early.</p>` : ''}
          ${mode === 'CLASH' ? `
            <p><b>Buy phase:</b> 15 seconds before each round. Spend cash on weapons, armour and utility.</p>
            <p><b>Rounds:</b> wipe the enemy team or capture the objective. Losing team gets a bonus.</p>` : ''}
          ${mode === 'LONE' ? `
            <p><b>Loadout:</b> identical weapons each round — this fight is pure aim and movement.</p>` : ''}
          ${mode === 'TRAINING' ? `
            <p><b>Everything unlocked:</b> walk to the armoury table and pick any weapon from the loadout screen.</p>
            <p><b>Try the vehicles:</b> a car and a bike are parked on the pad east of the firing line.</p>` : ''}
          <p><b>Controls:</b> <code>WASD</code> move · <code>Shift</code> sprint · <code>C</code> crouch · <code>Z</code> prone ·
          <code>LMB</code> fire · <code>RMB</code> aim · <code>R</code> reload · <code>F</code> interact ·
          <code>1-4</code> weapons · <code>G</code> grenade · <code>H</code> heal · <code>Tab</code> inventory ·
          <code>M</code> map · <code>P</code> scoreboard · <code>Esc</code> pause</p>
        </div>
      </div>
    </div>
  </div>`;
}

export function lobbyScreen(ctx: { mode: string; teamSize: number; playerCount: number; seconds: number; mapName: string; difficulty: string }): string {
  return `
  <div class="screen" id="screen-lobby">
    ${topStrip('Leave', 'leave')}
    <div class="menu-body" style="grid-template-columns:1fr minmax(320px,420px);">
      <div class="panel" style="display:flex;flex-direction:column;">
        <div class="panel-title">${esc(ctx.mode)} · ${ctx.mapName}</div>
        <div style="flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;">
          <div style="font-family:var(--mono);font-size:64px;letter-spacing:6px;" id="lobby-countdown">${Math.ceil(ctx.seconds)}</div>
          <div class="hint">Dropship departs when the timer hits zero</div>
          <div class="tips" style="max-width:560px;text-align:center;margin-top:10px;">
            <b>Tip:</b> the dropship flies a straight line across the island. Jump early for the outer POIs, late for the city.
          </div>
        </div>
        <button class="btn primary" data-action="ready">Ready up — board dropship</button>
      </div>
      <div class="panel">
        <div class="panel-title">Lobby · ${ctx.playerCount} players</div>
        <div class="kv"><span>Mode</span><span>${esc(ctx.mode)}</span></div>
        <div class="kv"><span>Squad size</span><span>${ctx.teamSize === 1 ? 'Solo' : ctx.teamSize === 2 ? 'Duo' : 'Squad'}</span></div>
        <div class="kv"><span>Difficulty</span><span>${ctx.difficulty}</span></div>
        <div class="squad-roster" style="margin-top:14px;">
          <div class="roster-slot"><div class="tag">SLOT 1</div><div>You</div></div>
          ${ctx.teamSize > 1 ? Array.from({ length: ctx.teamSize - 1 }, (_, i) => `<div class="roster-slot"><div class="tag">SLOT ${i + 2}</div><div>Auto-fill bot</div></div>`).join('') : ''}
        </div>
      </div>
    </div>
  </div>`;
}

export function settingsScreen(ctx: {
  quality: string; fov: number; sensitivity: number; adsSensitivity: number; invertY: boolean;
  volumes: { master: number; music: number; sfx: number; voice: number };
  toggles: { showCrosshair: boolean; damageNumbers: boolean; damageIndicators: boolean; autoPickup: boolean; autoReload: boolean; showFps: boolean; minimapRotate: boolean; showBlood: boolean; firstPerson: boolean };
  keybinds: Record<string, string>;
}): string {
  const qualityButtons = ['AUTO', 'LOW', 'MEDIUM', 'HIGH', 'ULTRA']
    .map((q) => `<button data-value="${q}" class="${q === ctx.quality ? 'on' : ''}">${q}</button>`).join('');
  const preset = QUALITY_PRESETS[(ctx.quality === 'AUTO' ? 'MEDIUM' : ctx.quality) as QualityLevel];
  return `
  <div class="screen" id="screen-settings">
    ${topStrip('Back', 'back')}
    <div class="menu-body" style="grid-template-columns:1fr 1fr;">
      <div class="panel scroll-area">
        <div class="panel-title">Graphics</div>
        <div class="opt-row"><label>Quality preset</label><div class="seg" data-seg="quality">${qualityButtons}</div></div>
        <div class="hint" style="margin:8px 0 14px;">
          ${ctx.quality === 'AUTO' ? 'Auto-detected from your hardware.' : 'Manual preset.'}
          Shadows ${preset.shadows ? 'on' : 'off'} · view ${preset.viewDistance} m · render scale ${preset.renderScale}
        </div>
        <div class="panel-title">Audio</div>
        ${volumeRow('master', 'Master', ctx.volumes.master)}
        ${volumeRow('music', 'Music', ctx.volumes.music)}
        ${volumeRow('sfx', 'Effects', ctx.volumes.sfx)}
        ${volumeRow('voice', 'Callouts', ctx.volumes.voice)}
        <div class="panel-title" style="margin-top:16px;">Gameplay</div>
        ${toggleRow('showCrosshair', 'Crosshair', ctx.toggles.showCrosshair)}
        ${toggleRow('damageNumbers', 'Damage numbers', ctx.toggles.damageNumbers)}
        ${toggleRow('damageIndicators', 'Damage direction', ctx.toggles.damageIndicators)}
        ${toggleRow('autoPickup', 'Auto pickup', ctx.toggles.autoPickup)}
        ${toggleRow('autoReload', 'Auto reload', ctx.toggles.autoReload)}
        ${toggleRow('minimapRotate', 'Rotating minimap', ctx.toggles.minimapRotate)}
        ${toggleRow('showBlood', 'Blood effects', ctx.toggles.showBlood)}
        ${toggleRow('showFps', 'Show FPS', ctx.toggles.showFps)}
        ${toggleRow('firstPerson', 'First person view', ctx.toggles.firstPerson)}
      </div>
      <div class="panel scroll-area">
        <div class="panel-title">Controls</div>
        <div class="opt-row"><label>Look sensitivity</label>${rangeRow('sensitivity', ctx.sensitivity, 0.2, 3, 0.05)}</div>
        <div class="opt-row"><label>Aim sensitivity</label>${rangeRow('adsSensitivity', ctx.adsSensitivity, 0.2, 2, 0.05)}</div>
        <div class="opt-row"><label>Field of view</label>${rangeRow('fov', ctx.fov, 60, 110, 1)}</div>
        ${toggleRow('invertY', 'Invert vertical look', ctx.invertY)}
        <div class="panel-title" style="margin-top:16px;">Keybinds</div>
        <table class="stats">
          ${Object.entries(ctx.keybinds).map(([action, code]) => `
            <tr><td style="text-transform:capitalize;">${action.replace(/([A-Z])/g, ' $1')}</td><td>${code.replace('Key', '').replace('Digit', '')}</td></tr>`).join('')}
        </table>
        <div class="btn-row" style="margin-top:14px;">
          <button class="btn" data-action="reset-keybinds">Reset keybinds</button>
          <button class="btn danger" data-action="reset-settings">Reset everything</button>
        </div>
      </div>
    </div>
  </div>`;
}

function volumeRow(id: string, label: string, value: number): string {
  return `<div class="opt-row"><label>${label}</label>${rangeRow(id, value, 0, 1, 0.05)}</div>`;
}

function rangeRow(id: string, value: number, min: number, max: number, step: number): string {
  return `<div class="range-wrap">
    <input type="range" data-range="${id}" min="${min}" max="${max}" step="${step}" value="${value}">
    <span class="range-val" data-range-val="${id}">${typeof value === 'number' ? value.toFixed(step < 1 ? 2 : 0) : value}</span>
  </div>`;
}

function toggleRow(id: string, label: string, on: boolean): string {
  return `<div class="opt-row"><label>${label}</label><div class="toggle ${on ? 'on' : ''}" data-toggle="${id}"><i></i></div></div>`;
}

export function armoryScreen(ctx: MenuContext & { selected: string }): string {
  const weapon = WEAPONS[ctx.selected];
  const classes: WeaponClass[] = ['AR', 'SMG', 'SHOTGUN', 'DMR', 'SNIPER', 'LMG', 'PISTOL', 'MELEE'];
  return `
  <div class="screen" id="screen-armory">
    ${topStrip('Back', 'back')}
    <div class="menu-body armory">
      <div class="panel scroll-area">
        <div class="panel-title">Weapons</div>
        ${classes.map((cls) => {
          const list = Object.values(WEAPONS).filter((w) => w.cls === cls);
          if (list.length === 0) return '';
          return `<div style="margin-bottom:14px;">
            <div class="hint" style="letter-spacing:3px;margin-bottom:6px;">${cls}</div>
            <div class="item-grid">
              ${list.map((w) => `
                <div class="item-card rarity-${weaponRarity(w)}" data-action="select-weapon" data-id="${w.id}">
                  <h4>${w.name}</h4>
                  <div class="sub">${w.ammo} · ${w.fireModes.join('/')}</div>
                  <div class="stat-row"><span>DMG</span><span>${w.damage}</span></div>
                  <div class="stat-bar"><i style="width:${Math.min(100, w.damage * 1.4)}%"></i></div>
                  <div class="stat-row"><span>RPM</span><span>${w.rpm}</span></div>
                  <div class="stat-row"><span>Falloff</span><span>${w.falloffStart} m</span></div>
                </div>`).join('')}
            </div>
          </div>`;
        }).join('')}
      </div>
      <div class="panel scroll-area">
        <div class="panel-title">Details</div>
        ${weapon ? `
          <h3 style="font-size:24px;letter-spacing:2px;color:${RARITY_COLOR[weaponRarity(weapon)]}">${weapon.name}</h3>
          <div class="hint" style="margin-bottom:12px;">${weapon.cls} · ${weaponRarity(weapon)} · ${weapon.ammo}</div>
          <div class="hint" style="margin-bottom:10px;">${esc(weapon.description)}</div>
          <table class="stats">
            <tr><td>Damage</td><td>${weapon.damage}${weapon.pellets > 1 ? ` × ${weapon.pellets} pellets` : ''}</td></tr>
            <tr><td>Headshot multiplier</td><td>${weapon.headMult.toFixed(2)}×</td></tr>
            <tr><td>Limb multiplier</td><td>${weapon.limbMult.toFixed(2)}×</td></tr>
            <tr><td>Fire rate</td><td>${weapon.rpm} rpm</td></tr>
            <tr><td>Magazine</td><td>${weapon.magSize}</td></tr>
            <tr><td>Reload</td><td>${weapon.reloadTime.toFixed(2)} s</td></tr>
            <tr><td>Damage falloff</td><td>${weapon.falloffStart} – ${weapon.falloffEnd} m</td></tr>
            <tr><td>Bullet speed</td><td>${weapon.bulletSpeed} m/s</td></tr>
            <tr><td>Recoil (vert/horiz)</td><td>${weapon.recoilVertical.toFixed(2)} / ${weapon.recoilHorizontal.toFixed(2)}</td></tr>
            <tr><td>Spread (hip / ads)</td><td>${weapon.spreadHip.toFixed(2)} / ${weapon.spreadAds.toFixed(2)}</td></tr>
            <tr><td>ADS zoom</td><td>${weapon.adsZoom.toFixed(2)}×</td></tr>
          </table>
          <div class="panel-title" style="margin-top:16px;">Attachments available</div>
          ${Object.values(ATTACHMENTS).filter((a) => a.fits.includes(weapon.cls)).map((a) => `
            <div class="kv"><span>${a.name} <span class="badge">${a.slot}</span></span><span>${describeMods(a.mods)}</span></div>`).join('') || '<div class="hint">No attachments for this class.</div>'}
        ` : '<div class="hint">Select a weapon to inspect it.</div>'}
        <div class="panel-title" style="margin-top:16px;">Gear</div>
        <div class="item-grid">
          ${Object.values(GEAR).map((g) => `
            <div class="item-card rarity-${g.rarity}">
              <h4>${g.name}</h4>
              <div class="sub">${g.slot} · ${g.rarity}</div>
              <div class="stat-row"><span>${g.slot === 'HELMET' ? 'Head reduction' : g.slot === 'ARMOR' ? 'Armour points' : 'Capacity'}</span><span>${g.value}</span></div>
            </div>`).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

function describeMods(mods: object): string {
  const parts = Object.entries(mods as Record<string, unknown>).map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()} ${typeof v === 'number' ? (v > 1 ? `+${((v - 1) * 100).toFixed(0)}%` : `×${v.toFixed(2)}`) : String(v)}`);
  return parts.join(' · ') || '—';
}

/** Maps a weapon's tier bias to the rarity colour used across the UI. */
export function tierRarity(tier: number): Rarity {
  if (tier >= 4) return 'EPIC';
  if (tier === 3) return 'RARE';
  if (tier === 2) return 'UNCOMMON';
  return 'COMMON';
}

function weaponRarity(w: WeaponDef): Rarity {
  return tierRarity(w.tier);
}

export function progressionScreen(ctx: MenuContext): string {
  const s = ctx.stats;
  const acc = s.shotsFired > 0 ? ((s.shotsHit / s.shotsFired) * 100).toFixed(1) : '0.0';
  const hs = s.kills > 0 ? ((s.headshots / s.kills) * 100).toFixed(0) : '0';
  return `
  <div class="screen" id="screen-progression">
    ${topStrip('Back', 'back')}
    <div class="menu-body" style="grid-template-columns:minmax(300px,380px) 1fr;">
      <div class="panel">
        <div class="panel-title">Operator</div>
        <h3 style="font-size:26px;letter-spacing:2px;">${esc(ctx.profile.name)}</h3>
        <div class="hint" style="margin-bottom:12px;">Level ${ctx.profile.level} · ${ctx.profile.xp} XP · ◈ ${ctx.profile.coins}</div>
        <div class="xp-bar"><i style="width:${xpPercent(ctx)}%"></i></div>
        <div class="opt-row" style="margin-top:14px;">
          <label>Callsign</label>
          <input id="name-input" value="${esc(ctx.profile.name)}" maxlength="16"
            style="background:var(--bg-1);border:1px solid var(--line);color:var(--text);font-family:var(--mono);padding:6px 9px;width:150px;">
        </div>
        <button class="btn" data-action="set-name" style="margin-top:10px;">Save callsign</button>
      </div>
      <div class="panel scroll-area">
        <div class="panel-title">Career statistics</div>
        <div class="result-grid">
          ${resultCell('Matches', s.matches)}
          ${resultCell('Wins', s.wins, true)}
          ${resultCell('Kills', s.kills)}
          ${resultCell('K/D', s.deaths > 0 ? (s.kills / s.deaths).toFixed(2) : String(s.kills))}
          ${resultCell('Headshots', s.headshots)}
          ${resultCell('HS rate', `${hs}%`)}
          ${resultCell('Accuracy', `${acc}%`)}
          ${resultCell('Damage', Math.round(s.damage).toLocaleString())}
          ${resultCell('Revives', s.revives)}
        </div>
        <div class="panel-title">Achievements</div>
        <table class="stats">
          ${ACHIEVEMENTS.map((a) => {
            const unlocked = ctx.profile.achievements.includes(a.id);
            return `<tr><td>
              <div style="color:${unlocked ? 'var(--text)' : 'var(--text-mute)'}">${a.name}</div>
              <div class="hint">${a.desc}</div></td>
              <td>${unlocked ? '<span class="badge good">UNLOCKED</span>' : '<span class="badge">LOCKED</span>'}</td></tr>`;
          }).join('')}
        </table>
        <div class="panel-title" style="margin-top:14px;">Match history</div>
        ${ctx.history.length === 0 ? '<div class="hint">No matches recorded yet.</div>' : `
        <table class="stats">
          ${ctx.history.slice(-12).reverse().map((h) => `
            <tr>
              <td>${esc(h.mode)}${h.victory ? ' <span class="badge good">WIN</span>' : ''}</td>
              <td>#${h.placement} · ${h.kills} kills · ${Math.round(h.damage)} dmg · ${formatTime(h.survivalTime)}</td>
            </tr>`).join('')}
        </table>`}
      </div>
    </div>
  </div>`;
}

function resultCell(label: string, value: string | number, highlight = false): string {
  return `<div class="result-cell ${highlight ? 'highlight' : ''}"><div class="v">${value}</div><div class="k">${label}</div></div>`;
}

export function resultsScreen(result: {
  victory: boolean;
  placement: number;
  kills: number;
  damage: number;
  headshots: number;
  survivalTime: number;
  accuracy: number;
  revives: number;
  xp: number;
  coins: number;
  level: number;
  unlocked: string[];
  mode: string;
}): string {
  return `
  <div class="screen" id="screen-results">
    <div class="menu-body" style="grid-template-columns:1fr;max-width:1100px;margin:0 auto;">
      <div class="panel">
        <div class="result-banner">
          <h1 class="${result.victory ? 'win' : 'lose'}">${result.victory ? 'Victory' : 'Eliminated'}</h1>
          <div class="placement">${esc(result.mode)} · PLACEMENT #${result.placement}</div>
        </div>
        <div class="result-grid">
          ${resultCell('Kills', result.kills, result.kills > 0)}
          ${resultCell('Damage', Math.round(result.damage))}
          ${resultCell('Headshots', result.headshots)}
          ${resultCell('Accuracy', `${result.accuracy.toFixed(1)}%`)}
          ${resultCell('Survived', formatTime(result.survivalTime))}
          ${resultCell('Revives', result.revives)}
          ${resultCell('XP earned', `+${result.xp}`)}
          ${resultCell('Coins', `+${result.coins}`)}
        </div>
        ${result.unlocked.length > 0 ? `<div class="hint" style="margin-bottom:12px;">Unlocked: ${result.unlocked.join(', ')}</div>` : ''}
        <div class="xp-bar" style="margin-bottom:16px;"><i style="width:${xpPercent({ profile: { level: result.level } } as MenuContext)}%"></i></div>
        <div class="btn-row">
          <button class="btn primary" data-action="play-again">▶ Play again</button>
          <button class="btn" data-action="to-menu">Main menu</button>
          <button class="btn" data-action="progression">Progression</button>
        </div>
      </div>
    </div>
  </div>`;
}

export function pauseMenuScreen(mode: string, clash: { active: boolean; cash: number; round: number; scoreUs: number; scoreThem: number } | null): string {
  return `
  <div class="overlay hidden" id="overlay-pause">
    <div class="panel pause-menu">
      <div class="panel-title">Paused · ${esc(mode)}</div>
      ${clash && clash.active ? `<div class="kv"><span>Round ${clash.round}</span><span>${clash.scoreUs} — ${clash.scoreThem}</span></div>
        <div class="kv"><span>Cash</span><span>◈ ${clash.cash}</span></div>` : ''}
      <button class="btn" data-action="resume">Resume</button>
      <button class="btn" data-action="settings">Settings</button>
      <button class="btn" data-action="controls">Controls</button>
      <button class="btn danger" data-action="leave">Leave match</button>
    </div>
  </div>`;
}

export function controlsOverlay(): string {
  return `
  <div class="overlay hidden" id="overlay-controls">
    <div class="panel">
      <div class="panel-title">Controls</div>
      <div class="tips" style="columns:2;column-gap:34px;">
        <p><code>W A S D</code> — move</p>
        <p><code>Shift</code> — sprint</p>
        <p><code>C</code> — crouch · <code>Z</code> — prone</p>
        <p><code>Space</code> — jump / parachute</p>
        <p><code>Left mouse</code> — fire</p>
        <p><code>Right mouse</code> — aim down sights</p>
        <p><code>R</code> — reload · <code>B</code> — fire mode</p>
        <p><code>1 2 3 4</code> — weapon slots · <code>wheel</code> — cycle</p>
        <p><code>G</code> — grenade · <code>H</code> — heal</p>
        <p><code>F</code> — interact / loot / revive</p>
        <p><code>E</code> — exit vehicle</p>
        <p><code>Tab</code> — inventory · <code>M</code> — map</p>
        <p><code>P</code> — scoreboard · <code>Esc</code> — pause</p>
        <p><code>Q</code> — previous spectate target</p>
      </div>
      <button class="btn" data-action="close-controls" style="margin-top:16px;">Close</button>
    </div>
  </div>`;
}

export function scoreboardOverlay(rows: { name: string; kills: number; damage: number; alive: boolean; isYou: boolean; team: number }[], alive: number, total: number): string {
  const sorted = [...rows].sort((a, b) => (b.kills - a.kills) || (b.damage - a.damage));
  return `
  <div class="overlay hidden" id="overlay-scoreboard">
    <div class="panel">
      <div class="panel-title">Scoreboard · ${alive}/${total} alive</div>
      <div class="panel-body">
        <table class="stats">
          <thead><tr><td>Player</td><td>Kills</td></tr></thead>
          <tbody>
            ${sorted.map((r) => `
              <tr style="${r.isYou ? 'color:var(--accent)' : r.alive ? '' : 'opacity:0.5;'}">
                <td>${esc(r.name)}${r.isYou ? ' <span class="badge live">YOU</span>' : ''}${r.alive ? '' : ' <span class="badge">OUT</span>'}</td>
                <td>${r.kills} · ${Math.round(r.damage)} dmg</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;
}

export function inventoryOverlay(actor: {
  weapons: { slot: number; name: string; rarity: string; ammo: string; attachments: string[] }[];
  items: { name: string; count: number }[];
  gear: { armor: string; helmet: string; backpack: string };
  capacity: { used: number; max: number };
  ammo: { type: string; count: number }[];
}): string {
  return `
  <div class="overlay hidden" id="overlay-inventory">
    <div class="panel">
      <div class="panel-title">Inventory · ${actor.capacity.used}/${actor.capacity.max} space</div>
      <div class="panel-body">
        <div class="armory">
          <div>
            <div class="hint" style="letter-spacing:3px;margin-bottom:8px;">WEAPONS</div>
            <div class="item-grid">
              ${actor.weapons.length === 0 ? '<div class="hint">No weapons — loot something.</div>' : actor.weapons.map((w) => `
                <div class="item-card rarity-${w.rarity}">
                  <h4>${esc(w.name)}</h4>
                  <div class="sub">SLOT ${w.slot + 1} · ${esc(w.ammo)}</div>
                  <div class="stat-row"><span>Attachments</span><span>${w.attachments.length > 0 ? esc(w.attachments.join(', ')) : 'none'}</span></div>
                  <button class="btn ghost" data-action="drop-weapon" data-slot="${w.slot}" style="margin-top:8px;">Drop</button>
                </div>`).join('')}
            </div>
            <div class="hint" style="letter-spacing:3px;margin:16px 0 8px;">CONSUMABLES & UTILITY</div>
            <div class="item-grid">
              ${actor.items.length === 0 ? '<div class="hint">Nothing in your pack.</div>' : actor.items.map((i) => `
                <div class="item-card"><h4>${esc(i.name)}</h4><div class="sub">x${i.count}</div></div>`).join('')}
            </div>
          </div>
          <div>
            <div class="hint" style="letter-spacing:3px;margin-bottom:8px;">GEAR</div>
            <div class="kv"><span>Armour</span><span>${actor.gear.armor ? esc(actor.gear.armor) : '—'}</span></div>
            <div class="kv"><span>Helmet</span><span>${actor.gear.helmet ? esc(actor.gear.helmet) : '—'}</span></div>
            <div class="kv"><span>Backpack</span><span>${actor.gear.backpack ? esc(actor.gear.backpack) : '—'}</span></div>
            <div class="hint" style="letter-spacing:3px;margin:16px 0 8px;">AMMUNITION</div>
            ${actor.ammo.map((a) => `<div class="kv"><span>${a.type}</span><span>${a.count}</span></div>`).join('')}
            <div class="hint" style="margin-top:16px;">Press <code>Tab</code> to close. Hover a weapon and press <code>1-4</code> to equip it.</div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

export function mapOverlay(): string {
  return `
  <div class="overlay hidden" id="overlay-map">
    <div class="panel" style="width:min(760px,92vw);">
      <div class="panel-title">Island map</div>
      <div style="display:flex;justify-content:center;">
        <canvas id="fullmapCanvas" width="640" height="640" style="width:min(640px,78vh);height:min(640px,78vh);border:1px solid var(--line);background:#070a0d;"></canvas>
      </div>
      <div class="hint" style="margin-top:10px;">Blue ring: current zone · dashed: next zone · white marker: you · blue: squad</div>
      <button class="btn" data-action="close-map" style="margin-top:10px;">Close</button>
    </div>
  </div>`;
}

export function buyMenuScreen(cash: number, offers: { id: string; name: string; price: number; kind: string; sub: string; rarity: string }[], seconds: number, round: number): string {
  return `
  <div class="overlay hidden" id="overlay-buy">
    <div class="panel">
      <div class="panel-title">Buy phase · round ${round} · <span style="font-family:var(--mono);color:var(--gold)">◈ ${cash}</span> · <span id="buy-timer">${Math.ceil(seconds)}</span>s</div>
      <div class="panel-body">
        <div class="buy-grid">
          ${offers.map((o) => `
            <div class="item-card rarity-${o.rarity} buy-card ${o.price > cash ? 'cant' : ''}" data-action="buy" data-id="${o.id}" data-price="${o.price}" data-kind="${o.kind}">
              <h4>${esc(o.name)}</h4>
              <div class="sub">${esc(o.sub)}</div>
              <div class="stat-row"><span>${o.kind}</span><span class="price">◈ ${o.price}</span></div>
            </div>`).join('')}
        </div>
      </div>
      <button class="btn primary" data-action="start-round" style="margin-top:14px;">Start round</button>
    </div>
  </div>`;
}

export function roundBanner(round: number, scoreUs: number, scoreThem: number, won: boolean | null): string {
  return `
  <div class="overlay hidden" id="overlay-round">
    <div class="panel pause-menu" style="text-align:center;">
      <div class="panel-title" style="justify-content:center;">Round ${round}</div>
      <h1 style="font-size:40px;letter-spacing:8px;text-transform:uppercase;color:${won === null ? 'var(--text)' : won ? 'var(--gold)' : 'var(--bad)'}">
        ${won === null ? 'Fight' : won ? 'Round won' : 'Round lost'}
      </h1>
      <div class="hint" style="font-size:16px;margin:10px 0 18px;">Score ${scoreUs} — ${scoreThem}</div>
      <button class="btn primary" data-action="continue-round">Continue</button>
    </div>
  </div>`;
}

export function helpScreen(): string {
  return `
  <div class="screen" id="screen-help">
    ${topStrip('Back', 'back')}
    <div class="menu-body" style="grid-template-columns:1fr 1fr;">
      <div class="panel scroll-area">
        <div class="panel-title">How to play</div>
        <div class="tips">
          <p><b>1. Drop.</b> You start aboard the dropship. Press <code>Space</code> to jump, then hold <code>W</code> and steer with the mouse. The parachute opens by itself at low altitude.</p>
          <p><b>2. Loot.</b> Walk over items to pick them up (auto-pickup is on by default) or press <code>F</code>. Weapons arrive loaded. Ammo, armour, helmets and backpacks all matter.</p>
          <p><b>3. Fight.</b> Right mouse aims down sights, left mouse fires. Headshots hurt far more. Bullets travel, so lead distant targets.</p>
          <p><b>4. Survive.</b> The ring shrinks in seven phases. Rotate early, hold buildings, use smoke to cross open ground.</p>
          <p><b>5. Squad.</b> In duo/squad modes you can revive downed teammates: stand next to them and hold <code>F</code>.</p>
        </div>
      </div>
      <div class="panel scroll-area">
        <div class="panel-title">Modes</div>
        <div class="tips">
          <p><b>Battle Royale.</b> Solo, duo or squad. Last one standing wins.</p>
          <p><b>Clash Squad.</b> 4v4 round-based fights with an economy. Score four rounds to win the match.</p>
          <p><b>Lone Wolf.</b> 1v1 duel, best of three or five rounds with identical loadouts.</p>
          <p><b>Training.</b> Free-play range with every weapon available at the armoury table.</p>
        </div>
        <div class="panel-title" style="margin-top:14px;">Performance</div>
        <div class="tips">
          <p>Quality presets scale shadows, draw distance, vegetation density and render resolution. Low-end laptops should use <b>LOW</b> or <b>MEDIUM</b>; the game also adapts the render scale automatically to hold a stable frame rate.</p>
        </div>
      </div>
    </div>
  </div>`;
}

export function touchControls(): string {
  return `
  <div class="touch-controls">
    <div class="touch-stick" data-touch="stick"><i></i></div>
    <div class="touch-buttons">
      <button class="touch-btn fire" data-touch="fire">Fire</button>
      <button class="touch-btn" data-touch="aim">Aim</button>
      <button class="touch-btn" data-touch="jump">Jump</button>
      <button class="touch-btn" data-touch="reload">Reload</button>
      <button class="touch-btn" data-touch="interact">Use</button>
      <button class="touch-btn" data-touch="heal">Heal</button>
    </div>
  </div>`;
}

function topStrip(backLabel: string, action: string): string {
  return `
  <div class="top-strip">
    <div class="brand">
      <div class="brand-mark">APEX<span>ISLAND</span></div>
      <div class="brand-sub">Tactical Battle Royale</div>
    </div>
    <button class="btn ghost" data-action="${action}" style="width:auto;padding:9px 16px;">← ${backLabel}</button>
  </div>`;
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export { MODE_INFO, DEFAULT_KEYBINDS };
