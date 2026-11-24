// Turn beams into a point path a galvo-scanning laser can draw. A "beam" on a
// real projector is the scanner parking on one spot with the laser on, so
// each beam becomes a dwell of lit points with blanked travel moves between.

import type { Beam } from './types';
import { clamp } from './util';

export interface PathOptions {
  /** Lit points per beam — more = brighter, but fewer beams per second. */
  dwell: number;
  /** Blanked points to move between beams (lets the mirrors settle). */
  blanks: number;
}

/** Flat [x, y, r, g, b, ...] with x/y in -1..1 of the scan field. */
export function beamsToPoints(beams: Beam[], scanAngle: number, opts: PathOptions = { dwell: 8, blanks: 5 }): number[] {
  const half = Math.max(1, scanAngle / 2);
  // Visit beams left-to-right, then return — shortest path for fans.
  const sorted = [...beams].sort((a, b) => a.x - b.x || a.y - b.y);
  const out: number[] = [];
  let px = 0;
  let py = 0;
  for (const b of sorted) {
    const x = clamp(b.x / half, -1, 1);
    const y = clamp(b.y / half, -1, 1);
    for (let i = 1; i <= opts.blanks; i++) {
      const t = i / opts.blanks;
      out.push(px + (x - px) * t, py + (y - py) * t, 0, 0, 0);
    }
    const a = clamp(b.a, 0, 1);
    for (let i = 0; i < opts.dwell; i++) out.push(x, y, b.r * a, b.g * a, b.b * a);
    px = x;
    py = y;
  }
  // Park blanked in the centre when there's nothing to draw.
  if (!out.length) out.push(0, 0, 0, 0, 0);
  return out;
}
