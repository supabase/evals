import { readFile } from 'node:fs/promises';
import { Sandbox } from '@vercel/sandbox';

const stages = new Set([
  'validate configuration', 'install WARP', 'enroll and connect',
  'resolve Spark', 'discover routes', 'before manual routes', 'Spark GET through WARP',
  'after route rollback', 'result', 'cleanup',
]);
const fields = new Set([
  'ok', 'connected', 'nft_unsupported', 'address_count', 'routed',
  'curl_exit', 'http_status', 'address_index', 'projects_created', 'route_count', 'numeric_table_count',
]);

let sandbox;
let stage = 'create sandbox';
try {
  sandbox = await Sandbox.create({
    token: process.env.VERCEL_TOKEN,
    teamId: process.env.VERCEL_TEAM_ID,
    projectId: process.env.VERCEL_PROJECT_ID,
    image: 'vercel/sandbox/node:24',
    timeout: 900000,
    persistent: false,
    networkPolicy: 'allow-all',
  });
  console.log(JSON.stringify({ stage, ok: true }));
  stage = 'write probe';
  const config = Object.fromEntries([
    'CLOUDFLARE_WARP_CLIENT_ID', 'CLOUDFLARE_WARP_CLIENT_SECRET', 'SPARK_API_URL',
  ].map(name => [name, process.env[name]]));
  await sandbox.writeFiles([
    { path: '/tmp/warp-network-probe.py', content: await readFile(new URL('./warp-network-probe.py', import.meta.url)) },
    { path: '/tmp/warp-probe-config.json', content: Buffer.from(JSON.stringify(config)), mode: 0o600 },
  ]);
  stage = 'run sandbox probe';
  const result = await sandbox.runCommand({
    cmd: 'python3',
    args: ['/tmp/warp-network-probe.py', '/tmp/warp-probe-config.json'],
    sudo: true,
    timeoutMs: 780000,
  });
  // Only the probe's fixed stages and numeric/boolean receipts reach public logs.
  for (const line of (await result.stdout()).split('\n')) {
    if (!line.trim()) continue;
    const value = JSON.parse(line);
    if (!stages.has(value.stage)) throw new Error('Unexpected probe output');
    const receipt = { stage: value.stage };
    for (const [key, item] of Object.entries(value)) {
      if (fields.has(key) && (typeof item === 'boolean' || typeof item === 'number')) receipt[key] = item;
    }
    console.log(JSON.stringify(receipt));
  }
  if (result.exitCode) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ stage, ok: false }));
  process.exitCode = 1;
} finally {
  if (sandbox) {
    try {
      await sandbox.runCommand({ cmd: 'rm', args: ['-f', '/tmp/warp-probe-config.json', '/var/lib/cloudflare-warp/mdm.xml'], sudo: true });
      await sandbox.stop();
      await sandbox.delete();
      console.log(JSON.stringify({ stage: 'cleanup', ok: true }));
    } catch {
      console.log(JSON.stringify({ stage: 'cleanup', ok: false }));
      process.exitCode = 1;
    }
  }
}
