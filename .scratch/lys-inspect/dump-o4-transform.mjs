import { readFileSync } from 'node:fs';

const path = 'C:\\Users\\tyman\\Desktop\\Lys Conversion\\V3 Puck_Scene.json';
const scene = JSON.parse(readFileSync(path, 'utf8'));
const objs = scene?.objects?.present?.byId ?? {};
for (const [id, o] of Object.entries(objs)) {
  console.log('object', id);
  console.log('  center:      ', JSON.stringify(o.center));
  console.log('  formerCenter:', JSON.stringify(o.formerCenter));
  console.log('  position:    ', JSON.stringify(o.position));
  console.log('  rotation:    ', JSON.stringify(o.rotation));
  console.log('  scale:       ', JSON.stringify(o.scale));
}
