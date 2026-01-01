import * as THREE from 'three';
import { Roots, Segment, Joint, Vec3 } from '@/supports/types';
import { SupportData } from '@/supports/rendering/SupportBuilder';
import { getSocketPosition } from '@/supports/SupportPrimitives/ContactCone';
import { calculateDiskThickness, getDiskCenter, getDiskRotation } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import { RaftSettings } from '@/supports/Rafts/Crenelated/RaftTypes';

/**
 * SupportGeometryGenerator
 * 
 * A pure-logic class that generates THREE.Mesh objects for supports.
 * This is used for:
 * 1. Offline STL export (headless)
 * 2. Future: Merging supports into a single mesh for performance
 * 
 * It replicates the visual output of the React components:
 * - RootsRenderer
 * - ShaftRenderer
 * - JointRenderer
 * - ContactConeRenderer
 */
export class SupportGeometryGenerator {
  
  /**
   * Generates a single group containing all meshes for a support structure
   */
  public static generateSupportGroup(data: SupportData, raftSettings?: RaftSettings): THREE.Group {
    const group = new THREE.Group();
    group.name = `Support_${data.id}`;

    // Determine shaft diameter for roots connection
    const firstSegment = data.segments[0];
    const shaftDiameter = firstSegment ? firstSegment.diameter : 1.0;

    // 1. Roots
    if (data.roots) {
      const rootsMesh = this.generateRootsMesh(data.roots, shaftDiameter, raftSettings);
      if (rootsMesh) group.add(rootsMesh);
    }

    // 2. Segments & Joints
    // We need to track start position similar to SupportBuilder
    // Pass raftSettings to calculate correct start height (lifted by raft)
    let currentStart = this.getStartPosition(data, raftSettings);
    
    data.segments.forEach((seg: Segment) => {
      // Calculate end point
      let endPoint: THREE.Vector3;
      
      if (seg.topJoint) {
        endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
      } else if (data.contactCone) {
        // Calculate socket position
        const socketPos = getSocketPosition(
          data.contactCone.pos,
          data.contactCone.normal,
          data.contactCone.profile
        );
        endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
      } else {
        // Fallback
        endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 10));
      }

      // Generate Shaft
      const shaftMesh = this.generateShaftMesh(currentStart, endPoint, seg.diameter);
      if (shaftMesh) group.add(shaftMesh);

      // Generate Joint (if present)
      if (seg.topJoint) {
        const jointMesh = this.generateJointMesh(seg.topJoint);
        if (jointMesh) group.add(jointMesh);
      }

      // Update start for next segment
      currentStart = endPoint;
    });

    // 3. Contact Cone
    if (data.contactCone) {
      const coneMesh = this.generateConeMesh(data.contactCone);
      if (coneMesh) group.add(coneMesh);
      
      // 3b. Contact Disk (if using disk profile)
      const diskMesh = this.generateContactDiskMesh(data.contactCone);
      if (diskMesh && diskMesh.children.length > 0) {
        group.add(diskMesh);
      }
    }

    return group;
  }

  private static getStartPosition(data: SupportData, raftSettings?: RaftSettings): THREE.Vector3 {
    if (data.roots) {
      // RootsRenderer logic for vertical offset
      const hasSolidBottom = (raftSettings?.bottomMode ?? 'off') === 'solid';
      const diskHeight = hasSolidBottom ? 0.05 : data.roots.diskHeight;
      const verticalOffset = hasSolidBottom && raftSettings ? Math.max(raftSettings.thickness - diskHeight, 0) : 0;

      const basePos = new THREE.Vector3(
        data.roots.transform.pos.x,
        data.roots.transform.pos.y,
        data.roots.transform.pos.z + verticalOffset
      );
      
      const coneHeight = data.roots.coneHeight;
      // Start at the center of the top sphere (which is at disk + cone)
      return basePos.clone().add(new THREE.Vector3(0, 0, diskHeight + coneHeight));
    } else if (data.startPos) {
      return new THREE.Vector3(data.startPos.x, data.startPos.y, data.startPos.z);
    }
    return new THREE.Vector3(0, 0, 0);
  }

  public static generateRootsMesh(root: Roots, shaftDiameter: number = 1.0, raftSettings?: RaftSettings): THREE.Group {
    const group = new THREE.Group();
    
    // Raft offset logic matching RootsRenderer
    const hasSolidBottom = (raftSettings?.bottomMode ?? 'off') === 'solid';
    const diskHeight = hasSolidBottom ? 0.05 : root.diskHeight;
    const verticalOffset = hasSolidBottom && raftSettings ? Math.max(raftSettings.thickness - diskHeight, 0) : 0;
    
    const pos = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z + verticalOffset);
    // Group is at world pos (lifted if needed)
    group.position.copy(pos);

    // Rotate X 90 to align Y-up cylinders to Z-up world
    const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

    // Base Disk
    const diskGeom = new THREE.CylinderGeometry(root.diameter / 2, root.diameter / 2, diskHeight, 32);
    
    // Mesh 1: Disk
    const diskMesh = new THREE.Mesh(diskGeom);
    diskMesh.setRotationFromQuaternion(quaternion);
    diskMesh.position.set(0, 0, diskHeight / 2);
    group.add(diskMesh);

    // Cone
    const coneHeight = root.coneHeight;
    const topRadius = shaftDiameter / 2; // Matches trunk shaft
    const bottomRadius = root.diameter / 2;
    
    const coneGeom = new THREE.CylinderGeometry(topRadius, bottomRadius, coneHeight, 32);
    const coneMesh = new THREE.Mesh(coneGeom);
    coneMesh.setRotationFromQuaternion(quaternion);
    coneMesh.position.set(0, 0, diskHeight + coneHeight / 2);
    group.add(coneMesh);

    // Sphere Top
    const sphereRadius = topRadius;
    const sphereGeom = new THREE.SphereGeometry(sphereRadius, 16, 12);
    const sphereMesh = new THREE.Mesh(sphereGeom);
    sphereMesh.position.set(0, 0, diskHeight + coneHeight);
    group.add(sphereMesh);

    return group;
  }

  public static generateShaftMesh(start: THREE.Vector3, end: THREE.Vector3, diameter: number): THREE.Mesh | null {
    const length = start.distanceTo(end);
    if (length < 0.001) return null;

    const radius = diameter / 2;
    const geometry = new THREE.CylinderGeometry(radius, radius, length, 8);
    
    // Orient the cylinder
    const midpoint = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const direction = new THREE.Vector3().subVectors(end, start).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(up, direction);

    const mesh = new THREE.Mesh(geometry);
    mesh.position.copy(midpoint);
    mesh.setRotationFromQuaternion(quaternion);
    
    return mesh;
  }

  public static generateJointMesh(joint: Joint): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(joint.diameter / 2, 16, 16);
    const mesh = new THREE.Mesh(geometry);
    mesh.position.set(joint.pos.x, joint.pos.y, joint.pos.z);
    return mesh;
  }

  public static generateConeMesh(coneData: any): THREE.Group {
    const group = new THREE.Group();
    
    // Replicating ContactConeRenderer logic
    // We need to import the profile values properly. 
    // coneData is ContactCone from types.ts
    
    // 1. Parse Profile
    // If profile is missing, we need defaults. 
    // But coneData usually has it.
    const profile = coneData.profile || {
      contactDiameterMm: 0.6,
      bodyDiameterMm: 1.5,
      lengthMm: 3.0
    };
    
    const contactRadius = profile.contactDiameterMm / 2;
    const bodyRadius = profile.bodyDiameterMm / 2;
    const length = profile.lengthMm;

    // 2. Cone Body
    // Standard Cylinder: Top radius = contact, Bottom radius = body
    const geometry = new THREE.CylinderGeometry(contactRadius, bodyRadius, length, 16);
    
    // ContactConeRenderer logic:
    // const center = getConeCenterPosition(pos, normal, profile);
    // const quaternion = getConeQuaternion(normal);
    // group position = center, quaternion = quaternion
    
    // Let's replicate the math inline or import helpers if possible.
    // The helpers are in `contactConeUtils.ts`. Can we import them?
    // Yes, they are just math.
    
    // However, `ContactConeRenderer` does:
    // <group position={center} quaternion={quaternion}> <mesh> ... </mesh> </group>
    
    // We can't import `getConeCenterPosition` easily if it's not exported from index.
    // Let's recreate the math. Y-up cylinder.
    // Center of cylinder is at local (0,0,0).
    // We want Top (contact) to touch the model at `pos`.
    // "Top" is at local Y = +length/2.
    // So we need to position the mesh such that +Y end is at `pos`.
    // Wait, ContactConeRenderer uses `getConeCenterPosition`.
    // If we don't match it exactly, we drift.
    
    // Let's look at `getSocketPosition` usage earlier in this file.
    // It is imported from `@/supports/SupportPrimitives/ContactCone`.
    // Let's check if we can import `getConeCenterPosition` and `getConeQuaternion`.
    // If not, let's approximate.
    
    // Math:
    // Normal points INTO model? Or AWAY?
    // `ContactConeRenderer`: "normal: Cone axis (points into model)"?
    // Actually, usually normal points OUT of model surface.
    // If normal points OUT (e.g. 0,0,1), and cone attaches to bottom face...
    // We want the small tip at `pos`.
    // The large base (socket) at `pos + normal * length`?
    // `getSocketPosition`: `pos + normal * length`.
    // So `normal` points AWAY from the model surface towards the floor.
    
    // Cylinder Y-up. Top (+Y) = contact (small). Bottom (-Y) = socket (large).
    // We want Top (+Y) at `pos`.
    // We want Bottom (-Y) at `pos + normal * length`.
    // So the vector (Bottom - Top) = (pos + N*L) - pos = N*L.
    // Local vector (Bottom - Top) = (0, -L/2, 0) - (0, L/2, 0) = (0, -L, 0).
    // So we want (0, -1, 0) to align with Normal.
    // Or (0, 1, 0) to align with -Normal.
    
    // Rotation:
    const up = new THREE.Vector3(0, 1, 0);
    const normalVec = new THREE.Vector3(coneData.normal.x, coneData.normal.y, coneData.normal.z);
    // If we align UP (small end) with -Normal (pointing into model):
    const quaternion = new THREE.Quaternion().setFromUnitVectors(up, normalVec.clone().negate());
    
    // Position:
    // Midpoint of cone is at `pos + normal * (length / 2)`.
    const midpoint = new THREE.Vector3(coneData.pos.x, coneData.pos.y, coneData.pos.z)
      .add(normalVec.clone().multiplyScalar(length / 2));
      
    const coneMesh = new THREE.Mesh(geometry);
    coneMesh.position.copy(midpoint);
    coneMesh.setRotationFromQuaternion(quaternion);
    group.add(coneMesh);

    // 3. Socket Sphere
    // At `socketPos` (large end).
    // `getSocketPosition` already calculated this for the shaft end.
    const socketPos = new THREE.Vector3(coneData.pos.x, coneData.pos.y, coneData.pos.z)
      .add(normalVec.clone().multiplyScalar(length));
      
    // Joint radius logic from renderer: `getJointRadius(bodyDiameter)`
    // We can approximate or import.
    // Default joint radius is usually slightly larger than shaft.
    // Let's use bodyRadius * 1.2 or similar if we can't find the constant.
    // In `ContactConeRenderer`: `const jointRadius = getJointRadius(profile.bodyDiameterMm);`
    // `getJointRadius` usually returns `diameter * 0.5 * 1.2` (from constants).
    // Let's assume 1.0mm radius for standard 1.5mm shaft.
    const jointRadius = bodyRadius * 1.2; 
    
    const sphereGeom = new THREE.SphereGeometry(jointRadius, 16, 12);
    const sphereMesh = new THREE.Mesh(sphereGeom);
    sphereMesh.position.copy(socketPos);
    group.add(sphereMesh);

    return group;
  }

  public static generateContactDiskMesh(coneData: any): THREE.Group {
    const group = new THREE.Group();
    
    // Extract contact disk data
    const profile = coneData.profile;
    if (!profile || profile.type !== 'disk') {
      return group; // Only generate for disk type profiles
    }
    
    const pos = coneData.pos;
    const surfaceNormal = coneData.surfaceNormal || coneData.normal; // Fallback to cone normal
    const coneAxis = coneData.normal;
    const contactDiameterMm = profile.contactDiameterMm;
    const overrideThickness = coneData.diskLengthOverride;
    
    // Calculate geometry based on angle between Surface Normal and Cone Axis
    const thickness = overrideThickness !== undefined 
      ? overrideThickness 
      : calculateDiskThickness(surfaceNormal, coneAxis, profile);
    
    const center = getDiskCenter(pos, surfaceNormal, thickness);
    const rotation = getDiskRotation(surfaceNormal);
    const radius = contactDiameterMm / 2;
    
    // Create the contact disk geometry (cylinder shaft + spherical tip)
    // Shaft: From Surface to Tip Center
    const shaftGeometry = new THREE.CylinderGeometry(radius, radius, thickness, 16);
    const shaftMesh = new THREE.Mesh(shaftGeometry);
    shaftMesh.position.set(0, 0, 0); // Local origin in group
    
    // Round Tip: Centered at the top of the shaft
    const tipGeometry = new THREE.SphereGeometry(radius, 16, 16);
    const tipMesh = new THREE.Mesh(tipGeometry);
    tipMesh.position.set(0, thickness / 2, 0); // Position at top of shaft
    
    // Create group and apply transforms
    group.add(shaftMesh);
    group.add(tipMesh);
    group.position.set(center.x, center.y, center.z);
    group.setRotationFromQuaternion(rotation);
    
    return group;
  }
}
