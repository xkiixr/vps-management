#!/usr/bin/env bash
# Prepares a fresh Ubuntu server: installs Docker Engine and opens only SSH, HTTP and HTTPS.
# Safe to run again. Usage:  sudo bash deploy/install-ubuntu.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run this script as root (sudo bash $0)" >&2
  exit 1
fi

# shellcheck disable=SC1091
if [ ! -r /etc/os-release ] || [ "$(. /etc/os-release && echo "${ID:-}")" != "ubuntu" ]; then
  echo "error: this script supports Ubuntu only" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

missing=()
for tool in curl ufw; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ "${#missing[@]}" -gt 0 ]; then
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates "${missing[@]}"
fi

# Docker Engine with the compose and buildx plugins, from Docker's official convenience script.
if ! command -v docker >/dev/null 2>&1; then
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://get.docker.com -o "$installer"
  sh "$installer"
fi
systemctl enable --now docker
docker compose version >/dev/null
docker buildx version >/dev/null

# Firewall: allow SSH first, so enabling ufw cannot lock this session out.
# Ports 30000-32767 for user apps are opened in a later plan.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "Done. Docker $(docker --version | cut -d' ' -f3 | tr -d ,) is installed; ufw allows SSH, 80/tcp and 443/tcp."
echo "Next: cp .env.example .env, fill it in, then docker compose up -d --build"
