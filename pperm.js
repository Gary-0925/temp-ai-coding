const workerUrl = new URL("./pperm.worker.js", import.meta.url);

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

			if (!root) {
				throw new Error(`DOM root not found: ${this.permissions.dom.root}`);
			}

			const resolveTarget = reference => {
				if (!reference) return root;
				if (reference.nodeType === "root") return root;

				const parent = reference.parent ? resolveTarget(reference.parent) : root;
				if (!parent) return null;
				if (Number.isInteger(reference.index)) {
					return parent.querySelectorAll(reference.selector)[reference.index] ?? null;
				}
				return parent.querySelector(reference.selector) ?? null;
			};

			const target = resolveTarget(data.target);
			const args = data.args ?? {};
			let value;

			switch (data.operation) {
				case "get":
					if (!target) throw new Error("DOM element not found");
					value = target[args.property];
					if (value instanceof Node) {
						throw new Error("DOM node values are not directly transferable");
					}
					break;
				case "set":
					if (!target) throw new Error("DOM element not found");
					if (args.property === "outerHTML" || args.property === "ownerDocument") {
						throw new DOMException("This DOM property is not permitted", "NotAllowedError");
					}
					target[args.property] = args.value;
					value = true;
					break;
				case "style-get":
					if (!target) throw new Error("DOM element not found");
					value = target.style[args.property];
					break;
				case "style-set":
					if (!target) throw new Error("DOM element not found");
					target.style[args.property] = args.value;
					value = true;
					break;
				case "querySelectorAll":
					value = Array.from((target ?? root).querySelectorAll(args.selector), (element, index) => {
						const parentRef = data.target ?? null;
						return {
							parent: parentRef,
							selector: args.selector,
							index
						};
					});
					break;
				case "call": {
					if (!target) throw new Error("DOM element not found");
					const method = target[args.method];
					if (typeof method !== "function") throw new Error(`Unknown DOM method: ${args.method}`);
					const result = method.apply(target, args.args ?? []);
					value = result instanceof Node ? null : result;
					break;
				}
				case "classList":
					if (!target) throw new Error("DOM element not found");
					value = target.classList[args.method](...(args.args ?? []));
					break;
				case "document-get":
					if (args.property === "title") value = document.title;
					else if (args.property === "URL" || args.property === "documentURI") value = location.href;
					else value = undefined;
					break;
				default:
					throw new Error(`Unsupported DOM operation: ${data.operation}`);
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
