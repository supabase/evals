import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  judge,
  type CheckResult,
  type LocalStackScorer,
} from "@supabase-evals/core";
import { stripIndent } from "common-tags";

const OBSERVABILITY_DIR = "observability";
const PROMETHEUS_PATH = join(OBSERVABILITY_DIR, "prometheus.yml");
const COMPOSE_PATH = join(OBSERVABILITY_DIR, "docker-compose.yml");
const README_PATH = join(OBSERVABILITY_DIR, "README.md");

const scorer: LocalStackScorer = async (ctx) => {
  const prometheus = readWorkspaceFile(ctx.hostWorkspace, PROMETHEUS_PATH);
  const compose = readWorkspaceFile(ctx.hostWorkspace, COMPOSE_PATH);
  const readme = readWorkspaceFile(ctx.hostWorkspace, README_PATH);

  // Agents sometimes split scrape targets into a separate file (e.g. referenced
  // via Prometheus file_sd_configs) instead of inlining them in prometheus.yml.
  // Sweep any other yaml under observability/ so that pattern isn't judged blind.
  const extraConfigs = collectAdditionalYamlFiles(
    ctx.hostWorkspace,
    OBSERVABILITY_DIR,
    new Set([PROMETHEUS_PATH, COMPOSE_PATH]),
  );
  const extraConfigsBlock = extraConfigs
    .map(
      ({ path, content }) => `\n${path}:\n\`\`\`yaml\n${content}\n\`\`\`\n`,
    )
    .join("");

  const input = stripIndent`
    ${PROMETHEUS_PATH}:
    \`\`\`yaml
    ${prometheus}
    \`\`\`

    ${COMPOSE_PATH}:
    \`\`\`yaml
    ${compose}
    \`\`\`
    ${extraConfigsBlock}
    ${README_PATH}:
    \`\`\`md
    ${readme}
    \`\`\`
  `;

  const [prometheusConfig, deploymentDocs] = await Promise.all([
    judge({
      input,
      rubric: stripIndent`
        Pass if prometheus.yml adds a deployable Supabase Metrics API scrape for <project-ref>.supabase.co or <project-ref>.supabase.red.
        Require HTTPS, /customer/v1/privileged/metrics, HTTP Basic Auth with password_file, the existing app scrape preserved, and docker-compose.yml mounting that password_file via a volume or Compose secret.
        The scrape target may be inlined in prometheus.yml or split into a separate file referenced via file_sd_configs (included above if present); either is acceptable as long as the target resolves to a real project ref.
        Fail for bearer auth, hardcoded Secret API keys, missing/mismatched secret wiring, wrong endpoint, missing project target, or removing the app job.
      `,
    }),
    judge({
      input,
      rubric: stripIndent`
        Pass if README.md explains how to make the integration live and verify it.
        Require steps to create a Secret API key, place the matching secret file, and restart/reload the Compose stack.
        Require concrete verification via Prometheus targets, PromQL/Grafana, or equivalent.
        Fail for wrong endpoint/auth, hardcoded secret values, vague deploy steps, missing verification, or mismatched secret setup.
      `,
    }),
  ]);

  const checks: CheckResult[] = [
    {
      name: "preserved existing app scrape job",
      passed:
        /job_name:\s*["']?app["']?/i.test(prometheus) &&
        /app:8080/i.test(prometheus),
    },
    {
      name: "configured the Supabase Metrics API scrape correctly",
      passed: prometheusConfig.passed,
      judgeNotes: prometheusConfig.notes,
    },
    {
      name: "documented live deployment and verification steps",
      passed: deploymentDocs.passed,
      judgeNotes: deploymentDocs.notes,
    },
  ];

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
};

function readWorkspaceFile(workspace: string, path: string): string {
  const fullPath = join(workspace, path);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
}

/** Recursively finds yaml files under `dir` (skipping `secrets/`) not already in `exclude`, so referenced config like a file_sd_configs target file gets included even though it lives outside the fixed set of judged paths. */
function collectAdditionalYamlFiles(
  workspace: string,
  dir: string,
  exclude: Set<string>,
): Array<{ path: string; content: string }> {
  const dirPath = join(workspace, dir);
  if (!existsSync(dirPath)) return [];

  const results: Array<{ path: string; content: string }> = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.name === "secrets") continue;
    const relPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectAdditionalYamlFiles(workspace, relPath, exclude));
    } else if (/\.ya?ml$/i.test(entry.name) && !exclude.has(relPath)) {
      results.push({
        path: relPath,
        content: readFileSync(join(workspace, relPath), "utf8"),
      });
    }
  }
  return results;
}

export default scorer;
