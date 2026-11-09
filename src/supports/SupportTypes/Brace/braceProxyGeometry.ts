import { registerSupportProxyGeometry } from '../../proxyGeometry/seam';
import { braceBezierToBatchedShaft } from '../../Curves/batchedBezierShaft';
import { braceSpanDiameters } from './braceSpanDiameters';
import { knotHostId, spanKnotHostType } from '../../supportTypeRegistry';
import type { Brace } from '../../types';

/**
 * A brace spans two knots and is addressed as a segment of its own, under the
 * synthetic id its type declares.
 *
 * The visual diameter is derived from the host knot diameters rather than read
 * off `profile.diameter`, mirroring SupportRenderer: the profile value alone
 * produces the thin brace setting and loses the dynamic sizing that matches the
 * trunk thickness the brace attaches to.
 */
registerSupportProxyGeometry<Brace>('brace', (brace, ctx) => {
  const startKnot = ctx.state.knots[brace.startKnotId];
  const endKnot = ctx.state.knots[brace.endKnotId];
  if (!startKnot || !endKnot) return;

  const { startDiameterMm: startHostDiameter, endDiameterMm: endHostDiameter } =
    braceSpanDiameters(brace, startKnot, endKnot);

  const braceDiameter = (startHostDiameter + endHostDiameter) * 0.5;

  if (brace.curve?.type === 'bezier') {
    ctx.pushShaft(braceBezierToBatchedShaft(
      knotHostId(spanKnotHostType(), brace.id),
      startKnot.pos,
      endKnot.pos,
      brace.curve.controlPoint1,
      brace.curve.controlPoint2,
      braceDiameter,
      brace.curve.resolution,
      brace.id,
      brace.modelId,
    ));
    return;
  }

  ctx.pushShaft({
    id: knotHostId(spanKnotHostType(), brace.id),
    supportId: brace.id,
    modelId: brace.modelId,
    start: startKnot.pos,
    end: endKnot.pos,
    diameter: startHostDiameter,
    diameterEnd: endHostDiameter,
  });
}, { skipInInteriorView: true });
