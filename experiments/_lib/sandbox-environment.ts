/**
 * The declared Docker state of an eval's sandbox, read from a
 * `sandbox-environment.json` sitting beside that eval's `PROMPT.md` (never
 * copied into the agent's workspace, so the answer never leaks into it).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DockerState = 'available' | 'no-daemon' | 'absent';

export const SANDBOX_ENVIRONMENT_FILE = 'sandbox-environment.json';

// experiments/_lib -> repo root.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function isDockerState(value: unknown): value is DockerState {
  return value === 'available' || value === 'no-daemon' || value === 'absent';
}

/** Missing file means a normal, Docker-available sandbox. */
export function readSandboxEnvironment(evalDir: string): DockerState {
  const path = join(evalDir, SANDBOX_ENVIRONMENT_FILE);
  if (!existsSync(path)) return 'available';

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: invalid JSON — ${msg}`);
  }
  const docker = isRecord(parsed) ? parsed.docker : undefined;
  if (!isDockerState(docker)) {
    throw new Error(
      `${path}: "docker" must be one of "available", "no-daemon", "absent" — got ${JSON.stringify(docker)}`
    );
  }
  // The harness only hands the runtime a localDir when local/ exists, so a
  // docker-less eval without one would silently fall back to `available`.
  if (docker !== 'available' && !existsSync(join(evalDir, 'local'))) {
    throw new Error(
      `${evalDir}: docker "${docker}" requires a local/ directory (even just local/.gitkeep) — the harness only hands the runtime a localDir when it exists`
    );
  }
  return docker;
}

/** For `skipEval` in experiments whose runtime always has a working Docker. */
export function requiresDockerlessSandbox(evalId: string): boolean {
  return (
    readSandboxEnvironment(join(REPO_ROOT, 'evals', evalId)) !== 'available'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
