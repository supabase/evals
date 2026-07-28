import type { ParsedResult } from "@/lib/eval-results"

/**
 * Builds a ParsedResult for tests. Only the fields a query or dimension reads
 * are worth setting, so everything else gets a plausible default.
 */
export function makeResult(
  overrides: Partial<ParsedResult> = {}
): ParsedResult {
  const evalId = overrides.eval ?? "build-cli-001-bootstrap-app"

  return {
    eval: evalId,
    experiment: "claude-code-sonnet-5",
    experimentSuite: "benchmark",
    passed: true,
    sourcePath: `claude-code-sonnet-5/${evalId}.json`,
    category: "build",
    product: [],
    topic: [],
    primaryCategory: "uncategorized",
    ...overrides,
  } as ParsedResult
}
