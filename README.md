# pperm.js

A small browser library for creating JavaScript processes backed by dedicated Web Workers.

## Usage

```js
import pperm from "./pperm.js";

const process = pperm.create({
	permissions: {
		network: false,
		storage: false
	}
});

process.addEventListener("message", event => {
	console.log(event.detail);
});

process.addEventListener("error", event => {
	console.error(event.detail);
});

const result = await process.run(`
	postMessage("Hello from pperm.js");
	42
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

Available permission flags are `network` and `storage`. Both default to enabled.

## Runtime model

Each process runs in a dedicated Worker, so synchronous infinite loops do not block the page's main JavaScript thread. Workers do not expose `document` or direct DOM access.

Permission flags currently disable common APIs inside the worker, but they are not a hardened security boundary: code running in the worker may be able to reach underlying platform APIs or bypass API replacements. Do not execute hostile code with this prototype. Browser permissions, origin policy, and CORS remain controlled by the browser.
