import { create } from 'zustand';
import * as THREE from 'three';
import { type ScanResults } from './steps/voxelization/ScanOrchestrator';

export type StepStatus = 'pending' | 'running' | 'complete' | 'verified';

export interface StepState {
    currentStep: number;
    steps: {
        1: StepStatus;
        2: StepStatus;
        3: StepStatus;
        4: StepStatus;
        5: StepStatus;
        6: StepStatus;
        7: StepStatus;
        8: StepStatus;
    };

    // Data Artifacts per step
    step1Data: { lowestPoints: THREE.Vector3[] } | null;
    step2Data: ScanResults | null; // Replaced VoxelGrid
    // ... future steps

    // Actions
    setStepStatus: (step: number, status: StepStatus) => void;
    setStep1Data: (data: { lowestPoints: THREE.Vector3[] }) => void;
    setStep2Data: (data: ScanResults) => void;
    reset: () => void;
}

export const useStepManager = create<StepState>((set) => ({
    currentStep: 1,
    steps: {
        1: 'pending',
        2: 'pending',
        3: 'pending',
        4: 'pending',
        5: 'pending',
        6: 'pending',
        7: 'pending',
        8: 'pending',
    },
    step1Data: null,
    step2Data: null,

    setStepStatus: (step, status) => set((state) => ({
        steps: { ...state.steps, [step]: status }
    })),

    setStep1Data: (data) => set({ step1Data: data }),
    setStep2Data: (data) => set({ step2Data: data }),

    reset: () => set({
        currentStep: 1,
        steps: {
            1: 'pending',
            2: 'pending',
            3: 'pending',
            4: 'pending',
            5: 'pending',
            6: 'pending',
            7: 'pending',
            8: 'pending',
        },
        step1Data: null,
        step2Data: null,
    })
}));
