"use client";

import React from 'react';
import * as THREE from 'three';
import { SupportSettings } from './types';
import { PlacementValidationLevel } from './validation';

/**
 * Renders a preview support (semi-transparent) at the hover position.
 */
export function SupportPreview({
  tip,
  base,
  settings,
  tipNormal,
  validationLevel = 'valid',
  joints
}: {
  tip: { x: number; y: number; z: number };
  base: { x: number; y: number; z: number };
  settings: SupportSettings;
  tipNormal?: { x: number; y: number; z: number };
  validationLevel?: PlacementValidationLevel;
  joints?: Array<{ id: string; position: { x: number; y: number; z: number }; ballDiameterMm: number; order: number }>;
}) {
  // Tip geometry parameters
  const tipPointRadius = settings.tip.contactDiameterMm / 2; // Small end (touches model)
  const tipBaseRadius = settings.tip.bodyDiameterMm / 2; // Large end (connects to shaft)
  const tipLength = settings.tip.lengthMm;

  // Shaft parameters
  const shaftRadius = settings.mid.diameterMm / 2;

  // Base parameters
  const baseRadius = settings.base.diameterMm / 2;
  const baseHeight = settings.base.heightMm;

  // If we have tipNormal, use it (pointing away from model); otherwise assume vertical
  const tipDir = tipNormal
    ? new THREE.Vector3(tipNormal.x, tipNormal.y, tipNormal.z).normalize()
    : new THREE.Vector3(0, 0, 1);

  // Tip end point
  const tipEnd = new THREE.Vector3(
    tip.x + tipDir.x * tipLength,
    tip.y + tipDir.y * tipLength,
    tip.z + tipDir.z * tipLength
  );

  // Shaft connects tipEnd to base (via joints if present)
  // The shaft should end at the top of the base cylinder
  const shaftEnd = new THREE.Vector3(base.x, base.y, base.z + baseHeight);

  // Base is at the snapped location
  const baseCenter = new THREE.Vector3(base.x, base.y, base.z + baseHeight / 2);

  // Rotations
  const up = new THREE.Vector3(0, 1, 0);

  // Tip rotation: flip so wide end is at tipEnd, point is at tip
  const tipDirFlipped = new THREE.Vector3(-tipDir.x, -tipDir.y, -tipDir.z);
  const tipQuaternion = new THREE.Quaternion().setFromUnitVectors(up, tipDirFlipped);
  const tipMidpoint = new THREE.Vector3(
    (tip.x + tipEnd.x) / 2,
    (tip.y + tipEnd.y) / 2,
    (tip.z + tipEnd.z) / 2
  );

  // Base rotation: flat on XY plane
  const baseQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

  // Color based on validation level
  const previewColor = validationLevel === 'valid' ? '#00ff00' : '#ff0000'; // Green = valid, Red = invalid

  const previewMaterial = (
    <meshStandardMaterial
      color={previewColor}
      transparent
      opacity={0.5}
      depthWrite={false}
    />
  );

  // --- Shaft & Joints Rendering Logic ---

  const shaftSegments: React.ReactNode[] = [];
  const jointElements: React.ReactNode[] = [];

  // Start point of the current segment
  let currentStart = tipEnd;

  // Sort joints by order
  const sortedJoints = joints ? [...joints].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : [];

  // Points path: tipEnd -> [joints] -> shaftEnd
  const pathPoints = [
    ...sortedJoints.map(j => new THREE.Vector3(j.position.x, j.position.y, j.position.z)),
    shaftEnd
  ];

  pathPoints.forEach((point, index) => {
    const start = currentStart;
    const end = point;
    const length = start.distanceTo(end);

    if (length > 0.001) {
      const dir = new THREE.Vector3().subVectors(end, start).normalize();
      const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
      const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);

      shaftSegments.push(
        <group key={`seg-${index}`} position={[mid.x, mid.y, mid.z]} quaternion={quat}>
          <mesh>
            <cylinderGeometry args={[shaftRadius, shaftRadius, length, 8]} />
            {previewMaterial}
          </mesh>
        </group>
      );
    }

    // Render joint sphere (except for the last point which is shaftEnd/base top)
    if (index < pathPoints.length - 1) {
      const joint = sortedJoints[index];
      jointElements.push(
        <mesh key={`joint-${joint.id || index}`} position={[point.x, point.y, point.z]}>
          <sphereGeometry args={[joint.ballDiameterMm / 2, 16, 16]} />
          {previewMaterial}
        </mesh>
      );
    }

    currentStart = end;
  });

  return (
    <>
      {/* Tip frustum preview - tapered cylinder */}
      <group position={[tipMidpoint.x, tipMidpoint.y, tipMidpoint.z]} quaternion={tipQuaternion}>
        <mesh>
          {/* CylinderGeometry(radiusTop, radiusBottom, height) - top is +Y (small), bottom is -Y (large) */}
          <cylinderGeometry args={[tipPointRadius, tipBaseRadius, tipLength, 16]} />
          {previewMaterial}
        </mesh>
      </group>

      {/* Shaft Segments */}
      {shaftSegments}

      {/* Joints */}
      {jointElements}

      {/* Base preview */}
      <group position={[baseCenter.x, baseCenter.y, baseCenter.z]} quaternion={baseQuaternion}>
        <mesh>
          <cylinderGeometry args={[baseRadius, baseRadius, baseHeight, 16]} />
          {previewMaterial}
        </mesh>
      </group>

      {/* Base flare cone preview - when enabled */}
      {settings.baseFlare.enabled && (
        (() => {
          // When rotated 90° flat: radiusBottom = outer edge (plate), radiusTop = inner edge (base)
          const flareOuterRadius = settings.baseFlare.diameterMm / 2; // Wide end at plate
          const flareInnerRadius = Math.max(0.05, shaftRadius - 0.05); // Narrow end: shaft diameter - 0.1mm
          const flareHeight = settings.baseFlare.heightMm;
          const flareCenter = new THREE.Vector3(
            base.x,
            base.y,
            base.z + flareHeight / 2
          );
          const flareQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

          return (
            <group position={[flareCenter.x, flareCenter.y, flareCenter.z]} quaternion={flareQuaternion}>
              <mesh>
                <cylinderGeometry args={[flareInnerRadius, flareOuterRadius, flareHeight, 16]} />
                {previewMaterial}
              </mesh>
            </group>
          );
        })()
      )}
    </>
  );
}
