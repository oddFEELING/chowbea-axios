#!/bin/bash
# Setup script for chowbea-axios CLI
# Run this from your project root after copying the cli folder

set -e  # Exit on error

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Navigate to project root (two levels up from cli/chowbea-axios)
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Detect package manager based on lockfile
detect_package_manager() {
    if [ -f "$PROJECT_ROOT/pnpm-lock.yaml" ]; then
        echo "pnpm"
    elif [ -f "$PROJECT_ROOT/yarn.lock" ]; then
        echo "yarn"
    elif [ -f "$PROJECT_ROOT/bun.lockb" ]; then
        echo "bun"
    elif [ -f "$PROJECT_ROOT/package-lock.json" ]; then
        echo "npm"
    else
        # Default to pnpm if no lockfile found
        echo "pnpm"
    fi
}

PM=$(detect_package_manager)

echo "================================================"
echo "  chowbea-axios Setup"
echo "================================================"
echo ""
echo "Project root: $PROJECT_ROOT"
echo "Package manager: $PM"
echo ""

# Step 1: Install CLI dependencies (only if node_modules doesn't exist)
cd "$SCRIPT_DIR"

if [ -d "node_modules" ] && [ -d "node_modules/@oclif" ]; then
    echo "[1/3] Dependencies already installed, skipping..."
else
    echo "[1/3] Installing CLI dependencies..."
    case $PM in
        pnpm)
            pnpm install --ignore-workspace
            ;;
        yarn)
            yarn install --ignore-workspace-root-check 2>/dev/null || yarn install
            ;;
        bun)
            bun install
            ;;
        npm)
            npm install
            ;;
    esac
fi

# Step 2: Build the CLI (only if dist doesn't exist or src is newer)
if [ -d "dist" ] && [ "dist/index.js" -nt "src/index.ts" ]; then
    echo ""
    echo "[2/3] CLI already built, skipping..."
else
    echo ""
    echo "[2/3] Building CLI..."
    case $PM in
        pnpm)
            pnpm build
            ;;
        yarn)
            yarn build
            ;;
        bun)
            bun run build
            ;;
        npm)
            npm run build
            ;;
    esac
fi

# Step 3: Run init
echo ""
echo "[3/3] Running init..."
cd "$PROJECT_ROOT"
node cli/chowbea-axios/bin/run.js init "$@"
