#!/usr/bin/env bash
set -euo pipefail

REPO="foundling-ai/mlflare"
BINARY="mlflare"
VERSION=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      BINARY="mlflare-agent"
      shift
      ;;
    --version)
      VERSION="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: install.sh [--agent] [--version vX.Y.Z]"
      exit 1
      ;;
  esac
done

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Linux)  OS="linux" ;;
  Darwin) OS="darwin" ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

# Agent is Linux-only
if [[ "$BINARY" == "mlflare-agent" && "$OS" != "linux" ]]; then
  echo "mlflare-agent is only available for Linux"
  exit 1
fi

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

# Get latest version if not specified
if [[ -z "$VERSION" ]]; then
  echo "Fetching latest release..."
  VERSION="$(curl -sSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)"
  if [[ -z "$VERSION" ]]; then
    echo "Failed to fetch latest version"
    exit 1
  fi
fi

echo "Installing ${BINARY} ${VERSION} (${OS}/${ARCH})..."

# Build download URL
ARCHIVE="${BINARY}_${OS}_${ARCH}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${ARCHIVE}"
CHECKSUM_URL="https://github.com/${REPO}/releases/download/${VERSION}/checksums.txt"

# Download to temp directory
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "Downloading ${URL}..."
curl -sSL -o "${TMPDIR}/${ARCHIVE}" "$URL"
curl -sSL -o "${TMPDIR}/checksums.txt" "$CHECKSUM_URL"

# Verify checksum
echo "Verifying checksum..."
EXPECTED="$(grep "${ARCHIVE}" "${TMPDIR}/checksums.txt" | awk '{print $1}')"
if [[ -z "$EXPECTED" ]]; then
  echo "Warning: checksum not found for ${ARCHIVE}, skipping verification"
else
  ACTUAL="$(sha256sum "${TMPDIR}/${ARCHIVE}" | awk '{print $1}')"
  if [[ "$EXPECTED" != "$ACTUAL" ]]; then
    echo "Checksum mismatch!"
    echo "  Expected: ${EXPECTED}"
    echo "  Got:      ${ACTUAL}"
    exit 1
  fi
  echo "Checksum verified."
fi

# Extract
tar -xzf "${TMPDIR}/${ARCHIVE}" -C "$TMPDIR"

# Install
INSTALL_DIR="/usr/local/bin"
if [[ -w "$INSTALL_DIR" ]]; then
  mv "${TMPDIR}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  if command -v sudo &>/dev/null; then
    sudo mv "${TMPDIR}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
  else
    INSTALL_DIR="${HOME}/.local/bin"
    mkdir -p "$INSTALL_DIR"
    mv "${TMPDIR}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
    echo ""
    echo "Installed to ${INSTALL_DIR}/${BINARY}"
    echo "Make sure ${INSTALL_DIR} is in your PATH:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
  fi
fi

chmod +x "${INSTALL_DIR}/${BINARY}"

echo ""
echo "${BINARY} ${VERSION} installed successfully!"
${INSTALL_DIR}/${BINARY} --version 2>/dev/null || true
