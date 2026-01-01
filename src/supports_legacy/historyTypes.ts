import { SupportInstance } from './types';

export type SupportHistoryAction =
  | {
      type: 'add';
      instance: SupportInstance;
    }
  | {
      type: 'remove';
      instance: SupportInstance;
    }
  | {
      type: 'update';
      previous: SupportInstance;
      instance: SupportInstance;
    };
