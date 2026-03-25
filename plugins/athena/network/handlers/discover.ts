type HandlerResult = {
  status: number;
  body: unknown;
};

type DiscoverHandlers = {
  discover: (payload: unknown) => Promise<HandlerResult>;
};

export async function tryHandleNanoDlpDiscoverOperation(
  op: string,
  payload: unknown,
  handlers: DiscoverHandlers,
): Promise<HandlerResult | null> {
  if (op !== 'discover') return null;
  return handlers.discover(payload);
}
