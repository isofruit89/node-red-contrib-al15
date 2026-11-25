# node-red-contrib-al15

Node-RED palette for local access to the IoT-Core of ifm **AL1590 / AL1591**.
Runs on the AL15 itself and talks to `http://127.0.0.1:8090` (firmware > V1.9, no TLS overhead).
With firmware < V1.9 or enabled IoT-Core access protection, user and password are required in the config node.
No npm dependencies – the package works fully offline.

| Node | Purpose |
|---|---|
| **AL15 in** | Sends values when they change (free polling interval ≥ 20 ms per data point, optional deadband) |
| **AL15 get** | Reads values on demand, uses the RAM cache when it is young enough |
| **AL15 out** | Writes data points (device tag, configuration, outputs, PDOut) with validation |
| *AL15 config* | Shared connection, IoT-Core model, RAM cache and scheduler |

## Installation (offline)

The ready-to-install package is in [`dist/`](dist/): **[node-red-contrib-al15-0.5.0.tgz](dist/node-red-contrib-al15-0.5.0.tgz)**.
No internet access is needed on the AL15.

1. Download the `.tgz` file.
2. In the Node-RED editor on the AL15: *Menu → Manage palette → Install → upload* (icon next to the search field) and select the file,
   **or** in the Node-RED user directory: `npm install /path/to/node-red-contrib-al15-0.4.0.tgz`
3. Restart Node-RED (the new version is only active after a restart).

## Installation from source

```
git clone <this repository>
cd node-red-contrib-al15
npm test        # optional: tests against the built-in IoT-Core mock
npm pack        # builds node-red-contrib-al15-<version>.tgz
```
Then install the `.tgz` as described above.
Example flow: *Import → Examples → node-red-contrib-al15 → AL15-basics*.

## Selecting data points

The editor reads the IoT-Core model (`/gettree`) dynamically – no static list is needed.

1. Choose the area and category:
   * **IO-Link Master Status** – status of Node-RED, NTP, MQTT, OPC UA, HTTP servers, monitor and fieldbus connection.
   * **IO-Link Master Data** – *AL15 Tags*, *AL15 Ident*, *AL15 Data* or *Advanced (all)* (every data point outside the ports, full paths).
   * **Data on Ports** – port 1…n and *Process Data IN*, *Process Data OUT*, *Device Status / Diagnosis*,
     *Device Identification*, *Parameter*, *Port Configuration* or *All Port Data*.

   The number behind each category is the number of data points the AL15 offers there; empty categories are greyed out.
2. Optionally filter by name or path (several words = AND).
3. Click a data point to add it, click again to remove it. Selected points are highlighted.
4. Give every point a name (`msg.name`). Duplicate or empty names are marked red.

Attributes such as `unit` or `iodd_info` below a process value are hidden unless **Details** is ticked.

### Categories – generic across firmware versions

The categories are a rule table in [`lib/categories.js`](lib/categories.js) (`port[x]` = any port,
`/#` = the path and everything below it, first match wins). It only *sorts* what the live `/gettree` returns:

* data points that a firmware does not have are simply not shown (e.g. `iqin` only on ports with an IQ input),
* data points that no rule matches are never lost – they appear in **Advanced (all)** or **All Port Data**
  (e.g. `observation_interpreted` of newer firmware, which repeats the interpreted process data),
* *Device Identification* also lists the raw fields (`vendorid`, `deviceid`, `productname`, `serial` …),
  so it is filled without IODD; `*_interpreted` branches need an IODD on the AL15.
Use the refresh button after changing devices, IODDs or firmware. The model can be loaded before the
config node is deployed.

## Message formats

Single value (AL15 in, AL15 get with one point):
```js
{ payload: 0.1, name: "motor1_v-Rms", path: "/iolinkmaster/port[1]/…/v-Rms", timestamp: "2026-11-17T12:28:45.123Z" }
```
Several values (AL15 get, AL15 in collection mode): `msg.payload` is an array in the configured order:
```js
[ { name: "motor1_v-Rms", path: "…", value: 0.1, timestamp: "…" }, … ]
```
Entries that could not be read additionally contain `error`, `code` and `stale: true` (last valid value kept).
In *Object by name* mode such a point is `null` if no valid value has been read yet; the details are in `msg.errors`.
`timestamp` is always the UTC time of the last **successful** read.

AL15 out result: `{ name, path, value, outcome, transport, accepted, effective, persistence, code, message }`
with `outcome` = `OK | INVALID | REJECTED | FAILED | OUTCOME_UNKNOWN`. Writes are never retried automatically – the only
exception is a *rejected* `pdout_interpreted` write, which is repeated once after re-initialising the PDOut (see below).

Communication and technical errors are signalled through the node status and a Catch node.

### PDOut of IO-Link devices

Elements below `pdout_interpreted` (e.g. `OnOffOut/LED-a`) only change part of the raw PDOut. The device rejects them
until the raw `pdout` of the port has been written completely once – again after every reboot. AL15 out does this
automatically (option *initialise raw PDOut automatically*, default on): the current raw PDOut is written back unchanged,
or – if it cannot be read (530 after a reboot) – zeros with the device-specific length (1–32 bytes) taken from the IODD
(`bit_length` of the PDOut record), learned per port, from the model or as last resort by probing. Several values at once:

```js
msg.payload = { "LED-a": 1, "LED-b": 0, "LED-c": 1 }   // keys = names in the node
```

## Runtime behaviour

* All nodes of one config share one RAM cache and one keep-alive HTTP connection.
* The polling interval is entered per data point in ms (minimum 20 ms, default 500 ms).
* Subscriptions are grouped by interval; each group polls independently with **one** `getdatamulti`
  for all its paths (across all nodes of the same config). A 20 ms point does **not** make the other points poll at 20 ms.
* A path selected with several intervals is only read by the fastest group; slower groups take it from the cache –
  identical paths are never read twice. Every distinct interval value means its own request stream, so prefer few distinct values.
* Requests never overlap: if a request takes longer than its interval, the next one starts afterwards.
* Concurrent live reads of the same path are joined into one request.
* Redeploy removes all timers of the old nodes (no duplicate timers, no request storms).
* The first successful read of an *AL15 in* node only initialises the comparison value.

## Feedback

This version is shared for testing. Please report problems and ideas as a GitHub issue and include
AL15 type and firmware, IO-Link devices / ports involved, the Node-RED version and – if possible – the flow (export) and the debug output.

## Development

```
npm test                      # unit + integration tests against the IoT-Core mock
node test/mock-iotcore.js 18090   # simulator for editor tests (endpoint http://127.0.0.1:18090)
```
