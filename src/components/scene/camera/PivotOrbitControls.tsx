"use client";
import React from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { PivotOrbitControls as PivotOrbitControlsImpl } from './orbitControlsPivot';

/**
 * React Three Fiber binding for `PivotOrbitControls`.
 *
 * Mirrors drei's wrapper — the same props, the same `makeDefault` handshake with
 * the store, the same `start`/`change`/`end` wiring — because the app's other
 * camera code (`CameraProjectionController`, `HorizonLock`, the focus and home
 * controllers) reads `useThree().controls`. The only difference is the class
 * underneath, which can hold its target on a chosen pixel.
 */
/** The controls instance the wrapper exposes through its ref. */
export type PivotOrbitControlsHandle = PivotOrbitControlsImpl;

export type PivotOrbitControlsProps = {
  makeDefault?: boolean;
  camera?: THREE.Camera;
  domElement?: HTMLElement;
  target?: [number, number, number];
  enabled?: boolean;
  enableDamping?: boolean;
  dampingFactor?: number;
  rotateSpeed?: number;
  panSpeed?: number;
  zoomSpeed?: number;
  screenSpacePanning?: boolean;
  zoomToCursor?: boolean;
  enablePan?: boolean;
  enableZoom?: boolean;
  mouseButtons?: {
    LEFT?: THREE.MOUSE;
    MIDDLE?: THREE.MOUSE;
    RIGHT?: THREE.MOUSE;
  };
  onStart?: (event: unknown) => void;
  onChange?: (event: unknown) => void;
  onEnd?: (event: unknown) => void;
};

export const PivotOrbitControls = React.forwardRef<PivotOrbitControlsImpl, PivotOrbitControlsProps>(
  function PivotOrbitControls(
    {
      makeDefault,
      camera,
      domElement,
      target,
      enabled = true,
      enableDamping = true,
      dampingFactor,
      rotateSpeed,
      panSpeed,
      zoomSpeed,
      screenSpacePanning,
      zoomToCursor,
      enablePan,
      enableZoom,
      mouseButtons,
      onStart,
      onChange,
      onEnd,
    },
    ref,
  ) {
    const defaultCamera = useThree((state) => state.camera);
    const gl = useThree((state) => state.gl);
    const events = useThree((state) => state.events);
    const set = useThree((state) => state.set);
    const get = useThree((state) => state.get);

    const explicitCamera = camera ?? defaultCamera;
    const explicitDomElement = domElement ?? events.connected ?? gl.domElement;

    const controls = React.useMemo(
      () => new PivotOrbitControlsImpl(explicitCamera),
      [explicitCamera],
    );

    useFrame(() => {
      if (controls.enabled) controls.update();
    }, -1);

    React.useEffect(() => {
      controls.connect(explicitDomElement);
      return () => {
        controls.dispose();
      };
    }, [controls, explicitDomElement]);

    // r3f applies these onto the controls object; `target` is an array of numbers
    // and lands through `Vector3.fromArray`, so the vector identity the rest of
    // the app holds survives.
    const forwarded: Record<string, unknown> = {
      enabled,
      enableDamping,
    };
    if (dampingFactor !== undefined) forwarded.dampingFactor = dampingFactor;
    if (rotateSpeed !== undefined) forwarded.rotateSpeed = rotateSpeed;
    if (panSpeed !== undefined) forwarded.panSpeed = panSpeed;
    if (zoomSpeed !== undefined) forwarded.zoomSpeed = zoomSpeed;
    if (screenSpacePanning !== undefined) forwarded.screenSpacePanning = screenSpacePanning;
    if (zoomToCursor !== undefined) forwarded.zoomToCursor = zoomToCursor;
    if (enablePan !== undefined) forwarded.enablePan = enablePan;
    if (enableZoom !== undefined) forwarded.enableZoom = enableZoom;
    if (mouseButtons) forwarded.mouseButtons = mouseButtons;
    if (target) forwarded.target = target;

    React.useEffect(() => {
      const onStartEvent = (event: unknown) => onStart?.(event);
      const onChangeEvent = (event: unknown) => onChange?.(event);
      const onEndEvent = (event: unknown) => onEnd?.(event);
      controls.addEventListener('start', onStartEvent);
      controls.addEventListener('change', onChangeEvent);
      controls.addEventListener('end', onEndEvent);
      return () => {
        controls.removeEventListener('start', onStartEvent);
        controls.removeEventListener('change', onChangeEvent);
        controls.removeEventListener('end', onEndEvent);
      };
    }, [controls, onChange, onEnd, onStart]);

    React.useEffect(() => {
      if (!makeDefault) return;
      const previous = get().controls;
      set({ controls } as never);
      return () => set({ controls: previous } as never);
    }, [controls, get, makeDefault, set]);

    React.useImperativeHandle(ref, () => controls, [controls]);

    return <primitive object={controls} ref={ref} {...forwarded} />;
  },
);
