#!/bin/bash
# io-tech-deals - Deal checker wrapper

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# Only compile if JS file doesn't exist or TS is newer
if [ ! -f "scripts/check-deals.js" ] || [ "src/check-deals.ts" -nt "scripts/check-deals.js" ]; then
    echo "🔄 Compiling TypeScript..."
    npx tsc || {
        echo "❌ Compilation failed"
        exit 1
    }
fi

# Run the compiled JS, passing all arguments
node scripts/check-deals.js "$@"
