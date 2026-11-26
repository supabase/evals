import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CustomMetadataSchema } from '@supabase-evals/core/eval-metadata';
import { formatZodIssues } from '@supabase-evals/core/eval-markdown';

const schemaCache = new Map<
  string,
  Promise<CustomMetadataSchema | undefined>
>();

function loadSuiteSchema(
  suiteDir: string
): Promise<CustomMetadataSchema | undefined> {
  let schema = schemaCache.get(suiteDir);
  if (!schema) {
    const file = join(suiteDir, 'custom-metadata.ts');
    schema = existsSync(file)
      ? import(pathToFileURL(file).href).then((mod) => {
          if (typeof mod.customMetadataSchema?.safeParse !== 'function') {
            throw new Error(
              `evals/${basename(suiteDir)}/custom-metadata.ts must export a zod customMetadataSchema`
            );
          }
          return mod.customMetadataSchema as CustomMetadataSchema;
        })
      : Promise.resolve(undefined);
    schemaCache.set(suiteDir, schema);
  }
  return schema;
}

/** Validates `customMetadata` against `<suiteDir>/custom-metadata.ts`, when the suite ships one. */
export async function validateCustomMetadata(
  suiteDir: string,
  customMetadata: Record<string, unknown> | undefined,
  promptPath: string
): Promise<Record<string, unknown> | undefined> {
  const schema = await loadSuiteSchema(suiteDir);
  if (!schema) return customMetadata;
  const parsed = schema.safeParse(customMetadata);
  if (!parsed.success) {
    throw new Error(
      `Invalid customMetadata in ${promptPath}: ${formatZodIssues(parsed.error.issues)}`
    );
  }
  return parsed.data;
}
