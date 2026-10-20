import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkRelease, validateNotes, validateVersions } from "./check-release.mjs";

const notes = "# 1.0.4\n\n## English\n\n### Improved\n- Simplifies host integration.\n\n## 简体中文\n\n### 改进\n- 简化宿主集成。\n";
function metadata() {
  return [
    { version: "1.0.4", minAppVersion: "1.13.0" },
    { version: "1.0.4" },
    { version: "1.0.4", packages: { "": { version: "1.0.4" } } },
    { "1.0.3": "1.8.7", "1.0.4": "1.13.0" },
  ];
}

test("matching metadata and tag pass without modifying historical mappings", () => {
  const files = metadata(); const before = structuredClone(files);
  assert.equal(validateVersions(...files), "1.0.4");
  assert.equal(validateVersions(...files, "1.0.4"), "1.0.4");
  assert.deepEqual(files, before);
});

test("every npm version must match the manifest, including the lock root", () => {
  for (const mutate of [
    (files) => { files[1].version = "1.0.3"; },
    (files) => { files[2].version = "1.0.3"; },
    (files) => { files[2].packages[""].version = "1.0.3"; },
    (files) => { delete files[2].packages; },
  ]) {
    const files = metadata(); mutate(files);
    assert.throws(() => validateVersions(...files), /must match manifest.version/);
  }
});

test("missing, mismatched, or malformed compatibility maps fail", () => {
  for (const versions of [undefined, [], {}, { "1.0.4": "1.8.7" }, { "1.0.4": "v1.13.0" }, { "v1.0.3": "1.8.7", "1.0.4": "1.13.0" }]) {
    const files = metadata(); files[3] = versions;
    assert.throws(() => validateVersions(...files));
  }
});

test("invalid manifest versions and tags are rejected before constructing notes paths", () => {
  for (const value of ["v1.0.4", "1.0", "01.0.4", "1.0.4-beta.1", "../1.0.4", "1.0.4\n", null]) {
    const files = metadata(); files[0].version = value;
    assert.throws(() => validateVersions(...files));
    assert.throws(() => validateVersions(...metadata(), value));
  }
  const files = metadata(); files[0].minAppVersion = "1.13";
  assert.throws(() => validateVersions(...files), /manifest.minAppVersion/);
  assert.throws(() => validateVersions(...metadata(), "1.0.3"), /Release tag must match/);
});

test("notes require real content in both languages, without a fixed compatibility footer", () => {
  assert.doesNotThrow(() => validateNotes(notes));
  for (const text of ["", notes.replace("- 简化宿主集成。", ""), notes.replace("## English", "## Other"), `${notes}\nTODO`, `${notes}\n待补充`, `${notes}\n<!-- add details -->`]) {
    assert.throws(() => validateNotes(text));
  }
});

test("metadata-only checks need no notes; release checks reject absent or unfinished notes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "super-table-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = metadata();
  for (const [index, file] of ["manifest.json", "package.json", "package-lock.json", "versions.json"].entries()) await writeFile(join(root, file), JSON.stringify(files[index]));
  assert.equal(await checkRelease({ root }), "1.0.4");
  await assert.rejects(checkRelease({ root, tag: "1.0.4" }), /ENOENT/);
  await mkdir(join(root, "docs/releases"), { recursive: true });
  await writeFile(join(root, "docs/releases/1.0.4.md"), `${notes}\nTBD`);
  await assert.rejects(checkRelease({ root, notes: true }), /placeholder/);
  await writeFile(join(root, "docs/releases/1.0.4.md"), notes);
  assert.equal(await checkRelease({ root, notes: true }), "1.0.4");
  assert.equal(await checkRelease({ root, tag: "1.0.4" }), "1.0.4");
});
