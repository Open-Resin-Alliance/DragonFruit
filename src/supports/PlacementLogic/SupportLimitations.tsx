import React from 'react';
import { MouseTooltip } from '../../components/ui/MouseTooltip';

import { LimitationCode, WarningCode } from '../types';

export const SupportLimitations: Record<LimitationCode, string> = {
    ANGLE_TOO_STEEP: "Surface angle is upward facing. Supports cannot be placed here.",
    KNOT_ABOVE_TIP: "Support base must be below the tip (knot cannot be above the tip).",
    COLLISION_WITH_MODEL: "Support would collide with the model geometry.",
    TOO_CLOSE_TO_EXISTING: "Too close to an existing support.",
    OUT_OF_BOUNDS: "Support placement is outside the build volume."
};

export const SupportWarnings: Record<WarningCode, string> = {
    ANGLE_VERTICAL_WARNING: "Horizontal angles are not good for holding up overhangs. They are only good for lateral stability.",
    SHAFT_ANGLE_TOO_FLAT: "Support angle is too flat (must be >10° from horizontal)."
};

export function getLimitationMessage(code: LimitationCode | WarningCode): string {
    if (code in SupportLimitations) return SupportLimitations[code as LimitationCode];
    if (code in SupportWarnings) return SupportWarnings[code as WarningCode];
    return "Placement message.";
}

interface SupportLimitationFeedbackProps {
    error: LimitationCode | null;
    warning?: WarningCode | null;
}

export function SupportLimitationFeedback({ error, warning }: SupportLimitationFeedbackProps) {
    if (!error && !warning) return null;

    const code = error || warning!;
    const isError = !!error;
    const message = getLimitationMessage(code);

    // Styles
    const bgClass = isError
        ? "bg-red-900/90 border-red-500 text-red-200"
        : "bg-yellow-900/90 border-yellow-500 text-yellow-200";

    const title = isError ? "Cannot Place Support" : "Stability Warning";

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
