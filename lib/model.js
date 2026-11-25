"use strict";
const { categorize } = require("./categories");
/**
 * Helpers for the dynamically read IoT-Core model:
 *  - flattening /gettree into a categorised list of data points
 *  - IoT-Core diagnostic codes
 *  - deterministic change detection (incl. deadband)
 *  - write validation based on the "format" description of a data point
 */

const CODES = {
    200: "OK",
    230: "OK, reboot required",
    231: "OK, request not yet finished",
    232: "OK, value was adapted by the device",
    233: "OK, new IP settings",
    400: "Bad request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Data point not found",
    500: "Internal device error",
    503: "Service not available",
    530: "Invalid process data",
    531: "IO-Link error",
    532: "PLC connected error"
};

/** Text for an IoT-Core code; the device's own message (answer.msg) is preferred when present. */
function codeText(code, msg) {
    if (typeof msg === "string" && msg.trim()) return `${msg.trim()} (${code})`;
    return CODES[code] || `IoT-Core code ${code}`;
}

/**
 * Normalises a gettree "adr" to an absolute IoT-Core path.
 * Depending on the firmware the adr is "/a/b", "a/b" or "<devicename>/a/b".
 * A leading device name is detected by comparing with the top-level branches.
 */
function normPath(adr, top) {
    if (typeof adr !== "string" || !adr) return "";
    if (adr.startsWith("/")) return adr;
    const seg = adr.split("/");
    if (top && seg.length > 1 && !top.has(seg[0]) && top.has(seg[1])) seg.shift();
    return `/${seg.join("/")}`;
}

/** Picker category of a path – see lib/categories.js (rule table from the mapping list). */
const classify = categorize;

function services(n) {
    return new Set((n.subs || []).filter(x => x && x.type === "service").map(x => x.identifier));
}

/**
 * Flattens the gettree answer. Data points nested inside another data point
 * (e.g. "unit" / "iodd_info" below an interpreted process value) are flagged
 * as `nested` so that the editor can hide them by default; they inherit the
 * category of that data point.
 */
function flattenTree(root) {
    const out = [];
    const top = new Set((root && root.subs || []).filter(x => x && x.type !== "service").map(x => x.identifier));
    function walk(n, folders, parentData, parentCat) {
        if (!n || typeof n !== "object") return;
        const path = normPath(n.adr || "", top);
        const label = n.identifier || path.split("/").pop() || "root";
        const svc = services(n);
        let isData = false, cat = parentCat;
        if (n.type === "data" && (svc.has("getdata") || svc.has("setdata"))) {
            isData = true;
            const c = parentCat || classify(path);
            out.push({
                path,
                label,
                parent: parentData || null,
                group: folders.slice(-2).join(" / "),
                area: c.area,
                port: c.port,
                cat: c.cat,
                nested: !!parentData,
                readable: svc.has("getdata"),
                writable: svc.has("setdata"),
                format: n.format || null
            });
            cat = c;
        }
        const nextFolders = n.type === "data" || !path ? folders : [...folders, label];
        (n.subs || []).forEach(x => {
            if (x && x.type !== "service") walk(x, nextFolders, isData ? label : parentData, cat);
        });
    }
    walk(root, [], null, null);
    out.sort((a, b) => (a.port || 0) - (b.port || 0) || a.path.localeCompare(b.path, "en", { numeric: true }));
    return out;
}

/* ---------- change detection ---------- */

function stable(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
}

function asNumber(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    return null;
}

/** true when `next` must be reported compared to the last reported value `prev`. */
function hasChanged(prev, next, deadband) {
    const db = Number(deadband) || 0;
    if (typeof prev === "number" && typeof next === "number") {
        if (Number.isNaN(prev) && Number.isNaN(next)) return false;
        if (db > 0 && Number.isFinite(prev) && Number.isFinite(next)) return Math.abs(next - prev) >= db;
        return prev !== next;
    }
    if (db > 0 && typeof prev === typeof next) {
        const a = asNumber(prev), b = asNumber(next);
        if (a !== null && b !== null) return Math.abs(b - a) >= db;
    }
    return stable(prev) !== stable(next);
}

/* ---------- write validation ---------- */

function validateWrite(item, value) {
    if (!item) return { ok: false, error: "Data point does not exist in the IoT-Core model" };
    if (!item.writable) return { ok: false, error: "Data point is not writable (no setdata service)" };
    if (value === undefined || value === null) return { ok: false, error: "No value given" };
    const f = item.format || {};
    const type = String(f.type || "").toLowerCase();
    const enc = String(f.encoding || "").toLowerCase();
    const val = f.valuation || {};
    let v = value;

    if (val.valuelist && typeof val.valuelist === "object") {
        const keys = Object.keys(val.valuelist);
        let key = keys.find(k => String(k) === String(v));
        if (key === undefined) key = keys.find(k => String(val.valuelist[k]).toLowerCase() === String(v).toLowerCase());
        if (key === undefined) return { ok: false, error: `Value ${JSON.stringify(value)} not allowed. Allowed: ${keys.map(k => `${k} (${val.valuelist[k]})`).join(", ")}` };
        v = (enc === "integer" || type === "number" || typeof value === "number") && Number.isFinite(Number(key)) ? Number(key) : key;
        return { ok: true, value: v };
    }

    const isInt = enc === "integer" || /^u?int\d*$/.test(enc);
    if (type === "number" || isInt || enc === "float" || enc === "double") {
        let n = asNumber(v);
        if (n === null) {
            const sv = matchSingle(val, v);
            if (sv === undefined) return { ok: false, error: `Expected a number, got ${JSON.stringify(value)}${allowedText(val)}` };
            n = asNumber(sv);
        }
        if (isInt && !Number.isInteger(n)) return { ok: false, error: `Expected an integer, got ${n}` };
        if (/^uint/.test(enc) && n < 0) return { ok: false, error: `Expected a value >= 0, got ${n}` };
        if (val.min !== undefined && n < Number(val.min)) return { ok: false, error: `Value ${n} below minimum ${val.min}` };
        if (val.max !== undefined && n > Number(val.max)) return { ok: false, error: `Value ${n} above maximum ${val.max}` };
        if (!inAllowed(val, n)) return { ok: false, error: `Value ${n} not allowed${allowedText(val)}` };
        return { ok: true, value: n };
    }

    if (type === "boolean") {
        const t = typeof v === "string" ? v.trim().toLowerCase() : v;
        if (t === true || t === 1 || t === "1" || t === "true") return { ok: true, value: true };
        if (t === false || t === 0 || t === "0" || t === "false") return { ok: true, value: false };
        return { ok: false, error: `Expected a boolean (true/false or 1/0), got ${JSON.stringify(value)}` };
    }

    if (enc === "hexstring") {
        const h = String(v).replace(/^0x/i, "").replace(/\s+/g, "");
        if (!/^([0-9a-fA-F]{2})*$/.test(h)) return { ok: false, error: "Expected a hex string with an even number of digits" };
        return { ok: true, value: h.toUpperCase() };
    }

    if (type === "string" || typeof v !== "object") {
        let str = typeof v === "string" ? v : String(v);
        if (Array.isArray(val.single_values) && !Array.isArray(val.value_ranges)) {
            const sv = matchSingle(val, str);
            if (sv === undefined) return { ok: false, error: `Value ${JSON.stringify(value)} not allowed${allowedText(val)}` };
            str = String(sv);
        }
        if (val.minlength !== undefined && str.length < Number(val.minlength)) return { ok: false, error: `Text shorter than ${val.minlength} characters` };
        if (val.maxlength !== undefined && str.length > Number(val.maxlength)) return { ok: false, error: `Text longer than ${val.maxlength} characters` };
        return { ok: true, value: type === "string" ? str : v };
    }
    return { ok: true, value: v };
}

/* single_values: [{ value, text }], value_ranges: [{ lower_value, upper_value }] (IoT-Core / IODD) */
function matchSingle(val, v) {
    if (!Array.isArray(val.single_values)) return undefined;
    const s = String(v).trim().toLowerCase();
    const hit = val.single_values.find(x => x && (String(x.value).toLowerCase() === s || (x.text !== undefined && String(x.text).toLowerCase() === s)));
    return hit ? hit.value : undefined;
}

function inAllowed(val, n) {
    const singles = Array.isArray(val.single_values) ? val.single_values : null;
    const ranges = Array.isArray(val.value_ranges) ? val.value_ranges : null;
    if (!singles && !ranges) return true;
    if (singles && singles.some(x => x && Number(x.value) === n)) return true;
    if (ranges && ranges.some(r => r && n >= Number(r.lower_value) && n <= Number(r.upper_value))) return true;
    return false;
}

function allowedText(val) {
    const parts = [];
    if (Array.isArray(val.single_values)) parts.push(...val.single_values.slice(0, 12).map(x => x.text !== undefined ? `${x.value} (${x.text})` : String(x.value)));
    if (Array.isArray(val.value_ranges)) parts.push(...val.value_ranges.map(r => `${r.lower_value}..${r.upper_value}`));
    return parts.length ? `. Allowed: ${parts.join(", ")}` : "";
}

module.exports = { flattenTree, classify, normPath, hasChanged, stable, validateWrite, codeText, CODES };
