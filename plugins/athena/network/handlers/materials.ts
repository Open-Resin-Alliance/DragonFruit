type HandlerResult = {
  status: number;
  body: unknown;
};

type MaterialsHandlers = {
  materials: (payload: unknown) => Promise<HandlerResult>;
  materialsEdit: (payload: unknown) => Promise<HandlerResult>;
};

export async function tryHandleNanoDlpMaterialsOperation(
  op: string,
  payload: unknown,
  handlers: MaterialsHandlers,
): Promise<HandlerResult | null> {
  if (op === 'materials') return handlers.materials(payload);
  if (op === 'materials/edit') return handlers.materialsEdit(payload);
  return null;
}
