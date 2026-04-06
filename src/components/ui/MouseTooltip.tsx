import React, { useEffect, useRef, useState } from 'react';

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

    // Compute clamped position to keep tooltip on-screen
    let left = pos.x + offset.x;
    let top = pos.y + offset.y;
    const el = tooltipRef.current;
    if (el) {
        const rect = el.getBoundingClientRect();
        if (left + rect.width > window.innerWidth) {
            left = pos.x - offset.x - rect.width;
        }
        if (top + rect.height > window.innerHeight) {
            top = pos.y - offset.y - rect.height;
        }
    }

    return (
        <div
            ref={tooltipRef}
            className={`fixed pointer-events-none z-50 ${className}`}
            style={{ left, top }}
        >
            {children}
        </div>
    );
}
