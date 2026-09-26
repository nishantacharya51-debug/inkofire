# Apex Island — Browser Battle Royale

A complete, original 3D battle-royale shooter that runs entirely in the browser
(TypeScript + Three.js + Vite). No game engine download, no external art or
audio assets — every texture, model, sound and map is generated procedurally in
code.

**Play it:** https://nishantacharya51-debug.github.io/secretnishantfwh/play/

*(the older "Secret ICT Call Room" page still owns the site root —
https://nishantacharya51-debug.github.io/secretnishantfwh/ — and a copy of it
ships with the game at `/secretnishantfwh/play/ict/`)*

> **Want the game on the plain URL?** Set
> **Settings → Pages → Source → GitHub Actions**, or just ask — the workflow can
> publish the game at `/secretnishantfwh/` with the previous page moved to
> `/secretnishantfwh/ict/`. No files are lost and no paid plan is involved (the
> repository is public).
>
> **Renaming the repository changes the URL.** GitHub Pages URLs follow the repo
> name, so after a rename the game moves to
> `https://<user>.github.io/<new-repo-name>/play/`.

## Game modes

| Mode | Description |
| --- | --- |
| **Battle Royale** | 30–60 players, dropship, skydive, parachute, loot, shrinking zone, last one standing |
| **Clash Squad** | 4v4 rounds with a buy phase and a cash economy between rounds |
| **Lone Wolf** | 1v1 rounds, best of 3 or 5 |
| **Training** | Free-play shooting range with static or patrolling targets |

Squads (solo / duo / squad) support knockdown + revive, vehicles (car,
motorcycle, buggy), per-limb damage, weapon attachments, healing items,
throwables and full bot AI with four difficulty tiers.

## Controls

| Input | Action |
| --- | --- |
| `W A S D` | Move |
| `Shift` | Sprint |
| `C` / `Z` | Crouch / prone |
| `Space` | Jump, deploy from the dropship |
| Mouse | Look, left-click fire, right-click aim |
| `R` | Reload |
| `1`-`4` | Weapon slots |
| `F` | Interact (pick up loot, enter vehicle, revive) |
| `H` | Use healing item |
| `G` | Throw grenade |
| `Tab` | Inventory |
| `M` | Map |
| `V` | Enter / exit vehicle |
| `Esc` | Pause menu |

Touch controls (virtual sticks and buttons) are wired for mobile browsers.

## Repository layout

```
game/               the game itself
  src/core/         engine, input, settings, save data, state machine, pooling
  src/world/        terrain, map layout, collision
  src/render/       world renderer, character rigs, effects
  src/player/       locomotion + player controller
  src/combat/       weapon system, ballistics
  src/ai/           navigation grid, bot brains
  src/modes/        battle royale, arena modes (clash squad / lone wolf / training)
  src/ui/           menus, HUD, minimap, styles
  src/audio/        procedural WebAudio sound
  src/network/      transport seam (local + WebSocket) for future multiplayer
  scripts/          headless test harnesses (simulation, world check, QA)
index.html          the original ICT call-room page (kept at /ict/ when deployed)
```

## Development

```bash
cd game
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build into game/dist
npm run preview    # serve the production build
```

Headless verification (no browser required):

```bash
cd game
bash scripts/run.sh scripts/worldcheck.ts        # map generation sanity
bash scripts/run.sh scripts/simulate.ts 12345 30 600   # full bot match
bash scripts/run.sh scripts/qa.ts                # full app: menus -> match -> results
```

## Deployment

`.github/workflows/deploy-pages.yml` builds `game/` with Vite and publishes
`game/dist` to **GitHub Pages** on every push to `main` — free for public
repositories, no extra hosting service required. The previous page in this
repository is copied to `/ict/` during the deploy so nothing is lost.

The production build is a plain static bundle, so the same `game/dist` folder
also deploys as-is to Netlify, Vercel or Cloudflare Pages.
