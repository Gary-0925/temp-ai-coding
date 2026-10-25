# pperm.js

A small browser JavaScript runner with synchronous DOM access and configurable prototype-level permissions.

## Usage

~~~js
import pperm from "./pperm.js";

const process = pperm.create({
	maxStatements: 100000,
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

const result = await process.run(
	'document.body.textContent = "Hello!";' +
	'const button = document.createElement("button");' +
	'button.textContent = "Click me";' +
	'button.style.backgroundColor = "black";' +
	'document.body.appendChild(button);' +
	'await new Promise(resolve => button.addEventListener("click", resolve, { once: true }));' +
	'return document.querySelector("button").textContent;'
);

console.log(result);
process.terminate();
~~~

DOM operations are synchronous, so DOM access and mutation do not require await. process.run() is asynchronous because user code may itself use await.

## API

- pperm.create({ permissions, maxExecutionTimeMs }) creates a process runner. The time limit defaults to 10000 ms.
- process.run(code) executes JavaScript and resolves with its completion value.
- process.postMessage(value) dispatches a message event on the process.
- process.terminate() marks the process as terminated, removes its registered DOM listeners, and makes later guarded operations fail.
- message, error, and terminate events report process activity.
- process.terminated indicates whether termination has been requested.

## Permissions

Network permissions: network.fetch, network.webSocket, network.eventSource, and network.xmlHttpRequest.

Storage permissions: storage.indexedDB and storage.cache.

DOM is disabled by default. Enable dom.enabled and set dom.root to the selector for the element exposed as the process's document.body. DOM queries are scoped to that root, and the bridge blocks common operations that would remove/move the root or insert siblings outside it.

The bridge supports document.querySelector, querySelectorAll, getElementById, getElementsByClassName, getElementsByTagName, createElement, createTextNode, createComment, createDocumentFragment, activeElement, and common element methods, properties, styles, class lists, and event listeners. Collection-returning helpers return arrays rather than live native NodeList or HTMLCollection objects.

## Execution time limit

Before execution, Acorn parses the code and the runner inserts a deadline check at each executable statement and block entry. Acorn is declared as an npm dependency; the standalone Playground resolves it through an import map to esm.sh. The per-run wall-clock limit is controlled by maxExecutionTimeMs (default: 10000 ms). Exceeding the deadline throws a TimeoutError. The same deadline checks catch tight loops, while a timer also ends runs waiting on asynchronous work; a timeout terminates that process and removes its registered DOM listeners.

This is a best-effort time limit, not a hard execution sandbox. A long-running expression or blocking native call can still block the main thread until it returns to an injected check, so the timer cannot fire while the thread is blocked. Code that bypasses instrumented paths may also evade checks. For hard preemptive termination, execution needs a separate execution context such as a Worker, which cannot directly provide synchronous access to the page's native DOM.

## Security limitations

This library does not provide a hardened sandbox. User code executes on the page's main thread and can access globals such as globalThis, potentially bypassing the prototype-level network/storage restrictions. Do not execute untrusted or hostile code with this library. For strong isolation and preemptive termination, execution must be moved to a separate execution context such as a Worker, which cannot provide synchronous access to the page's native DOM.
