#!/usr/bin/env node
import path from 'node:path';
import { Store } from '../src/store.js';
import { startAdminServer } from '../src/admin.js';
import { parsePositiveInt } from '../src/util.js';

const args = process.argv.slice(2);
let dataDir = process.env.RPA_DATA_DIR ?? '.rpa';
let port = 4700;
let dataset = 'fixture';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--data-dir') dataDir = args[++i];
  else if (args[i] === '--port') port = parsePositiveInt(args[++i], 4700);
  else if (args[i] === '--dataset') dataset = args[++i];
}

const root = path.resolve(dataDir);
const store = Store.open(path.join(root, 'rpa.sqlite'));
const admin = startAdminServer({
  store,
  artifactsDir: path.join(root, 'artifacts', dataset),
  port,
});
const { url } = await admin.listen();
console.log(`RPA admin listening at ${url}`);
console.log(`  data dir: ${root}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await admin.close();
    store.close();
    process.exit(0);
  });
}
