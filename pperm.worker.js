const running = new Set();
const domPending = new Map();
let nextDomRequestId = 0;

function deny(name) {
	return () => {
		throw new DOMException(`${name} permission denied`, "NotAllowedError");
	};
}

function hideGlobal(name, value = undefined) {
	try {
		Object.defineProperty(globalThis, name, {
			configurable: true,
			value,
			writable: false
		});
	} catch {}
}

function applyPermissions(permissions) {
	const network = permissions.network ?? {};
	const storage = permissions.storage ?? {};

	for (const [key, globalName] of [
		["fetch", "fetch"],
		["webSocket", "WebSocket"],
		["eventSource", "EventSource"],
		["xmlHttpRequest", "XMLHttpRequest"]
	]) {
		if (network[key] === false) {
			hideGlobal(globalName, deny(globalName));
		}
	}

	if (storage.indexedDB === false) hideGlobal("indexedDB");
	if (storage.cache === false) hideGlobal("caches");
}

function requestDom(operation, target, args = {}) {
	if (!currentPermissions.dom?.enabled) {
		return Promise.reject(new DOMException("DOM permission denied", "NotAllowedError"));
	}

	const id = ++nextDomRequestId;
	return new Promise((resolve, reject) => {
		domPending.set(id, { resolve, reject });
		self.postMessage({
			type: "dom-request",
			id,
			operation,
			target,
			args,
			root: currentPermissions.dom.root
		});
	});
}

let currentPermissions = {};

function createElementProxy(selector) {
	const elementMethods = new Set([
		"querySelector",
		"querySelectorAll",
		"getAttribute",
		"setAttribute",
		"removeAttribute",
		"hasAttribute",
		"append",
		"prepend",
		"remove",
		"focus",
		"blur",
		"click"
	]);

	return new Proxy(Object.create(null), {
		get(_, property) {
			if (property === Symbol.toStringTag) return "HTMLElement";
			if (property === "then") return undefined;
			if (property === "toString") return () => "[object HTMLElement]";
			if (property === "querySelector") {
				return query => createElementProxy({ parent: selector, selector: String(query) });
			}
			if (property === "querySelectorAll") {
				return async query => {
					const items = await requestDom("querySelectorAll", selector, { selector: String(query) });
					return items.map(item => createElementProxy(item));
				};
			}
			if (elementMethods.has(property)) {
				return (...args) => requestDom("call", selector, {
					method: property,
					args
				});
			}
			if (property === "style") {
				return createStyleProxy(selector);
			}
			if (property === "classList") {
				return new Proxy(Object.create(null), {
					get(_, method) {
						return (...args) => requestDom("classList", selector, {
							method,
							args
						});
					}
				});
			}
			return requestDom("get", selector, { property: String(property) });
		},
		set(_, property, value) {
			requestDom("set", selector, {
				property: String(property),
				value
			}).catch(error => self.postMessage({ type: "error", error: {
				name: error.name,
				message: error.message
			} }));
			return true;
		}
	});
}

function createStyleProxy(selector) {
	return new Proxy(Object.create(null), {
		get(_, property) {
			return requestDom("style-get", selector, { property: String(property) });
		},
		set(_, property, value) {
			requestDom("style-set", selector, {
				property: String(property),
				value: String(value)
			}).catch(error => self.postMessage({ type: "error", error: {
				name: error.name,
				message: error.message
			} }));
			return true;
		}
	});
}

function createDocumentProxy() {
	return new Proxy(Object.create(null), {
		get(_, property) {
			if (property === "body" || property === "documentElement") {
				return createElementProxy(null);
			}
			if (property === "querySelector") {
				return selector => createElementProxy({ parent: null, selector: String(selector) });
			}
			if (property === "querySelectorAll") {
				return async selector => {
					const items = await requestDom("querySelectorAll", null, { selector: String(selector) });
					return items.map(item => createElementProxy(item));
				};
			}
			if (property === "createElement") {
				return tagName => ({
					__ppermElement: true,
					tagName: String(tagName)
				});
			}
			if (property === "createTextNode") {
				return text => ({ __ppermText: String(text) });
			}
			return requestDom("document-get", null, { property: String(property) });
		}
	});
}

self.addEventListener("message", async ({ data }) => {
	if (data.type === "message") {
		self.postMessage({ type: "message", value: data.value });
		return;
	}

	if (data.type === "dom-result") {
		const pending = domPending.get(data.id);
		if (pending) {
			domPending.delete(data.id);
			data.error ? pending.reject(Object.assign(new Error(data.error.message), { name: data.error.name ?? "Error" })) : pending.resolve(data.value);
		}
		return;
	}

	if (data.type !== "run" || running.has(data.id)) return;

	running.add(data.id);
	currentPermissions = data.permissions ?? {};

	try {
		applyPermissions(currentPermissions);
		const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
		const execute = new AsyncFunction(
			"postMessage",
			"permissions",
			"document",
			data.code
		);

		const value = await execute(
			value => self.postMessage({ type: "message", value }),
			Object.freeze({ ...currentPermissions }),
			currentPermissions.dom?.enabled
				? createDocumentProxy()
				: undefined
		);

		self.postMessage({ type: "result", id: data.id, value });
	} catch (error) {
		self.postMessage({
			type: "error",
			id: data.id,
			error: {
				name: error?.name ?? "Error",
				message: error?.message ?? String(error)
			}
		});
	} finally {
		running.delete(data.id);
		self.postMessage({ type: "exit", id: data.id });
	}
});
