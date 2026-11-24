# Changelog

## 0.4.1

* **AL15 out: payload example in the editor.** Below the selected targets the dialog shows an example `msg.payload`
  built from the names and the IoT-Core formats, plus the accepted format of each target (boolean, range, allowed values, hex string …).
* AL15 out help: payload examples (one target, several targets, partial object, path as key, dynamic `msg.path`) and value formats.

## 0.4.0

* **AL15 in: free polling interval** per data point in ms (any value ≥ 20 ms, default 500 ms) instead of the classes fast / normal / slow.
  Existing nodes keep working: `fast` / `normal` / `slow` are read as 20 / 500 / 1000 ms and stored as numbers when the node is saved.
  Values below 20 ms are marked red in the editor and raised to 20 ms (warning at runtime).
* Config node: hint text for firmware > V1.9 (default endpoint) and < V1.9 (user / password needed).

## 0.3.3

* AL15 get, output *Object by name*: points that could not be read and have no last valid value are now `null`
  instead of missing in `msg.payload` (details still in `msg.errors`).
* Data point picker: opening an existing node shows the area / port / category of its selected points
  (e.g. *Data per Port · Port 4 · Process Data Out*) instead of the last view used in any node. Mixed selections keep the last view.
* Picker: a model reload no longer resets the selected port.

## 0.3.2 (tested on AL1590, DV2121 on port 4)

* AL15 out: an object payload `{ "LED-a": 1, … }` is mapped by name also when the node has only one target
  (before, the whole object was written as value -> `INVALID: Expected a boolean`).
* PDOut length taken from the IODD (`bit_length` in `pdout_interpreted/<record>/iodd_info`), probing only as last fallback.
* Validation understands the formats of the real IoT-Core: `single_values` (value or text), `value_ranges`,
  `int8…int64` / `uint8…uint64`, `double`, booleans as `true/false`, `True/False`, `1/0`. Allowed values are listed in the error text.
* Device messages are also taken from `data.msg` (getdatamulti / error answers).
* Hex strings: `maxlength` is no longer interpreted (unit not defined), the device checks the length.

## 0.3.1

* **AL15 out: automatic PDOut initialisation** for `pdout_interpreted` elements (option, default on).
  The raw PDOut of a port must be written completely once (after every reboot) before interpreted elements can be written.
  Before the first interpreted write of a port the node reads the raw PDOut and writes it back unchanged. If it cannot be read,
  zeros are written with the device-specific length (1–32 bytes): learned length → length from the model → probing 1…32 bytes.
* If an interpreted write is rejected later (reboot, device re-plugged), the PDOut is initialised again and the write is repeated once
  (`retried: true`, `pdoutInit` in the result).
* After a reboot the raw PDOut cannot be read (`530 Invalid process data`); the length is then taken from the learned value, the model or by probing.
* Error texts use the device's own message (`msg`) when the IoT-Core provides one, e.g. `Invalid process data (530)`.

## 0.3.0

### New
* **AL15 in** – change-based output, interval classes 20 ms / 500 ms / 1 s per data point, deadband, single or collection output, first read only initialises.
* **AL15 out** – validated writes (existence, writability, type, range, value list, hex, length), optional read-back, separated outcome (`transport`, `accepted`, `effective`, `persistence`), `OUTCOME_UNKNOWN` on timeout, no automatic retry.
* Shared scheduler in the config node: grouped `getdatamulti` per interval, no duplicate paths, no overlapping requests, clean redeploy.
* Example flow, help texts, IoT-Core mock and automated tests.

### Data point selection (editor)
* Rebuilt picker shared by all nodes: area / port / category in one row, filter, Details toggle.
* Ports are taken from the model (no fixed 1–8 list).
* Click toggles a data point; selected points are highlighted in the list.
* Attributes like `unit` / `iodd_info` hidden by default and shown as `Temperature › unit`.
* Fixed: “add” button of the selected list created empty entries and broke the editor.
* Fixed: name inputs were cut off / list scrolled horizontally (negative margin layout).
* Fixed: model was not reloaded when the AL15 config was changed; parallel loads could overwrite each other.
* Model can be loaded before the config node is deployed (uses the URL from the editor).
* Duplicate / empty names are highlighted.
* Only `{path, label, name, …}` is stored per point (previously the whole tree entry).

### Runtime
* Default endpoint `http://127.0.0.1:8090`, keep-alive connection, hard request timeout.
* Cache is RAM only (the gettree file cache in `<userDir>/.al15-cache` is no longer used).
* Failed points keep the last value and are marked stale instead of silently disappearing.
* Path normalisation for different gettree `adr` formats.
* AL15 get: single value output according to the specification, `msg.path` / `msg.paths` / `msg.forceRefresh` / `msg.maxAge`.

### Migration from 0.2.x
* Existing *AL15 get data* nodes keep working (`selections`/`alias` are read). Opening and saving a node converts them to `points`/`name`.
* Output modes `aliases`/`paths` are mapped to *Object by name*.
