"use strict";
/* Minimal test runner (no dependencies): node test/run.js */
const assert = require("assert");
const mock = require("./mock-iotcore");
const Core = require("../lib/core");
const { flattenTree, hasChanged, validateWrite } = require("../lib/model");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 18391;
const URL = `http://127.0.0.1:${PORT}`;
const PD = "/iolinkmaster/port[2]/iolinkdevice/pdin_interpreted/Process_Data_Input_Output";
let server;

test("flattenTree categorises and flags nested attributes", async () => {
    const core = new Core({ baseUrl: URL });
    const { items } = await core.getTree(true);
    const by = p => items.find(i => i.path === p);
    assert.strictEqual(by(`${PD}/Temperature`).cat, "pdin");
    assert.strictEqual(by(`${PD}/Temperature`).port, 2);
    assert.strictEqual(by(`${PD}/Temperature`).nested, false);
    assert.strictEqual(by(`${PD}/Temperature/unit`).nested, true);
    assert.strictEqual(by(`${PD}/Temperature/unit`).parent, "Temperature");
    assert.strictEqual(by("/iolinkmaster/port[1]/mode").cat, "port");
    assert.strictEqual(by("/iolinkmaster/port[1]/mode").writable, true);
    assert.strictEqual(by("/iolinkmaster/port[1]/iolinkdevice/serial").cat, "device");
    assert.strictEqual(by("/iolinkmaster/port[1]/iolinkdevice/pdout").cat, "pdout");
    assert.strictEqual(by("/iolinkmaster/voltage").area, "master");
    assert.strictEqual(by("/deviceinfo/serialnumber").area, "system");
    assert.ok(by(`${PD}/Temperature`).group.includes("Process_Data_Input_Output"));
    core.close();
});

test("hasChanged: deadband and deterministic compare", () => {
    assert.strictEqual(hasChanged(1, 1.05, 0.1), false);
    assert.strictEqual(hasChanged(1, 1.1, 0.1), true);
    assert.strictEqual(hasChanged(1, 1.0001, 0), true);
    assert.strictEqual(hasChanged(NaN, NaN, 0), false);
    assert.strictEqual(hasChanged({ a: 1, b: 2 }, { b: 2, a: 1 }, 0), false);
    assert.strictEqual(hasChanged("a", "b", 0), true);
    assert.strictEqual(hasChanged("1.0", "1.05", 0.1), false);
});

test("validateWrite: type, range, enum, hex, length", () => {
    const num = { writable: true, format: { type: "number", encoding: "integer", valuation: { min: 0, max: 10 } } };
    assert.strictEqual(validateWrite(num, "5").value, 5);
    assert.strictEqual(validateWrite(num, 11).ok, false);
    assert.strictEqual(validateWrite(num, 1.5).ok, false);
    const en = { writable: true, format: { type: "number", encoding: "integer", valuation: { valuelist: { 0: "disabled", 3: "IO-Link" } } } };
    assert.strictEqual(validateWrite(en, "IO-Link").value, 3);
    assert.strictEqual(validateWrite(en, 2).ok, false);
    const hex = { writable: true, format: { type: "string", encoding: "hexstring", valuation: { maxlength: 2 } } };
    assert.strictEqual(validateWrite(hex, "0a1b").value, "0A1B");
    assert.strictEqual(validateWrite(hex, "0a1").ok, false);
    // formats as delivered by a real AL1590 IoT-Core
    const led = { writable: true, format: { valuation: { single_values: [{ value: true }, { value: false }] }, type: "boolean" } };
    assert.strictEqual(validateWrite(led, 1).value, true);
    assert.strictEqual(validateWrite(led, "False").value, false);
    assert.strictEqual(validateWrite(led, { "LED-a": 0 }).ok, false);
    const unit = { writable: true, format: { valuation: { single_values: [{ value: 0, text: "mm/s" }, { value: 1, text: "m/s" }] }, type: "number", encoding: "uint64" } };
    assert.strictEqual(validateWrite(unit, "m/s").value, 1);
    assert.strictEqual(validateWrite(unit, 2).ok, false);
    const rng = { writable: true, format: { valuation: { value_ranges: [{ lower_value: 0, upper_value: 500 }], min: 0, max: 500 }, type: "number", encoding: "float" } };
    assert.strictEqual(validateWrite(rng, "12.5").value, 12.5);
    assert.strictEqual(validateWrite(rng, 501).ok, false);
    const i32 = { writable: true, format: { valuation: { min: 50, max: 3600000 }, type: "number", encoding: "int32" } };
    assert.strictEqual(validateWrite(i32, 50.5).ok, false);
    const en2 = { writable: true, format: { valuation: { valuelist: { 1: "Static", 2: "DHCP" } }, type: "enum", encoding: "integer" } };
    assert.strictEqual(validateWrite(en2, "DHCP").value, 2);
    assert.strictEqual(validateWrite({ writable: false }, 1).ok, false);
    assert.strictEqual(validateWrite(null, 1).ok, false);
});

test("read: cache policy and request coalescing", async () => {
    const core = new Core({ baseUrl: URL });
    const s = server.state.stats;
    const before = s.getdatamulti;
    const p = [`${PD}/Temperature`, "/deviceinfo/serialnumber"];
    const [a, b] = await Promise.all([core.read(p, { force: true }), core.read(p, { force: true })]);
    assert.strictEqual(s.getdatamulti - before, 1, "parallel reads must share one request");
    assert.strictEqual(a.get(p[1]).value, "000174210147");
    assert.strictEqual(b.get(p[1]).value, "000174210147");
    assert.match(a.get(p[0]).timestamp, /^\d{4}-\d\d-\d\dT.*Z$/);
    await core.read(p, { maxAge: 10000 });
    assert.strictEqual(s.getdatamulti - before, 1, "fresh cache must not trigger a request");
    const missing = await core.read(["/does/not/exist"], { force: true });
    assert.strictEqual(missing.get("/does/not/exist").code, 404);
    core.close();
});

test("scheduler: one request per interval group, shared paths only in fastest group", async () => {
    const core = new Core({ baseUrl: URL });
    const s = server.state.stats;
    const fastP = `${PD}/Temperature`, slowOnly = "/timer/counter";
    const got = { a: 0, b: 0, c: 0 };
    const u1 = core.subscribe(50, [fastP], () => got.a++);
    const u2 = core.subscribe(50, [fastP], () => got.b++);       // identical subscription
    const u3 = core.subscribe(200, [fastP, slowOnly], m => { got.c++; assert.ok(m.has(fastP) && m.has(slowOnly)); });
    const p0 = s.paths, r0 = s.getdatamulti;
    await sleep(520);
    u1(); u2(); u3();
    const reqs = s.getdatamulti - r0, paths = s.paths - p0;
    // ~11 fast ticks (1 path) + ~3 slow ticks (only counter) => paths ≈ reqs
    assert.ok(reqs >= 10 && reqs <= 16, `unexpected request count ${reqs}`);
    assert.strictEqual(paths, reqs, "every request must contain exactly one path (no duplicates)");
    assert.ok(got.a > 5 && got.a === got.b, "both identical subscribers get every tick");
    assert.ok(got.c >= 2);
    const r1 = s.getdatamulti;
    await sleep(150);
    assert.strictEqual(s.getdatamulti, r1, "no polling after unsubscribe");
    assert.strictEqual(core.groups.size, 0);
    core.close();
});

test("write: invalid, ok + verify, rejected-by-model", async () => {
    const core = new Core({ baseUrl: URL });
    let r = await core.write("/devicetag/applicationtag", "x".repeat(40));
    assert.strictEqual(r.outcome, "INVALID");
    r = await core.write("/devicetag/applicationtag", "Line 7", { verify: true });
    assert.strictEqual(r.outcome, "OK");
    assert.strictEqual(r.accepted, true);
    assert.strictEqual(r.effective, true);
    r = await core.write("/iolinkmaster/port[3]/mode", "IO-Link", { verify: true });
    assert.strictEqual(r.value, 3);
    assert.strictEqual(r.effective, true);
    r = await core.write("/deviceinfo/serialnumber", "1");
    assert.strictEqual(r.outcome, "INVALID");
    core.close();
});

test("write timeout => OUTCOME_UNKNOWN, unreachable => FAILED / stale values", async () => {
    const slow = await mock.start(PORT + 1, { delay: 400 });
    const core = new Core({ baseUrl: `http://127.0.0.1:${PORT + 1}`, timeout: 5000 });
    await core.getTree(true);
    const r = await core.write("/devicetag/applicationtag", "x", { timeout: 150 });
    assert.strictEqual(r.outcome, "OUTCOME_UNKNOWN");
    assert.strictEqual(r.transport, "timeout");
    core.close();
    await new Promise(res => slow.close(res));

    const dead = new Core({ baseUrl: "http://127.0.0.1:1", timeout: 500 });
    const m = await dead.read(["/x"], { force: true });
    assert.ok(m.get("/x").transportError);
    dead.close();

    // stale flag keeps last value
    const c2 = new Core({ baseUrl: URL });
    await c2.read(["/deviceinfo/serialnumber"], { force: true });
    c2.client.url = new (require("url").URL)("http://127.0.0.1:1");
    const s = (await c2.read(["/deviceinfo/serialnumber"], { force: true })).get("/deviceinfo/serialnumber");
    assert.strictEqual(s.value, "000174210147");
    assert.strictEqual(s.stale, true);
    c2.close();
});

test("pdout_interpreted: PDOut initialised per port with device-specific length", async () => {
    const st = server.state;
    st.reboot();
    const core = new Core({ baseUrl: URL });
    const led = l => `/iolinkmaster/port[4]/iolinkdevice/pdout_interpreted/OnOffOut/${l}`;
    // without initialisation the device rejects interpreted writes (behaviour of the AL15)
    let r = await core.write(led("LED-a"), 1, { pdoutInit: false });
    assert.strictEqual(r.outcome, "REJECTED");
    // port 4: raw PDOut not readable (530), length from IODD: OnOffOut/iodd_info bit_length 16 -> 2 bytes
    r = await core.write(led("LED-a"), 1, { verify: true });
    assert.strictEqual(r.outcome, "OK", r.message);
    assert.strictEqual(r.pdoutInit, "iodd");
    assert.strictEqual(st.values.get("/iolinkmaster/port[4]/iolinkdevice/pdout"), "0000");
    assert.strictEqual(r.effective, true);
    // second write: no further initialisation
    const w0 = st.stats.pdoutWrites;
    r = await core.write(led("LED-b"), true);
    assert.strictEqual(r.outcome, "OK");
    assert.strictEqual(r.pdoutInit, null);
    assert.strictEqual(st.stats.pdoutWrites - w0, 1);
    // "reboot" of the device: rejected -> re-initialised with learned length, write repeated once
    st.reboot();
    const w1 = st.stats.pdoutWrites;
    r = await core.write(led("LED-c"), true);
    assert.strictEqual(r.outcome, "OK", r.message);
    assert.strictEqual(r.retried, true);
    assert.strictEqual(r.pdoutInit, "zeros");
    assert.strictEqual(st.stats.pdoutWrites - w1, 3, "rejected write + 1 init + repeated write");
    core.close();
});

test("PDOut init: read-back value, model length and 1-byte device", async () => {
    const core = new Core({ baseUrl: URL });
    // readable raw PDOut is written back unchanged (state of outputs kept)
    server.state.values.set("/iolinkmaster/port[4]/iolinkdevice/pdout", "0500");
    assert.strictEqual(await core._ensurePdout("/iolinkmaster/port[4]/iolinkdevice", {}, true), "written-back");
    assert.strictEqual(server.state.values.get("/iolinkmaster/port[4]/iolinkdevice/pdout"), "0500");
    // length from the model (port 1: maxlength 2)
    server.state.reboot();
    assert.strictEqual(await core._ensurePdout("/iolinkmaster/port[1]/iolinkdevice", {}, true), "zeros");
    assert.strictEqual(core.pdoutLength.get("/iolinkmaster/port[1]/iolinkdevice"), 2);
    // 1-byte device found by probing
    assert.strictEqual(await core._ensurePdout("/iolinkmaster/port[3]/iolinkdevice", {}, true), "probed");
    assert.strictEqual(core.pdoutLength.get("/iolinkmaster/port[3]/iolinkdevice"), 1);
    core.close();
});

test("gettree adr with device name prefix (ifm-AL1590-<serial>/...)", () => {
    const pre = "ifm-AL1590-000251100049";
    const tree = { identifier: pre, type: "structure", subs: [
        { identifier: "iolinkmaster", type: "structure", adr: `${pre}/iolinkmaster`, subs: [
            { identifier: "pdout", type: "data", adr: `${pre}/iolinkmaster/port[4]/iolinkdevice/pdout`,
              subs: [{ identifier: "getdata", type: "service" }, { identifier: "setdata", type: "service" }] }] }] };
    const items = flattenTree(tree);
    assert.strictEqual(items[0].path, "/iolinkmaster/port[4]/iolinkdevice/pdout");
    assert.strictEqual(items[0].port, 4);
    assert.strictEqual(items[0].cat, "pdout");
});

test("device message is used in error texts (530 Invalid process data)", async () => {
    server.state.reboot();
    const core = new Core({ baseUrl: URL });
    const e = (await core.read(["/iolinkmaster/port[4]/iolinkdevice/pdout"], { force: true })).get("/iolinkmaster/port[4]/iolinkdevice/pdout");
    assert.strictEqual(e.code, 530);
    assert.strictEqual(e.error, "Invalid process data (530)");
    core.close();
});

test("AL15 out node: object payload mapped by name (1 or n targets)", async () => {
    server.state.reboot();
    const core = new Core({ baseUrl: URL });
    const types = {};
    const RED = { nodes: {
        createNode(n) { const h = {}; n.on = (e, f) => { h[e] = f; }; n._h = h; n.status = () => {}; },
        registerType(t, f) { types[t] = f; },
        getNode() { return { core }; } } };
    require("../nodes/al15-output.js")(RED);
    const P = "/iolinkmaster/port[4]/iolinkdevice/pdout_interpreted/OnOffOut/";
    const run = (points, msg) => new Promise(res => {
        const n = {};
        types["al15-output"].call(n, { connection: "x", verify: true, points });
        n._h.input(msg, m => res({ payload: m.payload }), e => { if (e) res({ error: e.message }); });
    });
    const one = [{ path: P + "LED-a", name: "LED-a" }];
    const three = ["LED-a", "LED-b", "LED-c"].map(l => ({ path: P + l, name: l }));
    let r = await run(one, { payload: { "LED-a": 1, "LED-b": 0 } });
    assert.strictEqual(r.payload.outcome, "OK");
    assert.strictEqual(r.payload.value, true);
    r = await run(three, { payload: { "LED-b": 1, "LED-c": "true" } });
    assert.deepStrictEqual(r.payload.map(x => [x.name, x.outcome, x.value]), [["LED-b", "OK", true], ["LED-c", "OK", true]]);
    r = await run(one, { payload: 0 });
    assert.strictEqual(r.payload.value, false);
    r = await run(three, { payload: { foo: 1 } });
    assert.match(r.error, /none of the configured names/);
    core.close();
});

test("AL15 get node: object mode keeps unreadable points as null + msg.errors", async () => {
    const core = new Core({ baseUrl: URL });
    const types = {};
    const RED = { nodes: {
        createNode(n) { const h = {}; n.on = (e, f) => { h[e] = f; }; n._h = h; n.status = () => {}; },
        registerType(t, f) { types[t] = f; },
        getNode() { return { core }; } } };
    require("../nodes/al15-get-data.js")(RED);
    const n = {};
    types["al15-get-data"].call(n, { connection: "x", cacheMode: "live", outputMode: "object", points: [
        { path: "/deviceinfo/serialnumber", name: "serial" },
        { path: "/iolinkmaster/port[1]/does_not_exist", name: "missing" }
    ] });
    const msg = await new Promise((res, rej) => n._h.input({}, res, e => { if (e) rej(e); }));
    assert.ok(Object.prototype.hasOwnProperty.call(msg.payload, "missing"));
    assert.strictEqual(msg.payload.missing, null);
    assert.notStrictEqual(msg.payload.serial, null);
    assert.strictEqual(msg.errors.length, 1);
    assert.strictEqual(msg.errors[0].name, "missing");
    core.close();
});

test("AL15 in node: free interval in ms, legacy classes, minimum 20 ms", async () => {
    const subs = [], warns = [];
    const core = { subscribe(iv, paths) { subs.push([iv, paths.length]); return () => {}; } };
    const types = {};
    const RED = { nodes: {
        createNode(n) { const h = {}; n.on = (e, f) => { h[e] = f; }; n._h = h; n.status = () => {}; n.warn = w => warns.push(w); },
        registerType(t, f) { types[t] = f; },
        getNode() { return { core }; } } };
    require("../nodes/al15-input.js")(RED);
    const n = {};
    types["al15-input"].call(n, { connection: "x", points: [
        { path: "/a", name: "a", interval: 33 },
        { path: "/b", name: "b", interval: "33" },
        { path: "/c", name: "c", interval: "fast" },
        { path: "/d", name: "d", interval: "slow" },
        { path: "/e", name: "e", interval: 5 },
        { path: "/f", name: "f" },
        { path: "/g", name: "g", interval: 1234.4 }
    ] });
    assert.deepStrictEqual(subs.sort((x, y) => x[0] - y[0]), [[20, 2], [33, 2], [500, 1], [1000, 1], [1234, 1]]);
    assert.strictEqual(warns.length, 1);
    assert.match(warns[0], /below 20 ms.*\be\b/);
});

test("scheduler: free intervals poll independently, each with one getdatamulti", async () => {
    const core = new Core({ baseUrl: URL });
    const A = `${PD}/Temperature`, B = "/timer/counter", C = "/deviceinfo/serialnumber";
    const s0 = { ...server.state.stats };
    const cnt = { a: 0, b: 0, c: 0 };
    const u1 = core.subscribe(40, [A], () => cnt.a++);
    const u2 = core.subscribe(130, [B, C], () => cnt.b++);
    const u3 = core.subscribe(300, [A, C], () => cnt.c++);   // A from 40 ms group, C from 130 ms group -> no own request
    await sleep(620);
    u1(); u2(); u3();
    const reqs = server.state.stats.getdatamulti - s0.getdatamulti, paths = server.state.stats.paths - s0.paths;
    // 40 ms: ~16 ticks x 1 path, 130 ms: ~5 ticks x 2 paths, 300 ms: no request
    assert.ok(cnt.a >= 12 && cnt.b >= 4 && cnt.b <= 6 && cnt.c >= 2, JSON.stringify(cnt));
    assert.strictEqual(reqs, cnt.a + cnt.b, `requests ${reqs} != ticks of 40/130 ms groups`);
    assert.strictEqual(paths, cnt.a * 1 + cnt.b * 2);
    core.close();
});

(async () => {
    server = await mock.start(PORT);
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log(`  ok   ${t.name}`); }
        catch (e) { failed++; console.log(`  FAIL ${t.name}\n       ${e.stack.split("\n").slice(0, 3).join("\n       ")}`); }
    }
    server.close();
    console.log(failed ? `\n${failed} test(s) failed` : `\nall ${tests.length} tests passed`);
    process.exit(failed ? 1 : 0);
})();
