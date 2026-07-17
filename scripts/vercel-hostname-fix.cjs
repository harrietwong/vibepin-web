// vercel-hostname-fix.cjs — the Vercel CLI crashes on non-ASCII computer names
// ("Cannot convert argument to a ByteString", e.g. a Chinese hostname). Preload
// this to any vercel command:
//   NODE_OPTIONS="--require <abs path>/scripts/vercel-hostname-fix.cjs" npx vercel <cmd>
const os = require("os");
os.hostname = () => "vibepin-dev";
