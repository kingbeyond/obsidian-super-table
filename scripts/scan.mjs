import { ESLint } from "eslint";
import postcss from "postcss";
import ts from "typescript";
import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";

// Local source/CSS checks, not a replacement for the directory's release/build scan.
const lint = new ESLint();
const results = await lint.lintFiles(["src"]);
const findings = results.flatMap((result) => result.messages.map((message) => ({
  file: relative(process.cwd(), result.filePath), line: message.line ?? 1,
  severity: message.severity === 2 ? "error" : "warning",
  rule: message.ruleId ?? "eslint", message: message.message,
})));

const css = postcss.parse(await readFile("styles.css", "utf8"), { from: "styles.css" });
const cssFinding = (node, rule, message) => findings.push({
  file: "styles.css", line: node.source.start.line, severity: "warning", rule, message,
});
css.walkDecls((declaration) => {
  if (declaration.important) cssFinding(declaration, "css/no-important", "Review the necessity of !important against host and theme styles.");
  if (declaration.prop === "clip-path") cssFinding(declaration, "css/clip-path-compatibility", "Check clipping fallback and screen-reader access on supported hosts.");
  if (declaration.prop === "column-gap") cssFinding(declaration, "css/column-gap-compatibility", "Review the layout context; this property also applies to Grid and Flexbox.");
});
css.walkRules((rule) => {
  for (const _match of rule.selector.matchAll(/:has\(/g)) {
    cssFinding(rule, "css/has-performance", "Review selector scope and invalidation cost; do not remove necessary menu isolation.");
  }
});

// Capability notices are grouped once per behavior, like the directory review.
const capabilities = new Map();
for (const result of results) {
  const file = relative(process.cwd(), result.filePath);
  const source = ts.createSourceFile(file, await readFile(result.filePath, "utf8"), ts.ScriptTarget.Latest, true);
  const record = (node, rule, message) => {
    if (!capabilities.has(rule)) capabilities.set(rule, {
      file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      severity: "recommendation", rule, message,
    });
  };
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const call = node.expression.getText(source);
      if (/\.vault\.(getFiles|getMarkdownFiles)$/.test(call)) record(node, "behavior/vault-enumeration", "Vault file enumeration is used for the attachment picker.");
      if (/\.clipboard\.(read|readText|write|writeText)$/.test(call)) record(node, "behavior/clipboard", "Clipboard access supports user copy/paste operations.");
      if (/\.(localStorage|sessionStorage)\.(getItem|setItem|removeItem)$/.test(call)) record(node, "behavior/local-storage", "Browser storage supports the host language fallback and device-local view memory.");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
findings.push(...capabilities.values());
const counts = {
  errors: findings.filter((item) => item.severity === "error").length,
  warnings: findings.filter((item) => item.severity === "warning").length,
  recommendations: findings.filter((item) => item.severity === "recommendation").length,
};
const report = {
  scope: "Local ESLint (Obsidian recommended plus unsafe-value checks), CSS heuristics, and capability notices. No remote directory review, release attestation verification, malware scan, or build reproduction.",
  counts, findings,
};
for (const finding of findings) console.log(`${finding.file}:${finding.line} ${finding.severity} ${finding.rule} ${finding.message}`);
console.log(`Local scan: ${counts.errors} errors, ${counts.warnings} warnings, ${counts.recommendations} recommendations.`);
const args = process.argv.slice(2);
if (args.length) {
  if (args.length !== 2 || args[0] !== "--json") throw new Error("Usage: npm run scan -- [--json report-path]");
  await writeFile(args[1], JSON.stringify(report, null, 2) + "\n");
}
process.exitCode = counts.errors ? 1 : 0;
