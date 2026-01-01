import * as THREE from 'three';
import { v4 as uuidv4 } from 'uuid';
import { 
  DragonfruitImportFormat, 
  Roots, 
  Trunk, 
  Segment, 
  Joint, 
  Vec3
} from '../../supports/types';
import { 
  ContactCone, 
} from '../../supports/SupportPrimitives/ContactCone/types';
import { SupportSettings } from '../../supports/Settings';
import { getJointDiameter } from '../../supports/constants';
import { calculateSmoothedNormal } from '../../supports/PlacementLogic/PlacementUtils';
import { calculateDiskThickness } from '../../supports/SupportPrimitives/ContactDisk/contactDiskUtils';

// ------------------------------------------------------------------
// 1. Type Definitions (Lychee Source)
// ------------------------------------------------------------------

interface LycheeVector { x: number; y: number; z: number }

interface LycheeSupportSettings {
  tip?: {
    length?: number;
    angle?: number;
    diameter?: number;
    pointDiameter?: number;
  };
  base?: {
    length?: number;
    diameter?: number;
    joinDiameter?: number;
    joinLength?: number;
    joinCone?: number;
  };
  baseTip?: {
    length?: number;
    diameter?: number;
    isStraight?: boolean;
  };
  isStraight?: boolean;
}

interface LycheeSupport {
  id: string;
  base: LycheeVector;
  tip: LycheeVector;
  settings?: LycheeSupportSettings;
  parentId?: string[]; // List of parent IDs
}

interface LycheeObject {
  id: string;
  center?: LycheeVector;
  position?: LycheeVector;
  rotation?: LycheeVector;
  scale?: LycheeVector;
  supportsBase?: string[]; // IDs of supports rooted on this object (or floor?)
}

interface LycheeData {
  objects?: { present?: { byId?: Record<string, LycheeObject> } };
  supports?: { present?: { byId?: Record<string, LycheeSupport> } };
}

// ------------------------------------------------------------------
// 3. The Converter Logic
// ------------------------------------------------------------------

export class LysConverter {
  
  /**
   * Converts Lychee data to Dragonfruit format.
   * 
   * @param data The parsed Lychee JSON data
   * @param settings The target Dragonfruit support settings to apply
   * @param mesh Optional THREE.Mesh for surface alignment (raycasting)
   * @returns DragonfruitImportFormat
   */
  static convert(data: LycheeData, settings: SupportSettings, mesh?: THREE.Mesh): DragonfruitImportFormat {
    const result: DragonfruitImportFormat = {
      version: 1,
      meta: {
        source: 'lychee_conversion',
        objectCenter: { x: 0, y: 0, z: 0 },
        updatedAt: Date.now()
      },
      roots: [],
      trunks: [],
      branches: [],
      leaves: [],
      braces: [],
      knots: []
    };

    if (!data.objects?.present?.byId || !data.supports?.present?.byId) {
      console.error('[LysConverter] Missing objects or supports data');
      return result;
    }

    // 1. Find the Target Object (o15 or first with supports)
    const objects = data.objects.present.byId;
    let targetObj: LycheeObject | null = null;
    
    if (objects['o15']) targetObj = objects['o15'];
    else {
      for (const key in objects) {
        if (objects[key].supportsBase && objects[key].supportsBase!.length > 0) {
          targetObj = objects[key];
          break;
        }
      }
    }

    if (!targetObj) {
      console.warn('[LysConverter] No object found with supports');
      return result;
    }

    // Update Meta
    const center = targetObj.center || { x: 0, y: 0, z: 0 };
    result.meta.objectCenter = center;

    // 2. Build Coordinate Transform Matrix
    // Logic: World = (Local + Center) * Scale + Position
    const pos = targetObj.position || { x: 0, y: 0, z: 0 };
    const scale = targetObj.scale || { x: 1, y: 1, z: 1 };
    // const center is already defined above

    // Helper to transform coordinates
    // Tip uses FULL transform (Scale + Center + Position)
    const transformFull = (v: LycheeVector): THREE.Vector3 => {
      return new THREE.Vector3(
        (v.x + center.x) * scale.x + pos.x,
        (v.y + center.y) * scale.y + pos.y,
        (v.z + center.z) * scale.z + pos.z
      );
    };

    // Base uses HYBRID transform?
    // X/Y: Unscaled (World relative to Pos?) -> Places pillar OUTSIDE model.
    // Z: For Roots, Z must be 0 (Plate). We must NOT add Object Position Z.
    const transformBase = (v: LycheeVector): THREE.Vector3 => {
        return new THREE.Vector3(
            v.x + pos.x, 
            v.y + pos.y,
            v.z // Keep Z relative to floor (usually 0)
        );
    };

    // 3. Process Supports
    const supports = data.supports.present.byId;
    
    // Extract settings for standardized geometry
    const rootDefaults = settings.roots;
    const tipDefaults = settings.tip;
    const shaftDefaults = settings.shaft;
    const baseFlareDefaults = settings.baseFlare;

    for (const [id, s] of Object.entries(supports)) {
      if (!s.base || !s.tip) continue;

      // A. Transform Endpoints (Keep Lychee Placement)
      const tipWorld = transformFull(s.tip);
      const baseRefWorld = transformBase(s.base); 

      // Dimensions Extraction
      const tipSettings = s.settings?.tip;
      const baseSettings = s.settings?.base;
      const baseTipSettings = s.settings?.baseTip;

      // 1. Root (The anchor on the floor)
      const rootId = uuidv4();
      
      // Use Dragonfruit Root Settings (ignoring Lychee's native values)
      // However, we still create the structure so the renderer can use it.
      const padDiameter = rootDefaults.diameterMm;
      const diskHeight = rootDefaults.diskHeightMm;
      const coneHeight = rootDefaults.coneHeightMm;
      const totalBaseHeight = diskHeight + coneHeight;

      // Use Lychee Shaft Diameter if available, else fallback to Settings
      // Lychee 'joinDiameter' is usually the shaft diameter. 'diameter' on base can be the pad.
      const pillarDiameter = baseSettings?.joinDiameter 
          || tipSettings?.diameter 
          || shaftDefaults.diameterMm;

      const root: Roots = {
          id: rootId,
          modelId: targetObj.id,
          transform: {
              pos: { x: baseRefWorld.x, y: baseRefWorld.y, z: 0 },
              rot: { x: 0, y: 0, z: 0, w: 1 },
          },
          diameter: padDiameter,
          height: totalBaseHeight // Explicit height to sync with joint
      };
      result.roots.push(root);

      // 2. Joint 0 (The "Knee") - Top of the vertical riser
      // Logic: Place the joint explicitly at the top of the Dragonfruit Root structure.
      // This ensures the shaft emerges from the visual top of the root, preventing "buried knee".
      
      const scaleZ = scale.z || 1;
      // Joint 0 Z = Root Z + Dragonfruit Visual Height
      const joint0Z = baseRefWorld.z + totalBaseHeight;

      const joint0: Joint = {
          id: uuidv4(),
          pos: { x: baseRefWorld.x, y: baseRefWorld.y, z: joint0Z },
          diameter: getJointDiameter(baseTipSettings?.diameter || pillarDiameter)
      };

      // 3. Socket Joint (Top of Pillar / Start of Cone)
      // Logic: Lychee prefers Vertical Shafts. We try to place the Socket directly above Joint 0.
      // We only lean if the Tip is too far away for the Cone (tipLen) to reach.
      const tipLen = tipSettings?.length || tipDefaults.lengthMm;

      // Calculate Horizontal Distance between Knee (Joint 0) and Tip
      const dx = tipWorld.x - joint0.pos.x;
      const dy = tipWorld.y - joint0.pos.y;
      const hDistSq = dx*dx + dy*dy;
      const tipLenSq = tipLen * tipLen;

      let socketPosVec: THREE.Vector3;

      // Tolerance: If horizontal gap is effectively zero, it's vertical.
      // If horizontal gap <= tipLen, we can stay vertical.
      if (hDistSq <= tipLenSq) {
          // Vertical Solution
          const vOffset = Math.sqrt(tipLenSq - hDistSq);
          socketPosVec = new THREE.Vector3(
              joint0.pos.x,
              joint0.pos.y,
              tipWorld.z - vOffset // Socket is below Tip
          );
          
          // Safety: Ensure Socket is above Knee
          if (socketPosVec.z < joint0.pos.z) {
             // Edge case: Tip is lower than Knee? Fallback to projection.
             const tipToKnee = new THREE.Vector3(
                joint0.pos.x - tipWorld.x,
                joint0.pos.y - tipWorld.y,
                joint0.pos.z - tipWorld.z
             );
             socketPosVec = tipToKnee.normalize().multiplyScalar(tipLen).add(tipWorld);
          }
      } else {
          // Leaning Solution (Tip too far for vertical shaft)
          // Project from Tip towards Knee
          const tipToKnee = new THREE.Vector3(
              joint0.pos.x - tipWorld.x,
              joint0.pos.y - tipWorld.y,
              joint0.pos.z - tipWorld.z
          );
          socketPosVec = tipToKnee.normalize().multiplyScalar(tipLen).add(tipWorld);
      }

      // Socket Joint
      const tipBodyDiameter = tipSettings?.diameter || tipDefaults.bodyDiameterMm;
      
      const socketJoint: Joint = {
          id: uuidv4(),
          pos: { x: socketPosVec.x, y: socketPosVec.y, z: socketPosVec.z },
          diameter: getJointDiameter(tipBodyDiameter)
      };

      // Cone Axis: Points FROM Tip TO Socket (Downwards/Backwards)
      const coneAxis = socketPosVec.clone().sub(tipWorld).normalize();

      // Raycast Snap: Use the Socket -> Tip direction to find the EXACT surface point
      let finalTipPos = { x: tipWorld.x, y: tipWorld.y, z: tipWorld.z };
      let surfaceNormal: Vec3 | undefined = undefined;

      if (mesh) {
          const raycaster = new THREE.Raycaster();
          
          // Ray from Socket towards Tip (along the cone axis, into the model)
          // We start at the Socket (not far away) to avoid hitting outer walls of hollow geometry.
          const rayOrigin = socketPosVec.clone();
          const rayDir = tipWorld.clone().sub(socketPosVec).normalize();

          console.log(`[LysConverter v13] Raycast Debug:`);
          console.log(` - Tip World: (${tipWorld.x.toFixed(2)}, ${tipWorld.y.toFixed(2)}, ${tipWorld.z.toFixed(2)})`);
          console.log(` - Ray Origin: (${rayOrigin.x.toFixed(2)}, ${rayOrigin.y.toFixed(2)}, ${rayOrigin.z.toFixed(2)})`);
          console.log(` - Ray Direction: (${rayDir.x.toFixed(2)}, ${rayDir.y.toFixed(2)}, ${rayDir.z.toFixed(2)})`);
          
          // Compute world-space bounding box to verify ghost mesh alignment
          // Note: mesh might be a child of a Group, so setFromObject traverses the hierarchy
          const worldBox = new THREE.Box3().setFromObject(mesh.parent || mesh);
          const worldCenter = worldBox.getCenter(new THREE.Vector3());
          const worldSize = worldBox.getSize(new THREE.Vector3());
          console.log(` - Ghost Mesh World BBox: Center(${worldCenter.x.toFixed(2)},${worldCenter.y.toFixed(2)},${worldCenter.z.toFixed(2)}) Size(${worldSize.x.toFixed(2)},${worldSize.y.toFixed(2)},${worldSize.z.toFixed(2)})`);
          console.log(` - Tip inside BBox? X:${tipWorld.x >= worldBox.min.x && tipWorld.x <= worldBox.max.x} Y:${tipWorld.y >= worldBox.min.y && tipWorld.y <= worldBox.max.y} Z:${tipWorld.z >= worldBox.min.z && tipWorld.z <= worldBox.max.z}`);

          // Raycast from Far Away towards Model
          raycaster.set(rayOrigin, rayDir);
          
          // Only check against this mesh
          const intersects = raycaster.intersectObject(mesh, false);

          if (intersects.length > 0) {
              // Find the first hit
              const hit = intersects[0];
              
              // 1. Snap Tip Position to exact surface hit
              finalTipPos = { x: hit.point.x, y: hit.point.y, z: hit.point.z };

              // 2. Calculate Smoothed Normal for correct Disk orientation
              const smoothed = calculateSmoothedNormal(hit);
              surfaceNormal = { x: smoothed.x, y: smoothed.y, z: smoothed.z };
              console.log(`[LysConverter v13] HIT: Support ${id} snapped. Dist: ${hit.distance.toFixed(3)}mm`);
          } else {
             console.warn(`[LysConverter v13] MISS: Support ${id} raycast failed.`);
          }
      }

      // C. Create Segments
      const segments: Segment[] = [];

      // Segment 0: Roots -> Joint 0 (The Riser)
      segments.push({
          id: uuidv4(),
          type: 'straight',
          diameter: baseTipSettings?.diameter || pillarDiameter,
          bottomJoint: undefined, // Connects to Root
          topJoint: joint0
      });

      // Segment 1: Joint 0 -> Socket (The Main Shaft)
      segments.push({
          id: uuidv4(),
          type: 'straight',
          diameter: pillarDiameter,
          bottomJoint: joint0,
          topJoint: socketJoint
      });

      // D. Contact Cone (Use Dragonfruit Tip Profile hydrated with Lychee dims)
      // Build the profile first so we can use it for socket calculation
      const coneProfile = {
          type: 'disk' as const,
          lengthMm: tipLen,
          contactDiameterMm: tipSettings?.pointDiameter || tipDefaults.contactDiameterMm,
          bodyDiameterMm: tipBodyDiameter,
          diskThicknessMm: tipDefaults.diskThicknessMm ?? 0.1,
          maxStandoffMm: tipDefaults.maxStandoffMm ?? 0.25,
          standoffAngleThreshold: tipDefaults.standoffAngleThreshold ?? Math.PI / 4,
          penetrationMm: tipDefaults.penetrationMm
      };

      // CRITICAL FIX (v13): Recalculate Socket Joint position to match getFinalSocketPosition logic
      // This ensures the cone and socket joint are perfectly aligned.
      // The renderer uses getFinalSocketPosition(cone) to find where the shaft should end.
      // We must store the socket joint at that EXACT position.
      const effectiveSurfaceNormal = surfaceNormal || { x: coneAxis.x, y: coneAxis.y, z: coneAxis.z };
      
      // 1. Calculate disk thickness offset (same as getFinalSocketPosition)
      const diskOffset = calculateDiskThickness(effectiveSurfaceNormal, { x: coneAxis.x, y: coneAxis.y, z: coneAxis.z }, coneProfile);
      
      // 2. Calculate cone start position (after disk offset along surface normal)
      const coneStartPos = {
          x: finalTipPos.x + effectiveSurfaceNormal.x * diskOffset,
          y: finalTipPos.y + effectiveSurfaceNormal.y * diskOffset,
          z: finalTipPos.z + effectiveSurfaceNormal.z * diskOffset
      };
      
      // 3. Calculate final socket position (cone extends along cone axis)
      const alignedSocketPos = {
          x: coneStartPos.x + coneAxis.x * tipLen,
          y: coneStartPos.y + coneAxis.y * tipLen,
          z: coneStartPos.z + coneAxis.z * tipLen
      };
      
      // Update socket joint position to match
      socketJoint.pos = alignedSocketPos;

      const contactCone: ContactCone = {
          id: uuidv4(),
          pos: finalTipPos,
          normal: { x: coneAxis.x, y: coneAxis.y, z: coneAxis.z },
          surfaceNormal: surfaceNormal,
          socketJointId: socketJoint.id,
          profile: coneProfile
      };

      // E. Create Trunk
      const trunk: Trunk = {
          id: uuidv4(),
          modelId: targetObj.id,
          rootId: rootId,
          segments: segments,
          contactCone: contactCone
      };

      result.trunks.push(trunk);
    }

    console.log(`[LysConverter] Converted ${Object.keys(supports).length} supports using Global Settings. (v13 - Socket Alignment Fix)`);
    return result;
  }
}
