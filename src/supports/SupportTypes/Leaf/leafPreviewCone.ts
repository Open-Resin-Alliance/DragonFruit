import * as THREE from 'three';

import { orbitLeafCapAnchorTowardKnot } from '../../PlacementLogic/PlacementNormalSynthesis';
import { getSettings } from '../../Settings/state';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import { resolveTwigDiameterAtSegmentT } from '../Twig/twigTaper';
import type { Knot, Leaf, Twig, Vec3 } from '../../types';

const _tip = new THREE.Vector3();
const _sn = new THREE.Vector3();
const _knot = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _axisVec3: Vec3 = { x: 0, y: 0, z: 0 };
const _start = new THREE.Vector3();
const _coneVec = new THREE.Vector3();
const _orbitSurfaceScratch: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * A leaf's contact cone, re-derived against a knot that has moved: the cone
 * re-aims at the knot, its length becomes the knot-to-tip distance, and its
 * wide end tracks the host's diameter there. Returns the same leaf when nothing
 * moved, so a still frame does not churn the render list.
 */
export function recomputeLeafPreviewContactCone(
    leaf: Leaf,
    previewKnot: Knot,
    twigBySegmentId: Map<string, Twig>,
) {
    const cone = leaf.contactCone;
    if (!cone?.surfaceNormal) return leaf;

    const previewKnotPos = previewKnot.pos;
    const useOrbit = !!(cone.capAnchor && getSettings().smoothContactNormals !== false);
    const effectiveSurfaceNormal = useOrbit
        ? orbitLeafCapAnchorTowardKnot(cone.pos, previewKnotPos, cone.capAnchor!, undefined, _orbitSurfaceScratch)
        : cone.surfaceNormal;

    _tip.set(cone.pos.x, cone.pos.y, cone.pos.z);
    _sn.set(effectiveSurfaceNormal.x, effectiveSurfaceNormal.y, effectiveSurfaceNormal.z);
    _knot.set(previewKnotPos.x, previewKnotPos.y, previewKnotPos.z);

    _axis.subVectors(_knot, _tip);
    if (_axis.lengthSq() < 0.000001) {
        _axis.copy(_sn);
    }
    _axis.normalize();

    let finalLength = Math.max(0.1, _knot.distanceTo(_tip));

    for (let i = 0; i < 3; i++) {
        _axisVec3.x = _axis.x;
        _axisVec3.y = _axis.y;
        _axisVec3.z = _axis.z;
        const thickness = cone.profile.type === 'disk'
            ? calculateDiskThickness(effectiveSurfaceNormal, _axisVec3, cone.profile)
            : 0;

        _start.copy(_tip).addScaledVector(_sn, thickness);
        _coneVec.subVectors(_knot, _start);
        const len = _coneVec.length();
        if (len > 0.000001) {
            _axis.copy(_coneVec).multiplyScalar(1 / len);
            finalLength = Math.max(0.1, len);
        }
    }

    // On a tapered host, the wide end tracks the host's local diameter at the
    // knot's slide T, or the neck stays frozen while the knot visibly changes size.
    let nextBodyDiameterMm = cone.profile.bodyDiameterMm;
    const hostTwig = previewKnot.parentShaftId ? twigBySegmentId.get(previewKnot.parentShaftId) : undefined;
    if (hostTwig && previewKnot.t !== undefined) {
        const localTwigDia = resolveTwigDiameterAtSegmentT(hostTwig, previewKnot.parentShaftId, previewKnot.t);
        if (localTwigDia !== null) {
            nextBodyDiameterMm = localTwigDia;
        }
    }

    const oldNormal = cone.normal;
    const oldSurfaceNormal = cone.surfaceNormal;
    const oldLen = cone.profile.lengthMm;
    const oldBodyDia = cone.profile.bodyDiameterMm;
    if (
        oldLen === finalLength
        && oldBodyDia === nextBodyDiameterMm
        && cone.diskLengthOverride === undefined
        && oldNormal.x === _axis.x
        && oldNormal.y === _axis.y
        && oldNormal.z === _axis.z
        && oldSurfaceNormal.x === effectiveSurfaceNormal.x
        && oldSurfaceNormal.y === effectiveSurfaceNormal.y
        && oldSurfaceNormal.z === effectiveSurfaceNormal.z
    ) {
        return leaf;
    }

    return {
        ...leaf,
        contactCone: {
            ...cone,
            normal: { x: _axis.x, y: _axis.y, z: _axis.z },
            surfaceNormal: useOrbit
                ? { x: effectiveSurfaceNormal.x, y: effectiveSurfaceNormal.y, z: effectiveSurfaceNormal.z }
                : cone.surfaceNormal,
            diskLengthOverride: undefined,
            profile: {
                ...cone.profile,
                lengthMm: finalLength,
                bodyDiameterMm: nextBodyDiameterMm,
            },
        },
    };
}
