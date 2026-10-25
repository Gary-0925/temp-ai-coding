const running = new Set();

function deny(name) {
	return () => {
		throw new DOMException(`${name} permission denied`, "NotAllowedError");
	};
}

function applyPermissions(permissions) {
	if (!permissions.network) {
		globalThis.fetch = deny("Network");
		globalThis.WebSocket = deny("Network");
		globalThis.EventSource = deny("Network");
		globalThis.XMLHttpRequest = deny("Network");
	}

	if (!permissions.storage) {
		globalThis.indexedDB = undefined;
		globalThis.caches = undefined;
	}

	if (!permissions.clipboard) {
		globalThis.navigator.clipboard = undefined;
	}
}

self.addEventListener("message", async ({ data }) => {
	if (data.type === "message") {
		self.postMessage({
			type: "message",
			value: data.value
		});
		return;
	}

	if (data.type !== "run" || running.has(data.id)) {
		return;
	}

	running.add(data.id);

	try {
		applyPermissions(data.permissions);

		const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
		const execute = new AsyncFunction(
			"postMessage",
			"permissions",
			data.code
		);

		const value = await execute(
			value => self.postMessage({
				type: "message",
				value
			}),
			Object.freeze({ ...data.permissions })
		);

		self.postMessage({
			type: "result",
			id: data.id,
			value
		});
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
		self.postMessage({
			type: "exit",
			id: data.id
		});
	}
});
