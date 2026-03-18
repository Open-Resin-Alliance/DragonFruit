type HandlerResult = {
  status: number;
  body: unknown;
};

type PrinterHandlers = {
  start: (payload: unknown) => Promise<HandlerResult>;
  pause: (payload: unknown) => Promise<HandlerResult>;
  resume: (payload: unknown) => Promise<HandlerResult>;
  cancel: (payload: unknown) => Promise<HandlerResult>;
  emergencyStop: (payload: unknown) => Promise<HandlerResult>;
  status: (payload: unknown) => Promise<HandlerResult>;
  webcamInfo: (payload: unknown) => Promise<HandlerResult>;
};

export async function tryHandleNanoDlpPrinterOperation(
  op: string,
  payload: unknown,
  handlers: PrinterHandlers,
): Promise<HandlerResult | null> {
  if (op === 'printer/start') return handlers.start(payload);
  if (op === 'printer/pause') return handlers.pause(payload);
  if (op === 'printer/unpause' || op === 'printer/resume') return handlers.resume(payload);
  if (op === 'printer/stop' || op === 'printer/cancel') return handlers.cancel(payload);
  if (op === 'printer/force-stop' || op === 'printer/emergency-stop') return handlers.emergencyStop(payload);
  if (op === 'printer/status') return handlers.status(payload);
  if (op === 'printer/webcam/info') return handlers.webcamInfo(payload);
  return null;
}
