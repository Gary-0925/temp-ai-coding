# pperm.js

A browser library for creating JavaScript processes backed by dedicated Web Workers.

## Usage

```js
import pperm from "./pperm.js";

const process = pperm.create({
	permissions: {
		network: {
			fetch: true,
			webSocket: false,
			eventSource: false,
			xmlHttpRequest: false
		},
		storage: {
			indexedDB: false,
			cache: false
		},
		dom: {
			enabled: true,
			root: "#app"
		}
	}
});

process.addEventListener("message", event => console.log(event.detail));

const result = await process.run(`
	document.body.textContent = "Hello!";
	const button = await document.createElement("button");
	button.textContent = "Click me";
	await document.body.appendChild(button);

	await new Promise(resolve => {
		button.addEventListener("click", resolve, { once: true });
	});
	return await document.querySelector("button").textContent;
`);

console.log(result);
process.terminate();
```

## API

- `pperm.create({ permissions })` creates a worker-backed process.
- `process.run(code)` executes JavaScript and resolves with its completion value.
- `process.postMessage(value)` sends a message to the worker.
- `process.terminate()` terminates the worker.
- `message`, `error`, `exit`, and `terminate` events report process activity.

## Permissions

Network permissions can be configured independently: `network.fetch`, `network.webSocket`, `network.eventSource`, and `network.xmlHttpRequest`.

Storage permissions: `storage.indexedDB` and `storage.cache`.

DOM is disabled by default. Enable `dom.enabled` and set `dom.root` to the selector for the element exposed as the process's `document.body`. Within that root, the process can use familiar DOM expressions, including node creation/insertion and event listeners:

```js
document.body.textContent = "Hello";

const button = await document.createElement("button");
button.textContent = "Click me";
button.style.backgroundColor = "black";
await document.body.appendChild(button);

await new Promise(resolve => {
	button.addEventListener("click", resolve, { once: true });
});
```

The bridge maps returned DOM nodes to stable remote handles, supports node arguments for methods such as `appendChild`, and forwards common DOM events to the Worker. It supports `document.getElementById`, `getElementsByClassName`, `getElementsByTagName`, `createComment`, and `createDocumentFragment`, plus element-level `getElementsByClassName` and `getElementsByTagName`. Collection-returning helpers currently resolve to arrays of remote element proxies rather than live native `NodeList` or `HTMLCollection` objects. Event objects are snapshots/proxies rather than genuine browser `Event` instances, so methods such as `preventDefault()` cannot cancel the original event.

Because DOM operations cross the Worker/main-thread boundary, remote property reads and methods that return values are asynchronous; writes are queued asynchronously. This is not fully identical to synchronous browser DOM behavior.

## Runtime model and limitations

Each process runs in a dedicated Worker, so synchronous infinite loops do not block the page's main JavaScript thread. Workers do not have a native `document`; the `document` object exposed to process code is a proxy that forwards supported operations to the configured root element in the main thread.

This is a prototype permission layer, not a hardened security boundary. Hiding or replacing browser globals in a Worker cannot reliably isolate hostile JavaScript, and some globals are read-only or non-configurable. Do not run hostile code with this prototype.
