/**
 * The model's center of mass as a screen-stable quadrant globe, the way CAD
 * marks mass properties: a sphere split into four quadrants, alternating
 * yellow and near-black, drawn through the model as an annotation.
 *
 * It has no gravity arrow (the direction is the scene's, not the part's), and
 * its size is in pixels rather than millimetres so it reads as a gizmo at any
 * zoom instead of collapsing to a dot on a large part.
 */

import React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { geometryCentroidMm } from '@/features/printing/modelResinVolume';
import { getFrameStressSnapshot, subscribeFrameStress } from '@/supports/autoSupport';

/** On-screen radius of the globe, in CSS pixels. */
const MARKER_PX_RADIUS = 13;

/**
 * Quadrants are measured around the camera axis, not fixed to the model axes:
 * a fixed split shows two hemispheres whenever the camera looks down one axis
 * (the side view read black-left / yellow-right). Projecting the fragment
 * direction into the screen plane keeps the four-way split from every angle.
 */
const QUADRANT_FRAGMENT = `
vec3 quadrantAxis = normalize(uQuadrantViewAxis);
vec3 quadrantHelper = abs(quadrantAxis.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
vec3 quadrantRight = normalize(cross(quadrantHelper, quadrantAxis));
vec3 quadrantUp = normalize(cross(quadrantAxis, quadrantRight));
vec3 quadrantNormal = normalize(vQuadrantPos);
float quadrantX = step(0.0, dot(quadrantNormal, quadrantRight));
float quadrantY = step(0.0, dot(quadrantNormal, quadrantUp));
float alternate = abs(quadrantX - quadrantY);
diffuseColor.rgb = mix(vec3(0.012, 0.012, 0.014), vec3(0.86, 0.56, 0.035), alternate);
`;

interface Placement {
    local: THREE.Vector3;
}

export function CenterOfMassOverlay({
    activeModelId,
    meshRefs,
}: {
    activeModelId: string | null;
    /** The scene's live mesh per model, as `StlMesh` registers it. */
    meshRefs: React.RefObject<Record<string, THREE.Mesh | null>>;
}) {
    const groupRef = React.useRef<THREE.Group>(null);
    const placementGeometryRef = React.useRef<THREE.BufferGeometry | null>(null);
    const [placement, setPlacement] = React.useState<Placement | null>(null);
    const viewportHeight = useThree((state) => state.size.height);
    const stressSnap = React.useSyncExternalStore(
        subscribeFrameStress,
        getFrameStressSnapshot,
        getFrameStressSnapshot,
    );
    const overlayEnabled = stressSnap.overlayEnabled;
    const material = React.useMemo(() => {
        const next = new THREE.MeshBasicMaterial({
            depthTest: false,
            depthWrite: false,
            toneMapped: false,
        });
        const viewAxis = { value: new THREE.Vector3(0, 0, 1) };
        next.userData.viewAxis = viewAxis;
        next.onBeforeCompile = (shader) => {
            shader.uniforms.uQuadrantViewAxis = viewAxis;
            shader.vertexShader = `varying vec3 vQuadrantPos;\n${shader.vertexShader}`;
            shader.vertexShader = shader.vertexShader.replace(
                '#include <begin_vertex>',
                `#include <begin_vertex>
                 vQuadrantPos = position;`,
            );
            shader.fragmentShader = `uniform vec3 uQuadrantViewAxis;\nvarying vec3 vQuadrantPos;\n${shader.fragmentShader}`;
            shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>${QUADRANT_FRAGMENT}`);
        };
        next.customProgramCacheKey = () => 'df-center-of-mass-quadrants';
        return next;
    }, []);

    React.useEffect(() => () => material.dispose(), [material]);

    useFrame((state) => {
        const group = groupRef.current;
        if (!group) return;
        const mesh = activeModelId ? meshRefs.current[activeModelId] ?? null : null;
        if (!mesh) {
            group.visible = false;
            return;
        }

        if (placementGeometryRef.current !== mesh.geometry) {
            placementGeometryRef.current = mesh.geometry;
            const centroid = geometryCentroidMm(mesh.geometry);
            setPlacement(centroid ? { local: new THREE.Vector3(centroid.x, centroid.y, centroid.z) } : null);
        }

        if (!placement || !overlayEnabled || viewportHeight <= 0) {
            group.visible = false;
            return;
        }
        mesh.updateWorldMatrix(true, false);
        group.position.copy(placement.local).applyMatrix4(mesh.matrixWorld);

        const camera = state.camera;
        let worldPerPixel: number;
        if (camera instanceof THREE.PerspectiveCamera) {
            const distance = camera.position.distanceTo(group.position);
            worldPerPixel = (2 * distance * Math.tan((camera.fov * Math.PI) / 360)) / viewportHeight;
        } else if (camera instanceof THREE.OrthographicCamera) {
            worldPerPixel = (camera.top - camera.bottom) / camera.zoom / viewportHeight;
        } else {
            group.visible = false;
            return;
        }
        group.scale.setScalar(worldPerPixel * MARKER_PX_RADIUS);

        // Direction from the globe's centre to the camera, in the globe's own
        // space, so the fragment shader can build the screen-plane basis.
        group.updateWorldMatrix(true, false);
        const viewAxis = material.userData.viewAxis as { value: THREE.Vector3 };
        viewAxis.value.copy(camera.position);
        group.worldToLocal(viewAxis.value).normalize();
        group.visible = true;
    });

    return (
        <group ref={groupRef} visible={false}>
            {placement && (
                <mesh material={material} renderOrder={1002} frustumCulled={false}>
                    <sphereGeometry args={[1, 32, 20]} />
                </mesh>
            )}
        </group>
    );
}
