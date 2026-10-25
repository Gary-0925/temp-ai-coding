const running = new Set();
const domPending = new Map();
const proxyRefs = new WeakMap();
const elementProxies = new Map();
const eventCallbacks = new Map();
let nextDomRequestId = 0;
let nextListenerId = 0;
let currentPermissions = {};

function deny(name) {
	return () => {
		throw new DOMException(name + " permission denied", "NotAllowedError");
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
		if (network[key] === false) hideGlobal(globalName, deny(globalName));
	}

	if (storage.indexedDB === false) hideGlobal("indexedDB");
	if (storage.cache === false) hideGlobal("caches");
}

function requestDom(operation, target, args = {}) {
	target ??= { nodeType: "root" };
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

function encode(value) {
	if (value && typeof value === "object") {
		const ref = proxyRefs.get(value);
		if (ref) return { __ppermTarget: true, target: ref };
		if (Array.isArray(value)) return value.map(encode);
	}
	return value;
}

function revive(value) {
	if (Array.isArray(value)) return value.map(revive);
	if (value && typeof value === "object") {
		if (value.__ppermNode === true) return createElementProxy({ nodeId: value.nodeId }, value);
		return value;
	}
	return value;
}

const elementMethods = new Set([
	"querySelector", "querySelectorAll", "getAttribute", "getAttributeNames",
	"setAttribute", "removeAttribute", "hasAttribute", "toggleAttribute",
	"append", "prepend", "appendChild", "insertBefore", "replaceChild",
	"replaceChildren", "before", "after", "remove", "focus", "blur", "click",
	"matches", "closest", "contains", "cloneNode", "normalize", "scrollIntoView",
	"hasAttributes", "isEqualNode", "isSameNode", "getBoundingClientRect",
	"getClientRects", "setPointerCapture", "releasePointerCapture",
	"hasPointerCapture", "getRootNode"
]);

function createElementProxy(reference, metadata = {}) {
	reference ??= { nodeType: "root" };
	const cacheKey = reference.nodeId ? "n:" + reference.nodeId : "s:" + JSON.stringify(reference);
	if (elementProxies.has(cacheKey)) return elementProxies.get(cacheKey);

	const listeners = new Map();
	const proxy = new Proxy(Object.create(null), {
		get(_, property) {
			if (property === Symbol.toStringTag) return metadata.nodeType === 3 ? "Text" : "HTMLElement";
			if (property === "then") return undefined;
			if (property === "toString") return () => "[object " + (metadata.tagName || "HTMLElement") + "]";
			if (property === "nodeType" && metadata.nodeType) return metadata.nodeType;
			if (property === "nodeName" && metadata.nodeName) return metadata.nodeName;
			if (property === "tagName" && metadata.tagName) return metadata.tagName;
			if (property === "style") return createStyleProxy(reference);
			if (property === "classList") return createClassListProxy(reference);
			if (property === "querySelector") {
				return selector => createElementProxy({ parent: reference, selector: String(selector) });
			}
			if (property === "querySelectorAll") {
				return async selector => revive(await requestDom("querySelectorAll", reference, { selector: String(selector) }));
			}
			if (property === "addEventListener") {
				return (eventType, callback, options) => {
					if (typeof callback !== "function") return;
					const listenerId = ++nextListenerId;
					const key = String(eventType) + ":" + String(listenerId);
					listeners.set(key, { eventType: String(eventType), callback, options, listenerId });
					eventCallbacks.set(listenerId, { callback, reference, eventType: String(eventType) });
					requestDom("event-listener-add", reference, {
						eventType: String(eventType), listenerId, options: typeof options === "boolean" ? options : (options ? { capture: !!options.capture, once: !!options.once, passive: !!options.passive } : false)
					}).catch(reportAsyncError);
				};
			}
			if (property === "removeEventListener") {
				return (eventType, callback) => {
					for (const [key, entry] of listeners) {
						if (entry.eventType === String(eventType) && entry.callback === callback) {
							listeners.delete(key);
							eventCallbacks.delete(entry.listenerId);
							requestDom("event-listener-remove", reference, { eventType: String(eventType), listenerId: entry.listenerId }).catch(reportAsyncError);
						}
					}
				};
			}
			if (elementMethods.has(property)) {
				return (...args) => requestDom("call", reference, {
					method: String(property),
					args: args.map(encode)
				}).then(revive);
			}
			return requestDom("get", reference, { property: String(property) }).then(revive);
		},
		set(_, property, value) {
			requestDom("set", reference, {
				property: String(property),
				value: encode(value)
			}).catch(reportAsyncError);
			return true;
		},
		has(_, property) {
			return ["style", "classList", "querySelector", "querySelectorAll", "addEventListener", "removeEventListener"].includes(String(property)) || elementMethods.has(property);
		}
	});

	proxyRefs.set(proxy, reference);
	elementProxies.set(cacheKey, proxy);
	return proxy;
}

function createStyleProxy(reference) {
	return new Proxy(Object.create(null), {
		get(_, property) {
			if (property === "setProperty") return (name, value, priority = "") => requestDom("style-method", reference, { method: "setProperty", args: [String(name), String(value), String(priority)] });
			if (property === "removeProperty") return name => requestDom("style-method", reference, { method: "removeProperty", args: [String(name)] });
			if (property === "getPropertyValue") return name => requestDom("style-method", reference, { method: "getPropertyValue", args: [String(name)] });
			return requestDom("style-get", reference, { property: String(property) });
		},
		set(_, property, value) {
			requestDom("style-set", reference, { property: String(property), value: String(value) }).catch(reportAsyncError);
			return true;
		}
	});
}

function createClassListProxy(reference) {
	return new Proxy(Object.create(null), {
		get(_, method) {
			if (method === "length") return requestDom("get", reference, { property: "className" }).then(value => String(value ?? "").split(/\s+/).filter(Boolean).length);
			if (method === "item") return index => requestDom("classList", reference, { method: "item", args: [index] });
			if (method === "contains") return (...args) => requestDom("classList", reference, { method: "contains", args });
			if (["add", "remove", "toggle", "replace"].includes(String(method))) {
				return (...args) => requestDom("classList", reference, { method: String(method), args });
			}
			return undefined;
		}
	});
}

function createDocumentProxy() {
	return new Proxy(Object.create(null), {
		get(_, property) {
			if (property === "body" || property === "documentElement") return createElementProxy(null);
			if (property === "querySelector") return selector => createElementProxy({ parent: null, selector: String(selector) });
			if (property === "querySelectorAll") return async selector => revive(await requestDom("querySelectorAll", null, { selector: String(selector) }));
			if (property === "createElement") return async tagName => revive(await requestDom("createElement", null, { tagName: String(tagName) }));
			if (property === "createTextNode") return async text => revive(await requestDom("createTextNode", null, { text: String(text) }));
			if (property === "addEventListener") return (type, callback, options) => createElementProxy(null).addEventListener(type, callback, options);
			return requestDom("document-get", null, { property: String(property) });
		}
	});
}

function reportAsyncError(error) {
	self.postMessage({ type: "error", error: {
		name: error?.name ?? "Error",
		message: error?.message ?? String(error)
	} });
}

self.addEventListener("message", async ({ data }) => {
	if (data.type === "message") {
		self.postMessage({ type: "message", value: data.value });
		return;
	}

	if (data.type === "dom-event") {
		const entry = eventCallbacks.get(data.listenerId);
		if (entry) {
			const eventData = data.event ?? {};
			const event = {
				...eventData,
				target: revive(eventData.target),
				currentTarget: revive(eventData.currentTarget),
				preventDefault() {},
				stopPropagation() {},
				stopImmediatePropagation() {},
				composedPath() { return [this.target, this.currentTarget].filter(Boolean); }
			};
			try {
				entry.callback.call(createElementProxy(entry.reference), event);
			} catch (error) {
				reportAsyncError(error);
			}
		}
		return;
	}

	if (data.type === "dom-result") {
		const pending = domPending.get(data.id);
		if (pending) {
			domPending.delete(data.id);
			data.error
				? pending.reject(Object.assign(new Error(data.error.message), { name: data.error.name ?? "Error" }))
				: pending.resolve(data.value);
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
			currentPermissions.dom?.enabled ? createDocumentProxy() : undefined
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
