// Runs the repo's .venv Python with this script's arguments, so that `pnpm test:py`
// and `pnpm lint:py` work on Windows too, where the venv's interpreter is
// .venv\Scripts\python.exe rather than .venv/bin/python. Setup: docs/cod/README.md.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const python = process.platform === "win32" ? join(".venv", "Scripts", "python.exe") : join(".venv", "bin", "python");
if (!existsSync(python)) {
  console.error(`no ${python}: create the venv as docs/cod/README.md says`);
  process.exit(1);
}
const result = spawnSync(python, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
