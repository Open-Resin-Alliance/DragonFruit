import { registerLateralStabiliser, type LateralStabiliserRequest } from '../../supportTypeRegistry';
import type { SupportState } from '../../types';
import type { AutoBracingSettings } from '../../autoBracing/settings';
import { generateRequiredKickstands } from './kickstandStabiliser';

/**
 * A kickstand stabilises a shaft without needing a partner to brace against,
 * so auto-bracing can ask for one when no neighbouring shaft is in reach.
 */
registerLateralStabiliser('kickstand', (request: LateralStabiliserRequest) => generateRequiredKickstands(
    request.snapshot as SupportState,
    request.existing as Pick<SupportState, 'kickstands' | 'roots' | 'knots'>,
    request.settings as AutoBracingSettings,
    request.existingEdges as Array<{ a: string; b: string; angleRad: number }>,
    request.gridSettings,
));
