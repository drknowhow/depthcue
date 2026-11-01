/** The numbers behind a chart's axes: round ticks, and a straight line from data to the drawing. */

export interface Ticks {
  /** The round values to mark, from the first to the last. */
  ticks: number[];
  lo: number;
  hi: number;
}

/**
 * About `count` round ticks that cover min to max. The step is 1, 2 or 5 times a power of ten, so a tick is a number
 * a person would say, and every tick is rounded to the step's own decimals, so 0.1 + 0.2 is 0.3. `zero` stretches the
 * range to take in 0, as a bar needs. A flat or empty range still gets a range with room on both sides.
 */
export function niceTicks(min: number, max: number, count = 4, zero = false): Ticks {
  let lo = zero ? Math.min(0, min) : min;
  let hi = zero ? Math.max(0, max) : max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (hi === lo) {
    const pad = Math.abs(hi) || 1;
    lo -= zero && lo === 0 ? 0 : pad / 2;
    hi += pad / 2;
  }
  const raw = (hi - lo) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const step = (unit <= 1.4 ? 1 : unit <= 3.1 ? 2 : unit <= 7 ? 5 : 10) * power;
  const places = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const first = Math.floor(lo / step + 1e-9);
  const last = Math.ceil(hi / step - 1e-9);
  const ticks: number[] = [];
  for (let i = first; i <= last; i++) ticks.push(Number((i * step).toFixed(places)));
  return { ticks, lo: ticks[0] as number, hi: ticks[ticks.length - 1] as number };
}

/** A straight map from the domain d0 to d1 onto the range r0 to r1, which may run backward, as a y axis does. */
export const linear =
  (d0: number, d1: number, r0: number, r1: number) =>
  (value: number): number =>
    d1 === d0 ? (r0 + r1) / 2 : r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);

/** The text cut to fit `room` characters, with an ellipsis where it was cut. The whole text is in the data table. */
export const fit = (text: string, room: number): string =>
  text.length <= room ? text : `${text.slice(0, Math.max(1, Math.floor(room) - 1))}…`;
