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
	property = String(property).trim();
	const css = String(value);
	if (!/^(?:--[a-z0-9_-]+|-?[a-z][a-z0-9-]*)$/i.test(property) || ["__proto__", "prototype", "constructor"].includes(property.toLowerCase())) {
		throw new DOMException("CSS property name is not permitted by the DOM bridge", "NotAllowedError");
	}
	if (/url\s*\(|expression\s*\(|@import|-moz-binding|behavior\s*:|\\|\/\*/i.test(css)) {
		throw new DOMException("CSS resource loading and executable CSS are not permitted by the DOM bridge", "NotAllowedError");
	}
	return property;
}

function snapshotNode(node, ids, state) {
	if (node.nodeType === 1 && blockedElementNames.has(node.localName.toLowerCase())) return null;
	const id = state.nextId++;
	ids.set(id, node);
	const attributes = {};
	if (node.nodeType === 1) {
		for (const attr of node.attributes) {
			const name = attr.name.toLowerCase();
			if (!name.startsWith("on") && !["srcdoc", "nonce", "integrity", "is", "action", "formaction"].includes(name)) attributes[attr.name] = attr.value;
		}
	}
	const styleData = {};
	if (node.nodeType === 1) {
		for (let i = 0; i < node.style.length; i++) {
			const name = node.style[i];
			styleData[name.startsWith("--") ? name : name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = node.style.getPropertyValue(name);
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
		value: node.nodeType === 1 && "value" in node ? node.value : undefined,
		checked: node.nodeType === 1 && "checked" in node ? node.checked : undefined,
		disabled: node.nodeType === 1 && "disabled" in node ? node.disabled : undefined,
		muted: node.nodeType === 1 && "muted" in node ? node.muted : undefined,
		selected: node.nodeType === 1 && "selected" in node ? node.selected : undefined,
		indeterminate: node.nodeType === 1 && "indeterminate" in node ? node.indeterminate : undefined,
		tabIndex: node.nodeType === 1 && "tabIndex" in node ? node.tabIndex : undefined,
		width: node.nodeType === 1 && "width" in node ? node.width : undefined,
		height: node.nodeType === 1 && "height" in node ? node.height : undefined,
		rows: node.nodeType === 1 && "rows" in node ? node.rows : undefined,
		cols: node.nodeType === 1 && "cols" in node ? node.cols : undefined,
		maxLength: node.nodeType === 1 && "maxLength" in node ? node.maxLength : undefined,
		minLength: node.nodeType === 1 && "minLength" in node ? node.minLength : undefined,
		rowSpan: node.nodeType === 1 && "rowSpan" in node ? node.rowSpan : undefined,
		colSpan: node.nodeType === 1 && "colSpan" in node ? node.colSpan : undefined,
		size: node.nodeType === 1 && "size" in node ? node.size : undefined,
		start: node.nodeType === 1 && "start" in node ? node.start : undefined,
		span: node.nodeType === 1 && "span" in node ? node.span : undefined,
		children: Array.from(node.childNodes, child => snapshotNode(child, ids, state)).filter(Boolean)
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
	if (data.value !== undefined && "value" in node) node.value = data.value;
	if (data.checked !== undefined && "checked" in node) node.checked = data.checked;
	if (data.disabled !== undefined && "disabled" in node) node.disabled = data.disabled;
	if (data.muted !== undefined && "muted" in node) node.muted = data.muted;
	if (data.selected !== undefined && "selected" in node) node.selected = data.selected;
	if (data.indeterminate !== undefined && "indeterminate" in node) node.indeterminate = data.indeterminate;
	if (data.tabIndex !== undefined && "tabIndex" in node) node.tabIndex = data.tabIndex;
	if (data.width !== undefined && "width" in node) node.width = data.width;
	if (data.height !== undefined && "height" in node) node.height = data.height;
	if (data.rows !== undefined && "rows" in node) node.rows = data.rows;
	if (data.cols !== undefined && "cols" in node) node.cols = data.cols;
	if (data.maxLength !== undefined && "maxLength" in node) node.maxLength = data.maxLength;
	if (data.minLength !== undefined && "minLength" in node) node.minLength = data.minLength;
	if (data.rowSpan !== undefined && "rowSpan" in node) node.rowSpan = data.rowSpan;
	if (data.colSpan !== undefined && "colSpan" in node) node.colSpan = data.colSpan;
	if (data.size !== undefined && "size" in node) node.size = data.size;
	if (data.start !== undefined && "start" in node) node.start = data.start;
	if (data.span !== undefined && "span" in node) node.span = data.span;
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
			case "innerText": return this.setInnerText(target, message);
			case "urlProperty": return this.setURLProperty(target, message);
			case "numericProperty": return this.setNumericProperty(target, message);
			case "style": return this.setStyle(target, message);
			case "styleText": return this.setStyleText(target, message);
			case "styleSetProperty": return this.setStyleProperty(target, message);
			case "styleRemoveProperty": return this.removeStyleProperty(target, message);
			case "classList": return this.setClassList(target, message);
			case "attribute": return this.setAttribute(target, message);
			case "removeAttribute": return this.removeAttribute(target, message);
			case "formProperty": return this.setFormProperty(target, message);
			case "reflectedProperty": return this.setReflectedProperty(target, message);
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

	setInnerText(target, message) {
		this.policy.check();
		target.innerText = String(message.value);
	}

	setURLProperty(target, message) {
		this.policy.check();
		const property = String(message.property);
		if (!["href", "src", "poster"].includes(property)) {
			throw new DOMException("Unsupported URL property: " + property, "NotAllowedError");
		}
		const value = String(message.value);
		this.policy.checkProperty(property, value);
		const attribute = this.policy.checkAttribute(property, value);
		if (property in target) target[property] = value;
		else target.setAttribute(attribute, value);
	}

	setNumericProperty(target, message) {
		this.policy.check();
		const property = String(message.property);
		if (!["tabIndex", "width", "height", "rows", "cols", "maxLength", "minLength", "rowSpan", "colSpan", "size", "start", "span"].includes(property)) {
			throw new DOMException("Unsupported numeric DOM property: " + property, "NotAllowedError");
		}
		const value = Number(message.value);
		if (!Number.isFinite(value)) throw new TypeError(property + " must be a finite number");
		if (property in target) target[property] = value;
		else target.setAttribute(property.toLowerCase(), String(value));
	}

	setStyle(target, message) {
		this.policy.check();
		const property = this.policy.checkStyle(message.property, message.value);
		if (property.includes("-")) {
			if (message.value === "") target.style.removeProperty(property);
			else target.style.setProperty(property, String(message.value), message.priority ?? "");
		} else target.style[property] = String(message.value);
	}

	setStyleText(target, message) {
		this.policy.check();
		const value = String(message.value);
		this.policy.checkStyle("style", value);
		target.style.cssText = value;
	}

	setStyleProperty(target, message) {
		this.policy.check();
		const value = String(message.value);
		const property = this.policy.checkStyle(message.property, value);
		const priority = String(message.priority ?? "");
		if (priority.trim() && priority.trim().toLowerCase() !== "important") {
			throw new TypeError("CSS priority must be empty or \"important\"");
		}
		target.style.setProperty(property, value, priority);
	}

	removeStyleProperty(target, message) {
		this.policy.check();
		const property = this.policy.checkStyle(message.property, "");
		target.style.removeProperty(property);
	}

	setClassList(target, message) {
		this.policy.check();
		const method = String(message.method);
		if (!["add", "remove", "toggle", "replace"].includes(method)) {
			throw new DOMException("Unsupported classList operation: " + method, "NotAllowedError");
		}
		const args = message.args;
		if (!Array.isArray(args) || args.length > 256 || args.some(value => typeof value !== "string" && typeof value !== "boolean")) {
			throw new TypeError("Invalid classList arguments");
		}
		const expected = method === "replace" ? 2 : method === "toggle" ? [1, 2] : null;
		if (method === "replace" && args.length !== expected) throw new TypeError("replace expects two tokens");
		if (method === "toggle" && (args.length < expected[0] || args.length > expected[1])) throw new TypeError("toggle expects a token and optional force");
		if ((method === "add" || method === "remove") && args.some(value => typeof value !== "string")) throw new TypeError("classList tokens must be strings");
		if (method === "toggle" && (typeof args[0] !== "string" || (args.length === 2 && typeof args[1] !== "boolean"))) throw new TypeError("Invalid toggle arguments");
		if (method === "replace" && args.some(value => typeof value !== "string")) throw new TypeError("replace tokens must be strings");
		const tokens = method === "toggle" ? [args[0]] : args;
		for (const token of tokens) {
			if (token === "") throw new DOMException("The token must not be empty", "SyntaxError");
			if (/\s/.test(token)) throw new DOMException("The token must not contain whitespace", "InvalidCharacterError");
		}
		target.classList[method](...args);
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

	setFormProperty(target, message) {
		this.policy.check();
		const property = String(message.property);
		if (!["value", "checked", "disabled", "selected"].includes(property)) {
			throw new DOMException("Unsupported form-state property: " + property, "NotAllowedError");
		}
		this.policy.checkProperty(property, message.value);
		if (property === "value") {
			if (message.value !== null && (typeof message.value === "object" || typeof message.value === "function")) {
				throw new TypeError("DOM property value must be primitive");
			}
			target.value = String(message.value);
		} else target[property] = Boolean(message.value);
	}

	setReflectedProperty(target, message) {
		this.policy.check();
		const property = this.policy.checkProperty(message.property, message.value);
		const attribute = this.policy.checkAttribute(message.attribute, message.kind === "boolean" ? "" : message.value);
		if (message.kind === "boolean" || message.kind === "stateBoolean") {
			const value = Boolean(message.value);
			if (property in target) target[property] = value;
			else if (value) target.setAttribute(attribute, "");
			else target.removeAttribute(attribute);
			return;
		}
		const value = String(message.value);
		if (property in target) target[property] = value;
		else target.setAttribute(attribute, value);
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
			if (blockedElementNames.has(this.#root.localName.toLowerCase())) throw new DOMException("The configured DOM root is not permitted", "NotAllowedError");
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
				this.#worker = new Worker(new URL("./pperm-worker.js?v=20261026-47", import.meta.url));
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
							this.#domBridge.policy.check();
							for (const entry of this.#domListeners) {
								if (entry.listenerId === message.listenerId) entry.target.removeEventListener(entry.type, entry.handler, { capture: !!entry.capture });
							}
							this.#domListeners = this.#domListeners.filter(entry => entry.listenerId !== message.listenerId);
							this.#pendingListeners = this.#pendingListeners.filter(entry => entry.listenerId !== message.listenerId);
						} else if (message.type === "documentTitle") {
							this.#domBridge.apply({ op: "documentTitle", value: message.value }, this.#nodeIds, this.#root);
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
					documentTitle: document.title,
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
		this.#domBridge.policy.check();
		if (!Number.isSafeInteger(message.listenerId) || typeof message.eventType !== "string" || !message.eventType || message.eventType.length > 128) {
			throw new DOMException("Invalid DOM listener request", "NotAllowedError");
		}
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
