/* ReRun pair — the tab side. Registers this notebook with the relay so an
 * agent (via the pair MCP bridge) can drive it while the human watches.
 *
 *   initPair(api)   — api: the op handlers from app.js
 *
 * Pairing starts from the header button (or automatically via
 * #pair=session:token in the URL, which is also how tests drive it). While
 * paired, incoming {id, type:'tool', name, args} frames are executed against
 * the live notebook and answered with {id, result}. The button is the kill
 * switch.
 */

const RELAY_PATH = '/rerun/pair';

export function initPair(api) {
  const btn = document.getElementById('pair');
  const banner = document.getElementById('pair-banner');
  if (!btn) return;

  let ws = null;
  let state = 'idle'; // idle | connecting | waiting | live

  const rand = (n) => {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return [...a].map((b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
  };

  function setUi() {
    btn.classList.toggle('pairing', state !== 'idle');
    btn.textContent = { idle: 'pair', connecting: 'pairing…', waiting: '⟳ waiting for agent', live: '⟳ agent live — unpair' }[state];
    if (state === 'idle') { banner.hidden = true; banner.innerHTML = ''; }
  }

  function showBanner(sessionId, token) {
    banner.innerHTML = '';
    const relay = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${RELAY_PATH}`;

    const label = document.createElement('span');
    label.textContent = 'tell your agent to pair with ';
    const short = document.createElement('code');
    short.textContent = `session ${sessionId} · token ${token}`;
    const copyShort = document.createElement('button');
    copyShort.textContent = 'copy';
    copyShort.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(`pair with my ReRun notebook: session ${sessionId}, token ${token}`);
        copyShort.textContent = 'copied';
      } catch { /* it's visible, select it */ }
    });

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'MCP config for Claude Code / Codex / Cursor';
    const code = document.createElement('code');
    code.textContent =
      `claude mcp add rerun-pair -- node pair/mcp/server.mjs --relay ${relay} --session ${sessionId} --token ${token}`;
    const copyFull = document.createElement('button');
    copyFull.textContent = 'copy';
    copyFull.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code.textContent); copyFull.textContent = 'copied'; }
      catch { /* visible */ }
    });
    details.append(summary, code, copyFull);

    banner.append(label, short, copyShort, details);
    banner.hidden = false;
  }

  function stop() {
    if (ws) { try { ws.close(); } catch { } ws = null; }
    state = 'idle';
    setUi();
  }

  function start(sessionId, token) {
    state = 'connecting';
    setUi();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}${RELAY_PATH}`);

    ws.onopen = () => ws.send(JSON.stringify({ role: 'tab', session: sessionId, token }));

    ws.onmessage = async (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'registered') {
        state = m.agentConnected ? 'live' : 'waiting';
        showBanner(sessionId, token);
        setUi();
        return;
      }
      if (m.type === 'refused') { console.error('pair refused:', m.reason); stop(); return; }
      if (m.type === 'agent-joined' || m.type === 'tab-back') { state = 'live'; setUi(); return; }
      if (m.type === 'agent-gone') { state = 'waiting'; setUi(); return; }
      if (m.type === 'tool' && m.id !== undefined) {
        let result;
        try {
          const fn = api[m.name];
          result = fn ? await fn(m.args ?? {}) : { error: `unknown tool '${m.name}'` };
        } catch (e) {
          result = { error: String(e?.message ?? e) };
        }
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: m.id, result }));
      }
    };

    ws.onclose = () => { if (state !== 'idle') { state = 'idle'; setUi(); } };
    ws.onerror = () => { console.error('pair: relay unreachable'); stop(); };
  }

  btn.addEventListener('click', () => {
    if (state === 'idle') start(`rr-${rand(6)}`, rand(12));
    else stop();
  });

  // #pair=session:token — auto-pair (tests, and reconnect-by-link)
  const h = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (h?.includes(':')) {
    const [sessionId, token] = h.split(':');
    if (sessionId && token?.length >= 6) start(sessionId, token);
  }
}
