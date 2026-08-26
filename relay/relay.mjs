#!/usr/bin/env node
/* ReRun pair relay — a dumb, token-gated message pipe between one ReRun
 * browser tab (the kernel) and one agent (the MCP bridge).
 *
 * First frame on any connection registers it:
 *   {role: "tab",   session, token}   — the tab claims a session
 *   {role: "agent", session, token}   — an agent joins it (token must match)
 *
 * After that, frames are opaque JSON piped agent → tab and tab → agent.
 * The relay never inspects payloads. One tab + one agent per session; a
 * reconnecting tab replaces the old one; when a side drops, the other gets
 * {type: "tab-gone"} / {type: "agent-gone"}. Sessions die with their tab
 * (grace: 60 s for refresh). Nothing is persisted.
 *
 * systemd: rerun-pair-relay.service · Caddy: handle /rerun/pair* → :8095
 */

import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8095);
const MAX_FRAME = 4 * 1024 * 1024; // apply batches with figures stay well under
const sessions = new Map(); // name -> {token, tab, agent, reapTimer}

const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_FRAME });
console.log(`rerun-pair relay on :${PORT}`);

/* Keepalive: without traffic, an idle pairing connection is dropped by the
 * proxy in front of us (Cloudflare's WebSocket idle timeout is ~100 s), which
 * looked like the session "rebooting after a few minutes" (issue #4). Ping
 * every 30 s and terminate only a peer that misses a full interval's pong —
 * WS ping/pong are control frames the proxy counts as activity, and both the
 * browser tab and the Node bridge auto-answer pings at the protocol level, so
 * no client change is needed. Well under the ~100 s proxy window. */
const HEARTBEAT_MS = 30_000;
function heartbeat() { this.isAlive = true; }
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch { } continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { }
  }
}, HEARTBEAT_MS);
heartbeatTimer.unref?.();
wss.on('close', () => clearInterval(heartbeatTimer));

wss.on('connection', (ws) => {
  let me = null; // {session, role}
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (!me) { // registration frame
      const { role, session, token } = msg;
      if (!/^[\w-]{1,64}$/.test(String(session ?? '')) || typeof token !== 'string' || token.length < 6) {
        ws.send(JSON.stringify({ type: 'refused', reason: 'bad session or token' }));
        return ws.close();
      }
      if (role === 'tab') {
        let s = sessions.get(session);
        if (s && s.token !== token) {
          ws.send(JSON.stringify({ type: 'refused', reason: 'session name taken' }));
          return ws.close();
        }
        if (!s) { s = { token, tab: null, agent: null, reapTimer: null }; sessions.set(session, s); }
        clearTimeout(s.reapTimer);
        if (s.tab) try { s.tab.close(); } catch { }
        s.tab = ws;
        me = { session, role };
        ws.send(JSON.stringify({ type: 'registered', role, agentConnected: !!s.agent }));
        if (s.agent) s.agent.send(JSON.stringify({ type: 'tab-back' }));
      } else if (role === 'agent') {
        const s = sessions.get(session);
        if (!s || s.token !== token) {
          ws.send(JSON.stringify({ type: 'refused', reason: 'no such session (is the tab open and paired?)' }));
          return ws.close();
        }
        if (s.agent) try { s.agent.close(); } catch { }
        s.agent = ws;
        me = { session, role };
        ws.send(JSON.stringify({ type: 'registered', role, tabConnected: !!s.tab }));
        if (s.tab) s.tab.send(JSON.stringify({ type: 'agent-joined' }));
      } else {
        ws.close();
      }
      return;
    }

    // piping
    const s = sessions.get(me.session);
    if (!s) return;
    const peer = me.role === 'agent' ? s.tab : s.agent;
    if (peer && peer.readyState === peer.OPEN) peer.send(data.toString());
  });

  ws.on('close', () => {
    if (!me) return;
    const s = sessions.get(me.session);
    if (!s) return;
    if (me.role === 'tab' && s.tab === ws) {
      s.tab = null;
      if (s.agent) s.agent.send(JSON.stringify({ type: 'tab-gone' }));
      s.reapTimer = setTimeout(() => { // grace for a refresh
        if (!s.tab) {
          if (s.agent) try { s.agent.close(); } catch { }
          sessions.delete(me.session);
        }
      }, 60_000);
    } else if (me.role === 'agent' && s.agent === ws) {
      s.agent = null;
      if (s.tab) s.tab.send(JSON.stringify({ type: 'agent-gone' }));
    }
  });

  ws.on('error', () => { try { ws.close(); } catch { } });
});
