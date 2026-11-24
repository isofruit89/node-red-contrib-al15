"use strict";
/**
 * Small IoT-Core simulator for development and tests (not part of the package).
 *   node test/mock-iotcore.js [port]
 */
const http = require("http");

function svc(adr, names) { return names.map(n => ({ identifier: n, type: "service", adr: `${adr}/${n}` })); }
function data(adr, id, opts = {}) {
    return { identifier: id, type: "data", adr, format: opts.format, subs: [...svc(adr, opts.write ? (opts.read === false ? ["setdata"] : ["getdata", "setdata"]) : ["getdata"]), ...(opts.subs || [])] };
}
function struct(adr, id, subs) { return { identifier: id, type: "structure", adr, subs }; }

const PDOUT_LEN = { 1: 2, 2: 1, 3: 1, 4: 2 };

function createState() {
    const values = new Map();
    const pdoutReady = new Set(); // ports whose raw PDOut was written completely (lost on "reboot")
    const t0 = Date.now();
    const dyn = new Map();
    const ports = [];
    for (let p = 1; p <= 4; p++) {
        const b = `iolinkmaster/port[${p}]`;
        const dev = `${b}/iolinkdevice`;
        const pdi = `${dev}/pdin_interpreted/Process_Data_Input_Output`;
        const subsPd = p === 2 ? [
            data(`${pdi}/Temperature`, "Temperature", { format: { type: "number", encoding: "float" }, subs: [
                data(`${pdi}/Temperature/unit`, "unit", { format: { type: "string" } }),
                data(`${pdi}/Temperature/iodd_info`, "iodd_info", { format: { type: "string" } })] }),
            data(`${pdi}/Fatigue__v-RMS_`, "Fatigue__v-RMS_", { format: { type: "number", encoding: "float" } }),
            data(`${pdi}/Impact__a-Peak_`, "Impact__a-Peak_", { format: { type: "number", encoding: "integer" } }),
            data(`${pdi}/Device_status`, "Device_status", { format: { type: "number", encoding: "integer" } })
        ] : [];
        ports.push(struct(b, `port[${p}]`, [
            data(`${b}/mode`, "mode", { write: true, format: { type: "number", encoding: "integer", valuation: { valuelist: { 0: "disabled", 1: "DI", 2: "DO", 3: "IO-Link" } } } }),
            data(`${b}/comspeed`, "comspeed", { format: { type: "string" } }),
            data(`${b}/mastercycletime_actual`, "mastercycletime_actual", { format: { type: "number", encoding: "integer" } }),
            struct(dev, "iolinkdevice", [
                data(`${dev}/status`, "status", { format: { type: "number", encoding: "integer" } }),
                data(`${dev}/vendorid`, "vendorid", { format: { type: "number", encoding: "integer" } }),
                data(`${dev}/productname`, "productname", { format: { type: "string" } }),
                data(`${dev}/serial`, "serial", { format: { type: "string" } }),
                data(`${dev}/applicationspecifictag`, "applicationspecifictag", { write: true, format: { type: "string", valuation: { maxlength: 32 } } }),
                data(`${dev}/pdin`, "pdin", { format: { type: "string", encoding: "hexstring" } }),
                data(`${dev}/pdout`, "pdout", { write: true, format: p === 1 ? { type: "string", encoding: "hexstring", valuation: { maxlength: 2 } } : { type: "string", encoding: "hexstring" } }),
                struct(`${dev}/pdout_interpreted`, "pdout_interpreted", p === 4 ? [struct(`${dev}/pdout_interpreted/OnOffOut`, "OnOffOut",
                    [data(`${dev}/pdout_interpreted/OnOffOut/iodd_info`, "iodd_info", { format: { type: "object" } }),
                    ...["LED-a", "LED-b", "LED-c"].map(l => data(`${dev}/pdout_interpreted/OnOffOut/${l}`, l, { write: true, format: { valuation: { single_values: [{ value: true }, { value: false }] }, type: "boolean" } }))])] : []),
                struct(`${dev}/pdin_interpreted`, "pdin_interpreted", subsPd.length ? [struct(pdi, "Process_Data_Input_Output", subsPd)] : []),
                struct(`${dev}/iolreadacyclic`, "iolreadacyclic", [])
            ])
        ]));
        values.set(`/${b}/mode`, p <= 2 ? 3 : 0);
        values.set(`/${b}/comspeed`, "COM2");
        values.set(`/${b}/mastercycletime_actual`, 2300);
        values.set(`/${dev}/status`, p <= 2 ? 2 : 0);
        values.set(`/${dev}/vendorid`, 310);
        values.set(`/${dev}/productname`, p === 2 ? "VVB001" : "");
        values.set(`/${dev}/serial`, p === 2 ? "000008512993" : "");
        values.set(`/${dev}/applicationspecifictag`, "***");
        values.set(`/${dev}/pdin`, "0001");
        ["LED-a", "LED-b", "LED-c"].forEach(l => p === 4 && values.set(`/${dev}/pdout_interpreted/OnOffOut/${l}`, false));
        if (p === 4) values.set(`/${dev}/pdout_interpreted/OnOffOut/iodd_info`, { id: "OnOffModeOut", name: "OnOffOut", type: "record", bit_length: 16, subindex_access_supported: false });
    }
    const pdi = "/iolinkmaster/port[2]/iolinkdevice/pdin_interpreted/Process_Data_Input_Output";
    values.set(`${pdi}/Temperature/unit`, "°C");
    values.set(`${pdi}/Temperature/iodd_info`, "{\"subindex\":1}");
    dyn.set(`${pdi}/Temperature`, () => Math.round((42 + Math.sin((Date.now() - t0) / 5000) * 2) * 10) / 10);
    dyn.set(`${pdi}/Fatigue__v-RMS_`, () => Math.round(Math.random() * 3) / 10);
    dyn.set(`${pdi}/Impact__a-Peak_`, () => 30 + Math.floor((Date.now() - t0) / 3000) % 3);
    dyn.set(`${pdi}/Device_status`, () => 0);

    const tree = struct("", "AL1590", [
        struct("deviceinfo", "deviceinfo", [
            data("deviceinfo/productcode", "productcode", { format: { type: "string" } }),
            data("deviceinfo/serialnumber", "serialnumber", { format: { type: "string" } }),
            data("deviceinfo/swrevision", "swrevision", { format: { type: "string" } })
        ]),
        struct("devicetag", "devicetag", [
            data("devicetag/applicationtag", "applicationtag", { write: true, format: { type: "string", valuation: { maxlength: 32 } } })
        ]),
        struct("iolinkmaster", "iolinkmaster", [
            data("iolinkmaster/supervisionstatus", "supervisionstatus", { format: { type: "number", encoding: "integer" } }),
            data("iolinkmaster/voltage", "voltage", { format: { type: "number", encoding: "float" } }),
            ...ports
        ]),
        struct("timer", "timer", [data("timer/counter", "counter", { format: { type: "number", encoding: "integer" } })])
    ]);
    values.set("/deviceinfo/productcode", "AL1590");
    values.set("/deviceinfo/serialnumber", "000174210147");
    values.set("/deviceinfo/swrevision", "1.2.3");
    values.set("/devicetag/applicationtag", "line 1");
    values.set("/iolinkmaster/supervisionstatus", 0);
    values.set("/iolinkmaster/voltage", 24.1);
    dyn.set("/timer/counter", () => Math.floor((Date.now() - t0) / 100));
    return { tree, values, dyn, pdoutReady, reboot: () => pdoutReady.clear(), stats: { requests: 0, getdatamulti: 0, paths: 0 } };
}

function start(port, opts = {}) {
    const st = createState();
    const pdPort = p => { const m = p.match(/^\/iolinkmaster\/port\[(\d+)\]\/iolinkdevice\/pdout(_interpreted)?(\/|$)/); return m ? { port: Number(m[1]), interpreted: !!m[2] } : null; };
    const get = p => {
        const pd = pdPort(p);
        if (pd && !pd.interpreted && !st.pdoutReady.has(pd.port)) return { code: 530, msg: "Invalid process data" };
        return getValue(p);
    };
    const getValue = p => (st.dyn.has(p) ? { code: 200, data: st.dyn.get(p)() } : st.values.has(p) ? { code: 200, data: st.values.get(p) } : { code: 404 });
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", c => { body += c; });
        req.on("end", () => {
            st.stats.requests++;
            let r;
            try { r = JSON.parse(body); } catch (_) { res.writeHead(400); return res.end("bad json"); }
            const adr = r.adr || "";
            let out;
            if (adr === "/gettree") out = { code: 200, data: st.tree };
            else if (adr === "/getdatamulti") {
                st.stats.getdatamulti++;
                const d = {};
                (r.data && r.data.datatosend || []).forEach(p => { st.stats.paths++; d[p] = get(p); });
                out = { code: 200, data: d };
            } else if (adr.endsWith("/getdata") && pdPort(adr.slice(0, -8)) && !pdPort(adr.slice(0, -8)).interpreted) {
                const pd = pdPort(adr.slice(0, -8));
                out = st.pdoutReady.has(pd.port) ? { code: 200, data: { value: st.values.get(adr.slice(0, -8)) } } : { code: 530, msg: "Invalid process data", codeDetails: 530, msgDetails: "" };
            } else if (adr.endsWith("/setdata") && pdPort(adr.slice(0, -8))) {
                // raw PDOut must be written completely once; interpreted elements only work afterwards
                const p = adr.slice(0, -8), pd = pdPort(p), v = String(r.data && r.data.newvalue);
                st.stats.pdoutWrites = (st.stats.pdoutWrites || 0) + 1;
                if (!pd.interpreted) {
                    if (/^([0-9A-Fa-f]{2})+$/.test(v) && v.length === PDOUT_LEN[pd.port] * 2) { st.values.set(p, v.toUpperCase()); st.pdoutReady.add(pd.port); out = { code: 200 }; }
                    else out = { code: 500 };
                } else if (!st.pdoutReady.has(pd.port) || !st.values.has(p)) out = { code: 500 };
                else { st.values.set(p, r.data.newvalue); out = { code: 200 }; }
            } else if (adr.endsWith("/getdata")) {
                const g = get(adr.slice(0, -8));
                out = g.code === 200 ? { code: 200, data: { value: g.data } } : { code: g.code };
            } else if (adr.endsWith("/setdata")) {
                const p = adr.slice(0, -8);
                if (!st.values.has(p)) out = { code: 404 };
                else { st.values.set(p, r.data && r.data.newvalue); out = { code: 200 }; }
            } else out = { code: 400 };
            const send = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(Object.assign({ cid: r.cid }, out))); };
            if (opts.delay) setTimeout(send, opts.delay); else send();
        });
    });
    server.state = st;
    return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve(server)));
}

module.exports = { start };
if (require.main === module) {
    const port = Number(process.argv[2]) || 18090;
    start(port).then(() => console.log(`IoT-Core mock listening on http://127.0.0.1:${port}`));
}
