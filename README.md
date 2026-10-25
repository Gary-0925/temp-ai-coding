# pperm.js

A small browser library for creating JavaScript processes backed by dedicated Web Workers.

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

process.addEventListener("message", event => {
	console.log(event.detail);
});

const result = await process.run(`
	postMessage("Hello from pperm.js");
	await dom.setText("#status", "Updated by process");
	return await dom.getText("#status");
`);

console.log(result);
process.terminate();
```

## API

- `pperm.create({ permissions })` creates a worker-backed process.
- `process.run(code)` executes JavaScript and resolves with the completion value.
- `process.postMessage(value)` sends a message to the worker.
- `process.terminate()` terminates the worker.
- `message`, `error`, `exit`, and `terminate` events report process activity.
- `process.terminated` indicates whether the process has been terminated.

## Permissions

Network permissions can be configured independently:

- `network.fetch`
- `network.webSocket`
- `network.eventSource`
- `network.xmlHttpRequest`

Storage permissions:

- `storage.indexedDB`
- `storage.cache`

DOM access is disabled by default. Set `dom.enabled: true` and choose a root selector with `dom.root`. The process can only address descendants of that root through the asynchronous `dom` bridge:

- `await dom.querySelector(selector)` returns basic information about a matching element.
- `await dom.getText(selector)` reads text content.
- `await dom.setText(selector, value)` replaces text content.
- `await dom.appendText(selector, value)` appends a text node.
- `await dom.setAttribute(selector, name, value)` sets an attribute.

The selector is evaluated relative to the configured root. The bridge does not provide a real `document` or native DOM objects inside the Worker.

For backward compatibility, `network: false` and `storage: false` disable all APIs in their respective groups. Permission flags default to enabled for network and storage, while DOM is disabled by default.

## Runtime model and limitations

Each process runs in a dedicated Worker, so synchronous infinite loops do not block the page's main JavaScript thread. Workers do not expose `document` or direct DOM access.

This is a prototype permission layer, not a hardened security boundary. Replacing or hiding browser APIs inside a Worker cannot reliably isolate hostile JavaScript, and some browser globals may be non-configurable. Do not run untrusted hostile code with this prototype. Browser permissions, origin policy, and CORS remain controlled by the browser.
