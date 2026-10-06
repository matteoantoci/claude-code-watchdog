// Copied from .scratch/claude-code-watchdog/prototypes/failure-probe/proxy.mjs (spec §16.3), with the extra keys of
// prototypes/first-checks/billing/proxy.mjs merged in, so one proxy covers the first check 9 and the failure cases.
//
// Reverse proxy for ANTHROPIC_BASE_URL=http://127.0.0.1:<port> -> https://api.anthropic.com
// It listens on a free port (or $PORT) and writes the port to <dir>/proxy-port. <dir> is $PROXY_DIR, else the folder
// of this file. It reads <dir>/proxy-mode.json again for each request:
//   { "agent": null | 529 | 429 | 500 | 400 | ..., "main": null | ..., "retryAfter": "<secs>" | null,
//     "unified": { "resetIn": <secs>, "claim": "five_hour", "noShouldRetry": true } (subscription-limit headers),
//     "errType": "<error.type>" (overrides the body type), "message": "<error.message>",
//     "shouldRetry": "true" | "false" | null (x-should-retry header; null = header absent; default "true"),
//     "agentMark": "<text>" (the system-prompt text that marks a watchdog request; default WDFAIL-AGENT-SYSTEM),
//     "saveBodies": true (saves each /v1/messages body to <dir>/req/NNN.json, the wire proof) }
// A request is "agent" when its system prompt carries the agent marker.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const DIR = process.env.PROXY_DIR ?? import.meta.dirname;
const MARK = 'WDFAIL-AGENT-SYSTEM';
const BODIES = {
  529: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  429: {
    type: 'error',
    error: {
      type: 'rate_limit_error',
      message: "This request would exceed your account's rate limit. Please try again later.",
    },
  },
  500: { type: 'error', error: { type: 'api_error', message: 'Internal server error' } },
};
let n = 0;
function plog(o) {
  fs.appendFileSync(`${DIR}/proxy.log`, `${new Date().toISOString()} ${JSON.stringify(o)}\n`);
}
function mode() {
  try {
    return JSON.parse(fs.readFileSync(`${DIR}/proxy-mode.json`, 'utf8'));
  } catch {
    return {};
  }
}
function save(id, body) {
  fs.mkdirSync(`${DIR}/req`, { recursive: true });
  fs.writeFileSync(`${DIR}/req/${String(id).padStart(3, '0')}.json`, body);
}
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    n += 1;
    const id = n;
    let parsed = null;
    try {
      parsed = JSON.parse(body.toString());
    } catch {}
    const isMsg = req.method === 'POST' && req.url.includes('/v1/messages') && !req.url.includes('count_tokens');
    const sys = parsed ? JSON.stringify(parsed.system ?? '') : '';
    const m = mode();
    const who = sys.includes(m.agentMark ?? MARK) ? 'agent' : 'main';
    const inject = isMsg ? m[who] : null;
    const info = {
      id,
      url: req.url,
      who,
      model: parsed?.model,
      retry: req.headers['x-stainless-retry-count'] ?? null,
      msgs: parsed?.messages?.length,
      bytes: body.length,
    };
    if (isMsg && m.saveBodies) {
      save(id, body);
    }
    if (inject) {
      plog({ ...info, injected: inject });
      const h = { 'content-type': 'application/json', 'request-id': `req_probe_${id}` };
      const sr = 'shouldRetry' in m ? m.shouldRetry : 'true';
      if (sr !== null) h['x-should-retry'] = sr;
      if (m.retryAfter) h['retry-after'] = String(m.retryAfter);
      if (m.unified) {
        // shape of a subscription usage-limit 429 (claude.ai plan): unified rate-limit headers
        h['anthropic-ratelimit-unified-status'] = 'rejected';
        h['anthropic-ratelimit-unified-reset'] = String(Math.floor(Date.now() / 1000) + (m.unified.resetIn ?? 60));
        h['anthropic-ratelimit-unified-representative-claim'] = m.unified.claim ?? 'five_hour';
        h['anthropic-ratelimit-unified-overage-status'] = 'rejected';
        if (m.unified.noShouldRetry) delete h['x-should-retry'];
      }
      const base = BODIES[inject] ?? BODIES[500];
      const out =
        m.errType || m.message
          ? { type: 'error', error: { type: m.errType ?? base.error.type, message: m.message ?? base.error.message } }
          : base;
      plog({ id, status: inject, headers: h, body: out });
      res.writeHead(inject, h);
      res.end(JSON.stringify(out));
      return;
    }
    if (isMsg || req.url.includes('count_tokens')) plog({ ...info, forwarded: true });
    const headers = { ...req.headers, host: 'api.anthropic.com' };
    const up = https.request(
      { host: 'api.anthropic.com', port: 443, path: req.url, method: req.method, headers },
      (ur) => {
        if (isMsg) plog({ id, upstreamStatus: ur.statusCode });
        res.writeHead(ur.statusCode, ur.headers);
        ur.pipe(res);
      }
    );
    up.on('error', (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    up.end(body);
  });
});
srv.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  const port = srv.address().port;
  fs.writeFileSync(`${DIR}/proxy-port`, String(port));
  console.log(`proxy ready ${port}`);
});
