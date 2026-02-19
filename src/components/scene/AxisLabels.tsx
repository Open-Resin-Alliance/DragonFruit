"use client";

import React from 'react';
import * as THREE from 'three';

/**
 * Axis labels for X, Y, Z axes using sprites (no font loading)
 */
export function AxisLabels({ size = 100 }: { size?: number }) {
  const labelOffset = size + 10;
  
  // Create canvas-based texture for each label
  const createLabelTexture = (text: string, color: string) => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;
    
    canvas.width = 64;
    canvas.height = 64;
    
    context.fillStyle = color;
    context.font = 'Bold 48px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 32, 32);
    
    const texture = new THREE.CanvasTexture(canvas);
    return texture;
  };
  
  const xTexture = React.useMemo(() => createLabelTexture('X', '#ff0000'), []);
  const yTexture = React.useMemo(() => createLabelTexture('Y', '#00ff00'), []);
  const zTexture = React.useMemo(() => createLabelTexture('Z', '#0000ff'), []);
  
  const nullRaycast = () => null;

  return (
    <>
      {/* X axis - Red */}
      {xTexture && (
        <sprite position={[labelOffset, 0, 0]} scale={[8, 8, 1]} raycast={nullRaycast}>
          <spriteMaterial map={xTexture} transparent sizeAttenuation={true} depthTest={false} depthWrite={false} toneMapped={false} />
        </sprite>
      )}
      
      {/* Y axis - Green */}
      {yTexture && (
        <sprite position={[0, labelOffset, 0]} scale={[8, 8, 1]} raycast={nullRaycast}>
          <spriteMaterial map={yTexture} transparent sizeAttenuation={true} depthTest={false} depthWrite={false} toneMapped={false} />
        </sprite>
      )}
      
      {/* Z axis - Blue */}
      {zTexture && (
        <sprite position={[0, 0, labelOffset]} scale={[8, 8, 1]} raycast={nullRaycast}>
          <spriteMaterial map={zTexture} transparent sizeAttenuation={true} depthTest={false} depthWrite={false} toneMapped={false} />
        </sprite>
      )}
    </>
  );
}
