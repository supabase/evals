import { Sandbox } from '@vercel/sandbox';

const sandbox = await Sandbox.create({
  token: process.env.VERCEL_TOKEN,
  teamId: process.env.VERCEL_TEAM_ID,
  projectId: process.env.VERCEL_PROJECT_ID,
  image: 'vercel/sandbox/node:24',
  timeout: 600000,
  persistent: false,
  networkPolicy: 'allow-all',
});
async function run(step, command, timeoutMs = 120000) {
  const result = await sandbox.runCommand({ cmd: 'bash', args: ['-c', command], sudo: true, timeoutMs });
  if (result.exitCode !== 0) {
    if (step === 'complete enrollment' || step === 'connect WARP') console.log(await result.stdout());
    throw new Error(`${step} failed (exit ${result.exitCode})`);
  }
}
try {
  await run('install WARP', `set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends curl gpg dbus >/dev/null 2>&1
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
. /etc/os-release
echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $VERSION_CODENAME main" >/etc/apt/sources.list.d/cloudflare-client.list
apt-get update -qq
apt-get install -y -qq --no-install-recommends cloudflare-warp >/dev/null 2>&1
mkdir -p /run/dbus
dbus-daemon --system --fork`, 300000);
  await sandbox.runCommand({ cmd: 'bash', args: ['-c', 'umask 077; exec /usr/bin/warp-svc >/tmp/warp-daemon.log 2>&1'], sudo: true, detached: true });
  await run('start WARP', 'for i in $(seq 1 30); do warp-cli --accept-tos status >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1');
  await run('start enrollment', 'timeout 20 warp-cli --accept-tos registration new supabase >/dev/null 2>&1 || true');
  const response = await fetch('https://supabase.cloudflareaccess.com/warp', {
    headers: { 'CF-Access-Client-Id': process.env.CLOUDFLARE_WARP_CLIENT_ID, 'CF-Access-Client-Secret': process.env.CLOUDFLARE_WARP_CLIENT_SECRET },
    redirect: 'manual',
  });
  const location = response.headers.get('location');
  if (!location?.startsWith('com.cloudflare.warp://') || !new URL(location).searchParams.has('token')) throw new Error(`No enrollment token (HTTP ${response.status})`);
  await sandbox.writeFiles([{ path: '.warp-enrollment', content: Buffer.from(location), mode: 0o600 }]);
  await run('complete enrollment', `
if [ ! -f /vercel/.warp-enrollment ]; then echo 'Enrollment file missing'; exit 1; fi
warp-cli --accept-tos registration token "$(cat /vercel/.warp-enrollment)" >/tmp/warp-result 2>&1; code=$?
rm -f /vercel/.warp-enrollment
for word in 'registration' 'token' 'invalid' 'expired' 'missing' 'failed' '401' '403' '400'; do
  if grep -qi "$word" /tmp/warp-result; then echo "Error contains: $word"; fi
done
rm -f /tmp/warp-result
exit "$code"`);
  await run('connect WARP', `warp-cli --accept-tos connect >/tmp/warp-connect 2>&1
connect_status=$?
echo "Connect command exit: $connect_status"
for phrase in 'permission' 'denied' 'policy' 'registration' 'error' 'missing' 'failed' 'disabled'; do
  if grep -qi "$phrase" /tmp/warp-connect; then echo "Connect output contains: $phrase"; fi
done
for i in $(seq 1 20); do warp-cli --accept-tos status 2>/dev/null | grep -q Connected && exit 0; sleep 2; done
warp-cli --accept-tos registration show >/tmp/warp-registration 2>&1 && echo 'Registration present' || echo 'Registration missing'
grep -qi supabase /tmp/warp-registration && echo 'Registration mentions team' || echo 'Registration does not mention team'
warp-cli --accept-tos status >/tmp/warp-status 2>&1
for phrase in 'Disconnected' 'Connecting' 'Unable' 'Registration Missing' 'Network' 'Authentication' 'DNS' 'Tunnel' 'policy' 'error' 'network unreachable' 'device' 'daemon' 'proxy' 'timeout'; do
  if grep -qi "$phrase" /tmp/warp-status; then echo "Status contains: $phrase"; fi
done
for phrase in 'permission denied' 'operation not permitted' 'no such file' 'connection refused' 'connection reset' 'timed out' 'network is unreachable' 'certificate' 'handshake' 'failed to bind' 'tun device' 'tunnel failure' 'invalid token'; do
  if grep -qi "$phrase" /tmp/warp-daemon.log; then echo "Daemon log contains: $phrase"; fi
done
exit 1`, 150000);
  const sparkUrl = new URL('/v1/projects', process.env.SPARK_API_URL).toString();
  const check = await sandbox.runCommand({ cmd: 'curl', args: ['-sS', '--connect-timeout', '10', '--max-time', '20', '-o', '/dev/null', '-w', '%{http_code}', sparkUrl] });
  const status = await check.stdout();
  if (check.exitCode !== 0 || !['200', '404', '405'].includes(status)) throw new Error(`Spark connectivity failed (HTTP ${status})`);
  console.log(`WARP connected and Spark API returned HTTP ${status}`);
} finally {
  await sandbox.runCommand({ cmd: 'bash', args: ['-c', 'rm -f /vercel/.warp-enrollment; warp-cli --accept-tos disconnect >/dev/null 2>&1 || true; warp-cli --accept-tos registration delete >/dev/null 2>&1 || true'], sudo: true, timeoutMs: 30000 }).catch(() => {});
  await sandbox.stop();
}
