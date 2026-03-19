type HandlerResult = {
  status: number;
  body: unknown;
};

type JobHandlers = {
  jobImport: (payload: unknown) => Promise<HandlerResult>;
  platesListJson: (payload: unknown) => Promise<HandlerResult>;
  plateDelete: (payload: unknown) => Promise<HandlerResult>;
};

export async function tryHandleNanoDlpJobOperation(
  op: string,
  payload: unknown,
  handlers: JobHandlers,
): Promise<HandlerResult | null> {
  if (op === 'job/import') return handlers.jobImport(payload);
  if (op === 'plates/list/json') return handlers.platesListJson(payload);
  if (op === 'plate/delete') return handlers.plateDelete(payload);
  return null;
}
