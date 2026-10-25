const workerUrl = new URL("./pperm.worker.js", import.meta.url);

const defaults = {
	network: true,
	storage: true,
	clipboard: false
};

export class PpermProcess extends EventTarget {
	#worker;
	#terminated = false;
	#pending = new Map();
	#nextId = 0;

	constructor(permissions = {}) {
		super();

		this.permissions = Object.freeze({
			...defaults,
			...permissions
		});

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

		this.#worker.postMessage({
			type: "message",
			value
		});
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
