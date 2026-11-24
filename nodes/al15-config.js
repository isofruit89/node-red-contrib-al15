"use strict";
const Core = require("../lib/core");
const Client = require("../lib/client");

module.exports = function (RED) {
    function AL15ConfigNode(c) {
        RED.nodes.createNode(this, c);
        const node = this;
        node.name = c.name;
        node.baseUrl = c.baseUrl || Client.DEFAULT_URL;
        node.core = new Core({
            baseUrl: node.baseUrl,
            timeout: c.timeout,
            verifyTls: c.verifyTls === true || c.verifyTls === "true",
            username: node.credentials && node.credentials.username,
            password: node.credentials && node.credentials.password
        });
        node.on("close", done => {
            node.core.close();
            done();
        });
    }

    RED.nodes.registerType("al15-config", AL15ConfigNode, {
        credentials: { username: { type: "text" }, password: { type: "password" } }
    });

    /**
     * Model endpoint for the editor.
     * Works with a deployed config node (credentials available) and also with a
     * not yet deployed one: the editor then passes the URL it currently has.
     */
    RED.httpAdmin.get("/al15/model", RED.auth.needsPermission("al15-config.read"), async (req, res) => {
        const force = req.query.refresh === "true";
        const cfg = req.query.config ? RED.nodes.getNode(String(req.query.config)) : null;
        const url = req.query.url ? String(req.query.url) : null;
        let client = null, temp = false;
        try {
            if (cfg && cfg.core && (!url || url.replace(/\/+$/, "") === cfg.core.client.baseUrl)) {
                client = cfg.core.client;
            } else {
                client = new Client({ baseUrl: url || Client.DEFAULT_URL, timeout: 10000 });
                temp = true;
            }
            const r = await Core.loadTree(client, force);
            res.json({ items: r.items, loadedAt: r.loadedAt, cached: r.cached, url: client.baseUrl, deployed: !temp });
        } catch (e) {
            res.status(502).json({ error: `AL15 not reachable (${client ? client.baseUrl : url}): ${e.message}` });
        } finally {
            if (temp && client) client.close();
        }
    });
};
