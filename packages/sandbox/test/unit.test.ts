import { readFileSync } from "node:fs";
import { parseEvalMarkdown } from "@supabase-evals/core/eval-markdown";
import { describe, expect, it } from "vitest";
import {
  resolveSandboxPath,
  truncateOutput,
  wrapSelectAsJson,
} from "../src/local-stack-runtime.js";
import {
  SANDBOX_DOCKERFILE_PATH,
  buildServiceWrapperScript,
  buildSupabaseStartCommand,
  computeExcludedServices,
} from "../src/supabase.js";
import { ALL_SUPABASE_SERVICES } from "../src/types.js";

describe("sandbox Dockerfile", () => {
  it("installs a CLI version pinned via build arg from the release .deb", () => {
    const dockerfile = readFileSync(SANDBOX_DOCKERFILE_PATH, "utf8");
    expect(dockerfile).toContain("FROM node:22-slim");
    expect(dockerfile).toContain("ARG CLI_VERSION");
    expect(dockerfile).toContain(
      "https://github.com/supabase/cli/releases/download/v${CLI_VERSION}/supabase_${CLI_VERSION}_linux_${ARCH}.deb",
    );
    expect(dockerfile).toContain("dpkg -i /tmp/supabase.deb");
  });
});

describe("buildServiceWrapperScript", () => {
  it("appends the exclude flag to start and passes other commands through", () => {
    const script = buildServiceWrapperScript(["studio", "realtime"]);
    expect(script).toContain('if [ "$1" = "start" ]; then');
    expect(script).toContain('start "$@" -x studio,realtime');
    expect(script).toContain('exec /usr/local/bin/supabase-cli "$@"');
  });
});

describe("buildSupabaseStartCommand", () => {
  it("starts everything when no include list is given", () => {
    expect(buildSupabaseStartCommand(undefined)).toBe("supabase start");
  });

  it("excludes every optional service for an empty list (database only)", () => {
    const command = buildSupabaseStartCommand([]);
    expect(command).toBe(`supabase start -x ${ALL_SUPABASE_SERVICES.join(",")}`);
  });

  it("excludes every service not in the include list", () => {
    const command = buildSupabaseStartCommand(["kong", "postgrest"]);
    expect(command.startsWith("supabase start -x ")).toBe(true);
    const excluded = command.replace("supabase start -x ", "").split(",");
    expect(excluded).not.toContain("kong");
    expect(excluded).not.toContain("postgrest");
    expect(excluded).toHaveLength(ALL_SUPABASE_SERVICES.length - 2);
  });
});

describe("computeExcludedServices", () => {
  it("inverts the include list preserving canonical order", () => {
    const excluded = computeExcludedServices(["gotrue", "kong", "postgrest"]);
    expect(excluded).toEqual(
      ALL_SUPABASE_SERVICES.filter(
        (service) => !["gotrue", "kong", "postgrest"].includes(service),
      ),
    );
  });

  it("returns empty when everything is included", () => {
    expect(computeExcludedServices(ALL_SUPABASE_SERVICES)).toEqual([]);
  });

  it("excludes nothing when omitted, but everything for an explicit empty list", () => {
    expect(computeExcludedServices(undefined)).toEqual([]);
    expect(computeExcludedServices([])).toEqual([...ALL_SUPABASE_SERVICES]);
  });

  it("rejects unknown services with the valid list in the message", () => {
    expect(() => computeExcludedServices(["auth"])).toThrowError(
      /invalid Supabase services: auth \(valid: gotrue/,
    );
  });
});

describe("services frontmatter → computeExcludedServices (regression)", () => {
  // Frontmatter token normalization folds hyphens to underscores for the enum
  // dimensions (product/topic), but the same normalizer must NOT touch
  // `services` — those are real CLI service ids (postgres-meta, storage-api,
  // edge-runtime) that must match the Supabase service names verbatim:
  // https://github.com/supabase/supabase/blob/d71717585e1b0fcadcdc03546211a7bfbdbe0959/apps/docs/spec/cli_v1_commands.yaml#L584
  const buildMarkdown = (services: string) =>
    [
      "---",
      "stage: build",
      "product: [database]",
      "topic: [migrations]",
      `services: ${services}`,
      "---",
      "body",
    ].join("\n");

  it("preserves hyphens so parsed services match the Supabase service names", () => {
    const { metadata } = parseEvalMarkdown(
      buildMarkdown("[postgres-meta, storage-api, edge-runtime, gotrue]"),
    );

    // Folding to postgres_meta / storage_api / edge_runtime would break the
    // match in computeExcludedServices and throw at sandbox startup.
    expect(metadata.services).toEqual([
      "postgres-meta",
      "storage-api",
      "edge-runtime",
      "gotrue",
    ]);

    expect(() => computeExcludedServices(metadata.services)).not.toThrow();
    const excluded = computeExcludedServices(metadata.services);
    expect(excluded).not.toContain("postgres-meta");
    expect(excluded).not.toContain("storage-api");
    expect(excluded).not.toContain("edge-runtime");
    expect(excluded).not.toContain("gotrue");
  });

  it("still trims and lowercases hyphenated service ids", () => {
    const { metadata } = parseEvalMarkdown(buildMarkdown("[' Postgres-Meta ']"));
    expect(metadata.services).toEqual(["postgres-meta"]);
  });
});

describe("resolveSandboxPath", () => {
  it("accepts and normalizes relative paths", () => {
    expect(resolveSandboxPath("a/b.txt")).toBe("a/b.txt");
    expect(resolveSandboxPath("./a//b.txt")).toBe("a/b.txt");
    expect(resolveSandboxPath("a/../b.txt")).toBe("b.txt");
  });

  it("rejects absolute, empty, and escaping paths", () => {
    expect(() => resolveSandboxPath("/etc/passwd")).toThrowError(/relative/);
    expect(() => resolveSandboxPath("")).toThrowError(/relative/);
    expect(() => resolveSandboxPath("..")).toThrowError(/escapes/);
    expect(() => resolveSandboxPath("../x")).toThrowError(/escapes/);
    expect(() => resolveSandboxPath("a/../../x")).toThrowError(/escapes/);
  });
});

describe("truncateOutput", () => {
  it("passes short output through untouched", () => {
    expect(truncateOutput("hello")).toBe("hello");
  });

  it("keeps head and tail of oversized output with a marker", () => {
    const output = `${"a".repeat(20_000)}TAIL`;
    const truncated = truncateOutput(output);
    expect(truncated.length).toBeLessThan(output.length);
    expect(truncated.startsWith("aaa")).toBe(true);
    expect(truncated.endsWith("TAIL")).toBe(true);
    expect(truncated).toContain("...[truncated");
  });
});

describe("wrapSelectAsJson", () => {
  it("wraps a SELECT in a json_agg subquery", () => {
    expect(wrapSelectAsJson("select 1 as one")).toBe(
      "select coalesce(json_agg(t), '[]'::json) from (select 1 as one) t;",
    );
  });

  it("strips a trailing semicolon so the subquery stays valid", () => {
    expect(wrapSelectAsJson("select 1 as one; ")).toBe(
      "select coalesce(json_agg(t), '[]'::json) from (select 1 as one) t;",
    );
  });
});
