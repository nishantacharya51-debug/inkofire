import * as THREE from 'three';
import type { Actor } from '../entity/Actor';
import { CharacterRig, SKINS } from './CharacterRig';
import { settings } from '../core/Settings';
import { WEAPONS } from '../items/Items';

/**
 * Owns one animation rig per live actor, plus nameplates and health bars.
 *
 * Distance LOD swaps full rigs for a cheap 3-box stand-in so a 48-player lobby
 * still renders at a stable frame rate.
 */

const RIG_DISTANCE = 46;
const SIMPLE_DISTANCE = 175;
const NAMEPLATE_DISTANCE = 190;

interface ActorView {
  rig: CharacterRig;
  weaponId: string | null;
  sprite: THREE.Sprite | null;
  canvas: HTMLCanvasElement | null;
  ctx: CanvasRenderingContext2D | null;
  texture: THREE.CanvasTexture | null;
  lastHp: number;
  lastLabel: string;
  redrawTimer: number;
  lod: number;
}

function d0(actor: Actor, p: THREE.Vector3): number {
  return actor.distanceTo(p.x, p.y, p.z);
}

function cosmeticFor(id: number): { paletteIndex: number; helmet: boolean; vest: boolean } {
  const h = (id * 2654435761) >>> 0;
  return {
    paletteIndex: h % SKINS.length,
    helmet: h % 3 !== 0,
    vest: h % 2 === 0
  };
}

export class ActorRenderer {
  readonly root = new THREE.Group();
  private views = new Map<number, ActorView>();
  private tmpDir = new THREE.Vector3();

  constructor(private scene: THREE.Scene) {
    this.root.name = 'actors';
    this.scene.add(this.root);
  }

  get count(): number {
    return this.views.size;
  }

  private createView(actor: Actor): ActorView {
    const cos = cosmeticFor(actor.id);
    const rig = new CharacterRig(cos.paletteIndex, { helmet: cos.helmet, vest: cos.vest });
    this.root.add(rig.root);
    this.root.add(rig.simpleRoot);

    let sprite: THREE.Sprite | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    let texture: THREE.CanvasTexture | null = null;
    if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 64;
      ctx = canvas.getContext('2d');
      if (ctx) {
        texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
        sprite = new THREE.Sprite(mat);
        sprite.scale.set(2.2, 0.55, 1);
        sprite.renderOrder = 20;
        this.root.add(sprite);
      }
    }
    return { rig, weaponId: null, sprite, canvas, ctx, texture, lastHp: -1, lastLabel: '', redrawTimer: 0, lod: -1 };
  }

  private drawNameplate(view: ActorView, actor: Actor, isEnemy: boolean, squadVisible: boolean): void {
    if (!view.ctx || !view.canvas || !view.texture) return;
    const ctx = view.ctx;
    const w = view.canvas.width;
    const h = view.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const hpRatio = Math.max(0, Math.min(1, actor.health / actor.maxHealth));
    const accent = isEnemy ? '#ff5d4d' : '#63d7ff';

    // Health bar
    ctx.fillStyle = 'rgba(6,10,14,0.72)';
    ctx.fillRect(24, 6, w - 48, 12);
    ctx.fillStyle = hpRatio > 0.5 ? '#63e08a' : hpRatio > 0.25 ? '#f3c04a' : '#f0553f';
    ctx.fillRect(26, 8, (w - 52) * Math.max(0, hpRatio), 8);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(24, 6, w - 48, 12);

    // Armor pips
    const armorMax = actor.inventory.maxArmorPoints;
    if (armorMax > 0) {
      ctx.fillStyle = '#8fc9ff';
      ctx.fillRect(24, 21, (w - 48) * Math.min(1, actor.inventory.armorPoints / armorMax), 3);
    }

    // Name
    ctx.font = '600 20px "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(actor.name, w / 2 + 1, 51);
    ctx.fillStyle = squadVisible ? '#cfe9ff' : '#ffffff';
    ctx.fillText(actor.name, w / 2, 50);

    if (actor.lifeState === 'DOWNED') {
      ctx.fillStyle = '#ff9d3c';
      ctx.font = '700 18px "Segoe UI", Roboto, sans-serif';
      ctx.fillText('DOWN', w / 2, 30);
    }
    view.texture.needsUpdate = true;
  }

  /** Creates / removes rigs, updates animation and switches LOD. */
  sync(actors: Actor[], dt: number, cameraPos: THREE.Vector3, localActor: Actor | null): void {
    const viewDistance = settings.graphics.viewDistance;
    const seen = new Set<number>();

    for (const actor of actors) {
      if (actor.lifeState === 'DEAD' && actor.moveState === 'DEAD' && actor.survivalTime > 0 && actor.health === 0 && d0(actor, cameraPos) > SIMPLE_DISTANCE) continue;
      seen.add(actor.id);
      let view = this.views.get(actor.id);
      if (!view) {
        view = this.createView(actor);
        this.views.set(actor.id, view);
      }
      const d = actor.distanceTo(cameraPos.x, cameraPos.y, cameraPos.z);

      // LOD
      const lod = d > SIMPLE_DISTANCE ? 2 : d > RIG_DISTANCE ? 1 : 0;
      if (lod !== view.lod) {
        view.lod = lod;
        view.rig.root.visible = lod < 2 && d < viewDistance;
        view.rig.simpleRoot.visible = lod === 2 && d < viewDistance + 120;
        view.rig.setLod(lod === 0 ? 0 : 1);
      } else {
        view.rig.root.visible = lod < 2 && d < viewDistance;
        view.rig.simpleRoot.visible = lod === 2 && d < viewDistance + 120;
      }

      view.rig.update(actor, dt, actor.pitch);

      // Weapon swap only when it actually changes
      const active = actor.inventory.active;
      const weaponId = active ? active.defId : null;
      if (view.weaponId !== weaponId) {
        view.weaponId = weaponId;
        view.rig.setWeapon(weaponId);
      }
      view.rig.setParachute(actor.moveState === 'PARACHUTE');

      // Nameplate
      const isTeammate = !!localActor && actor.id !== localActor.id && actor.team === localActor.team;
      const isEnemy = !isTeammate && !!localActor && actor.id !== localActor.id;
      const showPlate = actor.id !== localActor?.id && d < NAMEPLATE_DISTANCE && (isTeammate || (isEnemy && d < viewDistance * 0.9));
      if (view.sprite) {
        view.sprite.visible = showPlate && actor.lifeState !== 'DEAD';
        const spriteScale = Math.max(1.6, Math.min(6, d * 0.045));
        view.sprite.scale.set(spriteScale, spriteScale * 0.25, 1);
        const headY = actor.position.y + actor.bodyHeight + (actor.stance === 'PRONE' ? -0.55 : 0);
        view.sprite.position.set(actor.position.x, headY + 0.35, actor.position.z);
      }
      const label = `${actor.name}|${Math.round(actor.health)}|${Math.round(actor.inventory.armorPoints)}|${actor.lifeState}`;
      view.redrawTimer += dt;
      if (view.sprite?.visible && (label !== view.lastLabel || view.redrawTimer > 0.4)) {
        view.redrawTimer = 0;
        view.lastLabel = label;
        view.lastHp = actor.health;
        this.drawNameplate(view, actor, !isTeammate, isTeammate);
      }
    }

    for (const [id, view] of this.views) {
      if (seen.has(id)) continue;
      view.rig.dispose();
      if (view.texture) view.texture.dispose();
      this.root.remove(view.rig.root);
      this.root.remove(view.rig.simpleRoot);
      if (view.sprite) {
        this.root.remove(view.sprite);
        (view.sprite.material as THREE.SpriteMaterial).dispose();
      }
      this.views.delete(id);
    }
  }

  /** Local muzzle direction, used to aim the rig's weapon. */
  aimDirection(actor: Actor): { x: number; y: number; z: number } {
    return actor.getAimDirection(this.tmpDir);
  }

  /** Marks a hit so the rig plays a flinch (used by the effects layer). */
  flinch(actorId: number, strength = 1): void {
    const view = this.views.get(actorId);
    if (view) view.rig.flinch(strength);
  }

  getWeaponName(weaponId: string | null): string {
    if (!weaponId) return 'Unarmed';
    return WEAPONS[weaponId]?.name ?? weaponId;
  }

  dispose(): void {
    for (const [, view] of this.views) {
      view.rig.dispose();
      if (view.texture) view.texture.dispose();
      if (view.sprite) (view.sprite.material as THREE.SpriteMaterial).dispose();
    }
    this.views.clear();
    this.scene.remove(this.root);
  }
}
