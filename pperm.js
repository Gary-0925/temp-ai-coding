const defaults = {
	network: { fetch: true, webSocket: true, eventSource: true, xmlHttpRequest: true },
	storage: { indexedDB: true, cache: true },
	dom: { enabled: false, root: "body" }
};

function normalizePermissions(permissions = {}) {
	const network = permissions.network ?? {};
	const storage = permissions.storage ?? {};
	const dom = permissions.dom ?? {};
	return {
		network: Object.fromEntries(Object.keys(defaults.network).map(key => [key, network[key] ?? defaults.network[key]])),
		storage: Object.fromEntries(Object.keys(defaults.storage).map(key => [key, storage[key] ?? defaults.storage[key]])),
		dom: {
			enabled: dom.enabled ?? defaults.dom.enabled,
			root: typeof dom.root === "string" ? dom.root : defaults.dom.root
		}
	};
}

const blockedElementNames = new Set([
	"script", "iframe", "frame", "frameset", "object", "embed", "applet",
	"base", "meta", "link", "style", "svg", "math", "portal", "fencedframe",
	"webview"
]);
const blockedPropertyNames = new Set([
	"innerHTML", "outerHTML", "srcdoc", "insertAdjacentHTML", "setHTMLUnsafe",
	"setHTML", "outerText", "innerText", "__proto__", "prototype", "constructor",
	"formAction", "action"
]);
const urlPropertyNames = new Set(["href", "src", "poster", "cite", "background", "data", "manifest"]);
const urlAttributeNames = new Set([
	"href", "src", "action", "formaction", "poster", "cite", "xlink:href",
	"background", "data", "manifest"
]);

function assertSafeElementName(value) {
	const name = String(value).toLowerCase();
	if (!/^[a-z][a-z0-9-]*$/.test(name) || name.includes("-") || blockedElementNames.has(name)) {
		throw new DOMException("Element type is not permitted by the DOM bridge", "NotAllowedError");
	}
	return name;
}

function assertSafeAttribute(name, value) {
	name = String(name).toLowerCase();
	if (!/^[a-z_:][a-z0-9_.:-]*$/.test(name) || name.startsWith("on") ||
		["srcdoc", "nonce", "integrity", "is", "formaction", "action"].includes(name)) {
		throw new DOMException("Attribute is not permitted by the DOM bridge: " + name, "NotAllowedError");
	}
	if (urlAttributeNames.has(name)) {
		const url = String(value).trim().replace(/[\u0000-\u0020]+/g, "");
		if (/^(javascript|vbscript):/i.test(url) ||
			/^data:(text\/html|application\/xhtml\+xml)/i.test(url)) {
			throw new DOMException("Executable URLs are not permitted by the DOM bridge", "NotAllowedError");
		}
	}
	return name;
}

function assertSafeProperty(name, value) {
	name = String(name);
	if (blockedPropertyNames.has(name) || name.startsWith("__") || /^on[a-z]+$/i.test(name)) {
		throw new DOMException("DOM property is not permitted by the bridge: " + name, "NotAllowedError");
	}
	if (urlPropertyNames.has(name)) assertSafeAttribute(name.toLowerCase(), value);
	return name;
}

function assertSafeStyle(property, value) {
	const css = String(value);
	if (/url\s*\(|expression\s*\(|@import|-moz-binding|behavior\s*:|\\|\/\*/i.test(css)) {
		throw new DOMException("CSS resource loading and executable CSS are not permitted by the DOM bridge", "NotAllowedError");
	}
	return String(property);
}

function snapshotNode(node, ids, state) {
	const id = state.nextId++;
	ids.set(id, node);
	const attributes = {};
	if (node.nodeType === 1) {
		for (const attr of node.attributes) attributes[attr.name] = attr.value;
	}
	const styleData = {};
	if (node.nodeType === 1) {
		for (let i = 0; i < node.style.length; i++) {
			const name = node.style[i];
			styleData[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = node.style.getPropertyValue(name);
		}
	}
	return {
		id,
		nodeType: node.nodeType,
		tagName: node.nodeType === 1 ? node.tagName : node.nodeName,
		idName: node.nodeType === 1 ? node.id : "",
		className: node.nodeType === 1 ? node.className : "",
		text: node.nodeType === 3 || node.nodeType === 8 ? node.nodeValue ?? "" : "",
		attributes,
		styleData,
		children: Array.from(node.childNodes, child => snapshotNode(child, ids, state))
	};
}

function createNativeNode(data, ids) {
	let node;
	if (data.nodeType === 3) node = document.createTextNode(data.text ?? "");
	else if (data.nodeType === 8) node = document.createComment(data.text ?? "");
	else if (data.nodeType === 11) node = document.createDocumentFragment();
	else {
		const tagName = assertSafeElementName(data.tagName ?? "div");
		node = document.createElement(tagName);
		for (const [name, value] of Object.entries(data.attributes ?? {})) {
			try {
				const safeName = assertSafeAttribute(name, value);
				if (safeName === "style") assertSafeStyle("style", value);
				node.setAttribute(safeName, String(value));
			} catch (error) {
				if (error?.name === "NotAllowedError") throw error;
			}
		}
		for (const [name, value] of Object.entries(data.styleData ?? {})) {
			try { node.style[assertSafeStyle(name, value)] = String(value); } catch (error) {
				if (error?.name === "NotAllowedError") throw error;
			}
		}
		if (data.text) node.textContent = data.text;
	}
	ids.set(data.id, node);
	for (const child of data.children ?? []) node.appendChild(createNativeNode(child, ids));
	return node;
}

class DomPermissionPolicy {
	constructor(permissions) {
		this.permissions = permissions;
	}

	check() {
		if (!this.permissions.dom.enabled) {
			throw new DOMException("DOM permission is not enabled", "NotAllowedError");
		}
	}

	checkElement(name) {
		this.check();
		return assertSafeElementName(name);
	}

	checkAttribute(name, value) {
		this.check();
		return assertSafeAttribute(name, value);
	}

	checkProperty(name, value) {
		this.check();
		return assertSafeProperty(name, value);
	}

	checkStyle(property, value) {
		this.check();
		return assertSafeStyle(property, value);
	}
}

class DomBridge {
	constructor(permissions) {
		this.permissions = permissions;
		this.policy = new DomPermissionPolicy(permissions);
	}

	apply(message, ids, root) {
		this.policy.check();
		const target = ids.get(message.id);
		if (!target && message.op !== "documentTitle") {
			throw new DOMException("Unknown DOM bridge node", "NotFoundError");
		}
		switch (message.op) {
			case "documentTitle": return this.setDocumentTitle(message);
			case "text": return this.setText(target, message);
			case "style": return this.setStyle(target, message);
			case "attribute": return this.setAttribute(target, message);
			case "removeAttribute": return this.removeAttribute(target, message);
			case "property": return this.setProperty(target, message);
			case "append": return this.appendChild(target, message, ids);
			case "insert": return this.insertBefore(target, message, ids);
			case "remove": return this.removeChild(target, message, ids, root);
			case "focus": return this.focus(target);
			case "blur": return this.blur(target);
			default: throw new DOMException("Unsupported DOM bridge operation: " + message.op, "NotSupportedError");
		}
	}

	setDocumentTitle(message) {
		this.policy.check();
		document.title = String(message.value);
	}

	setText(target, message) {
		this.policy.check();
		target.textContent = String(message.value);
	}

	setStyle(target, message) {
		this.policy.check();
		const property = this.policy.checkStyle(message.property, message.value);
		if (property.includes("-")) {
			if (message.value === "") target.style.removeProperty(property);
			else target.style.setProperty(property, String(message.value), message.priority ?? "");
		} else target.style[property] = String(message.value);
	}

	setAttribute(target, message) {
		this.policy.check();
		const name = this.policy.checkAttribute(message.name, message.value);
		if (name === "style") this.policy.checkStyle("style", message.value);
		target.setAttribute(name, String(message.value));
	}

	removeAttribute(target, message) {
		this.policy.check();
		const name = String(message.name).toLowerCase();
		if (!/^[a-z_:][a-z0-9_.:-]*$/.test(name) || name.startsWith("on") ||
			["srcdoc", "nonce", "integrity", "is", "action", "formaction"].includes(name)) {
			throw new DOMException("Attribute is not permitted by the DOM bridge: " + name, "NotAllowedError");
		}
		target.removeAttribute(name);
	}

	setProperty(target, message) {
		this.policy.check();
		const property = this.policy.checkProperty(message.property, message.value);
		if (typeof message.value === "function" || (message.value !== null && typeof message.value === "object")) {
			throw new DOMException("DOM property value must be a serializable primitive", "NotAllowedError");
		}
		target[property] = message.value;
	}

	appendChild(target, message, ids) {
		this.policy.check();
		const child = createNativeNode(message.child, ids);
		if (child === root || child.contains?.(root)) throw new DOMException("Cannot move the permitted root", "NotAllowedError");
		target.appendChild(child);
	}

	insertBefore(target, message, ids) {
		this.policy.check();
		const before = message.beforeId == null ? null : ids.get(message.beforeId);
		if (message.beforeId != null && !before) throw new DOMException("Unknown reference node", "NotFoundError");
		const child = createNativeNode(message.child, ids);
		if (child === root || child.contains?.(root)) throw new DOMException("Cannot move the permitted root", "NotAllowedError");
		target.insertBefore(child, before);
	}

	removeChild(target, message, ids, root) {
		this.policy.check();
		const child = ids.get(message.childId);
		if (!child || child.parentNode !== target) throw new DOMException("Node is not a child", "NotFoundError");
		if (child === root) throw new DOMException("Cannot remove the permitted root", "NotAllowedError");
		target.removeChild(child);
	}

	focus(target) {
		this.policy.check();
		target.focus();
	}

	blur(target) {
		this.policy.check();
		target.blur();
	}
}

export class PpermProcess extends EventTarget {
	#terminated = false;
	#worker = null;
	#timer = null;
	#resolveTermination;
	#terminationPromise;
	#running = false;
	#finish = null;
	#maxExecutionTimeMs;
	#root = null;
	#nodeIds = new Map();
	#domBridge;

	constructor(options = {}) {
		super();
		const permissions = options.permissions ?? options;
		this.permissions = Object.freeze(normalizePermissions(permissions));
		this.#domBridge = new DomBridge(this.permissions);
		this.#maxExecutionTimeMs = Math.max(1, Number(options.maxExecutionTimeMs) || 10000);
		this.#terminationPromise = new Promise(resolve => { this.#resolveTermination = resolve; });
		if (this.permissions.dom.enabled) {
			this.#root = document.querySelector(this.permissions.dom.root);
			if (!this.#root) throw new Error("DOM root not found: " + this.permissions.dom.root);
		}
	}

	run(code) {
		if (this.#terminated) return Promise.reject(new DOMException("Process has been terminated", "AbortError"));
		if (this.#running) return Promise.reject(new Error("A pperm process can run only one script at a time"));
		this.#running = true;

		return new Promise((resolve, reject) => {
			let settled = false;
			let snapshot;
			const finish = (error, value) => {
				if (settled) return;
				settled = true;
				clearTimeout(this.#timer);
				this.#timer = null;
				this.#worker?.terminate();
				this.#worker = null;
				this.#running = false;
				for (const entry of this.#domListeners) {
					entry.target.removeEventListener(entry.type, entry.handler, { capture: !!entry.capture });
				}
				this.#domListeners = [];
				this.#pendingListeners = [];
				if (error) {
					this.dispatchEvent(new CustomEvent("error", { detail: error }));
					reject(error);
				} else resolve(value);
			};
			this.#finish = finish;
			if (this.#terminated) {
				finish(new DOMException("Process has been terminated", "AbortError"));
				return;
			}

			try {
				if (this.#root) {
					this.#nodeIds = new Map();
					snapshot = snapshotNode(this.#root, this.#nodeIds, { nextId: 1 });
				} else {
					snapshot = { id: 1, nodeType: 1, tagName: "BODY", idName: "", className: "", text: "", attributes: {}, styleData: {}, children: [] };
					this.#nodeIds = new Map();
				}
				this.#worker = new Worker(new URL("./pperm-worker.js?v=20261026-14", import.meta.url));
				this.#worker.addEventListener("message", event => {
					if (settled || this.#terminated) return;
					const message = event.data;
					try {
						if (message.type === "userMessage") this.dispatchEvent(new CustomEvent("message", { detail: message.value }));
						else if (message.type === "dom") {
							if (!this.#root) throw new DOMException("DOM permission is not enabled", "NotAllowedError");
							this.#domBridge.apply(message, this.#nodeIds, this.#root);
							const pending = this.#pendingListeners.splice(0);
							for (const item of pending) this.#attachListener(item);
						} else if (message.type === "listen") this.#attachListener(message);
						else if (message.type === "unlisten") {
							for (const entry of this.#domListeners) {
								if (entry.listenerId === message.listenerId) entry.target.removeEventListener(entry.type, entry.handler, { capture: !!entry.capture });
							}
							this.#domListeners = this.#domListeners.filter(entry => entry.listenerId !== message.listenerId);
						} else if (message.type === "documentTitle") {
							if (!this.#root) throw new DOMException("DOM permission is not enabled", "NotAllowedError");
							document.title = String(message.value);
						}
						else if (message.type === "dispatch") this.#dispatchWorkerEvent(message);
						else if (message.type === "done") finish(null, message.value);
						else if (message.type === "error") {
							const error = new Error(message.error?.message ?? "Worker execution failed");
							error.name = message.error?.name ?? "Error";
							if (message.error?.stack) error.stack = message.error.stack;
							finish(error);
						}
					} catch (error) {
						finish(error);
					}
				});
				this.#worker.addEventListener("error", event => {
					event.preventDefault();
					const error = new Error(event.message || "Worker failed");
					error.name = "WorkerError";
					finish(error);
				});
				this.#worker.postMessage({
					type: "init",
					code: String(code),
					permissions: this.permissions,
					snapshot
				});
				this.#timer = setTimeout(() => {
					const error = new DOMException("Execution stopped: time limit exceeded", "TimeoutError");
					finish(error);
					this.terminate();
				}, this.#maxExecutionTimeMs);
			} catch (error) {
				finish(error);
			}
		});
	}

	#domListeners = [];
	#pendingListeners = [];

	#dispatchWorkerEvent(message) {
		this.#domBridge.policy.check();
		const target = this.#nodeIds.get(message.id);
		if (!target || !this.#worker) throw new DOMException("Unknown event target", "NotFoundError");
		const type = String(message.event?.type ?? "");
		if (!type) throw new TypeError("Event type is required");
		const path = [];
		for (let node = target; node; node = node.parentNode) {
			path.push(node);
			if (!message.event?.bubbles) break;
		}
		const eventData = {
			...message.event,
			type,
			targetId: message.id,
			bubbles: !!message.event?.bubbles,
			cancelable: !!message.event?.cancelable
		};
		const deliver = (node, capture) => {
			for (const entry of [...this.#domListeners]) {
				if (entry.target !== node || entry.type !== type || !!entry.capture !== capture) continue;
				this.#worker?.postMessage({ type: "event", listenerId: entry.listenerId, event: eventData });
				if (entry.once) {
					entry.target.removeEventListener(entry.type, entry.handler, { capture: !!entry.capture });
					this.#domListeners = this.#domListeners.filter(item => item !== entry);
				}
			}
		};
		for (const node of [...path].reverse()) deliver(node, true);
		for (const node of path) deliver(node, false);
	}

	#findNodeId(target) {
		for (const [id, node] of this.#nodeIds) if (node === target) return id;
		return null;
	}

	#attachListener(message) {
		const target = this.#nodeIds.get(message.id);
		if (!target) {
			this.#pendingListeners.push(message);
			return;
		}
		const handler = nativeEvent => {
			if (this.#terminated || !this.#worker) return;
			this.#worker.postMessage({
				type: "event",
				listenerId: message.listenerId,
				event: {
					type: nativeEvent.type,
					detail: nativeEvent.detail ?? null,
					targetId: this.#findNodeId(nativeEvent.target),
					bubbles: !!nativeEvent.bubbles,
					cancelable: !!nativeEvent.cancelable
				}
			});
			if (message.once) {
				target.removeEventListener(message.eventType, handler, { capture: !!message.capture });
				this.#domListeners = this.#domListeners.filter(entry => entry.handler !== handler);
			}
		};
		target.addEventListener(message.eventType, handler, { once: !!message.once, capture: !!message.capture });
		this.#domListeners.push({ target, type: message.eventType, handler, listenerId: message.listenerId, once: !!message.once, capture: !!message.capture });
	}

	postMessage(value) {
		if (this.#terminated) throw new DOMException("Process has been terminated", "AbortError");
		this.dispatchEvent(new CustomEvent("message", { detail: value }));
	}

	terminate() {
		if (this.#terminated) return;
		this.#terminated = true;
		clearTimeout(this.#timer);
		this.#timer = null;
		this.#worker?.postMessage({ type: "shutdown" });
		this.#worker?.terminate();
		this.#worker = null;
		for (const entry of this.#domListeners) {
			entry.target.removeEventListener(entry.type, entry.handler, { capture: !!entry.capture });
		}
		this.#domListeners = [];
		this.#pendingListeners = [];
		this.#resolveTermination();
		this.#finish?.(new DOMException("Process has been terminated", "AbortError"));
		this.dispatchEvent(new Event("terminate"));
	}

	get terminated() {
		return this.#terminated;
	}
}

export function create(options = {}) {
	return new PpermProcess(options);
}

export const pperm = { create };
export default pperm;
