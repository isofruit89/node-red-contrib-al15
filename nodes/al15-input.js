"use strict";
const { hasChanged } = require("../lib/model");

module.exports = function (RED) {
    const MIN_INTERVAL = 20, DEFAULT_INTERVAL = 500;
    const LEGACY = { fast: 20, normal: 500, slow: 1000 }; // interval classes of 0.3.x

    /** polling interval in ms: free value >= 20 ms, legacy class names, default 500 ms */
    function ivOf(p) {
        if (LEGACY[p.interval]) return LEGACY[p.interval];
        if (p.interval === undefined || p.interval === null || p.interval === "") return DEFAULT_INTERVAL;
        const n = Math.round(Number(p.interval));
        if (!Number.isFinite(n)) return DEFAULT_INTERVAL;
        return Math.max(MIN_INTERVAL, n);
    }

    function AL15InputNode(c) {
        RED.nodes.createNode(this, c);
        const node = this;
        const cfg = RED.nodes.getNode(c.connection);
        const points = (Array.isArray(c.points) ? c.points : []).filter(p => p && p.path).map(p => ({
            path: p.path,
            name: p.name || p.path.split("/").pop(),
            interval: ivOf(p),
            deadband: Math.max(0, Number(p.deadband) || 0),
            init: false,
            last: undefined,
            entry: null
        }));
        const collect = c.outputMode === "collection";
        const unsubs = [];
        let failing = false;
        let lastStatus = 0;
        let changes = 0;

        const tooShort = (Array.isArray(c.points) ? c.points : []).filter(p => p && p.path && Number.isFinite(Number(p.interval)) && p.interval !== "" && p.interval !== null && Number(p.interval) < MIN_INTERVAL);
        if (tooShort.length) node.warn(`Interval below ${MIN_INTERVAL} ms raised to ${MIN_INTERVAL} ms: ${tooShort.map(p => p.name || p.path).join(", ")}`);

        if (!cfg || !cfg.core) { node.status({ fill: "red", shape: "ring", text: "no AL15 config" }); return; }
        if (!points.length) { node.status({ fill: "grey", shape: "ring", text: "no data points" }); return; }
        const core = cfg.core;
        node.status({ fill: "grey", shape: "dot", text: "initialising" });

        function status(force) {
            const now = Date.now();
            if (!force && now - lastStatus < 1000) return; // throttle for fast classes
            lastStatus = now;
            if (failing) return;
            node.status({ fill: "green", shape: "dot", text: `${points.length} values · ${changes} changes` });
        }

        function onPoll(byPath, group) {
            const changed = [];
            let errorText = null;
            for (const p of group) {
                const e = byPath.get(p.path);
                if (!e || e.error || e.stale) { errorText = errorText || (e && e.error) || "no value"; continue; }
                if (p.entry && p.entry.ts === e.ts) continue; // nothing new (served from cache)
                p.entry = e;
                if (!p.init) { p.init = true; p.last = e.value; continue; } // first read: initialise only
                if (hasChanged(p.last, e.value, p.deadband)) { p.last = e.value; changed.push(p); }
            }
            if (errorText && !failing) {
                failing = true;
                node.status({ fill: "yellow", shape: "ring", text: `stale: ${errorText}`.slice(0, 60) });
                node.error(`AL15 read failed, values are stale: ${errorText}`, { payload: null, error: errorText });
            } else if (!errorText && failing) {
                failing = false;
                status(true);
            }
            if (!changed.length) { status(false); return; }
            changes += changed.length;
            if (collect) {
                node.send({
                    payload: points.map(p => ({ name: p.name, path: p.path, value: p.last, timestamp: p.entry ? p.entry.timestamp : null })),
                    topic: c.topic || node.name || "al15"
                });
            } else {
                node.send([changed.map(p => ({ payload: p.last, name: p.name, path: p.path, timestamp: p.entry.timestamp, topic: p.name }))]);
            }
            status(false);
        }

        // one subscription per interval; identical paths are polled once per config node
        const byInterval = new Map();
        points.forEach(p => { if (!byInterval.has(p.interval)) byInterval.set(p.interval, []); byInterval.get(p.interval).push(p); });
        byInterval.forEach((group, iv) => {
            unsubs.push(core.subscribe(iv, [...new Set(group.map(p => p.path))], m => onPoll(m, group)));
        });

        node.on("close", done => { unsubs.forEach(u => u()); unsubs.length = 0; node.status({}); done(); });
    }

    RED.nodes.registerType("al15-input", AL15InputNode);
};
