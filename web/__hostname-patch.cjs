// Override os.hostname so Vercel CLI doesn't put Chinese chars in HTTP headers
const os = require('os');
os.hostname = () => 'vibepin-deploy';
