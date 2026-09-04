type HandlerResult = {
  status: number;
  body: unknown;
};

type PrinterDataHandlers = {
  printerData: (payload: unknown) => Promise<HandlerResult>;
};

export async function tryHandleNanoDlpPrinterDataOperation(
  op: string,
  payload: unknown,
  handlers: PrinterDataHandlers,
): Promise<HandlerResult | null> {
  if (op === 'printerData') return handlers.printerData(payload);
  return null;
}
