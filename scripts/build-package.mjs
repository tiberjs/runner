import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Renamed and extracted modules must not survive in a package's published output.
rmSync("dist", { recursive: true, force: true });

const compiler = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));
const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.build.json"], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
