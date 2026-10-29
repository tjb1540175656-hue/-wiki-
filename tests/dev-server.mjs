import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const types = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json' };
http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        const relative = decodeURIComponent(url.pathname === '/' ? '/tests/preview.html' : url.pathname);
        const target = path.resolve(root, `.${relative}`);
        if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
        const bytes = await readFile(target);
        res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control':'no-store' }).end(bytes);
    } catch { res.writeHead(404).end('Not found'); }
}).listen(18746, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:18746/tests/preview.html'));
