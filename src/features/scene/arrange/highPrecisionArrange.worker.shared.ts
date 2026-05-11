import type { EulerOrder } from 'three';

export type SerializedVector3 = [number, number, number];
export type SerializedEuler = [number, number, number, EulerOrder];

export type SerializedArrangeTransform = {
  position: SerializedVector3;
  rotation: SerializedEuler;
  scale: SerializedVector3;
};

export type SerializedArrangeModel = {
  id: string;
  visible: boolean;
  transform: SerializedArrangeTransform;
  geometry: {
    center: SerializedVector3;
    uuid: string;
    positions: Float32Array;
    supportLocalPoints?: Float32Array;
    supportHullKey?: string;
  };
};

export type SerializedArrangeUpdate = {
  id: string;
  transform: SerializedArrangeTransform;
};

export type SerializedHighPrecisionArrangeResult = {
  updates: SerializedArrangeUpdate[];
  packedIds: string[];
  spilledIds: string[];
};

export type HighPrecisionArrangeWorkerInput = {
  visibleModels: SerializedArrangeModel[];
  sceneModels: SerializedArrangeModel[];
  widthMm: number;
  depthMm: number;
  originMode: 'front_left' | 'center';
  arrangeSpacingMm: number;
  arrangeAllowRotateOnZ: boolean;
  arrangeAnchorMode: 'center' | 'front_left' | 'front_right' | 'back_left' | 'back_right';
  safetyMarginMm?: { front: number; back: number; left: number; right: number };
};

export type HighPrecisionArrangeWorkerRequest = {
  type: 'compute';
  requestId: number;
  input: HighPrecisionArrangeWorkerInput;
};

export type HighPrecisionArrangeWorkerResult = {
  type: 'result';
  requestId: number;
  result: SerializedHighPrecisionArrangeResult;
};

export type HighPrecisionArrangeWorkerError = {
  type: 'error';
  requestId: number;
  error: string;
};

export type HighPrecisionArrangeWorkerMessage = HighPrecisionArrangeWorkerResult | HighPrecisionArrangeWorkerError;
