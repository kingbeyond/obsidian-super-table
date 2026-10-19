import { build } from "esbuild";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({ absWorkingDir: root, entryPoints: ["src/filters.ts"], bundle: true, write: false, platform: "node", format: "esm" });
const { filterRows } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const fields = [
  { id: "number", name: "Number", type: "number" }, { id: "text", name: "Text", type: "text" },
  { id: "tags", name: "Tags", type: "multiselect" }, { id: "date", name: "Date", type: "date", dateFormat: "iso-date" },
];
const results = [];
for (const count of [1000, 10000]) {
  const rows = Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, values: { number: index, text: `Example row ${index}`, tags: ["a", "b"], date: "2026-10-15T09:30" } }));
  for (const conditions of [1, 5, 20]) {
    for (const mode of ["and", "or"]) {
      // AND matches all; OR matches none, forcing every condition to run.
      const matching = mode === "and";
      const templates = [
        { fieldId: "number", operator: "gte", value: matching ? 0 : count },
        { fieldId: "text", operator: "contains", value: matching ? "example" : "missing" },
        { fieldId: "tags", operator: "contains", value: [matching ? "a" : "missing"] },
        { fieldId: "date", operator: "eq", value: matching ? "2026-10-15" : "2026-10-16" },
      ];
      const filters = { mode, conditions: Array.from({ length: conditions }, (_, index) => ({ ...templates[index % templates.length], id: `condition-${index}` })) };
      for (let warmup = 0; warmup < 10; warmup++) filterRows(fields, rows, filters);
      const samples = [];
      for (let sample = 0; sample < 15; sample++) {
        const start = performance.now(); const actual = filterRows(fields, rows, filters); const elapsed = performance.now() - start;
        if (actual.length !== (matching ? count : 0)) throw new Error("Unexpected benchmark projection");
        samples.push(elapsed);
      }
      samples.sort((a, b) => a - b);
      results.push({ records: count, conditions, mode, medianMs: +samples[7].toFixed(3), minMs: +samples[0].toFixed(3), maxMs: +samples.at(-1).toFixed(3) });
    }
  }
}
console.log(JSON.stringify({ runtime: process.version, platform: process.platform, arch: process.arch, samples: 15, scenario: "mixed fields, no short circuit; compute only, excludes persistence and DOM", results }, null, 2));
