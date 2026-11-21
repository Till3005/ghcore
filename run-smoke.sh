#!/bin/bash
# Run the forge + smoke test in one shot, then shut down.
set -u
cd "$(dirname "$0")"
pkill -f "FORGE_UNDER_TEST" 2>/dev/null
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_SHOP_TOKEN=test-token FORGE_UNDER_TEST=1 node --experimental-strip-types -e "
import { createApp } from './app.ts';
const server = createApp();
server.on('error', e => console.error('Server error:', e));
process.on('unhandledRejection', r => console.error('Unhandled rejection:', r));
process.on('uncaughtException', e => console.error('Uncaught exception:', e));
await new Promise<void>((resolve) => server.listen(41234, resolve));
console.log('Server ready on 41234');
setTimeout(() => {}, 600000);
" 2>&1 &
SERVER_PID=$!
sleep 1.5
FORGE_URL=http://localhost:41234 MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types smoke.ts
RESULT=$?
kill $SERVER_PID 2>/dev/null
exit $RESULT
