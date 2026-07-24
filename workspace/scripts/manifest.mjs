#!/usr/bin/env node
// Loader + CLI for manifest.json (lives at workspace/manifest.json, beside
// scripts/) — the single source of truth for the repos this workspace wires
// together: repo-root-relative checkout dirs and the ordered enabler-patch
// set per repo (patch names without the patches/ prefix or .patch suffix;
// "localPatches" marks the dev shims that must never reach an upstream PR —
// see patches/README.md). Every repo is a pinned submodule (.gitmodules owns
// remotes; nothing here is cloned by our scripts — the docs submodule is
// seeded by clone-docs.sh from the .gitmodules url). Every `dir` is
// repo-root-relative; resolving it is the caller's job (bash scripts `cd` to
// the repo root, two levels up from workspace/scripts, before using it).
//
// loadManifest() is THE loader: every consumer (the CLI below, the bash
// facade scripts/patches-lib.sh through it, and provenance.mjs via import)
// goes through the same read+validate, so a schema error fails identically
// everywhere. Never grep the JSON.
//
// CLI usage:
//   manifest.mjs repos             repo names, one per line, manifest order
//   manifest.mjs get <repo> <key>  value; arrays print one item per line;
//                                  absent optional keys print nothing (exit 0)
//   manifest.mjs kind <patch>      "local" | "upstream" for a patch name
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "..", "manifest.json");

/** Read + validate manifest.json. Throws with an actionable message. */
export function loadManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${manifestPath}: ${e.message}`);
  }

  // --- schema validation: fail loud before answering any query ---
  const isStr = (v) => typeof v === "string" && v.length > 0;
  const isStrArr = (v) => Array.isArray(v) && v.length > 0 && v.every(isStr);
  if (typeof manifest?.repos !== "object" || manifest.repos === null || Array.isArray(manifest.repos)) {
    throw new Error('top-level "repos" object missing');
  }
  for (const [name, repo] of Object.entries(manifest.repos)) {
    if (!isStr(repo?.dir)) throw new Error(`repos.${name}.dir must be a non-empty string`);
    if (repo.kind !== "submodule") {
      throw new Error(`repos.${name}.kind must be "submodule" (every repo is a pinned submodule; the clone kind is gone)`);
    }
    if (repo.remote !== undefined) {
      throw new Error(`repos.${name}.remote must be absent (.gitmodules owns the remote)`);
    }
    if (repo.patches !== undefined && !isStrArr(repo.patches)) throw new Error(`repos.${name}.patches must be a non-empty array of strings`);
    if (repo.localPatches !== undefined) {
      if (!isStrArr(repo.localPatches)) throw new Error(`repos.${name}.localPatches must be a non-empty array of strings`);
      for (const p of repo.localPatches) {
        if (!(repo.patches ?? []).includes(p)) throw new Error(`repos.${name}.localPatches has "${p}" which is not in patches`);
      }
    }
  }
  // Patch names must be globally unique: `kind` scans localPatches across ALL
  // repos while other consumers scan per-repo — a duplicated name would let
  // the two silently disagree. Also note "local" is opt-in: a patch absent
  // from every localPatches defaults to upstream (publishable via --with).
  const seen = new Set();
  for (const [name, repo] of Object.entries(manifest.repos)) {
    for (const p of repo.patches ?? []) {
      if (seen.has(p)) throw new Error(`patch name "${p}" appears under more than one repo (repos.${name}) — names must be globally unique`);
      seen.add(p);
    }
  }
  return manifest;
}

// --- CLI: runs only when executed directly (not when imported) ---
// Compare REALPATHS: node resolves the ESM main-module URL through symlinks
// (macOS /tmp -> /private/tmp), so a naive pathToFileURL(argv[1]) mismatches.
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  const die = (msg) => {
    console.error(`manifest.mjs: ${msg}`);
    process.exit(1);
  };

  let manifest;
  try {
    manifest = loadManifest();
  } catch (e) {
    die(e.message);
  }

  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "repos":
      console.log(Object.keys(manifest.repos).join("\n"));
      break;
    case "get": {
      const [name, key] = args;
      const repo = manifest.repos[name ?? ""];
      if (!repo) die(`unknown repo "${name ?? ""}"`);
      if (!["dir", "patches", "localPatches"].includes(key ?? "")) die(`unknown key "${key ?? ""}"`);
      const v = repo[key];
      if (v !== undefined) console.log(Array.isArray(v) ? v.join("\n") : v);
      break;
    }
    case "kind": {
      const [patch] = args;
      if (typeof patch !== "string" || patch.length === 0) die("kind: patch name required");
      const local = Object.values(manifest.repos).some((r) => (r.localPatches ?? []).includes(patch));
      console.log(local ? "local" : "upstream");
      break;
    }
    default:
      die(`unknown command "${cmd ?? ""}" (expected: repos | get | kind)`);
  }
}
