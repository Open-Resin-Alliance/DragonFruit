/**
 * Auto-support worker shell. The body is `runAutoPlaceRequest`, shared with
 * the client's test so both run the same code.
 */

import {
    runAutoPlaceRequest,
    type AutoPlaceWorkerRequest,
    type AutoPlaceWorkerResponse,
} from './autoPlace.worker.shared';

self.onmessage = (event: MessageEvent<AutoPlaceWorkerRequest>) => {
    const msg = event.data;
    if (!msg || msg.type !== 'run') return;

    // Ack before planning. Module evaluation happens before this handler
    // exists, so a worker whose import graph threw while loading never acks —
    // and that silence is the only signal the client has that no answer is
    // coming. (The plan itself blocks this thread, so a heartbeat from inside
    // the run is not possible without progress callbacks in the pipeline.)
    self.postMessage({ type: 'started', requestId: msg.requestId } satisfies AutoPlaceWorkerResponse);

    let out: AutoPlaceWorkerResponse;
    try {
        out = { type: 'result', requestId: msg.requestId, plan: runAutoPlaceRequest(msg.payload) };
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
