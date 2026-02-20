import genericPrinters from './generic/printers.json';
import concepts3dPrinters from './concepts3d/printers.json';

const printerPresets = [
  ...genericPrinters,
  ...concepts3dPrinters,
];

export default printerPresets;
