#!/usr/bin/env node
/**
 * skillsync executable entry point. Runs directly — no build step.
 */
import { main } from '../src/cli.js';

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`fatal: ${(err && err.stack) || err}`);
    process.exit(1);
  });
