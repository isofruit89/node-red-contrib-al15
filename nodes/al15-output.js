"use strict";

module.exports = function (RED) {
    function AL15OutputNode(c) {
        RED.nodes.createNode(this, c);
        const node = this;
        const cfg = RED.nodes.getNode(c.connection);
        const points = (Array.isArray(c.points) ? c.points : []).filter(p => p && p.path)
            .map(p => ({ path: p.path, name: p.name || p.path.split("/").pop() }));
        const verify = c.verify === true || c.verify === "true";
        const timeout = Number(c.timeout) || undefined;
        const pdoutInit = c.pdoutInit !== false && c.pdoutInit !== "false"; // default on (also for nodes from 0.3.0)

        const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
        const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);

        /** value for target t from an object payload keyed by name or path, undefined if not contained */
        function pick(payload, t) {
            if (has(payload, t.name)) return { value: payload[t.name] };
            if (has(payload, t.path)) return { value: payload[t.path] };
            return undefined;
        }

        function jobsFor(msg) {
            const targets = typeof msg.path === "string" && msg.path
                ? [{ path: msg.path, name: msg.name || msg.path.split("/").pop() }]
                : points;
            if (!targets.length) throw new Error("No target selected and no msg.path given");
            // object keyed by target names/paths -> write exactly the contained targets (1..n targets)
            if (isObj(msg.payload)) {
                const jobs = targets.map(t => { const v = pick(msg.payload, t); return v && { ...t, value: v.value }; }).filter(Boolean);
                if (jobs.length) return jobs;
            }
            if (targets.length === 1) return [{ ...targets[0], value: msg.payload }];
            if (!isObj(msg.payload)) {
                throw new Error(`Several targets configured: msg.payload must be an object { ${targets.map(p => p.name).join(", ")} }`);
            }
            throw new Error(`msg.payload contains none of the configured names: ${targets.map(p => p.name).join(", ")} (got ${Object.keys(msg.payload).join(", ")})`);
        }

        node.on("input", async (msg, send, done) => {
            try {
                if (!cfg || !cfg.core) throw new Error("No AL15 config selected");
                const jobs = jobsFor(msg);
                node.status({ fill: "blue", shape: "dot", text: "writing" });
                const results = [];
                for (const j of jobs) { // sequential: defined order, no request burst
                    const r = await cfg.core.write(j.path, j.value, { verify, timeout, pdoutInit });
                    results.push(Object.assign({ name: j.name }, r));
                }
                const bad = results.filter(r => r.outcome !== "OK" || r.effective === false);
                msg.payload = results.length === 1 ? results[0] : results;
                if (!bad.length) node.status({ fill: "green", shape: "dot", text: `written${verify ? " + verified" : ""}` });
                else node.status({ fill: bad.some(r => r.outcome === "OUTCOME_UNKNOWN") ? "yellow" : "red", shape: "ring", text: `${bad[0].outcome}${bad[0].effective === false ? " (not effective)" : ""}` });
                send(msg);
                if (bad.length) {
                    const b = bad[0];
                    done(new Error(`${b.outcome}: ${b.name} (${b.path}): ${b.effective === false ? "read back value differs" : b.message}`));
                } else done();
            } catch (e) {
                node.status({ fill: "red", shape: "ring", text: e.message.slice(0, 60) });
                done(e);
            }
        });
    }

    RED.nodes.registerType("al15-output", AL15OutputNode);
};
