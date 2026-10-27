#!/usr/bin/env node
import { runCli } from './cli-main';

runCli(process.argv.slice(2), { env: process.env, fetchImpl: fetch, out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
