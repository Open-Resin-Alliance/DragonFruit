import React from 'react';
import { hotkeyStore } from '@/hotkeys/hotkeyStore';
import {
  getPrinterReachabilitySnapshot,
  setPrinterReachabilityMap,
} from '@/features/network/printerReachabilityStore';
import {
  PrinterMonitoringSnapshot,
  PrinterMonitoringWebcamInfo,
  getProfileMonitoringUiAdapter,
  getProfileNetworkUiAdapter,
} from '@/features/plugins/pluginRegistry';
import {
  normalizePrintingMonitorWebcamAspectRatio,
  parsePrintingMonitorAreaMm2,
  parsePrintingMonitorMaterialMl,
  parsePrintingMonitorSeconds,
  resolvePrintingMonitorAbsoluteUrl,
} from '@/features/printing/printingMonitorFormat';
import {
  FleetUploadMaterialOption,
  PRINTING_MONITOR_DEBUG_CHANNELS,
  PrintingMonitorDebugChannel,
  PrintingMonitorDebugState,
  PrintingMonitorFeatureToggleResponse,
  PrintingMonitorPendingConfirmation,
  PrintingMonitorRecentPlate,
} from '@/features/printing/printingMonitorTypes';
import {
  PrinterNetworkDevice,
  getActivePrinterProfile,
} from '@/features/profiles/profileStore';
import {
  savePrintArtifactWithNativeDialog,
} from '@/features/slicing/tauri/nativeSlicerBridge';
import {
  readBooleanField,
  readJsonObject,
  readNumberField,
  readStringField,
} from '@/utils/jsonFields';
import {
  pluginNetworkFetch,
} from '@/utils/pluginNetworkBridge';
import {
  fetchRtspRelayStatus,
} from '@/utils/rtspRelayBridge';

const DEFAULT_MONITOR_BUSY_GRACE_MS = 30_000;
const REACHABILITY_PROBE_TIMEOUT_MS = 7_500;
const DEFAULT_WEBCAM_TIMEOUT_COOLDOWN_MS = 20_000;
const DEFAULT_WEBCAM_FAILURE_COOLDOWN_MS = 8_000;
const DEFAULT_WEBCAM_MAX_CONSECUTIVE_TIMEOUTS = 3;
const DEFAULT_RTSP_DEBUG_POLL_MS = 4_000;

/**
 * Printing-monitor domain manager: webcam streaming/relay, device status polling,
 * recent plates, target/material selection, dashboard, debug bundles, reachability.
 * Extracted verbatim from Home(); state + all its logic moved together.
 * The 10 deps are values Home owns (profile, network adapter, reachability store,
 * sliced-layer-height, shared ready-plate id, monitor-error toast). All are defined
 * before this hook's call site, so they pass directly (no deps-ref needed).
 */
export type PrintingMonitorManagerDeps = {
  activePrinterProfile: ReturnType<typeof getActivePrinterProfile>;
  setPrintingMonitorError: (nextError: string | null) => void;
  printingReadyPlateId: number | null;
  setPrintingReadyPlateId: React.Dispatch<React.SetStateAction<number | null>>;
  printerReachabilityByDeviceId: ReturnType<typeof getPrinterReachabilitySnapshot>;
  activeNetworkUiAdapter: ReturnType<typeof getProfileNetworkUiAdapter>;
  slicedLayerHeightMm: number;
  isLayerHeightMatch: (candidateLayerHeightMm: number | null | undefined) => boolean;
  printableConnectedPrinterFleet: PrinterNetworkDevice[];
  selectedPrinterProbeTarget: { host: string; port: number } | null;
};

export function usePrintingMonitorManager(deps: PrintingMonitorManagerDeps) {
  const {
    activePrinterProfile,
    setPrintingMonitorError,
    printingReadyPlateId,
    setPrintingReadyPlateId,
    printerReachabilityByDeviceId,
    activeNetworkUiAdapter,
    slicedLayerHeightMm,
    isLayerHeightMatch,
    printableConnectedPrinterFleet,
    selectedPrinterProbeTarget,
  } = deps;

  const [printingTargetPickerOpen, setPrintingTargetPickerOpen] = React.useState(false);

  const [printingTargetPickerMode, setPrintingTargetPickerMode] = React.useState<'post-slice' | 'pre-slice-upload' | 'pre-slice-print'>('post-slice');

  const [printingTargetDeviceId, setPrintingTargetDeviceId] = React.useState<string | null>(null);

  const [printingTargetMaterialId, setPrintingTargetMaterialId] = React.useState<string>('');

  const [printingTargetMaterialOptions, setPrintingTargetMaterialOptions] = React.useState<FleetUploadMaterialOption[]>([]);

  const [isPrintingTargetMaterialsLoading, setIsPrintingTargetMaterialsLoading] = React.useState(false);

  const [printingTargetMaterialError, setPrintingTargetMaterialError] = React.useState<string | null>(null);

  const printingTargetMaterialsCacheRef = React.useRef<Map<string, FleetUploadMaterialOption[]>>(new Map());

  const [printingMonitorSnapshot, setPrintingMonitorSnapshot] = React.useState<PrinterMonitoringSnapshot | null>(null);

  const [printingMonitorWebcamInfo, setPrintingMonitorWebcamInfo] = React.useState<PrinterMonitoringWebcamInfo | null>(null);

  const [printingMonitorRelayBaseWsUrl, setPrintingMonitorRelayBaseWsUrl] = React.useState<string | null>(null);

  const [printingMonitorRelaySetupError, setPrintingMonitorRelaySetupError] = React.useState<string | null>(null);

  const [printingMonitorRelayDebugTransport, setPrintingMonitorRelayDebugTransport] = React.useState<{
    clientPort: number | null;
    serverPort: number | null;
    transportHeader: string | null;
    updatedAtEpochMs: number | null;
  } | null>(null);

  const [printingMonitorRelayReclaimDebug, setPrintingMonitorRelayReclaimDebug] = React.useState<{
    activeSessionId: string | null;
    clientRtpPort: number | null;
    serverRtpPort: number | null;
    lastClaimStatus: string | null;
    lastClaimAtMs: number | null;
    updatedAtMs: number | null;
  } | null>(null);

  const [isPrintingMonitorThumbnailLoaded, setIsPrintingMonitorThumbnailLoaded] = React.useState(false);

  const [printingMonitorThumbnailDisplayUrl, setPrintingMonitorThumbnailDisplayUrl] = React.useState<string | null>(null);

  const [isPrintingMonitorWebcamLoaded, setIsPrintingMonitorWebcamLoaded] = React.useState(false);

  const [printingMonitorWebcamLoadError, setPrintingMonitorWebcamLoadError] = React.useState<string | null>(null);

  const [printingMonitorWebcamAspectRatio, setPrintingMonitorWebcamAspectRatio] = React.useState<number | null>(null);

  const [printingMonitorWebcamRefreshNonce, setPrintingMonitorWebcamRefreshNonce] = React.useState(0);

  const [isPrintingMonitorWebcamResetBusy, setIsPrintingMonitorWebcamResetBusy] = React.useState(false);

  const [isPrintingMonitorWebcamSnapshotSaving, setIsPrintingMonitorWebcamSnapshotSaving] = React.useState(false);

  const [printingMonitorWebcamExpanded, setPrintingMonitorWebcamExpanded] = React.useState(false);

  const [printingMonitorRecentPlates, setPrintingMonitorRecentPlates] = React.useState<PrintingMonitorRecentPlate[]>([]);

  const [isPrintingMonitorRecentPlatesLoading, setIsPrintingMonitorRecentPlatesLoading] = React.useState(false);

  const [printingMonitorRecentPlatesError, setPrintingMonitorRecentPlatesError] = React.useState<string | null>(null);

  const [printingMonitorPlatesStoragePath, setPrintingMonitorPlatesStoragePath] = React.useState<'/local/' | '/usb/'>('/local/');

  const [printingMonitorSelectedPlateId, setPrintingMonitorSelectedPlateId] = React.useState<number | null>(null);

  const [isPrintingMonitorPolling, setIsPrintingMonitorPolling] = React.useState(false);

  const [isPrintingMonitorStatusRequestInFlight, setIsPrintingMonitorStatusRequestInFlight] = React.useState(false);

  const [printingMonitorLastStatusSuccessAtMs, setPrintingMonitorLastStatusSuccessAtMs] = React.useState<number | null>(null);

  const [printingMonitorNowEpochMs, setPrintingMonitorNowEpochMs] = React.useState(() => Date.now());

  const [printingMonitorActionBusy, setPrintingMonitorActionBusy] = React.useState<null | 'start' | 'delete' | 'pause' | 'resume' | 'cancel' | 'emergency-stop' | 'webcam-enable' | 'webcam-disable' | 'timelapse-enable' | 'timelapse-disable'>(null);

  const [printingMonitorControlPendingAction, setPrintingMonitorControlPendingAction] = React.useState<null | 'pause' | 'resume' | 'cancel' | 'emergency-stop'>(null);

  const [printingMonitorActionStatus, setPrintingMonitorActionStatus] = React.useState<string | null>(null);

  const [printingMonitorPendingConfirmation, setPrintingMonitorPendingConfirmation] = React.useState<PrintingMonitorPendingConfirmation | null>(null);

  const [printingMonitorDeviceId, setPrintingMonitorDeviceId] = React.useState<string | null>(null);

  const [printingMonitorViewMode, setPrintingMonitorViewMode] = React.useState<'detail' | 'dashboard'>('detail');

  const [printingMonitorDashboardSnapshots, setPrintingMonitorDashboardSnapshots] = React.useState<Record<string, PrinterMonitoringSnapshot | null>>({});

  const [isPrintingMonitorDashboardRefreshing, setIsPrintingMonitorDashboardRefreshing] = React.useState(false);

  const [isPrintingMonitorPrinterMenuOpen, setIsPrintingMonitorPrinterMenuOpen] = React.useState(false);

  const [isPrintingMonitorPrinterThumbnailFailed, setIsPrintingMonitorPrinterThumbnailFailed] = React.useState(false);

  const [printingMonitorModalOpen, setPrintingMonitorModalOpen] = React.useState(false);

  const [isPrintingMonitorDebugOpen, setIsPrintingMonitorDebugOpen] = React.useState(false);

  const [isPrintingMonitorRtspDebugOpen, setIsPrintingMonitorRtspDebugOpen] = React.useState(false);

  const [printingMonitorDebugCopyState, setPrintingMonitorDebugCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle');

  const [printingMonitorLastFeatureToggleResponse, setPrintingMonitorLastFeatureToggleResponse] = React.useState<PrintingMonitorFeatureToggleResponse | null>(null);

  const [printingMonitorDebugState, setPrintingMonitorDebugState] = React.useState<PrintingMonitorDebugState>({
    status: {
      requestedAtEpochMs: null,
      request: null,
      httpStatus: null,
      rawPayload: null,
      parsedPayload: null,
      error: null,
    },
    webcam: {
      requestedAtEpochMs: null,
      request: null,
      httpStatus: null,
      rawPayload: null,
      parsedPayload: null,
      error: null,
    },
    plates: {
      requestedAtEpochMs: null,
      request: null,
      httpStatus: null,
      rawPayload: null,
      parsedPayload: null,
      error: null,
    },
    taskHistory: {
      requestedAtEpochMs: null,
      request: null,
      httpStatus: null,
      rawPayload: null,
      parsedPayload: null,
      error: null,
    },
    taskDetails: {
      requestedAtEpochMs: null,
      request: null,
      httpStatus: null,
      rawPayload: null,
      parsedPayload: null,
      error: null,
    },
  });

  const printingMonitorPrinterMenuRef = React.useRef<HTMLDivElement | null>(null);

  const printingMonitorWebcamViewportRef = React.useRef<HTMLDivElement | null>(null);

  const printingMonitorThumbnailCacheRef = React.useRef<Map<string, string>>(new Map());

  const printingMonitorWebcamRequestInFlightRef = React.useRef(false);

  const printingMonitorWebcamBusyUntilEpochMsRef = React.useRef(0);

  const printingMonitorWebcamAutoPollBlockedRef = React.useRef(false);

  const printingMonitorWebcamConsecutiveTimeoutsRef = React.useRef(0);

  const printingMonitorRelayAutoRetryCountRef = React.useRef(0);

  const printingMonitorRelayAutoRetryTimeoutRef = React.useRef<number | null>(null);

  const printingMonitorWebcamReadinessTokenRef = React.useRef(0);

  const printingMonitorWebcamReadinessTimeoutRef = React.useRef<number | null>(null);

  const printingMonitorStartFocusDeviceIdRef = React.useRef<string | null>(null);

  const printingMonitorRecentPlatesRequestIdRef = React.useRef(0);

  const printingMonitorRecentPlatesRef = React.useRef<PrintingMonitorRecentPlate[]>([]);

  const printingMonitorSelectedPlateIdRef = React.useRef<number | null>(null);

  const printingMonitorRecentPlatesCacheRef = React.useRef<Map<string, {
    plates: PrintingMonitorRecentPlate[];
    selectedPlateId: number | null;
    error: string | null;
  }>>(new Map());

  const printingMonitorLeftColumnRef = React.useRef<HTMLElement | null>(null);

  const printingMonitorWebcamSectionRef = React.useRef<HTMLElement | null>(null);

  const printingMonitorWebcamFollowerHeightPxRef = React.useRef<number | null>(null);

  const monitorReachabilityInconclusiveCountsRef = React.useRef<Record<string, number>>({});

  const [selectedPrinterMonitorSnapshot, setSelectedPrinterMonitorSnapshot] = React.useState<PrinterMonitoringSnapshot | null>(null);

  const printingMonitoringAdapter = React.useMemo(
    () => getProfileMonitoringUiAdapter(activePrinterProfile?.networkSupport),
    [activePrinterProfile?.networkSupport],
  );

  const printingTargetDevice = React.useMemo(() => {
    if (printableConnectedPrinterFleet.length === 0) return null;
    return printableConnectedPrinterFleet.find((device) => device.id === activePrinterProfile?.activeNetworkDeviceId)
      ?? printableConnectedPrinterFleet.find((device) => device.id === printingTargetDeviceId)
      ?? printableConnectedPrinterFleet[0]
      ?? null;
  }, [activePrinterProfile?.activeNetworkDeviceId, printableConnectedPrinterFleet, printingTargetDeviceId]);

  const monitorSelectableDevices = React.useMemo(() => {
    const fleet = activePrinterProfile?.networkFleet ?? [];
    if (fleet.length === 0) return [] as PrinterNetworkDevice[];
    return fleet.filter((device) => (device.ipAddress || '').trim().length > 0);
  }, [activePrinterProfile?.networkFleet]);

  const dashboardMonitorDevices = React.useMemo(() => {
    if (monitorSelectableDevices.length === 0) return [] as PrinterNetworkDevice[];

    return [...monitorSelectableDevices].sort((a, b) => {
      const aOffline = printerReachabilityByDeviceId[a.id] === false || a.connected !== true;
      const bOffline = printerReachabilityByDeviceId[b.id] === false || b.connected !== true;
      if (aOffline === bOffline) return 0;
      return aOffline ? 1 : -1;
    });
  }, [monitorSelectableDevices, printerReachabilityByDeviceId]);

  const dashboardOnlineMonitorDevices = React.useMemo(() => {
    return monitorSelectableDevices.filter((device) => {
      const hasHost = (device.ipAddress || '').trim().length > 0;
      if (!hasHost) return false;
      if (printerReachabilityByDeviceId[device.id] === false) return false;
      return device.connected === true;
    });
  }, [monitorSelectableDevices, printerReachabilityByDeviceId]);

  const monitoringDevice = React.useMemo(() => {
    if (monitorSelectableDevices.length > 0) {
      return monitorSelectableDevices.find((device) => device.id === printingMonitorDeviceId)
        ?? monitorSelectableDevices.find((device) => device.id === activePrinterProfile?.activeNetworkDeviceId)
        ?? monitorSelectableDevices.find((device) => device.id === printingTargetDevice?.id)
        ?? monitorSelectableDevices[0]
        ?? null;
    }
    return null;
  }, [activePrinterProfile?.activeNetworkDeviceId, monitorSelectableDevices, printingMonitorDeviceId, printingTargetDevice?.id]);

  const monitoringDeviceId = monitoringDevice?.id ?? null;

  const monitoringDeviceHost = React.useMemo(() => {
    return (monitoringDevice?.ipAddress || '').trim();
  }, [monitoringDevice?.ipAddress]);

  const monitoringDevicePort = monitoringDevice?.port || 80;

  const monitoringDeviceMainboardId = React.useMemo(() => {
    if (!monitoringDeviceId) return null;
    if (!monitoringDeviceId.includes('-')) return monitoringDeviceId;
    return monitoringDeviceId.split('-').pop() ?? monitoringDeviceId;
  }, [monitoringDeviceId]);

  const printingMonitorRecentPlatesCacheKey = React.useMemo(() => {
    if (!monitoringDeviceHost) return null;
    const pluginId = (printingMonitoringAdapter.pluginId ?? '').trim();
    if (!pluginId) return null;
    return `${pluginId}|${monitoringDeviceId ?? 'unknown'}|${monitoringDeviceHost.toLowerCase()}:${monitoringDevicePort}|${printingMonitorPlatesStoragePath}`;
  }, [
    monitoringDeviceHost,
    monitoringDeviceId,
    monitoringDevicePort,
    printingMonitorPlatesStoragePath,
    printingMonitoringAdapter.pluginId,
  ]);

  const printingTargetMaterialGroups = React.useMemo(() => {
    const groups = new Map<string, FleetUploadMaterialOption[]>();
    for (const material of printingTargetMaterialOptions) {
      const label = material.layerHeightMm == null
        ? 'Layer height unknown'
        : '';
      const bucket = groups.get(label);
      if (bucket) {
        bucket.push(material);
      } else {
        groups.set(label, [material]);
      }
    }
    return Array.from(groups.entries()).map(([label, materials]) => ({ label, materials }));
  }, [printingTargetMaterialOptions]);

  const requiresRemoteMaterialSelectionForUpload = Boolean(
    activeNetworkUiAdapter
    && activeNetworkUiAdapter.supportsRemoteMaterialProfiles !== false,
  );

  const isPreSliceTargetPicker = printingTargetPickerMode !== 'post-slice';

  const printingMonitorPlateId = React.useMemo(() => {
    const candidate = printingMonitorSnapshot?.plateId ?? printingReadyPlateId;
    if (candidate == null || !Number.isFinite(candidate) || candidate <= 0) return null;
    return Math.round(candidate);
  }, [printingMonitorSnapshot?.plateId, printingReadyPlateId]);

  const printingMonitorThumbnailUrl = React.useMemo(() => {
    if (!monitoringDevice) return null;
    const host = (monitoringDevice.ipAddress || '').trim();
    if (!host) return null;
    const port = monitoringDevice.port || 80;

    const metadataThumbnail = typeof printingMonitorSnapshot?.thumbnailPath === 'string'
      ? printingMonitorSnapshot.thumbnailPath.trim()
      : '';
    if (metadataThumbnail) {
      const resolved = resolvePrintingMonitorAbsoluteUrl(metadataThumbnail, host, port);
      if (resolved) return resolved;
    }

    if (printingMonitorPlateId == null) return null;
    const base = `http://${host}${port === 80 ? '' : `:${port}`}`;
    return `${base}/static/plates/${printingMonitorPlateId}/3d.png`;
  }, [monitoringDevice, printingMonitorPlateId, printingMonitorSnapshot?.thumbnailPath]);

  const printingMonitorThumbnailCacheKey = React.useMemo(() => {
    if (!monitoringDevice || !printingMonitorThumbnailUrl) return null;
    const host = (monitoringDevice.ipAddress || '').trim();
    if (!host) return null;
    const port = monitoringDevice.port || 80;
    return `${host}:${port}|${printingMonitorThumbnailUrl}`;
  }, [monitoringDevice, printingMonitorThumbnailUrl]);

  const printingMonitorInlineWebcamUrl = React.useMemo(() => {
    const candidates = [
      printingMonitorWebcamInfo?.streamUrl,
      printingMonitorWebcamInfo?.snapshotUrl,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    return candidates.find((value) => /^https?:\/\//i.test(value)
      || /^wss?:\/\//i.test(value)
      || /^data:/i.test(value)
      || /^blob:/i.test(value));
  }, [printingMonitorWebcamInfo?.snapshotUrl, printingMonitorWebcamInfo?.streamUrl]);

  const printingMonitorRtspSourceUrl = React.useMemo(() => {
    const candidates = [
      printingMonitorWebcamInfo?.streamUrl,
      printingMonitorWebcamInfo?.snapshotUrl,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    return candidates.find((value) => /^rtsps?:\/\//i.test(value)) ?? null;
  }, [printingMonitorWebcamInfo?.snapshotUrl, printingMonitorWebcamInfo?.streamUrl]);

  const printingMonitorIsDesktopRuntime = React.useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.location.protocol === 'tauri:'
      || window.location.protocol === 'file:'
      || window.location.hostname === 'tauri.localhost'
      || typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
  }, []);

  React.useEffect(() => {
    if (!printingMonitorRtspSourceUrl || !printingMonitorModalOpen) {
      setPrintingMonitorRelayBaseWsUrl(null);
      setPrintingMonitorRelaySetupError(null);
      setPrintingMonitorRelayDebugTransport(null);
      setPrintingMonitorRelayReclaimDebug(null);
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const refreshRelayDebug = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const relayStatus = await fetchRtspRelayStatus(printingMonitorRtspSourceUrl);
        const response = { ok: relayStatus.ok, status: relayStatus.status };
        const payload = relayStatus.payload ?? null;
        if (cancelled) return;

        const wsBaseUrl = typeof payload?.wsBaseUrl === 'string'
          ? payload.wsBaseUrl.trim()
          : '';
        if (response.ok && /^wss?:\/\//i.test(wsBaseUrl)) {
          setPrintingMonitorRelayBaseWsUrl(wsBaseUrl);
          setPrintingMonitorRelaySetupError(null);
          const debugTransport = payload?.rtspDebugTransport && typeof payload.rtspDebugTransport === 'object'
            ? {
                clientPort: typeof payload.rtspDebugTransport.clientPort === 'number' ? payload.rtspDebugTransport.clientPort : null,
                serverPort: typeof payload.rtspDebugTransport.serverPort === 'number' ? payload.rtspDebugTransport.serverPort : null,
                transportHeader: typeof payload.rtspDebugTransport.transportHeader === 'string'
                  ? payload.rtspDebugTransport.transportHeader
                  : null,
                updatedAtEpochMs: typeof payload.rtspDebugTransport.updatedAtEpochMs === 'number'
                  ? payload.rtspDebugTransport.updatedAtEpochMs
                  : null,
              }
            : null;
          const reclaimDebug = payload?.rtspReclaimDebug && typeof payload.rtspReclaimDebug === 'object'
            ? {
                activeSessionId: typeof payload.rtspReclaimDebug.activeSessionId === 'string'
                  ? payload.rtspReclaimDebug.activeSessionId
                  : null,
                clientRtpPort: typeof payload.rtspReclaimDebug.clientRtpPort === 'number'
                  ? payload.rtspReclaimDebug.clientRtpPort
                  : null,
                serverRtpPort: typeof payload.rtspReclaimDebug.serverRtpPort === 'number'
                  ? payload.rtspReclaimDebug.serverRtpPort
                  : null,
                lastClaimStatus: typeof payload.rtspReclaimDebug.lastClaimStatus === 'string'
                  ? payload.rtspReclaimDebug.lastClaimStatus
                  : null,
                lastClaimAtMs: typeof payload.rtspReclaimDebug.lastClaimAtMs === 'number'
                  ? payload.rtspReclaimDebug.lastClaimAtMs
                  : null,
                updatedAtMs: typeof payload.rtspReclaimDebug.updatedAtMs === 'number'
                  ? payload.rtspReclaimDebug.updatedAtMs
                  : null,
              }
            : null;
          setPrintingMonitorRelayDebugTransport(debugTransport);
          setPrintingMonitorRelayReclaimDebug(reclaimDebug);
          return;
        }

        const payloadError = typeof payload?.error === 'string' ? payload.error.trim() : '';
        const fallbackError = 'RTSP relay endpoint returned no websocket base URL.';
        setPrintingMonitorRelayBaseWsUrl(null);
        setPrintingMonitorRelaySetupError(payloadError || fallbackError);
        setPrintingMonitorRelayDebugTransport(null);
        setPrintingMonitorRelayReclaimDebug(null);
      } catch (error) {
        if (!cancelled) {
          setPrintingMonitorRelayBaseWsUrl(null);
          const message = error instanceof Error ? error.message : 'Unable to reach RTSP relay endpoint.';
          setPrintingMonitorRelaySetupError(message);
          setPrintingMonitorRelayDebugTransport(null);
          setPrintingMonitorRelayReclaimDebug(null);
        }
      } finally {
        inFlight = false;
      }
    };

    void refreshRelayDebug();
    const intervalId = window.setInterval(() => {
      void refreshRelayDebug();
    }, DEFAULT_RTSP_DEBUG_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [printingMonitorModalOpen, printingMonitorRtspSourceUrl]);

  const printingMonitorWebcamUrl = React.useMemo(() => {
    if (printingMonitorInlineWebcamUrl) return printingMonitorInlineWebcamUrl;

    if (!printingMonitorRtspSourceUrl || !printingMonitorRelayBaseWsUrl) return null;

    const relayQueryUrl = encodeURIComponent(printingMonitorRtspSourceUrl);
    return `${printingMonitorRelayBaseWsUrl}?url=${relayQueryUrl}`;
  }, [printingMonitorInlineWebcamUrl, printingMonitorRelayBaseWsUrl, printingMonitorRtspSourceUrl]);

  const printingMonitorWebcamUsesRelayWs = React.useMemo(() => {
    const candidate = (printingMonitorWebcamUrl ?? '').trim();
    return /^wss?:\/\//i.test(candidate);
  }, [printingMonitorWebcamUrl]);

  const printingMonitorRtspDebugSummary = React.useMemo(() => {
    if (printingMonitorInlineWebcamUrl) {
      return {
        title: 'Inline webcam transport',
        description: 'The monitor is using the printer-provided HTTP/data/blob stream directly, so no RTSP relay is involved.',
      };
    }

    if (printingMonitorRtspSourceUrl && printingMonitorRelayBaseWsUrl) {
      return {
        title: 'RTSP relay transport',
        description: 'The printer reported an RTSP source and the monitor is bridging it through the local relay websocket.',
      };
    }

    if (printingMonitorRtspSourceUrl) {
      if (printingMonitorIsDesktopRuntime && printingMonitorRelaySetupError) {
        return {
          title: 'RTSP relay unavailable',
          description: `The printer reported an RTSP URL, but the relay endpoint could not be initialized in this bundled runtime (${printingMonitorRelaySetupError}).`,
        };
      }

      return {
        title: 'RTSP source detected',
        description: 'The printer reported an RTSP URL, but the local relay websocket is not ready yet.',
      };
    }

    return {
      title: 'No RTSP source',
      description: 'The printer did not report an RTSP webcam URL for this monitor session.',
    };
  }, [
    printingMonitorInlineWebcamUrl,
    printingMonitorIsDesktopRuntime,
    printingMonitorRelayBaseWsUrl,
    printingMonitorRelaySetupError,
    printingMonitorRtspSourceUrl,
  ]);

  const printingMonitorHasCamera = activePrinterProfile?.hasCamera !== false;

  const printingMonitorUsesTwoColumnDetailLayout = printingMonitorHasCamera;

  const printingMonitorModalWidthClass = printingMonitorViewMode === 'detail' && !printingMonitorUsesTwoColumnDetailLayout
    ? 'w-[min(760px,94vw)]'
    : 'w-[min(1120px,94vw)]';

  const printingMonitorWebcamStatusPresentation = React.useMemo(() => {
    const rawMessage = (printingMonitorWebcamInfo?.message ?? 'No webcam feed reported yet.').trim();
    const messageLower = rawMessage.toLowerCase();

    if (messageLower.includes('stream limit') || messageLower.includes('simultaneous')) {
      return {
        tone: 'warning' as const,
        title: 'Video Stream Busy',
        description: rawMessage,
      };
    }

    if (messageLower.includes('failed') || messageLower.includes('error') || messageLower.includes('unable')) {
      return {
        tone: 'error' as const,
        title: 'Webcam Unavailable',
        description: rawMessage,
      };
    }

    return {
      tone: 'neutral' as const,
      title: 'Webcam Not Ready',
      description: rawMessage,
    };
  }, [printingMonitorWebcamInfo?.message]);

  const printingMonitorWebcamDisplayPresentation = React.useMemo(() => {
    if (printingMonitorWebcamLoadError) {
      return {
        tone: 'error' as const,
        title: 'Webcam Unavailable',
        description: printingMonitorWebcamLoadError,
      };
    }

    return printingMonitorWebcamStatusPresentation;
  }, [printingMonitorWebcamLoadError, printingMonitorWebcamStatusPresentation]);

  const printingMonitorUiPolicy = React.useMemo(() => {
    return printingMonitoringAdapter.getMonitoringUiPolicy?.() ?? null;
  }, [printingMonitoringAdapter]);

  const printingMonitorBusyGraceMs = printingMonitorUiPolicy?.busyResponseGraceMs ?? DEFAULT_MONITOR_BUSY_GRACE_MS;

  const printingMonitorReachabilityMaxInconclusivePolls = printingMonitorUiPolicy?.inconclusiveReachabilityMaxPolls ?? null;

  const printingMonitorSupportsWebcamStreamSlotReset = Boolean(printingMonitorUiPolicy?.supportsWebcamStreamSlotReset);

  const printingMonitorWebcamMaxConsecutiveTimeouts = printingMonitorUiPolicy?.webcamMaxConsecutiveTimeouts ?? DEFAULT_WEBCAM_MAX_CONSECUTIVE_TIMEOUTS;

  const printingMonitorWebcamTimeoutCooldownMs = printingMonitorUiPolicy?.webcamTimeoutCooldownMs ?? DEFAULT_WEBCAM_TIMEOUT_COOLDOWN_MS;

  const printingMonitorWebcamFailureCooldownMs = printingMonitorUiPolicy?.webcamFailureCooldownMs ?? DEFAULT_WEBCAM_FAILURE_COOLDOWN_MS;

  const printingMonitorWebcamCanResetStreamSlot = React.useMemo(() => {
    if (!printingMonitorSupportsWebcamStreamSlotReset) return false;
    const messageLower = String(printingMonitorWebcamInfo?.message ?? '').toLowerCase();
    if (!messageLower) return false;
    return messageLower.includes('stream limit') || messageLower.includes('simultaneous');
  }, [printingMonitorSupportsWebcamStreamSlotReset, printingMonitorWebcamInfo?.message]);

  const monitorWebcamRotationDeg = React.useMemo(() => {
    const candidate = Number(activePrinterProfile?.display.webcamRotationDeg ?? 0);
    if (candidate === 0 || candidate === 90 || candidate === 180 || candidate === 270) {
      return candidate as 0 | 90 | 180 | 270;
    }
    return 0;
  }, [activePrinterProfile?.display.webcamRotationDeg]);

  const shouldSwapMonitorWebcamAspect = React.useMemo(() => {
    return monitorWebcamRotationDeg === 90 || monitorWebcamRotationDeg === 270;
  }, [monitorWebcamRotationDeg]);

  const monitorWebcamTransform = React.useMemo(() => {
    const rotate = monitorWebcamRotationDeg !== 0
      ? `rotate(${monitorWebcamRotationDeg}deg)`
      : '';
    const scale = shouldSwapMonitorWebcamAspect
      ? ` scale(${printingMonitorWebcamAspectRatio ?? 1})`
      : '';
    const combined = `${rotate}${scale}`.trim();
    return combined.length > 0 ? combined : undefined;
  }, [monitorWebcamRotationDeg, printingMonitorWebcamAspectRatio, shouldSwapMonitorWebcamAspect]);

  const printingMonitorCanExpandWebcam = React.useMemo(() => {
    return Boolean(
      printingMonitorModalOpen
      && printingMonitorViewMode === 'detail'
      && printingMonitorUsesTwoColumnDetailLayout
      && printingMonitorHasCamera
    );
  }, [
    printingMonitorHasCamera,
    printingMonitorModalOpen,
    printingMonitorUsesTwoColumnDetailLayout,
    printingMonitorViewMode,
  ]);

  const printingMonitorDetailWebcamExpanded = printingMonitorCanExpandWebcam && printingMonitorWebcamExpanded;

  const monitorWebcamDisplayAspectRatio = React.useMemo(() => {
    const normalizedAspect = normalizePrintingMonitorWebcamAspectRatio(printingMonitorWebcamAspectRatio);
    if (normalizedAspect == null) {
      return null;
    }
    return shouldSwapMonitorWebcamAspect
      ? (1 / normalizedAspect)
      : normalizedAspect;
  }, [printingMonitorWebcamAspectRatio, shouldSwapMonitorWebcamAspect]);

  const printingMonitorStateTextNormalized = React.useMemo(() => {
    return String(printingMonitorSnapshot?.stateText ?? '').trim().toLowerCase();
  }, [printingMonitorSnapshot?.stateText]);

  const printingMonitorIsPauseTransition = React.useMemo(() => {
    return Boolean(
      printingMonitorSnapshot?.pauseLatched
      || printingMonitorStateTextNormalized === 'pausing',
    );
  }, [printingMonitorSnapshot?.pauseLatched, printingMonitorStateTextNormalized]);

  const printingMonitorIsCancelTransition = React.useMemo(() => {
    return Boolean(
      printingMonitorStateTextNormalized === 'canceling'
      || (printingMonitorSnapshot?.cancelLatched && printingMonitorStateTextNormalized !== 'idle'),
    );
  }, [printingMonitorSnapshot?.cancelLatched, printingMonitorStateTextNormalized]);

  const printingMonitorHasActivePrint = React.useMemo(() => {
    return Boolean(
      printingMonitorSnapshot?.isPrinting
      || printingMonitorSnapshot?.isPaused
      || printingMonitorIsCancelTransition
      || printingMonitorIsPauseTransition
    );
  }, [
    printingMonitorSnapshot?.isPaused,
    printingMonitorSnapshot?.isPrinting,
    printingMonitorIsCancelTransition,
    printingMonitorIsPauseTransition,
  ]);

  const printingMonitorAnyActionBusy = React.useMemo(() => {
    return printingMonitorActionBusy !== null || printingMonitorControlPendingAction !== null;
  }, [printingMonitorActionBusy, printingMonitorControlPendingAction]);

  const printingMonitorCancelButtonAnimating = React.useMemo(() => {
    return Boolean(
      printingMonitorControlPendingAction === 'cancel'
      || printingMonitorIsCancelTransition
      || printingMonitorActionBusy === 'cancel',
    );
  }, [printingMonitorActionBusy, printingMonitorControlPendingAction, printingMonitorIsCancelTransition]);

  const printingMonitorPauseButtonAnimating = React.useMemo(() => {
    return Boolean(
      printingMonitorControlPendingAction === 'pause'
      || printingMonitorControlPendingAction === 'resume'
      || printingMonitorIsPauseTransition
      || printingMonitorActionBusy === 'pause'
      || printingMonitorActionBusy === 'resume',
    );
  }, [
    printingMonitorActionBusy,
    printingMonitorControlPendingAction,
    printingMonitorIsPauseTransition,
  ]);

  const printingMonitorPauseButtonDisabled = React.useMemo(() => {
    if (!printingMonitoringAdapter.operations || !printingMonitorHasActivePrint) return true;
    if (printingMonitorIsCancelTransition || printingMonitorControlPendingAction === 'cancel') return true;
    if (printingMonitorIsPauseTransition || printingMonitorControlPendingAction === 'pause') return true;
    return (
      printingMonitorActionBusy === 'start'
      || printingMonitorActionBusy === 'delete'
      || printingMonitorActionBusy === 'pause'
      || printingMonitorActionBusy === 'resume'
      || printingMonitorActionBusy === 'emergency-stop'
      || printingMonitorControlPendingAction === 'resume'
      || printingMonitorControlPendingAction === 'emergency-stop'
    );
  }, [
    printingMonitorActionBusy,
    printingMonitorControlPendingAction,
    printingMonitorHasActivePrint,
    printingMonitorIsCancelTransition,
    printingMonitorIsPauseTransition,
    printingMonitoringAdapter.operations,
  ]);

  const printingMonitorCancelButtonDisabled = React.useMemo(() => {
    if (!printingMonitoringAdapter.operations || !printingMonitorHasActivePrint) return true;
    if (printingMonitorIsPauseTransition || printingMonitorIsCancelTransition) return true;
    return printingMonitorAnyActionBusy;
  }, [
    printingMonitorAnyActionBusy,
    printingMonitorHasActivePrint,
    printingMonitorIsCancelTransition,
    printingMonitorIsPauseTransition,
    printingMonitoringAdapter.operations,
  ]);

  const printingMonitorEmergencyStopDisabled = React.useMemo(() => {
    if (!printingMonitoringAdapter.operations) return true;
    return (
      printingMonitorActionBusy === 'start'
      || printingMonitorActionBusy === 'delete'
      || printingMonitorActionBusy === 'pause'
      || printingMonitorActionBusy === 'resume'
      || printingMonitorActionBusy === 'emergency-stop'
      || printingMonitorControlPendingAction === 'pause'
      || printingMonitorControlPendingAction === 'resume'
      || printingMonitorControlPendingAction === 'emergency-stop'
    );
  }, [printingMonitorActionBusy, printingMonitorControlPendingAction, printingMonitoringAdapter.operations]);

  const printingMonitorDisplayProgressPct = React.useMemo(() => {
    if (!printingMonitorHasActivePrint) return null;
    const totalRaw = printingMonitorSnapshot?.totalLayers;
    const currentRaw = printingMonitorSnapshot?.currentLayer;
    const totalNumeric = Number(totalRaw);
    const currentNumeric = Number(currentRaw);
    if (!Number.isFinite(totalNumeric) || !Number.isFinite(currentNumeric)) return null;

    const total = Math.max(0, Math.round(totalNumeric));
    const current = Math.max(0, Math.round(currentNumeric));
    if (total <= 0) return null;

    const completedLayers = Math.max(0, Math.min(total, current - 1));
    return (completedLayers / total) * 100;
  }, [printingMonitorHasActivePrint, printingMonitorSnapshot?.currentLayer, printingMonitorSnapshot?.totalLayers]);

  const printingMonitorDisplayCurrentLayer = React.useMemo(() => {
    if (!printingMonitorHasActivePrint) return null;
    const raw = printingMonitorSnapshot?.currentLayer;
    if (raw == null || !Number.isFinite(raw) || raw < 0) return null;
    return Math.max(0, Math.round(raw));
  }, [printingMonitorHasActivePrint, printingMonitorSnapshot?.currentLayer]);

  const printingMonitorDisplayTotalLayers = React.useMemo(() => {
    if (!printingMonitorHasActivePrint) return null;
    const raw = printingMonitorSnapshot?.totalLayers;
    if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
    return Math.round(raw);
  }, [printingMonitorHasActivePrint, printingMonitorSnapshot?.totalLayers]);

  const printingMonitorDisplayMaterialProfile = React.useMemo(() => {
    if (!printingMonitorHasActivePrint) return '—';

    const activePlateId = printingMonitorPlateId;
    if (activePlateId != null) {
      const activePlate = printingMonitorRecentPlates.find((plate) => plate.plateId === activePlateId);
      if (activePlate?.materialProfileName) return activePlate.materialProfileName;
    }

    if (printingMonitorSelectedPlateId != null) {
      const selectedPlate = printingMonitorRecentPlates.find((plate) => plate.plateId === printingMonitorSelectedPlateId);
      if (selectedPlate?.materialProfileName) return selectedPlate.materialProfileName;
    }

    return '—';
  }, [printingMonitorHasActivePrint, printingMonitorPlateId, printingMonitorRecentPlates, printingMonitorSelectedPlateId]);

  const isPrintingMonitorSelectedPrinterOfflineRaw = React.useMemo(() => {
    const monitorHost = (monitoringDevice?.ipAddress || activePrinterProfile?.network?.ipAddress || '').trim();
    if (!monitorHost) return false;

    if (printingMonitorSnapshot?.connected === true) {
      return false;
    }

    if (monitoringDevice) {
      if (printerReachabilityByDeviceId[monitoringDevice.id] !== true) return true;
      return monitoringDevice.connected !== true;
    }

    return activePrinterProfile?.networkConnection?.connected === false;
  }, [
    activePrinterProfile?.network?.ipAddress,
    activePrinterProfile?.networkConnection?.connected,
    monitoringDevice,
    printingMonitorSnapshot?.connected,
    printerReachabilityByDeviceId,
  ]);

  const isPrintingMonitorWithinSlowResponseGrace = React.useMemo(() => {
    if (!printingMonitorModalOpen) return false;
    if (printingMonitorLastStatusSuccessAtMs == null) return false;
    return (printingMonitorNowEpochMs - printingMonitorLastStatusSuccessAtMs) <= printingMonitorBusyGraceMs;
  }, [
    printingMonitorLastStatusSuccessAtMs,
    printingMonitorModalOpen,
    printingMonitorNowEpochMs,
    printingMonitorBusyGraceMs,
  ]);

  const printingMonitorSlowResponseGraceRemainingSec = React.useMemo(() => {
    if (!isPrintingMonitorWithinSlowResponseGrace || printingMonitorLastStatusSuccessAtMs == null) return 0;
    const remainingMs = Math.max(0, printingMonitorBusyGraceMs - (printingMonitorNowEpochMs - printingMonitorLastStatusSuccessAtMs));
    return Math.ceil(remainingMs / 1000);
  }, [
    isPrintingMonitorWithinSlowResponseGrace,
    printingMonitorLastStatusSuccessAtMs,
    printingMonitorNowEpochMs,
    printingMonitorBusyGraceMs,
  ]);

  const shouldShowPrintingMonitorSlowResponseCard = React.useMemo(() => {
    return isPrintingMonitorSelectedPrinterOfflineRaw && isPrintingMonitorWithinSlowResponseGrace;
  }, [isPrintingMonitorSelectedPrinterOfflineRaw, isPrintingMonitorWithinSlowResponseGrace]);

  const isPrintingMonitorSelectedPrinterOffline = React.useMemo(() => {
    if (isPrintingMonitorSelectedPrinterOfflineRaw && isPrintingMonitorWithinSlowResponseGrace) {
      return false;
    }
    return isPrintingMonitorSelectedPrinterOfflineRaw;
  }, [
    isPrintingMonitorSelectedPrinterOfflineRaw,
    isPrintingMonitorWithinSlowResponseGrace,
  ]);

  const hasMonitorSelectableTarget = monitorSelectableDevices.length > 0;

  const hasPrintingMonitorFleet = monitorSelectableDevices.length > 1;

  const printingMonitorPrinterThumbnailSrc = React.useMemo(() => {
    const source = activePrinterProfile?.imageDataUrl;
    if (typeof source !== 'string') return null;
    const trimmed = source.trim();
    if (!trimmed || isPrintingMonitorPrinterThumbnailFailed) return null;
    return trimmed;
  }, [activePrinterProfile?.imageDataUrl, isPrintingMonitorPrinterThumbnailFailed]);

  const printingMonitorHeaderUsesFleetLabelOrder = React.useMemo(() => {
    return (activePrinterProfile?.networkFleet?.length ?? 0) > 1;
  }, [activePrinterProfile?.networkFleet]);

  const printingMonitorHeaderTopLabel = React.useMemo(() => {
    if (printingMonitorHeaderUsesFleetLabelOrder) {
      return activePrinterProfile?.name ?? 'Select Profile';
    }
    return 'Printer';
  }, [activePrinterProfile?.name, printingMonitorHeaderUsesFleetLabelOrder]);

  const printingMonitorHeaderBottomLabel = React.useMemo(() => {
    const selectedPrinterName = monitoringDevice?.displayName || monitoringDevice?.hostName || monitoringDevice?.ipAddress || 'Selected printer';
    return selectedPrinterName;
  }, [monitoringDevice?.displayName, monitoringDevice?.hostName, monitoringDevice?.ipAddress]);

  const printingMonitorHeaderTitle = React.useMemo(() => {
    if (printingMonitorHeaderUsesFleetLabelOrder) {
      return `Printer profile: ${printingMonitorHeaderTopLabel} • Active printer: ${printingMonitorHeaderBottomLabel}`;
    }
    return `Monitored printer: ${printingMonitorHeaderBottomLabel}`;
  }, [printingMonitorHeaderBottomLabel, printingMonitorHeaderTopLabel, printingMonitorHeaderUsesFleetLabelOrder]);

  const showTopbarMonitorButton = React.useMemo(() => {
    const hasMonitoring = Boolean(
      printingMonitoringAdapter.available
      && printingMonitoringAdapter.pluginId
      && printingMonitoringAdapter.operations
    );
    if (!hasMonitoring) return false;
    if (!hasMonitorSelectableTarget) return false;
    return true;
  }, [hasMonitorSelectableTarget, printingMonitoringAdapter]);

  React.useEffect(() => {
    printingMonitorRecentPlatesRef.current = printingMonitorRecentPlates;
  }, [printingMonitorRecentPlates]);

  React.useEffect(() => {
    printingMonitorSelectedPlateIdRef.current = printingMonitorSelectedPlateId;
  }, [printingMonitorSelectedPlateId]);

  React.useEffect(() => {
    if (!printingMonitorModalOpen) return;

    setPrintingMonitorNowEpochMs(Date.now());
    const intervalId = window.setInterval(() => {
      setPrintingMonitorNowEpochMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [printingMonitorModalOpen]);

  React.useEffect(() => {
    if (!printingMonitorModalOpen) return;
    setPrintingMonitorLastStatusSuccessAtMs(null);
    setIsPrintingMonitorStatusRequestInFlight(false);
  }, [monitoringDevice?.id, printingMonitorModalOpen]);

  React.useEffect(() => {
    const shouldProbeFleetReachability = Boolean(
      activeNetworkUiAdapter
      && printingMonitoringAdapter.available
      && printingMonitoringAdapter.pluginId
      && printingMonitoringAdapter.operations?.status,
    );

    if (!shouldProbeFleetReachability) {
      monitorReachabilityInconclusiveCountsRef.current = {};
      return;
    }

    const probeFleet = (activePrinterProfile?.networkFleet ?? []).filter((device) => {
      const host = (device.ipAddress || '').trim();
      return host.length > 0;
    });

    if (probeFleet.length === 0) {
      monitorReachabilityInconclusiveCountsRef.current = {};
      return;
    }

    let cancelled = false;

    const probeWithTimeout = async (device: PrinterNetworkDevice): Promise<boolean | null> => {
      const host = (device.ipAddress || '').trim();
      const port = device.port || 80;
      if (!host) return false;

      // Deterministic debug behavior for local dummy endpoints.
      const normalizedHost = host.toLowerCase();
      const normalizedName = `${device.displayName ?? ''} ${device.hostName ?? ''}`.toLowerCase();
      if (normalizedHost.endsWith('999.999') || normalizedName.includes('debug dummy athena a')) {
        return true;
      }
      if (normalizedHost.endsWith('999.998') || normalizedName.includes('debug dummy athena b')) {
        return false;
      }

      try {
        const result = await Promise.race<boolean | null>([
          pluginNetworkFetch({
            pluginId: printingMonitoringAdapter.pluginId!,
            operation: printingMonitoringAdapter.operations!.status,
            ipAddress: host,
            port,
          })
            .then(async (response) => {
              if (!response.ok) return false;

              const payload = await readJsonObject(response);
              const payloadOk = readBooleanField(payload, 'ok');
              if (payloadOk != null) {
                return payloadOk === true;
              }

              try {
                const parsed = printingMonitoringAdapter.parseStatusPayload(payload, `reachability:${host}:${port}`);
                if (parsed && typeof parsed.connected === 'boolean') {
                  return parsed.connected;
                }
              } catch {
                // Ignore parse errors and fall back to HTTP success semantics.
              }

              return true;
            })
            .catch(() => null),
          new Promise<null>((resolve) => {
            window.setTimeout(() => resolve(null), REACHABILITY_PROBE_TIMEOUT_MS);
          }),
        ]);

        return result;
      } catch {
        return null;
      }
    };

    const probeAll = async () => {
      const entries = await Promise.all(
        probeFleet.map(async (device) => {
          const reachable = await probeWithTimeout(device);
          return [device.id, reachable] as const;
        }),
      );

      if (cancelled) return;

      const previousReachability = getPrinterReachabilitySnapshot();
      const previousInconclusiveCounts = monitorReachabilityInconclusiveCountsRef.current;
      const nextInconclusiveCounts: Record<string, number> = {};
      const nextMap: Record<string, boolean | null> = {};
      const maxUnknownPolls = Math.max(1, printingMonitorReachabilityMaxInconclusivePolls ?? 1);
      for (const [id, reachable] of entries) {
        if (reachable === true) {
          nextMap[id] = true;
          nextInconclusiveCounts[id] = 0;
          continue;
        }

        if (reachable === false) {
          nextMap[id] = false;
          nextInconclusiveCounts[id] = 0;
          continue;
        }

        const unknownCount = (previousInconclusiveCounts[id] ?? 0) + 1;
        nextInconclusiveCounts[id] = unknownCount;

        const keepPreviousOnline = previousReachability[id] === true && unknownCount < maxUnknownPolls;
        nextMap[id] = keepPreviousOnline ? true : false;
      }

      monitorReachabilityInconclusiveCountsRef.current = nextInconclusiveCounts;
      const mergedMap: Record<string, boolean | null> = {
        ...previousReachability,
        ...nextMap,
      };
      setPrinterReachabilityMap(mergedMap);
    };

    void probeAll();

    const intervalId = window.setInterval(() => {
      void probeAll();
    }, 9000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    activeNetworkUiAdapter,
    activePrinterProfile?.networkFleet,
    printingMonitoringAdapter,
  ]);

  React.useEffect(() => {
    if (!printingTargetPickerOpen) return;
    if (!printingTargetDeviceId) return;
    if (printerReachabilityByDeviceId[printingTargetDeviceId] !== false) return;

    const fallbackOnline = printableConnectedPrinterFleet.find(
      (device) => printerReachabilityByDeviceId[device.id] !== false,
    );
    if (fallbackOnline) {
      setPrintingTargetDeviceId(fallbackOnline.id);
    }
  }, [
    printableConnectedPrinterFleet,
    printerReachabilityByDeviceId,
    printingTargetDeviceId,
    printingTargetPickerOpen,
  ]);

  React.useEffect(() => {
    if (!showTopbarMonitorButton && printingMonitorModalOpen) {
      setPrintingMonitorModalOpen(false);
    }
  }, [printingMonitorModalOpen, showTopbarMonitorButton]);

  React.useEffect(() => {
    if (!printingTargetPickerOpen) {
      setIsPrintingTargetMaterialsLoading(false);
      return;
    }
    if (!requiresRemoteMaterialSelectionForUpload) {
      setPrintingTargetMaterialOptions([]);
      setPrintingTargetMaterialId('__local_profile__');
      setPrintingTargetMaterialError(null);
      setIsPrintingTargetMaterialsLoading(false);
      return;
    }
    if (!printingTargetDevice || !activeNetworkUiAdapter) {
      setPrintingTargetMaterialOptions([]);
      setPrintingTargetMaterialId('');
      setPrintingTargetMaterialError('Select a printer to load matching material settings.');
      setIsPrintingTargetMaterialsLoading(false);
      return;
    }

    const host = (printingTargetDevice.ipAddress || '').trim();
    if (!host) {
      setPrintingTargetMaterialOptions([]);
      setPrintingTargetMaterialId('');
      setPrintingTargetMaterialError('Selected printer has no network address.');
      setIsPrintingTargetMaterialsLoading(false);
      return;
    }

    const cacheKey = `${activeNetworkUiAdapter.pluginId}:${host.toLowerCase()}`;
    const applyResolvedMaterials = (parsed: FleetUploadMaterialOption[]) => {
      const materialChoices = isPreSliceTargetPicker
        ? parsed
        : parsed.filter((material) => isLayerHeightMatch(material.layerHeightMm));

      const selectedDeviceMaterialId = (printingTargetDevice.selectedMaterialId ?? '').trim();
      if (
        materialChoices.length === 0
        && selectedDeviceMaterialId.length > 0
        && (isPreSliceTargetPicker || isLayerHeightMatch(printingTargetDevice.selectedMaterialLayerHeightMm ?? null))
      ) {
        materialChoices.push({
          id: selectedDeviceMaterialId,
          name: printingTargetDevice.selectedMaterialName?.trim() || selectedDeviceMaterialId,
          layerHeightMm: printingTargetDevice.selectedMaterialLayerHeightMm ?? null,
        });
      }

      setPrintingTargetMaterialOptions(materialChoices);

      setPrintingTargetMaterialId((previousId) => {
        const preferredId = previousId.trim();
        const fallbackId = materialChoices.find((material) => material.id === selectedDeviceMaterialId)?.id
          ?? materialChoices[0]?.id
          ?? '';
        return materialChoices.some((material) => material.id === preferredId) ? preferredId : fallbackId;
      });

      if (materialChoices.length === 0) {
        setPrintingTargetMaterialError(
          isPreSliceTargetPicker
            ? 'No material profiles found on this printer.'
            : `No material on this printer matches sliced layer height ${slicedLayerHeightMm.toFixed(3)} mm.`,
        );
      } else {
        setPrintingTargetMaterialError(null);
      }
    };

    const cached = printingTargetMaterialsCacheRef.current.get(cacheKey);
    if (cached) {
      setIsPrintingTargetMaterialsLoading(false);
      applyResolvedMaterials(cached);
      return;
    }

    let cancelled = false;
    setIsPrintingTargetMaterialsLoading(true);
    setPrintingTargetMaterialError(null);

    void (async () => {
      try {
        const response = await pluginNetworkFetch({
          pluginId: activeNetworkUiAdapter.pluginId,
          operation: activeNetworkUiAdapter.operations.materials,
          host,
        });

        const payload = await readJsonObject(response);
        const rawMaterials = Array.isArray(payload?.materials) ? payload.materials : [];

        const parsed: FleetUploadMaterialOption[] = rawMaterials
          .map((item: any) => {
            if (typeof item?.id !== 'string' || typeof item?.name !== 'string') return null;
            const processValues = activeNetworkUiAdapter.resolveMaterialProcessValues((item?.meta ?? {}) as Record<string, unknown>);
            return {
              id: item.id,
              name: item.name,
              layerHeightMm: Number.isFinite(Number(processValues.layerHeightMm))
                ? Number(processValues.layerHeightMm)
                : null,
            } satisfies FleetUploadMaterialOption;
          })
          .filter((item: FleetUploadMaterialOption | null): item is FleetUploadMaterialOption => item !== null);

        if (cancelled) return;
        printingTargetMaterialsCacheRef.current.set(cacheKey, parsed);
        applyResolvedMaterials(parsed);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Failed to load materials from printer.';
        setPrintingTargetMaterialOptions([]);
        setPrintingTargetMaterialId('');
        setPrintingTargetMaterialError(message);
      } finally {
        if (!cancelled) {
          setIsPrintingTargetMaterialsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeNetworkUiAdapter,
    isPreSliceTargetPicker,
    isLayerHeightMatch,
    printingTargetDevice,
    printingTargetPickerOpen,
    requiresRemoteMaterialSelectionForUpload,
    slicedLayerHeightMm,
  ]);

  React.useEffect(() => {
    const canProbeSelectedPrinter = Boolean(
      printingMonitoringAdapter.available
      && printingMonitoringAdapter.pluginId
      && printingMonitoringAdapter.operations
      && selectedPrinterProbeTarget,
    );

    if (!canProbeSelectedPrinter) {
      setSelectedPrinterMonitorSnapshot(null);
      return;
    }

    const host = (selectedPrinterProbeTarget?.host || '').trim();
    const port = selectedPrinterProbeTarget?.port || 80;
    if (!host) {
      setSelectedPrinterMonitorSnapshot(null);
      return;
    }

    let cancelled = false;

    const poll = async () => {
      while (!cancelled) {
        try {
          const response = await pluginNetworkFetch({
            pluginId: printingMonitoringAdapter.pluginId,
            operation: printingMonitoringAdapter.operations!.status,
            ipAddress: host,
            port,
          });

          const payload = await readJsonObject(response);
          if (cancelled) return;
          const snapshot = printingMonitoringAdapter.parseStatusPayload(payload, `${host}:${port}`);
          setSelectedPrinterMonitorSnapshot(snapshot);
        } catch {
          if (cancelled) return;
          setSelectedPrinterMonitorSnapshot(null);
        }

        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 4500);
        });
      }
    };

    void poll();

    return () => {
      cancelled = true;
    };
  }, [printingMonitoringAdapter, selectedPrinterProbeTarget]);

  React.useEffect(() => {
    const canMonitor = Boolean(
      printingMonitorModalOpen
      && monitoringDevice
      && printingMonitoringAdapter.available
      && printingMonitoringAdapter.pluginId
      && printingMonitoringAdapter.operations,
    );

    if (!canMonitor) {
      setIsPrintingMonitorPolling(false);
      setIsPrintingMonitorStatusRequestInFlight(false);
      return;
    }

    const host = (monitoringDevice?.ipAddress || '').trim();
    const port = monitoringDevice?.port || 80;
    if (!host) {
      setIsPrintingMonitorPolling(false);
      setIsPrintingMonitorStatusRequestInFlight(false);
      setPrintingMonitorError('No printer IP available for monitoring.');
      return;
    }

    let cancelled = false;
    setIsPrintingMonitorPolling(true);

    const poll = async () => {
      while (!cancelled) {
        const requestPayload = {
          pluginId: printingMonitoringAdapter.pluginId,
          operation: printingMonitoringAdapter.operations!.status,
          ipAddress: host,
          port,
          plateId: printingReadyPlateId,
        };

        setIsPrintingMonitorStatusRequestInFlight(true);
        try {
          const response = await pluginNetworkFetch(requestPayload);

          const payload = await readJsonObject(response);
          if (cancelled) return;

          const snapshot = printingMonitoringAdapter.parseStatusPayload(payload, `${host}:${port}`);
          setPrintingMonitorSnapshot(snapshot);
          if (snapshot?.connected === true) {
            setPrintingMonitorLastStatusSuccessAtMs(Date.now());
          }
          const payloadError = typeof payload?.error === 'string' ? payload.error : null;
          const liveReachability = monitoringDevice ? getPrinterReachabilitySnapshot()[monitoringDevice.id] : null;
          const isLikelyOffline = Boolean(
            monitoringDevice
            && (liveReachability !== true || monitoringDevice.connected !== true)
            && snapshot?.connected !== true,
          );
          setPrintingMonitorError(isLikelyOffline ? null : payloadError);
          setPrintingMonitorDebugState((previous) => ({
            ...previous,
            status: {
              requestedAtEpochMs: Date.now(),
              request: requestPayload,
              httpStatus: response.status,
              rawPayload: payload,
              parsedPayload: snapshot,
              error: null,
            },
          }));
        } catch (error) {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : 'Failed to poll printer status.';
          const liveReachability = monitoringDevice ? getPrinterReachabilitySnapshot()[monitoringDevice.id] : null;
          const isLikelyOffline = Boolean(
            monitoringDevice
            && (liveReachability !== true || monitoringDevice.connected !== true),
          );
          setPrintingMonitorError(isLikelyOffline ? null : message);
          setPrintingMonitorDebugState((previous) => ({
            ...previous,
            status: {
              requestedAtEpochMs: Date.now(),
              request: requestPayload,
              httpStatus: null,
              rawPayload: null,
              parsedPayload: null,
              error: message,
            },
          }));
        } finally {
          if (!cancelled) {
            setIsPrintingMonitorStatusRequestInFlight(false);
          }
        }

        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 2200);
        });
      }
    };

    void poll().finally(() => {
      if (!cancelled) {
        setIsPrintingMonitorPolling(false);
        setIsPrintingMonitorStatusRequestInFlight(false);
      }
    });

    return () => {
      cancelled = true;
      setIsPrintingMonitorPolling(false);
      setIsPrintingMonitorStatusRequestInFlight(false);
    };
  }, [
    monitoringDevice,
    printingMonitoringAdapter,
    printingMonitorModalOpen,
    printingReadyPlateId,
  ]);

  const refreshPrintingMonitorRecentPlates = React.useCallback(async () => {
    const requestId = ++printingMonitorRecentPlatesRequestIdRef.current;

    const canLoadRecentPlates = Boolean(
      printingMonitorModalOpen
      && monitoringDevice
      && printingMonitoringAdapter.available
      && printingMonitoringAdapter.pluginId
      && printingMonitoringAdapter.operations?.platesList,
    );
    if (!canLoadRecentPlates) {
      if (requestId !== printingMonitorRecentPlatesRequestIdRef.current) return;
      setPrintingMonitorRecentPlatesError(null);
      setIsPrintingMonitorRecentPlatesLoading(false);
      return;
    }

    const host = (monitoringDevice?.ipAddress || '').trim();
    const port = monitoringDevice?.port || 80;
    if (!host) {
      if (requestId !== printingMonitorRecentPlatesRequestIdRef.current) return;
      setPrintingMonitorRecentPlatesError('No printer IP available for recent print files.');
      setIsPrintingMonitorRecentPlatesLoading(false);
      return;
    }

    setIsPrintingMonitorRecentPlatesLoading(true);
    setPrintingMonitorRecentPlatesError(null);

    const requestPayload = {
      pluginId: printingMonitoringAdapter.pluginId,
      operation: printingMonitoringAdapter.operations!.platesList,
      ipAddress: host,
      port,
      storagePath: printingMonitorPlatesStoragePath,
      source: printingMonitorPlatesStoragePath,
      url: printingMonitorPlatesStoragePath,
    };

    try {
      const response = await pluginNetworkFetch(requestPayload);

      const payload = await readJsonObject(response);
      if (requestId !== printingMonitorRecentPlatesRequestIdRef.current) return;
      if (!response.ok || payload?.ok === false) {
        const reason = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(reason);
      }

      const parsed: PrintingMonitorRecentPlate[] = (Array.isArray(payload?.plates) ? payload.plates : [])
        .map((entry: unknown) => {
          if (!entry || typeof entry !== 'object') return null;
          const plate = entry as Record<string, unknown>;
          const rawPlateId = plate.PlateID ?? plate.plateId ?? plate.plate_id ?? plate.id;
          const plateId = Number(String(rawPlateId ?? '').trim());
          if (!Number.isFinite(plateId) || plateId <= 0) return null;

          const rawName = plate.Path ?? plate.path ?? plate.File ?? plate.file ?? plate.Name ?? plate.name;
          const fullName = typeof rawName === 'string' ? rawName.trim() : `Plate #${Math.round(plateId)}`;
          const cleanName = fullName.split('/').filter(Boolean).pop() || fullName;

          const rawMaterialProfile =
            plate.ProfileName
            ?? plate.profileName
            ?? plate.MaterialName
            ?? plate.materialName
            ?? plate.ResinName
            ?? plate.resinName
            ?? plate.Profile
            ?? plate.profile;
          const materialProfileFromName = typeof rawMaterialProfile === 'string'
            ? rawMaterialProfile.trim()
            : '';

          const rawProfileId =
            plate.ProfileID
            ?? plate.profileId
            ?? plate.profile_id
            ?? plate.MaterialID
            ?? plate.materialId;
          const profileId = Number(String(rawProfileId ?? '').trim());
          const materialProfileName = materialProfileFromName.length > 0
            ? materialProfileFromName
            : (Number.isFinite(profileId) && profileId > 0 ? `Profile #${Math.round(profileId)}` : null);

          const rawFileData = plate.file_data ?? plate.fileData;
          let fileData: Record<string, unknown> | undefined;
          if (rawFileData && typeof rawFileData === 'object' && !Array.isArray(rawFileData)) {
            fileData = rawFileData as Record<string, unknown>;
          } else if (typeof rawFileData === 'string' && rawFileData.trim().length > 0) {
            try {
              const parsedFileData = JSON.parse(rawFileData) as unknown;
              if (parsedFileData && typeof parsedFileData === 'object' && !Array.isArray(parsedFileData)) {
                fileData = parsedFileData as Record<string, unknown>;
              }
            } catch {
              fileData = undefined;
            }
          }
          const rawLastModified = fileData?.last_modified ?? fileData?.lastModified ?? plate.lastModified;
          const lastModifiedEpochSec = Number(String(rawLastModified ?? '').trim());
          const rawLayerCount = plate.LayersCount ?? plate.layerCount ?? fileData?.layer_count;
          const rawPrintTime =
            plate.PrintTime
            ?? plate.printTime
            ?? plate.print_time
            ?? plate.EstimatedTime
            ?? plate.estimatedTime
            ?? plate.estimated_time
            ?? plate.Duration
            ?? plate.duration
            ?? fileData?.PrintTime
            ?? fileData?.printTime
            ?? fileData?.print_time
            ?? fileData?.EstimatedTime
            ?? fileData?.estimatedTime
            ?? fileData?.estimated_time
            ?? fileData?.Duration
            ?? fileData?.duration;
          const rawUsedMaterial =
            plate.UsedMaterial
            ?? plate.usedMaterial
            ?? plate.used_material
            ?? plate.MaterialUsage
            ?? plate.materialUsage
            ?? plate.material_usage
            ?? fileData?.UsedMaterial
            ?? fileData?.usedMaterial
            ?? fileData?.used_material
            ?? fileData?.MaterialUsage
            ?? fileData?.materialUsage
            ?? fileData?.material_usage;
          const rawTotalSolidArea =
            plate.TotalSolidArea
            ?? plate.totalSolidArea
            ?? plate.total_solid_area
            ?? fileData?.TotalSolidArea
            ?? fileData?.totalSolidArea
            ?? fileData?.total_solid_area;
          const rawLargestArea =
            plate.LargestArea
            ?? plate.largestArea
            ?? plate.largest_area
            ?? fileData?.LargestArea
            ?? fileData?.largestArea
            ?? fileData?.largest_area;
          const rawSmallestArea =
            plate.SmallestArea
            ?? plate.smallestArea
            ?? plate.smallest_area
            ?? fileData?.SmallestArea
            ?? fileData?.smallestArea
            ?? fileData?.smallest_area;
          const parsedPrintTimeSec = parsePrintingMonitorSeconds(rawPrintTime);
          const parsedUsedMaterialMl = parsePrintingMonitorMaterialMl(rawUsedMaterial);
          const parsedTotalSolidAreaMm2 = parsePrintingMonitorAreaMm2(rawTotalSolidArea);
          const parsedLargestAreaMm2 = parsePrintingMonitorAreaMm2(rawLargestArea);
          const parsedSmallestAreaMm2 = parsePrintingMonitorAreaMm2(rawSmallestArea);

          return {
            plateId: Math.round(plateId),
            name: cleanName,
            materialProfileName,
            lastModifiedEpochSec: Number.isFinite(lastModifiedEpochSec) && lastModifiedEpochSec > 0
              ? Math.round(lastModifiedEpochSec)
              : null,
            layerCount: Number.isFinite(Number(rawLayerCount)) && Number(rawLayerCount) > 0
              ? Math.round(Number(rawLayerCount))
              : null,
            printTimeSec: parsedPrintTimeSec,
            usedMaterialMl: parsedUsedMaterialMl,
            totalSolidAreaMm2: parsedTotalSolidAreaMm2,
            smallestAreaMm2: parsedSmallestAreaMm2,
            largestAreaMm2: parsedLargestAreaMm2,
          } satisfies PrintingMonitorRecentPlate;
        })
        .filter((item: PrintingMonitorRecentPlate | null): item is PrintingMonitorRecentPlate => item !== null)
        .sort((a: PrintingMonitorRecentPlate, b: PrintingMonitorRecentPlate) => {
          const aModified = a.lastModifiedEpochSec ?? 0;
          const bModified = b.lastModifiedEpochSec ?? 0;
          if (aModified !== bModified) return bModified - aModified;
          return b.plateId - a.plateId;
        })
        .slice(0, 20);

      setPrintingMonitorRecentPlates(parsed);
      setPrintingMonitorDebugState((previous) => ({
        ...previous,
        plates: {
          requestedAtEpochMs: Date.now(),
          request: requestPayload,
          httpStatus: response.status,
          rawPayload: payload,
          parsedPayload: parsed,
          error: null,
        },
      }));
      setPrintingMonitorSelectedPlateId((previous) => {
        if (previous != null && parsed.some((plate: PrintingMonitorRecentPlate) => plate.plateId === previous)) return previous;
        if (printingMonitorPlateId != null && parsed.some((plate: PrintingMonitorRecentPlate) => plate.plateId === printingMonitorPlateId)) {
          return printingMonitorPlateId;
        }
        return parsed[0]?.plateId ?? null;
      });
      setPrintingMonitorRecentPlatesError(null);
      if (printingMonitorRecentPlatesCacheKey) {
        const resolvedSelectedPlateId = (
          printingMonitorPlateId != null && parsed.some((plate: PrintingMonitorRecentPlate) => plate.plateId === printingMonitorPlateId)
        )
          ? printingMonitorPlateId
          : (parsed[0]?.plateId ?? null);
        printingMonitorRecentPlatesCacheRef.current.set(printingMonitorRecentPlatesCacheKey, {
          plates: parsed,
          selectedPlateId: resolvedSelectedPlateId,
          error: null,
        });
      }
    } catch (error) {
      if (requestId !== printingMonitorRecentPlatesRequestIdRef.current) return;
      const message = error instanceof Error ? error.message : 'Failed to load recent print files.';
      setPrintingMonitorRecentPlatesError(message);
      if (printingMonitorRecentPlatesCacheKey) {
        const cached = printingMonitorRecentPlatesCacheRef.current.get(printingMonitorRecentPlatesCacheKey);
        printingMonitorRecentPlatesCacheRef.current.set(printingMonitorRecentPlatesCacheKey, {
          plates: cached?.plates ?? printingMonitorRecentPlatesRef.current,
          selectedPlateId: cached?.selectedPlateId ?? printingMonitorSelectedPlateIdRef.current,
          error: message,
        });
      }
      setPrintingMonitorDebugState((previous) => ({
        ...previous,
        plates: {
          requestedAtEpochMs: Date.now(),
          request: requestPayload,
          httpStatus: null,
          rawPayload: null,
          parsedPayload: null,
          error: message,
        },
      }));
    } finally {
      if (requestId !== printingMonitorRecentPlatesRequestIdRef.current) return;
      setIsPrintingMonitorRecentPlatesLoading(false);
    }
  }, [
    monitoringDevice,
    printingMonitorModalOpen,
    printingMonitorPlateId,
    printingMonitorPlatesStoragePath,
    printingMonitorRecentPlatesCacheKey,
    printingMonitoringAdapter,
  ]);

  const handlePrintingMonitorStoragePathChange = React.useCallback((nextPath: '/local/' | '/usb/') => {
    if (nextPath === printingMonitorPlatesStoragePath) return;

    // Switch immediately and hydrate from per-device cache (if available) while a fresh fetch runs.
    printingMonitorRecentPlatesRequestIdRef.current += 1;
    setIsPrintingMonitorRecentPlatesLoading(true);
    setPrintingMonitorPlatesStoragePath(nextPath);
  }, [printingMonitorPlatesStoragePath]);

  React.useEffect(() => {
    if (!printingMonitorModalOpen) return;

    printingMonitorRecentPlatesRequestIdRef.current += 1;

    if (!printingMonitorRecentPlatesCacheKey) {
      setPrintingMonitorRecentPlates([]);
      setPrintingMonitorRecentPlatesError(null);
      setPrintingMonitorSelectedPlateId(null);
      return;
    }

    const cached = printingMonitorRecentPlatesCacheRef.current.get(printingMonitorRecentPlatesCacheKey);
    if (!cached) {
      setPrintingMonitorRecentPlates([]);
      setPrintingMonitorRecentPlatesError(null);
      setPrintingMonitorSelectedPlateId(null);
      return;
    }

    setPrintingMonitorRecentPlates(cached.plates);
    setPrintingMonitorRecentPlatesError(cached.error);
    setPrintingMonitorSelectedPlateId(cached.selectedPlateId);
  }, [printingMonitorModalOpen, printingMonitorRecentPlatesCacheKey]);

  React.useEffect(() => {
    if (!printingMonitorModalOpen) {
      printingMonitorRecentPlatesRequestIdRef.current += 1;
      setIsPrintingMonitorRecentPlatesLoading(false);
      return;
    }

    void refreshPrintingMonitorRecentPlates();
  }, [printingMonitorModalOpen, refreshPrintingMonitorRecentPlates]);

  React.useLayoutEffect(() => {
    const webcamSection = printingMonitorWebcamSectionRef.current;
    const clearSizing = () => {
      webcamSection?.style.removeProperty('height');
      webcamSection?.style.removeProperty('max-height');
    };

    if (
      !printingMonitorModalOpen
      || printingMonitorViewMode !== 'detail'
      || !printingMonitorUsesTwoColumnDetailLayout
      || !printingMonitorHasCamera
    ) {
      clearSizing();
      return;
    }

    if (printingMonitorDetailWebcamExpanded) {
      const cachedHeightPx = printingMonitorWebcamFollowerHeightPxRef.current;
      if (cachedHeightPx && cachedHeightPx > 0 && webcamSection) {
        webcamSection.style.height = `${cachedHeightPx}px`;
        webcamSection.style.maxHeight = `${cachedHeightPx}px`;
      } else {
        clearSizing();
      }
      return;
    }

    let resizeObserver: ResizeObserver | null = null;
    let rafId: number | null = null;

    const applyFollowerHeight = () => {
      const leftColumn = printingMonitorLeftColumnRef.current;
      const rightColumn = printingMonitorWebcamSectionRef.current;
      if (!leftColumn || !rightColumn) return;

      const measured = Math.max(0, Math.round(leftColumn.getBoundingClientRect().height));
      if (measured <= 0) return;

      printingMonitorWebcamFollowerHeightPxRef.current = measured;
      rightColumn.style.height = `${measured}px`;
      rightColumn.style.maxHeight = `${measured}px`;
    };

    const bind = () => {
      const leftColumn = printingMonitorLeftColumnRef.current;
      if (!leftColumn) {
        rafId = window.requestAnimationFrame(bind);
        return;
      }

      applyFollowerHeight();
      resizeObserver = new ResizeObserver(() => {
        applyFollowerHeight();
      });
      resizeObserver.observe(leftColumn);
      window.addEventListener('resize', applyFollowerHeight);
    };

    bind();

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener('resize', applyFollowerHeight);
      clearSizing();
    };
  }, [
    printingMonitorHasCamera,
    printingMonitorDetailWebcamExpanded,
    printingMonitorModalOpen,
    printingMonitorUsesTwoColumnDetailLayout,
    printingMonitorViewMode,
  ]);

  React.useEffect(() => {
    if (printingMonitorCanExpandWebcam) return;
    setPrintingMonitorWebcamExpanded(false);
  }, [printingMonitorCanExpandWebcam]);

  React.useEffect(() => {
    if (printingMonitorPlateId == null) return;
    setPrintingMonitorSelectedPlateId((previous) => previous ?? printingMonitorPlateId);
  }, [printingMonitorPlateId]);

  React.useEffect(() => {
    if (!printingMonitorHasCamera) {
      setPrintingMonitorWebcamInfo(null);
      setPrintingMonitorWebcamLoadError(null);
      setIsPrintingMonitorWebcamLoaded(false);
      setPrintingMonitorWebcamAspectRatio(null);
      return;
    }

    const canResolveWebcam = Boolean(
      printingMonitorModalOpen
      && monitoringDeviceId
      && printingMonitoringAdapter.available
      && printingMonitoringAdapter.pluginId
      && printingMonitoringAdapter.operations,
    );

    if (!canResolveWebcam) return;

    const host = monitoringDeviceHost;
    const port = monitoringDevicePort;
    if (!host) return;
    const webcamOperation = printingMonitoringAdapter.operations?.webcamInfo;

    if (!webcamOperation || webcamOperation.trim().length === 0) {
      setPrintingMonitorWebcamInfo({
        available: false,
        streamUrl: null,
        snapshotUrl: null,
        message: 'Webcam operation is not configured for this plugin.',
      });
      setPrintingMonitorDebugState((previous) => ({
        ...previous,
        webcam: {
          requestedAtEpochMs: Date.now(),
          request: {
            pluginId: printingMonitoringAdapter.pluginId,
            operation: webcamOperation ?? null,
            ipAddress: host,
            port,
          },
          httpStatus: null,
          rawPayload: null,
          parsedPayload: null,
          error: 'Webcam operation is not configured for this plugin.',
        },
      }));
      return;
    }

    let cancelled = false;
    const pollWebcamInfo = async () => {
      if (cancelled || printingMonitorWebcamRequestInFlightRef.current) return;
      if (printingMonitorWebcamAutoPollBlockedRef.current) return;

      const now = Date.now();
      if (printingMonitorWebcamBusyUntilEpochMsRef.current > now) {
        return;
      }

      printingMonitorWebcamRequestInFlightRef.current = true;

      const requestPayload = {
        pluginId: printingMonitoringAdapter.pluginId,
        operation: webcamOperation,
        ipAddress: host,
        port,
        mainboardId: monitoringDeviceMainboardId,
      };

      try {
        const requestStartedAt = Date.now();
        const response = await pluginNetworkFetch(requestPayload);

        const payload = await readJsonObject(response);
        if (cancelled) return;
        const parsed = printingMonitoringAdapter.parseWebcamInfoPayload(payload, host, port);
        const elapsedMs = Date.now() - requestStartedAt;

        const parsedMessage = String(parsed?.message ?? '').toLowerCase();
        const payloadMessage = (readStringField(payload, 'message') ?? '').toLowerCase();
        const ack = readNumberField(payload, 'ack');
        const timedOut = parsedMessage.includes('timed out')
          || payloadMessage.includes('timed out')
          || parsedMessage.includes('no-response')
          || payloadMessage.includes('no-response')
          || ack === -1;
        const streamLimitBusy = parsedMessage.includes('stream limit') || parsedMessage.includes('simultaneous');
        const pluginFailure = !response.ok || payload?.ok === false;
        let timeoutCircuitBreakerTripped = false;
        let timeoutCount = printingMonitorWebcamConsecutiveTimeoutsRef.current;

        if (streamLimitBusy) {
          printingMonitorWebcamConsecutiveTimeoutsRef.current = 0;
          printingMonitorWebcamAutoPollBlockedRef.current = true;
          printingMonitorWebcamBusyUntilEpochMsRef.current = 0;
        } else if (timedOut) {
          timeoutCount += 1;
          printingMonitorWebcamConsecutiveTimeoutsRef.current = timeoutCount;

          if (timeoutCount >= printingMonitorWebcamMaxConsecutiveTimeouts) {
            timeoutCircuitBreakerTripped = true;
            printingMonitorWebcamAutoPollBlockedRef.current = true;
            printingMonitorWebcamBusyUntilEpochMsRef.current = 0;
          } else {
            printingMonitorWebcamBusyUntilEpochMsRef.current = Date.now() + printingMonitorWebcamTimeoutCooldownMs;
          }
        } else if (pluginFailure) {
          printingMonitorWebcamConsecutiveTimeoutsRef.current = 0;
          printingMonitorWebcamBusyUntilEpochMsRef.current = Date.now() + printingMonitorWebcamFailureCooldownMs;
        } else {
          printingMonitorWebcamConsecutiveTimeoutsRef.current = 0;
          printingMonitorWebcamBusyUntilEpochMsRef.current = 0;
        }

        const finalParsed: PrinterMonitoringWebcamInfo = timeoutCircuitBreakerTripped
          ? {
              available: false,
              streamUrl: null,
              snapshotUrl: null,
              message: `Webcam timed out ${timeoutCount} times in a row. Auto-retries are paused to prevent request spam. Click Retry Webcam to try again.`,
            }
          : parsed;

        if (!response.ok || timedOut || payload?.ok === false) {
          console.warn('[Monitor/Webcam] Request warning', {
            requestPayload,
            httpStatus: response.status,
            elapsedMs,
            timedOut,
            streamLimitBusy,
            timeoutCount,
            timeoutCircuitBreakerTripped,
            ack,
            cooldownUntilEpochMs: printingMonitorWebcamBusyUntilEpochMsRef.current,
            payload,
            parsed,
          });
        }

        setPrintingMonitorWebcamInfo(finalParsed);
        setPrintingMonitorDebugState((previous) => ({
          ...previous,
          webcam: {
            requestedAtEpochMs: Date.now(),
            request: requestPayload,
            httpStatus: response.status,
            rawPayload: payload,
            parsedPayload: finalParsed,
            error: null,
          },
        }));
      } catch (error) {
        if (cancelled) return;
        let timeoutCount = printingMonitorWebcamConsecutiveTimeoutsRef.current + 1;
        printingMonitorWebcamConsecutiveTimeoutsRef.current = timeoutCount;

        const timeoutCircuitBreakerTripped = timeoutCount >= printingMonitorWebcamMaxConsecutiveTimeouts;
        if (timeoutCircuitBreakerTripped) {
          printingMonitorWebcamAutoPollBlockedRef.current = true;
          printingMonitorWebcamBusyUntilEpochMsRef.current = 0;
        } else {
          printingMonitorWebcamBusyUntilEpochMsRef.current = Date.now() + printingMonitorWebcamTimeoutCooldownMs;
        }

        const message = timeoutCircuitBreakerTripped
          ? `Webcam timed out ${timeoutCount} times in a row. Auto-retries are paused to prevent request spam. Click Retry Webcam to try again.`
          : (error instanceof Error ? error.message : 'Unable to resolve webcam feed details.');

        console.warn('[Monitor/Webcam] Request failed', {
          requestPayload,
          error: message,
          timeoutCount,
          timeoutCircuitBreakerTripped,
          cooldownUntilEpochMs: printingMonitorWebcamBusyUntilEpochMsRef.current,
        });
        setPrintingMonitorWebcamInfo({
          available: false,
          streamUrl: null,
          snapshotUrl: null,
          message,
        });
        setPrintingMonitorDebugState((previous) => ({
          ...previous,
          webcam: {
            requestedAtEpochMs: Date.now(),
            request: requestPayload,
            httpStatus: null,
            rawPayload: null,
            parsedPayload: null,
            error: message,
          },
        }));
      } finally {
        printingMonitorWebcamRequestInFlightRef.current = false;
      }
    };

    void pollWebcamInfo();
    const intervalId = window.setInterval(() => {
      void pollWebcamInfo();
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      printingMonitorWebcamRequestInFlightRef.current = false;
    };
  }, [
    monitoringDeviceHost,
    monitoringDeviceId,
    monitoringDeviceMainboardId,
    monitoringDevicePort,
    printingMonitorHasCamera,
    printingMonitoringAdapter,
    printingMonitorModalOpen,
    printingMonitorWebcamRefreshNonce,
  ]);

  React.useEffect(() => {
    if (!printingMonitorHasActivePrint || !printingMonitorThumbnailUrl || !printingMonitorThumbnailCacheKey) {
      setPrintingMonitorThumbnailDisplayUrl(null);
      setIsPrintingMonitorThumbnailLoaded(false);
      return;
    }

    const cached = printingMonitorThumbnailCacheRef.current.get(printingMonitorThumbnailCacheKey) ?? null;
    if (cached) {
      setPrintingMonitorThumbnailDisplayUrl(cached);
      setIsPrintingMonitorThumbnailLoaded(true);
    } else {
      setPrintingMonitorThumbnailDisplayUrl(null);
      setIsPrintingMonitorThumbnailLoaded(false);
    }

    let cancelled = false;
    const probeImage = new Image();
    probeImage.decoding = 'async';
    probeImage.onload = () => {
      if (cancelled) return;
      printingMonitorThumbnailCacheRef.current.set(printingMonitorThumbnailCacheKey, printingMonitorThumbnailUrl);
      setPrintingMonitorThumbnailDisplayUrl(printingMonitorThumbnailUrl);
      setIsPrintingMonitorThumbnailLoaded(true);
    };
    probeImage.onerror = () => {
      if (cancelled) return;
      const fallback = printingMonitorThumbnailCacheRef.current.get(printingMonitorThumbnailCacheKey) ?? null;
      setPrintingMonitorThumbnailDisplayUrl(fallback);
      setIsPrintingMonitorThumbnailLoaded(Boolean(fallback));
    };
    probeImage.src = printingMonitorThumbnailUrl;

    return () => {
      cancelled = true;
    };
  }, [printingMonitorHasActivePrint, printingMonitorThumbnailCacheKey, printingMonitorThumbnailUrl]);

  React.useEffect(() => {
    printingMonitorWebcamReadinessTokenRef.current += 1;
    if (printingMonitorWebcamReadinessTimeoutRef.current != null) {
      window.clearTimeout(printingMonitorWebcamReadinessTimeoutRef.current);
      printingMonitorWebcamReadinessTimeoutRef.current = null;
    }
    setIsPrintingMonitorWebcamLoaded(false);
    setPrintingMonitorWebcamLoadError(null);
  }, [printingMonitorWebcamUrl]);

  React.useEffect(() => {
    setPrintingMonitorWebcamAspectRatio(null);
  }, [printingMonitorWebcamUrl]);

  const cancelPrintingMonitorWebcamReadinessCheck = React.useCallback(() => {
    printingMonitorWebcamReadinessTokenRef.current += 1;
    if (printingMonitorWebcamReadinessTimeoutRef.current != null) {
      window.clearTimeout(printingMonitorWebcamReadinessTimeoutRef.current);
      printingMonitorWebcamReadinessTimeoutRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    if (!printingMonitorModalOpen) return;

    cancelPrintingMonitorWebcamReadinessCheck();
    if (printingMonitorRelayAutoRetryTimeoutRef.current != null) {
      window.clearTimeout(printingMonitorRelayAutoRetryTimeoutRef.current);
      printingMonitorRelayAutoRetryTimeoutRef.current = null;
    }

    printingMonitorRelayAutoRetryCountRef.current = 0;
    printingMonitorWebcamAutoPollBlockedRef.current = false;
    printingMonitorWebcamBusyUntilEpochMsRef.current = 0;
    printingMonitorWebcamConsecutiveTimeoutsRef.current = 0;

    setPrintingMonitorRelayBaseWsUrl(null);
    setPrintingMonitorRelaySetupError(null);
    setPrintingMonitorRelayDebugTransport(null);
    setPrintingMonitorRelayReclaimDebug(null);
    setPrintingMonitorWebcamInfo(null);
    setPrintingMonitorWebcamLoadError(null);
    setIsPrintingMonitorWebcamLoaded(false);
    setPrintingMonitorWebcamAspectRatio(null);
  }, [cancelPrintingMonitorWebcamReadinessCheck, monitoringDeviceId, printingMonitorModalOpen]);

  const schedulePrintingMonitorMjpegReadinessCheck = React.useCallback((target: HTMLImageElement) => {
    cancelPrintingMonitorWebcamReadinessCheck();

    const readinessToken = printingMonitorWebcamReadinessTokenRef.current;
    const sampleIntervalMs = 120;
    const maxSamples = 36;
    const minFrameDimensionPx = 64;
    const minRenderedDimensionPx = 16;
    let sampleCount = 0;
    let stableDimensionSamples = 0;
    let previousDimensionSignature: string | null = null;

    const evaluateReadiness = () => {
      if (printingMonitorWebcamReadinessTokenRef.current !== readinessToken) return;

      const naturalW = Math.round(target.naturalWidth || 0);
      const naturalH = Math.round(target.naturalHeight || 0);
      const hasDimensions = Number.isFinite(naturalW)
        && Number.isFinite(naturalH)
        && naturalW > 0
        && naturalH > 0;

      let normalizedRatio: number | null = null;
      if (hasDimensions) {
        normalizedRatio = normalizePrintingMonitorWebcamAspectRatio(naturalW / naturalH);
        if (normalizedRatio != null) {
          setPrintingMonitorWebcamAspectRatio((previous) => {
            if (previous != null && Math.abs(previous - normalizedRatio!) < 0.001) return previous;
            return normalizedRatio;
          });
        }

        const signature = `${naturalW}x${naturalH}`;
        if (signature === previousDimensionSignature) {
          stableDimensionSamples += 1;
        } else {
          previousDimensionSignature = signature;
          stableDimensionSamples = 0;
        }
      }

      const hasUsableFrameDimensions = hasDimensions
        && naturalW >= minFrameDimensionPx
        && naturalH >= minFrameDimensionPx;
      const hasRenderableViewport = target.clientWidth >= minRenderedDimensionPx
        && target.clientHeight >= minRenderedDimensionPx;
      const ready = normalizedRatio != null
        && hasRenderableViewport
        && (hasUsableFrameDimensions ? stableDimensionSamples >= 1 : stableDimensionSamples >= 2);

      if (ready) {
        setIsPrintingMonitorWebcamLoaded(true);
        setPrintingMonitorWebcamLoadError(null);
        printingMonitorWebcamReadinessTimeoutRef.current = null;
        return;
      }

      sampleCount += 1;
      if (sampleCount >= maxSamples) {
        if (normalizedRatio != null && hasDimensions && hasRenderableViewport) {
          setIsPrintingMonitorWebcamLoaded(true);
          setPrintingMonitorWebcamLoadError(null);
        }
        printingMonitorWebcamReadinessTimeoutRef.current = null;
        return;
      }

      printingMonitorWebcamReadinessTimeoutRef.current = window.setTimeout(evaluateReadiness, sampleIntervalMs);
    };

    evaluateReadiness();
  }, [cancelPrintingMonitorWebcamReadinessCheck]);

  React.useEffect(() => {
    return () => {
      cancelPrintingMonitorWebcamReadinessCheck();
    };
  }, [cancelPrintingMonitorWebcamReadinessCheck]);

  React.useLayoutEffect(() => {
    if (!printingMonitorModalOpen) return;
    const focusDeviceId = printingMonitorStartFocusDeviceIdRef.current;
    if (focusDeviceId && monitorSelectableDevices.some((device) => device.id === focusDeviceId)) {
      setPrintingMonitorDeviceId(focusDeviceId);
      setPrintingMonitorViewMode('detail');
      return;
    }
    setPrintingMonitorViewMode(monitorSelectableDevices.length > 1 ? 'dashboard' : 'detail');
  }, [printingMonitorModalOpen, monitorSelectableDevices.length]);

  React.useEffect(() => {
    if (!printingMonitorModalOpen) {
      printingMonitorStartFocusDeviceIdRef.current = null;
      setIsPrintingMonitorPrinterMenuOpen(false);
      setPrintingMonitorViewMode('detail');
      setPrintingMonitorDashboardSnapshots({});
      setIsPrintingMonitorDashboardRefreshing(false);
      setIsPrintingMonitorWebcamResetBusy(false);
      return;
    }

    if (monitorSelectableDevices.length === 0) {
      setPrintingMonitorDeviceId(null);
      return;
    }

    setPrintingMonitorDeviceId((previous) => {
      const focusDeviceId = printingMonitorStartFocusDeviceIdRef.current;
      if (focusDeviceId && monitorSelectableDevices.some((device) => device.id === focusDeviceId)) {
        return focusDeviceId;
      }

      if (previous && monitorSelectableDevices.some((device) => device.id === previous)) {
        return previous;
      }

      if (activePrinterProfile?.activeNetworkDeviceId && monitorSelectableDevices.some((device) => device.id === activePrinterProfile.activeNetworkDeviceId)) {
        return activePrinterProfile.activeNetworkDeviceId;
      }

      if (printingTargetDevice?.id && monitorSelectableDevices.some((device) => device.id === printingTargetDevice.id)) {
        return printingTargetDevice.id;
      }

      return monitorSelectableDevices[0]?.id ?? null;
    });
  }, [activePrinterProfile?.activeNetworkDeviceId, monitorSelectableDevices, printingMonitorModalOpen, printingTargetDevice?.id]);

  const triggerPrintingMonitorWebcamRetry = React.useCallback(() => {
    cancelPrintingMonitorWebcamReadinessCheck();
    if (printingMonitorRelayAutoRetryTimeoutRef.current != null) {
      window.clearTimeout(printingMonitorRelayAutoRetryTimeoutRef.current);
      printingMonitorRelayAutoRetryTimeoutRef.current = null;
    }
    printingMonitorWebcamAutoPollBlockedRef.current = false;
    printingMonitorWebcamBusyUntilEpochMsRef.current = 0;
    printingMonitorWebcamConsecutiveTimeoutsRef.current = 0;
    setPrintingMonitorWebcamLoadError(null);
    setIsPrintingMonitorWebcamLoaded(false);
    setPrintingMonitorWebcamRefreshNonce((previous) => previous + 1);
  }, [cancelPrintingMonitorWebcamReadinessCheck]);

  React.useEffect(() => {
    printingMonitorRelayAutoRetryCountRef.current = 0;
    if (printingMonitorRelayAutoRetryTimeoutRef.current != null) {
      window.clearTimeout(printingMonitorRelayAutoRetryTimeoutRef.current);
      printingMonitorRelayAutoRetryTimeoutRef.current = null;
    }
  }, [printingMonitorWebcamUrl]);

  React.useEffect(() => {
    return () => {
      if (printingMonitorRelayAutoRetryTimeoutRef.current != null) {
        window.clearTimeout(printingMonitorRelayAutoRetryTimeoutRef.current);
        printingMonitorRelayAutoRetryTimeoutRef.current = null;
      }
    };
  }, []);

  const handleSavePrintingMonitorWebcamSnapshot = React.useCallback(async () => {
    if (isPrintingMonitorWebcamSnapshotSaving) return;

    const viewport = printingMonitorWebcamViewportRef.current;
    if (!viewport) {
      setPrintingMonitorError('Webcam view is not ready for snapshot capture.');
      return;
    }

    const renderedCanvas = viewport.querySelector('canvas');
    const renderedImage = viewport.querySelector('img');
    if (!renderedCanvas && !renderedImage) {
      setPrintingMonitorError('No webcam frame is available to capture.');
      return;
    }

    setIsPrintingMonitorWebcamSnapshotSaving(true);

    try {
      let blob: Blob | null = null;
      const snapshotSourceCandidates = Array.from(new Set([
        renderedImage?.currentSrc,
        renderedImage?.src,
        printingMonitorWebcamInfo?.snapshotUrl,
        printingMonitorWebcamInfo?.streamUrl,
        printingMonitorWebcamUrl,
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())));

      if (renderedCanvas) {
        try {
          blob = await new Promise<Blob | null>((resolve, reject) => {
            try {
              renderedCanvas.toBlob((nextBlob) => resolve(nextBlob), 'image/png');
            } catch (canvasError) {
              reject(canvasError);
            }
          });
        } catch (canvasError) {
          const message = canvasError instanceof Error ? canvasError.message : String(canvasError ?? '');
          if (!/tainted canvases may not be exported/i.test(message)) {
            throw canvasError;
          }
        }
      }

      if (!blob) {
        let snapshotFetchError: unknown = null;

        for (const sourceUrl of snapshotSourceCandidates) {
          const isDataOrBlobUrl = /^data:|^blob:/i.test(sourceUrl);
          const isHttpUrl = /^https?:\/\//i.test(sourceUrl);
          if (!isDataOrBlobUrl && !isHttpUrl) continue;

          const requestUrl = isDataOrBlobUrl
            ? sourceUrl
            : `/api/webcam-snapshot?url=${encodeURIComponent(sourceUrl)}`;

          try {
            const response = await fetch(requestUrl, {
              method: 'GET',
              cache: 'no-store',
            });

            if (!response.ok) {
              const payload = await readJsonObject(response);
              const payloadError = readStringField(payload, 'error');
              const reason = typeof payloadError === 'string' && payloadError.trim().length > 0
                ? payloadError.trim()
                : `HTTP ${response.status}`;
              throw new Error(reason);
            }

            const nextBlob = await response.blob();
            if (nextBlob.size <= 0) {
              throw new Error('Snapshot source returned empty image data.');
            }

            blob = nextBlob;
            break;
          } catch (fetchError) {
            snapshotFetchError = fetchError;
          }
        }

        if (!blob && snapshotFetchError) {
          throw snapshotFetchError;
        }
      }

      if (!blob) {
        throw new Error('Unable to capture webcam snapshot from the current feed.');
      }

      const bytes = new Uint8Array(await blob.arrayBuffer());
      const baseNameRaw = (
        monitoringDevice?.displayName
        || monitoringDevice?.hostName
        || monitoringDevice?.ipAddress
        || 'printer'
      ).trim();
      const baseName = baseNameRaw.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'printer';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `webcam_${baseName}_${stamp}.png`;

      try {
        await savePrintArtifactWithNativeDialog(bytes, filename);
      } catch {
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        anchor.rel = 'noopener';
        anchor.style.display = 'none';
        document.body?.appendChild(anchor);
        anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }

      setPrintingMonitorActionStatus('Webcam snapshot saved.');
      setPrintingMonitorError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save webcam snapshot.';
      setPrintingMonitorError(message);
    } finally {
      setIsPrintingMonitorWebcamSnapshotSaving(false);
    }
  }, [
    isPrintingMonitorWebcamSnapshotSaving,
    monitoringDevice?.displayName,
    monitoringDevice?.hostName,
    monitoringDevice?.ipAddress,
    printingMonitorWebcamInfo?.snapshotUrl,
    printingMonitorWebcamInfo?.streamUrl,
    printingMonitorWebcamUrl,
  ]);

  const flushMonitors = React.useCallback(async () => {
    cancelPrintingMonitorWebcamReadinessCheck();
    if (printingMonitorRelayAutoRetryTimeoutRef.current != null) {
      window.clearTimeout(printingMonitorRelayAutoRetryTimeoutRef.current);
      printingMonitorRelayAutoRetryTimeoutRef.current = null;
    }
    printingMonitorRelayAutoRetryCountRef.current = 0;
    // Reset webcam polling state
    printingMonitorWebcamAutoPollBlockedRef.current = false;
    printingMonitorWebcamBusyUntilEpochMsRef.current = 0;
    printingMonitorWebcamRequestInFlightRef.current = false;
    printingMonitorWebcamConsecutiveTimeoutsRef.current = 0;
    setPrintingMonitorWebcamLoadError(null);
    setIsPrintingMonitorWebcamLoaded(false);
    setPrintingMonitorWebcamAspectRatio(null);
    setPrintingMonitorWebcamRefreshNonce((previous) => previous + 1);
  }, [cancelPrintingMonitorWebcamReadinessCheck]);

  const handleResetPrintingMonitorWebcamStreamSlot = React.useCallback(async () => {
    if (isPrintingMonitorWebcamResetBusy) return;

    const host = monitoringDeviceHost;
    const port = monitoringDevicePort;
    if (!printingMonitorModalOpen || !monitoringDeviceId || !host) {
      setPrintingMonitorWebcamInfo({
        available: false,
        streamUrl: null,
        snapshotUrl: null,
        message: 'No printer IP available to reset webcam stream.',
      });
      return;
    }

    setIsPrintingMonitorWebcamResetBusy(true);

    try {
      triggerPrintingMonitorWebcamRetry();
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Failed to reset webcam stream.';
      setPrintingMonitorWebcamInfo({
        available: false,
        streamUrl: null,
        snapshotUrl: null,
        message,
      });
    } finally {
      setIsPrintingMonitorWebcamResetBusy(false);
    }
  }, [
    isPrintingMonitorWebcamResetBusy,
    monitoringDeviceHost,
    monitoringDeviceId,
    printingMonitorModalOpen,
    triggerPrintingMonitorWebcamRetry,
  ]);

  React.useEffect(() => {
    if (!printingMonitorModalOpen || !monitoringDeviceId) {
      // Monitor closed or no device: disable the stream
      void flushMonitors();
      return;
    }

    // Cleanup when monitor closes
    return () => {
      void flushMonitors();
    };
  }, [printingMonitorModalOpen, monitoringDeviceId, flushMonitors]);

  React.useEffect(() => {
    const canPollDashboard = Boolean(
      printingMonitorModalOpen
      && printingMonitorViewMode === 'dashboard'
      && printingMonitoringAdapter.available
      && printingMonitoringAdapter.pluginId
      && printingMonitoringAdapter.operations?.status,
    );

    if (!canPollDashboard) {
      setIsPrintingMonitorDashboardRefreshing(false);
      return;
    }

    if (dashboardOnlineMonitorDevices.length === 0) {
      setPrintingMonitorDashboardSnapshots({});
      setIsPrintingMonitorDashboardRefreshing(false);
      return;
    }

    let cancelled = false;

    const pollAll = async () => {
      if (cancelled) return;
      setIsPrintingMonitorDashboardRefreshing(true);

      const entries = await Promise.all(
        dashboardOnlineMonitorDevices.map(async (device) => {
          const host = (device.ipAddress || '').trim();
          const port = device.port || 80;
          if (!host) return [device.id, null] as const;

          try {
            const response = await pluginNetworkFetch({
              pluginId: printingMonitoringAdapter.pluginId!,
              operation: printingMonitoringAdapter.operations!.status,
              ipAddress: host,
              port,
            });

            const payload = await readJsonObject(response);
            const snapshot = printingMonitoringAdapter.parseStatusPayload(payload, `${host}:${port}`);
            return [device.id, snapshot] as const;
          } catch {
            return [device.id, null] as const;
          }
        }),
      );

      if (cancelled) return;

      const next: Record<string, PrinterMonitoringSnapshot | null> = {};
      for (const [deviceId, snapshot] of entries) {
        next[deviceId] = snapshot;
      }
      setPrintingMonitorDashboardSnapshots(next);
      setIsPrintingMonitorDashboardRefreshing(false);
    };

    void pollAll();

    const intervalId = window.setInterval(() => {
      void pollAll();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    dashboardOnlineMonitorDevices,
    printingMonitorModalOpen,
    printingMonitoringAdapter,
    printingMonitorViewMode,
  ]);

  React.useEffect(() => {
    if (!isPrintingMonitorPrinterMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (printingMonitorPrinterMenuRef.current?.contains(target)) return;
      setIsPrintingMonitorPrinterMenuOpen(false);
    };

    window.addEventListener('mousedown', handlePointerDown);

    let wasEscapePressed = false;
    const unsubscribe = hotkeyStore.subscribe((state) => {
      const active = state.activeKeys;
      const isEscapePressed = active.has('escape');
      if (isEscapePressed && !wasEscapePressed) {
        setIsPrintingMonitorPrinterMenuOpen(false);
      }
      wasEscapePressed = isEscapePressed;
    });

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      unsubscribe();
    };
  }, [isPrintingMonitorPrinterMenuOpen]);

  React.useEffect(() => {
    setIsPrintingMonitorPrinterThumbnailFailed(false);
  }, [activePrinterProfile?.id, activePrinterProfile?.imageDataUrl]);

  React.useEffect(() => {
    if (!printingMonitorModalOpen) {
      setPrintingMonitorLastStatusSuccessAtMs(null);
      setIsPrintingMonitorStatusRequestInFlight(false);
      setPrintingMonitorActionBusy(null);
      setPrintingMonitorControlPendingAction(null);
      setPrintingMonitorActionStatus(null);
      setPrintingMonitorPendingConfirmation(null);
      setIsPrintingMonitorDebugOpen(false);
      setIsPrintingMonitorRtspDebugOpen(false);
      setPrintingMonitorDebugCopyState('idle');
      setPrintingMonitorError(null);
    }
  }, [printingMonitorModalOpen, setPrintingMonitorError]);

  React.useEffect(() => {
    if (!printingMonitorControlPendingAction) return;

    const timeoutId = window.setTimeout(() => {
      setPrintingMonitorControlPendingAction(null);
    }, 20_000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [printingMonitorControlPendingAction]);

  React.useEffect(() => {
    if (!printingMonitorControlPendingAction || !printingMonitorSnapshot) return;

    const settled = (() => {
      if (printingMonitorControlPendingAction === 'pause') {
        return printingMonitorSnapshot.isPaused || !printingMonitorHasActivePrint;
      }
      if (printingMonitorControlPendingAction === 'resume') {
        return !printingMonitorSnapshot.isPaused && !printingMonitorIsPauseTransition;
      }
      if (printingMonitorControlPendingAction === 'cancel') {
        return !printingMonitorSnapshot.isPrinting
          && !printingMonitorSnapshot.isPaused
          && !printingMonitorIsCancelTransition;
      }
      return !printingMonitorSnapshot.isPrinting
        && !printingMonitorSnapshot.isPaused
        && !printingMonitorIsCancelTransition;
    })();

    if (settled) {
      setPrintingMonitorControlPendingAction(null);
    }
  }, [
    printingMonitorControlPendingAction,
    printingMonitorHasActivePrint,
    printingMonitorIsCancelTransition,
    printingMonitorIsPauseTransition,
    printingMonitorSnapshot,
  ]);

  const openPrintingMonitorForTargetDevice = React.useCallback((deviceId: string | null) => {
    printingMonitorStartFocusDeviceIdRef.current = deviceId;
    setPrintingMonitorDeviceId(deviceId);
    setPrintingMonitorViewMode('detail');
    setPrintingMonitorModalOpen(true);
  }, []);

  const executeStartMonitorRecentPlate = React.useCallback(async (plateId: number) => {
    if (!printingMonitoringAdapter.pluginId || !printingMonitoringAdapter.operations?.start) return;
    if (!Number.isFinite(plateId) || plateId <= 0) return;

    const roundedPlateId = Math.round(plateId);

    const host = (monitoringDevice?.ipAddress || '').trim();
    const port = monitoringDevice?.port || 80;
    if (!host) {
      setPrintingMonitorError('No printer IP available to start selected file.');
      return;
    }

    setPrintingMonitorActionBusy('start');
    setPrintingMonitorActionStatus(null);

    try {
      const response = await pluginNetworkFetch({
        pluginId: printingMonitoringAdapter.pluginId,
        operation: printingMonitoringAdapter.operations.start,
        ipAddress: host,
        port,
        plateId: roundedPlateId,
      });

      const payload = await readJsonObject(response);
      if (!response.ok || payload?.ok === false) {
        const reason = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(reason);
      }

      setPrintingReadyPlateId(roundedPlateId);
      setPrintingMonitorSelectedPlateId(roundedPlateId);
      setPrintingMonitorActionStatus(`Started plate #${roundedPlateId}.`);
      setPrintingMonitorError(null);
      void refreshPrintingMonitorRecentPlates();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start selected print file.';
      setPrintingMonitorError(message);
      setPrintingMonitorActionStatus(null);
    } finally {
      setPrintingMonitorActionBusy(null);
    }
  }, [
    monitoringDevice?.ipAddress,
    monitoringDevice?.port,
    printingMonitoringAdapter,
    refreshPrintingMonitorRecentPlates,
  ]);

  const handleStartMonitorRecentPlate = React.useCallback((plateId: number) => {
    if (!Number.isFinite(plateId) || plateId <= 0) return;
    const roundedPlateId = Math.round(plateId);
    const matched = printingMonitorRecentPlates.find((plate) => plate.plateId === roundedPlateId);
    setPrintingMonitorPendingConfirmation({
      kind: 'plate',
      action: 'start',
      plateId: roundedPlateId,
      plateName: matched?.name ?? `Plate #${roundedPlateId}`,
    });
  }, [printingMonitorRecentPlates]);

  const executeDeleteMonitorRecentPlate = React.useCallback(async (plateId: number) => {
    if (!printingMonitoringAdapter.pluginId || !printingMonitoringAdapter.operations?.deletePlate) return;
    if (!Number.isFinite(plateId) || plateId <= 0) return;

    const roundedPlateId = Math.round(plateId);

    const host = (monitoringDevice?.ipAddress || '').trim();
    const port = monitoringDevice?.port || 80;
    if (!host) {
      setPrintingMonitorError('No printer IP available to delete selected file.');
      return;
    }

    setPrintingMonitorActionBusy('delete');
    setPrintingMonitorActionStatus(null);

    try {
      const response = await pluginNetworkFetch({
        pluginId: printingMonitoringAdapter.pluginId,
        operation: printingMonitoringAdapter.operations.deletePlate,
        ipAddress: host,
        port,
        plateId: roundedPlateId,
      });

      const payload = await readJsonObject(response);
      if (!response.ok || payload?.ok === false) {
        const reason = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(reason);
      }

      setPrintingMonitorActionStatus(`Deleted plate #${roundedPlateId}.`);
      setPrintingMonitorError(null);
      setPrintingMonitorRecentPlates((previous) => previous.filter((plate) => plate.plateId !== roundedPlateId));
      setPrintingMonitorSelectedPlateId((previous) => (previous === roundedPlateId ? null : previous));
      if (printingReadyPlateId === roundedPlateId) {
        setPrintingReadyPlateId(null);
      }
      void refreshPrintingMonitorRecentPlates();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete selected print file.';
      setPrintingMonitorError(message);
      setPrintingMonitorActionStatus(null);
    } finally {
      setPrintingMonitorActionBusy(null);
    }
  }, [
    monitoringDevice?.ipAddress,
    monitoringDevice?.port,
    printingMonitoringAdapter,
    printingReadyPlateId,
    refreshPrintingMonitorRecentPlates,
  ]);

  const handleDeleteMonitorRecentPlate = React.useCallback((plateId: number) => {
    if (!Number.isFinite(plateId) || plateId <= 0) return;
    const roundedPlateId = Math.round(plateId);
    const matched = printingMonitorRecentPlates.find((plate) => plate.plateId === roundedPlateId);
    setPrintingMonitorPendingConfirmation({
      kind: 'plate',
      action: 'delete',
      plateId: roundedPlateId,
      plateName: matched?.name ?? `Plate #${roundedPlateId}`,
    });
  }, [printingMonitorRecentPlates]);

  const executePrintingMonitorControlAction = React.useCallback(async (
    action: 'pause' | 'resume' | 'cancel' | 'emergency-stop',
  ) => {
    if (!printingMonitoringAdapter.pluginId || !printingMonitoringAdapter.operations) return;

    const host = (monitoringDevice?.ipAddress || '').trim();
    const port = monitoringDevice?.port || 80;
    if (!host) {
      setPrintingMonitorError('No printer IP available for control command.');
      return;
    }

    const operation = action === 'pause'
      ? printingMonitoringAdapter.operations.pause
      : action === 'resume'
        ? printingMonitoringAdapter.operations.resume
        : action === 'cancel'
          ? printingMonitoringAdapter.operations.cancel
          : printingMonitoringAdapter.operations.emergencyStop;

    setPrintingMonitorActionBusy(action);
    setPrintingMonitorControlPendingAction(action);
    setPrintingMonitorActionStatus(null);

    try {
      const response = await pluginNetworkFetch({
        pluginId: printingMonitoringAdapter.pluginId,
        operation,
        ipAddress: host,
        port,
        plateId: printingMonitorPlateId,
      });

      const payload = await readJsonObject(response);
      if (!response.ok || payload?.ok === false) {
        const reason = typeof payload?.error === 'string'
          ? payload.error
          : `HTTP ${response.status}`;
        throw new Error(reason);
      }

      const successMessage = typeof payload?.message === 'string' && payload.message.trim().length > 0
        ? payload.message.trim()
        : action === 'pause'
          ? 'Pause command sent.'
          : action === 'resume'
            ? 'Resume command sent.'
            : action === 'cancel'
              ? 'Cancel command sent.'
              : 'Emergency stop command sent.';

      setPrintingMonitorActionStatus(successMessage);
      setPrintingMonitorError(null);

      const statusResponse = await pluginNetworkFetch({
        pluginId: printingMonitoringAdapter.pluginId,
        operation: printingMonitoringAdapter.operations.status,
        ipAddress: host,
        port,
        plateId: printingMonitorPlateId,
      });
      const statusPayload = await readJsonObject(statusResponse);
      if (statusResponse.ok) {
        setPrintingMonitorSnapshot(printingMonitoringAdapter.parseStatusPayload(statusPayload, `${host}:${port}`));
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Failed to send control command to printer.';
      setPrintingMonitorError(message);
      setPrintingMonitorActionStatus(null);
      setPrintingMonitorControlPendingAction(null);
    } finally {
      setPrintingMonitorActionBusy(null);
    }
  }, [monitoringDevice?.ipAddress, monitoringDevice?.port, printingMonitorPlateId, printingMonitoringAdapter]);

  const executePrintingMonitorFeatureToggle = React.useCallback(async (
    feature: 'webcam' | 'timelapse',
    enabled: boolean,
  ) => {
    if (!printingMonitoringAdapter.pluginId || !printingMonitoringAdapter.operations) return;

    const operation = feature === 'webcam'
      ? (enabled ? printingMonitoringAdapter.operations.webcamEnable : printingMonitoringAdapter.operations.webcamDisable)
      : (enabled ? printingMonitoringAdapter.operations.timelapseEnable : printingMonitoringAdapter.operations.timelapseDisable);
    if (!operation) {
      setPrintingMonitorError(`This monitor plugin does not expose ${feature} ${enabled ? 'enable' : 'disable'} commands.`);
      return;
    }

    const host = (monitoringDevice?.ipAddress || '').trim();
    const port = monitoringDevice?.port || 80;
    if (!host) {
      setPrintingMonitorError(`No printer IP available for ${feature} command.`);
      return;
    }

    const busyKey = feature === 'webcam'
      ? (enabled ? 'webcam-enable' : 'webcam-disable')
      : (enabled ? 'timelapse-enable' : 'timelapse-disable');

    const statusRawPayload = printingMonitorDebugState.status.rawPayload;
    const statusPayloadRecord = (statusRawPayload && typeof statusRawPayload === 'object' && !Array.isArray(statusRawPayload))
      ? statusRawPayload as Record<string, unknown>
      : null;
    const rawMainboardId = statusPayloadRecord?.mainboardId ?? statusPayloadRecord?.MainboardID;
    const resolvedMainboardId = typeof rawMainboardId === 'string' && rawMainboardId.trim().length > 0
      ? rawMainboardId.trim()
      : monitoringDeviceMainboardId;

    setPrintingMonitorActionBusy(busyKey);
    setPrintingMonitorActionStatus(null);
    let recordedResponse = false;

    try {
      const response = await pluginNetworkFetch({
        pluginId: printingMonitoringAdapter.pluginId,
        operation,
        ipAddress: host,
        port,
        mainboardId: resolvedMainboardId,
      });

      const payload = await readJsonObject(response);
      const commandOk = typeof payload?.ok === 'boolean' ? payload.ok : (response.ok ? true : false);
      setPrintingMonitorLastFeatureToggleResponse({
        operation,
        httpStatus: response.status,
        httpOk: response.ok,
        commandOk,
        payload,
        error: payload?.ok === false || !response.ok
          ? (typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
          : null,
        requestedAtEpochMs: Date.now(),
      });
      recordedResponse = true;
      if (!response.ok || payload?.ok === false) {
        const reason = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(reason);
      }

      const featureLabel = feature === 'webcam' ? 'Video stream' : 'Timelapse';
      setPrintingMonitorActionStatus(
        typeof payload?.message === 'string' && payload.message.trim().length > 0
          ? payload.message.trim()
          : `${featureLabel} ${enabled ? 'enabled' : 'disabled'}.`,
      );
      setPrintingMonitorError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to send ${feature} command.`;
      setPrintingMonitorError(message);
      setPrintingMonitorActionStatus(null);
      if (!recordedResponse) {
        setPrintingMonitorLastFeatureToggleResponse({
          operation,
          httpStatus: null,
          httpOk: false,
          commandOk: false,
          payload: null,
          error: message,
          requestedAtEpochMs: Date.now(),
        });
      }
    } finally {
      setPrintingMonitorActionBusy(null);
    }
  }, [
    monitoringDevice?.ipAddress,
    monitoringDevice?.port,
    monitoringDeviceMainboardId,
    printingMonitorDebugState.status.rawPayload,
    printingMonitoringAdapter,
  ]);

  const executePrintingMonitorSdcpDebugCommand = React.useCallback(async (
    options: {
      operation: string;
      label: string;
      channel: PrintingMonitorDebugChannel;
      payload?: Record<string, unknown>;
    },
  ) => {
    if (!printingMonitoringAdapter.pluginId) return;

    const host = (monitoringDevice?.ipAddress || '').trim();
    const port = monitoringDevice?.port || 80;
    if (!host) {
      setPrintingMonitorError(`No printer IP available for ${options.label}.`);
      return;
    }

    const requestPayload = {
      pluginId: printingMonitoringAdapter.pluginId,
      operation: options.operation,
      ipAddress: host,
      port,
      ...(options.payload ?? {}),
    };

    setPrintingMonitorActionBusy(null);
    setPrintingMonitorActionStatus(null);

    try {
      const response = await pluginNetworkFetch(requestPayload);
      const payload = await readJsonObject(response);

      setPrintingMonitorDebugState((previous) => ({
        ...previous,
        [options.channel]: {
          requestedAtEpochMs: Date.now(),
          request: requestPayload,
          httpStatus: response.status,
          rawPayload: payload,
          parsedPayload: payload,
          error: (!response.ok || payload?.ok === false)
            ? (typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
            : null,
        },
      }));

      const commandOk = typeof payload?.ok === 'boolean'
        ? payload.ok
        : response.ok;
      setPrintingMonitorLastFeatureToggleResponse({
        operation: options.operation,
        httpStatus: response.status,
        httpOk: response.ok,
        commandOk,
        payload,
        error: (!response.ok || payload?.ok === false)
          ? (typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
          : null,
        requestedAtEpochMs: Date.now(),
      });

      if (!response.ok || payload?.ok === false) {
        const reason = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(reason);
      }

      setPrintingMonitorActionStatus(
        typeof payload?.message === 'string' && payload.message.trim().length > 0
          ? payload.message.trim()
          : `${options.label} command accepted.`,
      );
      setPrintingMonitorError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to run ${options.label} command.`;
      setPrintingMonitorError(message);
      setPrintingMonitorActionStatus(null);
      setPrintingMonitorLastFeatureToggleResponse((previous) => ({
        operation: options.operation,
        httpStatus: previous?.operation === options.operation ? previous.httpStatus : null,
        httpOk: previous?.operation === options.operation ? previous.httpOk : false,
        commandOk: false,
        payload: previous?.operation === options.operation ? previous.payload : null,
        error: message,
        requestedAtEpochMs: Date.now(),
      }));
    }
  }, [monitoringDevice?.ipAddress, monitoringDevice?.port, printingMonitoringAdapter.pluginId]);

  const handlePrintingMonitorControlAction = React.useCallback((
    action: 'pause' | 'resume' | 'cancel' | 'emergency-stop',
  ) => {
    if (action === 'cancel' || action === 'emergency-stop') {
      setPrintingMonitorPendingConfirmation({ kind: 'control', action });
      return;
    }

    void executePrintingMonitorControlAction(action);
  }, [executePrintingMonitorControlAction]);

  React.useEffect(() => {
    if (!printingMonitorPendingConfirmation) return;

    let wasEscapePressed = false;
    const unsubscribe = hotkeyStore.subscribe((state) => {
      const active = state.activeKeys;
      const isEscapePressed = active.has('escape');
      if (isEscapePressed && !wasEscapePressed) {
        setPrintingMonitorPendingConfirmation(null);
      }
      wasEscapePressed = isEscapePressed;
    });

    return unsubscribe;
  }, [printingMonitorPendingConfirmation]);

  const printingMonitorDebugBundle = React.useMemo(() => {
    const selectedDeviceSummary = monitoringDevice
      ? {
          id: monitoringDevice.id,
          displayName: monitoringDevice.displayName,
          hostName: monitoringDevice.hostName,
          ipAddress: monitoringDevice.ipAddress,
          port: monitoringDevice.port,
          connectedFlag: monitoringDevice.connected,
          reachability: printerReachabilityByDeviceId[monitoringDevice.id],
        }
      : null;

    const channelSummary = (channel: PrintingMonitorDebugChannel) => {
      const debug = printingMonitorDebugState[channel];
      return {
        requestedAt: debug.requestedAtEpochMs
          ? new Date(debug.requestedAtEpochMs).toISOString()
          : null,
        httpStatus: debug.httpStatus,
        request: debug.request,
        error: debug.error,
        rawPayload: debug.rawPayload,
        parsedPayload: debug.parsedPayload,
      };
    };

    return {
      selectedDevice: selectedDeviceSummary,
      offlineGate: {
        isPrintingMonitorSelectedPrinterOffline,
        snapshotConnected: printingMonitorSnapshot?.connected ?? null,
        snapshotStateText: printingMonitorSnapshot?.stateText ?? null,
      },
      channels: {
        status: channelSummary('status'),
        webcam: channelSummary('webcam'),
        plates: channelSummary('plates'),
        taskHistory: channelSummary('taskHistory'),
        taskDetails: channelSummary('taskDetails'),
      },
    };
  }, [
    isPrintingMonitorSelectedPrinterOffline,
    monitoringDevice,
    printerReachabilityByDeviceId,
    printingMonitorDebugState,
    printingMonitorSnapshot?.connected,
    printingMonitorSnapshot?.stateText,
  ]);

  const printingMonitorDebugPanels = React.useMemo(() => {
    if (!isPrintingMonitorDebugOpen) return [] as Array<{
      channel: PrintingMonitorDebugChannel;
      statusText: string;
      requestedAt: string | null;
      json: string;
      hasError: boolean;
    }>;

    return PRINTING_MONITOR_DEBUG_CHANNELS.map((channel) => {
      const selectedChannel = printingMonitorDebugBundle.channels[channel];
      const payload = {
        channel,
        requestedAt: selectedChannel.requestedAt,
        httpStatus: selectedChannel.httpStatus,
        request: selectedChannel.request,
        error: selectedChannel.error,
        rawPayload: selectedChannel.rawPayload,
        parsedPayload: selectedChannel.parsedPayload,
      };

      let serialized = '';
      try {
        serialized = JSON.stringify(payload, null, 2);
      } catch {
        serialized = JSON.stringify({
          ...payload,
          rawPayload: '<unserializable>',
          parsedPayload: '<unserializable>',
        }, null, 2);
      }

      const hasError = Boolean(selectedChannel.error);
      const statusText = hasError
        ? 'error'
        : selectedChannel.httpStatus == null
          ? 'pending'
          : `HTTP ${selectedChannel.httpStatus}`;

      return {
        channel,
        statusText,
        requestedAt: selectedChannel.requestedAt,
        json: serialized,
        hasError,
      };
    });
  }, [isPrintingMonitorDebugOpen, printingMonitorDebugBundle.channels]);

  const handleCopyPrintingMonitorDebugBundle = React.useCallback(async () => {
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(JSON.stringify({
        generatedAt: new Date().toISOString(),
        ...printingMonitorDebugBundle,
      }, null, 2));
      setPrintingMonitorDebugCopyState('copied');
    } catch {
      setPrintingMonitorDebugCopyState('failed');
    }
  }, [printingMonitorDebugBundle]);

  React.useEffect(() => {
    if (printingMonitorDebugCopyState === 'idle') return;
    const timeoutId = window.setTimeout(() => setPrintingMonitorDebugCopyState('idle'), 1800);
    return () => window.clearTimeout(timeoutId);
  }, [printingMonitorDebugCopyState]);

  return {
    printingTargetPickerOpen,
    setPrintingTargetPickerOpen,
    printingTargetPickerMode,
    setPrintingTargetPickerMode,
    printingTargetDeviceId,
    setPrintingTargetDeviceId,
    printingTargetMaterialId,
    setPrintingTargetMaterialId,
    printingTargetMaterialOptions,
    setPrintingTargetMaterialOptions,
    isPrintingTargetMaterialsLoading,
    setIsPrintingTargetMaterialsLoading,
    printingTargetMaterialError,
    setPrintingTargetMaterialError,
    printingTargetMaterialsCacheRef,
    printingMonitorSnapshot,
    setPrintingMonitorSnapshot,
    printingMonitorWebcamInfo,
    setPrintingMonitorWebcamInfo,
    printingMonitorRelayBaseWsUrl,
    setPrintingMonitorRelayBaseWsUrl,
    printingMonitorRelaySetupError,
    setPrintingMonitorRelaySetupError,
    printingMonitorRelayDebugTransport,
    setPrintingMonitorRelayDebugTransport,
    printingMonitorRelayReclaimDebug,
    setPrintingMonitorRelayReclaimDebug,
    isPrintingMonitorThumbnailLoaded,
    setIsPrintingMonitorThumbnailLoaded,
    printingMonitorThumbnailDisplayUrl,
    setPrintingMonitorThumbnailDisplayUrl,
    isPrintingMonitorWebcamLoaded,
    setIsPrintingMonitorWebcamLoaded,
    printingMonitorWebcamLoadError,
    setPrintingMonitorWebcamLoadError,
    printingMonitorWebcamAspectRatio,
    setPrintingMonitorWebcamAspectRatio,
    printingMonitorWebcamRefreshNonce,
    setPrintingMonitorWebcamRefreshNonce,
    isPrintingMonitorWebcamResetBusy,
    setIsPrintingMonitorWebcamResetBusy,
    isPrintingMonitorWebcamSnapshotSaving,
    setIsPrintingMonitorWebcamSnapshotSaving,
    printingMonitorWebcamExpanded,
    setPrintingMonitorWebcamExpanded,
    printingMonitorRecentPlates,
    setPrintingMonitorRecentPlates,
    isPrintingMonitorRecentPlatesLoading,
    setIsPrintingMonitorRecentPlatesLoading,
    printingMonitorRecentPlatesError,
    setPrintingMonitorRecentPlatesError,
    printingMonitorPlatesStoragePath,
    setPrintingMonitorPlatesStoragePath,
    printingMonitorSelectedPlateId,
    setPrintingMonitorSelectedPlateId,
    isPrintingMonitorPolling,
    setIsPrintingMonitorPolling,
    isPrintingMonitorStatusRequestInFlight,
    setIsPrintingMonitorStatusRequestInFlight,
    printingMonitorLastStatusSuccessAtMs,
    setPrintingMonitorLastStatusSuccessAtMs,
    printingMonitorNowEpochMs,
    setPrintingMonitorNowEpochMs,
    printingMonitorActionBusy,
    setPrintingMonitorActionBusy,
    printingMonitorControlPendingAction,
    setPrintingMonitorControlPendingAction,
    printingMonitorActionStatus,
    setPrintingMonitorActionStatus,
    printingMonitorPendingConfirmation,
    setPrintingMonitorPendingConfirmation,
    printingMonitorDeviceId,
    setPrintingMonitorDeviceId,
    printingMonitorViewMode,
    setPrintingMonitorViewMode,
    printingMonitorDashboardSnapshots,
    setPrintingMonitorDashboardSnapshots,
    isPrintingMonitorDashboardRefreshing,
    setIsPrintingMonitorDashboardRefreshing,
    isPrintingMonitorPrinterMenuOpen,
    setIsPrintingMonitorPrinterMenuOpen,
    isPrintingMonitorPrinterThumbnailFailed,
    setIsPrintingMonitorPrinterThumbnailFailed,
    printingMonitorModalOpen,
    setPrintingMonitorModalOpen,
    isPrintingMonitorDebugOpen,
    setIsPrintingMonitorDebugOpen,
    isPrintingMonitorRtspDebugOpen,
    setIsPrintingMonitorRtspDebugOpen,
    printingMonitorDebugCopyState,
    setPrintingMonitorDebugCopyState,
    printingMonitorLastFeatureToggleResponse,
    setPrintingMonitorLastFeatureToggleResponse,
    printingMonitorDebugState,
    setPrintingMonitorDebugState,
    printingMonitorPrinterMenuRef,
    printingMonitorWebcamViewportRef,
    printingMonitorThumbnailCacheRef,
    printingMonitorWebcamRequestInFlightRef,
    printingMonitorWebcamBusyUntilEpochMsRef,
    printingMonitorWebcamAutoPollBlockedRef,
    printingMonitorWebcamConsecutiveTimeoutsRef,
    printingMonitorRelayAutoRetryCountRef,
    printingMonitorRelayAutoRetryTimeoutRef,
    printingMonitorWebcamReadinessTokenRef,
    printingMonitorWebcamReadinessTimeoutRef,
    printingMonitorStartFocusDeviceIdRef,
    printingMonitorRecentPlatesRequestIdRef,
    printingMonitorRecentPlatesRef,
    printingMonitorSelectedPlateIdRef,
    printingMonitorRecentPlatesCacheRef,
    printingMonitorLeftColumnRef,
    printingMonitorWebcamSectionRef,
    printingMonitorWebcamFollowerHeightPxRef,
    monitorReachabilityInconclusiveCountsRef,
    selectedPrinterMonitorSnapshot,
    setSelectedPrinterMonitorSnapshot,
    printingMonitoringAdapter,
    printingTargetDevice,
    monitorSelectableDevices,
    dashboardMonitorDevices,
    dashboardOnlineMonitorDevices,
    monitoringDevice,
    monitoringDeviceId,
    monitoringDeviceHost,
    monitoringDevicePort,
    monitoringDeviceMainboardId,
    printingMonitorRecentPlatesCacheKey,
    printingTargetMaterialGroups,
    requiresRemoteMaterialSelectionForUpload,
    isPreSliceTargetPicker,
    printingMonitorPlateId,
    printingMonitorThumbnailUrl,
    printingMonitorThumbnailCacheKey,
    printingMonitorInlineWebcamUrl,
    printingMonitorRtspSourceUrl,
    printingMonitorIsDesktopRuntime,
    printingMonitorWebcamUrl,
    printingMonitorWebcamUsesRelayWs,
    printingMonitorRtspDebugSummary,
    printingMonitorHasCamera,
    printingMonitorUsesTwoColumnDetailLayout,
    printingMonitorModalWidthClass,
    printingMonitorWebcamStatusPresentation,
    printingMonitorWebcamDisplayPresentation,
    printingMonitorUiPolicy,
    printingMonitorBusyGraceMs,
    printingMonitorReachabilityMaxInconclusivePolls,
    printingMonitorSupportsWebcamStreamSlotReset,
    printingMonitorWebcamMaxConsecutiveTimeouts,
    printingMonitorWebcamTimeoutCooldownMs,
    printingMonitorWebcamFailureCooldownMs,
    printingMonitorWebcamCanResetStreamSlot,
    monitorWebcamRotationDeg,
    shouldSwapMonitorWebcamAspect,
    monitorWebcamTransform,
    printingMonitorCanExpandWebcam,
    printingMonitorDetailWebcamExpanded,
    monitorWebcamDisplayAspectRatio,
    printingMonitorStateTextNormalized,
    printingMonitorIsPauseTransition,
    printingMonitorIsCancelTransition,
    printingMonitorHasActivePrint,
    printingMonitorAnyActionBusy,
    printingMonitorCancelButtonAnimating,
    printingMonitorPauseButtonAnimating,
    printingMonitorPauseButtonDisabled,
    printingMonitorCancelButtonDisabled,
    printingMonitorEmergencyStopDisabled,
    printingMonitorDisplayProgressPct,
    printingMonitorDisplayCurrentLayer,
    printingMonitorDisplayTotalLayers,
    printingMonitorDisplayMaterialProfile,
    isPrintingMonitorSelectedPrinterOfflineRaw,
    isPrintingMonitorWithinSlowResponseGrace,
    printingMonitorSlowResponseGraceRemainingSec,
    shouldShowPrintingMonitorSlowResponseCard,
    isPrintingMonitorSelectedPrinterOffline,
    hasMonitorSelectableTarget,
    hasPrintingMonitorFleet,
    printingMonitorPrinterThumbnailSrc,
    printingMonitorHeaderUsesFleetLabelOrder,
    printingMonitorHeaderTopLabel,
    printingMonitorHeaderBottomLabel,
    printingMonitorHeaderTitle,
    showTopbarMonitorButton,
    refreshPrintingMonitorRecentPlates,
    handlePrintingMonitorStoragePathChange,
    cancelPrintingMonitorWebcamReadinessCheck,
    schedulePrintingMonitorMjpegReadinessCheck,
    triggerPrintingMonitorWebcamRetry,
    handleSavePrintingMonitorWebcamSnapshot,
    flushMonitors,
    handleResetPrintingMonitorWebcamStreamSlot,
    openPrintingMonitorForTargetDevice,
    executeStartMonitorRecentPlate,
    handleStartMonitorRecentPlate,
    executeDeleteMonitorRecentPlate,
    handleDeleteMonitorRecentPlate,
    executePrintingMonitorControlAction,
    executePrintingMonitorFeatureToggle,
    executePrintingMonitorSdcpDebugCommand,
    handlePrintingMonitorControlAction,
    printingMonitorDebugBundle,
    printingMonitorDebugPanels,
    handleCopyPrintingMonitorDebugBundle,
  };
}
