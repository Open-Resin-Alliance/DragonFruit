"use client";

// Custom GizmoViewcube that works correctly in Z-up coordinate space.
// Based on the Drei GizmoViewcube source, modified so face text renders upright
// in a Z-up scene (Object3D.DEFAULT_UP = Z).
// See: https://github.com/pmndrs/drei/issues/1668#issuecomment-3339444809

import * as React from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { CanvasTexture, Vector3 } from 'three';
import { useGizmoContext } from './ZUpGizmoHelper';

type XYZ = [number, number, number];

type GenericProps = {
  font?: string;
  opacity?: number;
  color?: string;
  hoverColor?: string;
  textColor?: string;
  strokeColor?: string;
  onClick?: (e: ThreeEvent<MouseEvent>) => null;
  faces?: string[];
};

type FaceTypeProps = { hover: boolean; index: number } & GenericProps;
type EdgeCubeProps = { dimensions: XYZ; position: Vector3 } & Omit<GenericProps, 'font' & 'color'>;

const colors = { bg: '#f0f0f0', hover: '#999', text: 'black', stroke: 'black' };
const defaultFaces = ['Front', 'Back', 'Right', 'Left', 'Top', 'Bottom'];
const GIZMO_Z_ROTATION = -Math.PI / 2;
const Z_AXIS = new Vector3(0, 0, 1);
const makePositionVector = (xyz: number[]) => new Vector3(...xyz).multiplyScalar(0.38);
const rotateTweenTarget = (target: Vector3) => {
  return target.clone().applyAxisAngle(Z_AXIS, GIZMO_Z_ROTATION);
};

const corners: Vector3[] = /* @__PURE__ */ [
  [1, 1, 1],      // +X, +Y, +Z   (top-right-front)
  [1, 1, -1],     // +X, +Y, -Z   (top-right-back)
  [1, -1, 1],     // +X, -Y, +Z   (bottom-right-front)
  [1, -1, -1],    // +X, -Y, -Z   (bottom-right-back)
  [-1, 1, 1],     // -X, +Y, +Z   (top-left-front)
  [-1, 1, -1],    // -X, +Y, -Z   (top-left-back)
  [-1, -1, 1],    // -X, -Y, +Z   (bottom-left-front)
  [-1, -1, -1],   // -X, -Y, -Z   (bottom-left-back)
].map(makePositionVector);

const cornerDimensions: XYZ = [0.25, 0.25, 0.25];

const edges: Vector3[] = /* @__PURE__ */ [
  [1, 1, 0],      // +X, +Y, 0    (top-right)
  [1, 0, 1],      // +X, 0, +Z    (top-front)
  [1, 0, -1],     // +X, 0, -Z    (top-back)
  [1, -1, 0],     // +X, -Y, 0    (bottom-right)
  [0, 1, 1],      // 0, +Y, +Z    (top-center)
  [0, 1, -1],     // 0, +Y, -Z    (top-back-center)
  [0, -1, 1],     // 0, -Y, +Z    (bottom-front-center)
  [0, -1, -1],    // 0, -Y, -Z    (bottom-back-center)
  [-1, 1, 0],     // -X, +Y, 0    (top-left)
  [-1, 0, 1],     // -X, 0, +Z    (top-left-front)
  [-1, 0, -1],    // -X, 0, -Z    (top-left-back)
  [-1, -1, 0],    // -X, -Y, 0    (bottom-left)
].map(makePositionVector);

const edgeDimensions = /* @__PURE__ */ edges.map(
  (edge) => edge.toArray().map((axis: number): number => (axis === 0 ? 0.5 : 0.25)) as XYZ,
);

const FaceMaterial = ({
  hover,
  index,
  font = '20px Inter var, Arial, sans-serif',
  faces = defaultFaces,
  color = colors.bg,
  hoverColor = colors.hover,
  textColor = colors.text,
  strokeColor = colors.stroke,
  opacity = 1,
}: FaceTypeProps) => {
  const gl = useThree((state) => state.gl);
  const texture = React.useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d')!;
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = strokeColor;
    context.strokeRect(0, 0, canvas.width, canvas.height);
    context.font = font;
    context.textAlign = 'center';
    context.fillStyle = textColor;

    // Corrected rotation values for Z-up coordinate space.
    // In Y-up Drei the top/bottom faces (+Y/-Y) are indices 4/5 and need no rotation.
    // In Z-up the top/bottom faces are +Z/-Z which map to different box face indices,
    // so the rotation values below have been adjusted accordingly.
    const needsRotation = [-Math.PI / 2, Math.PI / 2, Math.PI, 0, -Math.PI / 2, -Math.PI / 2][index];
    if (needsRotation) {
      context.translate(64, 64);
      context.rotate(needsRotation);
      context.translate(-64, -64);
    }

    context.fillText(faces[index].toUpperCase(), 64, 76);
    return new CanvasTexture(canvas);
  }, [index, faces, font, color, textColor, strokeColor]);

  return (
    <meshBasicMaterial
      map={texture}
      map-anisotropy={gl.capabilities.getMaxAnisotropy() || 1}
      attach={`material-${index}`}
      color={hover ? hoverColor : 'white'}
      transparent
      opacity={opacity}
    />
  );
};

const FaceCube = (props: GenericProps) => {
  const { tweenCamera } = useGizmoContext();
  const [hover, setHover] = React.useState<number | null>(null);

  const handlePointerOut = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHover(null);
  };
  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const tweenTarget = rotateTweenTarget(e.face!.normal);
    tweenCamera(tweenTarget);
  };
  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHover(Math.floor(e.faceIndex! / 2));
  };

  return (
    <mesh onPointerOut={handlePointerOut} onPointerMove={handlePointerMove} onClick={props.onClick || handleClick}>
      {[...Array(6)].map((_, index) => (
        <FaceMaterial key={index} index={index} hover={hover === index} {...props} />
      ))}
      <boxGeometry />
    </mesh>
  );
};

const EdgeCube = ({ onClick, dimensions, position, hoverColor = colors.hover }: EdgeCubeProps): React.JSX.Element => {
  const { tweenCamera } = useGizmoContext();
  const [hover, setHover] = React.useState<boolean>(false);

  const handlePointerOut = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHover(false);
  };
  const handlePointerOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHover(true);
  };
  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const tweenTarget = rotateTweenTarget(position);
    tweenCamera(tweenTarget);
  };

  return (
    <mesh
      scale={1.01}
      position={position}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
      onClick={onClick || handleClick}
    >
      <meshBasicMaterial color={hover ? hoverColor : 'white'} transparent opacity={0.6} visible={hover} />
      <boxGeometry args={dimensions} />
    </mesh>
  );
};

export const ZUpGizmoViewcube = (props: GenericProps) => {
  return (
    // Rotate the rendered cube and tween targets together so the widget matches
    // DragonFruit's Z-up, X-right, Y-back coordinate convention.
    <group scale={[60, 60, 60]} rotation={[0, 0, GIZMO_Z_ROTATION]}>
      <FaceCube {...props} />
      {edges.map((edge, index) => (
        <EdgeCube key={index} position={edge} dimensions={edgeDimensions[index]} {...props} />
      ))}
      {corners.map((corner, index) => (
        <EdgeCube key={index} position={corner} dimensions={cornerDimensions} {...props} />
      ))}
    </group>
  );
};
