"""Spark-only Sandbox bootstrap. Raw command output stays inside the VM."""

import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback
from urllib.parse import quote, urlsplit
from xml.etree.ElementTree import Element, SubElement, tostring


def checked(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=300)
    if result.returncode:
        Path("/tmp/spark-setup-error.log").write_text(result.stdout + result.stderr)
        print(f"Spark setup executable {args[0]} failed with exit {result.returncode}", file=sys.stderr)
        raise RuntimeError("Spark setup command failed")
    return result.stdout


def redact(value, secrets):
    if isinstance(value, str):
        for secret in sorted(set(secrets), key=len, reverse=True):
            if secret:
                value = value.replace(secret, "[REDACTED]")
                value = value.replace(quote(secret, safe=""), "[REDACTED]")
        return value
    if isinstance(value, list):
        return [redact(item, secrets) for item in value]
    if isinstance(value, dict):
        return {redact(key, secrets): redact(item, secrets) for key, item in value.items()}
    return value


def sanitize(path):
    config = json.loads(Path("/tmp/spark-warp-config.json").read_text())
    secrets = list(config.values())
    secrets.append(urlsplit(config["SPARK_API_URL"]).hostname)
    secrets.extend(json.loads(Path("/tmp/spark-redactions.json").read_text()))
    result = Path(path)
    result.write_text(json.dumps(redact(json.loads(result.read_text()), secrets)))


def setup():
    os.umask(0o077)
    config = json.loads(Path("/tmp/spark-warp-config.json").read_text())
    # shortcut: Sandbox lacks bridge raw-table support, use host networking for Spark only.
    wrapper = Path("/usr/local/bin/docker")
    wrapper.write_text('''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
if args and args[0] in ('run', 'build') and '--network' not in args:
    args[1:1] = ['--network', 'host']
os.execv('/usr/bin/docker', ['docker', *args])
''')
    wrapper.chmod(0o755)
    checked("bash", "-c", """set -euo pipefail
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
""")
    document = Element("dict")
    for key, value in [("organization", "supabase"), ("auth_client_id", config["CLOUDFLARE_WARP_CLIENT_ID"]), ("auth_client_secret", config["CLOUDFLARE_WARP_CLIENT_SECRET"]), ("service_mode", "proxy"), ("warp_tunnel_protocol", "masque")]:
        SubElement(document, "key").text = key
        SubElement(document, "string").text = value
    SubElement(document, "key").text = "proxy_port"
    SubElement(document, "integer").text = "40000"
    mdm = Path("/var/lib/cloudflare-warp/mdm.xml")
    mdm.parent.mkdir(parents=True, exist_ok=True)
    mdm.write_bytes(tostring(document))
    mdm.chmod(0o600)


def connect():
    config = json.loads(Path("/tmp/spark-warp-config.json").read_text())
    for _ in range(60):
        registration = subprocess.run(["warp-cli", "--accept-tos", "registration", "show"], capture_output=True)
        if registration.returncode == 0:
            break
        time.sleep(1)
    checked("warp-cli", "--accept-tos", "connect")
    for _ in range(60):
        warp = subprocess.run(["warp-cli", "--accept-tos", "status"], capture_output=True, text=True)
        docker = subprocess.run(["docker", "info"], capture_output=True)
        if "Status update: Connected" in warp.stdout and docker.returncode == 0:
            Path("/var/run/docker.sock").chmod(0o666)
            status = checked("curl", "-s", "--max-time", "20", "-H", "Authorization: Bearer injected-by-sandbox-firewall", "-o", "/dev/null", "-w", "%{http_code}", "https://api.openai.com/v1/models")
            print(f"Provider credential brokering HTTP {status}")
            if status != "200":
                raise RuntimeError("Provider credential brokering failed")
            print("Provider credential brokering HTTP 200 with placeholder key")
            Path("/tmp/spark-warp-config.json").write_text(json.dumps({"SPARK_API_URL": config["SPARK_API_URL"]}))
            return
        time.sleep(1)
    raise RuntimeError("WARP did not connect")


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["--self-check"]:
            secret = "https://private.example/a?token=secret"
            assert redact({"nested": [secret, quote(secret, safe=""), 4]}, [secret]) == {"nested": ["[REDACTED]", "[REDACTED]", 4]}
        elif sys.argv[1:2] == ["sanitize"] and len(sys.argv) == 3:
            sanitize(sys.argv[2])
        elif sys.argv[1:] == ["connect"]:
            connect()
        elif not sys.argv[1:]:
            setup()
        else:
            raise RuntimeError("Invalid arguments")
    except Exception as error:
        print(f"Spark setup error type {type(error).__name__} at line {traceback.extract_tb(error.__traceback__)[-1].lineno}", file=sys.stderr)
        print("Spark setup or result sanitization failed. Inspect private Sandbox logs.", file=sys.stderr)
        sys.exit(1)
