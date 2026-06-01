/*
 * track.js — the procedurally-generated, endless 1-D road.
 *
 * The road is still a polyline of (length, slope) segments, but instead of a
 * fixed list it's grown on demand: call generateTo(s) and it appends random
 * segments until the road reaches arc-length `s`. Coordinates are world units
 * (x right, y up, metres); the car's position is an arc-length `s` along it.
 *
 * Lookups (slope/position by `s`, height by `x`) use binary search, and `x`
 * increases monotonically with point index because every segment advances in
 * x — so the road can grow indefinitely without lookups getting slower.
 *
 * "Features" (stop signs and traffic lights) are placed randomly on the
 * longer flat sections as the road is generated.
 */

class Track {
  constructor() {
    this.pts = [{ x: 0, y: 0 }];
    this.cumArc = [0];   // cumulative arc length at each point
    this.segSlope = [];  // slope angle (rad) of each segment
    this.segArc = [];    // arc length of each segment

    this.features = [];          // {type, s, x, y, ...}
    this.distSinceFeature = 0;   // metres since the last feature was placed
    this.featureCount = 0;       // how many features placed so far
    this.flatRemaining = 200;    // start on a guaranteed flat run

    this.generateTo(240);
  }

  get length() { return this.cumArc[this.cumArc.length - 1]; }

  appendSegment(len, deg) {
    const theta = (deg * Math.PI) / 180;
    const last = this.pts[this.pts.length - 1];
    const x = last.x + len;
    const y = last.y + len * Math.tan(theta);
    this.pts.push({ x, y });
    const arc = len / Math.cos(theta);
    const startS = this.cumArc[this.cumArc.length - 1];
    this.segSlope.push(theta);
    this.segArc.push(arc);
    this.cumArc.push(startS + arc);
    return { startS, len, theta };
  }

  // Should the feature with this index sit on a steep hill?
  // The first 3 features are always on the flat (easy warm-up); after that
  // every third feature is forced onto a steep grade.
  steepFeature(index) {
    return index >= 3 && (index - 3) % 3 === 0;
  }

  // Append segments until the road reaches arc-length targetS. Terrain is
  // random for variety, but feature placement is deterministic: once we're
  // due for a feature we force the segment it lands on to the required shape
  // (flat or steep hill) so the schedule above is guaranteed.
  generateTo(targetS) {
    while (this.length < targetS) {
      // Time to place a feature? Force its terrain and drop it on.
      if (this.flatRemaining <= 0 && this.distSinceFeature > 110) {
        let len, deg;
        if (this.steepFeature(this.featureCount)) {
          const mag = 10 + Math.random() * 6;        // steep grade
          deg = (Math.random() < 0.5 ? -1 : 1) * mag;
          len = 40 + Math.random() * 20;             // long enough to stop on
        } else {
          deg = 0;                                    // flat
          len = 50 + Math.random() * 30;
        }
        const seg = this.appendSegment(len, deg);
        this.addFeature(seg);
        this.featureCount++;
        this.distSinceFeature = 0;
        continue;
      }

      // Otherwise lay down ordinary random terrain.
      let len, deg;
      if (this.flatRemaining > 0) {
        deg = 0;
        len = Math.min(this.flatRemaining, 60);
        this.flatRemaining -= len;
      } else {
        const r = Math.random();
        if (r < 0.42) {
          deg = 0;                       // flat stretch
          len = 40 + Math.random() * 50;
        } else {
          const steep = Math.random() < 0.18;
          const mag = steep ? 10 + Math.random() * 6 : 3 + Math.random() * 6;
          deg = (Math.random() < 0.5 ? -1 : 1) * mag;
          len = 22 + Math.random() * 30;
        }
      }
      this.appendSegment(len, deg);
      this.distSinceFeature += len;
    }
  }

  addFeature(seg) {
    const s = seg.startS + seg.len * 0.6;
    const pos = this.posAt(s);
    if (Math.random() < 0.5) {
      this.features.push({ type: 'stop', s, x: pos.x, y: pos.y, passed: false, satisfied: false });
    } else {
      const p = Math.random();
      this.features.push({
        type: 'light', s, x: pos.x, y: pos.y, passed: false,
        state: p < 0.5 ? 'green' : p < 0.68 ? 'yellow' : 'red',
        t: Math.random() * 4,
      });
    }
  }

  // Advance traffic-light timers.
  updateLights(dt) {
    const G = 6, Y = 2, R = 6; // seconds per phase
    for (const f of this.features) {
      if (f.type !== 'light') continue;
      f.t += dt;
      if (f.state === 'green' && f.t >= G) { f.state = 'yellow'; f.t = 0; }
      else if (f.state === 'yellow' && f.t >= Y) { f.state = 'red'; f.t = 0; }
      else if (f.state === 'red' && f.t >= R) { f.state = 'green'; f.t = 0; }
    }
  }

  // ---- lookups (binary search) ----
  segmentAt(s) {
    s = Math.max(0, Math.min(this.length, s));
    let lo = 0, hi = this.segArc.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cumArc[mid] <= s) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  slopeAt(s) { return this.segSlope[this.segmentAt(s)]; }

  posAt(s) {
    s = Math.max(0, Math.min(this.length, s));
    const i = this.segmentAt(s);
    const frac = this.segArc[i] === 0 ? 0 : (s - this.cumArc[i]) / this.segArc[i];
    const a = this.pts[i], b = this.pts[i + 1];
    return { x: a.x + frac * (b.x - a.x), y: a.y + frac * (b.y - a.y) };
  }

  heightAtX(x) {
    const pts = this.pts;
    if (x <= pts[0].x) return pts[0].y;
    const last = pts[pts.length - 1];
    if (x >= last.x) return last.y;
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].x <= x) lo = mid; else hi = mid;
    }
    const a = pts[lo], b = pts[hi];
    return a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y);
  }
}

function buildDefaultTrack() {
  return new Track();
}
