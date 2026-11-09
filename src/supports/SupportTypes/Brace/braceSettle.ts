import { registerSupportSettle } from '../../settle/seam';
import {
  getChangedKnotPositions,
  recomputeConeHostKnotGeometry,
  recomputeKnotDependentGeometry,
  recomputeSpanHostKnotGeometry,
} from '../../state';

/**
 * A written brace settles the knots it spans, and only then the leaves hanging
 * off them; the leaf pass runs only if the span's own knots moved. A second
 * span-host pass follows, because moving a leaf's cone can move the knot it
 * rides, and a brace spanning that knot resolves again from there.
 */
registerSupportSettle('brace', ({ next }) => {
  const spanHost1 = recomputeSpanHostKnotGeometry(next.braces, next.knots);
  const changedByBrace1 = getChangedKnotPositions(next.knots, spanHost1.knots);

  if (Object.keys(changedByBrace1).length === 0) {
    return { knots: spanHost1.knots };
  }

  const nextLeaves = recomputeKnotDependentGeometry(next.leaves, changedByBrace1);
  const coneHost = recomputeConeHostKnotGeometry(nextLeaves, spanHost1.knots);
  const spanHost2 = recomputeSpanHostKnotGeometry(next.braces, coneHost.knots);
  return { knots: spanHost2.knots, leaves: nextLeaves };
});
