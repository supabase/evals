#!/usr/bin/env node
// Workspace provenance receipt: exact repo SHAs, dirty state (tracked diff
// hash + untracked file content hashes), enabler-patch fingerprints + marker
// presence, and the docs-index stamp. This is the record of WHAT an eval
// actually ran against.
//
// Usage:
//   provenance.mjs                     print the provenance object (JSON)
//   provenance.mjs --embed <result>    add it as `provenance` to a result JSON
//   provenance.mjs --stamp-docs-index  write .docs-index-stamp.json describing
//                                      the docs content state just embedded
//                                      (called by docs-index.sh / docs-seed.sh
//                                      after a SUCCESSFUL embed run only)
//
// Consumers: `status.sh --json` and ab.sh (embedded per-arm receipts, captured
// inside run_eval after each arm's sync so baseline/treatment receipts differ
// exactly by the edit under test). Report-only by design: nothing gates on
// these fields yet — receipt shape gets validated on real runs first.
import { readFileSync, writeFileSync, existsSync, rmSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest } from "./manifest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The one manifest loader (read + schema validation) — imported, not spawned,
// so this file and the manifest.mjs CLI structurally cannot diverge on how a
// bad manifest fails.
let manifest;
try {
  manifest = loadManifest();
} catch (e) {
  console.error(`provenance.mjs: ${e.message}`);
  process.exit(1);
}
const STAMP = join(root, ".docs-index-stamp.json");
// Docs corpus source dir inside the supabase clone (the docs loop's edit scope).
const DOCS_CONTENT_DIR = "apps/docs/content";
// The embed pipeline's model/dims are read FROM the pipeline source at stamp
// time (no duplicated literals that can silently drift); extraction failure
// fails the stamp closed.
const EMBED_PIPELINE_FILE = "supabase/apps/docs/scripts/search/generate-embeddings.ts";
const embedPipelineConfig = () => {
  const src = readFileSync(join(root, EMBED_PIPELINE_FILE), "utf8");
  const model = src.match(/EMBEDDING_MODEL:\s*'([^']+)'/)?.[1];
  const dims = src.match(/EMBEDDING_DIMENSION:\s*(\d+)/)?.[1];
  if (!model || !dims) {
    throw new Error(`cannot extract EMBEDDING_MODEL/EMBEDDING_DIMENSION from ${EMBED_PIPELINE_FILE} — pipeline layout changed?`);
  }
  return { model, dimensions: Number(dims) };
};

const git = (dir, ...args) => {
  try {
    return execFileSync("git", ["-C", join(root, dir), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  } catch {
    return null;
  }
};
// Buffer-returning variant for anything that gets hashed (binary-safe).
const gitRaw = (dir, ...args) => {
  try {
    return execFileSync("git", ["-C", join(root, dir), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
};
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const repoState = (dir) => {
  const dirty = (git(dir, "status", "--porcelain") ?? "").length > 0;
  // Hash the TRACKED diff only when there is one: an untracked-only dirty
  // tree keeps dirty:true but dirty_diff_sha256:null (the untracked list
  // below carries that state) — a hash-of-empty-diff here would mislead.
  const trackedDiff = dirty ? gitRaw(dir, "diff", "HEAD", "--binary") : null;
  // Untracked files are invisible to `git diff HEAD` but are real workspace
  // state (e.g. a brand-new guide page) — record path + content hash, sorted.
  const untracked = (git(dir, "ls-files", "--others", "--exclude-standard") ?? "")
    .split("\n")
    .filter(Boolean)
    .sort()
    .map((p) => {
      try {
        return { path: p, sha256: sha256(readFileSync(join(root, dir, p))) };
      } catch {
        return { path: p, sha256: null };
      }
    });
  return {
    branch: git(dir, "rev-parse", "--abbrev-ref", "HEAD"),
    sha: git(dir, "rev-parse", "HEAD"),
    dirty,
    dirty_diff_sha256: trackedDiff && trackedDiff.length > 0 ? sha256(trackedDiff) : null,
    untracked,
  };
};

// Receipt assembly is LAZY: only the paths that emit a receipt (print/--embed)
// pay for it. --stamp-docs-index must not — repoState alone walks and hashes
// every clone's untracked files.
const buildProvenance = () => {
  const repos = {};
  const patches = {};
  for (const [name, spec] of Object.entries(manifest.repos)) {
    if (!existsSync(join(root, spec.dir, ".git"))) {
      repos[name] = { dir: spec.dir, cloned: false };
      continue;
    }
    repos[name] = { dir: spec.dir, cloned: true, ...repoState(spec.dir) };

    const localSubjects = (git(spec.dir, "log", "--format=%s", "HEAD", "--not", "--remotes") ?? "").split("\n");
    for (const p of spec.patches ?? []) {
      const file = join(root, "patches", `${p}.patch`);
      const kind = (spec.localPatches ?? []).includes(p) ? "local" : "upstream";
      patches[p] = {
        repo: name,
        kind,
        patch_sha256: existsSync(file) ? sha256(readFileSync(file)) : null,
        marker_present: localSubjects.includes(`[eval-workspace-${kind}] ${p}`),
      };
    }
  }

  // SUPABASE_MCP_SERVER_PATH swaps the mcp server for an arbitrary local
  // build, so a receipt that only records the mcp CLONE's SHA would mislabel
  // the arm. Record the override target verbatim plus, when it lives inside a
  // git checkout (the workspace clone, the evals submodule, anywhere), that
  // checkout's exact HEAD and dirty state.
  let mcp_override = null;
  const overridePath = process.env.SUPABASE_MCP_SERVER_PATH;
  if (overridePath) {
    mcp_override = { path: overridePath, checkout_sha: null, checkout_dirty: null };
    try {
      // Same entrypoint shapes as the harness override accepts (.js/.mjs/.cjs).
      const top = execFileSync(
        "git",
        ["-C", /\.[cm]?js$/.test(overridePath) ? dirname(overridePath) : overridePath, "rev-parse", "--show-toplevel"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trimEnd();
      mcp_override.checkout_sha = execFileSync("git", ["-C", top, "rev-parse", "HEAD"], { encoding: "utf8" }).trimEnd();
      mcp_override.checkout_dirty = execFileSync("git", ["-C", top, "status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
    } catch {
      // not inside a git checkout (or path missing): the verbatim path still records the arm
    }
  }

  let docs_index = null;
  if (existsSync(STAMP)) {
    try {
      docs_index = JSON.parse(readFileSync(STAMP, "utf8"));
    } catch {
      docs_index = { error: "unreadable .docs-index-stamp.json" };
    }
  }

  return { generated_at: new Date().toISOString(), repos, patches, mcp_override, docs_index };
};

// Combined fingerprint of the supabase enabler-patch set: part of the docs
// stamp identity, since the patches shape what the embed pipeline does.
const supabasePatchSetSha256 = () => {
  const names = manifest.repos.supabase?.patches ?? [];
  const h = createHash("sha256");
  for (const p of names) {
    const file = join(root, "patches", `${p}.patch`);
    if (!existsSync(file)) {
      throw new Error(`manifest lists supabase patch "${p}" but ${file} is missing — manifest/patches drift`);
    }
    h.update(readFileSync(file));
  }
  return h.digest("hex");
};

const [cmd, target] = process.argv.slice(2);

if (cmd === "--stamp-docs-index") {
  // The stamp is a REPORT step running after the (paid) embed: a stamp
  // failure must never turn a successful docs-index run into a nonzero exit.
  // Fail closed on CONTENT (write no stamp, remove any stale one so nothing
  // misdescribes the new embed) but exit 0 with a loud warning.
  try {
    if (!existsSync(join(root, "supabase", ".git"))) {
      throw new Error("--stamp-docs-index needs the supabase clone");
    }
    const dirtyDiff = gitRaw("supabase", "diff", "HEAD", "--binary", "--", DOCS_CONTENT_DIR);
    // Untracked corpus files (a brand-new guide) are part of the embedded state
    // but invisible to `git diff HEAD` — record them path + content hash, sorted.
    const contentUntracked = (git("supabase", "ls-files", "--others", "--exclude-standard", "--", DOCS_CONTENT_DIR) ?? "")
      .split("\n")
      .filter(Boolean)
      .sort()
      .map((p) => {
        try {
          return { path: p, sha256: sha256(readFileSync(join(root, "supabase", p))) };
        } catch {
          return { path: p, sha256: null };
        }
      });
    const pipeline = embedPipelineConfig();
    const stamp = {
      generated_at: new Date().toISOString(),
      // SCOPE: this stamp identifies the REPO-BACKED docs content slice only
      // (guides under apps/docs/content). The embed corpus also includes
      // non-repo sources (GitHub discussions, generated reference docs, lint
      // warnings, partner data) that this stamp cannot capture — and with
      // DOCS_EMBED_ALLOW_MISSING_SOURCES, skipped sources leave their prior DB
      // rows intact. Do NOT read this as identifying the whole index; that
      // needs pipeline-side per-page checksum provenance (upstream fix first).
      scope: "repo-docs-content-only",
      external_sources_not_captured: true,
      supabase_sha: git("supabase", "rev-parse", "HEAD"),
      repo_docs_content_state: {
        content_tree: git("supabase", "rev-parse", `HEAD:${DOCS_CONTENT_DIR}`),
        content_dirty_diff_sha256: dirtyDiff && dirtyDiff.length > 0 ? sha256(dirtyDiff) : null,
        content_untracked: contentUntracked,
      },
      embedding_model: pipeline.model,
      embedding_dimensions: pipeline.dimensions,
      patch_set_sha256: supabasePatchSetSha256(),
      // schema_version deliberately omitted: there is no truthful source for it
      // yet (the content-DB migration state isn't stamped by the pipeline).
    };
    writeFileSync(STAMP, JSON.stringify(stamp, null, 2) + "\n");
    console.log(`stamped ${STAMP}`);
  } catch (e) {
    rmSync(STAMP, { force: true });
    console.error(
      `provenance.mjs: WARNING — docs-index stamp NOT written (${e.message}); ` +
        `any previous stamp was removed so receipts show docs_index: null instead of a stale claim. ` +
        `The embed itself is unaffected.`,
    );
  }
  process.exit(0);
}


if (cmd === "--embed") {
  if (!target) {
    console.error("provenance.mjs: --embed needs a result-file path");
    process.exit(1);
  }
  let result;
  try {
    result = JSON.parse(readFileSync(target, "utf8"));
  } catch (e) {
    console.error(`provenance.mjs: --embed cannot read result JSON at ${target}: ${e.message}`);
    process.exit(1);
  }
  result.provenance = buildProvenance();
  // Same-directory temp + rename: an interrupt mid-write cannot leave a
  // truncated result file behind.
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(result, null, 2) + "\n");
  renameSync(tmp, target);
} else if (cmd === undefined) {
  console.log(JSON.stringify(buildProvenance(), null, 2));
} else {
  console.error(`provenance.mjs: unknown arg "${cmd}" (expected: nothing | --embed <file> | --stamp-docs-index)`);
  process.exit(1);
}
