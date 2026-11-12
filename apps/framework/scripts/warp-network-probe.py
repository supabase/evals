"""Disposable IPv4 routing experiment. Public output contains only fixed labels and counts."""

import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
from urllib.parse import urlsplit
from xml.etree.ElementTree import Element, SubElement, tostring


def report(stage, **fields):
    print(json.dumps(dict(stage=stage, **fields)), flush=True)


def command(*args, timeout=30, input=None, env=None, cwd=None):
    return subprocess.run(args, input=input, env=env, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def checked(*args, timeout=30, input=None, cwd=None):
    result = command(*args, timeout=timeout, input=input, cwd=cwd)
    if result.returncode:
        report("command failure", exit_code=result.returncode, missing_command="command not found" in result.stderr, missing_repository="does not have a Release file" in result.stderr, package_missing="Unable to locate package" in result.stderr)
        if args[:2] == ("bash", "-c"):
            errors = " ".join(line for line in (result.stdout + result.stderr).splitlines() if line.startswith(("E:", "W:", "Err:")))
            errors = re.sub(r"https?://\S+", "<url>", errors)
            errors = re.sub(r"\b(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+\b", "<host>", errors)
            report("installation error", install_error=errors[:1500])
        raise RuntimeError("command failed")
    return result.stdout


def route_table(routes):
    tables = set()
    for item in routes:
        value = item.get("table")
        if item.get("dev") == "CloudflareWARP" and item.get("type", "unicast") == "unicast" and str(value).isdecimal():
            tables.add(int(value))
    if len(tables) != 1:
        raise RuntimeError("WARP routing table ambiguous")
    return tables.pop()


def receipt(url, host, address):
    result = command("curl", "-4", "-s", "--connect-timeout", "5", "--max-time", "15", "--resolve", f"{host}:443:{address}", "-o", "/dev/null", "-w", "%{http_code}", url)
    status = int(result.stdout) if re.fullmatch(r"[0-9]{3}", result.stdout) else 0
    return dict(curl_exit=result.returncode, http_status=status)


def real_eval(config):
    stage = "prepare real eval"
    os.chdir(config["WARP_PROBE_REPO_ROOT"])
    checked("git", "-c", f"safe.directory={os.getcwd()}", "-c", "url.https://github.com/.insteadOf=git@github.com:", "submodule", "update", "--init", "--recursive", timeout=180)
    checked("npm", "install", "--global", "pnpm@10.24.0", timeout=180)
    checked("pnpm", "install", "--frozen-lockfile", timeout=360)
    Path(".env").write_text("OPENAI_API_KEY=injected-by-sandbox-firewall\nSPARK_API_URL=" + config["SPARK_API_URL"] + "\nSPARK_PROXY_URL=http://host.docker.internal:40001\n")
    env = dict(os.environ, HTTPS_PROXY="http://127.0.0.1:40000", NO_PROXY=config["WARP_PROBE_BYPASS"], NODE_USE_ENV_PROXY="1")
    selection = command("pnpm", "--silent", "eval", "--", "list", "--suite", "spark", "--eval", "build-database-001-task-due-dates", env=env)
    if selection.returncode or "spark/codex-gpt-6-luna" not in json.loads(selection.stdout):
        raise RuntimeError("experiment not in Spark suite")
    report(stage, ok=True)

    framework = str(Path.cwd() / "apps/framework")
    ca = checked("node", "--import", "tsx/esm", "--input-type=module", "-e", "import {proxyCaArgs} from '../../packages/sandbox/src/docker-sandbox.ts'; console.log(JSON.stringify(proxyCaArgs()));", cwd=framework)
    image = "curlimages/curl:8.17.0"
    network = config.get("WARP_PROBE_NETWORK", "bridge")
    docker = ["docker", "run", "--rm", "--network", network, "--add-host", "host.docker.internal:host-gateway", *json.loads(ca), "--env", "HTTPS_PROXY=http://host.docker.internal:40001", "--env", "NO_PROXY=" + config["WARP_PROBE_BYPASS"], "--env", "OPENAI_API_KEY=injected-by-sandbox-firewall", "--entrypoint", "sh", image]
    provider = command(*docker, "-c", '''test "$OPENAI_API_KEY" = injected-by-sandbox-firewall && test -z "${CLOUDFLARE_WARP_CLIENT_SECRET-}${CLOUDFLARE_WARP_CLIENT_ID-}" || exit 97
exec curl -s --max-time 20 -H "Authorization: Bearer $OPENAI_API_KEY" -o /dev/null -w '%{http_code}' https://api.openai.com/v1/models''', timeout=45)
    status = int(provider.stdout) if re.fullmatch(r"[0-9]{3}", provider.stdout) else 0
    report("provider credential brokering", exit_code=provider.returncode, http_status=status, warp_credentials_present=provider.returncode == 97)
    if provider.returncode or status != 200:
        raise RuntimeError("nested provider broker failed")
    script = "fetch(new URL('/v1/projects',process.env.SPARK_API_URL),{signal:AbortSignal.timeout(15000)}).then(r=>console.log(r.status)).catch(()=>process.exitCode=1)"
    native = command("node", "--env-file=.env", "-e", script, env=env)
    status = int(native.stdout.strip()) if native.stdout.strip().isdigit() else 0
    report("Spark HTTP proxy fetch", exit_code=native.returncode, http_status=status)
    if native.returncode or status != 405:
        raise RuntimeError("native fetch proxy failed")

    if network == "host":
        directory = Path("/tmp/warp-eval-bin")
        directory.mkdir(exist_ok=True)
        wrapper = directory / "docker"
        wrapper.write_text('''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
if args and args[0] in ('run', 'build') and '--network' not in args:
    args[1:1] = ['--network', 'host']
os.execv('/usr/bin/docker', ['docker', *args])
''')
        wrapper.chmod(0o700)
        env.update(PATH=str(directory) + ":" + env["PATH"], DOCKER_BUILDKIT="0")
    report("eval networking", host_networking=network == "host", bridge_networking=network == "bridge")
    build = command("node", "--import", "tsx/esm", "--input-type=module", "-e", "import {ensureSupabaseSandboxImage} from '../../packages/sandbox/src/supabase.ts'; await ensureSupabaseSandboxImage();", env=env, cwd=framework, timeout=600)
    Path("/tmp/warp-agent-build.log").write_text(build.stdout + build.stderr)
    report("build agent image", exit_code=build.returncode)
    if build.returncode:
        raise RuntimeError("agent image build failed")

    path = Path("results/spark/codex-gpt-6-luna/build-database-001-task-due-dates/run-1/result.json")
    path.unlink(missing_ok=True)
    started = time.monotonic()
    with open("/tmp/warp-real-eval.log", "w") as output:
        result = subprocess.run(["node", "--env-file=../../.env", "--import", "./scripts/warp-eval-observe.mjs", "--import", "tsx/esm", "harness/run-eval.ts", "--suite", "spark", "--experiment", "codex-gpt-6-luna", "--eval", "build-database-001-task-due-dates", "--runs", "1", "--timeout-sec", "720"], env=env, cwd=framework, stdout=output, stderr=output, timeout=1200)
    # A committed result cannot stand in for this run's real project and result.
    project_exists = Path("/tmp/warp-eval-project.json").exists()
    exists = path.exists() and project_exists
    data = json.loads(path.read_text()) if exists else {}
    checks = data.get("checks", [])
    report("real Spark eval", exit_code=result.returncode, result_exists=exists, eval_passed=data.get("passed", False), check_count=len(checks), passed_check_count=sum(item.get("passed", False) for item in checks), elapsed_ms=round((time.monotonic()-started)*1000))
    timing = Path("/tmp/warp-eval-timing.jsonl")
    requests = [json.loads(line) for line in timing.read_text().splitlines()] if timing.exists() else []
    text = Path("/tmp/warp-real-eval.log").read_text(errors="replace") + json.dumps(data)
    summary = dict(request_count=len(requests), failed_request_count=sum(item["failed"] for item in requests), over_ten_seconds_count=sum(item["elapsed_ms"] >= 10000 for item in requests), max_elapsed_ms=max((item["elapsed_ms"] for item in requests), default=0), timeout_mentions=len(re.findall(r"timed out|ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT", text, re.IGNORECASE)))
    report("Spark request timings", **summary)
    projects = sum(item["path"] == "/v1/projects" and 200 <= item["status"] < 300 for item in requests)
    report("result", ok=exists and data.get("passed", False), projects_created=projects)
    return result.returncode == 0 and exists and data.get("passed", False)


def probe(config):
    stage = "validate configuration"
    added = []
    daemon = None
    sidecars = []
    mdm = Path("/var/lib/cloudflare-warp/mdm.xml")
    try:
        client_id = config["CLOUDFLARE_WARP_CLIENT_ID"]
        secret = config["CLOUDFLARE_WARP_CLIENT_SECRET"]
        mode = config.get("WARP_PROBE_MODE", "warp")
        api = urlsplit(config["SPARK_API_URL"])
        if mode not in ("warp", "proxy") or not client_id.endswith(".access") or not secret or api.scheme != "https" or not api.hostname or api.username or api.password or api.port not in (None, 443):
            raise RuntimeError("invalid configuration")
        host = api.hostname
        url = f"https://{host}/v1/projects"
        if os.environ.get("GITHUB_ACTIONS") == "true":
            print(f"::add-mask::{host}", flush=True)

        stage = "install WARP"
        report("probe environment", apt_available=shutil.which("apt-get") is not None, dnf_available=shutil.which("dnf") is not None)
        checked("bash", "-c", """set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl gpg iproute2 ca-certificates
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --dearmor --yes -o /usr/share/keyrings/cloudflare-warp.gpg
# apt's signature verifier reads the public key as an unprivileged user.
chmod 644 /usr/share/keyrings/cloudflare-warp.gpg
. /etc/os-release
echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp.gpg] https://pkg.cloudflareclient.com/ $VERSION_CODENAME main" > /etc/apt/sources.list.d/cloudflare-client.list
chmod 644 /etc/apt/sources.list.d/cloudflare-client.list
apt-get update -qq
apt-get install -y -qq cloudflare-warp
""", timeout=300)
        report(stage, ok=True)
        stage = "enroll and connect"
        mdm.parent.mkdir(parents=True, exist_ok=True)
        document = Element("dict")
        for key, value in [("organization", "supabase"), ("auth_client_id", client_id), ("auth_client_secret", secret), ("service_mode", mode), ("warp_tunnel_protocol", "masque")]:
            SubElement(document, "key").text = key
            SubElement(document, "string").text = value
        if mode == "proxy":
            SubElement(document, "key").text = "proxy_port"
            SubElement(document, "integer").text = "40000"
        mdm.write_bytes(tostring(document))
        mdm.chmod(0o600)
        if os.environ.get("GITHUB_ACTIONS") == "true":
            checked("systemctl", "restart", "warp-svc")
        # The package starts systemd on runners. Sandboxes need their own daemon.
        if command("warp-cli", "--accept-tos", "status").returncode:
            with open("/tmp/warp-probe-daemon.log", "w") as log:
                daemon = subprocess.Popen(["warp-svc"], stdout=log, stderr=log)
        for _ in range(45):
            if command("warp-cli", "--accept-tos", "registration", "show").returncode == 0:
                break
            time.sleep(2)
        checked("warp-cli", "--accept-tos", "connect")
        connected = False
        for _ in range(30):
            if "Status update: Connected" in command("warp-cli", "--accept-tos", "status").stdout:
                connected = True
                break
            time.sleep(2)
        daemon_log = Path("/tmp/warp-probe-daemon.log")
        text = daemon_log.read_text(errors="replace") if daemon_log.exists() else ""
        report(stage, connected=connected, nft_unsupported="Operation not supported" in text and "nft" in text)
        if not connected:
            raise RuntimeError("connection failed")

        if mode == "proxy":
            stage = "Spark proxy GET"
            result = command("curl", "-s", "--proxy", "socks5h://127.0.0.1:40000", "--connect-timeout", "5", "--max-time", "15", "-o", "/dev/null", "-w", "%{http_code}", url)
            status = int(result.stdout) if re.fullmatch(r"[0-9]{3}", result.stdout) else 0
            report(stage, exit_code=result.returncode, http_status=status)
            if result.returncode or status not in (200, 405):
                raise RuntimeError("proxy request failed")
            if config.get("WARP_PROBE_NESTED"):
                stage = "install nested Docker"
                checked("bash", "-c", "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends docker.io socat", timeout=300)
                if config.get("WARP_PROBE_REAL_EVAL"):
                    # Sandbox supports classic iptables NAT, while nftables calls fail.
                    checked("update-alternatives", "--set", "iptables", "/usr/sbin/iptables-legacy")
                    checked("update-alternatives", "--set", "ip6tables", "/usr/sbin/ip6tables-legacy")
                with open("/tmp/warp-probe-docker.log", "w") as log:
                    # This experiment only needs container-to-host access, so no NAT rules.
                    docker_args = ["dockerd"] if config.get("WARP_PROBE_REAL_EVAL") else ["dockerd", "--iptables=false", "--ip6tables=false", "--ip-masq=false"]
                    sidecars.append(subprocess.Popen(docker_args, stdout=log, stderr=log))
                ready = False
                for _ in range(60):
                    if command("docker", "info").returncode == 0:
                        ready = True
                        break
                    time.sleep(1)
                log = Path("/tmp/warp-probe-docker.log").read_text(errors="replace")
                report("Docker daemon", ready=ready, default_daemon_flags=bool(config.get("WARP_PROBE_REAL_EVAL")), legacy_iptables=bool(config.get("WARP_PROBE_REAL_EVAL")), iptables_unsupported="Operation not supported" in log and "iptables" in log)
                checked("docker", "info")
                bridge = json.loads(checked("ip", "-j", "-4", "addr", "show", "docker0"))[0]["addr_info"][0]["local"]
                with open("/tmp/warp-probe-forwarder.log", "w") as log:
                    sidecars.append(subprocess.Popen(["socat", f"TCP-LISTEN:40001,bind={bridge},reuseaddr,fork", "TCP:127.0.0.1:40000"], stdout=log, stderr=log))
                image = "curlimages/curl:8.17.0"
                checked("docker", "pull", image, timeout=180)
                stage = "nested Docker proxy GET"
                script = '''test -z "${CLOUDFLARE_WARP_CLIENT_SECRET-}${CLOUDFLARE_WARP_CLIENT_ID-}" || exit 97
exec curl -s --proxy socks5h://host.docker.internal:40001 --connect-timeout 5 --max-time 15 -o /dev/null -w '%{http_code}' "$PROBE_URL"'''
                nested = command("docker", "run", "--rm", "--network", config.get("WARP_PROBE_NETWORK", "bridge"), "--add-host", "host.docker.internal:host-gateway", "--env", f"PROBE_URL={url}", "--entrypoint", "sh", image, "-c", script, timeout=45)
                status = int(nested.stdout) if re.fullmatch(r"[0-9]{3}", nested.stdout) else 0
                report(stage, exit_code=nested.returncode, http_status=status, warp_credentials_present=nested.returncode == 97)
                if nested.returncode or status not in (200, 405):
                    raise RuntimeError("nested proxy request failed")
            if config.get("WARP_PROBE_REAL_EVAL"):
                if not real_eval(config):
                    raise RuntimeError("eval failed")
                return 0
            report("result", ok=True, projects_created=0)
            return 0

        stage = "resolve Spark"
        addresses = sorted({item[4][0] for item in socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)})
        if not addresses:
            raise RuntimeError("no addresses")
        for address in addresses:
            ipaddress.IPv4Address(address)
            if os.environ.get("GITHUB_ACTIONS") == "true":
                print(f"::add-mask::{address}", flush=True)
        report(stage, address_count=len(addresses))
        stage = "discover routes"
        routes = json.loads(checked("ip", "-j", "-4", "route", "show", "table", "all"))
        warp_routes = [item for item in routes if item.get("dev") == "CloudflareWARP"]
        report(stage, route_count=len(warp_routes), numeric_table_count=len({item["table"] for item in warp_routes if isinstance(item.get("table"), int)}))
        table = route_table(routes)
        report("before manual routes", **receipt(url, host, addresses[0]))
        for address in addresses:
            checked("ip", "-4", "route", "add", f"{address}/32", "dev", "CloudflareWARP", "table", str(table))
            added.append((address, table))
            routes = json.loads(checked("ip", "-j", "-4", "route", "get", address))
            if routes[0].get("dev") != "CloudflareWARP":
                raise RuntimeError("route not selected")
        report(stage, address_count=len(addresses), routed=True)
        stage = "Spark GET through WARP"
        for index, address in enumerate(addresses):
            result = receipt(url, host, address)
            report(stage, address_index=index, **result)
            if result["curl_exit"] or result["http_status"] not in (200, 405):
                raise RuntimeError("HTTP check failed")
        if os.environ.get("GITHUB_ACTIONS") == "true":
            stage = "nested Docker GET"
            checked("docker", "pull", "node:22-slim", timeout=180)
            script = """fetch(process.env.PROBE_URL, {signal: AbortSignal.timeout(15000)})
.then(response => console.log(JSON.stringify({http_status: response.status, warp_credentials_present: Boolean(process.env.CLOUDFLARE_WARP_CLIENT_SECRET)})))
.catch(() => { console.log(JSON.stringify({http_status: 0})); process.exitCode = 1; });"""
            nested = command("docker", "run", "--rm", "--network", "bridge", "--env", f"PROBE_URL={url}", "node:22-slim", "node", "-e", script, timeout=45)
            result = json.loads(nested.stdout)
            report(stage, exit_code=nested.returncode, **result)
            if nested.returncode or result["http_status"] not in (200, 405) or result["warp_credentials_present"]:
                raise RuntimeError("nested request failed")
        for address, table in added:
            checked("ip", "-4", "route", "del", f"{address}/32", "dev", "CloudflareWARP", "table", str(table))
        added.clear()
        report("after route rollback", **receipt(url, host, addresses[0]))
        report("result", ok=True, projects_created=0)
        return 0
    except Exception as error:
        report(stage, ok=False, failure_type=type(error).__name__)
        return 1
    finally:
        for address, table in added:
            command("ip", "-4", "route", "del", f"{address}/32", "dev", "CloudflareWARP", "table", str(table))
        mdm.unlink(missing_ok=True)
        for action in [("disconnect",), ("registration", "delete")]:
            try:
                command("warp-cli", "--accept-tos", *action)
            except OSError:
                pass
        if daemon:
            daemon.terminate()
        for process in reversed(sidecars):
            process.terminate()


if __name__ == "__main__":
    os.umask(0o077)
    if sys.argv[1:] == ["--self-check"]:
        assert route_table([{"dev": "CloudflareWARP", "table": "local"}, {"dev": "CloudflareWARP", "table": "123"}]) == 123
        assert route_table([{"dev": "CloudflareWARP", "table": 123}]) == 123
        try:
            route_table([{"dev": "CloudflareWARP", "table": 123}, {"dev": "CloudflareWARP", "table": 456}])
        except RuntimeError:
            pass
        else:
            raise AssertionError("ambiguous tables accepted")
        report("self-check", ok=True)
    else:
        config = json.loads(Path(sys.argv[1]).read_text()) if sys.argv[1:] else os.environ
        sys.exit(probe(config))
