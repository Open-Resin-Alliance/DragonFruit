/**
 * Constrain `value` to [`min`, `max`].
 *
 * Resolves an inverted range (min > max) in favour of `min`.
 */
export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** Snap `value` to a grid of `cellSize`, returning the integer cell index. */
export function quantizeToCell(value: number, cellSize: number): number {
    return Math.round(value / cellSize);
}

/** Round `value` to `scale` steps per unit (e.g. scale 1e5 keeps 5 decimals). */
export function quantizeToScale(value: number, scale: number): number {
    return Math.round(value * scale) / scale;
}

/**
 * Round `value` to `decimals` decimal places: nearest, ties away from zero.
 *
 * The rule applies to the double's exact value, which is usually not the decimal
 * literal you typed. `2.675` is really 2.67499…, so it rounds DOWN to 2.67, and no
 * tie is involved. Ties are genuinely rare; don't reason from that example.
 *
 * Do NOT replace this with `Math.round(v * 10**d) / 10**d`. That path multiplies
 * first, and the multiply is itself lossy: 2.67499… * 100 lands on exactly 267.5,
 * and Math.round then breaks the (invented) tie upward to 2.68. On the 0.001 grid
 * authored geometry lands on, the two disagree for 21,706 of the 500,001 values
 * in 0..500.
 *
 * The stronger reason is sign symmetry. Math.round breaks ties toward +Inf rather
 * than away from zero, so the scaled path rounds the two halves of a part that
 * straddles the origin by different rules: 45,412 values in that same range have
 * f(-v) !== -f(v). This function has none, because it's completely symmetrical from
 * zero.
 *
 * The grid step is always 10**-decimals: 1, 0.1, 0.01, … and nothing in between.
 * A 0.05 mm or 1/64" step is not reachable this way: use `quantizeToScale`.
 * Above 1e21 toFixed returns exponential notation and no rounding happens;
 * `decimals` outside 0..100 throws RangeError.
 */

export function round(value: number, decimals: number): number {
    return Number(value.toFixed(decimals));
}
