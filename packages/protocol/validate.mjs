// Validerer alle eksempler i ./examples mot skjemaet. Kjøres i CI (kontrakt-test).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(dir, 'agent-hub.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
let bad = 0;
for (const f of fs.readdirSync(path.join(dir, 'examples')).filter((f) => f.endsWith('.json'))) {
  const msg = JSON.parse(fs.readFileSync(path.join(dir, 'examples', f), 'utf8'));
  const ok = validate(msg);
  console.log(`${ok ? '✓' : '✗'} ${f}`);
  if (!ok) { bad++; console.log(JSON.stringify(validate.errors, null, 2)); }
}
process.exit(bad ? 1 : 0);
