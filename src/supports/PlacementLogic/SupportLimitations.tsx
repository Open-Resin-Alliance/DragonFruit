import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { MouseTooltip } from '../../components/ui/MouseTooltip';

import { LimitationCode, WarningCode } from '../types';

// Module level so React Compiler cannot rename anything the Lingui macro reads.
export const SupportLimitations: Record<LimitationCode, MessageDescriptor> = {
    ANGLE_TOO_STEEP: msg`Surface angle is upward facing. Supports cannot be placed here.`,
    KNOT_ABOVE_TIP: msg`Support base must be below the tip (knot cannot be above the tip).`,
    ANCHOR_BELOW_ROOT: msg`Contact point is lower than the anchor root — the shaft would extend below the root joint.`,
    COLLISION_WITH_MODEL: msg`Support would collide with the model geometry.`,
    TOO_CLOSE_TO_EXISTING: msg`Too close to an existing support.`,
    OUT_OF_BOUNDS: msg`Support placement is outside the build volume.`
};

export const SupportWarnings: Record<WarningCode, MessageDescriptor> = {
    ANGLE_VERTICAL_WARNING: msg`Horizontal angles are not good for holding up overhangs. They are only good for lateral stability.`,
    SHAFT_ANGLE_TOO_FLAT: msg`Support angle is too flat (must be >10° from horizontal).`
};

export function getLimitationMessage(
    code: LimitationCode | WarningCode,
    translate: (descriptor: MessageDescriptor) => string,
): string {
    if (code in SupportLimitations) return translate(SupportLimitations[code as LimitationCode]);
    if (code in SupportWarnings) return translate(SupportWarnings[code as WarningCode]);
    return translate(msg`Placement message.`);
}

interface SupportLimitationFeedbackProps {
    error: LimitationCode | null;
    warning?: WarningCode | null;
}

export function SupportLimitationFeedback({ error, warning }: SupportLimitationFeedbackProps) {
    const { _ } = useLingui();
    if (!error && !warning) return null;

    const code = error || warning!;
    const isError = !!error;
    const message = getLimitationMessage(code, _);

    // Styles
    const bgClass = isError
        ? "bg-red-900/90 border-red-500 text-red-200"
        : "bg-yellow-900/90 border-yellow-500 text-yellow-200";

    const title = isError ? _(msg`Cannot Place Support`) : _(msg`Stability Warning`);

    return (
        <MouseTooltip
            visible={true}
            offset={{ x: 65, y: 15 }}
            className={`${bgClass} text-white text-xs px-3 py-2 rounded shadow-lg border backdrop-blur-sm max-w-[250px]`}
        >
            <div className={`font-bold mb-0.5 ${isError ? "text-red-100" : "text-yellow-100"}`}>{title}</div>
            <div>{message}</div>
        </MouseTooltip>
    );
}
