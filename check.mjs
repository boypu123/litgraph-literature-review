import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const lines = [];
function log(...args) {
  lines.push(args.map(String).join(" "));
}

try {
  const clientSource = readFileSync(join(here, "lib/client.js"), "utf8");
  new vm.Script(clientSource, { filename: "lib/client.js" });
  log("OK client syntax");
} catch (error) {
  log("FAIL client syntax:", error.message);
}

try {
  const host = await import(pathToFileURL(join(here, "lib/index.js")).href);
  log("OK host import, exports =", JSON.stringify(Object.keys(host)));
  log("inject =", JSON.stringify(host.inject));
  log("apply type =", typeof host.apply);
  log("name =", String(host.name));
} catch (error) {
  log("FAIL host import:", error.stack ?? error.message);
}

writeFileSync(join(here, "check-result.txt"), lines.join("\n"), "utf8");
console.log(lines.join("\n"));
