import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const SESSION_TOKEN =
  /\\*["'](?:access_token|refresh_token|id_token)\\*["']\s*:\s*\\*["']([\w.~+/%=-]+)\\*["']/g;

function sessionTokens(value: unknown): string[] {
  if (typeof value === 'string') {
    return [...value.matchAll(JWT)]
      .map((match) => match[0])
      .concat([...value.matchAll(SESSION_TOKEN)].map((match) => match[1]));
  }
  if (Array.isArray(value)) return value.flatMap(sessionTokens);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [
      ...(['access_token', 'refresh_token', 'id_token'].includes(key) &&
      typeof item === 'string'
        ? [item]
        : []),
      ...sessionTokens(key),
      ...sessionTokens(item),
    ]);
  }
  return [];
}

function encodedSecret(secret: string): string {
  return encodeURIComponent(secret).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) {
      text = text
        .replaceAll(secret, '[REDACTED]')
        .replaceAll(encodedSecret(secret), '[REDACTED]');
    }
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        String(redact(key, secrets)),
        redact(item, secrets),
      ])
    );
  }
  return value;
}

export function sanitizeResult(
  value: unknown,
  configuredSecrets: readonly string[]
): string {
  const secrets = [...new Set([...configuredSecrets, ...sessionTokens(value)])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const payload = JSON.stringify(redact(value, secrets));
  if (
    secrets.some(
      (secret) =>
        payload.includes(secret) || payload.includes(encodedSecret(secret))
    )
  ) {
    throw new Error('Result still contains a private value');
  }
  return payload;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function config() {
  const value = readJson('/tmp/spark-warp-config.json');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Spark config');
  function field(name: string): string {
    const item = Object.entries(value ?? {}).find(([key]) => key === name)?.[1];
    if (typeof item !== 'string' || !item)
      throw new Error('Missing Spark config');
    return item;
  }
  return {
    apiUrl: field('SPARK_API_URL'),
    clientId: field('CLOUDFLARE_WARP_CLIENT_ID'),
    clientSecret: field('CLOUDFLARE_WARP_CLIENT_SECRET'),
  };
}

function checked(command: string, args: string[] = []): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    writeFileSync(
      '/tmp/spark-setup-error.log',
      (result.stdout ?? '') + (result.stderr ?? ''),
      { mode: 0o600 }
    );
    console.error(
      `Spark setup executable ${command} failed with exit ${result.status}`
    );
    throw new Error('Spark setup command failed');
  }
  return result.stdout;
}

function setup() {
  process.umask(0o077);
  const settings = config();
  // shortcut: Sandbox lacks bridge raw-table support, use host networking for Spark only.
  writeFileSync(
    '/usr/local/bin/docker',
    `#!/bin/bash
set -euo pipefail
case "\${1:-}" in
  run|build)
    for arg in "$@"; do
      case "$arg" in --network|--network=*) exec /usr/bin/docker "$@";; esac
    done
    command="$1"
    shift
    exec /usr/bin/docker "$command" --network host "$@"
    ;;
esac
exec /usr/bin/docker "$@"
`,
    { mode: 0o755 }
  );
  checked('bash', [
    '-c',
    `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl gpg ca-certificates docker.io
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --dearmor --yes -o /usr/share/keyrings/cloudflare-warp.gpg
chmod 644 /usr/share/keyrings/cloudflare-warp.gpg
. /etc/os-release
echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp.gpg] https://pkg.cloudflareclient.com/ $VERSION_CODENAME main" > /etc/apt/sources.list.d/cloudflare-client.list
chmod 644 /etc/apt/sources.list.d/cloudflare-client.list
apt-get update -qq
apt-get install -y -qq cloudflare-warp
update-alternatives --set iptables /usr/sbin/iptables-legacy
update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy
`,
  ]);
  const entries = Object.entries({
    organization: 'supabase',
    auth_client_id: settings.clientId,
    auth_client_secret: settings.clientSecret,
    service_mode: 'proxy',
    warp_tunnel_protocol: 'masque',
  }).map(
    ([key, value]) =>
      `<key>${key}</key><string>${value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</string>`
  );
  mkdirSync('/var/lib/cloudflare-warp', { recursive: true });
  writeFileSync(
    '/var/lib/cloudflare-warp/mdm.xml',
    `<dict>${entries.join('')}<key>proxy_port</key><integer>40000</integer></dict>`,
    { mode: 0o600 }
  );
}

async function connect() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (
      spawnSync('warp-cli', ['--accept-tos', 'registration', 'show']).status ===
      0
    )
      break;
    await setTimeout(1000);
  }
  checked('warp-cli', ['--accept-tos', 'connect']);
  for (let attempt = 0; attempt < 60; attempt++) {
    const warp = spawnSync('warp-cli', ['--accept-tos', 'status'], {
      encoding: 'utf8',
    });
    const docker = spawnSync('docker', ['info']);
    if (
      warp.stdout?.includes('Status update: Connected') &&
      docker.status === 0
    ) {
      chmodSync('/var/run/docker.sock', 0o666);
      return;
    }
    await setTimeout(1000);
  }
  throw new Error('WARP did not connect');
}

function sanitize(path: string) {
  const settings = config();
  const secrets = readJson('/tmp/spark-redactions.json');
  if (
    !Array.isArray(secrets) ||
    !secrets.every((item): item is string => typeof item === 'string')
  )
    throw new Error('Invalid Spark redactions');
  writeFileSync(
    path,
    sanitizeResult(readJson(path), [
      ...Object.values(settings),
      new URL(settings.apiUrl).hostname,
      ...secrets,
    ])
  );
}

function cleanup() {
  rmSync('/var/lib/cloudflare-warp/mdm.xml', { force: true });
  checked('warp-cli', ['--accept-tos', 'disconnect']);
  checked('warp-cli', ['--accept-tos', 'registration', 'delete']);
  if (
    spawnSync('warp-cli', ['--accept-tos', 'registration', 'show']).status === 0
  )
    throw new Error('WARP registration still present');
  console.log('WARP registration deleted');
}

async function main(args: string[]) {
  if (args.length === 0) setup();
  else if (args.length === 1 && args[0] === 'connect') await connect();
  else if (args.length === 1 && args[0] === 'cleanup') cleanup();
  else if (args.length === 2 && args[0] === 'sanitize') sanitize(args[1]);
  else throw new Error('Invalid arguments');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const type =
      error instanceof Error ? error.name.replace(/[^A-Za-z]/g, '') : 'Error';
    const line =
      error instanceof Error
        ? (error.stack?.match(/setup-spark-warp\.ts:(\d+)/)?.[1] ?? '0')
        : '0';
    console.error(`Spark setup error type ${type} at line ${line}`);
    console.error(
      'Spark setup or result sanitization failed. Inspect private Sandbox logs.'
    );
    process.exitCode = 1;
  });
}
