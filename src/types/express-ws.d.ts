declare module 'express-ws' {
  import type { Application } from 'express';
  import type { Server } from 'http';

  type ExpressWsInstaller = (app: Application, server?: Server) => unknown;

  const expressWs: ExpressWsInstaller;

  export default expressWs;
}