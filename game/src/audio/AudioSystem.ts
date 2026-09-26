import type { Actor } from '../entity/Actor';
import { WEAPONS } from '../items/Items';
import { settings } from '../core/Settings';
import { bus } from '../core/EventBus';
import { clamp } from '../utils/mathx';

/**
 * Fully procedural audio — every sound is synthesised with the WebAudio API, so
 * the game ships with zero audio assets.
 *
 * Buses: master → sfx / music. Weapon reports are built from a noise transient,
 * a body thump and a tail, with per-weapon parameters taken from the item defs.
 */

type Bus = GainNode;

export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private musicTimer: number | null = null;
  private unlocked = false;
  private listenerX = 0;
  private listenerY = 0;
  private listenerZ = 0;
  private lastFootstep = 0;
  private ambientGain: GainNode | null = null;

  get ready(): boolean {
    return this.ctx !== null && this.unlocked;
  }

  /** Must be called from a user gesture (click / key press). */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      this.unlocked = true;
      this.applyVolumes();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      this.ctx = new Ctor();
    } catch {
      return;
    }
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.connect(this.master);
    this.musicBus = this.ctx.createGain();
    this.musicBus.connect(this.master);
    this.noiseBuffer = this.makeNoise(2.0);
    this.unlocked = true;
    this.applyVolumes();
    this.startAmbience();
    this.bindEvents();
  }

  private bindEvents(): void {
    bus.on('hitmarker', (e) => this.hitmarker(e.headshot, e.killed));
    bus.on('actor:knocked', (e) => this.play(e.isLocal ? 'down' : 'knock', 0.9));
    bus.on('ammo:empty', () => this.click(0.5));
    bus.on('zone:warning', (e) => this.zoneWarning(e.level));
    bus.on('loot:pickup', () => this.pickup());
    bus.on('ui:toast', (e) => {
      if (e.kind === 'bad' || e.kind === 'warn') this.click(0.35);
    });
    bus.on('round:started', () => this.blip(660, 0.18));
    bus.on('match:ended', (e) => this.fanfare(e.victory));
  }

  applyVolumes(): void {
    if (!this.ctx || !this.master || !this.sfxBus || !this.musicBus) return;
    const d = settings.data;
    this.master.gain.value = d.masterVolume;
    this.sfxBus.gain.value = d.sfxVolume;
    this.musicBus.gain.value = d.musicVolume * 0.6;
  }

  setListener(x: number, y: number, z: number): void {
    this.listenerX = x;
    this.listenerY = y;
    this.listenerZ = z;
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx as AudioContext;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    return buffer;
  }

  /* ------------------------------------------------------------------ */
  /* Primitives                                                          */
  /* ------------------------------------------------------------------ */

  private gainTo(bus: Bus | null, value: number): GainNode | null {
    if (!this.ctx) return null;
    const g = this.ctx.createGain();
    g.gain.value = value;
    g.connect(bus ?? this.master ?? this.ctx.destination);
    return g;
  }

  /** Distance attenuation for a world-positioned sound. */
  private attenuation(x: number, y: number, z: number, maxDist = 90): number {
    const d = Math.hypot(x - this.listenerX, y - this.listenerY, z - this.listenerZ);
    if (d > maxDist) return 0;
    return clamp(1 - d / maxDist, 0, 1) ** 1.6;
  }

  private noise(duration: number, gain: number, filterType: BiquadFilterType, freq: number, q = 1, bus: Bus | null = null, delay = 0): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const t0 = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = this.gainTo(bus ?? this.sfxBus, 0);
    if (!g) return;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.012, duration * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter);
    filter.connect(g);
    src.start(t0);
    src.stop(t0 + duration + 0.02);
  }

  private tone(freq: number, duration: number, gain: number, type: OscillatorType = 'sine', slideTo = 0, delay = 0, bus: Bus | null = null): void {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo > 0) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + duration);
    const g = this.gainTo(bus ?? this.sfxBus, 0);
    if (!g) return;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.008, duration * 0.15));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  /* ------------------------------------------------------------------ */
  /* Game sounds                                                         */
  /* ------------------------------------------------------------------ */

  /** Weapon report, positioned in the world. */
  gunshot(actor: Actor | null, weaponId: string, suppressed: boolean, isLocal: boolean): void {
    if (!this.ready) return;
    const def = WEAPONS[weaponId];
    const cls = def?.cls ?? 'AR';
    const at = actor ? this.attenuation(actor.position.x, actor.position.y, actor.position.z, suppressed ? 55 : 140) : 1;
    if (at <= 0.01) return;
    const close = isLocal ? 1 : at;
    const body = suppressed ? 0.34 : 1;
    const pitchBase = cls === 'SNIPER' ? 760 : cls === 'DMR' ? 900 : cls === 'SHOTGUN' ? 520 : cls === 'SMG' || cls === 'PISTOL' ? 1250 : 1050;

    // Crack
    this.noise(suppressed ? 0.05 : 0.14, 0.75 * body * close, 'bandpass', pitchBase * 1.1, 0.9);
    // Body / thump
    this.tone(pitchBase * 0.28, suppressed ? 0.09 : 0.18, 0.4 * body * close, 'square', pitchBase * 0.12);
    // Tail (reverb-ish)
    if (!suppressed) {
      this.noise(0.42, 0.14 * close * Math.max(0.35, at), 'lowpass', 620, 0.6, this.sfxBus, 0.02);
    }
    if (isLocal) this.mechanical(0.25);
  }

  private mechanical(gain: number): void {
    this.noise(0.03, 0.25 * gain, 'highpass', 2600, 1.2);
  }

  impact(surface: string, isLocal: boolean, x = 0, y = 0, z = 0): void {
    if (!this.ready) return;
    const at = isLocal ? 1 : this.attenuation(x, y, z, 70);
    if (at <= 0.02) return;
    if (surface.includes('metal') || surface.includes('Steel')) {
      this.tone(1800 + Math.random() * 400, 0.08, 0.22 * at, 'triangle', 900);
      this.noise(0.06, 0.2 * at, 'highpass', 3200, 1);
    } else if (surface.includes('wood')) {
      this.noise(0.07, 0.24 * at, 'bandpass', 900, 2);
    } else if (surface.includes('glass')) {
      this.noise(0.12, 0.28 * at, 'highpass', 4200, 0.8);
    } else if (surface.includes('foliage')) {
      this.noise(0.09, 0.14 * at, 'lowpass', 2600, 0.5);
    } else {
      this.noise(0.08, 0.22 * at, 'bandpass', 420, 1.4);
    }
  }

  actorHit(isLocal: boolean): void {
    if (!this.ready) return;
    this.noise(0.05, isLocal ? 0.3 : 0.18, 'bandpass', 320, 1.6);
    if (isLocal) this.tone(220, 0.12, 0.16, 'sawtooth', 140);
  }

  hitmarker(headshot: boolean, killed: boolean): void {
    if (!this.ready) return;
    this.tone(headshot ? 1500 : 1050, 0.07, 0.16, 'square', headshot ? 1900 : 1250);
    if (killed) this.tone(700, 0.16, 0.16, 'triangle', 1100, 0.06);
  }

  explosion(x: number, y: number, z: number): void {
    if (!this.ready) return;
    const at = clamp(this.attenuation(x, y, z, 170), 0, 1);
    if (at <= 0.02) return;
    this.noise(0.7, 0.9 * at, 'lowpass', 320, 0.7);
    this.tone(90, 0.5, 0.7 * at, 'sine', 38);
    this.noise(0.16, 0.5 * at, 'highpass', 1800, 0.9);
  }

  footstep(kind: 'crouch' | 'walk' | 'run' | 'sprint' | 'land', surface = 'dirt'): void {
    if (!this.ready) return;
    const now = performance.now();
    const gap = kind === 'sprint' ? 240 : kind === 'run' ? 300 : kind === 'walk' ? 420 : 520;
    if (kind !== 'land' && now - this.lastFootstep < gap) return;
    this.lastFootstep = now;
    const gain = kind === 'crouch' ? 0.06 : kind === 'walk' ? 0.12 : kind === 'run' ? 0.2 : kind === 'sprint' ? 0.26 : 0.4;
    const freq = surface.includes('metal') ? 1400 : surface.includes('wood') ? 700 : surface.includes('concrete') ? 900 : 420;
    this.noise(kind === 'land' ? 0.16 : 0.08, gain, 'bandpass', freq, 1.2);
  }

  reload(stage: 'start' | 'mag' | 'finish'): void {
    if (!this.ready) return;
    if (stage === 'start') this.mechanical(0.7);
    else if (stage === 'mag') { this.tone(420, 0.06, 0.16, 'square', 240); this.mechanical(0.5); }
    else this.mechanical(0.9);
  }

  click(gain = 1): void {
    if (!this.ready) return;
    this.noise(0.02, 0.18 * gain, 'highpass', 2200, 1);
  }

  pickup(): void {
    if (!this.ready) return;
    this.tone(720, 0.09, 0.14, 'triangle', 1080);
    this.tone(1080, 0.08, 0.1, 'triangle', 1440, 0.06);
  }

  blip(freq: number, duration: number): void {
    if (!this.ready) return;
    this.tone(freq, duration, 0.16, 'triangle', freq * 1.4);
  }

  play(kind: 'down' | 'knock' | 'revive' | 'vehicle' | 'crash', gain = 1): void {
    if (!this.ready) return;
    switch (kind) {
      case 'down':
      case 'knock':
        this.tone(180, 0.4, 0.3 * gain, 'sawtooth', 80);
        this.noise(0.3, 0.25 * gain, 'lowpass', 700, 0.8);
        break;
      case 'revive':
        this.tone(520, 0.3, 0.18 * gain, 'triangle', 900);
        break;
      case 'vehicle':
        this.tone(140, 0.2, 0.2 * gain, 'square', 320);
        break;
      case 'crash':
        this.noise(0.6, 0.7 * gain, 'lowpass', 500, 0.7);
        this.tone(110, 0.4, 0.5 * gain, 'sine', 45);
        break;
    }
  }

  zoneWarning(level: number): void {
    if (!this.ready) return;
    const base = level >= 3 ? 220 : 320;
    this.tone(base, 0.5, 0.2, 'sine', base * 0.9);
    this.tone(base * 1.5, 0.35, 0.12, 'sine', base * 1.4, 0.18);
  }

  fanfare(victory: boolean): void {
    if (!this.ready) return;
    const notes = victory ? [523, 659, 784, 1047] : [392, 349, 294, 233];
    notes.forEach((n, i) => this.tone(n, 0.5, 0.2, 'triangle', 0, i * 0.16, this.musicBus));
  }

  /* ------------------------------------------------------------------ */
  /* Music + ambience                                                    */
  /* ------------------------------------------------------------------ */

  private startAmbience(): void {
    if (!this.ctx || !this.sfxBus) return;
    // Low wind bed — gives the island a sense of place.
    const src = this.ctx.createBufferSource();
    if (!this.noiseBuffer) return;
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    filter.Q.value = 0.4;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.05;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxBus);
    src.start();
    this.ambientGain = gain;
  }

  /** Slow menu pad; stopped when a match starts. */
  startMusic(): void {
    if (!this.ready || !this.ctx || this.musicTimer !== null) return;
    const chords = [
      [110, 164.81, 220, 277.18],
      [98, 146.83, 196, 246.94],
      [130.81, 196, 261.63, 329.63],
      [123.47, 185, 246.94, 311.13]
    ];
    let index = 0;
    const playChord = (): void => {
      if (!this.ctx || !this.musicBus) return;
      const t0 = this.ctx.currentTime;
      const chord = chords[index % chords.length];
      index++;
      chord.forEach((freq, i) => {
        const osc = this.ctx!.createOscillator();
        osc.type = i === 3 ? 'triangle' : 'sine';
        osc.frequency.value = freq;
        const g = this.ctx!.createGain();
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.09 / (i + 1), t0 + 1.6);
        g.gain.linearRampToValueAtTime(0, t0 + 6.4);
        osc.connect(g);
        g.connect(this.musicBus!);
        osc.start(t0);
        osc.stop(t0 + 6.6);
      });
    };
    playChord();
    this.musicTimer = window.setInterval(playChord, 6400);
  }

  stopMusic(): void {
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  /** Muffles the world while menus are open. */
  setMuffled(muffled: boolean): void {
    if (this.ambientGain) this.ambientGain.gain.value = muffled ? 0.02 : 0.05;
  }

  dispose(): void {
    this.stopMusic();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
