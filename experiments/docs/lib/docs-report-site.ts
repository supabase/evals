import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defineExperiment,
  platformLiteRuntime,
  type AgentHarness,
  type EvalRuntime,
  type ExperimentConfig,
  type McpServerDefinition,
} from '@supabase-evals/core';

import { codexGpt6Luna } from '../../presets.js';
import {
  FEEDBACK_PATH,
  GUIDE_PATH,
  REPORT_EVAL_PREFIX,
} from '../../../evals/docs/lib/report-scoring.js';
import { fakeDocsMcpServer } from './fake-docs-mcp-server.js';

type Channel = 'none' | 'page-note' | 'mcp' | 'skill';

// the local agent-skills checkout, so a wording change runs without a submodule bump
const LOCAL_SKILL_DIR = fileURLToPath(
  new URL('../../../../agent-skills/skills/supabase', import.meta.url)
);

// the local supabase checkout, so a change to the agent page or the note runs without a copy step
const LOCAL_DOCS_DIR = fileURLToPath(
  new URL('../../../../supabase/apps/docs', import.meta.url)
);
const LOCAL_FEEDBACK_PAGE = join(
  LOCAL_DOCS_DIR,
  'content/guides/ai-tools/agent-feedback.mdx'
);
const LOCAL_NOTE_ROUTE = join(
  LOCAL_DOCS_DIR,
  'app/api/guides-md/[...slug]/route.ts'
);

const NOTE_URL_PLACEHOLDER = '${DOCS_FEEDBACK_URL}';

// the markdown that the docs build makes from the page: title, description, then the body
const readFeedbackPage = (): string => {
  const source = readFileSync(LOCAL_FEEDBACK_PAGE, 'utf8');
  const [, frontmatter = '', body = ''] =
    source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
  const field = (key: string) =>
    frontmatter.match(new RegExp(`^${key}: '(.*)'$`, 'm'))?.[1];
  const title = field('title');
  const description = field('description');
  if (!title || !description) {
    throw new Error(
      `No single-quoted title and description in ${LOCAL_FEEDBACK_PAGE}`
    );
  }
  return `# ${title}\n\n${description}\n\n${body.trim()}\n`;
};

const readNoteTemplate = (): string => {
  const note = readFileSync(LOCAL_NOTE_ROUTE, 'utf8').match(
    /const agentNote = `([^`]+)`/
  )?.[1];
  if (!note?.includes(NOTE_URL_PLACEHOLDER)) {
    throw new Error(
      `No agentNote with ${NOTE_URL_PLACEHOLDER} in ${LOCAL_NOTE_ROUTE}`
    );
  }
  if (note.replace(NOTE_URL_PLACEHOLDER, '').includes('${')) {
    throw new Error(
      `agentNote in ${LOCAL_NOTE_ROUTE} has an expression this eval cannot fill`
    );
  }
  return note;
};

// the commit of a sibling checkout, so the log shows which text a run measured
const checkoutRevision = (dir: string): string => {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  const isDirty = git('status', '--porcelain', '--', '.') !== '';
  return `${git('rev-parse', '--short', 'HEAD')}${isDirty ? '-dirty' : ''}`;
};

const fixture = (name: string) =>
  readFileSync(
    new URL(`./docs-report-fixtures/${name}`, import.meta.url),
    'utf8'
  );

const PAGES = new Map([
  [GUIDE_PATH, fixture('creating-a-client.md')],
  ['/docs/reference/javascript/auth-getuser.md', fixture('auth-getuser.md')],
]);

// a host-side docs site with one outdated guide, so a live docs fix does not change the eval
const docsReportRuntime = ({
  hasPageNote,
  mcpServers,
}: {
  hasPageNote: boolean;
  mcpServers: McpServerDefinition[];
}): EvalRuntime => {
  const base = platformLiteRuntime({ mcpServers });

  return {
    id: base.id,
    async startSession(args) {
      // read once, before the server starts, so a broken checkout fails this session and not the eval process
      const feedbackPage = hasPageNote ? readFeedbackPage() : undefined;
      const noteTemplate = hasPageNote ? readNoteTemplate() : undefined;
      if (hasPageNote) {
        process.stderr.write(
          `page-note: ${LOCAL_DOCS_DIR} at ${checkoutRevision(LOCAL_DOCS_DIR)}\n`
        );
      }
      let origin = '';
      const server = createServer((request, response) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        const content = path === FEEDBACK_PATH ? feedbackPage : PAGES.get(path);
        // the note goes on every page, so the 002 control sees it on a correct page
        const page =
          content && noteTemplate && path !== FEEDBACK_PATH
            ? `${noteTemplate.replace(NOTE_URL_PLACEHOLDER, `${origin}${FEEDBACK_PATH}`)}\n\n${content}`
            : content;
        response.statusCode = page ? 200 : 404;
        response.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        response.end(page ?? `# Page not found\n\nNo page at ${path}.\n`);
      });
      // 0.0.0.0 and host.docker.internal, so the agent sandbox reaches the host
      await new Promise<void>((resolve) =>
        server.listen(0, '0.0.0.0', resolve)
      );
      origin = `http://host.docker.internal:${(server.address() as AddressInfo).port}`;
      const closeServer = () =>
        new Promise<void>((resolve) => server.close(() => resolve()));

      try {
        const session = await base.startSession(args);
        return {
          ...session,
          env: {
            ...session.env,
            DOCS_ORIGIN: origin,
            // the agent can reach npm, so a cli send must go to the staging feedback table, never production
            SUPABASE_PROFILE: 'supabase-staging',
          },
          close: async () => {
            await closeServer();
            await session.close();
          },
        };
      } catch (err) {
        await closeServer();
        throw err;
      }
    },
  };
};

// the harness installs the submodule copy, then this agent replaces it before codex starts
const withLocalSupabaseSkill = (agent: AgentHarness): AgentHarness => ({
  ...agent,
  run: async (args) => {
    if (args.sandbox) {
      // the workspace is a bind mount at the same path on the host
      const dir = join(args.sandbox.workspace, '.agents/skills/supabase');
      rmSync(dir, { recursive: true, force: true });
      cpSync(LOCAL_SKILL_DIR, dir, { recursive: true });
      process.stderr.write(
        `skill: ${LOCAL_SKILL_DIR} at ${checkoutRevision(LOCAL_SKILL_DIR)}\n`
      );
    }
    return agent.run(args);
  },
});

export const docsReportExperiment = (channel: Channel): ExperimentConfig => {
  const { agent } = codexGpt6Luna;
  // skip without the local input, so ci never runs these channels on published copies
  const isRunnable =
    (channel !== 'skill' || existsSync(LOCAL_SKILL_DIR)) &&
    (channel !== 'page-note' || existsSync(LOCAL_FEEDBACK_PAGE)) &&
    (channel !== 'mcp' || Boolean(process.env.SUPABASE_MCP_SERVER_PATH));
  return defineExperiment({
    agent: channel === 'skill' ? withLocalSupabaseSkill(agent) : agent,
    runtime: docsReportRuntime({
      hasPageNote: channel === 'page-note',
      mcpServers:
        channel === 'mcp'
          ? [
              fakeDocsMcpServer({
                features: ['docs', 'feedback'],
                pages: [
                  {
                    title: 'JavaScript: auth.getUser()',
                    href: 'https://supabase.com/docs/reference/javascript/auth-getuser',
                    content: fixture('auth-getuser.md'),
                  },
                ],
              }),
            ]
          : [],
    }),
    skills: channel === 'skill' ? ['supabase'] : [],
    skipEval: (ev) => !isRunnable || !ev.id.startsWith(REPORT_EVAL_PREFIX),
  });
};
