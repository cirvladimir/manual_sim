/*
 * track.js — the 1-D road.
 *
 * The road is a polyline built from segments of (horizontal length, slope).
 * Coordinates are world units: x to the right, y *up*, in metres. The car's
 * position is an arc-length `s` along this polyline; this module converts
 * `s` into a world (x, y) for drawing and reports the local slope angle so
 * the physics knows the gravity component.
 */

class Track {
  // segments: [ [horizontalLengthMeters, slopeDegrees], ... ]
  constructor(segments) {
    this.pts = [];        // {x, y} world points (y up)
    this.segSlope = [];   // slope angle (radians) of each segment
    this.cumArc = [0];    // cumulative arc length at each point
    this.segArc = [];     // arc length of each segment

    let x = 0, y = 0;
    this.pts.push({ x, y });
    for (const [len, deg] of segments) {
      const theta = (deg * Math.PI) / 180;
      const dx = len;
      const dy = len * Math.tan(theta);
      x += dx;
      y += dy;
      this.pts.push({ x, y });
      const arc = len / Math.cos(theta);
      this.segSlope.push(theta);
      this.segArc.push(arc);
      this.cumArc.push(this.cumArc[this.cumArc.length - 1] + arc);
    }
    this.length = this.cumArc[this.cumArc.length - 1];
  }

  // Find the segment index containing arc-length s.
  segmentAt(s) {
    s = Math.max(0, Math.min(this.length, s));
    // linear scan is fine for a short track
    let i = 0;
    while (i < this.segArc.length - 1 && s > this.cumArc[i + 1]) i++;
    return i;
  }

  slopeAt(s) {
    return this.segSlope[this.segmentAt(s)];
  }

  // World position {x, y} at arc-length s.
  posAt(s) {
    s = Math.max(0, Math.min(this.length, s));
    const i = this.segmentAt(s);
    const frac = this.segArc[i] === 0 ? 0 : (s - this.cumArc[i]) / this.segArc[i];
    const a = this.pts[i], b = this.pts[i + 1];
    return { x: a.x + frac * (b.x - a.x), y: a.y + frac * (b.y - a.y) };
  }

  // Sample world height (y) at a given world x — used to draw the ground
  // across the whole visible window, not just under the car.
  heightAtX(x) {
    if (x <= this.pts[0].x) return this.pts[0].y;
    const last = this.pts[this.pts.length - 1];
    if (x >= last.x) return last.y;
    for (let i = 0; i < this.pts.length - 1; i++) {
      const a = this.pts[i], b = this.pts[i + 1];
      if (x >= a.x && x <= b.x) {
        const f = (x - a.x) / (b.x - a.x);
        return a.y + f * (b.y - a.y);
      }
    }
    return last.y;
  }
}

// A course with flats, gentle and steep hills, and descents.
function buildDefaultTrack() {
  return new Track([
    [60, 0],
    [35, 7],    // gentle climb — practice a rolling hill start
    [40, 0],
    [30, -6],   // descent
    [50, 0],
    [20, 14],   // steep climb — easy to stall / roll back
    [25, 0],
    [40, -10],  // steeper descent
    [60, 0],
    [30, 9],
    [400, 0],   // long flat runout to row through the gears
  ]);
}
