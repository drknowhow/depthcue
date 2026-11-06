#!/usr/bin/env node
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDepthcueServer } from "./server.ts";

const USAGE = `Usage: depthcue-mcp <deck-folder>

Serves one deck folder to an MCP client over stdio, with seven tools: deck_get, deck_apply, deck_comment, deck_render,
deck_present, deck_asset and deck_export.
Set DEPTHCUE_BROWSER to a Chromium executable if Chrome or Edge is not installed.`;

const folder = process.argv[2];
if (!folder || folder.startsWith("-")) {
  console.error(USAGE);
  process.exit(2);
}
const root = resolve(folder);
if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`${root} is not a directory.\n\n${USAGE}`);
  process.exit(2);
}

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const depthcue = createDepthcueServer(root, version);

// stdout belongs to the protocol; anything else goes to stderr.
const shutdown = () => {
  depthcue.close().finally(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.stdin.once("end", shutdown);

await depthcue.server.connect(new StdioServerTransport());
depthcue.startChannel();
