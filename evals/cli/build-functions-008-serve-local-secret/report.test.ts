import { describe, expect, it } from 'vitest';
import { mentionsNumber } from '../lib/report.js';
import type { StackProbe } from '../lib/stack.js';
import { DIGEST_SECRET, FUNCTION_NAME } from './fixture.js';
import type { FunctionProbe, HttpResponse, ProbeAttempt } from './probe.js';
import { describeGroundTruth } from './report.js';
import type { SecretScan } from './secret.js';

const API_URL = 'http://127.0.0.1:54321';
const SOURCE = 'supabase/functions/nightly-digest/index.ts';

const STACK: StackProbe = {
  ok: true,
  backend: 'legacy',
  dbUrl: 'postgresql://postgres:hunter2@127.0.0.1:54322/postgres',
  apiUrl: API_URL,
  runtime: 'docker',
};

const NOT_RUN = {
  ran: false,
  reason: 'the agent never ran supabase functions serve',
} as const;

const response = (status: number, body = ''): HttpResponse => ({
  status,
  body,
});

const attempt = (
  variant: ProbeAttempt['variant'],
  status: number,
  body = ''
): ProbeAttempt => ({ variant, response: response(status, body) });

const PROBE: FunctionProbe = {
  url: `${API_URL}/functions/v1/${FUNCTION_NAME}`,
  harnessServe: false,
  live: [attempt('none', 200, '{"queued":true}')],
  replay: NOT_RUN,
  accepted: {
    servedBy: 'live',
    variant: 'none',
    response: response(200, '{"queued":true}'),
  },
  wrongSecret: response(401, 'wrong secret'),
  missingHeader: response(401, 'missing secret'),
};

const SCAN: SecretScan = {
  ok: true,
  functionSources: [SOURCE],
  hits: [
    { file: '.env', ignored: true },
    { file: 'supabase/functions/.env', ignored: true },
  ],
};

type Facts = Parameters<typeof describeGroundTruth>[0];

const FACTS: Facts = {
  stack: STACK,
  probe: PROBE,
  scan: SCAN,
  serveCommands: [],
  functionDirs: [FUNCTION_NAME],
};

const describe_ = (overrides: Partial<Facts> = {}) =>
  describeGroundTruth({ ...FACTS, ...overrides });

const lineFor = (lines: string[], pattern: RegExp) => {
  const start = lines.findIndex((line) => pattern.test(line));
  if (start === -1) return '';
  const block = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    block.push(line);
  }
  return block.join('\n');
};

const REPLAYED: FunctionProbe = {
  url: PROBE.url,
  harnessServe: false,
  live: [
    attempt('none', 401, 'Invalid JWT'),
    attempt('anon', 401, 'Invalid JWT'),
  ],
  replay: {
    ran: true,
    command: 'supabase functions serve --env-file .env',
    attempts: [attempt('none', 401, 'bad'), attempt('publishable', 200, 'ok')],
    log: 'Serving functions',
    stoppedServers: 0,
  },
  accepted: {
    servedBy: 'replay',
    variant: 'publishable',
    response: response(200, 'ok'),
  },
  wrongSecret: response(403, 'forbidden'),
  missingHeader: response(400, 'bad request'),
};

const REJECTED: FunctionProbe = {
  url: PROBE.url,
  harnessServe: false,
  live: [attempt('none', 401), attempt('publishable', 404)],
  replay: NOT_RUN,
};

const NO_STACK_PROBE: FunctionProbe = {
  stackNotes: 'The local stack is not running.',
  harnessServe: false,
  live: [],
  replay: { ran: false, reason: 'no local stack to serve the function' },
};

describe('describeGroundTruth', () => {
  it('writes every fact as a dash-led line, with continuations indented', () => {
    const lines = [
      ...describe_({
        probe: REPLAYED,
        serveCommands: ['supabase functions serve --env-file .env'],
      }),
      ...describe_({ probe: NO_STACK_PROBE, scan: { ok: false, notes: 'x' } }),
    ];

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith('- ') || line.startsWith('  ')).toBe(true);
    }
  });

  describe('stack', () => {
    it('describes a resolved stack with its backend and runtime', () => {
      expect(describe_().join('\n')).toContain('resolved: legacy/docker');
    });

    it('names the relocated CLI home of a stack found under one', () => {
      expect(
        describe_({
          stack: { ...STACK, relocatedHome: '/home/agent/.supabase' },
        }).join('\n')
      ).toContain('/home/agent/.supabase');
    });

    it('carries the notes of an unresolved stack', () => {
      expect(
        describe_({
          stack: { ok: false, notes: 'The local stack is not running.' },
          probe: NO_STACK_PROBE,
        }).join('\n')
      ).toContain('none (The local stack is not running.)');
    });

    it('never carries the stack credentials', () => {
      expect(describe_().join('\n')).not.toContain('hunter2');
    });
  });

  describe('function directories', () => {
    it('lists each directory under supabase/functions', () => {
      const line = lineFor(
        describe_({ functionDirs: [FUNCTION_NAME, 'other'] }),
        /function (dirs|directories)/i
      );

      expect(line).toContain(FUNCTION_NAME);
      expect(line).toContain('other');
    });

    it('says none when no function directory exists', () => {
      expect(
        lineFor(describe_({ functionDirs: [] }), /function (dirs|directories)/i)
      ).toContain('none');
    });
  });

  describe('serve invocations', () => {
    it('gives the count and the last command', () => {
      const line = lineFor(
        describe_({
          serveCommands: [
            'supabase functions serve --no-verify-jwt',
            'supabase functions serve --env-file .env',
          ],
        }),
        /serve invocations/i
      );

      expect(mentionsNumber(line, 2)).toBe(true);
      expect(line).toContain('supabase functions serve --env-file .env');
    });

    it('reports zero when the agent never ran functions serve', () => {
      const line = lineFor(describe_(), /serve invocations/i);

      expect(mentionsNumber(line, 0)).toBe(true);
    });
  });

  describe('harness serve', () => {
    it('says the harness restarted the edge runtime with a plain serve, without --env-file', () => {
      const line = lineFor(
        describe_({ probe: { ...PROBE, harnessServe: true } }),
        /harness/i
      );

      expect(line).toMatch(/^- the harness restarted the edge runtime/);
      expect(line).toContain('`supabase functions serve`');
      expect(line).toContain('no `--env-file`');
      expect(line).toMatch(/before probing/);
    });

    it('says nothing about the harness when it started no serve', () => {
      expect(describe_().join('\n')).not.toMatch(/harness/i);
    });
  });

  describe('live probe', () => {
    it('lists each attempt as variant → status in order', () => {
      const line = lineFor(
        describe_({ probe: { ...REJECTED, replay: NOT_RUN } }),
        /live probe/i
      );

      expect(line).toContain('none → 401');
      expect(line).toContain('publishable → 404');
      expect(line.indexOf('none → 401')).toBeLessThan(
        line.indexOf('publishable → 404')
      );
    });

    it('lists no attempt when there is no stack to probe', () => {
      const line = lineFor(
        describe_({
          stack: { ok: false, notes: 'The local stack is not running.' },
          probe: NO_STACK_PROBE,
        }),
        /live probe/i
      );

      expect(line).toMatch(/live probe/i);
      expect(line).not.toContain('→');
    });
  });

  describe('replay', () => {
    it('says the replay did not run and why', () => {
      const line = lineFor(describe_(), /^- replay/i);

      expect(line).toMatch(/not run/i);
      expect(line).toContain(NOT_RUN.reason);
    });

    it('gives the replayed command and each attempt as variant → status when it ran', () => {
      const line = lineFor(describe_({ probe: REPLAYED }), /^- replay/i);

      expect(line).toContain('supabase functions serve --env-file .env');
      expect(line).toContain('none → 401');
      expect(line).toContain('publishable → 200');
      expect(line).not.toMatch(/not run/i);
    });

    it('explains an unresolved stack as the reason nothing was replayed', () => {
      const line = lineFor(
        describe_({
          stack: { ok: false, notes: 'The local stack is not running.' },
          probe: NO_STACK_PROBE,
        }),
        /^- replay/i
      );

      expect(line).toContain('no local stack to serve the function');
    });
  });

  describe('acceptance', () => {
    it('says accepted: yes with the server, variant and status for a live answer', () => {
      const line = lineFor(describe_(), /accepted: yes/i);

      expect(line).toContain('live');
      expect(line).toContain('none');
      expect(line).toContain('200');
    });

    it('says accepted: yes with the replay, variant and status for a replayed answer', () => {
      const line = lineFor(describe_({ probe: REPLAYED }), /accepted: yes/i);

      expect(line).toContain('replay');
      expect(line).toContain('publishable');
      expect(line).toContain('200');
    });

    it('says accepted: no when nothing accepted the secret', () => {
      const text = describe_({ probe: REJECTED }).join('\n');

      expect(text).toMatch(/accepted: no/i);
      expect(text).not.toMatch(/accepted: yes/i);
    });
  });

  describe('rejection probes', () => {
    it('gives the status of the wrong-secret and missing-header responses', () => {
      const text = describe_({ probe: REPLAYED }).join('\n');

      expect(text).toMatch(/wrong[- ]secret[^\d\n]*403/i);
      expect(text).toMatch(/missing[- ]header[^\d\n]*400/i);
    });

    it('gives both statuses for a live answer', () => {
      const text = describe_().join('\n');

      expect(text).toMatch(/wrong[- ]secret[^\d\n]*401/i);
      expect(text).toMatch(/missing[- ]header[^\d\n]*401/i);
    });
  });

  describe('where the secret sits', () => {
    it('marks ignored files as ignored', () => {
      const text = describe_().join('\n');

      expect(text).toMatch(/\.env\W{1,4}ignored/);
      expect(text).toMatch(/supabase\/functions\/\.env\W{1,4}ignored/);
    });

    it('marks a file git would commit as committed', () => {
      const text = describe_({
        scan: {
          ok: true,
          functionSources: [SOURCE],
          hits: [
            { file: '.env', ignored: true },
            { file: SOURCE, ignored: false },
          ],
        },
      }).join('\n');

      expect(text).toMatch(/nightly-digest\/index\.ts\W{1,4}committed/);
      expect(text).toMatch(/\.env\W{1,4}ignored/);
    });

    it('says the literal sits in no file when there is no hit', () => {
      const text = describe_({
        scan: { ok: true, functionSources: [SOURCE], hits: [] },
      }).join('\n');

      expect(text).not.toMatch(/committed/);
      expect(text).not.toMatch(/\.env\W{1,4}ignored/);
    });

    it('carries the notes when the scan could not run', () => {
      expect(
        describe_({
          scan: {
            ok: false,
            notes: 'could not read ignore rules: sandbox gone',
          },
        }).join('\n')
      ).toContain('could not read ignore rules: sandbox gone');
    });

    it('says there is no function source when supabase/functions holds none', () => {
      expect(
        describe_({
          scan: { ok: true, functionSources: [], hits: [] },
        }).join('\n')
      ).toMatch(/no function source/i);
    });

    it('does not say there is no function source when one exists', () => {
      expect(describe_().join('\n')).not.toMatch(/no function source/i);
    });
  });

  describe('the secret literal', () => {
    it('masks a secret echoed by the wrong-secret response instead of printing it', () => {
      const text = describe_({
        probe: {
          ...PROBE,
          wrongSecret: response(200, `expected ${DIGEST_SECRET}`),
        },
      }).join('\n');

      expect(text).not.toContain(DIGEST_SECRET);
      expect(text).toContain('<DIGEST_SECRET>');
    });

    it('never prints it from any response body, the replay log, the replayed command or a serve command', () => {
      const echo = `{"expected":"${DIGEST_SECRET}"}`;
      const text = describe_({
        probe: {
          url: PROBE.url,
          harnessServe: true,
          live: [attempt('none', 401, echo)],
          replay: {
            ran: true,
            command: `DIGEST_SECRET=${DIGEST_SECRET} supabase functions serve`,
            attempts: [attempt('none', 200, echo)],
            log: `loaded DIGEST_SECRET=${DIGEST_SECRET}`,
            stoppedServers: 0,
          },
          accepted: {
            servedBy: 'replay',
            variant: 'none',
            response: response(200, echo),
          },
          wrongSecret: response(401, echo),
          missingHeader: response(401, echo),
        },
        serveCommands: [
          `DIGEST_SECRET=${DIGEST_SECRET} supabase functions serve`,
        ],
        stack: { ok: false, notes: `refused ${DIGEST_SECRET}` },
      }).join('\n');

      expect(text).not.toContain(DIGEST_SECRET);
    });

    it('keeps a very long response body out of the ground truth', () => {
      const text = describe_({
        probe: { ...PROBE, wrongSecret: response(401, 'x'.repeat(20_000)) },
      }).join('\n');

      expect(text.length).toBeLessThan(4_000);
    });
  });

  it('describes a run with no stack and no probe without throwing and says nothing was accepted', () => {
    const text = describe_({
      stack: { ok: false, notes: 'The local stack is not running.' },
      probe: NO_STACK_PROBE,
      scan: { ok: false, notes: 'could not read ignore rules' },
      functionDirs: [],
    }).join('\n');

    expect(text).toContain('The local stack is not running.');
    expect(text).toMatch(/accepted: no/i);
  });
});
