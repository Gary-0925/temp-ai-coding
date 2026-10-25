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
				this.dispatchEvent(new CustomEvent("message", {
					detail: data.value
				}));
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
					name: data.error.name
				});

				if (pending) {
					pending.reject(error);
					this.#pending.delete(data.id);
				}

				this.dispatchEvent(new CustomEvent("error", {
					detail: error
				}));
				return;
			}

			if (data.type === "exit") {
				this.dispatchEvent(new CustomEvent("exit", {
					detail: data.id
				}));
			}
		});

		this.#worker.addEventListener("error", event => {
			this.dispatchEvent(new CustomEvent("error", {
				detail: event.error ?? new Error(event.message)
			}));
		});
	}

	#handleDomRequest(data) {
		try {
			if (!this.permissions.dom.enabled) {
				throw new DOMException("DOM permission denied", "NotAllowedError");
			}

			const root = document.querySelector(this.permissions.dom.root);

			if (!root) {
				throw new Error(`DOM root not found: ${this.permissions.dom.root}`);
			}

			const selector = String(data.args.selector ?? "");
			const target = selector ? root.querySelector(selector) : root;
			let value;

			switch (data.operation) {
				case "querySelector":
					value = target ? {
						tagName: target.tagName,
						id: target.id,
						textContent: target.textContent
					} : null;
					break;
				case "getText":
					value = target?.textContent ?? null;
					break;
				case "setText":
					if (!target) throw new Error(`DOM element not found: ${selector}`);
					target.textContent = data.args.value;
					value = true;
					break;
				case "appendText":
					if (!target) throw new Error(`DOM element not found: ${selector}`);
					target.append(document.createTextNode(data.args.value));
					value = true;
					break;
				case "setAttribute":
					if (!target) throw new Error(`DOM element not found: ${selector}`);
					if (!/^[a-zA-Z_:][a-zA-Z0-9:._-]*$/.test(data.args.name)) {
						throw new Error("Invalid attribute name");
					}
					target.setAttribute(data.args.name, data.args.value);
					value = true;
					break;
				default:
					throw new Error(`Unsupported DOM operation: ${data.operation}`);
			}

			this.#worker.postMessage({
				type: "dom-result",
				id: data.id,
				value
			});
		} catch (error) {
			this.#worker.postMessage({
				type: "dom-result",
				id: data.id,
				error: error?.message ?? String(error)
			});
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
		if (this.#terminated) {
			throw new Error("Process has been terminated");
		}

		this.#worker.postMessage({ type: "message", value });
	}

	terminate() {
		if (this.#terminated) {
			return;
		}

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
