import * as THREE from 'three';
import type { Actor } from '../entity/Actor';
import type { ExplosionEvent } from '../combat/Ballistics';
import { Textures } from '../utils/textures';
import { settings } from '../core/Settings';

/**
 * Pooled combat VFX: tracers, impacts, sparks, blood, muzzle flashes, shells and
 * explosions. Everything is pre-allocated; nothing allocates during a fight.
 */

interface Spark {
  life: number;
  maxLife: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  size: number;
  r: number; g: number; b: number;
}

const MAX_TRACERS = 96;
const MAX_SPARKS = 700;
const MAX_SHELLS = 28;
const MAX_BLOOD = 320;
const MAX_EXPLOSIONS = 6;
const MAX_FLASHES = 14;

export class CombatEffects {
  readonly root = new THREE.Group();

  private tracers: { mesh: THREE.Mesh; life: number }[] = [];
  private tracerIndex = 0;

  private sparkGeo: THREE.BufferGeometry;
  private sparkPoints: THREE.Points;
  /** Particle shader materials (kept for the shared pixel-scale uniform). */
  private particleMaterials: THREE.ShaderMaterial[] = [];
  /** Camera FOV in degrees, used to size particles correctly. */
  cameraFovHint = 75;
  private sparks: Spark[] = [];
  private sparkCursor = 0;

  private bloodGeo: THREE.BufferGeometry;
  private bloodPoints: THREE.Points;
  private blood: Spark[] = [];
  private bloodCursor = 0;

  private flashes: { sprite: THREE.Sprite; life: number; maxLife: number }[] = [];
  private flashIndex = 0;
  private flashLight: THREE.PointLight;

  private shells: { mesh: THREE.Mesh; life: number; vx: number; vy: number; vz: number; spin: number }[] = [];
  private shellIndex = 0;

  private explosions: { group: THREE.Group; life: number; maxLife: number; radius: number }[] = [];
  private explosionIndex = 0;

  private decals: THREE.Mesh[] = [];
  private decalIndex = 0;
  private tmpQuat = new THREE.Quaternion();
  private tmpVec = new THREE.Vector3();
  private tmpUp = new THREE.Vector3(0, 1, 0);

  constructor(private scene: THREE.Scene) {
    this.root.name = 'vfx';
    this.scene.add(this.root);

    const quality = settings.graphics.particleQuality;

    /* ---- Tracers ---- */
    const tracerGeo = new THREE.CylinderGeometry(0.022, 0.022, 1, 4, 1, true);
    tracerGeo.rotateX(Math.PI / 2);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffd98a,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    for (let i = 0; i < MAX_TRACERS; i++) {
      const mesh = new THREE.Mesh(tracerGeo, tracerMat.clone());
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }

    /* ---- Sparks ---- */
    const sparkCount = Math.floor(MAX_SPARKS * Math.max(0.25, quality));
    this.sparkGeo = new THREE.BufferGeometry();
    const sp = new Float32Array(sparkCount * 3);
    const sc = new Float32Array(sparkCount * 3);
    const ss = new Float32Array(sparkCount);
    this.sparkGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.sparkGeo.setAttribute('color', new THREE.BufferAttribute(sc, 3));
    this.sparkGeo.setAttribute('size', new THREE.BufferAttribute(ss, 1));
    this.sparkGeo.setDrawRange(0, 0);
    (this.sparkGeo as THREE.BufferGeometry & { drawRange: { start: number; count: number } }).drawRange = { start: 0, count: 0 };
    this.sparkPoints = new THREE.Points(
      this.sparkGeo,
      this.makeParticleMaterial(Textures.particle('spark'), 0.22)
    );
    this.sparkPoints.frustumCulled = false;
    this.root.add(this.sparkPoints);

    /* ---- Blood ---- */
    const bloodCount = Math.floor(MAX_BLOOD * Math.max(0.3, quality));
    this.bloodGeo = new THREE.BufferGeometry();
    this.bloodGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bloodCount * 3), 3));
    this.bloodGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(bloodCount * 3), 3));
    this.bloodGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(bloodCount), 1));
    this.bloodPoints = new THREE.Points(
      this.bloodGeo,
      this.makeParticleMaterial(Textures.particle('blood'), 0.3)
    );
    this.bloodPoints.frustumCulled = false;
    this.root.add(this.bloodPoints);

    /* ---- Muzzle flashes ---- */
    const flashTexture = Textures.particle('flare');
    for (let i = 0; i < MAX_FLASHES; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: flashTexture,
          color: 0xffd9a0,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
      );
      sprite.visible = false;
      this.root.add(sprite);
      this.flashes.push({ sprite, life: 0, maxLife: 0.06 });
    }
    this.flashLight = new THREE.PointLight(0xffcf8a, 0, 14, 2);
    this.flashLight.visible = false;
    this.root.add(this.flashLight);

    /* ---- Shells ---- */
    const shellGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.05, 6);
    const shellMat = new THREE.MeshStandardMaterial({ color: 0xc9a34a, metalness: 0.85, roughness: 0.3 });
    for (let i = 0; i < MAX_SHELLS; i++) {
      const mesh = new THREE.Mesh(shellGeo, shellMat);
      mesh.visible = false;
      this.root.add(mesh);
      this.shells.push({ mesh, life: 0, vx: 0, vy: 0, vz: 0, spin: 0 });
    }

    /* ---- Explosions ---- */
    const fireballGeo = new THREE.SphereGeometry(1, 12, 10);
    const ringGeo = new THREE.RingGeometry(0.6, 1, 24, 1);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < MAX_EXPLOSIONS; i++) {
      const group = new THREE.Group();
      const fireball = new THREE.Mesh(
        fireballGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffa23c,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false
        })
      );
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffd9a0,
          transparent: true,
          opacity: 0.75,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      );
      const light = new THREE.PointLight(0xffb05a, 0, 30, 2);
      group.add(fireball, ring, light);
      group.visible = false;
      this.root.add(group);
      this.explosions.push({ group, life: 0, maxLife: 0.75, radius: 6 });
    }

    /* ---- Bullet decals ---- */
    const decalGeo = new THREE.PlaneGeometry(0.16, 0.16);
    const decalMat = new THREE.MeshBasicMaterial({
      map: Textures.particle('dust'),
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      color: 0x22201c
    });
    const decalCount = settings.resolvedQuality === 'LOW' ? 24 : settings.resolvedQuality === 'MEDIUM' ? 40 : 64;
    for (let i = 0; i < decalCount; i++) {
      const mesh = new THREE.Mesh(decalGeo, decalMat);
      mesh.visible = false;
      this.root.add(mesh);
      this.decals.push(mesh);
    }
  }

  /**
   * Particle material with a per-particle world size.
   * `THREE.PointsMaterial` has a single global size, so sparks/blood use a small
   * shader that reads the `size` attribute and scales it by perspective.
   */
  private makeParticleMaterial(map: THREE.Texture, opacity: number): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map },
        uOpacity: { value: opacity },
        // Pixels per world-unit at one metre (kept in sync with the viewport).
        uScale: { value: 520 }
      },
      vertexShader: `
        attribute float size;
        uniform float uScale;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = max(0.25, -mv.z);
          gl_PointSize = clamp(size * uScale / dist, 1.0, 190.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform float uOpacity;
        varying vec3 vColor;
        void main() {
          vec4 tex = texture2D(uMap, gl_PointCoord);
          float a = tex.a * uOpacity;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor * tex.rgb, a);
        }`,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      blending: THREE.AdditiveBlending
    });
    this.particleMaterials.push(material);
    return material;
  }

  /** Keeps the particle size scale consistent with the current viewport/FOV. */
  private syncParticleScale(): void {
    if (typeof window === 'undefined') return;
    const fov = (this.cameraFovHint ?? 75) * Math.PI / 180;
    const scale = (window.innerHeight || 720) / (2 * Math.tan(fov / 2));
    for (const mat of this.particleMaterials) mat.uniforms.uScale.value = scale;
  }

  /* ------------------------------------------------------------------ */
  /* Emitters                                                           */
  /* ------------------------------------------------------------------ */

  tracer(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, isLocal: boolean): void {
    const entry = this.tracers[this.tracerIndex];
    this.tracerIndex = (this.tracerIndex + 1) % this.tracers.length;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.05) return;
    const mesh = entry.mesh;
    mesh.visible = true;
    mesh.position.set(x0 + dx * 0.5, y0 + dy * 0.5, z0 + dz * 0.5);
    this.tmpVec.set(dx, dy, dz).normalize();
    this.tmpQuat.setFromUnitVectors(this.tmpUp, this.tmpVec);
    mesh.quaternion.copy(this.tmpQuat);
    mesh.scale.set(1, 1, len);
    entry.life = 0.055;
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.opacity = isLocal ? 0.9 : 0.65;
  }

  /** Spawns sparks + a decal for a bullet impact. */
  impact(x: number, y: number, z: number, nx: number, ny: number, nz: number, surface: string, isLocal: boolean): void {
    const isMetal = surface.includes('metal') || surface.includes('concrete') || surface.includes('Steel');
    const isFlesh = surface.includes('flesh') || surface.includes('body');
    const count = Math.round((settings.graphics.particleQuality * (isMetal ? 8 : 5)) | 0);
    for (let i = 0; i < count; i++) {
      const spread = 1.6;
      this.spawnSpark(
        x + nx * 0.02, y + ny * 0.02, z + nz * 0.02,
        nx * 1.6 + (Math.random() - 0.5) * spread,
        ny * 1.6 + (Math.random() - 0.5) * spread + 0.6,
        nz * 1.6 + (Math.random() - 0.5) * spread,
        isMetal ? 0.5 : 0.35,
        isFlesh ? 0.7 : 1.0,
        isFlesh ? 0.12 : 0.62,
        isFlesh ? 0.12 : 0.4
      );
    }
    if (!isFlesh && !isMetal) {
      this.placeDecal(x, y, z, nx, ny, nz);
    }
    void isLocal;
  }

  private spawnSpark(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, r: number, g: number, b: number
  ): void {
    if (this.sparks.length < MAX_SPARKS) {
      this.sparks.push({ life, maxLife: life, x, y, z, vx, vy, vz, size: 0.1, r, g, b });
      return;
    }
    const s = this.sparks[this.sparkCursor];
    this.sparkCursor = (this.sparkCursor + 1) % this.sparks.length;
    s.life = life;
    s.maxLife = life;
    s.x = x; s.y = y; s.z = z;
    s.vx = vx; s.vy = vy; s.vz = vz;
    s.r = r; s.g = g; s.b = b;
  }

  bloodBurst(x: number, y: number, z: number, dx: number, dy: number, dz: number, amount = 1): void {
    if (!settings.data.showBlood) return;
    const count = Math.round(6 * amount * settings.graphics.particleQuality);
    for (let i = 0; i < count; i++) {
      if (this.blood.length < MAX_BLOOD) {
        this.blood.push({
          life: 0.55, maxLife: 0.55,
          x, y, z,
          vx: dx * 1.2 + (Math.random() - 0.5) * 2.2,
          vy: dy * 1.2 + Math.random() * 1.6,
          vz: dz * 1.2 + (Math.random() - 0.5) * 2.2,
          size: 0.14, r: 0.55, g: 0.05, b: 0.05
        });
      } else {
        const s = this.blood[this.bloodCursor];
        this.bloodCursor = (this.bloodCursor + 1) % this.blood.length;
        s.life = 0.55; s.maxLife = 0.55;
        s.x = x; s.y = y; s.z = z;
        s.vx = dx * 1.2 + (Math.random() - 0.5) * 2.2;
        s.vy = dy * 1.2 + Math.random() * 1.6;
        s.vz = dz * 1.2 + (Math.random() - 0.5) * 2.2;
      }
    }
  }

  muzzleFlash(_actor: Actor | null, origin: THREE.Vector3, dir: THREE.Vector3, weaponId: string): void {
    const entry = this.flashes[this.flashIndex];
    this.flashIndex = (this.flashIndex + 1) % this.flashes.length;
    const scale = weaponId.includes('shotgun') || weaponId.includes('762') || weaponId.includes('sniper') ? 0.62 : 0.4;
    entry.sprite.visible = true;
    entry.sprite.position.set(
      origin.x + dir.x * 0.5,
      origin.y + dir.y * 0.5,
      origin.z + dir.z * 0.5
    );
    entry.sprite.scale.setScalar(scale);
    entry.life = entry.maxLife;
    const mat = entry.sprite.material as THREE.SpriteMaterial;
    mat.rotation = Math.random() * Math.PI;
    mat.opacity = 1;

    // Single shared dynamic light: keep it cheap but still punchy in dark rooms.
    this.flashLight.visible = true;
    this.flashLight.position.copy(origin).addScaledVector(dir, 0.4);
    this.flashLight.intensity = 6;
  }

  shellEject(actor: Actor): void {
    const entry = this.shells[this.shellIndex];
    this.shellIndex = (this.shellIndex + 1) % this.shells.length;
    const right = Math.cos(actor.yaw);
    const forwardX = -Math.sin(actor.yaw);
    const forwardZ = -Math.cos(actor.yaw);
    entry.mesh.visible = true;
    entry.mesh.position.set(
      actor.position.x + right * 0.3 + forwardX * 0.3,
      actor.position.y + 1.25,
      actor.position.z - Math.sin(actor.yaw) * 0.3 + forwardZ * 0.3
    );
    entry.vx = right * 2.2 + (Math.random() - 0.5);
    entry.vy = 2.4 + Math.random();
    entry.vz = forwardZ * 0.6;
    entry.spin = Math.random() * 12;
    entry.life = 2.2;
  }

  explosion(ev: ExplosionEvent): void {
    if (ev.kind === 'FLASH') return;
    const entry = this.explosions[this.explosionIndex];
    this.explosionIndex = (this.explosionIndex + 1) % this.explosions.length;
    entry.group.visible = true;
    entry.group.position.set(ev.x, ev.y + 0.4, ev.z);
    entry.radius = ev.radius;
    entry.life = entry.maxLife;
    const light = entry.group.children[2] as THREE.PointLight;
    light.intensity = 60;
    // Ground scorch decal
    this.placeDecal(ev.x, ev.y + 0.03, ev.z, 0, 1, 0, Math.max(2.5, ev.radius * 0.5));
  }

  private placeDecal(x: number, y: number, z: number, nx: number, ny: number, nz: number, scale = 1): void {
    const mesh = this.decals[this.decalIndex];
    this.decalIndex = (this.decalIndex + 1) % this.decals.length;
    mesh.visible = true;
    mesh.position.set(x + nx * 0.02, y + ny * 0.02, z + nz * 0.02);
    this.tmpVec.set(nx, ny, nz).normalize();
    this.tmpQuat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.tmpVec);
    mesh.quaternion.copy(this.tmpQuat);
    mesh.scale.setScalar(scale);
  }

  /* ------------------------------------------------------------------ */
  /* Update                                                             */
  /* ------------------------------------------------------------------ */

  update(dt: number, cameraPos: THREE.Vector3): void {
    this.syncParticleScale();
    // Tracers
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      const mat = t.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.max(0, t.life / 0.055) * 0.9;
      if (t.life <= 0) t.mesh.visible = false;
    }

    // Muzzle flashes
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const mat = f.sprite.material as THREE.SpriteMaterial;
      mat.opacity = Math.max(0, f.life / f.maxLife);
      if (f.life <= 0) f.sprite.visible = false;
    }
    if (this.flashLight.visible) {
      this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * 90);
      const d = this.flashLight.position.distanceTo(cameraPos);
      if (this.flashLight.intensity <= 0.05 || d > 60) this.flashLight.visible = false;
    }

    // Shells
    for (const s of this.shells) {
      if (s.life <= 0) continue;
      s.life -= dt;
      s.vy -= 12 * dt;
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      s.mesh.rotation.x += s.spin * dt;
      s.mesh.rotation.z += s.spin * 0.6 * dt;
      if (s.mesh.position.y < 0.05) {
        s.mesh.position.y = 0.05;
        s.vy = 0;
        s.vx *= 0.4;
        s.vz *= 0.4;
        s.spin *= 0.2;
      }
      if (s.life <= 0) s.mesh.visible = false;
    }

    // Explosions
    for (const e of this.explosions) {
      if (e.life <= 0) continue;
      e.life -= dt;
      const k = 1 - e.life / e.maxLife;
      const fireball = e.group.children[0] as THREE.Mesh;
      const ring = e.group.children[1] as THREE.Mesh;
      const light = e.group.children[2] as THREE.PointLight;
      const scale = 0.35 + k * e.radius * 0.42;
      fireball.scale.setScalar(scale);
      (fireball.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 * (1 - k * 1.35));
      ring.scale.setScalar(0.4 + k * e.radius * 0.55);
      (ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.75 * (1 - k * 1.2));
      light.intensity = Math.max(0, 60 * (1 - k * 1.6));
      if (e.life <= 0) e.group.visible = false;
    }

    // Particle systems
    this.updateParticles(this.sparks, this.sparkGeo, this.sparkPoints, dt, 0.9);
    this.updateParticles(this.blood, this.bloodGeo, this.bloodPoints, dt, 1.0);
  }

  private updateParticles(list: Spark[], geo: THREE.BufferGeometry, points: THREE.Points, dt: number, drag: number): void {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color as THREE.BufferAttribute;
    const size = geo.attributes.size as THREE.BufferAttribute;
    let live = 0;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) continue;
      s.vy -= 9.5 * dt;
      const d = Math.pow(drag, dt * 60);
      s.vx *= d;
      s.vz *= d;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      const k = s.life / s.maxLife;
      pos.setXYZ(live, s.x, s.y, s.z);
      col.setXYZ(live, s.r * k + 0.15 * k, s.g * k, s.b * k);
      size.setX(live, s.size * (0.6 + k));
      live++;
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    size.needsUpdate = true;
    geo.setDrawRange(0, live);
    points.visible = live > 0;
    if (list.length > 260) {
      // Compact occasionally so the array never grows unbounded.
      for (let i = list.length - 1; i >= 0; i--) if (list[i].life <= 0) list.splice(i, 1);
    }
  }

  clear(): void {
    for (const t of this.tracers) {
      t.life = 0;
      t.mesh.visible = false;
    }
    for (const f of this.flashes) {
      f.life = 0;
      f.sprite.visible = false;
    }
    for (const s of this.shells) {
      s.life = 0;
      s.mesh.visible = false;
    }
    for (const e of this.explosions) {
      e.life = 0;
      e.group.visible = false;
    }
    for (const d of this.decals) d.visible = false;
    this.sparks.length = 0;
    this.blood.length = 0;
    this.sparkGeo.setDrawRange(0, 0);
    this.bloodGeo.setDrawRange(0, 0);
  }

  dispose(): void {
    this.scene.remove(this.root);
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh || (o as THREE.Points).type === 'Points') {
        mesh.geometry?.dispose?.();
        const m = mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(m)) for (const mm of m) mm.dispose();
        else m?.dispose?.();
      }
    });
  }
}
