import * as THREE from 'three';
import { buildTrunkData } from '@/supports/SupportTypes/Trunk/trunkBuilder';
import { resolveConeAxisPolicy } from '@/supports/PlacementLogic/ConeAxisPolicy';
import type { SupportTipProfile } from '@/supports/SupportPrimitives/ContactCone/types';
import { calculateDiskThickness } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import type { SupportKind } from '../../../supportKindState';

interface GridPreviewProps {
    settings: any;
    liveConfig: any;
    activeKind: SupportKind;
}

export function buildGridPreviewSupports({ settings, liveConfig, activeKind }: GridPreviewProps) {
    if (activeKind !== 'grid') return null;

    const supports: any[] = [];
    const spacing = settings.grid.spacingMm; // Use direct setting
    const boxSize = 3; // 3x3

    // Use fixed cone angle for grid preview
    const internalAngle = 30;
    const angleRad = THREE.MathUtils.degToRad(internalAngle);
    const nx = Math.cos(angleRad);
    const nz = Math.sin(angleRad);
    const tipNormal = { x: -nx, y: 0, z: -nz };

    const tipProfile: SupportTipProfile = {
        type: 'disk',
        contactDiameterMm: 0.35, // Reduced tip size for sharper look
        bodyDiameterMm: 1.0,     // Standard body size (matches 1.0mm shaft)
        lengthMm: 3.0,          // Slightly longer cone
        penetrationMm: 0.1,
        diskThicknessMm: 0.1,
        maxStandoffMm: 1.5,
        standoffAngleThreshold: Math.PI / 4,
    };

    const coneAngleMode = settings.tip.coneAngleMode ?? 'normal';
    const adaptiveConeAngleOffsetDeg = settings.tip.adaptiveConeAngleOffsetDeg ?? 30;

    const { coneAxis } = resolveConeAxisPolicy({
        surfaceNormal: tipNormal,
        coneAngleMode,
        adaptiveConeAngleOffsetDeg,
    });

    const diskThickness = calculateDiskThickness(tipNormal, coneAxis, tipProfile);
    const tipX = -(tipNormal.x * diskThickness + coneAxis.x * tipProfile.lengthMm);

    // We want a fixed "look" for the grid supports, independent of the actual support settings
    // except for the grid spacing.
    const PREVIEW_HEIGHT_MM = 15; // Fixed height for grid preview


    // Generate 3x3 grid centered at 0,0
    // i (x) from -1 to 1, j (y) from -1 to 1
    let index = 0;
    for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
            const offsetX = i * spacing;
            const offsetY = j * spacing;

            // Sphere calculations
            // Radius must be larger than corner distance (sqrt(2) * spacing)
            // Let's use 1.5x spacing
            // Minimum radius to look good even with tiny spacing
            const sphereRadius = Math.max(5, spacing * 1.5);
            const sphereCenterZ = PREVIEW_HEIGHT_MM + sphereRadius;

            // Calculate Z on the bottom hemisphere of the sphere for this X,Y
            // sphere equation: x^2 + y^2 + (z - centerZ)^2 = r^2
            // (z - centerZ)^2 = r^2 - x^2 - y^2
            // z = centerZ - sqrt(r^2 - x^2 - y^2)
            const rSquared = sphereRadius * sphereRadius;
            const distSquared = offsetX * offsetX + offsetY * offsetY;

            // Default flat height if outside sphere (shouldn't happen with 3x3 grid and adequate radius)
            let tipZ = PREVIEW_HEIGHT_MM;
            let currentTipNormal = tipNormal; // Default to the flat one calculated above
            let baseTipX = tipX;

            if (distSquared < rSquared) {
                tipZ = sphereCenterZ - Math.sqrt(rSquared - distSquared);

                // Correct surface normal (Center -> Tip) points OUT from the sphere.
                // Since we are on the bottom hemisphere, Z is negative, so normal points DOWN.
                // This matches the standard convention where surface normal points away from the object volume.
                const vx = offsetX;
                const vy = offsetY;
                const vz = tipZ - sphereCenterZ;
                const len = Math.sqrt(vx * vx + vy * vy + vz * vz);

                // Surface normal at the tip position (Center -> Tip)
                const nx = vx / len;
                const ny = vy / len;
                const nz = vz / len;
                currentTipNormal = { x: nx, y: ny, z: nz };

                // For sphere contact, we want the tip strictly above the grid point
                baseTipX = 0;
            }

            // --- Custom Grid Support Construction ---
            // We bypass buildTrunkData because it forces vertical placement.
            // We want: Root at Grid Point -> Vertical to Joint -> Angled to Socket on Sphere.

            // 1. Define Positions
            const rootPos = { x: offsetX, y: offsetY, z: 0 };

            // 2. Define Cone/Socket
            // Reuse tipProfile from above (0.3mm contact, 2.5mm length)

            // coneAxis: Direction the support approaches the model.
            // StandardPlacement uses coneAxis ≈ surfaceNormal (Away from model / Down).
            // This aligns the ContactCone geometry (Y-up aligned to -normal) to point UP (Pointy end at tip).
            // It also ensures getSocketPosition moves AWAY from the model (Down).
            // Apply small penetration to ensure visual contact with tessellated sphere
            // The analytical surface is at R, but flat faces are slightly inside R.
            const penetrationOffset = 0.2;
            const tipPos = {
                x: baseTipX + offsetX - currentTipNormal.x * penetrationOffset,
                y: offsetY - currentTipNormal.y * penetrationOffset,
                z: tipZ - currentTipNormal.z * penetrationOffset
            };

            // 1. Define Positions
            // The rootPos is already defined above, so this comment is slightly out of place.
            // However, the instruction was to insert the tipPos calculation here.

            // 2. Define Cone/Socket
            // Ensure cone approaches model from below (Axis points DOWN/OUT).
            const coneAxis = currentTipNormal;

            const diskThickness = 0.1;

            const coneStartPos = {
                x: tipPos.x + currentTipNormal.x * diskThickness,
                y: tipPos.y + currentTipNormal.y * diskThickness,
                z: tipPos.z + currentTipNormal.z * diskThickness
            };

            const socketPos = {
                x: coneStartPos.x + coneAxis.x * tipProfile.lengthMm,
                y: coneStartPos.y + coneAxis.y * tipProfile.lengthMm,
                z: coneStartPos.z + coneAxis.z * tipProfile.lengthMm
            };

            // 3. Define Joint (The Knee)
            // Place joint directly above the root, to keep the bottom segment vertical.
            // Use 50% height for a balanced look (standard "knee" placement).
            // A more central joint helps the bend look natural and deliberate.
            const jointZ = socketPos.z * 0.5;
            const jointPos = {
                x: rootPos.x,
                y: rootPos.y,
                z: jointZ
            };

            // 4. Construct Data IDs
            const u = (s: string) => `grid-${index}-${s}`;

            // 5. Construct Entities
            // IDs
            const rootId = u('root');
            const trunkId = u('trunk');
            const jointId = u('joint');
            const seg1Id = u('seg1');
            const seg2Id = u('seg2');
            const coneId = u('cone');

            // Root
            const root = {
                id: rootId,
                modelId: `anatomy-preview-grid-${index}`,
                transform: { pos: rootPos, rot: { x: 0, y: 0, z: 0, w: 1 } },
                diameter: 2.0, // Fixed overrides
                diskHeight: 0.2, // Increased for visibility
                coneHeight: 0    // Removed cone as requested
            };

            // Joint
            const joint = {
                id: jointId,
                pos: jointPos,
                diameter: 1.2 // Visible knee joint
            };

            // Segments
            // Bottom Segment: Root -> Joint
            // In SupportBuilder, segments are drawn from Root -> Seg.topJoint -> ...
            // So Seg 1 has topJoint = joint.
            const seg1 = {
                id: seg1Id,
                diameter: 1.0, // 1mm shaft
                topJoint: joint
            };

            // Top Segment: Joint -> Socket. 
            // Represented as segment ending at Socket (which is a kind of joint?).
            // trunkBuilder treats socket as a joint for the top segment.
            const socketJoint = {
                id: u('socket'),
                pos: socketPos,
                // Make it slightly larger than shaft (1.0 -> 1.2) to be visible as a ball joint
                diameter: 1.2
            };

            const seg2 = {
                id: seg2Id,
                diameter: 1.0, // 1mm shaft
                topJoint: socketJoint
            };

            // SupportBuilder expects segments array. 
            // Order: Bottom -> Top.
            const segments = [seg1, seg2];

            // Contact Cone
            const contactCone = {
                id: coneId,
                pos: tipPos,
                normal: coneAxis,
                surfaceNormal: currentTipNormal,
                profile: tipProfile,
                socketJointId: u('socket')
            };

            const data = {
                id: trunkId,
                roots: root,
                segments: segments,
                contactCone: contactCone,
                angle: 0
            };

            supports.push(data);
            index++;
        }
    }
    return supports;
}
