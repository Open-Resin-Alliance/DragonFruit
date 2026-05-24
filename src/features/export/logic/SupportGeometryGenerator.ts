import * as THREE from 'three';
import { Roots, Segment, Joint, Vec3 } from '@/supports/types';
import { SupportData } from '@/supports/rendering/SupportBuilder';
import { getFinalSocketPosition } from '@/supports/SupportPrimitives/ContactCone';
import { getConeQuaternion } from '@/supports/SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness, getDiskCenter, getDiskRotation } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import { RaftSettings } from '@/supports/Rafts/Crenelated/RaftTypes';
import { JOINT_DIAMETER_OFFSET_MM } from '@/supports/constants';

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
  private static readonly NON_SELECTED_JOINT_BLEND_MM = JOINT_DIAMETER_OFFSET_MM * 0.75;

  private static buildSphereMesh(pos: { x: number; y: number; z: number }, diameter: number, widthSegments = 16, heightSegments = 16): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(Math.max(0.001, diameter) / 2, widthSegments, heightSegments);
    const mesh = new THREE.Mesh(geometry);
    mesh.position.set(pos.x, pos.y, pos.z);
    return mesh;
  }

  public static getExportJointDiameter(diameter: number): number {
    return Math.max(0.001, diameter - this.NON_SELECTED_JOINT_BLEND_MM);
  }

  public static getExportKnotDiameter(diameter: number): number {
    return Math.max(0.001, diameter - JOINT_DIAMETER_OFFSET_MM);
  }
  
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
        const socketPos = getFinalSocketPosition(data.contactCone);
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
    return this.buildSphereMesh(joint.pos, this.getExportJointDiameter(joint.diameter), 16, 16);
  }

  public static generateKnotMesh(knot: { pos: Vec3; diameter?: number }): THREE.Mesh {
    return this.buildSphereMesh(knot.pos, this.getExportKnotDiameter(knot.diameter ?? 1.2), 8, 8);
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
    const effectiveSurfaceNormal = coneData.surfaceNormal || coneData.normal;
    const primitiveThickness = profile.type === 'disk'
      ? (coneData.diskLengthOverride ?? calculateDiskThickness(effectiveSurfaceNormal, coneData.normal, profile))
      : 0;
    const coneStartPos = {
      x: coneData.pos.x + effectiveSurfaceNormal.x * primitiveThickness,
      y: coneData.pos.y + effectiveSurfaceNormal.y * primitiveThickness,
      z: coneData.pos.z + effectiveSurfaceNormal.z * primitiveThickness,
    };
    const center = {
      x: coneStartPos.x + coneData.normal.x * (length / 2),
      y: coneStartPos.y + coneData.normal.y * (length / 2),
      z: coneStartPos.z + coneData.normal.z * (length / 2),
    };
    const quaternion = getConeQuaternion(coneData.normal);

    // 2. Cone Body
    // Standard Cylinder: Top radius = contact, Bottom radius = body
    const geometry = new THREE.CylinderGeometry(contactRadius, bodyRadius, length, 16);

    const coneMesh = new THREE.Mesh(geometry);
    coneMesh.position.set(center.x, center.y, center.z);
    coneMesh.setRotationFromQuaternion(quaternion);
    group.add(coneMesh);

    // 3. Cone-start sphere (matches the live ContactConeRenderer)
    const sphereGeom = new THREE.SphereGeometry(contactRadius, 16, 12);
    const sphereMesh = new THREE.Mesh(sphereGeom);
    sphereMesh.position.set(coneStartPos.x, coneStartPos.y, coneStartPos.z);
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
