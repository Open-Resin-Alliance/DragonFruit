import React from 'react';
import * as THREE from 'three';

import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { ModelTransform } from '@/hooks/useModelTransform';
import { computeApproxModelWorldBounds } from '@/utils/modelBounds';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { blendTintColor } from '@/features/shaders/mesh/tint';

import { getBoxCorners } from './SceneCanvasGeometry';

const EXPORT_THUMBNAIL_WIDTH = 1600;
const EXPORT_THUMBNAIL_HEIGHT = 960;
const EXPORT_THUMBNAIL_MARGIN = 1.1;
const EXPORT_THUMBNAIL_YAW_RIGHT_DEG = -20;
const EXPORT_THUMBNAIL_PITCH_SCALE = 0.72;

type DefaultCameraSpec = {
  position: [number, number, number];
  up: [number, number, number];
};

export type ExportThumbnailRenderOptions = {
  includeGradient?: boolean;
  includeBuildPlate?: boolean;
  includeGrid?: boolean;
  centerOnModel?: boolean;
};

type UseExportThumbnailCaptureArgs = {
  models: LoadedModel[];
  meshColor?: string;
  modelWorldBounds: Map<string, THREE.Box3>;
  computeModelWorldBounds: (
    model: LoadedModel,
    modelTransformOverride?: ModelTransform,
    volumeBounds?: THREE.Box3 | null,
  ) => THREE.Box3;
  buildVolumeBounds: THREE.Box3 | null;
  activeTransformOverrideModelId: string | null;
  transform?: ModelTransform;
  defaultCamera: DefaultCameraSpec;
  rendererRef: React.RefObject<THREE.WebGLRenderer | null>;
  sceneRef: React.RefObject<THREE.Scene | null>;
  cameraRef: React.RefObject<THREE.Camera | null>;
  buildVolumeBoundsOverlayRef: React.RefObject<THREE.Group | null>;
  selectedTintColor?: string;
  selectedTintStrength?: number;
  exportThumbnailRenderOptions?: ExportThumbnailRenderOptions;
  onRegisterExportThumbnailCapture?: (capture: (() => Promise<Uint8Array | null>) | null) => void;
};

export function useExportThumbnailCapture({
  models,
  meshColor,
  modelWorldBounds,
  computeModelWorldBounds,
  buildVolumeBounds,
  activeTransformOverrideModelId,
  transform,
  defaultCamera,
  rendererRef,
  sceneRef,
  cameraRef,
  buildVolumeBoundsOverlayRef,
  selectedTintColor,
  selectedTintStrength,
  exportThumbnailRenderOptions,
  onRegisterExportThumbnailCapture,
}: UseExportThumbnailCaptureArgs) {
  const thumbnailCaptureActive = false;

  const captureExportThumbnailPng = React.useCallback(async (): Promise<Uint8Array | null> => {
    const renderer = rendererRef.current;
    const sceneGraph = sceneRef.current;
    const camera = cameraRef.current;

    if (!renderer || !sceneGraph || !camera) return null;

    // Only include models that are visible AND have bounds intersecting the build volume.
    // Models dragged out of bounds should not appear in the export thumbnail.
    const inBoundsModels = models.filter((model) => {
      if (!model.visible) return false;
      if (!buildVolumeBounds) return true;
      const bounds = modelWorldBounds.get(model.id) ?? computeModelWorldBounds(model, model.transform, buildVolumeBounds);
      if (!bounds || bounds.isEmpty()) return false;
      return bounds.intersectsBox(buildVolumeBounds);
    });
    const inBoundsModelIdSet = new Set(inBoundsModels.map((model) => model.id));

    const visibleBounds = inBoundsModels
      .map((model) => modelWorldBounds.get(model.id) ?? computeModelWorldBounds(model, model.transform, buildVolumeBounds))
      .filter((box): box is THREE.Box3 => !!box && !box.isEmpty());

    if (visibleBounds.length === 0) return null;

    const boundsUnion = visibleBounds[0].clone();
    for (let i = 1; i < visibleBounds.length; i += 1) {
      boundsUnion.union(visibleBounds[i]);
    }

    const sampledModelPoints: THREE.Vector3[] = [];
    const MAX_SAMPLED_POINTS_TOTAL = 3600;
    const MAX_SAMPLED_POINTS_PER_MODEL = 720;
    const sampledPoint = new THREE.Vector3();
    const sampleMatrix = new THREE.Matrix4();
    const sampleQuaternion = new THREE.Quaternion();

    for (let modelIndex = 0; modelIndex < inBoundsModels.length; modelIndex += 1) {
      if (sampledModelPoints.length >= MAX_SAMPLED_POINTS_TOTAL) break;

      const model = inBoundsModels[modelIndex];

      const effectiveTransform =
        (model.id === activeTransformOverrideModelId && transform)
          ? transform
          : model.transform;

      sampleMatrix.compose(
        effectiveTransform.position,
        sampleQuaternion.copy(quaternionFromGlobalEuler(effectiveTransform.rotation)),
        effectiveTransform.scale,
      );

      const positionAttr = model.geometry.geometry.getAttribute('position');
      if (!positionAttr || positionAttr.count <= 0) continue;

      const remainingBudget = MAX_SAMPLED_POINTS_TOTAL - sampledModelPoints.length;
      const sampleBudget = Math.min(MAX_SAMPLED_POINTS_PER_MODEL, remainingBudget);
      const stride = Math.max(1, Math.floor(positionAttr.count / Math.max(1, sampleBudget)));

      const center = model.geometry.center;
      let collected = 0;
      for (let vertexIndex = 0; vertexIndex < positionAttr.count && collected < sampleBudget; vertexIndex += stride) {
        sampledPoint
          .set(positionAttr.getX(vertexIndex), positionAttr.getY(vertexIndex), positionAttr.getZ(vertexIndex))
          .sub(center)
          .applyMatrix4(sampleMatrix);
        sampledModelPoints.push(sampledPoint.clone());
        collected += 1;
      }
    }

    const target = boundsUnion.getCenter(new THREE.Vector3());
    const focusBounds = boundsUnion.clone();
    const centerOnModel = exportThumbnailRenderOptions?.centerOnModel ?? true;
    if (centerOnModel) {
      const visibleModelGeometryBounds = inBoundsModels
        .map((model) => {
          const effectiveTransform =
            (model.id === activeTransformOverrideModelId && transform)
              ? transform
              : model.transform;
          return computeApproxModelWorldBounds(model.geometry, effectiveTransform);
        })
        .filter((box): box is THREE.Box3 => !!box && !box.isEmpty());

      if (visibleModelGeometryBounds.length > 0) {
        const geometryUnion = visibleModelGeometryBounds[0].clone();
        for (let i = 1; i < visibleModelGeometryBounds.length; i += 1) {
          geometryUnion.union(visibleModelGeometryBounds[i]);
        }
        focusBounds.copy(geometryUnion);
        const geometryCenter = geometryUnion.getCenter(new THREE.Vector3());
        const fullSize = boundsUnion.getSize(new THREE.Vector3());
        const geometrySize = geometryUnion.getSize(new THREE.Vector3());
        const fullHeight = Math.max(1e-6, fullSize.z);
        const nonModelHeight = Math.max(0, fullSize.z - geometrySize.z);
        const nonModelInfluence = THREE.MathUtils.clamp(nonModelHeight / fullHeight, 0, 1);
        const modelCenterBias = THREE.MathUtils.lerp(0.82, 0.28, nonModelInfluence);
        target.lerp(geometryCenter, modelCenterBias);
      }
    }

    // Keep thumbnail framing in an absolute world direction so it does not drift
    // with the user's current viewport orbit/pan state.
    const introDirection = new THREE.Vector3(
      defaultCamera.position[0],
      defaultCamera.position[1],
      defaultCamera.position[2],
    );
    if (introDirection.lengthSq() < 1e-8) {
      introDirection.copy(camera.position).sub(target);
    }
    if (introDirection.lengthSq() < 1e-8) {
      introDirection.set(-1, -1, 1);
    }
    introDirection.normalize();

    const baseYaw = Math.atan2(introDirection.y, introDirection.x);
    const basePitch = Math.atan2(introDirection.z, Math.hypot(introDirection.x, introDirection.y));
    const adjustedYaw = baseYaw - THREE.MathUtils.degToRad(EXPORT_THUMBNAIL_YAW_RIGHT_DEG);
    const adjustedPitch = THREE.MathUtils.clamp(
      basePitch * EXPORT_THUMBNAIL_PITCH_SCALE,
      THREE.MathUtils.degToRad(-75),
      THREE.MathUtils.degToRad(75),
    );
    const cosPitch = Math.cos(adjustedPitch);
    introDirection.set(
      Math.cos(adjustedYaw) * cosPitch,
      Math.sin(adjustedYaw) * cosPitch,
      Math.sin(adjustedPitch),
    ).normalize();

    const worldUp = new THREE.Vector3(defaultCamera.up[0], defaultCamera.up[1], defaultCamera.up[2]).normalize();
    const viewForward = introDirection.clone();
    const viewRight = new THREE.Vector3().crossVectors(worldUp, viewForward);
    if (viewRight.lengthSq() < 1e-8) {
      viewRight.set(1, 0, 0);
    }
    viewRight.normalize();
    const viewUp = new THREE.Vector3().crossVectors(viewForward, viewRight).normalize();

    const fitCorners = getBoxCorners(boundsUnion);

    const prevRenderTarget = renderer.getRenderTarget();
    const prevViewport = renderer.getViewport(new THREE.Vector4());
    const prevScissor = renderer.getScissor(new THREE.Vector4());
    const prevScissorTest = renderer.getScissorTest();
    const prevBuildVolumeOverlayVisible = buildVolumeBoundsOverlayRef.current?.visible ?? null;
    const visibilityRestores: Array<{ node: THREE.Object3D; visible: boolean }> = [];
    const lightRestores: Array<{ light: THREE.Light; position: THREE.Vector3 }> = [];
    const colorRestores: Array<{ material: THREE.Material & { color: THREE.Color }; color: THREE.Color }> = [];
    const helperOriginalVisibility = new WeakMap<THREE.Object3D, boolean>();
    const buildPlateHelperNodes: THREE.Object3D[] = [];
    const gridHelperNodes: THREE.Object3D[] = [];
    const fallbackModelBaseColor = meshColor ?? '#a3a3a3';
    const captureSelectedTintStrength = THREE.MathUtils.clamp(selectedTintStrength ?? 0.75, 0, 1);

    const hideHelperForFit = (node: THREE.Object3D) => {
      if (!helperOriginalVisibility.has(node)) {
        helperOriginalVisibility.set(node, node.visible);
        visibilityRestores.push({ node, visible: node.visible });
      }
      node.visible = false;
    };

    const restoreRendererState = () => {
      renderer.setRenderTarget(prevRenderTarget);
      renderer.setViewport(prevViewport.x, prevViewport.y, prevViewport.z, prevViewport.w);
      renderer.setScissor(prevScissor.x, prevScissor.y, prevScissor.z, prevScissor.w);
      renderer.setScissorTest(prevScissorTest);
      if (buildVolumeBoundsOverlayRef.current && prevBuildVolumeOverlayVisible != null) {
        buildVolumeBoundsOverlayRef.current.visible = prevBuildVolumeOverlayVisible;
      }
      for (let i = lightRestores.length - 1; i >= 0; i -= 1) {
        const entry = lightRestores[i];
        entry.light.position.copy(entry.position);
        entry.light.updateMatrixWorld(true);
      }
      for (let i = colorRestores.length - 1; i >= 0; i -= 1) {
        const entry = colorRestores[i];
        entry.material.color.copy(entry.color);
        entry.material.needsUpdate = true;
      }
      for (let i = visibilityRestores.length - 1; i >= 0; i -= 1) {
        const entry = visibilityRestores[i];
        entry.node.visible = entry.visible;
      }
    };

    const tintMaterialForCapture = (material: THREE.Material, modelId?: string) => {
      const colorMaterial = material as THREE.Material & { color?: THREE.Color };
      if (!(colorMaterial.color instanceof THREE.Color)) return;

      if (colorRestores.every((entry) => entry.material !== colorMaterial)) {
        colorRestores.push({ material: colorMaterial as THREE.Material & { color: THREE.Color }, color: colorMaterial.color.clone() });
      }

      const model = modelId ? models.find((entry) => entry.id === modelId) : null;
      const baseColor = model?.color ?? fallbackModelBaseColor;
      const blended = blendTintColor(baseColor, selectedTintColor, captureSelectedTintStrength);
      try {
        colorMaterial.color.setStyle(blended);
      } catch {
        colorMaterial.color.setStyle('#ec2a77');
      }
      colorMaterial.needsUpdate = true;
    };

    let captureRenderer: THREE.WebGLRenderer | null = null;

    try {

      const aspect = EXPORT_THUMBNAIL_WIDTH / EXPORT_THUMBNAIL_HEIGHT;
      let captureCamera: THREE.Camera;
      if (camera instanceof THREE.PerspectiveCamera) {
        const perspective = new THREE.PerspectiveCamera(camera.fov, aspect, camera.near, camera.far);
        perspective.up.set(defaultCamera.up[0], defaultCamera.up[1], defaultCamera.up[2]);

        const vFov = THREE.MathUtils.degToRad(perspective.fov);
        const halfV = Math.max(0.0001, vFov * 0.5);
        const halfH = Math.max(0.0001, Math.atan(Math.tan(halfV) * perspective.aspect));
        const tanHalfV = Math.tan(halfV);
        const tanHalfH = Math.tan(halfH);

        let requiredDistance = 0;
        for (let i = 0; i < fitCorners.length; i += 1) {
          const offset = fitCorners[i].clone().sub(target);
          const x = Math.abs(offset.dot(viewRight));
          const y = Math.abs(offset.dot(viewUp));
          const zForward = offset.dot(viewForward);
          const distanceForX = zForward + (x / Math.max(1e-6, tanHalfH));
          const distanceForY = zForward + (y / Math.max(1e-6, tanHalfV));
          requiredDistance = Math.max(requiredDistance, distanceForX, distanceForY);
        }

        const distance = Math.max(10, requiredDistance * EXPORT_THUMBNAIL_MARGIN);
        perspective.position.copy(target.clone().addScaledVector(introDirection, Math.max(10, distance)));
        perspective.lookAt(target);
        perspective.updateProjectionMatrix();
        perspective.updateMatrixWorld(true);
        captureCamera = perspective;
      } else if (camera instanceof THREE.OrthographicCamera) {
        const ortho = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, camera.near, camera.far);
        ortho.up.set(defaultCamera.up[0], defaultCamera.up[1], defaultCamera.up[2]);

        let halfWidth = 0;
        let halfHeight = 0;
        for (let i = 0; i < fitCorners.length; i += 1) {
          const offset = fitCorners[i].clone().sub(target);
          halfWidth = Math.max(halfWidth, Math.abs(offset.dot(viewRight)));
          halfHeight = Math.max(halfHeight, Math.abs(offset.dot(viewUp)));
        }

        halfWidth = Math.max(1e-6, halfWidth * EXPORT_THUMBNAIL_MARGIN);
        halfHeight = Math.max(1e-6, halfHeight * EXPORT_THUMBNAIL_MARGIN);
        const zoomByHeight = 1 / halfHeight;
        const zoomByWidth = aspect / halfWidth;
        ortho.zoom = Math.max(0.0001, Math.min(zoomByHeight, zoomByWidth));
        const distance = Math.max(10, boundsUnion.getSize(new THREE.Vector3()).length() * 1.25);
        ortho.position.copy(target.clone().addScaledVector(introDirection, distance));
        ortho.lookAt(target);
        ortho.updateProjectionMatrix();
        ortho.updateMatrixWorld(true);
        captureCamera = ortho;
      } else {
        const fallback = camera.clone() as THREE.Camera;
        fallback.up.set(defaultCamera.up[0], defaultCamera.up[1], defaultCamera.up[2]);
        fallback.position.copy(target.clone().addScaledVector(introDirection, Math.max(10, boundsUnion.getSize(new THREE.Vector3()).length() * 1.25)));
        fallback.lookAt(target);
        fallback.updateMatrixWorld(true);
        captureCamera = fallback;
      }

      const centerNdcBounds = {
        minX: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      };

      const centerPoints = sampledModelPoints.length > 0 ? sampledModelPoints : fitCorners;

      for (let i = 0; i < centerPoints.length; i += 1) {
        const ndc = centerPoints[i].clone().project(captureCamera);
        if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) continue;
        centerNdcBounds.minX = Math.min(centerNdcBounds.minX, ndc.x);
        centerNdcBounds.maxX = Math.max(centerNdcBounds.maxX, ndc.x);
        centerNdcBounds.minY = Math.min(centerNdcBounds.minY, ndc.y);
        centerNdcBounds.maxY = Math.max(centerNdcBounds.maxY, ndc.y);
      }

      if (
        Number.isFinite(centerNdcBounds.minX)
        && Number.isFinite(centerNdcBounds.maxX)
        && Number.isFinite(centerNdcBounds.minY)
        && Number.isFinite(centerNdcBounds.maxY)
      ) {
        const ndcCenterX = (centerNdcBounds.minX + centerNdcBounds.maxX) * 0.5;
        const ndcCenterY = (centerNdcBounds.minY + centerNdcBounds.maxY) * 0.5;

        if (Math.abs(ndcCenterX) > 1e-4 || Math.abs(ndcCenterY) > 1e-4) {
          const recenterOffset = new THREE.Vector3();

          if (captureCamera instanceof THREE.PerspectiveCamera) {
            const targetDistance = Math.max(1e-6, captureCamera.position.distanceTo(target));
            const halfV = Math.max(1e-6, THREE.MathUtils.degToRad(captureCamera.fov) * 0.5);
            const halfHeight = Math.tan(halfV) * targetDistance;
            const halfWidth = halfHeight * captureCamera.aspect;
            recenterOffset
              .addScaledVector(viewRight, ndcCenterX * halfWidth)
              .addScaledVector(viewUp, ndcCenterY * halfHeight);
          } else if (captureCamera instanceof THREE.OrthographicCamera) {
            const halfWidth = (captureCamera.right - captureCamera.left) / Math.max(1e-6, captureCamera.zoom) * 0.5;
            const halfHeight = (captureCamera.top - captureCamera.bottom) / Math.max(1e-6, captureCamera.zoom) * 0.5;
            recenterOffset
              .addScaledVector(viewRight, ndcCenterX * halfWidth)
              .addScaledVector(viewUp, ndcCenterY * halfHeight);
          }

          if (recenterOffset.lengthSq() > 1e-10) {
            target.add(recenterOffset);
            captureCamera.position.add(recenterOffset);
            captureCamera.lookAt(target);
            if (captureCamera instanceof THREE.PerspectiveCamera || captureCamera instanceof THREE.OrthographicCamera) {
              captureCamera.updateProjectionMatrix();
            }
            captureCamera.updateMatrixWorld(true);
          }
        }
      }

      const fitNdcBounds = {
        minX: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      };

      const fitPoints = sampledModelPoints.length > 0 ? sampledModelPoints : fitCorners;
      for (let i = 0; i < fitPoints.length; i += 1) {
        const ndc = fitPoints[i].clone().project(captureCamera);
        if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) continue;
        fitNdcBounds.minX = Math.min(fitNdcBounds.minX, ndc.x);
        fitNdcBounds.maxX = Math.max(fitNdcBounds.maxX, ndc.x);
        fitNdcBounds.minY = Math.min(fitNdcBounds.minY, ndc.y);
        fitNdcBounds.maxY = Math.max(fitNdcBounds.maxY, ndc.y);
      }

      if (
        Number.isFinite(fitNdcBounds.minX)
        && Number.isFinite(fitNdcBounds.maxX)
        && Number.isFinite(fitNdcBounds.minY)
        && Number.isFinite(fitNdcBounds.maxY)
      ) {
        const halfW = Math.max(1e-6, (fitNdcBounds.maxX - fitNdcBounds.minX) * 0.5);
        const halfH = Math.max(1e-6, (fitNdcBounds.maxY - fitNdcBounds.minY) * 0.5);
        const currentFill = Math.max(halfW, halfH);
        const desiredFill = 0.9;

        if (currentFill > 1e-4 && Math.abs(currentFill - desiredFill) > 0.03) {
          if (captureCamera instanceof THREE.PerspectiveCamera) {
            const scale = THREE.MathUtils.clamp(currentFill / desiredFill, 0.45, 2.2);
            const currentDistance = Math.max(1e-6, captureCamera.position.distanceTo(target));
            const nextDistance = Math.max(10, currentDistance * scale);
            captureCamera.position.copy(target.clone().addScaledVector(introDirection, nextDistance));
            captureCamera.lookAt(target);
            captureCamera.updateProjectionMatrix();
            captureCamera.updateMatrixWorld(true);
          } else if (captureCamera instanceof THREE.OrthographicCamera) {
            const zoomScale = THREE.MathUtils.clamp(desiredFill / currentFill, 0.45, 2.2);
            captureCamera.zoom = Math.max(0.0001, captureCamera.zoom * zoomScale);
            captureCamera.updateProjectionMatrix();
            captureCamera.updateMatrixWorld(true);
          }
        }
      }

      const safetyNdcBounds = {
        minX: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      };

      for (let i = 0; i < fitCorners.length; i += 1) {
        const ndc = fitCorners[i].clone().project(captureCamera);
        if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) continue;
        safetyNdcBounds.minX = Math.min(safetyNdcBounds.minX, ndc.x);
        safetyNdcBounds.maxX = Math.max(safetyNdcBounds.maxX, ndc.x);
        safetyNdcBounds.minY = Math.min(safetyNdcBounds.minY, ndc.y);
        safetyNdcBounds.maxY = Math.max(safetyNdcBounds.maxY, ndc.y);
      }

      if (
        Number.isFinite(safetyNdcBounds.minX)
        && Number.isFinite(safetyNdcBounds.maxX)
        && Number.isFinite(safetyNdcBounds.minY)
        && Number.isFinite(safetyNdcBounds.maxY)
      ) {
        const OVERFLOW_TRIGGER = 1.22;
        const hasHardOverflow = (
          safetyNdcBounds.minX < -OVERFLOW_TRIGGER
          || safetyNdcBounds.maxX > OVERFLOW_TRIGGER
          || safetyNdcBounds.minY < -OVERFLOW_TRIGGER
          || safetyNdcBounds.maxY > OVERFLOW_TRIGGER
        );

        if (hasHardOverflow) {
          const safetyHalfW = Math.max(1e-6, (safetyNdcBounds.maxX - safetyNdcBounds.minX) * 0.5);
          const safetyHalfH = Math.max(1e-6, (safetyNdcBounds.maxY - safetyNdcBounds.minY) * 0.5);
          const safetyFill = Math.max(safetyHalfW, safetyHalfH);
          const maxAllowedFill = sampledModelPoints.length > 0 ? 1.02 : 0.99;

          if (captureCamera instanceof THREE.PerspectiveCamera) {
            const scaleOut = THREE.MathUtils.clamp(safetyFill / maxAllowedFill, 1.0, 1.75);
            const currentDistance = Math.max(1e-6, captureCamera.position.distanceTo(target));
            const nextDistance = Math.max(10, currentDistance * scaleOut);
            captureCamera.position.copy(target.clone().addScaledVector(introDirection, nextDistance));
            captureCamera.lookAt(target);
            captureCamera.updateProjectionMatrix();
            captureCamera.updateMatrixWorld(true);
          } else if (captureCamera instanceof THREE.OrthographicCamera) {
            const zoomOutScale = THREE.MathUtils.clamp(maxAllowedFill / safetyFill, 0.58, 1.0);
            captureCamera.zoom = Math.max(0.0001, captureCamera.zoom * zoomOutScale);
            captureCamera.updateProjectionMatrix();
            captureCamera.updateMatrixWorld(true);
          }
        }
      }

      const includeBuildPlate = exportThumbnailRenderOptions?.includeBuildPlate ?? false;
      const includeGrid = exportThumbnailRenderOptions?.includeGrid ?? false;

      sceneGraph.traverse((node) => {
        const helperType = (node.userData as Record<string, unknown> | undefined)?.thumbnailHelperType;
        const isGizmoNode = Boolean((node.userData as Record<string, unknown> | undefined)?.isGizmoHandle);
        const isModelTintTarget = (node.userData as Record<string, unknown> | undefined)?.thumbnailTintTarget === 'modelMesh';
        const modelId = typeof (node.userData as Record<string, unknown> | undefined)?.modelId === 'string'
          ? ((node.userData as Record<string, unknown>).modelId as string)
          : undefined;
        const shouldExcludeFromThumbnail = Boolean((node.userData as Record<string, unknown> | undefined)?.thumbnailCaptureExclude);

        if (shouldExcludeFromThumbnail) {
          hideHelperForFit(node);
          return;
        }

        if (isGizmoNode) {
          hideHelperForFit(node);
        }

        if (modelId && !inBoundsModelIdSet.has(modelId)) {
          // Hide the parent group so the mesh and all its support/raft children disappear.
          hideHelperForFit(node.parent ?? node);
          return;
        }

        if (isModelTintTarget && node instanceof THREE.Mesh) {
          const material = node.material;
          if (Array.isArray(material)) {
            material.forEach((entry) => tintMaterialForCapture(entry, modelId));
          } else if (material) {
            tintMaterialForCapture(material, modelId);
          }
        }

        if (helperType === 'buildPlate') {
          buildPlateHelperNodes.push(node);
          hideHelperForFit(node);
          return;
        }
        if (helperType === 'grid') {
          gridHelperNodes.push(node);
          hideHelperForFit(node);
          return;
        }
        if (helperType === 'footprintBorder') {
          hideHelperForFit(node);
          return;
        }
        if (helperType === 'buildVolumeOverlay') {
          hideHelperForFit(node);
        }
      });

      if (buildVolumeBoundsOverlayRef.current) {
        buildVolumeBoundsOverlayRef.current.visible = false;
      }

      const syncCaptureCameraLights = () => {
        sceneGraph.traverse((node) => {
          if (!(node instanceof THREE.Light)) return;
          const light = node;
          const followCaptureCamera = Boolean((light.userData as Record<string, unknown> | undefined)?.followCaptureCamera);
          if (!followCaptureCamera) return;
          if (lightRestores.every((entry) => entry.light !== light)) {
            lightRestores.push({ light, position: light.position.clone() });
          }
          light.position.copy(captureCamera.position);
          light.updateMatrixWorld(true);
        });
      };

      const captureCanvas = document.createElement('canvas');
      captureCanvas.width = EXPORT_THUMBNAIL_WIDTH;
      captureCanvas.height = EXPORT_THUMBNAIL_HEIGHT;

      const liveClearColor = renderer.getClearColor(new THREE.Color());
      const liveClearAlpha = renderer.getClearAlpha();

      captureRenderer = new THREE.WebGLRenderer({
        canvas: captureCanvas,
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
      });
      captureRenderer.outputColorSpace = renderer.outputColorSpace;
      captureRenderer.toneMapping = renderer.toneMapping;
      captureRenderer.toneMappingExposure = renderer.toneMappingExposure;
      captureRenderer.autoClear = renderer.autoClear;
      captureRenderer.shadowMap.enabled = renderer.shadowMap.enabled;
      captureRenderer.shadowMap.type = renderer.shadowMap.type;
      captureRenderer.setClearColor(liveClearColor, liveClearAlpha);
      captureRenderer.setPixelRatio(1);
      captureRenderer.setSize(EXPORT_THUMBNAIL_WIDTH, EXPORT_THUMBNAIL_HEIGHT, false);
      captureRenderer.setViewport(0, 0, EXPORT_THUMBNAIL_WIDTH, EXPORT_THUMBNAIL_HEIGHT);
      captureRenderer.setScissor(0, 0, EXPORT_THUMBNAIL_WIDTH, EXPORT_THUMBNAIL_HEIGHT);
      captureRenderer.setScissorTest(false);

      const renderCaptureScene = () => {
        syncCaptureCameraLights();
        captureRenderer?.clear(true, true, true);
        captureRenderer?.render(sceneGraph, captureCamera);
      };

      const analysisCanvas = document.createElement('canvas');
      analysisCanvas.width = EXPORT_THUMBNAIL_WIDTH;
      analysisCanvas.height = EXPORT_THUMBNAIL_HEIGHT;
      const analysisContext = analysisCanvas.getContext('2d', { willReadFrequently: true });

      const measureRenderedSubjectNdcBounds = () => {
        if (!analysisContext) return null;

        const width = EXPORT_THUMBNAIL_WIDTH;
        const height = EXPORT_THUMBNAIL_HEIGHT;
        analysisContext.clearRect(0, 0, width, height);
        analysisContext.drawImage(captureCanvas, 0, 0, width, height);
        const pixels = analysisContext.getImageData(0, 0, width, height).data;

        const topLeft = 0;
        const topRight = (width - 1) * 4;
        const bottomLeft = ((height - 1) * width) * 4;
        const bottomRight = (((height - 1) * width) + (width - 1)) * 4;
        const bgR = Math.round((pixels[topLeft] + pixels[topRight] + pixels[bottomLeft] + pixels[bottomRight]) * 0.25);
        const bgG = Math.round((pixels[topLeft + 1] + pixels[topRight + 1] + pixels[bottomLeft + 1] + pixels[bottomRight + 1]) * 0.25);
        const bgB = Math.round((pixels[topLeft + 2] + pixels[topRight + 2] + pixels[bottomLeft + 2] + pixels[bottomRight + 2]) * 0.25);

        const bounds = {
          minX: Number.POSITIVE_INFINITY,
          maxX: Number.NEGATIVE_INFINITY,
          minY: Number.POSITIVE_INFINITY,
          maxY: Number.NEGATIVE_INFINITY,
        };

        const colorDeltaThreshold = 30;
        for (let y = 0; y < height; y += 1) {
          const rowOffset = y * width * 4;
          for (let x = 0; x < width; x += 1) {
            const i = rowOffset + (x * 4);
            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            const delta = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
            if (delta <= colorDeltaThreshold) continue;

            const ndcX = ((x / width) * 2) - 1;
            const ndcY = 1 - ((y / height) * 2);
            bounds.minX = Math.min(bounds.minX, ndcX);
            bounds.maxX = Math.max(bounds.maxX, ndcX);
            bounds.minY = Math.min(bounds.minY, ndcY);
            bounds.maxY = Math.max(bounds.maxY, ndcY);
          }
        }

        if (
          !Number.isFinite(bounds.minX)
          || !Number.isFinite(bounds.maxX)
          || !Number.isFinite(bounds.minY)
          || !Number.isFinite(bounds.maxY)
        ) {
          return null;
        }

        return bounds;
      };

      const DESIRED_SCREEN_FILL = 0.93;
      for (let pass = 0; pass < 2; pass += 1) {
        renderCaptureScene();

        const ndcBounds = measureRenderedSubjectNdcBounds();
        if (!ndcBounds) break;

        const ndcCenterX = (ndcBounds.minX + ndcBounds.maxX) * 0.5;
        const ndcCenterY = (ndcBounds.minY + ndcBounds.maxY) * 0.5;
        const halfW = Math.max(1e-6, (ndcBounds.maxX - ndcBounds.minX) * 0.5);
        const halfH = Math.max(1e-6, (ndcBounds.maxY - ndcBounds.minY) * 0.5);
        const currentFill = Math.max(halfW, halfH);

        let changed = false;

        if (Math.abs(ndcCenterX) > 0.01 || Math.abs(ndcCenterY) > 0.01) {
          const recenterOffset = new THREE.Vector3();
          if (captureCamera instanceof THREE.PerspectiveCamera) {
            const targetDistance = Math.max(1e-6, captureCamera.position.distanceTo(target));
            const halfV = Math.max(1e-6, THREE.MathUtils.degToRad(captureCamera.fov) * 0.5);
            const viewHalfHeight = Math.tan(halfV) * targetDistance;
            const viewHalfWidth = viewHalfHeight * captureCamera.aspect;
            recenterOffset
              .addScaledVector(viewRight, ndcCenterX * viewHalfWidth)
              .addScaledVector(viewUp, ndcCenterY * viewHalfHeight);
          } else if (captureCamera instanceof THREE.OrthographicCamera) {
            const viewHalfWidth = (captureCamera.right - captureCamera.left) / Math.max(1e-6, captureCamera.zoom) * 0.5;
            const viewHalfHeight = (captureCamera.top - captureCamera.bottom) / Math.max(1e-6, captureCamera.zoom) * 0.5;
            recenterOffset
              .addScaledVector(viewRight, ndcCenterX * viewHalfWidth)
              .addScaledVector(viewUp, ndcCenterY * viewHalfHeight);
          }

          if (recenterOffset.lengthSq() > 1e-10) {
            target.add(recenterOffset);
            captureCamera.position.add(recenterOffset);
            captureCamera.lookAt(target);
            if (captureCamera instanceof THREE.PerspectiveCamera || captureCamera instanceof THREE.OrthographicCamera) {
              captureCamera.updateProjectionMatrix();
            }
            captureCamera.updateMatrixWorld(true);
            changed = true;
          }
        }

        if (currentFill > 1e-4 && Math.abs(currentFill - DESIRED_SCREEN_FILL) > 0.025) {
          if (captureCamera instanceof THREE.PerspectiveCamera) {
            const scale = THREE.MathUtils.clamp(currentFill / DESIRED_SCREEN_FILL, 0.5, 2.1);
            const currentDistance = Math.max(1e-6, captureCamera.position.distanceTo(target));
            captureCamera.position.copy(target.clone().addScaledVector(introDirection, Math.max(10, currentDistance * scale)));
            captureCamera.lookAt(target);
            captureCamera.updateProjectionMatrix();
            captureCamera.updateMatrixWorld(true);
            changed = true;
          } else if (captureCamera instanceof THREE.OrthographicCamera) {
            const zoomScale = THREE.MathUtils.clamp(DESIRED_SCREEN_FILL / currentFill, 0.5, 2.1);
            captureCamera.zoom = Math.max(0.0001, captureCamera.zoom * zoomScale);
            captureCamera.updateProjectionMatrix();
            captureCamera.updateMatrixWorld(true);
            changed = true;
          }
        }

        if (!changed) break;
      }

      for (const node of buildPlateHelperNodes) {
        const originalVisible = helperOriginalVisibility.get(node) ?? true;
        node.visible = originalVisible && includeBuildPlate;
      }
      for (const node of gridHelperNodes) {
        const originalVisible = helperOriginalVisibility.get(node) ?? true;
        node.visible = originalVisible && includeGrid;
      }

      renderCaptureScene();

      const canvas = document.createElement('canvas');
      canvas.width = EXPORT_THUMBNAIL_WIDTH;
      canvas.height = EXPORT_THUMBNAIL_HEIGHT;
      const context = canvas.getContext('2d');
      if (!context) {
        return null;
      }

      context.drawImage(captureCanvas, 0, 0, EXPORT_THUMBNAIL_WIDTH, EXPORT_THUMBNAIL_HEIGHT);

      const includeGradient = exportThumbnailRenderOptions?.includeGradient ?? false;
      if (includeGradient) {
        const rootStyles = getComputedStyle(document.documentElement);
        const radialColor = rootStyles.getPropertyValue('--scene-gradient-radial').trim() || '#ff37aa';
        const linearStartColor = rootStyles.getPropertyValue('--scene-gradient-linear-start').trim() || '#ff37aa';
        const linearMidColor = rootStyles.getPropertyValue('--scene-gradient-linear-mid').trim() || '#6f33ff';

        context.save();
        context.globalCompositeOperation = 'screen';

        const radialGradient = context.createRadialGradient(
          EXPORT_THUMBNAIL_WIDTH * 0.5,
          EXPORT_THUMBNAIL_HEIGHT * 0.46,
          0,
          EXPORT_THUMBNAIL_WIDTH * 0.5,
          EXPORT_THUMBNAIL_HEIGHT * 0.46,
          Math.max(EXPORT_THUMBNAIL_WIDTH * 0.72, EXPORT_THUMBNAIL_HEIGHT * 0.72),
        );
        radialGradient.addColorStop(0.56, 'rgba(0, 0, 0, 0)');
        radialGradient.addColorStop(1, radialColor);
        context.globalAlpha = 0.14;
        context.fillStyle = radialGradient;
        context.fillRect(0, 0, EXPORT_THUMBNAIL_WIDTH, EXPORT_THUMBNAIL_HEIGHT);

        const linearGradient = context.createLinearGradient(0, 0, 0, EXPORT_THUMBNAIL_HEIGHT);
        linearGradient.addColorStop(0, linearStartColor);
        linearGradient.addColorStop(0.4, linearMidColor);
        linearGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        context.globalAlpha = 0.08;
        context.fillStyle = linearGradient;
        context.fillRect(0, 0, EXPORT_THUMBNAIL_WIDTH, EXPORT_THUMBNAIL_HEIGHT);
        context.restore();
      }

      const dataUrl = canvas.toDataURL('image/png');
      const commaIndex = dataUrl.indexOf(',');
      if (commaIndex < 0) {
        return null;
      }
      const base64 = dataUrl.slice(commaIndex + 1);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }

      return bytes;
    } finally {
      if (captureRenderer) {
        captureRenderer.dispose();
        captureRenderer.forceContextLoss();
      }
      restoreRendererState();
    }
  }, [
    activeTransformOverrideModelId,
    buildVolumeBounds,
    computeModelWorldBounds,
    defaultCamera,
    exportThumbnailRenderOptions,
    meshColor,
    modelWorldBounds,
    models,
    selectedTintColor,
    selectedTintStrength,
    rendererRef,
    sceneRef,
    cameraRef,
    buildVolumeBoundsOverlayRef,
    transform,
  ]);

  const includeHelpersGridDuringCapture = React.useMemo(
    () => exportThumbnailRenderOptions?.includeGrid ?? false,
    [exportThumbnailRenderOptions?.includeGrid],
  );
  const includeBuildPlateDuringCapture = React.useMemo(
    () => exportThumbnailRenderOptions?.includeBuildPlate ?? false,
    [exportThumbnailRenderOptions?.includeBuildPlate],
  );

  React.useEffect(() => {
    if (!onRegisterExportThumbnailCapture) return;
    onRegisterExportThumbnailCapture(captureExportThumbnailPng);
    return () => {
      onRegisterExportThumbnailCapture(null);
    };
  }, [captureExportThumbnailPng, onRegisterExportThumbnailCapture]);

  return {
    thumbnailCaptureActive,
    includeHelpersGridDuringCapture,
    includeBuildPlateDuringCapture,
  };
}
