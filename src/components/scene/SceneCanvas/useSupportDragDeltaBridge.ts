import React from 'react';

type UseSupportDragDeltaBridgeParams = {
  holdSupportDragDelta?: boolean;
  supportDragTransactionId?: number;
  bridgeWindowMs?: number;
};

type ArmSupportDragBridgeOptions = {
  expectParentTransaction?: boolean;
};

export function useSupportDragDeltaBridge({
  holdSupportDragDelta,
  supportDragTransactionId = 0,
  bridgeWindowMs = 320,
}: UseSupportDragDeltaBridgeParams) {
  const [localHoldActive, setLocalHoldActive] = React.useState(false);
  const localHoldTimeoutRef = React.useRef<number | null>(null);
  const expectedTransactionIdRef = React.useRef<number | null>(null);

  const clearLocalHold = React.useCallback(() => {
    setLocalHoldActive(false);
    expectedTransactionIdRef.current = null;
    if (localHoldTimeoutRef.current !== null) {
      window.clearTimeout(localHoldTimeoutRef.current);
      localHoldTimeoutRef.current = null;
    }
  }, []);

  const armLocalBridge = React.useCallback((options?: ArmSupportDragBridgeOptions) => {
    const expectParentTransaction = options?.expectParentTransaction !== false;
    if (!expectParentTransaction) {
      clearLocalHold();
      return;
    }

    expectedTransactionIdRef.current = supportDragTransactionId + 1;
    setLocalHoldActive(true);
  }, [clearLocalHold, supportDragTransactionId]);

  React.useEffect(() => {
    if (holdSupportDragDelta) {
      clearLocalHold();
      return;
    }

    const expectedTransactionId = expectedTransactionIdRef.current;
    if (
      expectedTransactionId !== null
      && supportDragTransactionId >= expectedTransactionId
    ) {
      clearLocalHold();
      return;
    }

    if (!localHoldActive) return;

    if (localHoldTimeoutRef.current !== null) {
      window.clearTimeout(localHoldTimeoutRef.current);
    }

    localHoldTimeoutRef.current = window.setTimeout(() => {
      clearLocalHold();
    }, bridgeWindowMs);

    return () => {
      if (localHoldTimeoutRef.current !== null) {
        window.clearTimeout(localHoldTimeoutRef.current);
        localHoldTimeoutRef.current = null;
      }
    };
  }, [bridgeWindowMs, clearLocalHold, holdSupportDragDelta, localHoldActive, supportDragTransactionId]);

  React.useEffect(() => {
    return () => {
      if (localHoldTimeoutRef.current !== null) {
        window.clearTimeout(localHoldTimeoutRef.current);
      }
    };
  }, []);

  return {
    effectiveHoldSupportDragDelta: Boolean(holdSupportDragDelta || localHoldActive),
    armLocalBridge,
    clearLocalHold,
  };
}
