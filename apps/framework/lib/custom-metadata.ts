import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ZodType } from 'zod';

const schemaCache = new Map<string, Promise<ZodType | undefined>>();

function loadSuiteSchema(suiteDir: string): Promise<ZodType | undefined> {
  let schema = schemaCache.get(suiteDir);
  if (!schema) {
    const file = join(suiteDir, 'custom-metadata.ts');
    schema = existsSync(file)
      ? import(pathToFileURL(file).href).then((mod) => mod.customMetadataSchema)
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
      `Invalid customMetadata in ${promptPath}: ${parsed.error.message}`
    );
  }
  return parsed.data as Record<string, unknown>;
}
