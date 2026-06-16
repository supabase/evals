import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  judge,
  type CheckResult,
  type LocalStackScorer,
} from "@supabase-evals/core";
import { stripIndent } from "common-tags";

const PROMETHEUS_PATH = "observability/prometheus.yml";
const COMPOSE_PATH = "observability/docker-compose.yml";
const README_PATH = "observability/README.md";

const scorer: LocalStackScorer = async (ctx) => {
  const prometheus = readWorkspaceFile(ctx.hostWorkspace, PROMETHEUS_PATH);
  const compose = readWorkspaceFile(ctx.hostWorkspace, COMPOSE_PATH);
  const readme = readWorkspaceFile(ctx.hostWorkspace, README_PATH);
  const input = stripIndent`
    ${PROMETHEUS_PATH}:
    \`\`\`yaml
    ${prometheus}
    \`\`\`

    ${COMPOSE_PATH}:
    \`\`\`yaml
    ${compose}
    \`\`\`

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

export default scorer;
