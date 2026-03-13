import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAILURE_FILE = path.join(__dirname, 'failures.jsonl');

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/log-failure') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const failure = JSON.parse(body);
        fs.appendFileSync(FAILURE_FILE, JSON.stringify(failure) + '\n');
        console.log('[failure-logger] wrote:', failure);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(4030, () => {
  console.log('[failure-logger] listening on http://localhost:4030');
});