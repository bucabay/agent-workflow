#!/usr/bin/env node
import { loadWorkflow } from './src/awl/loader.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowPath = process.argv[2] || join(__dirname, 'default.workflow.json');
const schemaPath = join(__dirname, 'schema.json');

const { ok, schemaErrors, refErrors } = await loadWorkflow(workflowPath, schemaPath, { silent: false });

let exitCode = 0;
if (!ok) {
  exitCode = 1;
  if (schemaErrors.length) {
    console.log(`SCHEMA: ${schemaErrors.length} error(s)`);
    for (const e of schemaErrors) console.log(` - ${e}`);
  }
  if (refErrors.length) {
    console.log(`RESOLUTION: ${refErrors.length} unresolved reference(s)`);
    for (const e of refErrors) console.log(` - ${e}`);
  }
}
process.exitCode = exitCode;