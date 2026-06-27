import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.join(rootDir, "docs");

fs.rmSync(docsDir, { recursive: true, force: true });
fs.mkdirSync(docsDir, { recursive: true });
fs.writeFileSync(path.join(docsDir, ".nojekyll"), "", "utf8");

await import("./build-index.ts");
await import("./ddb-bucketing-scaling/simulation.ts");
await import("./ddb-bucketing-performance/simulation.ts");
await import("./team-throughput/simulation.ts");
