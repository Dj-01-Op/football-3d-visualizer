/*
 * FB3D core: pure logic for the football 3D visualizer.
 * No DOM and no three.js here, so everything is testable in Node.
 * Pitch coordinates are meters: x along the long axis, y across, z up.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FB3DCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SENTINEL = -32768;
  const NULL8 = -128;
  const FRAME_MS = 200; // 5 Hz sampling (assumption, labeled in the UI)
  const RATE_HZ = 5;
  const SPEEDS = [0.25, 0.5, 1, 2, 4];
  const PITCH = { length: 105, width: 68 };
  const TRAIL = { min: 5, max: 100, def: 30 };

  const JOINTS = [
    'neck', 'pelvis',
    'r_shoulder', 'r_elbow', 'r_wrist',
    'l_shoulder', 'l_elbow', 'l_wrist',
    'r_hip', 'r_knee', 'r_ankle', 'r_heel', 'r_toe',
    'l_hip', 'l_knee', 'l_ankle', 'l_heel', 'l_toe',
    'r_ear', 'l_ear', 'nose',
  ];
  const NJ = JOINTS.length; // 21
  const NCH = NJ * 3; // 63
  const J = Object.fromEntries(JOINTS.map((n, i) => [n, i]));
  const BONES = [
    ['neck', 'pelvis'],
    ['neck', 'r_shoulder'], ['r_shoulder', 'r_elbow'], ['r_elbow', 'r_wrist'],
    ['neck', 'l_shoulder'], ['l_shoulder', 'l_elbow'], ['l_elbow', 'l_wrist'],
    ['pelvis', 'r_hip'], ['r_hip', 'r_knee'], ['r_knee', 'r_ankle'],
    ['r_ankle', 'r_heel'], ['r_ankle', 'r_toe'], ['r_heel', 'r_toe'],
    ['pelvis', 'l_hip'], ['l_hip', 'l_knee'], ['l_knee', 'l_ankle'],
    ['l_ankle', 'l_heel'], ['l_ankle', 'l_toe'], ['l_heel', 'l_toe'],
    ['r_hip', 'l_hip'], ['r_shoulder', 'l_shoulder'],
    ['neck', 'nose'], ['nose', 'r_ear'], ['nose', 'l_ear'],
  ].map(([a, b]) => [J[a], J[b]]);

  const TEAMS = ['Home', 'Away', 'Referees'];
  const COLORS = { home: '#00e5ff', away: '#ff2d95', referees: '#ffd600', neutral: '#9e9e9e' };
  const TEAM_COLORS = [COLORS.home, COLORS.away, COLORS.referees];
  const LAYER_NAMES = ['players', 'skeletons', 'trails', 'ball', 'pitchMarkings', 'labels', 'possession', 'referees', 'stadium', 'crowd'];

  // ------------------------------------------------------------------ decoding
  function base64ToBytes(b64) {
    const bin = atob(b64.replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream is not supported');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Parse the uncompressed FB3D payload into dense typed arrays. */
  function parsePayload(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.length < 17) throw new Error('payload too short');
    const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (magic !== 'FB3D' || dv.getUint16(4, true) !== 1) throw new Error('bad payload header');
    const F = dv.getUint32(6, true);
    const K = dv.getUint16(10, true);
    const R = dv.getUint32(12, true);
    const M = dv.getUint8(16);
    let off = 17;
    const need = (n) => { if (off + n > u8.length) throw new Error('payload truncated'); };

    const entities = [];
    need(K * 4);
    for (let k = 0; k < K; k++) {
      const team = dv.getUint8(off);
      const jersey = dv.getInt16(off + 2, true);
      entities.push({ team, jersey, teamName: TEAMS[team] || 'Unknown', label: (TEAMS[team] || '?')[0] + jersey });
      off += 4;
    }
    const takeBytes = (n) => { need(n); const s = u8.slice(off, off + n); off += n; return s; };
    const takeI16 = (n) => new Int16Array(takeBytes(n * 2).buffer);

    const frameNumber = new Int32Array(takeBytes(F * 4).buffer);
    const poss = new Int8Array(takeBytes(F).buffer);
    const status = new Int8Array(takeBytes(F).buffer);
    const ballMissing = takeBytes(F);

    const ballRaw = takeI16(3 * F);
    const ball = new Int16Array(F * 3);
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let f = 0; f < F; f++) {
        acc = (acc + ballRaw[c * F + f]) << 16 >> 16;
        ball[f * 3 + c] = acc;
      }
    }

    const masks = takeBytes(F * M);
    const present = new Uint8Array(F * K);
    let count = 0;
    for (let f = 0; f < F; f++) {
      for (let k = 0; k < K; k++) {
        const bit = (masks[f * M + (k >> 3)] >> (k & 7)) & 1;
        present[f * K + k] = bit;
        count += bit;
      }
    }
    if (count !== R) throw new Error('presence mask does not match row count');

    const pos = new Int16Array(F * K * NCH).fill(SENTINEL);
    for (let k = 0; k < K; k++) {
      const rows = [];
      for (let f = 0; f < F; f++) if (present[f * K + k]) rows.push(f);
      if (!rows.length) continue;
      const block = takeI16(NCH * rows.length);
      for (let c = 0; c < NCH; c++) {
        let acc = 0;
        const base = c * rows.length;
        for (let r = 0; r < rows.length; r++) {
          acc = (acc + block[base + r]) << 16 >> 16;
          pos[(rows[r] * K + k) * NCH + c] = acc;
        }
      }
    }
    if (off !== u8.length) throw new Error('trailing bytes in payload');
    let nullBallFrames = 0;
    for (let f = 0; f < F; f++) nullBallFrames += ballMissing[f];
    return { F, K, R, entities, frameNumber, poss, status, ballMissing, ball, present, pos, nullBallFrames };
  }

  async function decodeBlob(b64) {
    return parsePayload(await inflateRaw(base64ToBytes(b64)));
  }

  // ------------------------------------------------------------------ data access
  const isPresent = (d, f, k) => f >= 0 && f < d.F && d.present[f * d.K + k] === 1;

  function jointRaw(d, f, k, j, out) {
    const b = (f * d.K + k) * NCH + j * 3;
    const x = d.pos[b], y = d.pos[b + 1], z = d.pos[b + 2];
    if (x === SENTINEL || y === SENTINEL || z === SENTINEL) return false;
    out[0] = x / 100; out[1] = y / 100; out[2] = z / 100;
    return true;
  }

  /**
   * Interpolated joints for entity k at frame i blended by a toward i+1.
   * Writes meters into out[63] and per-joint presence into mask[21].
   * Returns false when the person is absent at frame i. Never interpolates
   * across a gap (absent at i+1 or joint missing at i+1) or across the wrap.
   */
  function personJoints(d, i, a, k, out, mask) {
    if (!isPresent(d, i, k)) { mask.fill(0); return false; }
    const nextOk = i + 1 < d.F && isPresent(d, i + 1, k) && a > 0;
    const p0 = [0, 0, 0], p1 = [0, 0, 0];
    for (let j = 0; j < NJ; j++) {
      if (!jointRaw(d, i, k, j, p0)) { mask[j] = 0; continue; }
      mask[j] = 1;
      const t = nextOk && jointRaw(d, i + 1, k, j, p1) ? a : 0;
      for (let c = 0; c < 3; c++) out[j * 3 + c] = t ? p0[c] + (p1[c] - p0[c]) * t : p0[c];
    }
    return true;
  }

  function ballRaw(d, f, out) {
    if (f < 0 || f >= d.F || d.ballMissing[f]) return false;
    out[0] = d.ball[f * 3] / 100; out[1] = d.ball[f * 3 + 1] / 100; out[2] = d.ball[f * 3 + 2] / 100;
    return true;
  }

  function ballPose(d, i, a, out) {
    if (!ballRaw(d, i, out)) return false;
    const n = [0, 0, 0];
    if (a > 0 && i + 1 < d.F && ballRaw(d, i + 1, n)) {
      for (let c = 0; c < 3; c++) out[c] += (n[c] - out[c]) * a;
    }
    return true;
  }

  // ------------------------------------------------------------------ playback
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function createPlayback(F) { return { t: 0, playing: false, speed: 1, F }; }
  function frameIndex(s) { return Math.min(s.F - 1, Math.floor(s.t)); }
  function blend(s) { return s.t - Math.floor(s.t); }

  function advance(s, dtMs) {
    if (!s.playing || !(dtMs > 0)) return s;
    let t = s.t + (dtMs * s.speed) / FRAME_MS;
    if (t >= s.F) t %= s.F;
    s.t = t;
    return s;
  }
  function seek(s, n) { s.t = clamp(Math.round(Number(n) || 0), 0, s.F - 1); return s; }
  function step(s, dir) { s.t = clamp(frameIndex(s) + dir, 0, s.F - 1); s.playing = false; return s; }
  function togglePlay(s) { s.playing = !s.playing; return s; }
  function setSpeed(s, v) { const n = Number(v); if (SPEEDS.includes(n)) s.speed = n; return s; }

  function frameText(index, F) { return `${index} / ${Number(F).toLocaleString('en-US')}`; }
  function elapsedText(index) { return `${(index / RATE_HZ).toFixed(1)} s`; }

  // ------------------------------------------------------------------ trails
  /** Segments [f, f+1] inside the trail window where both frames are present. */
  function trailSegments(presentFn, i, L) {
    const segs = [];
    for (let f = Math.max(0, i - L); f < i; f++) if (presentFn(f) && presentFn(f + 1)) segs.push([f, f + 1]);
    return segs;
  }
  function alpha(age, L) { return clamp(1 - age / L, 0, 1); }

  // ------------------------------------------------------------------ HUD + possession
  function hudState(d, f) {
    let persons = 0;
    for (let k = 0; k < d.K; k++) persons += d.present[f * d.K + k];
    if (d.ballMissing[f]) {
      return { ballText: 'Ball not tracked', possText: 'Unknown', statusText: 'Unknown',
        glow: COLORS.neutral, possTeam: null, persons };
    }
    const p = d.poss[f], s = d.status[f];
    const possText = p === 1 ? 'Home' : p === 2 ? 'Away' : 'No possession';
    const statusText = s === 1 ? 'In play' : s === 0 ? 'Dead ball' : 'Status unknown';
    const glow = p === 1 ? COLORS.home : p === 2 ? COLORS.away : COLORS.neutral;
    return { ballText: 'Ball tracked', possText, statusText, glow, possTeam: p === 1 ? 0 : p === 2 ? 1 : null, persons };
  }

  /** Entity index of the possessing team's player nearest the ball (2D, integer cm), or -1. */
  function ringTarget(d, f) {
    if (d.ballMissing[f]) return -1;
    const p = d.poss[f];
    if (p !== 1 && p !== 2) return -1;
    const team = p - 1;
    const bx = d.ball[f * 3], by = d.ball[f * 3 + 1];
    let best = -1, bestD = Infinity, bestJ = Infinity;
    for (let k = 0; k < d.K; k++) {
      if (d.entities[k].team !== team || !isPresent(d, f, k)) continue;
      const b = (f * d.K + k) * NCH + J.pelvis * 3;
      const x = d.pos[b], y = d.pos[b + 1];
      if (x === SENTINEL || y === SENTINEL) continue;
      const dd = (x - bx) * (x - bx) + (y - by) * (y - by);
      const jn = d.entities[k].jersey;
      if (dd < bestD || (dd === bestD && jn < bestJ)) { best = k; bestD = dd; bestJ = jn; }
    }
    return best;
  }

  // ------------------------------------------------------------------ camera math
  const DEG = Math.PI / 180;
  const ORBIT = { minEl: 5 * DEG, maxEl: 89 * DEG, minDist: 5, maxDist: 150 };

  function createOrbit() { return { az: 0.55, el: 32 * DEG, dist: 95, tx: 0, ty: 0, tz: 0 }; }
  function orbitApply(o, dAz, dEl, zoomSteps) {
    o.az = (o.az + (dAz || 0)) % (2 * Math.PI);
    o.el = clamp(o.el + (dEl || 0), ORBIT.minEl, ORBIT.maxEl);
    o.dist = clamp(o.dist * Math.pow(1.1, zoomSteps || 0), ORBIT.minDist, ORBIT.maxDist);
    return o;
  }
  /** Camera position in three.js space (y up). */
  function orbitPosition(o) {
    return [
      o.tx + o.dist * Math.cos(o.el) * Math.sin(o.az),
      o.ty + o.dist * Math.sin(o.el),
      o.tz + o.dist * Math.cos(o.el) * Math.cos(o.az),
    ];
  }
  function topDownHeight(vfovRad, aspect) {
    const t = Math.tan(vfovRad / 2);
    return 1.05 * Math.max(PITCH.width / 2 / t, PITCH.length / 2 / (t * aspect));
  }
  function followFactor(dtSec) { return 1 - Math.exp(-6 * Math.max(0, dtSec)); }

  /** POV from joints (meters, pitch coords): eye at ear midpoint looking toward the nose. */
  function povPose(joints, mask) {
    const re = J.r_ear, le = J.l_ear, no = J.nose;
    if (!mask[re] || !mask[le] || !mask[no]) return null;
    const pos = [0, 1, 2].map((c) => (joints[re * 3 + c] + joints[le * 3 + c]) / 2);
    const v = [0, 1, 2].map((c) => joints[no * 3 + c] - pos[c]);
    const len = Math.hypot(v[0], v[1], v[2]);
    if (!(len > 1e-6)) return null;
    return { pos, fwd: v.map((c) => c / len) };
  }

  // ------------------------------------------------------------------ layers + skeleton
  function createLayers() { return Object.fromEntries(LAYER_NAMES.map((n) => [n, true])); }
  function toggleLayer(layers, name) {
    if (!LAYER_NAMES.includes(name)) return layers;
    return { ...layers, [name]: !layers[name] };
  }
  function parseTrailLength(text, prev) {
    const s = String(text).trim();
    if (/^\d+$/.test(s)) {
      const n = parseInt(s, 10);
      if (n >= TRAIL.min && n <= TRAIL.max) return { value: n, error: null };
    }
    return { value: prev, error: `Accepted range is ${TRAIL.min} to ${TRAIL.max} frames` };
  }
  function skeletonInstances(mask) {
    const joints = [], bones = [];
    for (let j = 0; j < NJ; j++) if (mask[j]) joints.push(j);
    BONES.forEach(([a, b], i) => { if (mask[a] && mask[b]) bones.push(i); });
    return { joints, bones };
  }
  function shadowVisible(z) { return z > 0.5; }
  /** Pitch (x, y, z-up) -> three.js (x, y-up, z). */
  function toThree(x, y, z) { return [x, z, -y]; }

  return {
    SENTINEL, NULL8, FRAME_MS, RATE_HZ, SPEEDS, PITCH, TRAIL, JOINTS, NJ, NCH, J, BONES,
    TEAMS, COLORS, TEAM_COLORS, LAYER_NAMES, ORBIT,
    base64ToBytes, inflateRaw, parsePayload, decodeBlob,
    isPresent, jointRaw, personJoints, ballRaw, ballPose,
    createPlayback, frameIndex, blend, advance, seek, step, togglePlay, setSpeed, frameText, elapsedText,
    trailSegments, alpha, hudState, ringTarget,
    createOrbit, orbitApply, orbitPosition, topDownHeight, followFactor, povPose,
    createLayers, toggleLayer, parseTrailLength, skeletonInstances, shadowVisible, toThree, clamp,
  };
});
