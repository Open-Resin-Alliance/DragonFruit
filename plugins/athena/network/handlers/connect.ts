type HandlerResult = {
  status: number;
  body: unknown;
};

type ConnectHandlers = {
  connect: (payload: unknown) => Promise<HandlerResult>;
};

export async function tryHandleNanoDlpConnectOperation(
  op: string,
  payload: unknown,
  handlers: ConnectHandlers,
): Promise<HandlerResult | null> {
  if (op !== 'connect') return null;
  return handlers.connect(payload);
}
