'use strict';
const http = require('http');
console.log('[BOOT] Starting minimal bot test...');
console.log('[BOOT] Node version:', process.version);
console.log('[BOOT] Platform:', process.platform);
console.log('[BOOT] PORT:', process.env.PORT);
console.log('[BOOT] Env vars count:', Object.keys(process.env).length);

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Minimal bot OK — ${new Date().toISOString()}`);
});

server.on('error', err => console.error('[SERVER ERROR]', err.message));
server.listen(PORT, () => console.log(`[BOOT] ✅ Minimal server listening on ${PORT}`));

// Essayer de écrire BOOT_REPORT si GITHUB_TOKEN
setTimeout(async () => {
  if (!process.env.GITHUB_TOKEN) return console.log('[BOOT] GITHUB_TOKEN absent');
  try {
    const url = 'https://api.github.com/repos/signaturesb/kira-bot/contents/MINIMAL_BOOT.md';
    const getRes = await fetch(url, { headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } });
    const sha = getRes.ok ? (await getRes.json()).sha : undefined;
    const content = `# Minimal Bot Boot\n${new Date().toISOString()}\nNode: ${process.version}\nPort: ${PORT}\nPID: ${process.pid}\n`;
    await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Minimal boot test', content: Buffer.from(content).toString('base64'), ...(sha ? { sha } : {}) })
    });
    console.log('[BOOT] MINIMAL_BOOT.md écrit dans GitHub ✅');
  } catch (e) { console.error('[BOOT] GitHub write failed:', e.message); }
}, 8000);

console.log('[BOOT] Setup complete');
