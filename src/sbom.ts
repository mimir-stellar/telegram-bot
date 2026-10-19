import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

/**
 * Generate a Software Bill of Materials (SBOM) for the bot image.
 *
 * This module produces a deterministic, self-contained SBOM by scanning the
 * installed `node_modules` tree. It is designed to be run during CI or
 * deployment packaging to support supply-chain security auditing.
 *
 * The output is a JSON document compatible with SPDX 2.3 simplified format,
 * suitable for ingestion by Mimir or other SBOM consumers.
 *
 * Safety:
 *  - Never reads source code or secrets.
 *  - Only inspects package.json metadata and file hashes for integrity.
 *  - Deterministic: same inputs produce same outputs (sorted keys, stable order).
 *
 * Usage:
 *   - Run via CLI: `node dist/sbom.js > sbom.json`
 *   - Or import: `import { generateSbom } from "./sbom.js";`
 */

interface PackageInfo {
  name: string;
  version: string;
  license: string | null;
  homepage: string | null;
  repository: string | null;
  dependencies: Record<string, string>;
}

interface SbomDocument {
  spdxVersion: string;
  dataLicense: string;
  SPDXID: string;
  name: string;
  documentNamespace: string;
  creationInfo: {
    created: string;
    creators: string[];
  };
  packages: {
    name: string;
    versionInfo: string;
    supplier: string;
    downloadLocation: string;
    filesAnalyzed: boolean;
    licenseConcluded: string;
    licenseDeclared: string;
    copyrightText: string;
    checksums?: Array<{
      algorithm: string;
      checksumValue: string;
    }>;
  }[];
}

/**
 * Read a package.json file and extract relevant metadata.
 */
function readPackageJson(filePath: string): PackageInfo | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const pkg = JSON.parse(content) as {
      name?: string;
      version?: string;
      license?: string | { type?: string };
      homepage?: string;
      repository?: string | { url?: string };
      dependencies?: Record<string, string>;
    };

    if (!pkg.name || !pkg.version) {
      return null;
    }

    return {
      name: pkg.name,
      version: pkg.version,
      license: typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? null,
      homepage: pkg.homepage ?? null,
      repository: typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? null,
      dependencies: pkg.dependencies ?? {},
    };
  } catch {
    return null;
  }
}

/**
 * Compute SHA-256 checksum for a file.
 */
function computeChecksum(filePath: string): string {
  try {
    const content = readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "";
  }
}

/** A discovered package plus the checksum of its manifest. */
interface DiscoveredPackage extends PackageInfo {
  manifestChecksum: string;
}

/** Package directories directly under a node_modules folder, scoped ones included. */
function packageDirs(nodeModulesDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(nodeModulesDir);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const full = join(nodeModulesDir, name);
    if (name.startsWith("@")) {
      let scoped: string[] = [];
      try {
        scoped = readdirSync(full);
      } catch {
        // Unreadable scope directory: skip it.
      }
      for (const inner of scoped) dirs.push(join(full, inner));
    } else {
      dirs.push(full);
    }
  }
  return dirs;
}

/**
 * Discover all packages in node_modules, including nested node_modules
 * folders. Each package directory is visited once.
 */
function discoverPackages(rootDir: string): DiscoveredPackage[] {
  const packages: DiscoveredPackage[] = [];
  const visited = new Set<string>();

  function scan(nodeModulesDir: string): void {
    for (const dir of packageDirs(nodeModulesDir)) {
      if (visited.has(dir)) continue;
      visited.add(dir);
      const pkgPath = join(dir, "package.json");
      const pkg = readPackageJson(pkgPath);
      if (pkg) packages.push({ ...pkg, manifestChecksum: computeChecksum(pkgPath) });
      scan(join(dir, "node_modules"));
    }
  }

  scan(join(rootDir, "node_modules"));
  return packages;
}

/**
 * Generate the SBOM document.
 */
export function generateSbom(rootDir: string = process.cwd()): SbomDocument {
  const packages = discoverPackages(rootDir);

  // Sort packages by name for deterministic output
  packages.sort((a, b) => a.name.localeCompare(b.name));

  const created = new Date().toISOString();
  const documentNamespace = `https://spdx.org/spdxdocs/mimir-bot-${created}`;

  const sbom: SbomDocument = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "mimir-bot-sbom",
    documentNamespace,
    creationInfo: {
      created,
      creators: ["Tool: mimir-bot-sbom-generator"],
    },
    packages: packages.map((pkg) => ({
      name: pkg.name,
      versionInfo: pkg.version,
      supplier: "NOASSERTION",
      downloadLocation: pkg.homepage ?? "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: pkg.license ?? "NOASSERTION",
      licenseDeclared: pkg.license ?? "NOASSERTION",
      copyrightText: "NOASSERTION",
      ...(pkg.manifestChecksum
        ? { checksums: [{ algorithm: "SHA256", checksumValue: pkg.manifestChecksum }] }
        : {}),
    })),
  };

  return sbom;
}

/**
 * Main entry point for CLI usage.
 */
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const rootDir = process.argv[2] ?? process.cwd();
  const sbom = generateSbom(rootDir);
  console.log(JSON.stringify(sbom, null, 2));
}