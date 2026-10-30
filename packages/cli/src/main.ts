#!/usr/bin/env node
import { run } from "./index.ts";

process.exitCode = run(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
