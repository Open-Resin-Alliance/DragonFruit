"use client";

import React from 'react';
import ReactDOM from 'react-dom';
import * as THREE from 'three';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, TransformControls } from '@react-three/drei';
import { RaftPreview } from './PreviewTypes/Raft/RaftPreview';
import { GridPreview } from './PreviewTypes/Grid/GridPreview';
import { TrunkPreview } from './PreviewTypes/Trunk/TrunkPreview';
import { subscribeToSettings, getSettingsSnapshot } from '../state';
import { subscribeToAnatomyPreviewState, getAnatomyPreviewState, setAnatomyPreviewActiveSettingKey } from './previewState';
import { ANATOMY_CONFIG } from './AnatomyPreviewConfig';
import { getTargetFocusState } from './AnatomyPreviewCameraLogic';
import type { SupportKind } from '../supportKindState';
import { getSupportKindSnapshot, subscribeToSupportKindState } from '../supportKindState';
import { getRaftSettings, subscribeToRaftStore } from '../../Rafts/Crenelated/RaftState';
import { resolveConeAxisPolicy } from '@/supports/PlacementLogic/ConeAxisPolicy';
import { calculateDiskThickness } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import type { SupportTipProfile } from '@/supports/SupportPrimitives/ContactCone/types';
import { NumberInput } from '@/components/ui/NumberInput';

// Define the shape of our captured config
interface CapturedConfig {
    camera: {
        position: [number, number, number];
        target: [number, number, number];
        zoom: number;
    };
    support: {
        previewHeightMm: number;
        coneAngleDeg: number;
        tipContactDiameterMm: number;
        tipLengthMm: number;
        // Roots
        rootsDiameterMm: number;
        rootsDiskHeightMm: number;
        rootsConeHeightMm: number;
        jointCount: number;
    };
}

// Helper to watch scene and report values
function SceneMonitor({
    supportGroupRef,
    orbitRef,
    onUpdate
}: {
    supportGroupRef: React.RefObject<THREE.Group | null>;
    orbitRef: React.RefObject<any>;
    onUpdate: (data: CapturedConfig) => void;
}) {
    const { camera } = useThree();
    const lastUpdate = React.useRef(0);

    useFrame(() => {
        const now = performance.now();
        if (now - lastUpdate.current < 200) return; // Throttle to 5fps
        lastUpdate.current = now;

        const target = orbitRef.current?.target ?? new THREE.Vector3(0, 0, 0);
        const round = (n: number) => Math.round(n * 100) / 100;

        // Note: support values are populated by PreviewContent merging logic
        // We pass placeholder 0s here, they get safely overwritten by setDebugData in PreviewContent
        onUpdate({
            camera: {
                position: [round(camera.position.x), round(camera.position.y), round(camera.position.z)],
                target: [round(target.x), round(target.y), round(target.z)],
                zoom: round(camera.zoom),
            },
            support: {
                previewHeightMm: 0,
                coneAngleDeg: 0,
                tipContactDiameterMm: 0,
                tipLengthMm: 0,
                rootsDiameterMm: 0,
                rootsDiskHeightMm: 0,
                rootsConeHeightMm: 0,
                jointCount: 0
            }
        });
    });
    return null;
}

// Helper Input Component with Slider
function TunerControl({
    value,
    onChange,
    label,
    min = -100,
    max = 100,
    step = 1,
    disabled = false,
    onFocus,
    onBlur
}: {
    value: number;
    onChange: (val: number) => void;
    label?: string;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    onFocus?: () => void;
    onBlur?: () => void;
}) {
    const [localVal, setLocalVal] = React.useState(value.toString());
    const [focused, setFocused] = React.useState(false);

    // Sync from prop when not focused
    React.useEffect(() => {
        if (!focused) setLocalVal(value.toString());
    }, [value, focused]);

    const commit = (valStr: string) => {
        const num = parseFloat(valStr);
        if (!isNaN(num)) onChange(num);
        else setLocalVal(value.toString());
    };

    const numericLocalValue = React.useMemo(() => {
        const parsed = parseFloat(localVal);
        return Number.isFinite(parsed) ? parsed : value;
    }, [localVal, value]);

    return (
        <div className={`flex items-center gap-2 text-xs ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
            {label && <span className="opacity-70 w-16 text-right whitespace-nowrap flex-shrink-0">{label}:</span>}

            {/* Slider */}
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={localVal}
                onChange={(e) => {
                    if (disabled) return;
                    const v = e.target.value;
                    setLocalVal(v);
                    commit(v);
                }}
                disabled={disabled}
                onFocus={() => {
                    setFocused(true);
                    if (onFocus) onFocus();
                }}
                onBlur={() => {
                    setFocused(false);
                    if (onBlur) onBlur();
                }}
                className="flex-grow h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer range-sm opacity-80 hover:opacity-100 disabled:cursor-not-allowed"
            />

            {/* Number Input */}
            <NumberInput
                step={step}
                min={min}
                max={max}
                className="bg-gray-800 border border-gray-600 rounded pl-1.5 pr-5 w-14 text-right flex-shrink-0 focus:border-blue-400 focus:outline-none disabled:bg-gray-900 disabled:text-gray-500"
                value={numericLocalValue}
                onChange={(next) => {
                    const nextStr = String(next);
                    setLocalVal(nextStr);
                    commit(nextStr); // Commit immediately for live updates
                }}
                onFocus={() => {
                    setFocused(true);
                    if (onFocus) onFocus();
                }}
                onBlur={() => {
                    setFocused(false);
                    commit(localVal);
                    if (onBlur) onBlur();
                }}
                disabled={disabled}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        (e.target as HTMLInputElement).blur();
                    }
                }}
            />
        </div>
    );
}

// Overlay to display or edit the info
function DebugOverlay({
    data,
    onApply,
    autoCameraEnabled,
    onSetAutoCameraEnabled,
    activeKind
}: {
    data: CapturedConfig | null;
    onApply: (updates: Partial<CapturedConfig['camera'] | CapturedConfig['support']>, category: 'camera' | 'support') => void;
    autoCameraEnabled: boolean;
    onSetAutoCameraEnabled: (enabled: boolean) => void;
    activeKind: SupportKind;
}) {
    if (!data) return null;
    if (typeof document === 'undefined') return null;

    const copyToClipboard = () => {
        const text = `
    // PASTE THIS INTO AnatomyPreviewConfig.ts

    camera: {
        type: '${ANATOMY_CONFIG.camera.type}',
        fov: ${ANATOMY_CONFIG.camera.fov},
        framingPadding: ${ANATOMY_CONFIG.camera.framingPadding},
        orthographicZoom: ${data.camera.zoom},
        initialPosition: [${data.camera.position[0].toFixed(2)}, ${data.camera.position[1].toFixed(2)}, ${data.camera.position[2].toFixed(2)}], 
        initialTarget: [${data.camera.target[0].toFixed(2)}, ${data.camera.target[1].toFixed(2)}, ${data.camera.target[2].toFixed(2)}],
        upVector: [0, 0, 1],
        enableInteraction: ${ANATOMY_CONFIG.camera.enableInteraction},
    },
        `;
        navigator.clipboard.writeText(text);
        alert("Config copied to clipboard!");
    };

    const resetToHome = () => {
        const home = getTargetFocusState(activeKind, null);
        onApply({
            position: home.position,
            target: home.target,
            zoom: home.zoom
        }, 'camera');
    };

    // Use Portal to move this OUT of the small card and into main view
    return ReactDOM.createPortal(
        <div className="fixed top-24 left-[380px] bg-black/90 text-white p-4 rounded shadow-2xl border border-white/20 font-mono text-sm z-[9999] w-[400px] pointer-events-auto">
            <div className="font-bold mb-3 text-orange-400 border-b border-orange-400/30 pb-1 flex justify-between items-center">
                <span>PREVIEW TUNER</span>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => onSetAutoCameraEnabled(!autoCameraEnabled)}
                        className="text-[10px] bg-gray-700 hover:bg-gray-600 px-2 py-0.5 rounded text-gray-200 transition-colors"
                    >
                        Auto Camera: {autoCameraEnabled ? 'On' : 'Off'}
                    </button>
                    <button
                        onClick={resetToHome}
                        className="text-[10px] bg-gray-700 hover:bg-gray-600 px-2 py-0.5 rounded text-gray-200 transition-colors"
                    >
                        Reset to Home
                    </button>
                </div>
            </div>

            <div className="mb-4 space-y-3">
                <div className="space-y-1">
                    <div className="text-[10px] uppercase font-bold text-blue-400/80 mb-0.5">Camera</div>
                    <TunerControl label="Zoom" value={data.camera.zoom} onChange={(v) => onApply({ zoom: v }, 'camera')} min={1} max={100} step={0.5} />
                    <TunerControl label="Pos X" value={data.camera.position[0]} onChange={(v) => onApply({ position: [v, data.camera.position[1], data.camera.position[2]] }, 'camera')} min={-100} max={100} />
                    <TunerControl label="Pos Y" value={data.camera.position[1]} onChange={(v) => onApply({ position: [data.camera.position[0], v, data.camera.position[2]] }, 'camera')} min={-100} max={100} />
                    {/* Fixed Z at 10 */}
                    <TunerControl label="Pos Z" value={data.camera.position[2]} onChange={(v) => onApply({ position: [data.camera.position[0], data.camera.position[1], v] }, 'camera')} min={-100} max={100} />
                </div>

                <div className="space-y-1 pt-1 opacity-80 border-t border-white/5 mt-1">
                    <div className="text-[10px] uppercase font-bold text-blue-300/80 mb-0.5">Target (Right-Click Pan)</div>
                    <TunerControl label="Targ X" value={data.camera.target[0]} onChange={(v) => onApply({ target: [v, data.camera.target[1], data.camera.target[2]] }, 'camera')} min={-50} max={50} />
                    <TunerControl label="Targ Y" value={data.camera.target[1]} onChange={(v) => onApply({ target: [data.camera.target[0], v, data.camera.target[2]] }, 'camera')} min={-50} max={50} />
                    <TunerControl label="Targ Z" value={data.camera.target[2]} onChange={(v) => onApply({ target: [data.camera.target[0], data.camera.target[1], v] }, 'camera')} min={-20} max={50} />
                </div>
            </div>

            <button
                onClick={copyToClipboard}
                className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 px-3 rounded w-full transition-colors mb-2"
            >
                Copy Config Value
            </button>

            <div className="text-[10px] text-gray-400 text-center border-t border-gray-700 pt-2">
                Type, Slide, or Drag 3D Gizmos.
            </div>
        </div>,
        document.body
    );
}

// Internal component to handle camera framing and support rendering
function PreviewContent({
    setDebugData,
    manualOverride,
    autoCameraEnabled
}: {
    setDebugData?: (d: CapturedConfig) => void;
    manualOverride?: { data: Partial<CapturedConfig>; category: 'camera' | 'support'; timestamp: number } | null;
    autoCameraEnabled: boolean;
}) {
    const { camera } = useThree();
    const settings = React.useSyncExternalStore(subscribeToSettings, getSettingsSnapshot, getSettingsSnapshot);
    const previewState = React.useSyncExternalStore(subscribeToAnatomyPreviewState, getAnatomyPreviewState, getAnatomyPreviewState);
    const supportKindState = React.useSyncExternalStore(subscribeToSupportKindState, getSupportKindSnapshot, getSupportKindSnapshot);
    const activeKind = supportKindState.kind;
    const raftSettings = React.useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);
    const orbitRef = React.useRef<any>(null);
    const isUserInteractingRef = React.useRef(false);

    // Maintain live config state for the support parameters
    const [liveConfig, setLiveConfig] = React.useState({
        previewHeightMm: ANATOMY_CONFIG.support.previewHeightMm,
        coneAngleDeg: ANATOMY_CONFIG.support.coneAngleDeg,
        tipContactDiameterMm: settings.tip.contactDiameterMm,
        tipLengthMm: settings.tip.lengthMm,
        rootsDiameterMm: settings.roots.diameterMm,
        rootsDiskHeightMm: settings.roots.diskHeightMm,
        rootsConeHeightMm: settings.roots.coneHeightMm,
        jointCount: settings.joint.defaultJointCount,
        shaftDiameterMm: settings.shaft.diameterMm,
    });

    // ANIMATION ENGINE
    const lastActiveKey = React.useRef<string | null>(null);

    // Sync global settings to liveConfig for Roots
    // This allows sidebar changes to update the preview while preserving the structure for the Tuner
    // Sync global settings to liveConfig for Roots
    // This allows sidebar changes to update the preview while preserving the structure for the Tuner
    React.useEffect(() => {
        let tipContact = settings.tip.contactDiameterMm;
        let tipLength = settings.tip.lengthMm;
        let shaftDiameter = settings.shaft.diameterMm;

        // Apply Overrides if hovering a preset
        if (previewState.activeSettingValue !== null) {
            if (previewState.activeSettingKey === 'tip.contactDiameterMm') tipContact = previewState.activeSettingValue;
            if (previewState.activeSettingKey === 'tip.lengthMm') tipLength = previewState.activeSettingValue;
            if (previewState.activeSettingKey === 'shaft.diameterMm') shaftDiameter = previewState.activeSettingValue;
        }

        setLiveConfig(prev => ({
            ...prev,
            rootsDiameterMm: settings.roots.diameterMm,
            rootsDiskHeightMm: settings.roots.diskHeightMm,
            rootsConeHeightMm: settings.roots.coneHeightMm,
            jointCount: settings.joint.defaultJointCount,
            tipContactDiameterMm: tipContact,
            tipLengthMm: tipLength,
            shaftDiameterMm: shaftDiameter,
        }));
    }, [
        settings.roots.diameterMm,
        settings.roots.diskHeightMm,
        settings.roots.coneHeightMm,
        settings.joint.defaultJointCount,
        settings.tip.contactDiameterMm,
        settings.tip.lengthMm,
        settings.shaft.diameterMm,
        previewState.activeSettingKey,
        previewState.activeSettingValue
    ]);

    // Maintain a REF to liveConfig for useFrame to avoid stale closures
    const liveConfigRef = React.useRef(liveConfig);
    React.useLayoutEffect(() => {
        liveConfigRef.current = liveConfig;
    });

    const [isAnimating, setIsAnimating] = React.useState(false);

    // Trigger animation when the focused setting row changes
    React.useEffect(() => {
        if (previewState.activeSettingKey !== lastActiveKey.current) {
            lastActiveKey.current = previewState.activeSettingKey;
            if (!isUserInteractingRef.current && autoCameraEnabled) {
                setIsAnimating(true);
            } else {
                setIsAnimating(false);
            }
        }
    }, [previewState.activeSettingKey]);

    React.useEffect(() => {
        if (!autoCameraEnabled) return;
        if (isUserInteractingRef.current) return;
        setIsAnimating(true);
    }, [autoCameraEnabled]);

    // Handle Manual Overrides from Debug UI
    React.useEffect(() => {
        if (!manualOverride) return;

        // Any manual override from sliders should stop the auto-animator
        setIsAnimating(false);

        // Camera Updates
        if (manualOverride.category === 'camera' && manualOverride.data.camera) {
            const c = manualOverride.data.camera;
            if (c.zoom !== undefined) camera.zoom = c.zoom;

            // Force Z=10 when applying position updates
            if (c.position !== undefined) {
                camera.position.set(c.position[0], c.position[1], c.position[2]);
            }

            if (c.target !== undefined && orbitRef.current) {
                orbitRef.current.target.set(c.target[0], c.target[1], c.target[2]);
                orbitRef.current.update();
            }

            camera.updateProjectionMatrix();
        }

        // Support Updates
        if (manualOverride.category === 'support' && manualOverride.data.support) {
            const s = manualOverride.data.support;
            setLiveConfig(prev => ({
                previewHeightMm: s.previewHeightMm ?? prev.previewHeightMm,
                coneAngleDeg: s.coneAngleDeg ?? prev.coneAngleDeg,
                rootsDiameterMm: s.rootsDiameterMm ?? prev.rootsDiameterMm,
                rootsDiskHeightMm: s.rootsDiskHeightMm ?? prev.rootsDiskHeightMm,
                rootsConeHeightMm: s.rootsConeHeightMm ?? prev.rootsConeHeightMm,
                jointCount: s.jointCount ?? prev.jointCount,
                tipContactDiameterMm: s.tipContactDiameterMm ?? prev.tipContactDiameterMm,
                tipLengthMm: s.tipLengthMm ?? prev.tipLengthMm,
                shaftDiameterMm: prev.shaftDiameterMm,
            }));
        }
    }, [manualOverride, camera]);

    // Reactivity Hook: If Tip Contact Diameter changes while focused, ensure we animate the zoom
    // Reactivity Hook: If Tip Focus settings change while focused, ensure we animate
    React.useEffect(() => {
        if (!autoCameraEnabled) return;
        if (previewState.activeSettingKey === 'tip.contactDiameterMm' || previewState.activeSettingKey === 'tip.lengthMm') {
            setIsAnimating(true);
        }
    }, [liveConfig.tipContactDiameterMm, liveConfig.tipLengthMm, previewState.activeSettingKey]);

    // Interpolation Loop
    useFrame((state, delta) => {
        if (!autoCameraEnabled) return;
        if (!isAnimating) return;

        // If user starts dragging/orbiting, stop the auto-animator
        if (isUserInteractingRef.current) {
            setIsAnimating(false);
            return;
        }

        const focusKey = previewState.activeSettingKey;
        const targetFocus = getTargetFocusState(activeKind, focusKey);

        // --- Dynamic Zoom Logic for Tip Contact Diameter Only ---
        const isContactDiameterFocus = previewState.activeSettingKey === 'tip.contactDiameterMm';
        const isStickLikeKind = activeKind === 'stick' || activeKind === 'twig';

        // Strict scope: ONLY 'tip.contactDiameterMm' triggers dynamic zoom
        // Previously we checked startsWith('tip.'), which caused snapback on other tip settings

        let finalZoom = targetFocus.zoom;

        let finalPosition = [...targetFocus.position] as [number, number, number];

        if (isContactDiameterFocus) {
            // Use REF to ensure fresh value inside frame loop
            const diam = liveConfigRef.current.tipContactDiameterMm;
            const minDia = 0.12;
            const maxDia = 1.0;
            const maxZoom = isStickLikeKind ? 38 : 140; // Zoom for small diameter
            const minZoom = isStickLikeKind ? 24 : 35;  // Zoom for large diameter

            if (diam <= minDia) {
                finalZoom = maxZoom;
            } else if (diam >= maxDia) {
                finalZoom = minZoom;
            } else {
                // Linear Interpolation
                // t = 0 at minDia, t = 1 at maxDia
                const t = (diam - minDia) / (maxDia - minDia);
                // Lerp between maxZoom (at t=0) and minZoom (at t=1)
                finalZoom = maxZoom + t * (minZoom - maxZoom);
            }

            if (!isStickLikeKind) {
                const internalAngle = Math.abs(liveConfigRef.current.coneAngleDeg);
                const angleRad = THREE.MathUtils.degToRad(internalAngle);

                const nx = Math.cos(angleRad);
                const nz = Math.sin(angleRad);

                const tipNormal = { x: -nx, y: 0, z: -nz };

                const tipProfile: SupportTipProfile = {
                    type: 'disk',
                    contactDiameterMm: liveConfigRef.current.tipContactDiameterMm,
                    bodyDiameterMm: settings.shaft.diameterMm,
                    lengthMm: liveConfigRef.current.tipLengthMm,
                    penetrationMm: settings.tip.penetrationMm,
                    diskThicknessMm: settings.tip.diskThicknessMm ?? 0.1,
                    maxStandoffMm: settings.tip.maxStandoffMm ?? 1.5,
                    standoffAngleThreshold: settings.tip.standoffAngleThreshold ?? (Math.PI / 4),
                };

                const coneAngleMode = settings.tip.coneAngleMode ?? 'normal';
                const adaptiveConeAngleOffsetDeg = settings.tip.adaptiveConeAngleOffsetDeg ?? 30;

                const { coneAxis } = resolveConeAxisPolicy({
                    surfaceNormal: tipNormal,
                    coneAngleMode,
                    adaptiveConeAngleOffsetDeg,
                });

                const diskThickness = calculateDiskThickness(tipNormal, coneAxis, tipProfile);
                const tipX = -(tipNormal.x * diskThickness + coneAxis.x * tipProfile.lengthMm);
                const dx = tipX - targetFocus.target[0];

                finalPosition[0] = targetFocus.position[0] + dx;
            }
        }

        // --- Dynamic Zoom/Target Logic for Tip Length/Angle ---
        const isConeLengthFocus = previewState.activeSettingKey === 'tip.lengthMm';

        // We clone here because we might modify it
        let finalTarget = [...targetFocus.target] as [number, number, number];

        if (isContactDiameterFocus && !isStickLikeKind) {
            const dx = finalPosition[0] - targetFocus.position[0];
            finalTarget[0] = targetFocus.target[0] + dx;
        }

        if (isConeLengthFocus) {
            const len = liveConfigRef.current.tipLengthMm;
            const minLen = 1.0;
            const maxLen = 4.0;

            // Zoom Logic
            const minZoom = 58; // at 1mm
            const maxZoom = 24; // at 4mm

            // Target X Logic
            const minTargX = 0.53; // default
            const maxTargX = 1.0;

            if (len <= minLen) {
                finalZoom = minZoom;
                finalTarget[0] = minTargX;
            } else if (len >= maxLen) {
                finalZoom = maxZoom;
                finalTarget[0] = maxTargX;
            } else {
                const t = (len - minLen) / (maxLen - minLen);
                finalZoom = minZoom + t * (maxZoom - minZoom);
                finalTarget[0] = minTargX + t * (maxTargX - minTargX);
            }
        }

        const eps = 0.005;
        const damping = 8;
        const lerpFactor = 1 - Math.exp(-damping * delta);

        let posFinished = true;
        let targFinished = true;
        let zoomFinished = true;

        // 1. Animate Position
        const targetPos = new THREE.Vector3(...finalPosition);
        if (camera.position.distanceTo(targetPos) > eps) {
            camera.position.lerp(targetPos, lerpFactor);
            posFinished = false;
        }

        // 2. Animate Target
        const targetTarg = new THREE.Vector3(...finalTarget);
        if (orbitRef.current) {
            if (orbitRef.current.target.distanceTo(targetTarg) > eps) {
                orbitRef.current.target.lerp(targetTarg, lerpFactor);
                orbitRef.current.update();
                targFinished = false;
            }
        }

        // 3. Animate Zoom
        if (Math.abs(camera.zoom - finalZoom) > eps) {
            camera.zoom = THREE.MathUtils.lerp(camera.zoom, finalZoom, lerpFactor);
            camera.updateProjectionMatrix();
            zoomFinished = false;
        }

        // Once all values are settled, stop the frame loop
        if (posFinished && targFinished && zoomFinished) {
            // Explicit Snap to target values to prevent residual floating point jitter
            camera.position.set(...finalPosition);
            if (orbitRef.current) orbitRef.current.target.set(...finalTarget);
            camera.zoom = finalZoom;
            camera.updateProjectionMatrix();

            setIsAnimating(false);
        }
    });

    // Report config back to debug overlay
    React.useLayoutEffect(() => {
        if (setDebugData) {
            // We need to merge Camera State (from SceneMonitor interval) with Support State (from React State)
            // But we can't easily merge async streams here.
            // Simplified approach: SceneMonitor handles Camera, and we update 'support' prop in the Parent DebugData?
            // Actually, we can just trigger an update here.

            // Wait, SceneMonitor loops every 200ms.
            // Ideally we patch the support part.
        }
    }, [liveConfig, setDebugData]);



    const groupRef = React.useRef<THREE.Group>(null);

    // Auto-frame (Only once)
    const hasFramed = React.useRef(false);
    const lastFramedKindRef = React.useRef<string | null>(null);

    React.useLayoutEffect(() => {
        if (lastFramedKindRef.current !== activeKind) {
            hasFramed.current = false;
            lastFramedKindRef.current = activeKind;
        }
    }, [activeKind]);
    React.useLayoutEffect(() => {
        if (groupRef.current && !hasFramed.current) {
            const home = getTargetFocusState(activeKind, null);

            camera.position.set(home.position[0], home.position[1], home.position[2]);

            if (orbitRef.current) {
                orbitRef.current.target.set(home.target[0], home.target[1], home.target[2]);
                orbitRef.current.update();
            } else {
                camera.lookAt(new THREE.Vector3(...home.target));
            }

            if (ANATOMY_CONFIG.camera.type === 'orthographic') {
                camera.zoom = home.zoom;
            }

            camera.updateProjectionMatrix();
            hasFramed.current = true;
        }
    }, [activeKind, camera]);

    const showPreviewTuner = previewState.showTuner;

    // --- Anatomy Highlight Logic ---
    const HIGHLIGHT_COLOR = ANATOMY_CONFIG.colors.highlight;
    const DIM_COLOR = ANATOMY_CONFIG.colors.dim;
    const NORMAL_COLOR = ANATOMY_CONFIG.colors.normal;

    const anatomyOverrides = React.useMemo(() => {
        const key = previewState.activeSettingKey;
        if (!key) return undefined; // No highlight, usage default orange

        // Default state: everything dimmed
        const overrides: any = {
            roots: DIM_COLOR, // Fallback for unspecified parts
            rootsDisk: DIM_COLOR,
            rootsCone: DIM_COLOR,
            shaft: DIM_COLOR,
            joint: DIM_COLOR,
            tipBody: DIM_COLOR,
            tipDisk: DIM_COLOR,
        };

        // Activate specific parts based on key prefix/match
        if (key.startsWith('tip.contact')) {
            // "tip.contactDiameterMm", "tip.contactDepthMm"
            overrides.tipDisk = HIGHLIGHT_COLOR;
        } else if (key.startsWith('tip.') || key === 'tip.coneAngleDeg' || key === 'tip.coneAngleMode') {
            // "tip.lengthMm", "tip.bodyDiameterMm", etc.
            overrides.tipBody = HIGHLIGHT_COLOR;

        } else if (key === 'roots.diskHeightMm' || key === 'roots.diameterMm') {
            // Roots Disk Focus
            overrides.rootsDisk = HIGHLIGHT_COLOR;
            overrides.rootsCone = DIM_COLOR;

        } else if (key === 'roots.coneHeightMm' || key.startsWith('baseFlare.')) {
            // Roots Cone Focus
            overrides.rootsCone = HIGHLIGHT_COLOR;
            overrides.rootsDisk = DIM_COLOR;

        } else if (key.startsWith('roots.')) {
            // Generic roots setting (fallback)
            overrides.roots = HIGHLIGHT_COLOR;
            overrides.rootsDisk = HIGHLIGHT_COLOR;
            overrides.rootsCone = HIGHLIGHT_COLOR;

        } else if (key.startsWith('shaft.') || key.startsWith('trunk.') || key.startsWith('joint.')) {
            overrides.shaft = HIGHLIGHT_COLOR;
            overrides.joint = HIGHLIGHT_COLOR;
        }

        return overrides;
    }, [previewState.activeSettingKey]);



    // Pass support config up to parent for the Overlay
    React.useEffect(() => {
        if (setDebugData) {
            // ...
        }
    }, [liveConfig]);

    return (
        <>
            {/* Monitor scene for Debug UI - Pass live config to it so it reports correctly */}
            {showPreviewTuner && setDebugData && (
                <SceneMonitor
                    supportGroupRef={groupRef}
                    orbitRef={orbitRef}
                    onUpdate={(d) => {
                        // Merge Scene Camera Data with Live Support Data
                        setDebugData({
                            camera: d.camera,
                            support: {
                                previewHeightMm: liveConfig.previewHeightMm,
                                coneAngleDeg: liveConfig.coneAngleDeg,
                                rootsDiameterMm: liveConfig.rootsDiameterMm,
                                rootsDiskHeightMm: liveConfig.rootsDiskHeightMm,
                                rootsConeHeightMm: liveConfig.rootsConeHeightMm,
                                jointCount: liveConfig.jointCount,
                                tipContactDiameterMm: liveConfig.tipContactDiameterMm,
                                tipLengthMm: liveConfig.tipLengthMm,
                            }
                        });
                    }}
                />
            )}

            <ambientLight intensity={ANATOMY_CONFIG.lighting.ambientIntensity} />
            <directionalLight
                position={ANATOMY_CONFIG.lighting.keyLight.position as [number, number, number]}
                intensity={ANATOMY_CONFIG.lighting.keyLight.intensity}
            />
            <directionalLight
                position={ANATOMY_CONFIG.lighting.fillLight.position as [number, number, number]}
                intensity={ANATOMY_CONFIG.lighting.fillLight.intensity}
            />

            {activeKind === 'raft' && (
                <directionalLight
                    position={[0, 0, -20]}
                    intensity={0.8}
                    color={'#93c5fd'}
                />
            )}

            <group ref={groupRef}>
                {activeKind === 'raft' && (
                    <RaftPreview
                        settings={settings}
                        liveConfig={liveConfig}
                        activeKind={activeKind}
                        raftSettings={raftSettings}
                        previewState={previewState}
                    />
                )}

                {activeKind === 'grid' && (
                    <GridPreview
                        settings={settings}
                        liveConfig={liveConfig}
                        activeKind={activeKind}
                        previewState={previewState}
                        anatomyOverrides={anatomyOverrides}
                    />
                )}

                {activeKind !== 'raft' && activeKind !== 'grid' && (
                    <TrunkPreview
                        settings={settings}
                        liveConfig={liveConfig}
                        activeKind={activeKind}
                        previewState={previewState}
                        anatomyOverrides={anatomyOverrides}
                    />
                )}
            </group>

            {ANATOMY_CONFIG.camera.enableInteraction && (
                <OrbitControls
                    ref={orbitRef}
                    makeDefault
                    enableDamping={false}
                    enableZoom={true}
                    enablePan={true}
                    onStart={() => {
                        isUserInteractingRef.current = true;
                        setIsAnimating(false);
                    }}
                    onEnd={() => {
                        isUserInteractingRef.current = false;
                    }}
                />
            )}
        </>
    );
}

export function SupportAnatomyPreviewCanvas() {
    const [debugData, setDebugData] = React.useState<CapturedConfig | null>(null);
    const [manualOverride, setManualOverride] = React.useState<{ data: Partial<CapturedConfig>; category: 'camera' | 'support'; timestamp: number } | null>(null);
    const [autoCameraEnabled, setAutoCameraEnabled] = React.useState(true);
    const previewState = React.useSyncExternalStore(subscribeToAnatomyPreviewState, getAnatomyPreviewState, getAnatomyPreviewState);
    const showPreviewTuner = previewState.showTuner;

    const supportKindState = React.useSyncExternalStore(subscribeToSupportKindState, getSupportKindSnapshot, getSupportKindSnapshot);
    const activeKind = supportKindState.kind;

    const handleApply = (updates: any, category: 'camera' | 'support') => {
        if (category === 'camera') {
            setAutoCameraEnabled(false);
        }
        const data = category === 'camera' ? { camera: updates } : { support: updates };
        setManualOverride({ data, category, timestamp: Date.now() });
    };

    return (
        <div className="w-full h-full relative" style={{ minHeight: '300px' }}>
            {showPreviewTuner && (
                <DebugOverlay
                    data={debugData}
                    onApply={handleApply}
                    autoCameraEnabled={autoCameraEnabled}
                    onSetAutoCameraEnabled={setAutoCameraEnabled}
                    activeKind={activeKind}
                />
            )}
            <Canvas
                gl={{ alpha: true, antialias: true }}
                orthographic={ANATOMY_CONFIG.camera.type === 'orthographic'}
                camera={{
                    fov: ANATOMY_CONFIG.camera.fov,
                    position: ANATOMY_CONFIG.camera.initialPosition as [number, number, number],
                    up: ANATOMY_CONFIG.camera.upVector as [number, number, number],
                    zoom: ANATOMY_CONFIG.camera.orthographicZoom
                }}
                dpr={[1, 2]}
            >
                <PreviewContent
                    setDebugData={showPreviewTuner ? setDebugData : undefined}
                    manualOverride={manualOverride}
                    autoCameraEnabled={autoCameraEnabled}
                />
            </Canvas>
        </div>
    );
}
