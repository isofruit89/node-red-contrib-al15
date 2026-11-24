"use strict";
/**
 * Minimal JSON-RPC style client for the ifm IoT-Core (AL15xx).
 * Uses a keep-alive agent so that high-frequency polling (20 ms class)
 * does not open a new TCP connection per request.
 */
const http = require("http");
const https = require("https");

const DEFAULT_URL = "http://127.0.0.1:8090";

class TransportError extends Error {
    constructor(message, kind) {
        super(message);
        this.name = "TransportError";
        this.kind = kind || "transport"; // "timeout" | "transport" | "protocol"
    }
}

class Client {
    constructor(o = {}) {
        const url = new URL(String(o.baseUrl || DEFAULT_URL).trim().replace(/\/+$/, "") || DEFAULT_URL);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported protocol ${url.protocol}`);
        this.url = url;
        this.baseUrl = url.toString().replace(/\/+$/, "");
        this.username = o.username || "";
        this.password = o.password || "";
        this.timeout = Math.max(100, Number(o.timeout) || 2000);
        this.verifyTls = o.verifyTls === true;
        this.cid = 1;
        this.transport = url.protocol === "https:" ? https : http;
        this.agent = new this.transport.Agent({ keepAlive: true, maxSockets: 4 });
    }

    auth() {
        if (!this.username && !this.password) return undefined;
        return {
            user: Buffer.from(this.username).toString("base64"),
            passwd: Buffer.from(this.password).toString("base64")
        };
    }

    request(adr, data, timeout) {
        const payload = { code: "request", cid: this.cid++, adr };
        const auth = this.auth();
        if (auth) payload.auth = auth;
        if (data !== undefined) payload.data = data;
        const body = JSON.stringify(payload);
        const options = {
            protocol: this.url.protocol,
            hostname: this.url.hostname,
            port: this.url.port || undefined,
            path: (this.url.pathname || "/") + this.url.search,
            method: "POST",
            agent: this.agent,
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
        };
        if (this.url.protocol === "https:") options.rejectUnauthorized = this.verifyTls;
        const limit = Math.max(100, Number(timeout) || this.timeout);
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
            const req = this.transport.request(options, res => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", c => { text += c; });
                res.on("end", () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        return finish(reject, new TransportError(`AL15 HTTP error ${res.statusCode}`, "protocol"));
                    }
                    let parsed;
                    try { parsed = JSON.parse(text); } catch (_) {
                        return finish(reject, new TransportError(`AL15 returned non-JSON response (HTTP ${res.statusCode})`, "protocol"));
                    }
                    // Some firmware versions wrap the answer in lastResponse
                    if (parsed && parsed.lastResponse && typeof parsed.lastResponse === "object") parsed = parsed.lastResponse;
                    finish(resolve, parsed);
                });
                res.on("error", e => finish(reject, new TransportError(e.message)));
            });
            // Hard timeout over the whole request (socket timeout alone does not cover slow responses)
            const timer = setTimeout(() => {
                finish(reject, new TransportError(`AL15 request timed out after ${limit} ms`, "timeout"));
                req.destroy();
            }, limit);
            req.on("error", e => { const t = new TransportError(e.message); t.code = e.code; finish(reject, t); });
            req.end(body);
        });
    }

    getTree() { return this.request("/gettree"); }
    getDataMulti(paths) { return this.request("/getdatamulti", { datatosend: paths }); }
    getData(path) { return this.request(`${path}/getdata`); }
    setData(path, value, timeout) { return this.request(`${path}/setdata`, { newvalue: value }, timeout); }

    close() { try { this.agent.destroy(); } catch (_) { /* ignore */ } }
}

Client.DEFAULT_URL = DEFAULT_URL;
Client.TransportError = TransportError;
module.exports = Client;
