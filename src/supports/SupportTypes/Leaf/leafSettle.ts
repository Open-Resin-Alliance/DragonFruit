import { registerSupportSettle } from '../../settle/seam';
import { recomputeConeHostKnotGeometry, recomputeSpanHostKnotGeometry } from '../../state';

/**
 * A written leaf settles the knots on the shaft it hangs from: the cone-host
 * pass moves the knot, then the span-host pass moves whatever spans hang off
 * the knots that moved. The reverse order would read unmoved knots.
 */
registerSupportSettle('leaf', ({ next }) => {
  const coneHost = recomputeConeHostKnotGeometry(next.leaves, next.knots);
  const spanHost = recomputeSpanHostKnotGeometry(next.braces, coneHost.knots);
  return { knots: spanHost.knots };
});
