import * as THREE from 'three';
import { CharacterRig } from './CharacterRig';
import { settings } from '../core/Settings';
import { clamp, damp } from '../utils/mathx';

/**
 * The lobby: a lit hangar bay with the player's operator standing on a
 * rotating dais. Rendered instead of the world whenever a menu is on screen,
 * so the game never looks like a web page with panels floating over an empty
 * canvas.
 *
 * Everything here is generated geometry — backdrop, floor, dais, lights and
 * the drifting dust in the key light.
 */
export class LobbyScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.08, 160);

  private readonly rig: CharacterRig;
  private readonly dais = new THREE.Group();
  private readonly key: THREE.SpotLight;
  private readonly rim: THREE.SpotLight;
  private readonly accentLights: THREE.PointLight[] = [];
  private readonly dust: THREE.Points;
  private readonly backdrop: THREE.Mesh;
  private readonly floor: THREE.Mesh;

  private time = 0;
  private spin = 0.35;
  private spinVelocity = 0;
  private dragging = false;
  private distance = 4.35;
  private targetDistance = 4.35;
  private height = 1.62;
  private readonly lookAt = new THREE.Vector3(0, 1.05, 0);

  constructor(paletteIndex = 0, weaponId = 'vk77') {
    const scene = this.scene;
    scene.background = new THREE.Color(0x05070a);

    /* ---------------- Backdrop: gradient hangar shell ---------------- */
    const shellGeo = new THREE.CylinderGeometry(30, 30, 26, 40, 1, true);
    paintVerticalGradient(shellGeo, new THREE.Color(0x0b141d), new THREE.Color(0x020407), 26);
    this.backdrop = new THREE.Mesh(shellGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false }));
    this.backdrop.position.y = 8;
    scene.add(this.backdrop);

    // Angular structural ribs give the bay scale and depth.
    const ribMat = new THREE.MeshStandardMaterial({ color: 0x141d26, roughness: 0.85, metalness: 0.35 });
    for (let i = 0; i < 14; i++) {
      const angle = (i / 14) * Math.PI * 2;
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.34, 22, 0.62), ribMat);
      rib.position.set(Math.cos(angle) * 13.5, 9.5, Math.sin(angle) * 13.5);
      rib.rotation.y = -angle;
      scene.add(rib);
    }

    /* ---------------- Floor ---------------- */
    const floorGeo = new THREE.CircleGeometry(30, 48);
    floorGeo.rotateX(-Math.PI / 2);
    this.floor = new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial({ color: 0x0c1219, roughness: 0.52, metalness: 0.42 }));
    this.floor.position.y = -0.001;
    this.floor.receiveShadow = true;
    scene.add(this.floor);

    // Emissive deck lines radiating from the dais.
    const lineMat = new THREE.MeshBasicMaterial({ color: 0x1d3d4f, transparent: true, opacity: 0.55 });
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const line = new THREE.Mesh(new THREE.BoxGeometry(24, 0.012, 0.045), lineMat);
      line.position.set(Math.cos(angle) * 12, 0.004, Math.sin(angle) * 12);
      line.rotation.y = -angle;
      scene.add(line);
    }

    /* ---------------- Dais ---------------- */
    const daisBody = new THREE.Mesh(
      new THREE.CylinderGeometry(1.42, 1.52, 0.22, 8, 1, false),
      new THREE.MeshStandardMaterial({ color: 0x18212b, roughness: 0.42, metalness: 0.62 })
    );
    daisBody.position.y = 0.11;
    daisBody.castShadow = true;
    daisBody.receiveShadow = true;
    this.dais.add(daisBody);

    const daisInlay = new THREE.Mesh(
      new THREE.CylinderGeometry(1.30, 1.30, 0.03, 8, 1, false),
      new THREE.MeshStandardMaterial({ color: 0x22303c, roughness: 0.3, metalness: 0.75, emissive: 0x0b2733, emissiveIntensity: 0.7 })
    );
    daisInlay.position.y = 0.225;
    this.dais.add(daisInlay);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.47, 0.022, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0x63d7ff })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.222;
    this.dais.add(ring);

    scene.add(this.dais);

    /* ---------------- Operator ---------------- */
    // Only one character is on screen here, so the lobby uses the dense build.
    this.rig = new CharacterRig(paletteIndex, { helmet: true, vest: true, detail: 'high' });
    this.rig.setShowcase(true);
    this.rig.setWeapon(weaponId);
    this.rig.root.position.y = 0.22;
    this.dais.add(this.rig.root);

    // Soft contact shadow: cheap, and it works on every quality preset.
    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.62, 24),
      new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true, depthWrite: false, opacity: 0.85 })
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.233;
    this.dais.add(blob);

    /* ---------------- Lights ---------------- */
    scene.add(new THREE.HemisphereLight(0x9dc0e0, 0x161c22, 0.5));

    this.key = new THREE.SpotLight(0xfff3e2, 3.1, 26, 0.62, 0.55, 1.4);
    this.key.position.set(3.2, 6.4, 4.2);
    this.key.target.position.set(0, 1.05, 0);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.bias = -0.0012;
    this.key.shadow.normalBias = 0.02;
    scene.add(this.key, this.key.target);

    this.rim = new THREE.SpotLight(0x76b8ff, 3.4, 26, 0.7, 0.7, 1.2);
    this.rim.position.set(-3.6, 4.6, -4.4);
    this.rim.target.position.set(0, 1.2, 0);
    scene.add(this.rim, this.rim.target);

    const fill = new THREE.PointLight(0x63d7ff, 6, 14, 2);
    fill.position.set(-2.6, 1.6, 2.6);
    scene.add(fill);
    this.accentLights.push(fill);

    const fill2 = new THREE.PointLight(0xff8a4a, 4.5, 12, 2);
    fill2.position.set(3.0, 1.0, -2.4);
    scene.add(fill2);
    this.accentLights.push(fill2);

    /* ---------------- Dust motes ---------------- */
    this.dust = buildDust();
    scene.add(this.dust);

    this.applyQuality();
  }

  /** Swaps the displayed operator (used when cosmetics or loadout change). */
  setOperator(paletteIndex: number, weaponId: string): void {
    void paletteIndex;
    this.rig.setWeapon(weaponId);
  }

  /** Applies the current graphics preset to lobby-only extras. */
  applyQuality(): void {
    const g = settings.graphics;
    this.key.castShadow = g.shadows;
    this.key.shadow.mapSize.set(g.shadowQuality || 512, g.shadowQuality || 512);
    this.dust.visible = g.particleQuality > 0.2;
    this.backdrop.visible = true;
    this.floor.receiveShadow = g.shadows;
  }

  /* ---------------- Interaction ---------------- */

  /** Horizontal drag spins the operator; wheel zooms the camera in/out. */
  pointerDown(): void {
    this.dragging = true;
  }

  pointerMove(dx: number): void {
    if (!this.dragging) return;
    this.spinVelocity += dx * 0.006;
  }

  pointerUp(): void {
    this.dragging = false;
  }

  wheel(delta: number): void {
    this.targetDistance = clamp(this.targetDistance + delta * 0.0022, 2.1, 7.4);
  }

  /* ---------------- Frame ---------------- */

  update(dt: number): void {
    this.time += dt;

    // Idle rotation plus momentum from dragging.
    if (!this.dragging) this.spinVelocity = damp(this.spinVelocity, 0, 1.6, dt);
    this.spin += (0.16 + this.spinVelocity) * dt;
    this.dais.rotation.y = this.spin;

    this.rig.tickShowcase(dt);
    this.rig.root.position.y = 0.22 + Math.sin(this.time * 0.9) * 0.006;

    // Camera: slow arc, breathing height, mouse-wheel dolly.
    this.distance = damp(this.distance, this.targetDistance, 6, dt);
    const orbit = this.time * 0.055;
    const camX = Math.sin(orbit) * this.distance * 0.55;
    const camZ = Math.cos(orbit) * this.distance;
    this.camera.position.set(camX, this.height + Math.sin(this.time * 0.42) * 0.05, camZ);
    this.camera.lookAt(this.lookAt);

    // Key light drifts slightly so highlights move across the gear.
    this.key.position.x = 3.2 + Math.sin(this.time * 0.23) * 0.5;
    for (let i = 0; i < this.accentLights.length; i++) {
      const l = this.accentLights[i];
      l.intensity = (i === 0 ? 6 : 4.5) + Math.sin(this.time * (1.1 + i * 0.4)) * 0.7;
    }
    this.dust.rotation.y = this.time * 0.02;

    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    if (Math.abs(this.camera.aspect - aspect) > 0.001) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    // Composition shift: keep the operator slightly right of centre on wide
    // screens so menu panels have room without covering the model.
    const shift = aspect > 1.35 ? 0.42 : 0;
    this.camera.position.x += shift * this.distance * 0.22;
    this.lookAt.x = shift * 0.18;
    this.camera.lookAt(this.lookAt);
  }

  /**
   * Frees the rig's own attachments. Body geometry is *owned by the shared
   * cache in CharacterRig*, so it is deliberately left alone — disposing it
   * here would break every other character built from the same variant.
   */
  dispose(): void {
    this.rig.dispose();
    for (const light of this.accentLights) light.dispose?.();
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function paintVerticalGradient(geo: THREE.BufferGeometry, top: THREE.Color, bottom: THREE.Color, height: number): void {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) + height / 2;
    const t = clamp(y / height, 0, 1);
    c.copy(bottom).lerp(top, t * t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Radial-gradient blob used as a cheap contact shadow. */
function contactShadowTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(0,0,0,0.72)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.34)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Drifting motes that catch the key light. */
function buildDust(): THREE.Points {
  const count = 160;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 1.2 + Math.random() * 6;
    const a = Math.random() * Math.PI * 2;
    positions[i * 3] = Math.cos(a) * r;
    positions[i * 3 + 1] = 0.4 + Math.random() * 5.5;
    positions[i * 3 + 2] = Math.sin(a) * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0xbfe6ff, size: 0.035, transparent: true, opacity: 0.5, depthWrite: false });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return points;
}
