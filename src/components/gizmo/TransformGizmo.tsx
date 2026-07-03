"use client";

import React, { useState } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { DEFAULT_GIZMO_CONFIG } from './constants';
import type { TransformGizmoProps, GizmoAxis, GizmoOperation } from './types';
import { GizmoCenter } from './move/GizmoCenter';
import { GizmoMove } from './move/GizmoMove';
import { GizmoRotation } from './rotate/GizmoRotation';
import { GizmoScale } from './scale/GizmoScale';
import { usePicking } from '@/components/picking';

type AxisVisibility = Record<GizmoAxis, number>;

type ViewCullState = {
  move: AxisVisibility;
  scale: AxisVisibility;
  rotate: AxisVisibility;
};

const VIEW_CULL_HIDE_THRESHOLD = 0.02;
const VIEW_CULL_INTERACTION_THRESHOLD = 0.8;
const GIZMO_RENDER_ORDER = 1_000_000;

function createAxisVisibility(value = 1): AxisVisibility {
  return { x: value, y: value, z: value };
}

function createDefaultViewCullState(): ViewCullState {
  return {
    move: createAxisVisibility(),
    scale: createAxisVisibility(),
    rotate: createAxisVisibility(),
  };
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) {
    return value >= edge1 ? 1 : 0;
  }

  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function quantizeOpacity(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 40) / 40;
}

function getAxisWorldDirection(axis: GizmoAxis, rotationEuler: THREE.Euler): THREE.Vector3 {
  const direction = axis === 'x'
    ? new THREE.Vector3(1, 0, 0)
    : axis === 'y'
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(0, 0, 1);

  return direction.applyEuler(rotationEuler).normalize();
}

function getViewDirection(camera: THREE.Camera, gizmoPosition: THREE.Vector3): THREE.Vector3 {
  if ('isPerspectiveCamera' in camera && camera.isPerspectiveCamera) {
    return new THREE.Vector3().subVectors(camera.position, gizmoPosition).normalize();
  }

  return camera.getWorldDirection(new THREE.Vector3()).normalize();
}

function computeViewCullState(
  camera: THREE.Camera,
  gizmoPosition: THREE.Vector3,
  rotationEuler: THREE.Euler,
): ViewCullState {
  const viewDirection = getViewDirection(camera, gizmoPosition);
  const axes: GizmoAxis[] = ['x', 'y', 'z'];
  const move = createAxisVisibility();
  const scale = createAxisVisibility();
  const rotate = createAxisVisibility();

  for (const axis of axes) {
    const alignment = Math.abs(viewDirection.dot(getAxisWorldDirection(axis, rotationEuler)));

    // Axis arrows and scale cubes should only get out of the way when they're
    // very close to collapsing into the center from the current view.
    move[axis] = quantizeOpacity(1 - smoothstep(0.82, 0.97, alignment));
    scale[axis] = quantizeOpacity(1 - smoothstep(0.78, 0.95, alignment));

    // Rotation rings use axis-specific fade tuning:
    // - X/Y should get out of the way sooner (helps top-down and near-top-down usability)
    // - Z can stay visible a bit longer to avoid feeling like it disappears too eagerly.
    const rotateFadeStart = axis === 'z' ? 0.03 : 0.03;
    const rotateFadeEnd = axis === 'z' ? 0.14 : 0.55;
    rotate[axis] = quantizeOpacity(smoothstep(rotateFadeStart, rotateFadeEnd, alignment));
  }

  return { move, scale, rotate };
}

function viewCullStatesEqual(a: ViewCullState, b: ViewCullState): boolean {
  return a.move.x === b.move.x
    && a.move.y === b.move.y
    && a.move.z === b.move.z
    && a.scale.x === b.scale.x
    && a.scale.y === b.scale.y
    && a.scale.z === b.scale.z
    && a.rotate.x === b.rotate.x
    && a.rotate.y === b.rotate.y
    && a.rotate.z === b.rotate.z;
}

function getAxisFromPart(part: string): GizmoAxis | undefined {
  if (part.endsWith('-x')) return 'x';
  if (part.endsWith('-y')) return 'y';
  if (part.endsWith('-z')) return 'z';
  return undefined;
}

function getOperationFromPart(part: string): GizmoOperation | null {
  if (part === 'center' || part.startsWith('axis-')) return 'move';
  if (part.startsWith('ring-')) return 'rotate';
  if (part.startsWith('scale-')) return 'scale';
  return null;
}

/**
 * TransformGizmo - Unified 3D transform widget
 * 
 * Modular gizmo supporting move, rotate, and scale operations.
 * Features gradient colors matching world axes and unique hexagon scale handles.
 * 
 * @example
 * // Prepare mode - full transform
 * <TransformGizmo
 *   position={modelPosition}
 *   enableMove enableRotate enableScale
 *   onMove={(delta) => updatePosition(delta)}
 *   onRotate={(axis, angle) => updateRotation(axis, angle)}
 *   onScale={(axis, factor) => updateScale(axis, factor)}
 * />
 * 
 * @example
 * // Support mode - move and scale only
 * <TransformGizmo
 *   position={supportTip}
 *   enableMove enableScale
 *   constrainToSurface
 *   onMove={(delta) => updateTip(delta)}
 *   onScale={(axis, factor) => updateDiameter(factor)}
 * />
 */
export function TransformGizmo({
  position,
  rotation = [0, 0, 0],
  visible = true,
  enableMove = DEFAULT_GIZMO_CONFIG.enableMove,
  enableRotate = DEFAULT_GIZMO_CONFIG.enableRotate,
  enableScale = DEFAULT_GIZMO_CONFIG.enableScale,
  showMovePlanes = DEFAULT_GIZMO_CONFIG.showMovePlanes,
  showCenter = DEFAULT_GIZMO_CONFIG.showCenter,
  size = DEFAULT_GIZMO_CONFIG.size,
  opacity = DEFAULT_GIZMO_CONFIG.opacity,
  enableLighting = DEFAULT_GIZMO_CONFIG.enableLighting,
  constrainToSurface = DEFAULT_GIZMO_CONFIG.constrainToSurface,
  constrainToPlane = DEFAULT_GIZMO_CONFIG.constrainToPlane,
  axisLock = DEFAULT_GIZMO_CONFIG.axisLock,
  handleScale = 1.0,
  moveHandleBidirectional = false,
  moveHandleLengthScale = 1.0,
  moveHandleThicknessScale = 1.0,
  suppressAxisAnimations = false,
  onMoveStart,
  onMove,
  onMoveEnd,
  onRotateStart,
  onRotate,
  onRotateEnd,
  onScaleStart,
  onScale,
  onScaleEnd,
  onDragStateChange,
  rootRef,
  disableArrowFlip,
  disableRingBillboard,
  disableViewCull,
  axisVisualFlip,
  uniformScaling = true,
}: TransformGizmoProps) {
  const { isDragging: isGlobalDragging } = usePicking();
  const { camera } = useThree();
  const gizmoRootRef = React.useRef<THREE.Group | null>(null);
  const [hoveredPart, setHoveredPart] = useState<string | null>(null);
  const [activePart, setActivePart] = useState<string | null>(null);
  const [isUniformScale, setIsUniformScale] = useState(false);
  const [viewCullState, setViewCullState] = useState<ViewCullState>(() => createDefaultViewCullState());
  const activePartRef = React.useRef<string | null>(null);
  const hoverClearRafRef = React.useRef<number | null>(null);
  const viewCullStateRef = React.useRef<ViewCullState>(createDefaultViewCullState());

  const positionX = Array.isArray(position) ? position[0] : position.x;
  const positionY = Array.isArray(position) ? position[1] : position.y;
  const positionZ = Array.isArray(position) ? position[2] : position.z;
  const rotationX = Array.isArray(rotation) ? rotation[0] : rotation.x;
  const rotationY = Array.isArray(rotation) ? rotation[1] : rotation.y;
  const rotationZ = Array.isArray(rotation) ? rotation[2] : rotation.z;

  const posArray: [number, number, number] = React.useMemo(
    () => [positionX, positionY, positionZ],
    [positionX, positionY, positionZ],
  );

  const posVec = React.useMemo(
    () => new THREE.Vector3(positionX, positionY, positionZ),
    [positionX, positionY, positionZ],
  );

  const rotEuler = React.useMemo(
    () => new THREE.Euler(rotationX, rotationY, rotationZ),
    [rotationX, rotationY, rotationZ],
  );

  const rotArray: [number, number, number] = [rotEuler.x, rotEuler.y, rotEuler.z];

  // Precompute world-space axis directions from the gizmo rotation so that
  // GizmoMove can use them instead of hardcoded world axes. This makes the
  // drag delta respect the visual rotation of the gizmo.
  const worldAxisDirs = React.useMemo(() => {
    const quat = new THREE.Quaternion().setFromEuler(rotEuler);
    return {
      x: new THREE.Vector3(1, 0, 0).applyQuaternion(quat),
      y: new THREE.Vector3(0, 1, 0).applyQuaternion(quat),
      z: new THREE.Vector3(0, 0, 1).applyQuaternion(quat),
    };
  }, [rotEuler]);

  React.useLayoutEffect(() => {
    if (!gizmoRootRef.current) return;

    gizmoRootRef.current.traverse((obj) => {
      if (obj.userData?.gizmoOverlayPatched === true) return;

      obj.frustumCulled = false;
      obj.renderOrder = GIZMO_RENDER_ORDER;
      // Mark only renderable gizmo handle geometry so pointer handlers can detect
      // gizmo involvement from intersections. Do NOT tag lights/targets; those
      // should not be hidden during thumbnail capture because it changes lighting.
      if (
        obj instanceof THREE.Mesh
        || obj instanceof THREE.Line
        || obj instanceof THREE.LineSegments
        || obj instanceof THREE.Points
      ) {
        obj.userData.isGizmoHandle = true;
      }

      const material = (obj as THREE.Mesh).material;
      if (!material) {
        obj.userData.gizmoOverlayPatched = true;
        return;
      }

      const applyOverlayMaterial = (m: THREE.Material) => {
        if ('depthTest' in m) (m as THREE.Material & { depthTest: boolean }).depthTest = false;
        if ('depthWrite' in m) (m as THREE.Material & { depthWrite: boolean }).depthWrite = false;
      };

      if (Array.isArray(material)) {
        material.forEach(applyOverlayMaterial);
      } else {
        applyOverlayMaterial(material);
      }

      obj.userData.gizmoOverlayPatched = true;
    });
  });

  React.useEffect(() => {
    return () => {
      if (hoverClearRafRef.current !== null) {
        window.cancelAnimationFrame(hoverClearRafRef.current);
        hoverClearRafRef.current = null;
      }
    };
  }, []);

  const setGizmoRootRef = React.useCallback((node: THREE.Group | null) => {
    gizmoRootRef.current = node;
    if (node) {
      node.frustumCulled = false;
      node.renderOrder = GIZMO_RENDER_ORDER;
    }
    if (rootRef) {
      rootRef.current = node;
    }
  }, [rootRef]);

  useFrame(() => {
    if (!visible) return;
    if (disableViewCull) return;

    const nextViewCullState = computeViewCullState(camera, posVec, rotEuler);
    if (viewCullStatesEqual(viewCullStateRef.current, nextViewCullState)) {
      return;
    }

    viewCullStateRef.current = nextViewCullState;
    setViewCullState(nextViewCullState);
  });

  const handlePointerEnter = (part: string) => {
    if (isGlobalDragging) return;
    if (hoverClearRafRef.current !== null) {
      window.cancelAnimationFrame(hoverClearRafRef.current);
      hoverClearRafRef.current = null;
    }

    if (!activePartRef.current) {
      setHoveredPart(part);
    }
  };

  const handlePointerLeave = () => {
    if (isGlobalDragging) return;
    if (activePartRef.current) return;

    if (hoverClearRafRef.current !== null) {
      window.cancelAnimationFrame(hoverClearRafRef.current);
    }

    hoverClearRafRef.current = window.requestAnimationFrame(() => {
      hoverClearRafRef.current = null;
      if (!activePartRef.current) {
        setHoveredPart(null);
      }
    });
  };

  const handleDragStart = (part: string, isUniform?: boolean): boolean => {
    const axisFromPart = getAxisFromPart(part);

    if ((part === 'center' || part.startsWith('axis-')) && onMoveStart) {
      const allowed = onMoveStart(axisFromPart);
      if (allowed === false) return false;
    }

    if (part.startsWith('ring-') && onRotateStart) {
      if (!axisFromPart) return false;
      const allowed = onRotateStart(axisFromPart);
      if (allowed === false) return false;
    }

    if (part.startsWith('scale-') && onScaleStart) {
      if (!axisFromPart) return false;
      const allowed = onScaleStart(axisFromPart, Boolean(isUniform));
      if (allowed === false) return false;
    }

    setActivePart(part);
    activePartRef.current = part;
    setHoveredPart(null);

    if (part.startsWith('scale-') && isUniform !== undefined) {
      setIsUniformScale(isUniform);
    }

    const operation = getOperationFromPart(part);
    if (onDragStateChange && operation) onDragStateChange(true, { operation });

    return true;
  };

  const handleDragEnd = () => {
    const part = activePart;
    setActivePart(null);
    activePartRef.current = null;

    if (hoverClearRafRef.current !== null) {
      window.cancelAnimationFrame(hoverClearRafRef.current);
      hoverClearRafRef.current = null;
    }

    const operation = part ? getOperationFromPart(part) : null;
    if (onDragStateChange) onDragStateChange(false, operation ? { operation } : undefined);

    if (part === 'center' && onMoveEnd) onMoveEnd();
    if (part?.startsWith('axis-') && onMoveEnd) onMoveEnd();
    if (part?.startsWith('ring-') && onRotateEnd) onRotateEnd();
    if (part?.startsWith('scale-') && onScaleEnd) onScaleEnd();
  };

  const handleAxisMove = (axis: GizmoAxis, delta: THREE.Vector3) => {
    if (onMove) {
      onMove(delta, axis);
    }
  };

  const handleCenterMove = (delta: THREE.Vector3) => {
    if (onMove) {
      onMove(delta);
    }
  };

  const handleRotate = (axis: GizmoAxis, angle: number) => {
    if (onRotate) {
      onRotate(axis, angle);
    }
  };

  const handleScaleDrag = (axis: GizmoAxis, factor: number, isUniform: boolean) => {
    if (onScale) {
      if (isUniform) {
        onScale('uniform', factor);
      } else {
        onScale(axis, factor);
      }
    }
  };

  const isDimmed = (part: string) => {
    const focusedPart = activePart;
    return focusedPart !== null && focusedPart !== part;
  };

  const isHidden = (part: string) => {
    return activePart !== null && activePart !== part;
  };

  const isAxisAllowed = (axis: GizmoAxis) => !axisLock || axisLock === axis;
  const suppressHover = isGlobalDragging;
  const dragOpacityScale = isGlobalDragging ? 0.6 : 1;

  const getViewCullOpacity = (part: string): number => {
    if (disableViewCull) {
      return 1;
    }

    if (part === activePart) {
      return 1;
    }

    const axis = getAxisFromPart(part);
    if (!axis) {
      return 1;
    }

    if (part.startsWith('axis-')) {
      return viewCullState.move[axis];
    }

    if (part.startsWith('scale-')) {
      return viewCullState.scale[axis];
    }

    if (part.startsWith('ring-')) {
      return viewCullState.rotate[axis];
    }

    return 1;
  };

  const isViewHidden = (part: string) => {
    if (disableViewCull) {
      return false;
    }

    if (part === activePart) {
      return false;
    }

    return getViewCullOpacity(part) <= VIEW_CULL_HIDE_THRESHOLD;
  };

  const partOpacityScale = (part: string) => dragOpacityScale * getViewCullOpacity(part);

  const partIsHidden = (part: string) => isHidden(part) || isViewHidden(part);

  const partIsInteractable = (part: string) => {
    if (part === activePart) return true;
    if (partIsHidden(part)) return false;
    return getViewCullOpacity(part) > VIEW_CULL_INTERACTION_THRESHOLD;
  };

  const shouldRenderPart = (part: string) => !isViewHidden(part);

  React.useEffect(() => {
    if (!suppressHover) return;
    if (hoverClearRafRef.current !== null) {
      window.cancelAnimationFrame(hoverClearRafRef.current);
      hoverClearRafRef.current = null;
    }
    setHoveredPart(null);
  }, [suppressHover]);

  if (!visible) return null;

  return (
    <group
      ref={setGizmoRootRef}
      position={posArray}
      rotation={rotArray}
      scale={size}
      renderOrder={GIZMO_RENDER_ORDER}
      frustumCulled={false}
    >
      {enableMove && showCenter && (
        <GizmoCenter
          isHovered={!suppressHover && hoveredPart === 'center'}
          isActive={activePart === 'center'}
          isDimmed={isDimmed('center')}
          isHidden={isHidden('center')}
          suppressHover={suppressHover}
          opacityScale={dragOpacityScale}
          gizmoPosition={posVec}
          onDragStart={() => handleDragStart('center')}
          onDrag={handleCenterMove}
          onDragEnd={handleDragEnd}
          onPointerEnter={() => handlePointerEnter('center')}
          onPointerLeave={handlePointerLeave}
        />
      )}

      {enableMove && (
        <>
          {isAxisAllowed('x') && shouldRenderPart('axis-x') && (
            <GizmoMove
              axis="x"
              worldAxisDir={worldAxisDirs.x}
              disableArrowFlip={disableArrowFlip}
              isHovered={!suppressHover && hoveredPart === 'axis-x'}
              isActive={activePart === 'axis-x'}
              isDimmed={isDimmed('axis-x')}
              isHidden={partIsHidden('axis-x')}
              suppressHover={suppressHover}
              opacityScale={partOpacityScale('axis-x')}
              interactionsEnabled={partIsInteractable('axis-x')}
              enableLighting={enableLighting}
              gizmoPosition={posVec}
              handleScale={handleScale}
              moveHandleBidirectional={moveHandleBidirectional}
              moveHandleLengthScale={moveHandleLengthScale}
              moveHandleThicknessScale={moveHandleThicknessScale}
              onDragStart={() => handleDragStart('axis-x')}
              onDrag={(delta: THREE.Vector3) => handleAxisMove('x', delta)}
              onDragEnd={handleDragEnd}
              onPointerEnter={() => handlePointerEnter('axis-x')}
              onPointerLeave={handlePointerLeave}
            />
          )}
          {isAxisAllowed('y') && shouldRenderPart('axis-y') && (
            <GizmoMove
              axis="y"
              worldAxisDir={worldAxisDirs.y}
              disableArrowFlip={disableArrowFlip}
              isHovered={!suppressHover && hoveredPart === 'axis-y'}
              isActive={activePart === 'axis-y'}
              isDimmed={isDimmed('axis-y')}
              isHidden={partIsHidden('axis-y')}
              suppressHover={suppressHover}
              opacityScale={partOpacityScale('axis-y')}
              interactionsEnabled={partIsInteractable('axis-y')}
              enableLighting={enableLighting}
              gizmoPosition={posVec}
              handleScale={handleScale}
              moveHandleBidirectional={moveHandleBidirectional}
              moveHandleLengthScale={moveHandleLengthScale}
              moveHandleThicknessScale={moveHandleThicknessScale}
              onDragStart={() => handleDragStart('axis-y')}
              onDrag={(delta: THREE.Vector3) => handleAxisMove('y', delta)}
              onDragEnd={handleDragEnd}
              onPointerEnter={() => handlePointerEnter('axis-y')}
              onPointerLeave={handlePointerLeave}
            />
          )}
          {isAxisAllowed('z') && shouldRenderPart('axis-z') && (
            <GizmoMove
              axis="z"
              worldAxisDir={worldAxisDirs.z}
              disableArrowFlip={disableArrowFlip}
              isHovered={!suppressHover && hoveredPart === 'axis-z'}
              isActive={activePart === 'axis-z'}
              isDimmed={isDimmed('axis-z')}
              isHidden={partIsHidden('axis-z')}
              suppressHover={suppressHover}
              opacityScale={partOpacityScale('axis-z')}
              interactionsEnabled={partIsInteractable('axis-z')}
              enableLighting={enableLighting}
              gizmoPosition={posVec}
              handleScale={handleScale}
              moveHandleBidirectional={moveHandleBidirectional}
              moveHandleLengthScale={moveHandleLengthScale}
              moveHandleThicknessScale={moveHandleThicknessScale}
              onDragStart={() => handleDragStart('axis-z')}
              onDrag={(delta: THREE.Vector3) => handleAxisMove('z', delta)}
              onDragEnd={handleDragEnd}
              onPointerEnter={() => handlePointerEnter('axis-z')}
              onPointerLeave={handlePointerLeave}
            />
          )}
        </>
      )}

      {enableRotate && (
        <>
          {shouldRenderPart('ring-x') && (
            <GizmoRotation
              axis="x"
              worldAxisDir={worldAxisDirs.x}
              axisVisualFlip={axisVisualFlip?.x ?? 1}
              isHovered={!suppressHover && hoveredPart === 'ring-x'}
              isActive={activePart === 'ring-x'}
              isDimmed={isDimmed('ring-x')}
              isHidden={partIsHidden('ring-x')}
              suppressHover={suppressHover}
              opacityScale={partOpacityScale('ring-x')}
              interactionsEnabled={partIsInteractable('ring-x')}
              suppressAxisAnimations={suppressAxisAnimations}
              disableRingBillboard={disableRingBillboard}
              gizmoPosition={posVec}
              handleScale={handleScale}
              onDragStart={() => handleDragStart('ring-x')}
              onDrag={(angle: number) => handleRotate('x', angle)}
              onDragEnd={handleDragEnd}
              onPointerEnter={() => handlePointerEnter('ring-x')}
              onPointerLeave={handlePointerLeave}
            />
          )}
          {shouldRenderPart('ring-y') && (
            <GizmoRotation
              axis="y"
              worldAxisDir={worldAxisDirs.y}
              axisVisualFlip={axisVisualFlip?.y ?? 1}
              isHovered={!suppressHover && hoveredPart === 'ring-y'}
              isActive={activePart === 'ring-y'}
              isDimmed={isDimmed('ring-y')}
              isHidden={partIsHidden('ring-y')}
              suppressHover={suppressHover}
              opacityScale={partOpacityScale('ring-y')}
              interactionsEnabled={partIsInteractable('ring-y')}
              suppressAxisAnimations={suppressAxisAnimations}
              disableRingBillboard={disableRingBillboard}
              gizmoPosition={posVec}
              handleScale={handleScale}
              onDragStart={() => handleDragStart('ring-y')}
              onDrag={(angle: number) => handleRotate('y', angle)}
              onDragEnd={handleDragEnd}
              onPointerEnter={() => handlePointerEnter('ring-y')}
              onPointerLeave={handlePointerLeave}
            />
          )}
          {shouldRenderPart('ring-z') && (
            <GizmoRotation
              axis="z"
              worldAxisDir={worldAxisDirs.z}
              axisVisualFlip={axisVisualFlip?.z ?? 1}
              isHovered={!suppressHover && hoveredPart === 'ring-z'}
              isActive={activePart === 'ring-z'}
              isDimmed={isDimmed('ring-z')}
              isHidden={partIsHidden('ring-z')}
              suppressHover={suppressHover}
              opacityScale={partOpacityScale('ring-z')}
              interactionsEnabled={partIsInteractable('ring-z')}
              suppressAxisAnimations={suppressAxisAnimations}
              disableRingBillboard={disableRingBillboard}
              gizmoPosition={posVec}
              handleScale={handleScale}
              onDragStart={() => handleDragStart('ring-z')}
              onDrag={(angle: number) => handleRotate('z', angle)}
              onDragEnd={handleDragEnd}
              onPointerEnter={() => handlePointerEnter('ring-z')}
              onPointerLeave={handlePointerLeave}
            />
          )}
        </>
      )}

      {enableScale && (
        <>
          {shouldRenderPart('scale-x') && (
            <GizmoScale
              axis="x"
              isHovered={!suppressHover && hoveredPart === 'scale-x'}
              isActive={activePart === 'scale-x'}
              isDimmed={isDimmed('scale-x')}
              isHidden={partIsHidden('scale-x')}
              suppressHover={suppressHover}
              opacityScale={partOpacityScale('scale-x')}
              interactionsEnabled={partIsInteractable('scale-x')}
              isUniform={uniformScaling}
              gizmoPosition={posVec}
              onDragStart={(isUniform: boolean) => handleDragStart('scale-x', isUniform)}
              onDrag={(factor: number, isUniform: boolean) => handleScaleDrag('x', factor, isUniform)}
              onDragEnd={handleDragEnd}
              onPointerEnter={() => handlePointerEnter('scale-x')}
              onPointerLeave={handlePointerLeave}
            />
          )}
          {shouldRenderPart('scale-y') && (
            <GizmoScale
              axis="y"
              isHovered={!suppressHover && hoveredPart === 'scale-y'}
              isActive={activePart === 'scale-y'}
              isDimmed={isDimmed('scale-y')}
              isHidden={partIsHidden('scale-y')}
              suppressHover={suppressHover}
              opacityScale={partOpacityScale('scale-y')}
              interactionsEnabled={partIsInteractable('scale-y')}
              isUniform={uniformScaling}
              gizmoPosition={posVec}
              onDragStart={(isUniform: boolean) => handleDragStart('scale-y', isUniform)}
              onDrag={(factor: number, isUniform: boolean) => handleScaleDrag('y', factor, isUniform)}
              onDragEnd={handleDragEnd}
              onPointerEnter={() => handlePointerEnter('scale-y')}
              onPointerLeave={handlePointerLeave}
            />
          )}
          {shouldRenderPart('scale-z') && (
            <GizmoScale
              axis="z"
              isHovered={!suppressHover && hoveredPart === 'scale-z'}
              isActive={activePart === 'scale-z'}
              isDimmed={isDimmed('scale-z')}
              isHidden={partIsHidden('scale-z')}
              suppressHover={suppressHover}
              opacityScale={partOpacityScale('scale-z')}
              interactionsEnabled={partIsInteractable('scale-z')}
              isUniform={uniformScaling}
              gizmoPosition={posVec}
              onDragStart={(isUniform: boolean) => handleDragStart('scale-z', isUniform)}
              onDrag={(factor: number, isUniform: boolean) => handleScaleDrag('z', factor, isUniform)}
              onDragEnd={handleDragEnd}
              onPointerEnter={() => handlePointerEnter('scale-z')}
              onPointerLeave={handlePointerLeave}
            />
          )}
        </>
      )}
    </group>
  );
}
