import { tryHandleNanoDlpConnectOperation } from './connect';
import { tryHandleNanoDlpDiscoverOperation } from './discover';
import { tryHandleNanoDlpMaterialsOperation } from './materials';
import { tryHandleNanoDlpJobOperation } from './jobs';
import { tryHandleNanoDlpPrinterOperation } from './printer';

type HandlerResult = {
  status: number;
  body: unknown;
};

export type NanoDlpOperationHandlers = {
  connect: (payload: unknown) => Promise<HandlerResult>;
  discover: (payload: unknown) => Promise<HandlerResult>;
  materials: (payload: unknown) => Promise<HandlerResult>;
  materialsEdit: (payload: unknown) => Promise<HandlerResult>;
  jobImport: (payload: unknown) => Promise<HandlerResult>;
  platesListJson: (payload: unknown) => Promise<HandlerResult>;
  plateDelete: (payload: unknown) => Promise<HandlerResult>;
  printerStart: (payload: unknown) => Promise<HandlerResult>;
  printerPause: (payload: unknown) => Promise<HandlerResult>;
  printerResume: (payload: unknown) => Promise<HandlerResult>;
  printerCancel: (payload: unknown) => Promise<HandlerResult>;
  printerEmergencyStop: (payload: unknown) => Promise<HandlerResult>;
  printerStatus: (payload: unknown) => Promise<HandlerResult>;
  printerWebcamInfo: (payload: unknown) => Promise<HandlerResult>;
};

export async function dispatchNanoDlpOperation(
  op: string,
  payload: unknown,
  handlers: NanoDlpOperationHandlers,
): Promise<HandlerResult | null> {
  const connect = await tryHandleNanoDlpConnectOperation(op, payload, {
    connect: handlers.connect,
  });
  if (connect) return connect;

  const discover = await tryHandleNanoDlpDiscoverOperation(op, payload, {
    discover: handlers.discover,
  });
  if (discover) return discover;

  const materials = await tryHandleNanoDlpMaterialsOperation(op, payload, {
    materials: handlers.materials,
    materialsEdit: handlers.materialsEdit,
  });
  if (materials) return materials;

  const jobs = await tryHandleNanoDlpJobOperation(op, payload, {
    jobImport: handlers.jobImport,
    platesListJson: handlers.platesListJson,
    plateDelete: handlers.plateDelete,
  });
  if (jobs) return jobs;

  const printer = await tryHandleNanoDlpPrinterOperation(op, payload, {
    start: handlers.printerStart,
    pause: handlers.printerPause,
    resume: handlers.printerResume,
    cancel: handlers.printerCancel,
    emergencyStop: handlers.printerEmergencyStop,
    status: handlers.printerStatus,
    webcamInfo: handlers.printerWebcamInfo,
  });
  if (printer) return printer;

  return null;
}
