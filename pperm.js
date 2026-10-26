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
const safePropertyNames = new Set([
	"value", "checked", "disabled", "title", "hidden", "name", "type",
	"href", "src", "alt", "tabIndex", "role", "draggable", "contentEditable"
]);
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
	if (!safePropertyNames.has(name)) {
		throw new DOMException("DOM property is not permitted by the bridge: " + name, "NotAllowedError");
	}
	if (name === "href" || name === "src") assertSafeAttribute(name, value);
	return name;
}

function assertSafeStyle(property, value) {
	const css = String(value);
	if (/url\s*\(|expression\s*\(|@import|-moz-binding|behavior\s*:/i.test(css)) {
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

function applyDomMessage(message, ids, root) {
	const target = ids.get(message.id);
	if (!target) throw new DOMException("Unknown DOM bridge node", "NotFoundError");
	if (message.op === "documentTitle") {
		document.title = message.value;
		return;
	}
	if (message.op === "text") target.textContent = message.value;
	else if (message.op === "style") {
		const property = assertSafeStyle(message.property, message.value);
		if (property.includes("-")) {
			if (message.value === "") target.style.removeProperty(property);
			else target.style.setProperty(property, message.value, message.priority ?? "");
		} else target.style[property] = message.value;
	}
	else if (message.op === "attribute") {
		const name = assertSafeAttribute(message.name, message.value);
		if (name === "style") assertSafeStyle("style", message.value);
		target.setAttribute(name, String(message.value));
	}
	else if (message.op === "removeAttribute") {
		const name = String(message.name).toLowerCase();
		if (name.startsWith("on") || ["srcdoc", "nonce", "integrity", "is"].includes(name)) {
			throw new DOMException("Attribute is not permitted by the DOM bridge: " + name, "NotAllowedError");
		}
		target.removeAttribute(name);
	}
	else if (message.op === "property") target[assertSafeProperty(message.property, message.value)] = message.value;
	else if (message.op === "append") target.appendChild(createNativeNode(message.child, ids));
	else if (message.op === "insert") {
		const before = ids.get(message.beforeId) ?? null;
		target.insertBefore(createNativeNode(message.child, ids), before);
	}
	else if (message.op === "remove") {
		const child = ids.get(message.childId);
		if (child?.parentNode === target && child !== root) target.removeChild(child);
	}
	else if (message.op === "click" || message.op === "focus" || message.op === "blur") {
		if (message.op === "click" && target instanceof Element && ["A", "AREA", "FORM", "INPUT"].includes(target.tagName) &&
			(target.tagName === "FORM" || target.type === "submit" || target.type === "image" || target.href)) {
			throw new DOMException("Programmatic activation of navigation/submission controls is not permitted", "NotAllowedError");
		}
		target[message.op]();
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

	constructor(options = {}) {
		super();
		const permissions = options.permissions ?? options;
		this.permissions = Object.freeze(normalizePermissions(permissions));
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
					entry.target.removeEventListener(entry.type, entry.handler);
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
				this.#worker = new Worker(new URL("./pperm-worker.js?v=20261026-9", import.meta.url));
				this.#worker.addEventListener("message", event => {
					if (settled || this.#terminated) return;
					const message = event.data;
					try {
						if (message.type === "userMessage") this.dispatchEvent(new CustomEvent("message", { detail: message.value }));
						else if (message.type === "dom") {
							if (!this.#root) throw new DOMException("DOM permission is not enabled", "NotAllowedError");
							applyDomMessage(message, this.#nodeIds, this.#root);
							const pending = this.#pendingListeners.splice(0);
							for (const item of pending) this.#attachListener(item);
						} else if (message.type === "listen") this.#attachListener(message);
						else if (message.type === "unlisten") {
							for (const entry of this.#domListeners) {
								if (entry.listenerId === message.listenerId) entry.target.removeEventListener(entry.type, entry.handler);
							}
							this.#domListeners = this.#domListeners.filter(entry => entry.listenerId !== message.listenerId);
						} else if (message.type === "documentTitle") {
							if (!this.#root) throw new DOMException("DOM permission is not enabled", "NotAllowedError");
							document.title = String(message.value);
						}
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
				event: { type: nativeEvent.type, detail: nativeEvent.detail ?? null }
			});
		};
		target.addEventListener(message.eventType, handler, { once: !!message.once });
		this.#domListeners.push({ target, type: message.eventType, handler, listenerId: message.listenerId });
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
			entry.target.removeEventListener(entry.type, entry.handler);
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
