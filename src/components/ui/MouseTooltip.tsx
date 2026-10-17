import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clampToViewport } from '@/utils/math';

interface MouseTooltipProps {
    children: React.ReactNode;
    visible?: boolean;
    offset?: { x: number; y: number };
    className?: string;
}

export function MouseTooltip({
    children,
    visible = true,
    offset = { x: 15, y: 15 },
    className = ""
}: MouseTooltipProps) {
    const [pos, setPos] = useState<{ x: number, y: number } | null>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!visible) {
            setPos(null);
            return;
        }

        const handleMouseMove = (e: MouseEvent) => {
            setPos({ x: e.clientX, y: e.clientY });
        };

        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, [visible]);

    // Placed after it renders, from the size it actually has. Measured at the cursor, a box
    // near the right edge wraps to whatever width is left there; a position worked out from
    // that width puts it somewhere it then grows out of, and it took three mouse moves to
    // settle. At the viewport's corner nothing squeezes it.
    useLayoutEffect(() => {
        const el = tooltipRef.current;
        if (!el || !pos) return;
        el.style.width = '';
        el.style.left = '0px';
        el.style.top = '0px';
        const rect = el.getBoundingClientRect();
        // Held at that width wherever it lands: its room to grow is measured from `left`, which
        // a caller's translate class keeps away from where the box is actually drawn.
        el.style.width = `${rect.width}px`;
        // How far a caller's translate class moves the box off its `left`/`top`.
        const shiftX = rect.left;
        const shiftY = rect.top;
        const { left, top, overflowRight, overflowBottom } = clampToViewport(
            { x: pos.x + offset.x + shiftX, y: pos.y + offset.y + shiftY },
            { width: rect.width, height: rect.height },
            { margin: 0 },
        );
        // Flip to the other side of the cursor rather than cover it.
        const boxLeft = overflowRight ? Math.max(0, pos.x - offset.x - rect.width) : left;
        const boxTop = overflowBottom ? Math.max(0, pos.y - offset.y - rect.height) : top;
        el.style.left = `${boxLeft - shiftX}px`;
        el.style.top = `${boxTop - shiftY}px`;
    });

    if (!visible || !pos) return null;

    return (
        <div
            ref={tooltipRef}
            className={`fixed pointer-events-none z-[9999] ${className}`}
        >
            {children}
        </div>
    );
}
