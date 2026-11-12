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


def command(*args, timeout=30, input=None):
    return subprocess.run(args, input=input, capture_output=True, text=True, timeout=timeout)


def checked(*args, timeout=30, input=None):
    result = command(*args, timeout=timeout, input=input)
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


def probe(config):
    stage = "validate configuration"
    added = []
    daemon = None
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
