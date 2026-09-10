const WebSocket = require('ws');
const HOST = 'artautass-macbook-pro-2.tailc0c0ec.ts.net';
const PUBLIC_IP = '185.40.234.172';

const ws = new WebSocket(`wss://${PUBLIC_IP}/`, {
  servername: HOST,
  headers: { Host: HOST },
});

const t = setTimeout(() => { console.log('TIMEOUT - no upgrade'); process.exit(1); }, 20000);
ws.on('open', () => {
  console.log('websocket OPEN through the public ingress');
  ws.send(JSON.stringify({ id: 1, method: 'getBlockDagInfo', params: {} }));
});
ws.on('message', (d) => {
  clearTimeout(t);
  const r = JSON.parse(String(d));
  console.log('network :', r.params?.network);
  console.log('daaScore:', r.params?.virtualDaaScore);
  ws.close(); process.exit(0);
});
ws.on('error', (e) => { clearTimeout(t); console.log('ERROR:', e.message); process.exit(1); });
