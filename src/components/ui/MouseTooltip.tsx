import React, { useEffect, useRef, useState } from 'react';
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

    if (!visible || !pos) return null;

    // Compute clamped position to keep tooltip on-screen, flipping sides when
    // the box would overflow the viewport's right/bottom edge.
    let left = pos.x + offset.x;
    let top = pos.y + offset.y;
    const el = tooltipRef.current;
    if (el) {
        const rect = el.getBoundingClientRect();
        const {
            left: clampedLeft,
            top: clampedTop,
            overflowRight,
            overflowBottom,
        } = clampToViewport(
            { x: left, y: top },
            { width: rect.width, height: rect.height },
            { margin: 0 },
        );
        left = overflowRight ? pos.x - offset.x - rect.width : clampedLeft;
        top = overflowBottom ? pos.y - offset.y - rect.height : clampedTop;
    }

    return (
        <div
            ref={tooltipRef}
            className={`fixed pointer-events-none z-[9999] ${className}`}
            style={{ left, top }}
        >
            {children}
        </div>
    );
}
