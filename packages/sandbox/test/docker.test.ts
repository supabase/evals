/**
 * Integration test for the local-stack sandbox plumbing. Requires a running Docker
 * daemon, free Supabase default host ports (54321-54329), and network access
 * for image pulls on first run. Gated behind SANDBOX_DOCKER_TESTS=1; run with:
 *
 *   pnpm --filter @supabase-evals/sandbox test:docker
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildLocalStackScoringContext } from "../src/local-stack-runtime.js";
import { DockerSandbox } from "../src/docker-sandbox.js";
import {
  ensureSupabaseSandboxImage,
  setupSupabaseSandbox,
  startSupabaseProject,
  SUPABASE_CLI_VERSION,
  teardownSupabaseProject,
} from "../src/supabase.js";

const TEST_TIMEOUT_MS = 600_000;

describe.runIf(process.env.SANDBOX_DOCKER_TESTS)("local-stack sandbox (docker)", () => {
  it(
    "boots a sandbox, starts a minimal local stack, and reaches it",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const image = await ensureSupabaseSandboxImage();
      const sandbox = await DockerSandbox.create({
        image,
        capAdd: ["NET_ADMIN"],
        sysctls: { "net.ipv4.conf.all.route_localnet": "1" },
      });
      try {
        // The default (projectRunning: true) must refuse an empty workspace
        // with an authoring error instead of a confusing CLI failure.
        await expect(setupSupabaseSandbox(sandbox, {})).rejects.toThrow(
          /supabase\/config\.toml/,
        );

        // projectRunning: false — this test inits the project itself below,
        // mirroring scenarios where starting the stack is the agent's task.
        // gotrue is included because `supabase status` only reports the API
        // keys getClient needs while the auth service is running.
        await setupSupabaseSandbox(sandbox, {
          includeServices: ["gotrue", "kong", "postgrest"],
          projectRunning: false,
        });

        const version = await sandbox.runShell("supabase --version");
        expect(version.ok).toBe(true);
        expect(version.stdout.trim()).toBe(SUPABASE_CLI_VERSION);

        // Workspace file roundtrip (host staging -> docker cp -> container).
        await sandbox.writeFiles({ "nested/dir/hello.txt": "roundtrip" });
        expect(await sandbox.readFile("nested/dir/hello.txt")).toBe("roundtrip");

        // copyHostDir seeds straight from disk: binary content survives intact
        // and the ignore list (.git here) is dropped.
        const seed = mkdtempSync(join(tmpdir(), "copyhostdir-test-"));
        try {
          writeFileSync(join(seed, "bin.dat"), Buffer.from([0x00, 0xff, 0x00, 0xfe]));
          mkdirSync(join(seed, ".git"));
          writeFileSync(join(seed, ".git", "HEAD"), "ref");
          await sandbox.copyHostDir(seed);
          // Dump the bytes as hex (od, from coreutils) to confirm the copy is byte-exact.
          const hex = await sandbox.runShell("od -An -v -tx1 bin.dat | tr -d ' \\n'");
          expect(hex.stdout.trim()).toBe("00ff00fe");
          expect(await sandbox.fileExists(".git/HEAD")).toBe(false);
        } finally {
          rmSync(seed, { recursive: true, force: true });
        }

        // Headless init must not hang on its interactive prompts.
        const init = await sandbox.runShell("supabase init");
        expect(init.ok, init.stderr).toBe(true);
        expect(await sandbox.fileExists("supabase/config.toml")).toBe(true);

        await startSupabaseProject(sandbox, ["gotrue", "kong", "postgrest"]);

        // Postgres reachable through the loopback DNAT, structured rows back.
        const ctx = buildLocalStackScoringContext(sandbox);
        const { rows } = await ctx.query("select 1 as one");
        expect(rows).toEqual([{ one: 1 }]);

        // Kong reachable on the default API port (any HTTP status proves it).
        const rest = await ctx.exec(
          "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54321/rest/v1/",
        );
        expect(rest.stdout.trim()).not.toBe("000");
        expect(rest.stdout.trim()).not.toBe("");

        // getClient reaches the stack host-side via the published ports: a
        // PostgREST error response (unknown table) proves the full path.
        const client = await ctx.getClient();
        const { error } = await client.from("nonexistent_table").select("*");
        expect(error).not.toBeNull();
      } finally {
        await teardownSupabaseProject(sandbox);
        await sandbox.stop();
      }
    },
  );
});
