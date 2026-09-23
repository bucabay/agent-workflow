#!/usr/bin/env node
import { main } from '../src/awl/cli.mjs';

main().catch((err) => {
  console.error(`\nerror: ${err.message}`);
  process.exit(1);
});