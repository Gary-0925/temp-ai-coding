const workerUrl = new URL("./pperm.worker.js?v=20261025-4", import.meta.url);

const defaults = {
	network: {
		fetch: true,
		webSocket: true,
		eventSource: true,
		xmlHttpRequest: true
	},
	storage: {
		indexedDB: true,
		cache: true
	},
	dom: {
		enabled: false,
		root: "body"
	}
};

function normalizePermissions(permissions = {}) {
	return {
		network: {
			...defaults.network,
			...(typeof permissions.network === "boolean"
				? Object.fromEntries(Object.keys(defaults.network).map(key => [key, permissions.network]))
				: permissions.network)
		},
		storage: {
			...defaults.storage,
			...(typeof permissions.storage === "boolean"
				? Object.fromEntries(Object.keys(defaults.storage).map(key => [key, permissions.storage]))
				: permissions.storage)
		},
		dom: {
			...defaults.dom,
			...permissions.dom
		}
	};
}

export class PpermProcess extends EventTarget {
	#worker;
	#terminated = false;
	#pending = new Map();
	#nextId = 0;
	#domNodes = new Map();
	#domNodeIds = new WeakMap();
	#nextDomNodeId = 0;
	#domListeners = new Map();

	constructor(permissions = {}) {
		super();

		this.permissions = Object.freeze(normalizePermissions(permissions));
		this.#worker = new Worker(workerUrl, {
			type: "module",
			name: "pperm-process"
		});

		this.#worker.addEventListener("message", ({ data }) => {
			if (data.type === "message") {
				this.dispatchEvent(new CustomEvent("message", { detail: data.value }));
				return;
			}

			if (data.type === "dom-request") {
				this.#handleDomRequest(data);
				return;
			}

			const pending = this.#pending.get(data.id);

			if (data.type === "result") {
				pending?.resolve(data.value);
				this.#pending.delete(data.id);
				return;
			}

			if (data.type === "error") {
				const error = Object.assign(new Error(data.error.message), {
					name: data.error.name ?? "Error"
				});

				if (pending) {
					pending.reject(error);
					this.#pending.delete(data.id);
				}

				this.dispatchEvent(new CustomEvent("error", { detail: error }));
				return;
			}

			if (data.type === "exit") {
				this.dispatchEvent(new CustomEvent("exit", { detail: data.id }));
			}
		});

		this.#worker.addEventListener("error", event => {
			this.dispatchEvent(new CustomEvent("error", {
				detail: event.error ?? new Error(event.message)
			}));
		});
	}

	#handleDomRequest(data) {
		const reply = payload => this.#worker.postMessage({
			type: "dom-result",
			id: data.id,
			...payload
		});

		try {
			if (!this.permissions.dom.enabled) {
				throw new DOMException("DOM permission denied", "NotAllowedError");
			}

			const root = document.querySelector(this.permissions.dom.root);
			if (!root) throw new Error("DOM root not found: " + this.permissions.dom.root);

			const nodeId = node => {
				let id = this.#domNodeIds.get(node);
				if (!id) {
					id = ++this.#nextDomNodeId;
					this.#domNodeIds.set(node, id);
					this.#domNodes.set(id, node);
				}
				return id;
			};

			const allowedNode = node => node && (
				node === root ||
				root.contains(node) ||
				this.#domNodes.has(this.#domNodeIds.get(node))
			);

			const serialize = value => {
				if (value instanceof Node) {
					if (!allowedNode(value)) return null;
					return {
						__ppermNode: true,
						nodeId: nodeId(value),
						nodeType: value.nodeType,
						nodeName: value.nodeName,
						tagName: value.tagName ?? null
					};
				}
				if (value instanceof NodeList || value instanceof HTMLCollection) {
					return Array.from(value, serialize);
				}
				if (value && typeof value.length === "number" && typeof value.item === "function") {
					return Array.from(value, serialize);
				}
				if (Array.isArray(value)) return value.map(serialize);
				if (value && typeof value.toJSON === "function") return serialize(value.toJSON());
				if (value && Object.getPrototypeOf(value) === Object.prototype) {
					return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item)]));
				}
				return value;
			};

			const deserialize = value => {
				if (value && value.__ppermNode === true && Number.isInteger(value.nodeId)) {
					const node = this.#domNodes.get(value.nodeId);
					if (!node || !allowedNode(node)) throw new DOMException("DOM node is outside the permitted root", "NotAllowedError");
					return node;
				}
				if (value && value.__ppermTarget === true) {
					const node = resolveTarget(value.target);
					if (!node) throw new DOMException("DOM target not found", "NotAllowedError");
					return node;
				}
				if (Array.isArray(value)) return value.map(deserialize);
				return value;
			};

			const resolveTarget = reference => {
				if (!reference) return root;
				if (reference.nodeId) {
					const node = this.#domNodes.get(reference.nodeId);
					return allowedNode(node) ? node : null;
				}
				if (reference.nodeType === "root") return root;
				const parent = reference.parent ? resolveTarget(reference.parent) : root;
				if (!parent || typeof parent.querySelector !== "function") return null;
				if (Number.isInteger(reference.index)) return parent.querySelectorAll(reference.selector)[reference.index] ?? null;
				return parent.querySelector(reference.selector) ?? null;
			};

			const target = resolveTarget(data.target);
			const args = data.args ?? {};
			let value;

			switch (data.operation) {
				case "get":
					if (!target) throw new Error("DOM element not found");
					value = target[args.property];
					if (typeof value === "function") value = { __ppermMethod: true, name: args.property };
					else value = serialize(value);
					break;
				case "set":
					if (!target) throw new Error("DOM element not found");
					if (["outerHTML", "ownerDocument", "parentNode", "parentElement"].includes(args.property)) {
						throw new DOMException("This DOM property is not permitted", "NotAllowedError");
					}
					target[args.property] = deserialize(args.value);
					value = true;
					break;
				case "style-get":
					if (!target || !target.style) throw new Error("DOM element not found");
					value = target.style[args.property];
					break;
				case "style-set":
					if (!target || !target.style) throw new Error("DOM element not found");
					target.style[args.property] = String(args.value);
					value = true;
					break;
				case "style-method": {
					if (!target || !target.style) throw new Error("DOM element not found");
					const method = target.style[args.method];
					if (typeof method !== "function") throw new Error("Unknown CSSStyleDeclaration method: " + args.method);
					value = method.apply(target.style, args.args ?? []);
					break;
				}
				case "querySelectorAll":
					if (!target || typeof target.querySelectorAll !== "function") throw new Error("DOM element not found");
					value = Array.from(target.querySelectorAll(args.selector), node => serialize(node));
					break;
				case "createElement": {
					const element = document.createElement(String(args.tagName));
					nodeId(element);
					value = serialize(element);
					break;
				}
				case "createTextNode": {
					const node = document.createTextNode(String(args.text));
					nodeId(node);
					value = serialize(node);
					break;
				}
				case "createComment": {
					const node = document.createComment(String(args.text));
					nodeId(node);
					value = serialize(node);
					break;
				}
				case "createDocumentFragment": {
					const node = document.createDocumentFragment();
					nodeId(node);
					value = serialize(node);
					break;
				}
				case "getElementById": {
					const id = String(args.id);
					const node = root.id === id ? root : Array.from(root.querySelectorAll("[id]")).find(element => element.id === id) ?? null;
					value = serialize(node);
					break;
				}
				case "getElementsByClassName": {
					value = Array.from(root.getElementsByClassName(String(args.className)), serialize);
					break;
				}
				case "getElementsByTagName": {
					value = Array.from(root.getElementsByTagName(String(args.tagName)), serialize);
					break;
				}
				case "call": {
					if (!target) throw new Error("DOM element not found");
					const method = target[args.method];
					if (typeof method !== "function") throw new Error("Unknown DOM method: " + args.method);
					const result = method.apply(target, deserialize(args.args ?? []));
					if (result instanceof Node && args.method === "cloneNode") {
						const registerTree = node => {
							nodeId(node);
							for (const child of node.childNodes ?? []) registerTree(child);
						};
						registerTree(result);
					}
					value = serialize(result);
					break;
				}
				case "classList":
					if (!target || !target.classList) throw new Error("DOM element not found");
					value = target.classList[args.method](...(args.args ?? []));
					break;
				case "event-listener-add": {
					if (!target || typeof target.addEventListener !== "function") throw new Error("DOM element not found");
					const key = String(args.listenerId);
					const listenerKey = nodeId(target) + ":" + key;
					const listener = event => {
						const eventData = {
							type: event.type,
							bubbles: event.bubbles,
							cancelable: event.cancelable,
							defaultPrevented: event.defaultPrevented,
							timeStamp: event.timeStamp,
							detail: serialize(event.detail),
							key: event.key,
							code: event.code,
							repeat: event.repeat,
							button: event.button,
							buttons: event.buttons,
							clientX: event.clientX,
							clientY: event.clientY,
							target: serialize(event.target),
							currentTarget: serialize(event.currentTarget)
						};
						this.#worker.postMessage({ type: "dom-event", listenerId: args.listenerId, event: eventData });
					};
					target.addEventListener(args.eventType, listener, args.options);
					this.#domListeners.set(listenerKey, { target, eventType: args.eventType, listener, options: args.options });
					value = true;
					break;
				}
				case "event-listener-remove": {
					const key = String(args.listenerId);
					for (const [listenerKey, entry] of this.#domListeners) {
						if (listenerKey.endsWith(":" + key) && entry.eventType === args.eventType && target) {
							entry.target.removeEventListener(entry.eventType, entry.listener, entry.options);
							this.#domListeners.delete(listenerKey);
						}
					}
					value = true;
					break;
				}
				case "document-get":
					if (args.property === "title") value = document.title;
					else if (args.property === "URL" || args.property === "documentURI") value = location.href;
					else if (args.property === "readyState") value = document.readyState;
					else if (args.property === "visibilityState") value = document.visibilityState;
					else if (args.property === "activeElement") value = serialize(document.activeElement);
					else value = undefined;
					break;
				default:
					throw new Error("Unsupported DOM operation: " + data.operation);
			}

			reply({ value });
		} catch (error) {
			reply({ error: {
				name: error?.name ?? "Error",
				message: error?.message ?? String(error)
			} });
		}
	}
	run(code) {
		if (this.#terminated) {
			return Promise.reject(new Error("Process has been terminated"));
		}

		const id = ++this.#nextId;

		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#worker.postMessage({
				type: "run",
				id,
				code: String(code),
				permissions: this.permissions
			});
		});
	}

	postMessage(value) {
		if (this.#terminated) throw new Error("Process has been terminated");
		this.#worker.postMessage({ type: "message", value });
	}

	terminate() {
		if (this.#terminated) return;
		this.#terminated = true;
		for (const entry of this.#domListeners.values()) {
			entry.target.removeEventListener(entry.eventType, entry.listener, entry.options);
		}
		this.#domListeners.clear();
		this.#domNodes.clear();
		this.#worker.terminate();

		for (const { reject } of this.#pending.values()) {
			reject(new Error("Process has been terminated"));
		}

		this.#pending.clear();
		this.dispatchEvent(new Event("terminate"));
	}

	get terminated() {
		return this.#terminated;
	}
}

export function create(options = {}) {
	return new PpermProcess(options.permissions);
}

export const pperm = { create };

export default pperm;
