import matter from 'gray-matter';
import { z } from 'zod';

import {
  evalFrontmatterSchema,
  type ParsedEvalMarkdown,
} from './eval-metadata.js';

// Node-only: gray-matter pulls in js-yaml and Buffer, so it lives apart from
// the browser-safe schemas in eval-metadata.ts. Only the eval runner and
// result exporter need to read PROMPT.md files. gray-matter splits the YAML
// frontmatter from the body; evalFrontmatterSchema owns all coercion,
// normalization, and validation of the parsed data.
export function parseEvalMarkdown(
  source: string,
  sourceName = 'eval markdown'
): ParsedEvalMarkdown {
  // matter.test() inspects the raw source for a frontmatter delimiter without
  // parsing. We must check it here rather than reading parsed.matter below:
  // gray-matter caches parsed files keyed by content and returns a shallow
  // Object.assign copy on cache hits, which drops the non-enumerable .matter
  // field (it becomes undefined). Since export-results re-parses the same
  // PROMPT.md once per result file, the second read would otherwise crash on
  // parsed.matter.trim().
  if (!matter.test(source)) {
    throw new Error(`${sourceName} is missing eval metadata frontmatter`);
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(source);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`${sourceName} has invalid frontmatter: ${msg}`);
  }

  const result = evalFrontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    throw new Error(
      `${sourceName} has invalid eval metadata: ${formatZodIssues(result.error.issues)}`
    );
  }

  return {
    metadata: result.data,
    body: parsed.content.trim(),
  };
}

function formatZodIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
