/**
 * How much of the hover tint a marquee candidate gets.
 *
 * A candidate lights up the model, its supports and its raft at once, so at
 * full hover strength it reads as loud as a committed selection. Damping it
 * keeps the two apart, and leaves the user's own hover strength alone.
 */
export const MARQUEE_CANDIDATE_TINT_FACTOR = 0.6;
