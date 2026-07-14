import React from 'react';
import type { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import type { PrinterProfile } from '@/features/profiles/profileStore';

type SceneManager = ReturnType<typeof useSceneCollectionManager>;

type PreviewTargetResolution = {
  widthPx: number;
  heightPx: number;
  viewportWidth: number;
  viewportHeight: number;
} | null;

/** Late/cross-cutting dependencies the preview manager reads at event/effect
 *  time via deps.current.*. `printingPreviewTargetResolution` is owned by Home
 *  (it derives from the active printer profile + slicing artifact) and is
 *  defined AFTER this hook's call site, so it is injected through the deps ref
 *  to break the ordering cycle. Read inside the hi-res settled-canvas effect. */
export type PrintingPreviewManagerDeps = {
  /** Read at effect time; not reactive. Owned by Home (profile + artifact). */
  printingPreviewTargetResolution: PreviewTargetResolution;
};

export type UsePrintingPreviewManagerOptions = {
  scene: SceneManager;
  activePrinterProfile: PrinterProfile | null | undefined;
  /** Total sliced layers; owned by Home/slicing. */
  printingPreviewTotalLayers: number;
  /** Per-layer preview PNG object URLs; owned by Home/slicing loader. */
  printingLayerPreviewUrls: Array<string | null>;
  deps: React.MutableRefObject<PrintingPreviewManagerDeps>;
};

export function usePrintingPreviewManager({
  scene,
  activePrinterProfile,
  printingPreviewTotalLayers,
  printingLayerPreviewUrls,
  deps,
}: UsePrintingPreviewManagerOptions) {
  // ---- moved: stateA ----
  const [printingSelectedLayer, setPrintingSelectedLayer] = React.useState(1);
  const [printingDisplayedLayer, setPrintingDisplayedLayer] = React.useState(1);
  const [isPrintingLayerScrubbing, setIsPrintingLayerScrubbing] = React.useState(false);
  const [printingPngLoadedUrl, setPrintingPngLoadedUrl] = React.useState<string | null>(null);
  const [isSceneLayerScrubbing, setIsSceneLayerScrubbing] = React.useState(false);
  const [isPrintingPreviewSettled, setIsPrintingPreviewSettled] = React.useState(false);
  const [isPrintingSettledCanvasReady, setIsPrintingSettledCanvasReady] = React.useState(false);

  // ---- moved: stateB ----
  const [printingPreviewZoom, setPrintingPreviewZoom] = React.useState(1);
  const [printingPreviewPan, setPrintingPreviewPan] = React.useState({ x: 0, y: 0 });
  const [isPrintingPreviewPanning, setIsPrintingPreviewPanning] = React.useState(false);

  // ---- moved: refsC ----
  const printingPreviewViewportRef = React.useRef<HTMLDivElement | null>(null);
  const printingPreviewCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const printingPreviewSettleTimeoutRef = React.useRef<number | null>(null);
  const printingPreviewSettledRef = React.useRef(false);
  const printingPreviewCanvasRenderNonceRef = React.useRef(0);
  const printingPreviewLoadNonceRef = React.useRef(0);
  const pendingPrintingSelectedLayerRef = React.useRef<number | null>(null);
  const printingSelectedLayerRafRef = React.useRef<number | null>(null);
  const printingSelectedLayerRef = React.useRef(1);
  const printingPreviewZoomRef = React.useRef(1);
  const printingPreviewPanRef = React.useRef({ x: 0, y: 0 });
  const printingPreviewPanPendingRef = React.useRef({ x: 0, y: 0 });
  const printingPreviewPanRafRef = React.useRef<number | null>(null);

  // ---- moved: refD ----
  const printingPreviewDragRef = React.useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
  } | null>(null);

  // ---- moved: syncCleanupEffects ----
  React.useEffect(() => {
    printingPreviewZoomRef.current = printingPreviewZoom;
  }, [printingPreviewZoom]);

  React.useEffect(() => {
    printingPreviewPanRef.current = printingPreviewPan;
  }, [printingPreviewPan]);

  React.useEffect(() => {
    printingSelectedLayerRef.current = printingSelectedLayer;
  }, [printingSelectedLayer]);

  React.useEffect(() => {
    printingPreviewSettledRef.current = isPrintingPreviewSettled;
  }, [isPrintingPreviewSettled]);

  React.useEffect(() => {
    return () => {
      if (printingSelectedLayerRafRef.current !== null) {
        window.cancelAnimationFrame(printingSelectedLayerRafRef.current);
      }
      if (printingPreviewPanRafRef.current !== null) {
        window.cancelAnimationFrame(printingPreviewPanRafRef.current);
      }
      if (printingPreviewSettleTimeoutRef.current !== null) {
        window.clearTimeout(printingPreviewSettleTimeoutRef.current);
      }
    };
  }, []);

  // ---- moved: settleQueueClamp ----
  const schedulePrintingPreviewSettle = React.useCallback(() => {
    if (printingPreviewSettledRef.current) {
      printingPreviewSettledRef.current = false;
      setIsPrintingPreviewSettled(false);
    }
    if (printingPreviewSettleTimeoutRef.current !== null) {
      window.clearTimeout(printingPreviewSettleTimeoutRef.current);
    }
    printingPreviewSettleTimeoutRef.current = window.setTimeout(() => {
      printingPreviewSettleTimeoutRef.current = null;
      printingPreviewSettledRef.current = true;
      setIsPrintingPreviewSettled(true);
    }, 180);
  }, []);

  const queuePrintingPreviewPan = React.useCallback((nextPan: { x: number; y: number }) => {
    printingPreviewPanPendingRef.current = nextPan;
    if (printingPreviewPanRafRef.current !== null) return;

    printingPreviewPanRafRef.current = window.requestAnimationFrame(() => {
      printingPreviewPanRafRef.current = null;
      const pending = printingPreviewPanPendingRef.current;
      setPrintingPreviewPan((previous) => {
        if (Math.abs(previous.x - pending.x) < 0.05 && Math.abs(previous.y - pending.y) < 0.05) {
          return previous;
        }
        return pending;
      });
    });
  }, []);

  const clampPrintingPreviewPan = React.useCallback((
    nextPan: { x: number; y: number },
    zoom: number,
    viewportWidthPx: number,
    viewportHeightPx: number,
  ) => {
    if (!Number.isFinite(zoom) || zoom <= 1.0001) {
      return { x: 0, y: 0 };
    }

    const safeWidth = Math.max(1, viewportWidthPx);
    const safeHeight = Math.max(1, viewportHeightPx);
    const maxPanX = Math.max(0, ((zoom - 1) * safeWidth) * 0.5);
    const maxPanY = Math.max(0, ((zoom - 1) * safeHeight) * 0.5);

    return {
      x: Math.max(-maxPanX, Math.min(maxPanX, nextPan.x)),
      y: Math.max(-maxPanY, Math.min(maxPanY, nextPan.y)),
    };
  }, []);

  React.useEffect(() => {
    if (printingPreviewZoom <= 1.0001) {
      queuePrintingPreviewPan({ x: 0, y: 0 });
    }
  }, [printingPreviewZoom, queuePrintingPreviewPan]);

  const clampPrintingLayer = React.useCallback((nextLayer: number) => {
    const rounded = Math.round(nextLayer);
    return Math.max(1, Math.min(Math.max(1, printingPreviewTotalLayers), rounded));
  }, [printingPreviewTotalLayers]);

  // ---- moved: selectedUrlPngLoaded ----
  const selectedPrintingLayerPreviewUrl = React.useMemo(() => {
    if (printingDisplayedLayer < 1) return null;
    return printingLayerPreviewUrls[printingDisplayedLayer - 1] ?? null;
  }, [printingLayerPreviewUrls, printingDisplayedLayer]);

  const isPrintingPngLoaded = React.useMemo(() => {
    if (!selectedPrintingLayerPreviewUrl) return false;
    return printingPngLoadedUrl === selectedPrintingLayerPreviewUrl;
  }, [printingPngLoadedUrl, selectedPrintingLayerPreviewUrl]);

  // ---- moved: scrubPngHandlersMemos ----
  // Show GPU preview during scrubbing or while waiting for PNG to load
  // (GPU preview is fast enough to render real-time during scrub)
  const shouldShowScrubPreview = React.useMemo(() => {
    return (
      isPrintingLayerScrubbing
      || !isPrintingPreviewSettled
      || !selectedPrintingLayerPreviewUrl
      || !isPrintingPngLoaded
    );
  }, [
    isPrintingLayerScrubbing,
    isPrintingPreviewSettled,
    selectedPrintingLayerPreviewUrl,
    isPrintingPngLoaded,
  ]);

  const printingPreviewPngUrlForDisplay = React.useMemo(() => {
    return selectedPrintingLayerPreviewUrl ?? printingPngLoadedUrl;
  }, [printingPngLoadedUrl, selectedPrintingLayerPreviewUrl]);

  React.useEffect(() => {
    if (!selectedPrintingLayerPreviewUrl) {
      setPrintingPngLoadedUrl(null);
      return;
    }

    const loadNonce = ++printingPreviewLoadNonceRef.current;
    let cancelled = false;
    const targetUrl = selectedPrintingLayerPreviewUrl;
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (cancelled) return;
      if (loadNonce !== printingPreviewLoadNonceRef.current) return;
      setPrintingPngLoadedUrl(targetUrl);
    };
    image.onerror = () => {
      // Fail-open so we do not get stuck in scrub preview if decode/load fails once.
      if (cancelled) return;
      if (loadNonce !== printingPreviewLoadNonceRef.current) return;
      setPrintingPngLoadedUrl(targetUrl);
    };
    image.src = targetUrl;

    return () => {
      cancelled = true;
    };
  }, [selectedPrintingLayerPreviewUrl]);

  const handlePrintingPreviewWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (printingPreviewTotalLayers <= 0) return;
    event.preventDefault();

    const previousZoom = printingPreviewZoomRef.current;
    if (previousZoom <= 1.0001 && event.deltaY > 0) {
      return;
    }

    const factor = Math.exp(-event.deltaY * 0.0015);
    const nextZoom = Math.max(1, Math.min(32, previousZoom * factor));

    if (Math.abs(nextZoom - previousZoom) < 1e-5) return;

    schedulePrintingPreviewSettle();

    const viewportRect = printingPreviewViewportRef.current?.getBoundingClientRect();
    if (!viewportRect) {
      setPrintingPreviewZoom(nextZoom);
      if (nextZoom <= 1.0001) queuePrintingPreviewPan({ x: 0, y: 0 });
      return;
    }

    const pointerX = event.clientX - (viewportRect.left + viewportRect.width * 0.5);
    const pointerY = event.clientY - (viewportRect.top + viewportRect.height * 0.5);
    const previousPan = printingPreviewPanRef.current;
    const contentX = (pointerX - previousPan.x) / Math.max(1e-4, previousZoom);
    const contentY = (pointerY - previousPan.y) / Math.max(1e-4, previousZoom);
    const nextPan = nextZoom <= 1.0001
      ? { x: 0, y: 0 }
      : {
          x: pointerX - (contentX * nextZoom),
          y: pointerY - (contentY * nextZoom),
        };

    const clampedPan = clampPrintingPreviewPan(
      nextPan,
      nextZoom,
      viewportRect.width,
      viewportRect.height,
    );

    setPrintingPreviewZoom(nextZoom);
    queuePrintingPreviewPan(clampedPan);
  }, [clampPrintingPreviewPan, queuePrintingPreviewPan, schedulePrintingPreviewSettle, printingPreviewTotalLayers]);

  const handlePrintingPreviewPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (printingPreviewTotalLayers <= 0) return;
    if (printingPreviewZoomRef.current <= 1.0001) return;
    if (event.button !== 0) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const currentPan = printingPreviewPanRef.current;
    printingPreviewDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: currentPan.x,
      originY: currentPan.y,
    };
    setIsPrintingPreviewPanning(true);
    schedulePrintingPreviewSettle();
  }, [schedulePrintingPreviewSettle, printingPreviewTotalLayers]);

  const handlePrintingPreviewPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = printingPreviewDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();

    const nextPan = {
      x: drag.originX + (event.clientX - drag.startClientX),
      y: drag.originY + (event.clientY - drag.startClientY),
    };
    const viewportRect = printingPreviewViewportRef.current?.getBoundingClientRect();
    const clampedPan = viewportRect
      ? clampPrintingPreviewPan(nextPan, printingPreviewZoomRef.current, viewportRect.width, viewportRect.height)
      : nextPan;

    queuePrintingPreviewPan(clampedPan);
    schedulePrintingPreviewSettle();
  }, [clampPrintingPreviewPan, queuePrintingPreviewPan, schedulePrintingPreviewSettle]);

  const handlePrintingPreviewPointerEnd = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = printingPreviewDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    printingPreviewDragRef.current = null;
    setIsPrintingPreviewPanning(false);
    schedulePrintingPreviewSettle();
  }, [schedulePrintingPreviewSettle]);

  const printingPreviewDeMirrorTransform = React.useMemo(() => {
    const mirrorX = activePrinterProfile?.display?.mirrorX === true;
    const mirrorY = activePrinterProfile?.display?.mirrorY === true;
    const scaleX = mirrorX ? -1 : 1;
    const scaleY = mirrorY ? -1 : 1;
    if (scaleX === 1 && scaleY === 1) return undefined;
    return `scale(${scaleX}, ${scaleY})`;
  }, [activePrinterProfile?.display?.mirrorX, activePrinterProfile?.display?.mirrorY]);

  const printingPreviewMirrorScale = React.useMemo(() => ({
    x: activePrinterProfile?.display?.mirrorX === true ? -1 : 1,
    y: activePrinterProfile?.display?.mirrorY === true ? -1 : 1,
  }), [activePrinterProfile?.display?.mirrorX, activePrinterProfile?.display?.mirrorY]);

  const isPrintingPreviewLowResActive = React.useMemo(() => {
    // Only use low-res PNG upscale path when scrubbing with PNG preview.
    // When the fake cross-section preview is active, this would double-scale it.
    return isPrintingLayerScrubbing && !shouldShowScrubPreview && printingPreviewZoom <= 1.0001;
  }, [isPrintingLayerScrubbing, printingPreviewZoom, shouldShowScrubPreview]);

  const printingPreviewScrubQualityScale = React.useMemo(() => {
    if (!isPrintingPreviewLowResActive) return 1;
    return 0.5;
  }, [isPrintingPreviewLowResActive]);

  const printingPreviewScrubUpscaleTransform = React.useMemo(() => {
    if (printingPreviewScrubQualityScale >= 0.9999) return undefined;
    const upscale = 1 / printingPreviewScrubQualityScale;
    return `scale(${upscale})`;
  }, [printingPreviewScrubQualityScale]);

  const printingPreviewVisualTransform = React.useMemo(() => {
    const transformParts: string[] = [];
    if (Math.abs(printingPreviewPan.x) > 0.01 || Math.abs(printingPreviewPan.y) > 0.01) {
      transformParts.push(`translate(${printingPreviewPan.x}px, ${printingPreviewPan.y}px)`);
    }
    if (Math.abs(printingPreviewZoom - 1) > 1e-4) {
      transformParts.push(`scale(${printingPreviewZoom})`);
    }
    if (printingPreviewDeMirrorTransform) {
      transformParts.push(printingPreviewDeMirrorTransform);
    }
    if (printingPreviewScrubUpscaleTransform) {
      transformParts.push(printingPreviewScrubUpscaleTransform);
    }
    return transformParts.length > 0 ? transformParts.join(' ') : undefined;
  }, [
    printingPreviewDeMirrorTransform,
    printingPreviewPan.x,
    printingPreviewPan.y,
    printingPreviewScrubUpscaleTransform,
    printingPreviewZoom,
  ]);

  const printingPreviewCursor = React.useMemo<React.CSSProperties['cursor']>(() => {
    if (!selectedPrintingLayerPreviewUrl) return 'default';
    if (printingPreviewZoom > 1.0001) {
      return isPrintingPreviewPanning ? 'grabbing' : 'grab';
    }
    return 'zoom-in';
  }, [isPrintingPreviewPanning, printingPreviewZoom, selectedPrintingLayerPreviewUrl]);

  React.useEffect(() => {
    if (scene.mode !== 'printing') {
      setIsPrintingLayerScrubbing(false);
      setIsPrintingSettledCanvasReady(false);
      printingPreviewSettledRef.current = false;
      setIsPrintingPreviewSettled(false);
      setPrintingPreviewZoom(1);
      queuePrintingPreviewPan({ x: 0, y: 0 });
      setIsPrintingPreviewPanning(false);
      printingPreviewDragRef.current = null;
      setPrintingDisplayedLayer(1);
      if (printingPreviewSettleTimeoutRef.current !== null) {
        window.clearTimeout(printingPreviewSettleTimeoutRef.current);
        printingPreviewSettleTimeoutRef.current = null;
      }
    }
  }, [queuePrintingPreviewPan, scene.mode]);

  React.useEffect(() => {
    if (scene.mode !== 'printing') return;
    // Reset transform state on entering printing so scrub/PNG views stay in sync.
    setIsPrintingSettledCanvasReady(false);
    printingPreviewSettledRef.current = false;
    setIsPrintingPreviewSettled(false);
    setPrintingPreviewZoom(1);
    queuePrintingPreviewPan({ x: 0, y: 0 });
    setIsPrintingPreviewPanning(false);
    printingPreviewDragRef.current = null;
    if (printingPreviewSettleTimeoutRef.current !== null) {
      window.clearTimeout(printingPreviewSettleTimeoutRef.current);
      printingPreviewSettleTimeoutRef.current = null;
    }
  }, [queuePrintingPreviewPan, scene.mode]);

  React.useEffect(() => {
    if (scene.mode === 'printing') return;
    setIsSceneLayerScrubbing(false);
  }, [scene.mode]);

  React.useEffect(() => {
    if (scene.mode !== 'printing') return;
    if (!selectedPrintingLayerPreviewUrl) {
      printingPreviewSettledRef.current = false;
      setIsPrintingPreviewSettled(false);
      setIsPrintingSettledCanvasReady(false);
      return;
    }
    schedulePrintingPreviewSettle();
  }, [scene.mode, schedulePrintingPreviewSettle, selectedPrintingLayerPreviewUrl]);

  React.useEffect(() => {
    setIsPrintingSettledCanvasReady(false);
  }, [selectedPrintingLayerPreviewUrl]);

  // ---- moved: layerChangeHiRes ----
  const handlePrintingLayerChange = React.useCallback((nextLayer: number) => {
    if (!Number.isFinite(nextLayer)) return;
    const clamped = clampPrintingLayer(nextLayer);

    const flushPendingLayer = (options?: { syncDisplayedLayer?: boolean }) => {
      const pending = pendingPrintingSelectedLayerRef.current;
      pendingPrintingSelectedLayerRef.current = null;
      if (pending == null) return;

      printingSelectedLayerRef.current = pending;
      setPrintingSelectedLayer((previous) => (previous === pending ? previous : pending));
      if (options?.syncDisplayedLayer !== false) {
        setPrintingDisplayedLayer((previous) => (previous === pending ? previous : pending));
      }
    };

    if (isPrintingLayerScrubbing) {
      const currentOrPending = pendingPrintingSelectedLayerRef.current ?? printingSelectedLayerRef.current;
      if (currentOrPending === clamped) return;

      pendingPrintingSelectedLayerRef.current = clamped;

      if (printingSelectedLayerRafRef.current !== null) return;

      printingSelectedLayerRafRef.current = window.requestAnimationFrame(() => {
        printingSelectedLayerRafRef.current = null;
        flushPendingLayer({ syncDisplayedLayer: false });
      });
      return;
    }

    if (printingSelectedLayerRafRef.current !== null) {
      window.cancelAnimationFrame(printingSelectedLayerRafRef.current);
      printingSelectedLayerRafRef.current = null;
    }

    pendingPrintingSelectedLayerRef.current = null;
    printingSelectedLayerRef.current = clamped;
    setPrintingSelectedLayer((previous) => (previous === clamped ? previous : clamped));
    setPrintingDisplayedLayer((previous) => (previous === clamped ? previous : clamped));
  }, [clampPrintingLayer, isPrintingLayerScrubbing]);

  // ---- moved: scrubStartEndCanvas ----
  const handlePrintingLayerScrubStart = React.useCallback(() => {
    setIsPrintingLayerScrubbing(true);
    schedulePrintingPreviewSettle();
  }, [schedulePrintingPreviewSettle]);

  const handlePrintingLayerScrubEnd = React.useCallback(() => {
    const flushPendingLayer = () => {
      const pending = pendingPrintingSelectedLayerRef.current;
      pendingPrintingSelectedLayerRef.current = null;
      if (pending == null) return null;

      printingSelectedLayerRef.current = pending;
      setPrintingSelectedLayer((previous) => (previous === pending ? previous : pending));
      setPrintingDisplayedLayer((previous) => (previous === pending ? previous : pending));
      return pending;
    };

    if (printingSelectedLayerRafRef.current !== null) {
      window.cancelAnimationFrame(printingSelectedLayerRafRef.current);
      printingSelectedLayerRafRef.current = null;
    }

    const pending = flushPendingLayer();
    setIsPrintingLayerScrubbing(false);
    // Switch display target to the released layer immediately.
    // If that layer PNG is not loaded yet, UI falls back to cross-section preview
    // instead of showing stale PNG from the previously displayed layer.
    const targetLayer = pending ?? printingSelectedLayerRef.current;
    setPrintingDisplayedLayer(
      Math.max(1, Math.min(Math.max(1, printingPreviewTotalLayers), targetLayer)),
    );
    schedulePrintingPreviewSettle();
  }, [schedulePrintingPreviewSettle, printingPreviewTotalLayers]);

  const handleSceneLayerScrubStart = React.useCallback(() => {
    setIsSceneLayerScrubbing(true);
  }, []);

  const handleSceneLayerScrubEnd = React.useCallback(() => {
    setIsSceneLayerScrubbing(false);
  }, []);

  const usePrintingSettledHiResCanvas = React.useMemo(() => {
    return Boolean(
      selectedPrintingLayerPreviewUrl
      && printingPreviewZoom > 1.0001
      && !isPrintingLayerScrubbing,
    );
  }, [isPrintingLayerScrubbing, printingPreviewZoom, selectedPrintingLayerPreviewUrl]);

  React.useEffect(() => {
    if (!usePrintingSettledHiResCanvas) return;
    if (!selectedPrintingLayerPreviewUrl) return;

    const canvas = printingPreviewCanvasRef.current;
    const viewport = printingPreviewViewportRef.current;
    if (!canvas || !viewport) return;

    const rect = viewport.getBoundingClientRect();
    const viewportWidth = Math.max(1, Math.round(rect.width));
    const viewportHeight = Math.max(1, Math.round(rect.height));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const canvasWidth = Math.max(1, Math.round(viewportWidth * dpr));
    const canvasHeight = Math.max(1, Math.round(viewportHeight * dpr));

    if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const renderNonce = ++printingPreviewCanvasRenderNonceRef.current;
    let cancelled = false;
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (cancelled) return;
      if (renderNonce !== printingPreviewCanvasRenderNonceRef.current) return;

      const naturalWidth = Math.max(1, image.naturalWidth || 1);
      const naturalHeight = Math.max(1, image.naturalHeight || 1);
      const logicalSourceWidth = Math.max(1, deps.current.printingPreviewTargetResolution?.viewportWidth ?? naturalWidth);
      const logicalSourceHeight = Math.max(1, deps.current.printingPreviewTargetResolution?.viewportHeight ?? naturalHeight);
      const baseScale = Math.min(viewportWidth / logicalSourceWidth, viewportHeight / logicalSourceHeight);
      const drawWidth = logicalSourceWidth * baseScale;
      const drawHeight = logicalSourceHeight * baseScale;

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      ctx.imageSmoothingEnabled = false;
      ctx.translate(viewportWidth * 0.5 + printingPreviewPan.x, viewportHeight * 0.5 + printingPreviewPan.y);
      ctx.scale(printingPreviewZoom, printingPreviewZoom);
      ctx.scale(printingPreviewMirrorScale.x, printingPreviewMirrorScale.y);
      ctx.drawImage(image, -drawWidth * 0.5, -drawHeight * 0.5, drawWidth, drawHeight);
      ctx.restore();
      setIsPrintingSettledCanvasReady(true);
    };
    image.src = selectedPrintingLayerPreviewUrl;

    return () => {
      cancelled = true;
    };
  }, [
    printingPreviewMirrorScale.x,
    printingPreviewMirrorScale.y,
    printingPreviewPan.x,
    printingPreviewPan.y,
    deps.current.printingPreviewTargetResolution?.viewportHeight,
    deps.current.printingPreviewTargetResolution?.viewportWidth,
    printingPreviewZoom,
    selectedPrintingLayerPreviewUrl,
    usePrintingSettledHiResCanvas,
  ]);

  return {
    printingSelectedLayer,
    setPrintingSelectedLayer,
    printingDisplayedLayer,
    setPrintingDisplayedLayer,
    isPrintingLayerScrubbing,
    setIsPrintingLayerScrubbing,
    printingPngLoadedUrl,
    setPrintingPngLoadedUrl,
    isSceneLayerScrubbing,
    setIsSceneLayerScrubbing,
    isPrintingPreviewSettled,
    setIsPrintingPreviewSettled,
    isPrintingSettledCanvasReady,
    setIsPrintingSettledCanvasReady,
    printingPreviewZoom,
    setPrintingPreviewZoom,
    printingPreviewPan,
    setPrintingPreviewPan,
    isPrintingPreviewPanning,
    setIsPrintingPreviewPanning,
    printingPreviewViewportRef,
    printingPreviewCanvasRef,
    printingPreviewSettleTimeoutRef,
    printingPreviewSettledRef,
    printingPreviewCanvasRenderNonceRef,
    printingPreviewLoadNonceRef,
    pendingPrintingSelectedLayerRef,
    printingSelectedLayerRafRef,
    printingSelectedLayerRef,
    printingPreviewZoomRef,
    printingPreviewPanRef,
    printingPreviewPanPendingRef,
    printingPreviewPanRafRef,
    printingPreviewDragRef,
    schedulePrintingPreviewSettle,
    queuePrintingPreviewPan,
    clampPrintingPreviewPan,
    clampPrintingLayer,
    handlePrintingLayerChange,
    handlePrintingLayerScrubStart,
    handlePrintingLayerScrubEnd,
    handleSceneLayerScrubStart,
    handleSceneLayerScrubEnd,
    handlePrintingPreviewWheel,
    handlePrintingPreviewPointerDown,
    handlePrintingPreviewPointerMove,
    handlePrintingPreviewPointerEnd,
    selectedPrintingLayerPreviewUrl,
    isPrintingPngLoaded,
    shouldShowScrubPreview,
    printingPreviewPngUrlForDisplay,
    printingPreviewDeMirrorTransform,
    printingPreviewMirrorScale,
    isPrintingPreviewLowResActive,
    printingPreviewScrubQualityScale,
    printingPreviewScrubUpscaleTransform,
    printingPreviewVisualTransform,
    printingPreviewCursor,
    usePrintingSettledHiResCanvas,
  };
}
