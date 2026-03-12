import { Vec3 } from '../../types';

const MIN_INSERTED_BASE_SEGMENT_MM = 1.0;
const MIN_INSERTED_TRANSITION_SEGMENT_MM = 0.5;

export function withCentralStraightSupportJoint(args: {
    basePos: Vec3;
    rootTopZ: number;
    socketPos: Vec3;
}): Vec3[] {
    const { basePos, rootTopZ, socketPos } = args;
    const availableRise = socketPos.z - rootTopZ;
    if (availableRise <= MIN_INSERTED_TRANSITION_SEGMENT_MM + MIN_INSERTED_BASE_SEGMENT_MM) {
        return [];
    }

    const minJointZ = rootTopZ + MIN_INSERTED_BASE_SEGMENT_MM;
    const maxJointZ = socketPos.z - MIN_INSERTED_TRANSITION_SEGMENT_MM;
    const preferredJointZ = rootTopZ + availableRise * 0.65;
    const jointZ = Math.max(minJointZ, Math.min(preferredJointZ, maxJointZ));

    return [{
        x: basePos.x,
        y: basePos.y,
        z: jointZ,
    }];
}

export function normalizeFirstConstructionJoint(args: {
    basePos: Vec3;
    rootTopZ: number;
    socketPos: Vec3;
    routeJoints: Vec3[];
    constructionJoints: Vec3[];
}): Vec3[] {
    const { basePos, rootTopZ, socketPos, routeJoints, constructionJoints } = args;
    if (constructionJoints.length > 0) {
        return constructionJoints;
    }

    if (routeJoints.length > 0) {
        return [];
    }

    const availableRise = socketPos.z - rootTopZ;
    if (availableRise <= MIN_INSERTED_TRANSITION_SEGMENT_MM + MIN_INSERTED_BASE_SEGMENT_MM) {
        return [];
    }

    const minJointZ = rootTopZ + MIN_INSERTED_BASE_SEGMENT_MM;
    const maxJointZ = socketPos.z - MIN_INSERTED_TRANSITION_SEGMENT_MM;
    const preferredJointZ = rootTopZ + availableRise * 0.65;
    const jointZ = Math.max(minJointZ, Math.min(preferredJointZ, maxJointZ));

    return [{
        x: basePos.x,
        y: basePos.y,
        z: jointZ,
    }];
}
