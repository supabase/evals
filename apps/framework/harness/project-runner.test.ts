import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { resolvePackageBin, viteBuild, vitestRun } from './project-runner.js';
import { ROOT } from '../../../test-utils/scorer-test-kit.js';

const FRONTEND_EVAL = 'evals/build-frontend-001-todos-app';

/** The eval's reference solution, kept as a real file so it typechecks. */
const referenceApp = () =>
  readFileSync(join(ROOT, FRONTEND_EVAL, 'reference', 'App.tsx'), 'utf8');

// Regression guard for AI-975: pnpm's isolated layout has no hoisted
// `<repo>/node_modules/<pkg>`, so a repo-root path missed every time and the
// bin never even launched.
test.each([
  ['vite', 'bin/vite.js'],
  ['vitest', 'vitest.mjs'],
])('resolves the %s binary that actually exists on disk', (pkg, entry) => {
  const resolved = resolvePackageBin(pkg, entry);

  expect(existsSync(resolved), `${pkg} bin missing at ${resolved}`).toBe(true);
});

// AI-975, second layer: the workspace's own `vite.config.ts` imports `vite`,
// and vite compiles that config into `<repo>/node_modules/.vite-temp/`, so
// resolution anchors at the repo root. The scored workspace lives under
// `results/` and can only walk up to the repo root too. That is the documented
// contract (README, and the `copyToHost` doc comment: score with repo-root
// vite/vitest so the toolchain need not exist in the sandbox), so the root
// manifest owns the frontend toolchain. This fixture copies `local/` with no
// `node_modules`, exactly as that contract assumes.
test('builds and tests a known-good frontend workspace', async () => {
  const workspace = join(
    ROOT,
    'results',
    '_smoke',
    'build-frontend-001-todos-app'
  );
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(dirname(workspace), { recursive: true });
  cpSync(join(ROOT, FRONTEND_EVAL, 'local'), workspace, {
    recursive: true,
    filter: (src) => !src.endsWith('/EVAL.ts'),
  });
  cpSync(join(ROOT, FRONTEND_EVAL, 'tests'), join(workspace, 'tests'), {
    recursive: true,
  });
  // Deliberately no `.env.local`. A real agent workspace does not have one, so
  // writing it here would make this test pass while the live scoring path
  // fails. `vitestRun` injects VITE_SUPABASE_* through the config it generates.
  writeFileSync(join(workspace, 'src', 'App.tsx'), referenceApp());

  const build = await viteBuild(workspace);
  expect(build.ok, build.stderr || build.stdout).toBe(true);

  const vitest = await vitestRun(workspace);
  expect(vitest.ok, vitest.stderr || vitest.stdout).toBe(true);
});
