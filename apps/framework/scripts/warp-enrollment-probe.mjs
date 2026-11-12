import { readFile } from 'node:fs/promises';
import { Sandbox } from '@vercel/sandbox';
import { brokeredNetworkPolicy } from './run-vercel-evals.ts';
import { SPARK_PROXY_BYPASS } from '../../../experiments/spark/lib/runtime.ts';

const stages = new Set([
  'validate configuration', 'install WARP', 'enroll and connect', 'probe environment', 'command failure', 'installation error',
  'resolve Spark', 'discover routes', 'before manual routes', 'Spark GET through WARP',
  'after route rollback', 'result', 'cleanup', 'Spark proxy GET', 'install nested Docker', 'nested Docker proxy GET',
  'normal Docker networking', 'provider credential brokering', 'prepare real eval', 'real Spark eval', 'Spark request timings',
  'Spark HTTP proxy fetch',
  'eval networking',
]);
const fields = new Set([
  'warp_credentials_present', 'apt_available', 'dnf_available', 'exit_code', 'missing_command', 'missing_repository', 'package_missing', 'ok', 'connected', 'nft_unsupported', 'address_count', 'routed',
  'curl_exit', 'http_status', 'address_index', 'projects_created', 'route_count', 'numeric_table_count',
  'default_networking', 'ready', 'iptables_unsupported', 'eval_passed', 'check_count', 'passed_check_count',
  'request_count', 'failed_request_count', 'over_ten_seconds_count', 'max_elapsed_ms', 'result_exists', 'timeout_mentions',
  'elapsed_ms', 'legacy_iptables', 'host_networking', 'bridge_networking',
]);

const realEval = process.env.WARP_PROBE_REAL_EVAL === 'true';
let sandbox;
let stage = 'create sandbox';
try {
  sandbox = await Sandbox.create({
    token: process.env.VERCEL_TOKEN,
    teamId: process.env.VERCEL_TEAM_ID,
    projectId: process.env.VERCEL_PROJECT_ID,
    ...(realEval ? {
      name: `spark-real-eval-${process.env.GITHUB_RUN_ID}`,
      source: { type: 'git', url: 'https://github.com/supabase/evals.git', revision: process.env.GITHUB_SHA, depth: 1 },
      resources: { vcpus: 4 },
    } : {}),
    image: process.env.WARP_PROBE_IMAGE === 'universal' ? 'vercel/sandbox/universal' : 'vercel/sandbox/node:24',
    timeout: realEval ? 2400000 : 900000,
    persistent: false,
    networkPolicy: 'allow-all',
  });
  console.log(JSON.stringify({ stage, ok: true }));
  if (realEval) {
    stage = 'provider without brokering';
    const probeArgs = ['-s', '--max-time', '20', '-o', '/dev/null', '-w', '%{http_code}', 'https://api.openai.com/v1/models'];
    const before = await sandbox.runCommand({ cmd: 'curl', args: probeArgs });
    const beforeStatus = await before.stdout();
    console.log(JSON.stringify({ stage, http_status: Number(beforeStatus) }));
    if (before.exitCode || beforeStatus !== '401' || !process.env.OPENAI_API_KEY) throw new Error('Provider control failed');
    await sandbox.update({ networkPolicy: brokeredNetworkPolicy() });
    stage = 'provider with brokering';
    const after = await sandbox.runCommand({ cmd: 'curl', args: probeArgs });
    const afterStatus = await after.stdout();
    console.log(JSON.stringify({ stage, http_status: Number(afterStatus) }));
    if (after.exitCode || afterStatus !== '200') throw new Error('Provider broker failed');
  }
  stage = 'bootstrap sandbox';
  const bootstrap = await sandbox.runCommand({
    cmd: 'bash',
    args: ['-c', 'command -v python3 >/dev/null || { apt-get update -qq && apt-get install -y -qq python3; }'],
    sudo: true,
    timeoutMs: 180000,
  });
  console.log(JSON.stringify({ stage, exit_code: bootstrap.exitCode }));
  if (bootstrap.exitCode) throw new Error('Bootstrap failed');
  stage = 'write probe';
  const config = Object.fromEntries([
    'CLOUDFLARE_WARP_CLIENT_ID', 'CLOUDFLARE_WARP_CLIENT_SECRET', 'SPARK_API_URL', 'WARP_PROBE_MODE',
  ].map(name => [name, process.env[name]]));
  config.WARP_PROBE_NESTED = true;
  config.WARP_PROBE_REAL_EVAL = realEval;
  config.WARP_PROBE_BYPASS = SPARK_PROXY_BYPASS;
  config.WARP_PROBE_NETWORK = process.env.WARP_PROBE_NETWORK || 'bridge';
  const cwd = await sandbox.runCommand({ cmd: 'pwd' });
  config.WARP_PROBE_REPO_ROOT = (await cwd.stdout()).trim();
  await sandbox.writeFiles([
    { path: '/tmp/warp-network-probe.py', content: await readFile(new URL('./warp-network-probe.py', import.meta.url)) },
    { path: '/tmp/warp-probe-config.json', content: Buffer.from(JSON.stringify(config)), mode: 0o600 },
  ]);
  stage = 'run sandbox probe';
  const result = await sandbox.runCommand({
    cmd: 'python3',
    args: ['/tmp/warp-network-probe.py', '/tmp/warp-probe-config.json'],
    sudo: true,
    timeoutMs: realEval ? 2100000 : 780000,
  });
  console.log(JSON.stringify({ stage, exit_code: result.exitCode }));
  // Only the probe's fixed stages and numeric/boolean receipts reach public logs.
  for (const line of (await result.stdout()).split('\n')) {
    if (!line.trim()) continue;
    const value = JSON.parse(line);
    if (!stages.has(value.stage)) throw new Error('Unexpected probe output');
    const receipt = { stage: value.stage };
    for (const [key, item] of Object.entries(value)) {
      if (fields.has(key) && (typeof item === 'boolean' || typeof item === 'number')) receipt[key] = item;
    }
    if (value.stage === 'installation error' && typeof value.install_error === 'string' && value.install_error.length <= 1500 && !/[A-Za-z0-9-]\.[A-Za-z0-9-]|https?:/.test(value.install_error)) {
      receipt.install_error = value.install_error;
    }
    console.log(JSON.stringify(receipt));
  }
  if (result.exitCode) process.exitCode = 1;
  if (realEval) {
    console.log(JSON.stringify({ stage: 'private inspection window', ready: true }));
    for (let attempt = 0; attempt < 90; attempt++) {
      const release = await sandbox.runCommand({ cmd: 'test', args: ['-f', '/tmp/warp-eval-release'] });
      if (release.exitCode === 0) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
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
