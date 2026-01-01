import { BasinFillSimulator } from './BasinFillSimulator';

// Worker State
let simulator: BasinFillSimulator | null = null;
let isRunning = false;

// Parameters
const TICK_SIZE = 10000; // Chunk size per tick
const BATCH_SIZE = 50000; // How many changes before flushing to UI

self.onmessage = async (e: MessageEvent) => {
    const { type, payload } = e.data;

    switch (type) {
        case 'INIT':
            try {
                // Initialize Simulator
                // payload: { scanResults, layerHeight, minZ }
                console.log('[Worker] Initializing BasinFillSimulator...');
                simulator = new BasinFillSimulator(
                    payload.scanResults,
                    payload.layerHeight,
                    payload.minZ
                );

                // Return basic stats
                self.postMessage({
                    type: 'INIT_SUCCESS',
                    payload: {
                        solidVoxelCount: simulator.solidVoxelCount
                    }
                });
            } catch (err: any) {
                console.error('[Worker] Init Failed', err);
                self.postMessage({ type: 'ERROR', payload: err.message });
            }
            break;

        case 'START':
            if (!simulator) return;
            console.log('[Worker] Starting Simulation Loop');
            isRunning = true;
            runLoop();
            break;

        case 'STOP':
            isRunning = false;
            break;
    }
};

function runLoop() {
    if (!simulator || !isRunning) return;

    try {
        if (simulator.isComplete) {
            // Final flush
            flushUpdates();
            self.postMessage({ type: 'COMPLETE' });
            isRunning = false;
            return;
        }

        // Run Multi-Ticks
        // We want to run enough to saturate a frame interval (e.g. 16ms)
        // Let's run a fixed batch for now.
        const iterations = 500000; // Huge batch for speed
        simulator.tick(iterations);

        flushUpdates();

        // Schedule next tick
        // Use setTimeout to allow message processing (e.g. STOP)
        setTimeout(runLoop, 0);

    } catch (err: any) {
        console.error('[Worker] Loop Error', err);
        self.postMessage({ type: 'ERROR', payload: err.message });
        isRunning = false;
    }
}

function flushUpdates() {
    if (!simulator) return;

    // Get raw changes
    // flushChanges returns number[]
    const indices = simulator.flushChanges();
    if (indices.length === 0) return;

    // Convert to typed arrays for transfer
    const indicesArray = new Int32Array(indices);
    const labelsArray = new Int32Array(indices.length);

    for (let i = 0; i < indices.length; i++) {
        labelsArray[i] = simulator.labels[indices[i]];
    }

    // Transfer buffers to Main Thread
    self.postMessage({
        type: 'UPDATE',
        payload: {
            indices: indicesArray,
            labels: labelsArray
        }
    }, [indicesArray.buffer, labelsArray.buffer] as any);
}
