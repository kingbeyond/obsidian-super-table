import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function requireVersion(value, label) {
  if (typeof value !== "string" || value !== value.trim() || !versionPattern.test(value)) throw new Error(`${label} must use x.y.z without a v prefix or prerelease suffix.`);
}

export function validateVersions(manifest, pkg, lock, versions, tag) {
  const version = manifest?.version;
  requireVersion(version, "manifest.version");
  requireVersion(manifest.minAppVersion, "manifest.minAppVersion");
  for (const [label, value] of [
    ["package.version", pkg?.version],
    ["package-lock.version", lock?.version],
    ["package-lock.packages[root].version", lock?.packages?.[""]?.version],
  ]) {
    if (value !== version) throw new Error(`${label} must match manifest.version (${version}).`);
  }
  if (!versions || typeof versions !== "object" || Array.isArray(versions)) throw new Error("versions.json must be a version map.");
  for (const [pluginVersion, minAppVersion] of Object.entries(versions)) {
    requireVersion(pluginVersion, "versions.json key");
    requireVersion(minAppVersion, `versions.json[${pluginVersion}]`);
  }
  if (versions[version] !== manifest.minAppVersion) throw new Error(`versions.json[${version}] must match manifest.minAppVersion (${manifest.minAppVersion}).`);
  if (tag !== undefined) {
    requireVersion(tag, "Release tag");
    if (tag !== version) throw new Error(`Release tag must match manifest.version (${version}).`);
  }
  return version;
}

export function validateNotes(text) {
  if (/\b(?:TODO|TBD|FIXME|PLACEHOLDER)\b|待补充|待填写|占位|<!--/i.test(text)) throw new Error("Release notes contain placeholder content.");
  for (const heading of ["English", "简体中文"]) {
    const section = text.match(new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m"))?.[1];
    if (!section || !/^\s*-\s+\S/m.test(section)) throw new Error(`Release notes need a non-empty '## ${heading}' section with change bullets.`);
  }
}

export async function checkRelease({ root = process.cwd(), tag, notes = false } = {}) {
  const files = await Promise.all(["manifest.json", "package.json", "package-lock.json", "versions.json"].map(async (file) => JSON.parse(await readFile(resolve(root, file), "utf8"))));
  const version = validateVersions(...files, tag);
  if (notes || tag !== undefined) validateNotes(await readFile(resolve(root, "docs/releases", `${version}.md`), "utf8"));
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--notes") options.notes = true;
      else if (args[index] === "--tag" && args[index + 1] && !args[index + 1].startsWith("--")) options.tag = args[++index];
      else throw new Error("Usage: npm run check:release -- [--notes] [--tag x.y.z]");
    }
    console.log(`Release metadata verified: ${await checkRelease(options)}${options.notes || options.tag !== undefined ? " (including bilingual notes)" : ""}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
