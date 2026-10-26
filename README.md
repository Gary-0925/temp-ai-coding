# pperm.js

A browser JavaScript runner that executes each script in a dedicated Worker, so a tight loop can be terminated without blocking the page's main thread. DOM calls keep a synchronous-looking API, with writes sent to the main thread through a message bridge.

## Usage

```js
import pperm from "./pperm.js";

const process = pperm.create({
	maxExecutionTimeMs: 10000,
	permissions: {
		network: { fetch: true, webSocket: false, eventSource: false, xmlHttpRequest: false },
		storage: { indexedDB: false, cache: false },
		dom: { enabled: true, root: "#app" }
	}
});

process.addEventListener("message", event => console.log(event.detail));
const result = await process.run(`
	document.body.textContent = "Hello!";
	const button = document.createElement("button");
	button.textContent = "Click me";
	button.style.backgroundColor = "black";
	document.body.appendChild(button);
	await new Promise(resolve => button.addEventListener("click", resolve, { once: true }));
	return document.querySelector("button").textContent;
`);
process.terminate();
```

Each process has its own Worker and can be terminated independently. Multiple calls can run concurrently:

```js
const first = pperm.create({ permissions: { dom: { enabled: false } } });
const second = pperm.create({ permissions: { dom: { enabled: false } } });
const firstRun = first.run('while (true) {}');
const secondRun = second.run('postMessage("still responsive");');
setTimeout(() => first.terminate(), 500);
await Promise.allSettled([firstRun, secondRun]);
second.terminate();
```

## API

- `pperm.create({ permissions, maxExecutionTimeMs })` creates a runner. The time limit defaults to 10000 ms.
- `process.run(code)` runs code in a dedicated Worker and resolves with its completion value.
- `process.postMessage(value)` dispatches a message event on the process.
- `process.terminate()` terminates the Worker, stops further script execution, and removes registered DOM event listeners. DOM listeners are also cleaned up when a run finishes or fails.
- `message`, `error`, and `terminate` events report process activity.
- `process.terminated` indicates whether termination has been requested.

## DOM bridge limitations

DOM is disabled by default. Enable `dom.enabled` and set `dom.root` to the element exposed as `document.body`. The Worker cannot access native DOM nodes directly. Its synchronous-looking DOM proxy uses a local mirror for reads and sends mutations to the main thread asynchronously, without requiring `await` in user code.

Currently supported selectors are simple tag names, `#id`, and `.class`. The bridge supports common reflected properties, style assignments and `setProperty`/`getPropertyValue`/`removeProperty`, class lists, text nodes, document fragments, node cloning, `append`/`prepend`/`insertBefore`/`replaceChild`, basic tree mutation, and event listeners. `innerHTML`, compound selectors, and fully transparent native DOM semantics are not supported. Because mutations are queued to the main thread, layout/computed-style reads and browser-generated values are not guaranteed to reflect the latest native DOM state.

## Execution and security

A dedicated Worker lets the main thread's timeout terminate a script even when the script is stuck in a synchronous infinite loop. This protects the page's main thread from user-code CPU loops, though it cannot guarantee that browser internals, expensive DOM mutations, or other browser processes never stall. Workers do not provide a hardened security sandbox: hostile code may still access Worker globals and bypass some API permission wrappers. Do not treat this library as a secure environment for arbitrary malicious code.
