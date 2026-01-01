import { BasinFillSimulator } from './BasinFillSimulator'; // We reuse this for static initialization (Positions) if needed, or we reimplement static data holding.

/**
 * Client-side interface that mirrors BasinFillSimulator state
 * but receives updates from a Web Worker.
 * 
 * Implements a "Playback Buffer" effectively decoupling the 
 * fast simulation (Worker) from the slower visualization (DOM/WebGL).
 */
export class BasinFillProxy {
    public solidVoxelCount: number = 0;

    // Local State Arrays (Read by Visualizer)
    public labels: Int32Array;
    public positions: Float32Array;
    public seedIndices: Set<number>;
    public surfaceVoxelIndices: Int32Array | null;

    // Metadata for Visualizer
    public pxMm: number;
    public layerHeightMm: number;
    public gridWidth: number;
    public gridHeight: number;
    public gridDepth: number;

    // Sparse Map Cache (Ref from tempSim)
    public mapKeys: Int32Array;
    public mapValues: Int32Array;
    public mapMask: number;

    // Buffer Queue: List of chunks received from Worker
    private updateQueue: { indices: Int32Array; labels: Int32Array }[] = [];
    private currentChunkOffset = 0; // Where we are in the first chunk

    private worker: Worker;
    public isComplete = false;
    public iterationCount = 0;

    constructor(
        simulationData: any, // ScanResults + config
        workerFactory: () => Worker
    ) {
        // 1. Initialize Static Data (Positions) on Main Thread
        console.log('[Proxy] Building Static Data...');
        const tempSim = new BasinFillSimulator(
            simulationData.scanResults,
            simulationData.layerHeight,
            simulationData.minZ
        );

        this.solidVoxelCount = tempSim.solidVoxelCount;
        this.positions = tempSim.positions;
        this.labels = new Int32Array(this.solidVoxelCount); // Empty initially
        this.seedIndices = tempSim.seedIndices;
        this.surfaceVoxelIndices = tempSim.surfaceVoxelIndices;

        this.pxMm = tempSim['pxMm'] || 0.03;
        this.layerHeightMm = tempSim['layerHeightMm'] || 0.05;
        this.gridWidth = tempSim.gridWidth;
        this.gridHeight = tempSim.gridHeight;
        this.gridDepth = tempSim.gridDepth;

        // Copy Map References
        this.mapKeys = tempSim.mapKeys;
        this.mapValues = tempSim.mapValues;
        this.mapMask = tempSim.mapMask;

        // 2. Initialize Worker
        this.worker = workerFactory();

        this.worker.onmessage = (e) => this.handleMessage(e);

        // 3. Send Init to Worker
        this.worker.postMessage({
            type: 'INIT',
            payload: simulationData
        });
    }

    private handleMessage(e: MessageEvent) {
        const { type, payload } = e.data;

        switch (type) {
            case 'INIT_SUCCESS':
                console.log('[Proxy] Worker Initialized.');
                // Verify counts match?
                break;
            case 'UPDATE':
                this.handleUpdate(payload.indices, payload.labels);
                break;
            case 'COMPLETE':
                console.log('[Proxy] Worker Complete.');
                this.isComplete = true;
                break;
            case 'ERROR':
                console.error('[Proxy] Worker Error:', payload);
                break;
        }
    }

    private handleUpdate(indices: Int32Array, newLabels: Int32Array) {
        // Just push the chunk. Don't process individual items yet. Fast!
        // We do update iteration count though so UI knows the "True" progress
        this.updateQueue.push({ indices, labels: newLabels });
        this.iterationCount += indices.length;
    }

    public start() {
        this.worker.postMessage({ type: 'START' });
    }

    public stop() {
        this.worker.postMessage({ type: 'STOP' });
    }

    public terminate() {
        this.worker.terminate();
    }

    /**
     * Consumes updates from the buffer up to maxCount.
     * Updates the local `labels` state as it goes.
     * Returns the indices of changed voxels.
     */
    public flushChanges(maxCount: number = 25000): number[] {
        const changes: number[] = [];
        let count = 0;

        while (this.updateQueue.length > 0 && count < maxCount) {
            const chunk = this.updateQueue[0];
            const remainingInChunk = chunk.indices.length - this.currentChunkOffset;
            const take = Math.min(maxCount - count, remainingInChunk);

            // Copy data
            for (let i = 0; i < take; i++) {
                const ptr = this.currentChunkOffset + i;
                const idx = chunk.indices[ptr];
                const lbl = chunk.labels[ptr];

                this.labels[idx] = lbl; // Sync local state
                changes.push(idx);
            }

            count += take;
            this.currentChunkOffset += take;

            // Did we finish the chunk?
            if (this.currentChunkOffset >= chunk.indices.length) {
                this.updateQueue.shift(); // Remove chunk
                this.currentChunkOffset = 0;
            }
        }

        return changes;
    }

    /**
     * Looks up the Island ID for a given grid index using the sparse map.
     * @param gridIdx 
     * @returns Island ID (Label) or 0 if unassigned/empty
     */
    public lookupLabel(gridIdx: number): number {
        let slot = gridIdx & this.mapMask;
        while (true) {
            const key = this.mapKeys[slot];
            if (key === -1) return 0; // Not found -> Empty Space -> Label 0 or -1? 
            // If not in map, it's not a solid voxel, so effectively "Void" (0)
            if (key === gridIdx) {
                const solidIdx = this.mapValues[slot];
                return this.labels[solidIdx];
            }
            slot = (slot + 1) & this.mapMask;
        }
    }
}
