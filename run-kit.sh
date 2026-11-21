#!/bin/bash
# Run the kit's real conformance suite against a fresh forge instance.
# Usage: ./run-kit.sh [group...]   groups: repos issues pulls protocol graphql mcp git
set -u
cd "$(dirname "$0")"
lsof -ti:41234 2>/dev/null | xargs kill -9 2>/dev/null
sleep 0.3
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_SHOP_TOKEN=test-token FORGE_UNDER_TEST=1 node --experimental-strip-types -e "
import { createApp } from './app.ts';
const server = createApp();
process.on('uncaughtException', e => console.error('UNCAUGHT:', e));
await new Promise<void>((resolve) => server.listen(41234, resolve));
setTimeout(() => {}, 600000);
" 2>/dev/null &
SERVER_PID=$!
sleep 1
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types run-kit-suite.ts "$@"
RESULT=$?
lsof -ti:41234 2>/dev/null | xargs kill -9 2>/dev/null
exit $RESULT
