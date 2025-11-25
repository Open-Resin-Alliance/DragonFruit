/**
 * GPU Picking System - Debug Overlay
 * 
 * Displays real-time picking information for testing and debugging.
 * Shows what's under the cursor without affecting the actual scene.
 */

"use client";

import React from 'react';
import { usePicking } from './PickingContext';
import { PICK_ID } from './constants';

interface PickingDebugOverlayProps {
  /** Position of the overlay */
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

/**
 * PickingDebugOverlay - Shows current picking state.
 * 
 * Place this as a sibling to your Canvas (not inside it) to see
 * real-time picking information.
 * 
 * @example
 * <div style={{ position: 'relative' }}>
 *   <Canvas>
 *     <PickingProvider debug>
 *       <YourScene />
 *     </PickingProvider>
 *   </Canvas>
 *   <PickingDebugOverlay />
 * </div>
 */
export function PickingDebugOverlay({ 
  position = 'top-right' 
}: PickingDebugOverlayProps) {
  const { hit, config, isPaused } = usePicking();
  
  // Position styles
  const positionStyles: React.CSSProperties = {
    'top-left': { top: 10, left: 10 },
    'top-right': { top: 10, right: 10 },
    'bottom-left': { bottom: 10, left: 10 },
    'bottom-right': { bottom: 10, right: 10 },
  }[position];
  
  // Format the hit info
  const gizmoHandle = 'gizmoHandle' in hit ? hit.gizmoHandle : undefined;
  const parentId = 'parentId' in hit ? hit.parentId : undefined;
  
  const hitInfo = hit.pickId === PICK_ID.NONE
    ? 'Nothing'
    : `${hit.category}${hit.objectId ? ` (${hit.objectId.slice(0, 8)}...)` : ''}${gizmoHandle ? ` [${gizmoHandle}]` : ''}`;
  
  return (
    <div
      style={{
        position: 'absolute',
        ...positionStyles,
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        color: '#fff',
        padding: '8px 12px',
        borderRadius: 4,
        fontFamily: 'monospace',
        fontSize: 11,
        zIndex: 1000,
        pointerEvents: 'none',
        minWidth: 180,
      }}
    >
      <div style={{ fontWeight: 'bold', marginBottom: 4, color: '#4fc3f7' }}>
        GPU Picking Debug
      </div>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px' }}>
        <span style={{ color: '#888' }}>Status:</span>
        <span style={{ color: isPaused ? '#ff9800' : config.enabled ? '#4caf50' : '#f44336' }}>
          {isPaused ? 'Paused' : config.enabled ? 'Active' : 'Disabled'}
        </span>
        
        <span style={{ color: '#888' }}>Pick ID:</span>
        <span>{hit.pickId}</span>
        
        <span style={{ color: '#888' }}>Category:</span>
        <span style={{ color: getCategoryColor(hit.category) }}>{hit.category}</span>
        
        <span style={{ color: '#888' }}>Object:</span>
        <span>{hit.objectId ? hit.objectId.slice(0, 12) + '...' : '—'}</span>
        
        {gizmoHandle && (
          <>
            <span style={{ color: '#888' }}>Handle:</span>
            <span style={{ color: '#ffeb3b' }}>{gizmoHandle}</span>
          </>
        )}
        
        {parentId && (
          <>
            <span style={{ color: '#888' }}>Parent:</span>
            <span>{parentId.slice(0, 12)}...</span>
          </>
        )}
        
        <span style={{ color: '#888' }}>Screen:</span>
        <span>
          {hit.screenPosition.x.toFixed(2)}, {hit.screenPosition.y.toFixed(2)}
        </span>
        
        <span style={{ color: '#888' }}>Patch:</span>
        <span>{config.patchSize}×{config.patchSize}</span>
        
        <span style={{ color: '#888' }}>Rate:</span>
        <span>{config.hoverUpdateRate} Hz</span>
      </div>
      
      <div 
        style={{ 
          marginTop: 6, 
          paddingTop: 6, 
          borderTop: '1px solid #333',
          color: getCategoryColor(hit.category),
          fontWeight: 'bold',
        }}
      >
        {hitInfo}
      </div>
    </div>
  );
}

/**
 * Get a color for a category (for visual distinction).
 */
function getCategoryColor(category: string): string {
  switch (category) {
    case 'model': return '#2196f3';
    case 'support': return '#ff9800';
    case 'joint': return '#4caf50';
    case 'raft': return '#9c27b0';
    case 'gizmo': return '#ffeb3b';
    case 'none': return '#666';
    default: return '#fff';
  }
}
