import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommandResult } from '@supabase-evals/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listSeedFiles, readSeedConfig } from './seed-config.js';
import { fetchObject } from './storage.js';

const hasCommand = (name: string): boolean =>
  spawnSync('sh', ['-c', `command -v ${name}`]).status === 0;

const HAS_SHA256SUM = hasCommand('sha256sum');
const HAS_FETCH_TOOLS = ['sha256sum', 'curl', 'mktemp', 'cut'].every(
  hasCommand
);
const IS_ROOT = process.getuid?.() === 0;

const sha256 = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

const byKey = <T extends { key: string }>(files: readonly T[]) =>
  [...files].sort((a, b) => a.key.localeCompare(b.key));

const execIn =
  (cwd: string) =>
  async (command: string): Promise<CommandResult> => {
    const run = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8' });
    return {
      ok: run.status === 0,
      exitCode: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
    };
  };

describe.skipIf(!HAS_SHA256SUM)('the seed listing in a real shell', () => {
  let workspace: string;

  const supabase = (...segments: string[]) =>
    path.join(workspace, 'supabase', ...segments);

  const write = (relative: string, content: string) => {
    const file = supabase(relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  const list = (objectsPath: string) =>
    listSeedFiles({ exec: execIn(workspace), workspace }, objectsPath);

  beforeAll(() => {
    workspace = mkdtempSync(path.join(tmpdir(), 'seed-listing-'));
    write('storage/media/avatars/ava.svg', 'ava');
    write('storage/media/avatars/ben.svg', 'ben');
    write('storage/media/2026 Q1/it\'s a "file".txt', 'quoted');
    write('storage/media/.DS_Store', 'junk');
    write('storage/media/avatars/Thumbs.db', 'junk');
    write('storage/media/desktop.ini', 'junk');
    write('storage/outside/secret.txt', 'secret');
    symlinkSync('avatars/ava.svg', supabase('storage/media/linked.svg'));
    symlinkSync('../outside', supabase('storage/media/linked-dir'));
    symlinkSync('nowhere.txt', supabase('storage/media/dangling.txt'));
    symlinkSync('media', supabase('storage/media-link'));
    write('storage/single/nested/one.pdf', 'one invoice');
    write("storage/it's here/a b.pdf", 'spaced');
    mkdirSync(supabase('storage/empty'));
    write('config.toml', '');
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const withLockedFolder = async (
    relative: string,
    run: () => Promise<void>
  ) => {
    mkdirSync(supabase(relative));
    chmodSync(supabase(relative), 0o000);
    try {
      await run();
    } finally {
      chmodSync(supabase(relative), 0o700);
      rmSync(supabase(relative), { recursive: true });
    }
  };

  const MEDIA_FILES = [
    { key: '2026 Q1/it\'s a "file".txt', sha256: sha256('quoted') },
    { key: 'avatars/ava.svg', sha256: sha256('ava') },
    { key: 'avatars/ben.svg', sha256: sha256('ben') },
    { key: 'linked.svg', sha256: sha256('ava') },
  ];

  it('lists regular files and symlinked files with their hashes, keyed by path from the folder', async () => {
    const listed = await list('./storage/media');

    expect(listed.error).toBeUndefined();
    expect(listed.notes).toBeUndefined();
    expect(byKey(listed.files)).toEqual(byKey(MEDIA_FILES));
  });

  it('keeps a file name with a space and quotes as one key', async () => {
    const { files } = await list('./storage/media');

    expect(files.map(({ key }) => key)).toContain('2026 Q1/it\'s a "file".txt');
  });

  it('skips a symlink to a directory and everything behind it', async () => {
    const { files } = await list('./storage/media');

    expect(files.some(({ key }) => key.startsWith('linked-dir'))).toBe(false);
    expect(files.some(({ sha256: hash }) => hash === sha256('secret'))).toBe(
      false
    );
  });

  it('skips a broken symlink', async () => {
    const { files, error } = await list('./storage/media');

    expect(error).toBeUndefined();
    expect(files.some(({ key }) => key === 'dangling.txt')).toBe(false);
  });

  it.each(['.DS_Store', 'Thumbs.db', 'desktop.ini'])(
    'skips %s',
    async (junk) => {
      const { files } = await list('./storage/media');

      expect(files.some(({ key }) => key.endsWith(junk))).toBe(false);
      expect(files.some(({ sha256: hash }) => hash === sha256('junk'))).toBe(
        false
      );
    }
  );

  it('follows a symlinked objects_path', async () => {
    const { files, error } = await list('./storage/media-link');

    expect(error).toBeUndefined();
    expect(byKey(files)).toEqual(byKey(MEDIA_FILES));
  });

  it('reads an objects_path that is one file, keyed by the file name', async () => {
    const listed = await list('./storage/single/nested/one.pdf');

    expect(listed).toEqual({
      files: [{ key: 'one.pdf', sha256: sha256('one invoice') }],
    });
  });

  it('quotes an objects_path that holds a space and a quote', async () => {
    const listed = await list("./storage/it's here");

    expect(listed).toEqual({
      files: [{ key: 'a b.pdf', sha256: sha256('spaced') }],
    });
  });

  it('lists an existing empty folder as no files and no note', async () => {
    expect(await list('./storage/empty')).toEqual({ files: [] });
  });

  it('treats a path that does not exist as seeding nothing, not as an error', async () => {
    const listed = await list('./storage/ghost');

    expect(listed.files).toEqual([]);
    expect(listed.error).toBeUndefined();
    expect(listed.notes).toMatch(/does not exist/);
  });

  it.skipIf(IS_ROOT)('reports an unreadable folder as an error', () =>
    withLockedFolder('storage/locked', async () => {
      const listed = await list('./storage/locked');

      expect(listed.files).toEqual([]);
      expect(listed.notes).toBeUndefined();
      expect(listed.error).toMatch(/\S/);
    })
  );

  it.skipIf(IS_ROOT)(
    'reports an unreadable folder inside the objects_path as an error',
    () =>
      withLockedFolder('storage/media/locked', async () => {
        const listed = await list('./storage/media');

        expect(listed.files).toEqual([]);
        expect(listed.error).toMatch(/\S/);
      })
  );

  it('reads the buckets of a config and lists each folder through the same shell', async () => {
    write(
      'config.toml',
      [
        '[storage.buckets.docs]',
        'objects_path = "./storage/single/nested/one.pdf"',
        '[storage.buckets.ghost]',
        'objects_path = "./storage/ghost"',
        '[storage.buckets.scratch]',
      ].join('\n')
    );

    const probe = await readSeedConfig({
      exec: execIn(workspace),
      workspace,
      readFile: async (file) =>
        readFileSync(path.join(workspace, file), 'utf8'),
    });

    expect(probe).toMatchObject({ ok: true, storageEnabled: true });
    if (!probe.ok) return;
    const [docs, ghost, scratch] = probe.buckets;
    expect(docs.files).toEqual([
      { key: 'one.pdf', sha256: sha256('one invoice') },
    ]);
    expect(ghost).toMatchObject({
      files: [],
      notes: expect.stringMatching(/does not exist/),
    });
    expect(ghost.error).toBeUndefined();
    expect(scratch.files).toEqual([]);
  });
});

const execAsync = (command: string): Promise<CommandResult> =>
  new Promise((resolve) => {
    execFile(
      'sh',
      ['-c', command],
      { env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' } },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : error.code;
        resolve({
          ok: error === null,
          exitCode: typeof code === 'number' ? code : null,
          stdout,
          stderr,
        });
      }
    );
  });

describe.skipIf(!HAS_FETCH_TOOLS)('fetchObject against a local server', () => {
  const BODY = 'pretend invoice bytes';
  const FOUND = '/storage/v1/object/invoices/INV-1.pdf';
  const requests: {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
  }[] = [];
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
      });
      if (req.url === FOUND) {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(BODY);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not_found"}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const lastRequest = () => requests[requests.length - 1];

  it('returns the status and the sha256 of the body for a 200', async () => {
    const result = await fetchObject(
      { exec: execAsync },
      `${base}${FOUND}`,
      {}
    );

    expect(result).toEqual({ status: 200, sha256: sha256(BODY) });
  });

  it('returns the status and no hash for a 404', async () => {
    const result = await fetchObject(
      { exec: execAsync },
      `${base}/storage/v1/object/invoices/missing.pdf`,
      {}
    );

    expect(result).toEqual({ status: 404, sha256: null });
  });

  it('sends the headers as given, whatever characters their values hold', async () => {
    const headers = {
      apikey: 'it\'s a $HOME `key` "quoted"',
      Authorization: 'Bearer abc.def-ghi',
    };

    await fetchObject({ exec: execAsync }, `${base}${FOUND}`, headers);

    expect(lastRequest().headers.apikey).toBe(headers.apikey);
    expect(lastRequest().headers.authorization).toBe(headers.Authorization);
  });

  it('sends no credentials when given no headers', async () => {
    await fetchObject({ exec: execAsync }, `${base}${FOUND}`, {});

    expect(lastRequest().headers.apikey).toBeUndefined();
    expect(lastRequest().headers.authorization).toBeUndefined();
  });

  it('requests the percent-encoded path it was given with GET', async () => {
    const url = `${base}/storage/v1/object/invoices/2026%20Q1/INV%20%231.pdf`;

    await fetchObject({ exec: execAsync }, url, {});

    expect(lastRequest().method).toBe('GET');
    expect(lastRequest().url).toBe(
      '/storage/v1/object/invoices/2026%20Q1/INV%20%231.pdf'
    );
  });

  it('reports no status and a note when the connection is refused', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, '127.0.0.1', resolve)
    );
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));

    const result = await fetchObject(
      { exec: execAsync },
      `http://127.0.0.1:${port}${FOUND}`,
      {}
    );

    expect(result.status).toBeNull();
    expect(result.sha256).toBeNull();
    expect(result.notes).toMatch(/\S/);
  });
});
