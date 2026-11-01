import React from 'react';
import JSZip from 'jszip';
import type { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import { getProfileStoreSnapshot, type PrinterProfile } from '@/features/profiles/profileStore';
import { readPrintArtifactBytesFromPath } from '@/features/slicing/tauri/nativeSlicerBridge';
import type { SliceExportArtifact } from '@/features/slicing/sliceExportOrchestrator';

type SceneManager = ReturnType<typeof useSceneCollectionManager>;

type PreviewTargetResolution = {
  widthPx: number;
  heightPx: number;
  viewportWidth: number;
  viewportHeight: number;
} | null;

export type UsePrintingPreviewManagerOptions = {
  scene: SceneManager;
  activePrinterProfile: PrinterProfile | null | undefined;
  /** Total sliced layers; owned by Home/slicing. */
  printingPreviewTotalLayers: number;
  /** The preview of a layer of the plate on screen, once read; owned by `useSlicedPlates`. */
  layerPreviewUrlAt: (layerNumber: number) => string | null;
  /** The slice of the plate on screen; owned by `useSlicedPlates`. */
  printingArtifact: SliceExportArtifact | null;
};

/** Fallback tints when a tank's material has no colour of its own. */
const TANK_PREVIEW_COLOURS = ['#60a5fa', '#facc15', '#f87171', '#34d399', '#c084fc', '#fb923c'];

/**
 * A multi-tank slice stores one image per tank per layer (`layer_00001_tank_1.png`,
 * …). The preview colours each of them with its tank's resin and stacks them, so the
 * layer shows what each geometry prints as instead of a white mask.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.trim().replace('#', '');
  const value = normalized.length === 3
    ? normalized.split('').map((char) => char + char).join('')
    : normalized;
  const int = Number.parseInt(value.slice(0, 6), 16);
  if (!Number.isFinite(int)) return { r: 255, g: 255, b: 255 };
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

async function composeMultiTankLayerPreview(
  entries: Array<{ tankIndex: number; blob: Blob }>,
  colours: readonly string[],
): Promise<string> {
  const decoded = await Promise.all(entries.map(async (entry) => {
    const url = URL.createObjectURL(entry.blob);
    const image = new Image();
    image.src = url;
    await image.decode();
    return { ...entry, image, url };
  }));
  try {
    const width = Math.max(1, decoded[0]?.image.naturalWidth || 1);
    const height = Math.max(1, decoded[0]?.image.naturalHeight || 1);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('the preview canvas is unavailable');

    for (const tank of decoded) {
      const tinted = document.createElement('canvas');
      tinted.width = width;
      tinted.height = height;
      const tintCtx = tinted.getContext('2d');
      if (!tintCtx) continue;
      // The tank PNGs are opaque grayscale masks: the intensity is the coverage, so
      // transparency has to be derived from it. Filling over them would paint the
      // whole rectangle.
      tintCtx.drawImage(tank.image, 0, 0, width, height);
      const pixels = tintCtx.getImageData(0, 0, width, height);
      const tint = hexToRgb(colours[tank.tankIndex] ?? TANK_PREVIEW_COLOURS[tank.tankIndex % TANK_PREVIEW_COLOURS.length]);
      const data = pixels.data;
      for (let i = 0; i < data.length; i += 4) {
        const coverage = data[i];
        data[i] = tint.r;
        data[i + 1] = tint.g;
        data[i + 2] = tint.b;
        data[i + 3] = coverage;
      }
      tintCtx.putImageData(pixels, 0, 0);
      ctx.drawImage(tinted, 0, 0);
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('the preview could not be encoded');
    return URL.createObjectURL(blob);
  } finally {
    for (const tank of decoded) URL.revokeObjectURL(tank.url);
  }
}

export function usePrintingPreviewManager({
  scene,
  activePrinterProfile,
  printingPreviewTotalLayers,
  layerPreviewUrlAt,
  printingArtifact,
}: UsePrintingPreviewManagerOptions) {
  /** The printer's display, in pixels and in millimetres: what a layer image is drawn onto. */
  const printingPreviewTargetResolution = React.useMemo<PreviewTargetResolution>(() => {
    const printerWidth = Math.max(1, Math.round(activePrinterProfile?.display?.resolutionX ?? 0));
    const printerHeight = Math.max(1, Math.round(activePrinterProfile?.display?.resolutionY ?? 0));
    const pixelSizeX = Math.max(0.0001, Number(activePrinterProfile?.pixelSize?.x ?? 1));
    const pixelSizeY = Math.max(0.0001, Number(activePrinterProfile?.pixelSize?.y ?? 1));
    const hasPrintableArtifact = (printingArtifact?.outputName ?? '').trim().length > 0;

    if (!hasPrintableArtifact || printerWidth <= 0 || printerHeight <= 0) {
      return null;
    }

    return {
      widthPx: printerWidth,
      heightPx: printerHeight,
      viewportWidth: printerWidth * pixelSizeX,
      viewportHeight: printerHeight * pixelSizeY,
    };
  }, [
    activePrinterProfile?.display?.resolutionX,
    activePrinterProfile?.display?.resolutionY,
    activePrinterProfile?.pixelSize?.x,
    activePrinterProfile?.pixelSize?.y,
    printingArtifact?.outputName,
  ]);
  const targetViewportWidth = printingPreviewTargetResolution?.viewportWidth;
  const targetViewportHeight = printingPreviewTargetResolution?.viewportHeight;

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
  /** Composite preview of the displayed layer for a multi-tank slice, and its URL. */
  const [multiTankPreview, setMultiTankPreview] = React.useState<{ layer: number; url: string } | null>(null);
  const multiTankPreviewRef = React.useRef<{ layer: number; url: string } | null>(null);
  const multiTankZipRef = React.useRef<{ path: string; zip: JSZip } | null>(null);
  /** Composed layer URLs, so scrubbing back over a layer is instant. */
  const multiTankPreviewCacheRef = React.useRef(new Map<number, string>());
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
  const tankPreviewColours = React.useMemo(() => {
    if (activePrinterProfile?.materialMode !== 'multiTank') return [];
    const profiles = getProfileStoreSnapshot().materialProfiles;
    const byId = new Map(profiles.map((profile) => [profile.id, profile.color]));
    return (activePrinterProfile.tankMaterials ?? []).map((materialId, index) => (
      byId.get(materialId) ?? TANK_PREVIEW_COLOURS[index % TANK_PREVIEW_COLOURS.length]
    ));
  }, [activePrinterProfile?.materialMode, activePrinterProfile?.tankMaterials]);

  const multiTankArtifactPath = activePrinterProfile?.materialMode === 'multiTank'
    ? printingArtifact?.nativeTempPath ?? null
    : null;

  React.useEffect(() => {
    if (!multiTankArtifactPath) {
      if (multiTankPreviewRef.current) {
        URL.revokeObjectURL(multiTankPreviewRef.current.url);
        multiTankPreviewRef.current = null;
      }
      multiTankZipRef.current = null;
      setMultiTankPreview(null);
      return;
    }

    const layer = printingDisplayedLayer;
    const cached = multiTankPreviewCacheRef.current.get(layer);
    if (cached) {
      if (multiTankPreviewRef.current?.url !== cached) {
        multiTankPreviewRef.current = { layer, url: cached };
      }
      setMultiTankPreview({ layer, url: cached });
      return;
    }
    // While the pointer is moving the GPU cross-section is the preview; composing
    // images for every intermediate layer is what made scrubbing stutter. The
    // settled layer is composed once, when the scrub ends.
    if (isPrintingLayerScrubbing || !isPrintingPreviewSettled) return;

    let cancelled = false;
    void (async () => {
      try {
        let zip = multiTankZipRef.current?.path === multiTankArtifactPath
          ? multiTankZipRef.current.zip
          : null;
        if (!zip) {
          const bytes = await readPrintArtifactBytesFromPath(multiTankArtifactPath);
          zip = await JSZip.loadAsync(bytes);
          multiTankZipRef.current = { path: multiTankArtifactPath, zip };
        }
        const prefix = `layer_${String(layer).padStart(5, '0')}_tank_`;
        const entries = Object.values(zip.files)
          .filter((file) => !file.dir && file.name.startsWith(prefix) && file.name.endsWith('.png'))
          .map((file) => ({
            tankIndex: Number(file.name.slice(prefix.length, -4)) - 1,
            file,
          }))
          .filter((entry) => Number.isFinite(entry.tankIndex) && entry.tankIndex >= 0)
          .sort((a, b) => a.tankIndex - b.tankIndex);
        if (entries.length === 0) {
          if (!cancelled) setMultiTankPreview(null);
          return;
        }
        const blobs = await Promise.all(entries.map(async (entry) => ({
          tankIndex: entry.tankIndex,
          blob: await entry.file.async('blob'),
        })));
        const url = await composeMultiTankLayerPreview(blobs, tankPreviewColours);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        if (multiTankPreviewRef.current) URL.revokeObjectURL(multiTankPreviewRef.current.url);
        const next = { layer, url };
        multiTankPreviewRef.current = next;
        const cache = multiTankPreviewCacheRef.current;
        cache.set(layer, url);
        if (cache.size > 12) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined && oldest !== layer) {
            const evicted = cache.get(oldest);
            cache.delete(oldest);
            if (evicted && evicted !== url) URL.revokeObjectURL(evicted);
          }
        }
        setMultiTankPreview(next);
      } catch {
        if (!cancelled) setMultiTankPreview(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isPrintingLayerScrubbing,
    isPrintingPreviewSettled,
    multiTankArtifactPath,
    printingDisplayedLayer,
    tankPreviewColours,
  ]);

  React.useEffect(() => () => {
    for (const url of multiTankPreviewCacheRef.current.values()) URL.revokeObjectURL(url);
    multiTankPreviewCacheRef.current.clear();
    multiTankPreviewRef.current = null;
  }, []);

  const selectedPrintingLayerPreviewUrl = React.useMemo(() => {
    if (printingDisplayedLayer < 1) return null;
    if (multiTankPreview?.layer === printingDisplayedLayer) return multiTankPreview.url;
    // While a multi-tank composite is being built, the white single-image mask is
    // not shown: it would flash an uncoloured layer first.
    if (multiTankArtifactPath) return null;
    return layerPreviewUrlAt(printingDisplayedLayer);
  }, [layerPreviewUrlAt, multiTankArtifactPath, multiTankPreview, printingDisplayedLayer]);

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

    // Drawn again whenever the pane changes size: the canvas keeps the pixel size it was given,
    // and CSS stretches it to the new box until something redraws it.
    const draw = (image: HTMLImageElement) => {
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
      if (!ctx) return false;

      const naturalWidth = Math.max(1, image.naturalWidth || 1);
      const naturalHeight = Math.max(1, image.naturalHeight || 1);
      const logicalSourceWidth = Math.max(1, targetViewportWidth ?? naturalWidth);
      const logicalSourceHeight = Math.max(1, targetViewportHeight ?? naturalHeight);
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
      return true;
    };

    const renderNonce = ++printingPreviewCanvasRenderNonceRef.current;
    let cancelled = false;
    let loaded: HTMLImageElement | null = null;
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (cancelled) return;
      if (renderNonce !== printingPreviewCanvasRenderNonceRef.current) return;
      if (!draw(image)) return;
      loaded = image;
      setIsPrintingSettledCanvasReady(true);
    };
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          if (!cancelled && loaded) draw(loaded);
        });
    resizeObserver?.observe(viewport);
    image.src = selectedPrintingLayerPreviewUrl;

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
    };
  }, [
    printingPreviewMirrorScale.x,
    printingPreviewMirrorScale.y,
    printingPreviewPan.x,
    printingPreviewPan.y,
    targetViewportHeight,
    targetViewportWidth,
    printingPreviewZoom,
    selectedPrintingLayerPreviewUrl,
    usePrintingSettledHiResCanvas,
  ]);

  return {
    printingPreviewTargetResolution,
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
