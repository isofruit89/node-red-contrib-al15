"use strict";
/**
 * Runtime core shared by all AL15 nodes of one configuration node:
 *  - IoT-Core model (gettree) cached in RAM
 *  - value cache (RAM only) with timestamps and stale flag
 *  - request coalescing: a path is never fetched twice at the same time
 *  - scheduler: subscriptions grouped by interval, one getdatamulti per group
 *    and tick, no overlapping requests, paths already polled by a faster
 *    group are served from the cache
 *  - validated writes (setdata) with separated outcome information
 */
const EventEmitter = require("events");
const Client = require("./client");
const { flattenTree, validateWrite, codeText, stable } = require("./model");

// Model cache shared per endpoint (survives redeploys, RAM only)
const treeStore = new Map();

function unwrapValue(d) {
    return d && typeof d === "object" && !Array.isArray(d) && Object.prototype.hasOwnProperty.call(d, "value") ? d.value : d;
}

/** device message of an IoT-Core answer: top-level "msg" or "data.msg" (getdatamulti / errors) */
function devMsg(r) {
    if (!r || typeof r !== "object") return undefined;
    if (typeof r.msg === "string") return r.msg;
    return r.data && typeof r.data === "object" && typeof r.data.msg === "string" ? r.data.msg : undefined;
}

/** "/iolinkmaster/port[4]/iolinkdevice" for a path below pdout_interpreted, otherwise null */
function pdoutBase(path) {
    const m = String(path).match(/^(\/iolinkmaster\/port\[\d+\]\/iolinkdevice)\/pdout_interpreted(\/|$)/);
    return m ? m[1] : null;
}

function sameValue(a, b) {
    if (stable(a) === stable(b)) return true;
    return (typeof a !== "object" && typeof b !== "object") && String(a) === String(b);
}

async function loadTree(client, force) {
    const key = client.baseUrl;
    let entry = treeStore.get(key);
    if (!force && entry && entry.items) return { items: entry.items, loadedAt: entry.loadedAt, cached: true };
    if (entry && entry.promise) return entry.promise;
    entry = entry || {};
    entry.promise = (async () => {
        try {
            const b = await client.getTree();
            if (!b || b.code !== 200 || !b.data) throw new Error(`gettree failed: ${b && b.code ? codeText(b.code, devMsg(b)) : "no data"}`);
            entry.items = flattenTree(b.data);
            entry.index = new Map(entry.items.map(i => [i.path, i]));
            entry.loadedAt = Date.now();
            return { items: entry.items, loadedAt: entry.loadedAt, cached: false };
        } finally {
            entry.promise = null;
        }
    })();
    treeStore.set(key, entry);
    return entry.promise;
}

class Core extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.setMaxListeners(0);
        this.client = new Client(opts);
        this.cache = new Map();      // path -> { value, ts, stale, code, error }
        this.pending = new Map();    // path -> Promise<Map>
        this.groups = new Map();     // interval -> group
        this.closed = false;
        this.state = { connected: null, error: null };
        this.pdoutReady = new Set();   // port bases whose raw PDOut has been initialised
        this.pdoutPending = new Map();
        this.pdoutLength = new Map();  // port base -> PDOut length in bytes (learned)
    }

    /* ---------------- model ---------------- */

    getTree(force) { return loadTree(this.client, force); }

    async findItem(path) {
        const e = treeStore.get(this.client.baseUrl);
        if (!e || !e.index) await this.getTree(false);
        return treeStore.get(this.client.baseUrl).index.get(path) || null;
    }

    /* ---------------- connection state ---------------- */

    _setState(connected, error) {
        const changed = this.state.connected !== connected || (error && this.state.error !== error);
        this.state = { connected, error: error || null };
        if (changed) this.emit("state", this.state);
    }

    /* ---------------- reading ---------------- */

    _entry(path, source) {
        const e = this.cache.get(path);
        if (!e) return { path, value: undefined, timestamp: null, stale: true, code: null, error: "No value available yet", source };
        return { path, value: e.value, timestamp: e.ts ? new Date(e.ts).toISOString() : null, ts: e.ts, stale: e.stale, code: e.code, error: e.error || null, source };
    }

    async _fetchBatch(paths) {
        const out = new Map();
        try {
            const b = await this.client.getDataMulti(paths);
            if (!b || typeof b !== "object") throw new Client.TransportError("Empty answer from AL15", "protocol");
            if (b.code !== 200 || !b.data) {
                const err = new Client.TransportError(`getdatamulti: ${codeText(b.code, devMsg(b))}`, "protocol");
                err.deviceCode = b.code;
                throw err;
            }
            const now = Date.now();
            for (const p of paths) {
                const r = b.data[p];
                const old = this.cache.get(p);
                if (r && r.code === 200) {
                    this.cache.set(p, { value: unwrapValue(r.data), ts: now, stale: false, code: 200, error: null });
                } else {
                    const code = r ? r.code : 404;
                    // functional error: keep last good value, mark as stale
                    this.cache.set(p, { value: old ? old.value : undefined, ts: old ? old.ts : null, stale: true, code, error: codeText(code, devMsg(r)) });
                }
                out.set(p, this._entry(p, "device"));
            }
            this._setState(true);
        } catch (e) {
            for (const p of paths) {
                const old = this.cache.get(p);
                if (old) { old.stale = true; old.error = e.message; }
                const r = this._entry(p, "device");
                r.stale = true;
                r.error = e.message;
                r.transportError = true;
                out.set(p, r);
            }
            this._setState(false, e.message);
        }
        return out;
    }

    /** Fetch paths live, joining requests that are already in flight. Never rejects. */
    async fetch(paths) {
        const waits = new Set();
        const fresh = [];
        for (const p of paths) {
            if (this.pending.has(p)) waits.add(this.pending.get(p));
            else fresh.push(p);
        }
        if (fresh.length) {
            const pr = this._fetchBatch(fresh);
            fresh.forEach(p => this.pending.set(p, pr));
            pr.then(() => fresh.forEach(p => { if (this.pending.get(p) === pr) this.pending.delete(p); }));
            waits.add(pr);
        }
        const maps = await Promise.all([...waits]);
        const out = new Map();
        for (const p of paths) {
            const m = maps.find(x => x.has(p));
            out.set(p, m ? m.get(p) : this._entry(p, "cache"));
        }
        return out;
    }

    /**
     * Read with cache policy.
     * @param {string[]} paths
     * @param {{maxAge?:number, force?:boolean, cacheOnly?:boolean}} opt
     * @returns {Promise<Map<string,object>>}
     */
    async read(paths, opt = {}) {
        const maxAge = Number.isFinite(Number(opt.maxAge)) ? Number(opt.maxAge) : 250;
        const now = Date.now();
        const out = new Map();
        const need = [];
        for (const p of paths) {
            const e = this.cache.get(p);
            if (opt.cacheOnly) out.set(p, this._entry(p, "cache"));
            else if (!opt.force && e && !e.stale && e.ts && now - e.ts <= maxAge) out.set(p, this._entry(p, "cache"));
            else need.push(p);
        }
        if (need.length) {
            const live = await this.fetch(need);
            live.forEach((v, k) => out.set(k, v));
        }
        return new Map(paths.map(p => [p, out.get(p)]));
    }

    /* ---------------- scheduler ---------------- */

    /**
     * Subscribe a set of paths at an interval. The listener receives a Map
     * path -> entry after every poll of that interval group.
     * Returns an unsubscribe function.
     */
    subscribe(interval, paths, listener) {
        const iv = Math.max(10, Number(interval) || 500);
        let g = this.groups.get(iv);
        if (!g) {
            g = { interval: iv, refs: new Map(), listeners: new Set(), timer: null, running: false, stopped: false };
            this.groups.set(iv, g);
        }
        paths.forEach(p => g.refs.set(p, (g.refs.get(p) || 0) + 1));
        const sub = { paths: [...new Set(paths)], listener };
        g.listeners.add(sub);
        if (!g.timer && !g.running) g.timer = setTimeout(() => this._tick(g), 0);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            g.listeners.delete(sub);
            paths.forEach(p => {
                const c = (g.refs.get(p) || 1) - 1;
                if (c <= 0) g.refs.delete(p); else g.refs.set(p, c);
            });
            if (!g.listeners.size) {
                g.stopped = true;
                clearTimeout(g.timer);
                g.timer = null;
                if (this.groups.get(iv) === g) this.groups.delete(iv);
            }
        };
    }

    async _tick(g) {
        g.timer = null;
        if (this.closed || g.stopped) return;
        g.running = true;
        const start = Date.now();
        try {
            const faster = [...this.groups.values()].filter(x => x !== g && x.interval < g.interval && !x.stopped);
            const own = [...g.refs.keys()].filter(p => !faster.some(f => f.refs.has(p)));
            const res = own.length ? await this.fetch(own) : new Map();
            if (this.closed || g.stopped) return;
            for (const sub of [...g.listeners]) {
                const m = new Map(sub.paths.map(p => [p, res.get(p) || this._entry(p, "cache")]));
                try { sub.listener(m); } catch (e) { this.emit("error-listener", e); }
            }
        } finally {
            g.running = false;
            if (!this.closed && !g.stopped) {
                // fixed-rate scheduling without overlap: if a request took longer
                // than the interval the next one starts right away, never in parallel
                g.timer = setTimeout(() => this._tick(g), Math.max(0, g.interval - (Date.now() - start)));
            }
        }
    }

    /* ---------------- writing ---------------- */

    async _send(path, value, timeout) {
        try {
            const b = await this.client.setData(path, value, timeout);
            this._setState(true);
            return b;
        } catch (e) {
            this._setState(false, e.message);
            throw e;
        }
    }

    /**
     * Makes sure the raw PDOut of a port has been written completely once.
     * The PDOut length depends on the IO-Link device (1..32 bytes), so it is determined per port:
     *  1. read the current raw PDOut and write it back unchanged (outputs keep their state)
     *  2. zeros with the length known from an earlier initialisation of this port
     *  3. zeros with the length from the IODD: bit_length in pdout_interpreted/<record>/iodd_info
     *  4. zeros with the length from the IoT-Core model (format.valuation), if available
     *  5. probe: zeros with 1..32 bytes, the first length the device accepts wins
     *     (a write with the wrong length is rejected by the device and has no effect)
     * Returns "written-back" | "zeros" | "iodd" | "probed" when initialised, null if already done.
     */
    /** PDOut length in bytes from the IODD description (bit_length of the process data record/variable) */
    async _pdoutBytesFromIodd(base, hintPath) {
        const cands = [];
        const m = hintPath && hintPath.slice(base.length).match(/^\/pdout_interpreted\/([^/]+)/);
        if (m) cands.push(`${base}/pdout_interpreted/${m[1]}/iodd_info`);
        cands.push(`${base}/pdout_interpreted/iodd_info`);
        for (const p of cands) {
            try {
                const r = await this.client.getData(p);
                const info = r && r.code === 200 ? unwrapValue(r.data) : null;
                const bits = info && Number(info.bit_length);
                if (bits > 0 && bits <= 256) return Math.ceil(bits / 8);
            } catch (_) { /* next candidate */ }
        }
        return null;
    }

    async _ensurePdout(base, opt, force, hintPath) {
        if (!force && this.pdoutReady.has(base)) return null;
        if (this.pdoutPending.has(base)) return this.pdoutPending.get(base);
        const raw = `${base}/pdout`;
        const ok = w => w && w.code >= 200 && w.code < 300;
        const pr = (async () => {
            const tried = new Set();
            const attempt = async (hex, how) => {
                if (!hex || tried.has(hex.length)) return null;
                tried.add(hex.length);
                const w = await this._send(raw, hex, opt.timeout); // transport errors abort the initialisation
                if (!ok(w)) return null;
                this.cache.delete(raw);
                this.pdoutReady.add(base);
                this.pdoutLength.set(base, hex.length / 2);
                return how;
            };
            let current = null;
            try {
                const r = await this.client.getData(raw);
                const val = r && r.code === 200 ? unwrapValue(r.data) : null;
                if (typeof val === "string" && /^([0-9a-fA-F]{2}){1,32}$/.test(val)) current = val.toUpperCase();
            } catch (_) { /* fall back below */ }
            let how = await attempt(current, "written-back");
            if (!how && this.pdoutLength.has(base)) how = await attempt("00".repeat(this.pdoutLength.get(base)), "zeros");
            if (!how) {
                const bytes = await this._pdoutBytesFromIodd(base, hintPath);
                if (bytes) how = await attempt("00".repeat(bytes), "iodd");
            }
            if (!how) {
                let item = null;
                try { item = await this.findItem(raw); } catch (_) { /* ignore */ }
                const val = item && item.format && item.format.valuation || {};
                const bytes = Number(val.maxlength || val.length);
                if (bytes >= 1 && bytes <= 32) how = await attempt("00".repeat(bytes), "zeros");
            }
            for (let n = 1; !how && n <= 32; n++) how = await attempt("00".repeat(n), "probed");
            if (!how) {
                const err = new Error(`PDOut of ${base} could not be initialised (no length 1..32 bytes accepted)`);
                err.deviceCode = 500;
                throw err;
            }
            return how;
        })();
        this.pdoutPending.set(base, pr);
        try { return await pr; } finally { this.pdoutPending.delete(base); }
    }

    async write(path, value, opt = {}) {
        const res = { path, value, outcome: null, transport: null, accepted: null, effective: null, persistence: null, code: null, message: null };
        let item;
        try {
            item = await this.findItem(path);
        } catch (e) {
            return Object.assign(res, { outcome: "FAILED", transport: "failed", message: `Model not available: ${e.message}` });
        }
        const v = validateWrite(item, value);
        if (!v.ok) return Object.assign(res, { outcome: "INVALID", message: v.error });
        res.value = v.value;

        // pdout_interpreted only changes a part of the raw PDOut. The raw PDOut must
        // have been written completely once (after every reboot) before that works.
        const pdBase = opt.pdoutInit !== false ? pdoutBase(path) : null;
        if (pdBase) {
            try {
                res.pdoutInit = await this._ensurePdout(pdBase, opt, false, path);
            } catch (e) {
                return Object.assign(res, { outcome: "FAILED", transport: e.kind === "timeout" ? "timeout" : (e.deviceCode ? "ok" : "failed"), accepted: false, code: e.deviceCode || null, message: e.message });
            }
        }

        let b;
        try {
            b = await this._send(path, v.value, opt.timeout);
            // Rejected (not executed) -> PDOut may have been reset (reboot, device re-plugged):
            // initialise again and repeat this write exactly once.
            if (pdBase && !(b && b.code >= 200 && b.code < 300)) {
                let init = null;
                try { init = await this._ensurePdout(pdBase, opt, true, path); } catch (_) { /* keep first answer */ }
                if (init) {
                    res.pdoutInit = init;
                    res.retried = true;
                    b = await this._send(path, v.value, opt.timeout);
                }
            }
        } catch (e) {
            this.cache.delete(path);
            const notSent = ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"].includes(e.code);
            if (notSent) return Object.assign(res, { outcome: "FAILED", transport: "failed", accepted: false, message: e.message });
            // request may have reached the device: result is not known, no automatic retry
            return Object.assign(res, { outcome: "OUTCOME_UNKNOWN", transport: e.kind === "timeout" ? "timeout" : "failed", message: e.message });
        }
        this.cache.delete(path);
        res.transport = "ok";
        res.code = b && b.code;
        res.message = codeText(res.code, devMsg(b));
        if (!(res.code >= 200 && res.code < 300)) {
            if (pdBase && !res.retried) res.message += " (PDOut initialisation was not possible)";
            return Object.assign(res, { outcome: "REJECTED", accepted: false });
        }
        res.accepted = true;
        res.outcome = "OK";
        if (res.code === 230) res.persistence = "reboot_required";

        if (opt.verify && item.readable) {
            const r = (await this.fetch([path])).get(path);
            res.effective = r && !r.error ? sameValue(r.value, v.value) : null;
            res.readback = r ? r.value : undefined;
        }
        return res;
    }

    close() {
        this.closed = true;
        for (const g of this.groups.values()) { g.stopped = true; clearTimeout(g.timer); }
        this.groups.clear();
        this.removeAllListeners();
        this.client.close();
    }
}

Core.loadTree = loadTree;
module.exports = Core;
