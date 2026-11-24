"use strict";

module.exports = function (RED) {
    const LEGACY_OUTPUT = { aliases: "object", paths: "object", array: "array" };

    function toPoint(x) {
        if (typeof x === "string") return { path: x, name: x.split("/").pop() };
        if (x && typeof x.path === "string") return { path: x.path, name: x.name || x.alias || x.path.split("/").pop() };
        return null;
    }

    function AL15GetDataNode(c) {
        RED.nodes.createNode(this, c);
        const node = this;
        const cfg = RED.nodes.getNode(c.connection);
        // v0.2.x stored "selections" with "alias"
        const configured = (Array.isArray(c.points) ? c.points : Array.isArray(c.selections) ? c.selections : []).map(toPoint).filter(Boolean);
        const cacheMode = c.cacheMode || "prefer-cache";
        const maxAge = Math.max(0, Number(c.maxAge) || 0) || 250;
        const outputMode = LEGACY_OUTPUT[c.outputMode] || c.outputMode || "auto";

        node.on("input", async (msg, send, done) => {
            try {
                if (!cfg || !cfg.core) throw new Error("No AL15 config selected");
                const legacy = msg.al15 && typeof msg.al15 === "object" ? msg.al15 : {};
                let dyn = msg.paths || msg.path || legacy.paths;
                if (dyn !== undefined && !Array.isArray(dyn)) dyn = [dyn];
                const points = dyn ? dyn.map(toPoint).filter(Boolean) : configured;
                if (!points.length) throw new Error("No AL15 data points selected");

                const force = cacheMode === "live" || msg.forceRefresh === true || legacy.forceRefresh === true;
                const age = Number.isFinite(Number(msg.maxAge)) ? Number(msg.maxAge) : maxAge;
                const values = await cfg.core.read([...new Set(points.map(p => p.path))], { force, maxAge: age, cacheOnly: cacheMode === "cache-only" && !force });

                const entries = points.map(p => {
                    const e = values.get(p.path) || {};
                    const r = { name: p.name, path: p.path, value: e.value, timestamp: e.timestamp || null };
                    if (e.error) { r.error = e.error; r.code = e.code; r.stale = true; }
                    return r;
                });
                const failed = entries.filter(e => e.error);
                if ([...values.values()].every(v => v && v.transportError)) {
                    throw new Error(`AL15 not reachable: ${failed[0].error}`);
                }

                if (outputMode === "auto" && entries.length === 1) {
                    const e = entries[0];
                    if (e.error) throw new Error(`${e.path}: ${e.error}`);
                    msg.payload = e.value; msg.name = e.name; msg.path = e.path; msg.timestamp = e.timestamp;
                } else if (outputMode === "object") {
                    msg.payload = {};
                    // unreadable points without a last valid value stay visible as null (see msg.errors)
                    entries.forEach(e => { msg.payload[e.name] = e.value === undefined ? null : e.value; });
                    if (failed.length) msg.errors = failed.map(e => ({ name: e.name, path: e.path, error: e.error, code: e.code }));
                } else {
                    msg.payload = entries;
                }
                node.status(failed.length
                    ? { fill: "yellow", shape: "ring", text: `${entries.length - failed.length}/${entries.length} ok` }
                    : { fill: "green", shape: "dot", text: `${entries.length} value${entries.length > 1 ? "s" : ""}` });
                send(msg);
                done();
            } catch (e) {
                node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 60) });
                done(e);
            }
        });
    }

    RED.nodes.registerType("al15-get-data", AL15GetDataNode);
};
