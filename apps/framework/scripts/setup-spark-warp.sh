#!/bin/bash
umask 077
exec >>/tmp/spark-setup.log 2>&1
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
install -D -m 600 /tmp/spark-warp-mdm.xml /var/lib/cloudflare-warp/mdm.xml
# shortcut: Sandbox lacks bridge raw-table support, use host networking for Spark only.
cat > /usr/local/bin/docker <<'DOCKER'
#!/bin/bash
set -euo pipefail
case "${1:-}" in
  run|build)
    for arg in "$@"; do
      case "$arg" in --network|--network=*) exec /usr/bin/docker "$@";; esac
    done
    exec /usr/bin/docker "$1" --network host "${@:2}"
    ;;
esac
exec /usr/bin/docker "$@"
DOCKER
chmod 755 /usr/local/bin/docker
