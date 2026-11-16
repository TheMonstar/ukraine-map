// Capture Mala Tokmachka: online play over WebRTC (PeerJS), protocol v1.
// The host runs the only simulation; guests send commands and draw the host's
// snapshots. PeerJS's public broker only introduces the browsers; game traffic
// then goes peer to peer. PeerJS is loaded on demand, so single-player never
// touches the network. The pin below must match index.html's tag (a test checks).

import { FACTIONS } from './sim.js';

export const PEERJS = {
    src: 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
    integrity: 'sha384-nlUQ8ZqCbvStErob+biJNzSgltf6urV3VGqhfIfzhmg9RXmpeRm76ELw0pYnKlTR',
};
export const PROTOCOL = 1;
export const GUEST_TIMEOUT = 8000;   // ms without a message before a guest's seat goes back to the AI
export const HOST_TIMEOUT = 6000;    // ms without a snapshot before a guest gives up

let loading = null;
export function loadPeerJs() {
    if (globalThis.Peer) return Promise.resolve(globalThis.Peer);
    if (!loading) {
        loading = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = PEERJS.src;
            s.integrity = PEERJS.integrity;
            s.crossOrigin = 'anonymous';
            s.onload = () => (globalThis.Peer ? resolve(globalThis.Peer) : reject(new Error('PeerJS did not load')));
            s.onerror = () => { loading = null; reject(new Error('Could not load PeerJS')); };
            document.head.appendChild(s);
        });
    }
    return loading;
}

const fIdx = f => FACTIONS.indexOf(f);
const fOf = i => (i >= 0 ? FACTIONS[i] : null);
const r1 = x => Math.round(x * 10) / 10;

/** Compact snapshot of the host's state; `speeds` maps a column to its current m/s. */
export function encodeSnapshot(st, speedOf) {
    const b = [];
    for (const x of st.blocks) b.push(fIdx(x.owner), r1(x.troops), x.lv[0], x.lv[1], x.lv[2]);
    const g = [];
    for (const x of st.groups) g.push(x.id, fIdx(x.f), x.from, x.to, r1(x.n), r1(x.d), r1(speedOf(x)));
    return {
        t: 'snap', time: r1(st.t), b, g,
        mud: r1(Math.max(0, st.mudUntil - st.t)),
        hold: st.hold ? [fIdx(st.hold.f), r1(st.hold.since)] : null,
        win: fIdx(st.winner), why: st.winReason,
        rally: FACTIONS.map(f => st.rally?.[f] ?? -1),
        log: st.log.slice(-20),
    };
}

/** Rebuild a drawable state from a snapshot (the guest's mirror). */
export function applySnapshot(snap, mirror = null) {
    const blocks = [];
    for (let i = 0; i < snap.b.length; i += 5) {
        blocks.push({ id: i / 5, owner: fOf(snap.b[i]), troops: snap.b[i + 1], lv: [snap.b[i + 2], snap.b[i + 3], snap.b[i + 4]] });
    }
    const groups = [];
    for (let i = 0; i < snap.g.length; i += 7) {
        groups.push({ id: snap.g[i], f: fOf(snap.g[i + 1]), from: snap.g[i + 2], to: snap.g[i + 3], n: snap.g[i + 4], d: snap.g[i + 5], v: snap.g[i + 6] });
    }
    const log = mirror ? mirror.log : [];
    const last = log.length ? log[log.length - 1].seq : 0;
    for (const e of snap.log || []) if (e.seq > last) log.push(e);
    if (log.length > 200) log.splice(0, log.length - 200);
    return {
        t: snap.time, blocks, groups, log,
        mudUntil: snap.time + snap.mud,
        hold: snap.hold ? { f: fOf(snap.hold[0]), since: snap.hold[1] } : null,
        winner: fOf(snap.win), winReason: snap.why || null,
        rally: Object.fromEntries(FACTIONS.map((f, i) => [f, snap.rally && snap.rally[i] >= 0 ? snap.rally[i] : null])),
    };
}

/** A guest's command, checked for shape before the sim sees it. */
export function cleanCommand(cmd, nBlocks) {
    if (!cmd || typeof cmd !== 'object') return null;
    const id = v => (Number.isInteger(v) && v >= 0 && v < nBlocks ? v : null);
    if (cmd.type === 'send') {
        const from = Array.isArray(cmd.from) ? cmd.from.slice(0, nBlocks).map(id) : [];
        const to = id(cmd.to), frac = Number(cmd.frac);
        if (!from.length || from.includes(null) || to == null || !(frac >= 0.05 && frac <= 1)) return null;
        return { type: 'send', from, to, frac };
    }
    if (cmd.type === 'rally') {
        if (cmd.block === null) return { type: 'rally', block: null };
        const block = id(cmd.block);
        return block == null ? null : { type: 'rally', block };
    }
    if (cmd.type === 'upgrade') {
        const block = id(cmd.block);
        if (block == null || ![0, 1, 2].includes(cmd.track)) return null;
        return { type: 'upgrade', block, track: cmd.track };
    }
    return null;
}

export const cleanName = s => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24) || 'Guest';

export function inviteLink(peerId) {
    const u = new URL(location.href);
    u.searchParams.set('game', 'capture');
    u.hash = `join=${encodeURIComponent(peerId)}`;
    return u.toString();
}

/** Host side: accepts guests, relays their messages. */
export class HostNet {
    constructor(handlers) {
        this.h = handlers;      // {onOpen(id), onHello(conn, msg), onCmd(conn, cmd), onLeave(conn), onError(text)}
        this.conns = new Set();
        this.lastSeen = new Map();
    }

    /** `id`: reclaim this address after a reload, so the invite link and the guests still find us. */
    async start(id = null) {
        this.Peer = await loadPeerJs();
        this.wantId = id;
        this.idTries = 0;
        this._open();
        this.timer = setInterval(() => {
            const now = Date.now();
            for (const c of this.conns) if (now - (this.lastSeen.get(c) || 0) > GUEST_TIMEOUT) this._drop(c);
        }, 1000);
    }

    _open() {
        const peer = this.wantId ? new this.Peer(this.wantId) : new this.Peer();
        this.peer = peer;
        peer.on('open', id => {
            this.id = id;
            this.h.onOpen(id);
        });
        peer.on('connection', conn => {
            conn.on('open', () => {
                this.conns.add(conn);
                this.lastSeen.set(conn, Date.now());
            });
            conn.on('data', msg => {
                this.lastSeen.set(conn, Date.now());
                if (!msg || typeof msg !== 'object') return;
                if (msg.t === 'hello') {
                    if (msg.v !== PROTOCOL) return this.send(conn, { t: 'reject', reason: 'Different game version: reload both pages.' });
                    this.h.onHello(conn, msg);
                } else if (msg.t === 'cmd') {
                    this.h.onCmd(conn, msg.cmd);
                }
            });
            conn.on('close', () => this._drop(conn));
            conn.on('error', () => this._drop(conn));
        });
        peer.on('disconnected', () => { if (!this.closed && !peer.destroyed) peer.reconnect(); });
        peer.on('error', err => {
            // right after a reload the broker may still hold our old address: wait for it to free up
            if (err.type === 'unavailable-id' && this.wantId && ++this.idTries < 20) {
                peer.destroy();
                setTimeout(() => { if (!this.closed) this._open(); }, 2000);
                return;
            }
            this.h.onError(`Online play: ${err.type || err.message}`);
        });
    }

    _drop(conn) {
        if (!this.conns.has(conn)) return;
        this.conns.delete(conn);
        this.lastSeen.delete(conn);
        try { conn.close(); } catch { /* already gone */ }
        this.h.onLeave(conn);
    }

    /** Forget a connection without telling the game (a player came back on a new one). */
    forget(conn) {
        this.conns.delete(conn);
        this.lastSeen.delete(conn);
        try { conn.close(); } catch { /* already gone */ }
    }

    send(conn, msg) {
        if (conn.open) conn.send(msg);
    }

    broadcast(msg) {
        for (const c of this.conns) this.send(c, msg);
    }

    close() {
        this.closed = true;
        clearInterval(this.timer);
        this.peer?.destroy();
    }
}

export const RECONNECT_FOR = 60000;  // ms a guest keeps trying to reach a host it lost

/**
 * Guest side: one connection to the host. A drop (the host reloading, a network blip) is
 * not the end: it keeps reconnecting for RECONNECT_FOR and says hello again with the same
 * token, so the host gives back the same seat.
 */
export class GuestNet {
    constructor(hostId, handlers) {
        this.hostId = hostId;
        this.h = handlers;      // {onMessage(msg), onLost(text), onReconnecting(secondsLeft | null)}
    }

    async start(hello) {
        this.hello = hello;
        this.Peer = await loadPeerJs();
        this._open();
        this.ping = setInterval(() => {
            if (this.conn?.open) this.conn.send({ t: 'ping' });
            if (this.everConnected && !this.retryUntil && Date.now() - this.lastSnap > HOST_TIMEOUT) this._retry();
        }, 2000);
    }

    _open() {
        const peer = new this.Peer();
        this.peer = peer;
        peer.on('open', () => this._connect());
        peer.on('disconnected', () => { if (!this.gone && !peer.destroyed) peer.reconnect(); });
        peer.on('error', err => {
            if (this.everConnected) return this._retry();
            this._lost(err.type === 'peer-unavailable'
                ? 'That game is over or the link is wrong.' : `Online play: ${err.type || err.message}`);
        });
    }

    _connect() {
        const conn = this.peer.connect(this.hostId, { reliable: true });
        this.conn = conn;
        conn.on('open', () => {
            if (conn !== this.conn) return;
            this.everConnected = true;
            this.lastSnap = Date.now();
            if (this.retryUntil) {
                this.retryUntil = null;
                this.h.onReconnecting?.(null);
            }
            conn.send({ t: 'hello', v: PROTOCOL, ...this.hello });
        });
        conn.on('data', msg => {
            if (conn !== this.conn || !msg || typeof msg !== 'object') return;
            if (msg.t === 'snap' || msg.t === 'lobby' || msg.t === 'welcome') this.lastSnap = Date.now();
            this.h.onMessage(msg);
        });
        conn.on('close', () => { if (conn === this.conn) this._retry(); });
    }

    _retry() {
        if (this.gone || !this.everConnected) return;
        if (!this.retryUntil) this.retryUntil = Date.now() + RECONNECT_FOR;
        const left = this.retryUntil - Date.now();
        if (left <= 0) return this._lost('The host left the game.');
        this.h.onReconnecting?.(Math.ceil(left / 1000));
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
            if (this.gone) return;
            const old = this.conn;
            this.conn = null;
            try { old?.close(); } catch { /* already gone */ }
            if (this.peer.destroyed) this._open();
            else this._connect();
            clearTimeout(this._retryCheck);
            this._retryCheck = setTimeout(() => { if (!this.conn?.open) this._retry(); }, 4000);
        }, 3000);
    }

    _lost(text) {
        if (this.gone) return;
        this.gone = true;
        clearInterval(this.ping);
        clearTimeout(this.retryTimer);
        clearTimeout(this._retryCheck);
        this.h.onLost(text);
    }

    send(cmd) {
        if (this.conn?.open) this.conn.send({ t: 'cmd', cmd });
    }

    close() {
        this.gone = true;
        clearInterval(this.ping);
        clearTimeout(this.retryTimer);
        clearTimeout(this._retryCheck);
        this.peer?.destroy();
    }
}
