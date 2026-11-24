// Live audio analysis: auto-levelled bands, kick / snare / hi-hat hits and a
// beat clock that follows the music. Ported from Amethyst VJ (tempo.cpp,
// structure.cpp, pumpAudio) so both apps hear music the same way.
//
// Feed it mono PCM blocks in real time; read `features(now)` every frame.

export interface AudioFeatures {
  /** Auto-levelled 0..1 bands. */
  level: number;
  bass: number;
  mid: number;
  treble: number;
  /** 0..1 hit envelopes: jump to ~1 on a hit, then decay. */
  kick: number;
  snare: number;
  hat: number;
  /** 0..1 pulse on every beat of the tracked tempo. */
  beat: number;
  /** True while sound is coming in. */
  active: boolean;
}

export const SILENT: AudioFeatures = { level: 0, bass: 0, mid: 0, treble: 0, kick: 0, snare: 0, hat: 0, beat: 0, active: false };

/** One-pole low-pass coefficient for a cutoff (Hz). */
const lpCoef = (fc: number, fs: number) => 1 - Math.exp((-2 * Math.PI * fc) / fs);
/** One-pole high-pass (RC) coefficient for a cutoff (Hz). */
const hpCoef = (fc: number, fs: number) => 1 / (1 + (2 * Math.PI * fc) / fs);

const HOP_SEC = 0.01; // 100 Hz onset envelope, as in Amethyst
const HISTORY = 1500; // 15 s
const MIN_BPM = 70;
const STEP = 0.25;
const BINS = Math.floor((190 - MIN_BPM) / STEP) + 1;

export class LiveAnalyzer {
  /** Input sensitivity (multiplies the signal before analysis). */
  gain = 1;
  readonly fs: number;
  private hop: number;

  // ---- bands (pumpAudio)
  private lpBand = 0;
  private lpBand2 = 0;
  private peaks = { bass: 0.01, mid: 0.01, treble: 0.01, level: 0.01 };
  private bands = { bass: 0, mid: 0, treble: 0, level: 0 };
  private shown = { bass: 0, mid: 0, treble: 0, level: 0 };
  private acc = { bass: 0, mid: 0, treble: 0, level: 0, n: 0 };

  // ---- tempo onset envelope (tempo.cpp)
  private lpLow = 0;
  private lpMid = 0;
  private lpHigh = 0;
  private eLow = 0;
  private eMid = 0;
  private eHigh = 0;
  private prevL = [0, 0, 0];
  private hopCount = 0;
  private od = new Float32Array(HISTORY);
  private head = 0;
  private filled = 0;
  private lastHopTime = 0;

  // ---- percussion (structure.cpp)
  private kAlpha: number;
  private lpKick = 0;
  private h1 = 0;
  private h1In = 0;
  private h2 = 0;
  private h2In = 0;
  private s1 = 0;
  private s1In = 0;
  private s2 = 0;
  private s2In = 0;
  private sLp = 0;
  private accB = 0;
  private accA = 0;
  private accH = 0;
  private accS = 0;
  private hatM = 0;
  private snM = 0;
  private hatPrev = 0;
  private snPrev = 0;
  private bassPrev = 0;
  private bassAvg = 0;
  private hatGap = 1;
  private snGap = 1;
  private kickGap = 1;
  private env = { kick: 0, snare: 0, hat: 0 };
  private envTime = 0;
  /** Hit counters (lets callers react once per hit). */
  hits = { kick: 0, snare: 0, hat: 0 };

  // ---- beat clock
  bpm = 120;
  private anchorTime = 0;
  private anchorBeat = 0;
  confidence = 0;
  locked = false;
  private accScores: Float64Array | null = null;
  private pendingBpm = 0;
  private pendingVotes = 0;
  private strongAvg = 0;
  private lastEstimate = 0;
  private taps: number[] = [];
  private lastInput = -1;

  // Pre-computed filter coefficients.
  private c = { band: 0, band2: 0, low: 0, mid: 0, high: 0, hat: 0, sn: 0, snLp: 0 };

  constructor(sampleRate = 48000) {
    this.fs = sampleRate;
    this.hop = Math.max(1, Math.round(sampleRate * HOP_SEC));
    this.kAlpha = lpCoef(150, sampleRate);
    this.c = {
      band: lpCoef(155, sampleRate), // bass
      band2: lpCoef(2000, sampleRate), // mids/treble split
      low: lpCoef(150, sampleRate),
      mid: lpCoef(2000, sampleRate),
      high: lpCoef(5000, sampleRate),
      hat: hpCoef(7000, sampleRate),
      sn: hpCoef(1000, sampleRate),
      snLp: lpCoef(4000, sampleRate),
    };
  }

  /** Feed a block of mono samples that ends at time `now` (seconds). */
  feed(block: Float32Array, now: number) {
    const n = block.length;
    if (!n) return;
    this.lastInput = now;
    const g = this.gain;
    const c = this.c;
    const hopSec = this.hop / this.fs;
    const totalHops = Math.floor((this.hopCount + n) / this.hop);
    let hopIndex = 0;
    for (let i = 0; i < n; i++) {
      const m = block[i] * g;
      // Bands for display/modulation.
      this.lpBand += (m - this.lpBand) * c.band;
      this.lpBand2 += (m - this.lpBand2) * c.band2;
      this.acc.bass += this.lpBand * this.lpBand;
      this.acc.mid += (this.lpBand2 - this.lpBand) ** 2;
      this.acc.treble += (m - this.lpBand2) ** 2;
      this.acc.level += m * m;
      this.acc.n++;
      // Tempo onset bands.
      this.lpLow += (m - this.lpLow) * c.low;
      this.lpMid += (m - this.lpMid) * c.mid;
      this.lpHigh += (m - this.lpHigh) * c.high;
      const lo = this.lpLow;
      const mi = this.lpMid - this.lpLow;
      const hi = m - this.lpHigh;
      this.eLow += lo * lo;
      this.eMid += mi * mi;
      this.eHigh += hi * hi;
      // Percussion bands: kick low-pass, hats = 2× high-pass ~7 kHz, snares = 2× high-pass ~1 kHz + low-pass ~4 kHz.
      this.lpKick += this.kAlpha * (m - this.lpKick);
      this.accB += this.lpKick * this.lpKick;
      this.accA += m * m;
      this.h1 = c.hat * (this.h1 + m - this.h1In);
      this.h1In = m;
      this.h2 = c.hat * (this.h2 + this.h1 - this.h2In);
      this.h2In = this.h1;
      this.accH += this.h2 * this.h2;
      this.s1 = c.sn * (this.s1 + m - this.s1In);
      this.s1In = m;
      this.s2 = c.sn * (this.s2 + this.s1 - this.s2In);
      this.s2In = this.s1;
      this.sLp += c.snLp * (this.s2 - this.sLp);
      this.accS += this.sLp * this.sLp;

      if (++this.hopCount >= this.hop) {
        hopIndex++;
        const t = now - (totalHops - hopIndex) * hopSec;
        this.hopStep(t, hopSec);
      }
    }
  }

  private hopStep(t: number, dt: number) {
    const h = this.hop;
    // Band-wise log-energy flux (rises only): kicks, snares and hats all count.
    const e = [this.eLow, this.eMid, this.eHigh];
    const w = [1, 0.8, 0.6];
    let v = 0;
    for (let b = 0; b < 3; b++) {
      const lg = Math.log10(1e-9 + e[b] / h);
      v += w[b] * Math.max(0, lg - this.prevL[b]);
      this.prevL[b] = lg;
    }
    this.eLow = this.eMid = this.eHigh = 0;
    this.od[this.head] = v;
    this.head = (this.head + 1) % HISTORY;
    this.filled = Math.min(this.filled + 1, HISTORY);
    this.hopCount = 0;
    this.lastHopTime = t;

    // Bands with automatic gain (peak follower decaying over ~11 s).
    const decay = Math.exp(-dt / 11);
    const an = Math.max(1, this.acc.n);
    for (const k of ['bass', 'mid', 'treble', 'level'] as const) {
      const val = Math.sqrt(this.acc[k] / an);
      this.peaks[k] = Math.max(val, Math.max(0.01, this.peaks[k] * decay));
      this.bands[k] = Math.min(1, val / this.peaks[k]);
    }
    this.acc = { bass: 0, mid: 0, treble: 0, level: 0, n: 0 };

    this.percStep(Math.sqrt(this.accH / h), Math.sqrt(this.accS / h), Math.sqrt(this.accB / h), Math.sqrt(this.accA / h), t, dt);
    this.accB = this.accA = this.accH = this.accS = 0;
  }

  /** Hits are sudden jumps of a band's level over its own recent average (structure.cpp). */
  private percStep(hat: number, sn: number, bass: number, lvl: number, t: number, dt: number) {
    const ema = (st: number, val: number, tau: number) => st + (val - st) * (1 - Math.exp(-dt / tau));
    this.decayEnvelopes(t);
    this.hatGap += dt;
    this.snGap += dt;
    this.kickGap += dt;
    const loud = lvl >= 0.004;
    const kickJump = bass > 0.002 && bass > this.bassPrev * 1.35;
    // Kick: bass well above its recent average (pumpAudio's beat hit), at most ~3 per second.
    if (loud && this.kickGap >= 0.25 && bass > this.bassAvg * 1.35 + 0.002 && kickJump) {
      this.env.kick = Math.max(this.env.kick, Math.min(1, Math.max(0.5, (bass / (this.bassAvg + 1e-6) - 1) / 1.5)));
      this.hits.kick++;
      this.kickGap = 0;
    }
    if (loud && this.hatGap >= 0.06 && hat > this.hatM * 1.5 && hat > this.hatPrev * 1.2 && hat > lvl * 0.008) {
      this.env.hat = Math.max(this.env.hat, Math.min(1, Math.max(0.3, (hat / (this.hatM + 1e-6) - 1) / 1.5)));
      this.hits.hat++;
      this.hatGap = 0;
    }
    // A snare-band jump that comes with a kick is the kick's click, not a snare.
    if (loud && !kickJump && this.snGap >= 0.12 && sn > this.snM * 1.8 && sn > this.snPrev * 1.3 && sn > lvl * 0.05) {
      this.env.snare = Math.max(this.env.snare, Math.min(1, Math.max(0.3, (sn / (this.snM + 1e-6) - 1) / 2)));
      this.hits.snare++;
      this.snGap = 0;
    }
    this.hatM = ema(this.hatM, hat, 0.4);
    this.snM = ema(this.snM, sn, 0.4);
    this.bassAvg = ema(this.bassAvg, bass, 0.2);
    this.hatPrev = hat;
    this.snPrev = sn;
    this.bassPrev = bass;
  }

  private decayEnvelopes(t: number) {
    const dt = Math.max(0, t - this.envTime);
    this.envTime = Math.max(this.envTime, t);
    if (!dt) return;
    this.env.kick *= Math.exp(-dt / 0.12);
    this.env.hat *= Math.exp(-dt / 0.08);
    this.env.snare *= Math.exp(-dt / 0.15);
  }

  // ------------------------------------------------------------------ tempo

  private odAt(back: number) {
    return this.od[(this.head - 1 - back + HISTORY * 4) % HISTORY];
  }

  private setTempoKeepPhase(bpm: number, t: number) {
    this.anchorBeat = this.beatAt(t);
    this.anchorTime = t;
    this.bpm = bpm;
  }

  beatAt(t: number) {
    return this.anchorBeat + ((t - this.anchorTime) * this.bpm) / 60;
  }

  /** Re-estimate tempo and phase (cheap; call every frame — it runs twice a second). */
  update(now: number) {
    if (now - this.lastEstimate < 0.5) return;
    this.lastEstimate = now;
    this.estimate(now);
  }

  /**
   * Tempo: autocorrelate the onset envelope, score every candidate BPM by how
   * well its 1..4 beat lags (and the half-beat) line up, accumulate the scores
   * over ~8 s and only switch on sustained evidence.
   */
  private estimate(now: number) {
    if (this.filled < 400) return;
    const n = Math.min(this.filled, HISTORY);
    const x = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      x[i] = this.odAt(n - 1 - i);
      mean += x[i];
    }
    mean /= n;
    // How strong the rhythm is right now vs. this song so far: drumless breakdowns barely move the lock.
    let recent = 0;
    const rn = Math.min(n, 300);
    for (let i = n - rn; i < n; i++) recent += x[i];
    recent /= rn;
    this.strongAvg = this.strongAvg <= 0 ? recent : this.strongAvg + (recent - this.strongAvg) * 0.02;
    const w = Math.min(1.5, Math.max(0.05, recent / Math.max(1e-6, this.strongAvg)));
    for (let i = 0; i < n; i++) x[i] -= mean;
    const maxL = Math.min(n - 50, 360);
    const acf = new Float64Array(maxL + 2);
    for (let L = 1; L <= maxL + 1 && L < n; L++) {
      let s = 0;
      for (let i = L; i < n; i++) s += x[i] * x[i - L];
      acf[L] = s / (n - L);
    }
    const A = (L: number) => {
      const a = Math.floor(L);
      if (a < 1 || a + 1 > maxL + 1) return 0;
      const k = L - a;
      return acf[a] * (1 - k) + acf[a + 1] * k;
    };
    if (!this.accScores) this.accScores = new Float64Array(BINS);
    const acc = this.accScores;
    const sc = new Float64Array(BINS);
    let mx = 1e-12;
    for (let i = 0; i < BINS; i++) {
      const b = MIN_BPM + i * STEP;
      const P = 6000 / b;
      const s =
        A(P) + 0.8 * A(2 * P) + 0.6 * A(3 * P) + 0.6 * A(4 * P) + 0.5 * A(P / 2) - 0.3 * A(P * 1.5) - 0.4 * A((P * 2) / 3) - 0.3 * A(P / 3) - 0.25 * A((P * 4) / 3);
      sc[i] = Math.max(0, s);
      mx = Math.max(mx, sc[i]);
    }
    let sum = 0;
    for (let i = 0; i < BINS; i++) {
      acc[i] = acc[i] * (1 - 0.04 * w) + (w * sc[i]) / mx;
      sum += acc[i];
    }
    const prior = (b: number) => {
      const d = Math.log2(b / 140);
      return Math.exp((-0.5 * d * d) / (0.6 * 0.6));
    };
    let best = 0;
    let bestV = -1;
    for (let i = 0; i < BINS; i++) {
      const val = acc[i] * prior(MIN_BPM + i * STEP);
      if (val > bestV) {
        bestV = val;
        best = i;
      }
    }
    let off = 0;
    if (best > 0 && best < BINS - 1) {
      const a = acc[best - 1];
      const b = acc[best];
      const c = acc[best + 1];
      const d = a - 2 * b + c;
      if (Math.abs(d) > 1e-12) off = Math.min(0.5, Math.max(-0.5, (0.5 * (a - c)) / d));
    }
    const found = MIN_BPM + (best + off) * STEP;
    const avg = sum / BINS;
    this.confidence = avg > 0 ? Math.min(10, acc[best] / avg) : 0;
    if (this.confidence < 1.5) return;
    const valueAt = (b: number) => {
      const i = Math.round((b - MIN_BPM) / STEP);
      return i >= 0 && i < BINS ? acc[i] * prior(b) : 0;
    };
    // Triplet-heavy music makes 4:3, 3:2 and 2:1 neighbours look good for a while:
    // once locked, those need far stronger and longer evidence than an unrelated tempo.
    const related = (f: number) => [4 / 3, 3 / 4, 3 / 2, 2 / 3, 2, 0.5].some((q) => Math.abs(f / this.bpm / q - 1) < 0.03);
    if (Math.abs(found - this.bpm) / this.bpm < 0.02) {
      this.setTempoKeepPhase(this.bpm + (found - this.bpm) * 0.3, now);
      this.pendingVotes = 0;
      if (!this.locked && this.confidence > 2) this.locked = true;
    } else if (!this.locked || valueAt(found) > valueAt(this.bpm) * (related(found) ? 2 : 1.3)) {
      if (this.pendingBpm > 0 && Math.abs(found - this.pendingBpm) / this.pendingBpm < 0.02) {
        if (++this.pendingVotes >= (!this.locked ? 2 : related(found) ? 24 : 10)) {
          this.setTempoKeepPhase(found, now);
          this.pendingVotes = 0;
          this.pendingBpm = 0;
          this.locked = true;
        }
      } else {
        this.pendingBpm = found;
        this.pendingVotes = 1;
      }
    }

    // Phase: comb over the last ~6 s, recent onsets weigh more.
    const period = 6000 / this.bpm;
    const span = Math.min(n, 600);
    let bestSum = -1;
    let bestOff = 0;
    for (let o = 0; o < period; o += 0.5) {
      let s = 0;
      let wt = 1;
      for (let k = o; k < span - 1; k += period, wt *= 0.93) {
        const a = Math.floor(k);
        const f = k - a;
        s += wt * (this.odAt(a) * (1 - f) + this.odAt(a + 1) * f);
      }
      if (s > bestSum) {
        bestSum = s;
        bestOff = o;
      }
    }
    const lastBeatTime = this.lastHopTime - bestOff * HOP_SEC;
    const cur = this.beatAt(lastBeatTime);
    const err = cur - Math.round(cur);
    this.anchorBeat -= err * 0.35; // ease the phase towards the detected beat
  }

  /** Tap tempo: average the taps, and treat the tap as a beat (snaps phase). */
  tap(now: number) {
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 5) this.taps.shift();
    if (this.taps.length >= 2) {
      const avg = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
      this.setTempoKeepPhase(Math.min(240, Math.max(40, 60 / avg)), now);
      this.locked = true;
    }
    this.anchorBeat = Math.round(this.beatAt(now));
    this.anchorTime = now;
  }

  setBpm(bpm: number, now: number) {
    this.setTempoKeepPhase(Math.min(300, Math.max(20, bpm)), now);
  }

  /** Forget everything heard so far (new source). */
  reset(now = 0) {
    this.od.fill(0);
    this.head = this.filled = 0;
    this.accScores = null;
    this.pendingBpm = 0;
    this.pendingVotes = 0;
    this.confidence = 0;
    this.locked = false;
    this.strongAvg = 0;
    this.lastEstimate = 0;
    this.anchorTime = now;
    this.anchorBeat = 0;
    this.peaks = { bass: 0.01, mid: 0.01, treble: 0.01, level: 0.01 };
    this.env = { kick: 0, snare: 0, hat: 0 };
  }

  /** Current features. Bands are smoothed a touch for display; hits decay to `now`. */
  features(now: number): AudioFeatures {
    const active = this.lastInput >= 0 && now - this.lastInput < 0.5;
    if (!active) {
      for (const k of ['bass', 'mid', 'treble', 'level'] as const) this.shown[k] *= 0.9;
      this.decayEnvelopes(now);
      return { ...this.shown, kick: this.env.kick, snare: this.env.snare, hat: this.env.hat, beat: 0, active: false };
    }
    this.decayEnvelopes(now);
    for (const k of ['bass', 'mid', 'treble', 'level'] as const) {
      // Fast attack, ~120 ms release.
      const v = this.bands[k];
      this.shown[k] = v > this.shown[k] ? v : this.shown[k] + (v - this.shown[k]) * 0.18;
    }
    const f = this.beatAt(now);
    const ph = 1 - (f - Math.floor(f));
    return { ...this.shown, kick: this.env.kick, snare: this.env.snare, hat: this.env.hat, beat: this.locked ? ph * ph : 0, active };
  }
}
