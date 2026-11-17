// A LOCAL STAND-IN for Railway's edge, used only to rehearse verify-client-ip.sh (slice 5c). It is not Railway.
//
//   node edge-rig.mjs <listen-port> <api-port> replace|append
//
// "replace": sets X-Forwarded-For to "<caller>, 100.64.7.7" and X-Real-IP to "<caller>", discarding whatever the caller sent
//            (what Railway staff have described: the edge strips and sets, "you may see another hop").
// "append":  keeps the caller's own X-Forwarded-For and appends "<caller>, 100.64.7.7" (what a community answer described).
// The "caller" a request is seen as comes from the X-Sim-Client header, because a rehearsal on one machine has only one real address.
import http from 'node:http';

const [listenPort, apiPort, mode] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
if (!listenPort || !apiPort || (mode !== 'replace' && mode !== 'append')) {
  process.stderr.write('usage: node edge-rig.mjs <listen-port> <api-port> replace|append\n');
  process.exit(2);
}

http
  .createServer((req, res) => {
    const caller = String(req.headers['x-sim-client'] ?? req.socket.remoteAddress);
    const headers = { ...req.headers };
    delete headers['x-sim-client'];
    const incoming = typeof headers['x-forwarded-for'] === 'string' ? headers['x-forwarded-for'] : undefined;
    const hop = '100.64.7.7';
    headers['x-forwarded-for'] = mode === 'replace' ? `${caller}, ${hop}` : [incoming, caller, hop].filter(Boolean).join(', ');
    headers['x-real-ip'] = caller;
    const upstream = http.request({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers }, (back) => {
      res.writeHead(back.statusCode ?? 502, back.headers);
      back.pipe(res);
    });
    upstream.on('error', () => {
      res.writeHead(502).end();
    });
    req.pipe(upstream);
  })
  .listen(listenPort, '127.0.0.1');
