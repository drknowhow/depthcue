import { existsSync, readFileSync } from "node:fs";
import { evaluate, report } from "./budgets.mjs";

const config = JSON.parse(readFileSync(new URL("../budgets.json", import.meta.url), "utf8"));
const root = new URL("../", import.meta.url);
const rows = evaluate(config.budgets, (file) => {
  const url = new URL(file, root);
  return existsSync(url) ? readFileSync(url) : null;
});

for (const line of report(rows)) console.log(line);
process.exitCode = rows.every((row) => row.ok) ? 0 : 1;
