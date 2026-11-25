"use strict";
/**
 * Category mapping of the data point picker (source: "al15 mapping for nodered.xlsx").
 *
 * The IoT-Core model itself is always read live via /gettree – this table only SORTS
 * the data points that exist on the device into picker categories. Nothing is hard-coded
 * per firmware: paths that do not exist are simply not shown, paths that no rule matches
 * are never lost (they are shown in "Advanced (all)" or "All Port Data").
 *
 * Notation (as in the Excel list):
 *   port[x]  any port number
 *   /#       the path itself and everything below it
 * Matching is case-insensitive. Rules are checked top-down, the FIRST match wins.
 * Attributes nested inside a data point (unit, iodd_info …) inherit the category of that data point.
 *
 * Areas / categories (keys are used by the editor):
 *   status  IO-Link Master Status
 *   master  IO-Link Master Data   tags | ident | data   (+ "Advanced (all)" = everything outside the ports)
 *   port    Data on Ports         pdin | pdout | diag | ident | param | config  (+ "All Port Data")
 */

const P = "/iolinkmaster/port[x]";
const D = `${P}/iolinkdevice`;

const RULES = [
    /* ---------- IO-Link Master Status ---------- */
    { area: "status", paths: [
        "/application/node-red/status",
        "/application/ntp/status",
        "/connections/mqttcommandchannel/status",
        "/connections/mqttclient/status",
        "/connections/opcua_server/status",
        "/connections/httpserver0/status",
        "/connections/httpserver1/status",
        "/monitor/status",
        "/fieldbussetup/connectionstatus"
    ] },

    /* ---------- IO-Link Master Data ---------- */
    { area: "master", cat: "tags", paths: [
        "/devicetag/applicationtag",
        "/devicetag/functiontag",
        "/devicetag/locationtag"
    ] },
    { area: "master", cat: "ident", paths: [
        "/deviceinfo/hwrevision",
        "/deviceinfo/hwversion",
        "/deviceinfo/ordernumber",
        "/deviceinfo/productcode",
        "/deviceinfo/productiondate",
        "/deviceinfo/productname",
        "/deviceinfo/serialnumber",
        "/deviceinfo/swrevision",
        "/deviceinfo/swversion",
        "/deviceinfo/vendor",
        "/network/br0/hostname",
        "/network/br0/macaddress",
        "/software/firmware/version"
    ] },
    { area: "master", cat: "data", paths: [
        "/fieldbussetup/fieldbustype",
        "/devicesettings/systemtime/datetime",
        "/devicesettings/systemtime/timezone",
        "/devicesettings/systemtime/timezonelist",
        "/devicestatus/operatinghours",
        "/devicestatus/operatingstate",
        "/devicestatus/temperature/board",
        "/devicestatus/temperature/cpu",
        "/devicestatus/temperature/emmc",
        "/devicestatus/temperature/power5V",
        "/processdatamaster/current",
        "/processdatamaster/supervisionstatus",
        "/processdatamaster/supervisionstatus_ua",
        "/processdatamaster/voltage"
    ] },

    /* ---------- Data on Ports ---------- */
    { area: "port", cat: "pdin", paths: [
        `${P}/iqin`,                       // only on ports with an IQ input (tree decides)
        `${D}/pdin`,                       // raw value (IO-Link) or DI
        `${D}/pdin_interpreted/#`
    ] },
    { area: "port", cat: "pdout", paths: [
        `${P}/iqout`,                      // only on ports with an IQ output (tree decides)
        `${D}/pdout`,                      // raw value (IO-Link) or DO
        `${D}/pdout_interpreted/#`
    ] },
    { area: "port", cat: "diag", paths: [
        `${P}/portevent`,
        `${P}/porteventlist`,
        `${D}/status`,
        `${D}/iolinkevent`,
        `${D}/iolinkeventlist`,
        `${D}/diagnosis_interpreted/#`
    ] },
    { area: "port", cat: "ident", paths: [
        // raw identification – available without IODD
        `${D}/vendorid`,
        `${D}/deviceid`,
        `${D}/productname`,
        `${D}/serial`,
        `${D}/revision`,
        `${D}/applicationspecifictag`,
        `${D}/functiontag`,
        `${D}/locationtag`,
        // interpreted identification – only with IODD
        `${D}/identification_interpreted/#`
    ] },
    { area: "port", cat: "param", paths: [
        `${D}/parameter_interpreted/#`
    ] },
    // Everything else of the connected device (e.g. observation_interpreted of newer firmware,
    // which repeats pdin/pdout_interpreted) is only listed in "All Port Data".
    { area: "port", cat: null, paths: [
        `${D}/#`
    ] },
    // Settings / state of the port itself: mode, comspeed, cycle times, data storage, validation, power …
    { area: "port", cat: "config", paths: [
        `${P}/#`
    ] }
];

const PORT_RE = /^\/iolinkmaster\/port\[(\d+)\]/i;

function compile(pattern) {
    let p = pattern, deep = false;
    if (p.endsWith("/#")) { p = p.slice(0, -2); deep = true; }
    const src = p.split("[x]").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\[\\d+\\]");
    return new RegExp(`^${src}${deep ? "(?:/.*)?" : ""}$`, "i");
}

const COMPILED = RULES.flatMap(r => r.paths.map(p => ({ re: compile(p), area: r.area, cat: r.cat || null })));

/**
 * { area, cat, port } of an absolute IoT-Core path.
 * Fallback: port paths -> "All Port Data" only, all others -> "Advanced (all)" only.
 */
function categorize(path) {
    const m = String(path || "").match(PORT_RE);
    const port = m ? Number(m[1]) : null;
    const hit = COMPILED.find(r => r.re.test(path));
    if (hit) return { area: hit.area, cat: hit.cat, port: hit.area === "port" ? port : null };
    return { area: port ? "port" : "master", cat: null, port };
}

module.exports = { RULES, categorize, compile };
