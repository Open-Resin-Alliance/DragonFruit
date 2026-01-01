import * as THREE from 'three';

export type RaftBottomMode = 'off' | 'solid' | 'line';

export interface RaftSettings {
  bottomMode: RaftBottomMode;
  wallEnabled: boolean;
  thickness: number;           // mm
  chamferAngle: number;        // degrees (45-90)
  wallHeight: number;          // mm
  wallThickness: number;       // mm
  crenulationGapWidth: number; // mm
  crenulationSpacing: number;  // mm
  lineWidthMm: number;         // mm
  lineHeightMm: number;        // mm
  showFootprintBorder: boolean; // Show combined model+raft footprint border
  footprintBorderMargin: number; // mm - margin beyond raft/model edge
}

export interface RaftGeometry {
  baseProfile: THREE.Vector2[];      // 2D footprint points
  baseMesh: THREE.Mesh;         // Main raft plate
  wallMesh: THREE.Mesh;         // Perimeter wall with crenulations
  boundingBox: THREE.Box3;      // For collision detection
}

// Input representation for a support base footprint circle
export interface SupportBaseCircle {
  x: number;   // center X in mm
  y: number;   // center Y in mm
  r: number;   // radius in mm (half of base diameter)
}

// Options for computing raft footprint from support base circles
export interface ComputeFootprintOptions {
  marginMm?: number;       // additional outward buffer beyond circle radius
  samplesPerCircle?: number; // number of points to sample per circle (>=8)
}

export type FootprintProfile = THREE.Vector2[];
