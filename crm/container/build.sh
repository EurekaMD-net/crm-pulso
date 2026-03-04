#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Build engine base image first
echo "Building engine base image..."
cd "$SCRIPT_DIR/../../engine/container" && ./build.sh

# Build CRM container image (extends engine)
echo "Building CRM container image..."
cd "$SCRIPT_DIR/.." && docker build -t agentic-crm-agent:latest -f container/Dockerfile .

echo "CRM container image built: agentic-crm-agent:latest"
