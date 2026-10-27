# pperm.js

A browser JavaScript process runner with precise capability policies, metered resource quotas, preemptive step budgets, and parallel scheduling. Each process runs in its own dedicated Worker created inside an opaque-origin sandboxed iframe with a strict CSP. All quotas and permissions are enforced on the host thread, never inside untrusted code.

## Install

```sh
npm install
```

`acorn` is used for optional AST instrumentation. With a bundler or Node resolution it is loaded automatically. For a plain-browser setup, add an import map:

```html
<script type="importmap">
	{ "imports": { "acorn": "./node_modules/acorn/dist/acorn.mjs" } }
</script>
```

If `acorn` cannot be loaded, pperm.js still runs, but step budgeting is disabled and only wall-clock and heartbeat limits protect against blocking. `process.instrumented` reports which mode was used.

## Configuration model

Configuration is split into two clearly separated scopes.

**Host scope** — global limits on the pperm runtime itself, not on any single process. These are set once through `pperm.host` and apply to every process created afterwards:

```js
pperm.host.configure({ maxConcurrency: 4 });
console.log(pperm.host.stats);
```

| Field | Default | Meaning |
| --- | --- | --- |
| `maxConcurrency` | `4` | Maximum number of processes running at the same time. Excess processes wait in a FIFO queue without creating an iframe or Worker. |

`pperm.host.stats` returns `{ maxConcurrency, active, queued }`. Lowering the limit does not interrupt running processes; raising it immediately drains the queue.

**Process scope** — one single tree-shaped object passed to `pperm.create()`, `pperm.spawn()`, or `pperm.all()`. Capabilities and their quotas live on the same nodes; there is no separate `permissions` object and no separate `quotas` object. Every process gets its own frozen normalized copy.

```js
const process = pperm.create({
	network: {
		maxRequests: 20,
		maxBytes: 1048576,
		perSecond: 5,
		fetch: {
			allow: ["https://api.example.com/v1/*", "/*"],
			methods: ["GET", "POST"],
			timeoutMs: 5000,
			maxRequestBytes: 65536,
			maxResponseBytes: 262144
		},
		webSocket: { allow: [], maxConnections: 2 },
		eventSource: { allow: [] },
		xmlHttpRequest: { allow: [] }
	},
	storage: {
		enabled: true,
		maxOps: 1000,
		maxKeys: 100,
		maxBytes: 65536,
		maxValueBytes: 8192
	},
	dom: {
		enabled: true,
		root: "#app",
		innerHTML: true,
		remoteResources: { allow: ["/*"] },
		allowTags: null,
		denyTags: [],
		allowAttributes: null,
		allowEvents: ["click"],
		maxMutations: 5000,
		maxNodes: 2000,
		maxBytes: 1048576,
		maxDepth: 32,
		html: { maxLength: 65536, maxNodes: 500, maxAttributeLength: 2048 }
	},
	runtime: { allowEval: false, globals: ["URL"], highResolutionTime: false },
	execution: { steps: 2000000, wallMs: 5000, startMs: 5000, heartbeatMs: 100, stalledMs: 500 },
	messages: { maxCount: 10000, maxBytes: 4194304, perSecond: 1000 },
	timers: { maxActive: 16, maxCalls: 1000, minDelayMs: 8 }
});
```

User code reads the same normalized tree through the frozen `policy` global:

```js
postMessage(policy.dom.enabled);
postMessage(policy.execution.steps);
```

### Process scope reference

Everything is denied by default. Use `Infinity` or `"unlimited"` for any quota.

**`network`** — shared request budget plus per-API rules.

| Field | Default | Meaning |
| --- | --- | --- |
| `maxRequests` | `100` | Total mediated requests. |
| `maxBytes` | `4194304` | Total request + response bytes. |
| `perSecond` | `20` | Sliding-window request rate. |
| `fetch`, `xmlHttpRequest` | disabled | `false`, `true` (any `http(s)` origin), or a rule object. |
| `webSocket`, `eventSource` | disabled | `false`, `true`, or a rule object. |

HTTP rule fields: `allow` (URL patterns, empty array disables), `methods`, `timeoutMs` (`5000`), `maxRequestBytes` (`65536`), `maxResponseBytes` (`1048576`). Socket rule fields: `allow`, `maxConnections` (`2`).

URL patterns: `*` matches any `http(s)` origin; a pattern beginning with `/` matches a path on the host page's origin; otherwise `scheme://host/path` with `*` and `?` wildcards.

`fetch` and `XMLHttpRequest` are host-mediated: the Worker cannot reach the network (`connect-src 'none'`). The host validates origin, path, method, and quotas, strips ambient credentials and forbidden headers, executes the request with `credentials: "omit"`, and streams the response back under the byte limit. The Worker reconstructs a real `Response`, so ordinary fetch code works. The host page's own CSP applies and the target must satisfy CORS. `XMLHttpRequest` is a shim over the same channel. `WebSocket` and `EventSource` stay native; their allowed origins compile into the CSP `connect-src` allowlist and their construction count is capped.

**`storage`** — per-process in-memory KV store (`get`, `set`, `delete`, `keys`, `clear`). Each process has its own namespace; data disappears when the process ends.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Expose the `storage` global. |
| `maxOps` | `10000` | Total operations. |
| `maxKeys` | `1000` | Distinct keys held at once. |
| `maxBytes` | `1048576` | Current occupancy (released on delete/clear). |
| `maxValueBytes` | `65536` | Size of one value. |

Values must be JSON-serializable.

**`dom`** — mirrored DOM bridge rooted at `root`.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Expose `document`. |
| `root` | `"body"` | Element exposed as `document.body`. |
| `innerHTML` | `false` | Enable sanitized `innerHTML`. |
| `remoteResources` | disabled | `false`, `true`, an array of patterns, or `{ allow: [...] }`. |
| `allowTags` / `denyTags` | `null` / `[]` | Element allowlist / denylist. |
| `allowAttributes` | `null` | Attribute allowlist (`data-*`, `aria-*` always allowed). |
| `allowEvents` | `null` | Allowed event types for listeners and synthetic dispatch. |
| `maxMutations` | `50000` | DOM operations and listener registrations. |
| `maxNodes` | `20000` | Nodes across all DOM payloads. |
| `maxBytes` | `4194304` | Approximate DOM payload bytes. |
| `maxDepth` | `64` | DOM / HTML tree nesting depth. |
| `html.maxLength` | `262144` | `innerHTML` input length. |
| `html.maxNodes` | `2000` | Nodes in one `innerHTML` tree. |
| `html.maxAttributeLength` | `4096` | One HTML attribute value. |

Local `#fragment`, `about:blank`, `blob:`, and non-executable `data:` URLs are always allowed. Remote patterns are enforced on the Worker mirror and revalidated on the host.

**`runtime`**

| Field | Default | Meaning |
| --- | --- | --- |
| `allowEval` | `false` | When disabled, `Function`, `eval`, and the `constructor` of function prototypes throw. Required for step budgeting to cover all executed code. |
| `globals` | `[]` | Extra inert globals from a fixed safe set: `URL`, `URLSearchParams`, `Blob`, `File`, `FormData`, `Response`, `Headers`, `Request`, `AbortController`, `AbortSignal`, `TextEncoder`, `TextDecoder`, `crypto`, `console`, `atob`, `btoa`, `structuredClone`, `queueMicrotask`, `performance`, `navigator`, `location`. Capability-bearing names cannot be re-enabled. |
| `highResolutionTime` | `false` | By default `performance.now()` is rounded down to 10 ms. |

**`execution`**

| Field | Default | Meaning |
| --- | --- | --- |
| `steps` | `10000000` | Instrumented loop iterations + function entries. |
| `wallMs` | `10000` | Total wall-clock execution time after `ready`. |
| `startMs` | `5000` | Sandbox startup timeout. |
| `heartbeatMs` | `100` | Heartbeat and watchdog interval. |
| `stalledMs` | `500` (min `2 × heartbeatMs`) | Max silence before the process is declared blocked. |

**`messages`** — `maxCount` (`100000`), `maxBytes` (`33554432`), `perSecond` (`4000`). Exceeding a synchronous limit closes the port and removes the iframe immediately.

**`timers`** — `maxActive` (`64`), `maxCalls` (`10000`), `minDelayMs` (`4`).

## Quick start

```js
import pperm from "./pperm.js";

pperm.host.configure({ maxConcurrency: 2 });

const process = pperm.create({
	network: { fetch: { allow: ["/*"], methods: ["GET"] } },
	storage: { enabled: true },
	execution: { steps: 2000000, wallMs: 5000 },
	messages: { perSecond: 500 }
});

process.addEventListener("message", event => console.log(event.detail));
const result = await process.run(`
	let total = 0;
	for (let i = 0; i < 100000; i++) total += i;
	postMessage("done");
	const response = await fetch("/pperm.js");
	return { total, status: response.status };
`);
console.log(result, process.usage);
process.terminate();
```

## Enforcement and non-blocking execution

A single `QuotaLedger` per process holds all counters on the main thread. Worker-side counters are advisory only. Cumulative limits use `consume`, current-occupancy limits use `gauge`, and rate limits use a sliding window. Exceeding an async limit (network, storage, DOM) fails that operation and emits a `quota` event.

Four independent layers prevent blocking:

1. **Worker isolation** — user code never runs on the main thread.
2. **AST instrumentation** — when `acorn` is available, `run()` injects a `__pperm_tick_*()` call at every loop body, function body, and switch case. The tick counts steps, reports progress every 16384 steps, and on exceeding `execution.steps` sends a `quota` message and throws. The host verifies reported counts and kills unconditionally; the latched halt means `try { while(true){} } catch {}` cannot resume. A 50000-step budget stops `while(true){}` in roughly 25 ms.
3. **Heartbeat + stalled detection** — the Worker sends heartbeats on an independent native interval. Silence beyond `stalledMs` terminates the process, covering non-instrumented code (`allowEval`, `steps: Infinity`) and microtask floods. `wallMs` bounds total duration.
4. **Flood protection** — Worker emit throttling plus host message count, byte, and rate quotas. On violation the host closes the port before removing the iframe.

## Parallel execution

```js
pperm.host.configure({ maxConcurrency: 2 });

const batch = pperm.all([
	{ code: "return policy.execution.steps;", options: { execution: { steps: 100000 } } },
	{ code: "return policy.storage.enabled;", options: { storage: { enabled: true } } },
	"return 3;",
	() => 4
], { execution: { wallMs: 5000 } });

console.log(pperm.host.stats);
for (const process of batch.processes) console.log(process.id, process.state);
const results = await batch;
```

- `pperm.create(policy)` — create a process.
- `pperm.spawn(code, policy)` — create and run; returns the result promise with a `.process` property.
- `pperm.all(tasks, policy)` — create and run many processes concurrently; the returned promise has a `.processes` array. Task-level `options` are deep-merged over the shared policy, so each task keeps its own capabilities and quotas. It rejects on the first failure; terminate the remaining `batch.processes` if needed.
- `pperm.host.configure()` / `pperm.host.stats` — global concurrency limit, active count, queued count.

`process.run(code)` runs one script at a time and rejects with `AbortError`, `TimeoutError`, `QuotaExceededError`, `SyntaxError`, or the script's own error.

### Process API

| Member | Description |
| --- | --- |
| `id`, `state` | Numeric id and `idle / queued / starting / running / done / failed / terminated`. |
| `policy` | Frozen normalized process-scope tree. |
| `limits` | Frozen flattened quota map derived from `policy` for the ledger. |
| `usage` | Live snapshot: all counters, `limits`, `steps`, `elapsedMs`, `state`, `instrumented`. |
| `instrumented` | Whether AST step counters were injected. |
| `terminated` | Boolean. |
| `finished` | Promise resolved when the process is terminated — explicitly or by a quota/timeout kill. It does not resolve on normal completion. |
| `run(code)`, `terminate()`, `postMessage(value)` | Execution, irreversible termination, main-thread `message` event dispatch. |
| Events | `state`, `message`, `error`, `quota`, `done`, `terminate`. |

`process.postMessage(value)` dispatches a `message` event on the process object on the main thread; it is not a host → Worker channel.

## Isolation architecture

Each `run()` creates a hidden iframe with `sandbox="allow-scripts"` and no `allow-same-origin`, so the frame has an opaque origin. Its `srcdoc` carries a strict CSP meta policy and a small bootstrap script. The bootstrap creates a classic Worker from a blob URL and transfers a dedicated `MessagePort` into it.

- The opaque origin is enforced by the browser: parent DOM, cookies, localStorage, IndexedDB, and Cache API are inaccessible.
- `default-src 'none'`, `connect-src 'none'` (plus host-sources only for granted WebSocket/EventSource origins), and a `script-src` without URL sources are inherited by the Worker. Dynamic `import()` and `importScripts()` cannot reach the network.
- `script-src 'unsafe-inline' 'unsafe-eval' blob:` and `worker-src blob:` are required to create the Worker and compile the submitted script. No user code runs in the iframe document.
- Capability-bearing globals are removed from the Worker global and its prototypes. Standard intrinsics and prototypes are frozen, global `message` listeners are rejected, string timers are rejected, and a minimal `navigator`, `location`, and `performance` are provided. `self.origin` is `"null"`.
- The host independently revalidates every DOM mutation, storage operation, and network request. The global `postMessage` is removed, so untrusted code cannot inject a fake protocol frame.
- Termination removes the iframe, destroying the Worker, closing the port, clearing timers and pending requests, and removing registered DOM listeners.

## DOM bridge and sanitized innerHTML

The Worker cannot reach native DOM nodes; its synchronous-looking DOM proxy uses a local mirror for reads and sends mutations over the port without requiring `await`. Selectors are limited to tag names, `#id`, and `.class`.

`innerHTML` is opt-in. **No HTML string is ever handed to a browser HTML parser.** The Worker tokenizes a restricted subset into a structured tree, filters it with a host-supplied allowlist, and sends that tree over the port. The host validates it again, applies the `dom` policies, and constructs native nodes with `document.createElement`, `document.createTextNode`, `setAttribute`, and `style.setProperty`. Event-handler attributes, executable URLs, resource-loading CSS, active elements, `srcdoc`, `srcset`, `ping`, `outerHTML`, and `insertAdjacentHTML` remain blocked. `id` and `name` from HTML are virtualized in the mirror and not written to the host DOM, preventing DOM clobbering. Limits come from `dom.max*` and `dom.html.*`.

Unsafe attributes are stripped on the Worker side; any malformed or disallowed tree arriving at the host fails closed.

## Residual limitations

This is a strong, heavily metered sandbox — not a formally verified one.

- Correctness depends on the browser's origin, CSP, Worker, and `fetch` implementations. An engine bug can invalidate any layer.
- The realm lockdown is a curated denylist plus explicit denial of dynamic-compilation entry points, not a capability-safe allowlist. New browser APIs are not automatically covered. `script-src` must still allow `'unsafe-eval'`.
- There is no true memory quota. Steps, message bytes, DOM node counts, and storage bytes bound most growth paths, but JS heap allocation itself is not capped.
- Workers are not guaranteed to be in separate OS processes. Timing is coarse by default, but Spectre-class side channels are out of scope.
- `runtime.allowEval: true` or `execution.steps: Infinity` disables step metering; only heartbeat/wall-clock termination remains.
- Mediated `fetch` is issued from the host page with `credentials: "omit"`; the host page's own CSP applies and the target must allow CORS. WebSocket / EventSource are native and bounded by CSP origin allowlists plus construction counts rather than byte quotas.
- The host page's CSP must permit `about:srcdoc` frames. Grant DOM access only to a dedicated low-trust container: CSS can overlay host UI and listeners can observe input inside the root.

## Playground

`index.html` is a Chinese-language playground. Run a static server from the repository root and open it:

```sh
python3 -m http.server 8000
```

It exposes the process-scope tree (network patterns and methods, DOM tag/event allowlists, runtime globals, six live quotas) and host-scope concurrency separately. You can run a single process, launch four in parallel, and execute a two-phase dead-loop stress test that demonstrates both preemptive step budgeting and heartbeat fallback while the main-thread heartbeat keeps ticking.
