const running = new Set();

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

	if (network.fetch === false) {
		hideGlobal("fetch", deny("fetch"));
	}

	if (network.webSocket === false) {
		hideGlobal("WebSocket", deny("WebSocket"));
	}

	if (network.eventSource === false) {
		hideGlobal("EventSource", deny("EventSource"));
	}

	if (network.xmlHttpRequest === false) {
		hideGlobal("XMLHttpRequest", deny("XMLHttpRequest"));
	}

	if (storage.indexedDB === false) {
		hideGlobal("indexedDB");
	}

	if (storage.cache === false) {
		hideGlobal("caches");
	}
}

function createDomApi(request) {
	return Object.freeze({
		querySelector: selector => request("querySelector", { selector }),
		getText: selector => request("getText", { selector }),
		setText: (selector, value) => request("setText", { selector, value: String(value) }),
		setAttribute: (selector, name, value) => request("setAttribute", {
			selector,
			name,
			value: String(value)
		}),
		appendText: (selector, value) => request("appendText", {
			selector,
			value: String(value)
		})
	});
}

self.addEventListener("message", async ({ data }) => {
	if (data.type === "message") {
		self.postMessage({ type: "message", value: data.value });
		return;
	}

	if (data.type === "dom-result") {
		const pending = self.__domPending?.get(data.id);
		if (pending) {
			self.__domPending.delete(data.id);
			data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.value);
		}
		return;
	}

	if (data.type !== "run" || running.has(data.id)) {
		return;
	}

	running.add(data.id);

	try {
		applyPermissions(data.permissions);

		self.__domPending ??= new Map();
		let domRequestId = 0;
		const requestDom = (operation, args) => {
			if (!data.permissions.dom?.enabled) {
				return Promise.reject(new DOMException("DOM permission denied", "NotAllowedError"));
			}

			const id = ++domRequestId;
			return new Promise((resolve, reject) => {
				self.__domPending.set(id, { resolve, reject });
				self.postMessage({
					type: "dom-request",
					id,
					operation,
					args,
					root: data.permissions.dom.root
				});
			});
		};

		const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
		const execute = new AsyncFunction(
			"postMessage",
			"permissions",
			"dom",
			data.code
		);

		const value = await execute(
			value => self.postMessage({ type: "message", value }),
			Object.freeze({ ...data.permissions }),
			createDomApi(requestDom)
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
