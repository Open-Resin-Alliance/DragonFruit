import React, { useEffect, useState } from 'react';

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

    return (
        <div 
            className={`fixed pointer-events-none z-50 ${className}`}
            style={{
                left: pos.x + offset.x,
                top: pos.y + offset.y,
            }}
        >
            {children}
        </div>
    );
}
