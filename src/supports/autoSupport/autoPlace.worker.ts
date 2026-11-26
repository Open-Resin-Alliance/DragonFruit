/**
 * Auto-support worker shell. The bodies are shared with the client's tests:
 * `runAutoPlaceRequest` plans, `runSupportAnalysisRequest` evaluates the
 * existing forest. Both run on this thread so the panel never solves a large
 * model on the main thread.
 */

import {
    runAutoPlaceRequest,
    runSupportAnalysisRequest,
    type AutoPlaceWorkerRequest,
    type AutoPlaceWorkerResponse,
} from './autoPlace.worker.shared';

self.onmessage = (event: MessageEvent<AutoPlaceWorkerRequest>) => {
    const msg = event.data;
    if (!msg || (msg.type !== 'run' && msg.type !== 'analyze')) return;

    // Ack before either body. Module evaluation happens before this handler
    // exists, so a worker whose import graph threw while loading never acks —
    // and that silence is the only signal the client has that no answer is
    // coming.
    self.postMessage({ type: 'started', requestId: msg.requestId } satisfies AutoPlaceWorkerResponse);

    const reportProgress = (progress: { phase: string; done: number; total: number }) => {
        self.postMessage({
            type: 'progress',
            requestId: msg.requestId,
            phase: progress.phase,
            done: progress.done,
            total: progress.total,
        } satisfies AutoPlaceWorkerResponse);
    };

    let out: AutoPlaceWorkerResponse;
    try {
        out = msg.type === 'run'
            ? {
                type: 'result',
                requestId: msg.requestId,
                plan: runAutoPlaceRequest(msg.payload, reportProgress),
            }
            : {
                type: 'analysis',
                requestId: msg.requestId,
                result: runSupportAnalysisRequest(msg.payload, reportProgress),
            };
    } catch (error) {
        // The stack matters more than the message here: the failure is usually
        // a module reaching for something the realm does not have, and only the
        // stack names the module.
        out = {
            type: 'error',
            requestId: msg.requestId,
            error: error instanceof Error ? error.message : 'Unknown worker error',
            stack: error instanceof Error ? error.stack : undefined,
        };
    }
    self.postMessage(out);
};
