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
  SUPABASE_CLI_VERSION,
  buildServiceWrapperScript,
  buildSupabaseStartCommand,
  computeExcludedServices,
} from "../src/supabase.js";
import {
  SKILLS_CLI_VERSION,
  SKILLS_INSTALL_DIR,
  buildSkillsPrompt,
  frontmatterDescription,
} from "../src/skills.js";
import { ALL_SUPABASE_SERVICES } from "../src/types.js";

describe("sandbox Dockerfile", () => {
  it("is a CLI-free base image carrying the common agent tooling", () => {
    const dockerfile = readFileSync(SANDBOX_DOCKERFILE_PATH, "utf8");
    expect(dockerfile).toContain("FROM node:22-slim");
    // Common tooling shared by both eval modes.
    expect(dockerfile).toContain("postgresql-client");
    expect(dockerfile).toContain("docker.io");
    // The Supabase CLI is NOT baked in — it's a local-stack component installed
    // at setup time (installSupabaseCli), so tools-mode sandboxes genuinely lack
    // it. The base image is therefore shared across modes and CLI versions.
    expect(dockerfile).not.toContain("ARG CLI_VERSION");
    expect(dockerfile).not.toContain("supabase.deb");
  });

  it("bakes in Vercel's skills CLI pinned via build arg", () => {
    const dockerfile = readFileSync(SANDBOX_DOCKERFILE_PATH, "utf8");
    expect(dockerfile).toContain("ARG SKILLS_CLI_VERSION");
    expect(dockerfile).toContain('npm install -g "skills@${SKILLS_CLI_VERSION}"');
  });

  it("pins the Supabase CLI version installed at setup time", () => {
    // The pin moved out of the Dockerfile into installSupabaseCli.
    expect(SUPABASE_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("frontmatterDescription", () => {
  it("reads a quoted description containing colons", () => {
    const md = [
      "---",
      "name: supabase",
      'description: "Use when doing X. Triggers: a, b, c."',
      "metadata:",
      "  author: supabase",
      "---",
      "",
      "# Body",
    ].join("\n");
    expect(frontmatterDescription(md)).toBe("Use when doing X. Triggers: a, b, c.");
  });

  it("reads an unquoted single-line description", () => {
    expect(
      frontmatterDescription("---\nname: pg\ndescription: Postgres tips.\n---\nbody"),
    ).toBe("Postgres tips.");
  });

  it("returns empty without frontmatter or without a description", () => {
    expect(frontmatterDescription("# Just a body")).toBe("");
    expect(frontmatterDescription("---\nname: solo\n---\nbody")).toBe("");
  });
});

describe("buildSkillsPrompt", () => {
  it("is empty when no skills are installed", () => {
    expect(buildSkillsPrompt([])).toBe("");
  });

  it("lists name+description and points at the install dir for files_read", () => {
    const prompt = buildSkillsPrompt([
      { name: "supabase", description: "Use for Supabase tasks.", dir: "x" },
      { name: "pg", description: "Postgres tips.", dir: "y" },
    ]);
    expect(prompt).toContain(SKILLS_INSTALL_DIR);
    expect(prompt).toContain("files_read");
    expect(prompt).toContain("SKILL.md");
    expect(prompt).toContain("- supabase: Use for Supabase tasks.");
    expect(prompt).toContain("- pg: Postgres tips.");
    // Discovery only — the full body must not be inlined here.
    expect(prompt).not.toContain("# Body");
  });
});

describe("SKILLS_CLI_VERSION", () => {
  it("is a pinned semver string", () => {
    expect(SKILLS_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
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
  // Frontmatter token normalization folds underscores to hyphens for the enum
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
