import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const features = ["table-block", "data-format", "fields", "records", "views", "search", "interaction", "markdown", "attachments", "import-export", "storage", "layout", "localization"];
const args = process.argv.slice(2);
const testArgs = [];
const requestedFeatures = [];
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--feature") {
    requestedFeatures.push(args[++index] ?? "");
  } else if (arg.startsWith("--feature=")) {
    requestedFeatures.push(arg.slice("--feature=".length));
  } else {
    testArgs.push(arg);
  }
}
const unknownFeatures = requestedFeatures.filter((feature) => !features.includes(feature));
if (unknownFeatures.length) {
  console.error(`Unknown feature: ${unknownFeatures.join(", ")}. Available features: ${features.join(", ")}`);
  process.exit(2);
}
if (requestedFeatures.length && testArgs.some((arg) => arg === "--test-name-pattern" || arg.startsWith("--test-name-pattern="))) {
  console.error("Use either --feature or --test-name-pattern, not both.");
  process.exit(2);
}
const folder = await mkdtemp(join(tmpdir(), "super-table-tests-"));
try {
  const output = join(folder, "tests.cjs");
  await build({ entryPoints: ["tests/core.test.ts"], outfile: output, bundle: true, platform: "node", format: "cjs", packages: "external", alias: { obsidian: resolve("tests/obsidian-stub.ts") } });
  const featurePattern = requestedFeatures.length
    ? `\\[(${[...new Set(requestedFeatures)].join("|")})\\]`
    : undefined;
  const result = spawnSync(process.execPath, ["--test", ...testArgs, ...(featurePattern ? ["--test-name-pattern", featurePattern] : []), output], { stdio: "inherit", env: { ...process.env, NODE_PATH: resolve("node_modules") } });
  process.exitCode = result.status ?? 1;
} finally { await rm(folder, { recursive: true, force: true }); }
