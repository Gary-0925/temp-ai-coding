const defaults = {
	network: { fetch: true, webSocket: true, eventSource: true, xmlHttpRequest: true },
	storage: { indexedDB: true, cache: true },
	dom: { enabled: false, root: "body" }
};

const guardedName = "__ppermInternalCheck_7d3a";

function instrumentStatements(source) {
	const ast = acorn.parse(source, {
		ecmaVersion: "latest",
		sourceType: "script",
		allowReturnOutsideFunction: true,
		allowAwaitOutsideFunction: true
	});
	const edits = [];
	const seen = new Set();

	function walk(node, parent = null) {
		if (!node || typeof node.type !== "string") return;

		if (node.type === "BlockStatement" || node.type === "StaticBlock") {
			const position = node.start + 1;
			if (!seen.has(position)) {
				edits.push([position, position, guardedName + "();"]);
				seen.add(position);
			}
		} else {
			const isStatement = node.type.endsWith("Statement")
				|| node.type === "FunctionDeclaration"
				|| node.type === "ClassDeclaration"
				|| node.type === "VariableDeclaration" && !(
					parent && ["ForStatement", "ForInStatement", "ForOfStatement"].includes(parent.type)
				);
			if (isStatement && !node.directive && !seen.has(node.start)) {
				edits.push([node.start, node.start, guardedName + "();"]);
				seen.add(node.start);
			}
		}

		for (const key of Object.keys(node)) {
			if (key === "start" || key === "end" || key === "loc") continue;
			const value = node[key];
			if (Array.isArray(value)) {
				for (const child of value) walk(child, node);
			} else if (value && typeof value.type === "string") {
				walk(value, node);
			}
		}
	}

	walk(ast);
	edits.sort((a, b) => b[0] - a[0]);
	for (const [start, end, replacement] of edits) {
		source = source.slice(0, start) + replacement + source.slice(end);
	}
	return source;
}

function createProcessDocument(root, check) {
	const proxyCache = new WeakMap();
	const rawByProxy = new WeakMap();
	const createdNodes = new WeakSet();
	const listeners = new Set();
	let terminated = false;

	const assertActive = () => {
		check();
		if (terminated) throw new DOMException("Process has been terminated", "AbortError");
	};
	const allowed = node => !!node && (node === root || root.contains(node) || (!node.isConnected && createdNodes.has(node)));
	const unwrap = value => rawByProxy.get(value) ?? value;
	const ensureNode = node => {
		if (!(node instanceof Node)) return node;
		if (!allowed(node)) throw new DOMException("DOM node is outside the permitted root", "NotAllowedError");
		return node;
	};
	const wrapValue = value => {
		if (value instanceof Node) return wrapNode(value);
		if (value instanceof NodeList || value instanceof HTMLCollection) return Array.from(value, wrapValue);
		if (Array.isArray(value)) return value.map(wrapValue);
		return value;
	};
	const isRoot = node => node === root;

	function wrapNode(node) {
		if (!node) return null;
		if (!allowed(node)) return null;
		if (proxyCache.has(node)) return proxyCache.get(node);

		const proxy = new Proxy(node, {
			get(target, property) {
				assertActive();
				if (property === "ownerDocument") return documentProxy;
				if (property === "parentNode" || property === "parentElement") {
					const parent = property === "parentNode" ? target.parentNode : target.parentElement;
					return !parent || isRoot(target) || !allowed(parent) ? null : wrapNode(parent);
				}
				if (property === "getRootNode") return () => wrapNode(root);
				if (property === "outerHTML") throw new DOMException("outerHTML is not permitted", "NotAllowedError");
				if (property === "remove" && isRoot(target)) return () => { throw new DOMException("The permitted DOM root cannot be removed", "NotAllowedError"); };
				if (property === "before" || property === "after" || property === "replaceWith") {
					if (isRoot(target)) return () => { throw new DOMException("The permitted DOM root cannot be moved or replaced", "NotAllowedError"); };
				}
				if (property === "insertAdjacentHTML" || property === "insertAdjacentElement" || property === "insertAdjacentText") {
					return (position, ...args) => {
						assertActive();
						const where = String(position).toLowerCase();
						if (isRoot(target) && (where === "beforebegin" || where === "afterend")) {
							throw new DOMException("Content cannot be inserted outside the permitted DOM root", "NotAllowedError");
						}
						if (property === "insertAdjacentElement" && args[0]) args[0] = ensureNode(unwrap(args[0]));
						return target[property](position, ...args);
					};
				}
				if (property === "addEventListener") {
					return (type, callback, options) => {
						assertActive();
						if (typeof callback !== "function" && (!callback || typeof callback.handleEvent !== "function")) return;
						const wrapped = function(event) {
							if (terminated) return;
							const eventProxy = new Proxy(event, {
								get(eventTarget, key) {
									if (key === "target" || key === "currentTarget" || key === "srcElement") return wrapNode(eventTarget[key]);
									const value = Reflect.get(eventTarget, key, eventTarget);
									return typeof value === "function" ? value.bind(eventTarget) : value;
								}
							});
							const result = typeof callback === "function"
								? callback.call(proxy, eventProxy)
								: callback.handleEvent.call(callback, eventProxy);
							if (options && typeof options === "object" && options.once) listeners.delete(entry);
							return result;
						};
						const entry = { target, type, callback, wrapped, options };
						listeners.add(entry);
						target.addEventListener(type, wrapped, options);
					};
				}
				if (property === "removeEventListener") {
					return (type, callback, options) => {
						for (const entry of listeners) {
							if (entry.target === target && entry.type === type && entry.callback === callback) {
								target.removeEventListener(type, entry.wrapped, options ?? entry.options);
								listeners.delete(entry);
							}
						}
					};
				}
				if (property === "contains") return other => {
					const nodeArg = unwrap(other);
					return nodeArg instanceof Node && allowed(nodeArg) && target.contains(nodeArg);
				};
				if (property === "appendChild" || property === "insertBefore" || property === "replaceChild") {
					return (...args) => {
						assertActive();
						const node = ensureNode(unwrap(args[0]));
						if (args.length > 1 && args[1] != null) args[1] = ensureNode(unwrap(args[1]));
						if (isRoot(node) || (args[1] && isRoot(args[1]))) {
							throw new DOMException("The permitted DOM root cannot be moved", "NotAllowedError");
						}
						const result = target[property](node, ...args.slice(1));
						return wrapValue(result);
					};
				}
				if (["append", "prepend", "replaceChildren", "before", "after", "replaceWith"].includes(property)) {
					return (...args) => {
						assertActive();
						const nodes = args.map(arg => {
							const value = unwrap(arg);
							if (value instanceof Node) return ensureNode(value);
							return value;
						});
						if (nodes.some(isRoot)) throw new DOMException("The permitted DOM root cannot be moved", "NotAllowedError");
						target[property](...nodes);
					};
				}
				if (property === "cloneNode") {
					return (...args) => {
						const clone = target.cloneNode(...args);
						const register = current => {
							createdNodes.add(current);
							for (const child of current.childNodes) register(child);
						};
						register(clone);
						return wrapNode(clone);
					};
				}
				if (property === "closest") return selector => {
					const result = target.closest(selector);
					return result && allowed(result) ? wrapNode(result) : null;
				};
				const value = Reflect.get(target, property, target);
				if (typeof value === "function") {
					return (...args) => {
						assertActive();
						const nativeArgs = args.map(arg => {
							const value = unwrap(arg);
							return value instanceof Node ? ensureNode(value) : value;
						});
						const result = value.apply(target, nativeArgs);
						return wrapValue(result);
					};
				}
				return wrapValue(value);
			},
			set(target, property, value) {
				assertActive();
				if (property === "outerHTML" || ["ownerDocument", "parentNode", "parentElement"].includes(property)) {
					throw new DOMException("This DOM property is not permitted", "NotAllowedError");
				}
				const raw = unwrap(value);
				if (raw instanceof Node) ensureNode(raw);
				Reflect.set(target, property, raw, target);
				return true;
			},
			has(target, property) {
				return property in target;
			}
		});
		proxyCache.set(node, proxy);
		rawByProxy.set(proxy, node);
		return proxy;
	}

	function querySelector(selector, scope = root) {
		const text = String(selector);
		if (scope.matches && scope.matches(text)) return wrapNode(scope);
		return wrapNode(scope.querySelector(text));
	}

	const documentProxy = new Proxy(Object.create(null), {
		get(_, property) {
			assertActive();
			if (property === "body" || property === "documentElement") return wrapNode(root);
			if (property === "querySelector") return selector => querySelector(selector);
			if (property === "querySelectorAll") return selector => {
				const text = String(selector);
				const result = [];
				if (root.matches && root.matches(text)) result.push(wrapNode(root));
				result.push(...Array.from(root.querySelectorAll(text), wrapNode));
				return result;
			};
			if (property === "getElementById") return id => {
				const text = String(id);
				return root.id === text ? wrapNode(root) : wrapNode(Array.from(root.querySelectorAll("[id]")).find(node => node.id === text) ?? null);
			};
			if (property === "getElementsByClassName") return name => {
				const result = [];
				if (root.classList.contains(String(name))) result.push(wrapNode(root));
				result.push(...Array.from(root.getElementsByClassName(String(name)), wrapNode));
				return result;
			};
			if (property === "getElementsByTagName") return name => {
				const result = [];
				if (root.tagName?.toLowerCase() === String(name).toLowerCase() || name === "*") result.push(wrapNode(root));
				result.push(...Array.from(root.getElementsByTagName(String(name)), wrapNode));
				return result;
			};
			if (property === "createElement") return tag => {
				const node = window.document.createElement(String(tag));
				createdNodes.add(node);
				return wrapNode(node);
			};
			if (property === "createTextNode") return text => {
				const node = window.document.createTextNode(String(text));
				createdNodes.add(node);
				return wrapNode(node);
			};
			if (property === "createComment") return text => {
				const node = window.document.createComment(String(text));
				createdNodes.add(node);
				return wrapNode(node);
			};
			if (property === "createDocumentFragment") return () => {
				const node = window.document.createDocumentFragment();
				createdNodes.add(node);
				return wrapNode(node);
			};
			if (property === "addEventListener") return wrapNode(root).addEventListener;
			if (property === "removeEventListener") return wrapNode(root).removeEventListener;
			if (property === "title") return window.document.title;
			if (property === "URL" || property === "documentURI") return window.location.href;
			if (property === "readyState") return window.document.readyState;
			if (property === "visibilityState") return window.document.visibilityState;
			if (property === "activeElement") return wrapNode(window.document.activeElement);
			if (property === "nodeType") return 9;
			if (property === "toString") return () => "[object Document]";
			return undefined;
		},
		set(_, property, value) {
			assertActive();
			if (property === "title") {
				window.document.title = String(value);
				return true;
			}
			throw new DOMException("This document property is read-only or unsupported", "NotAllowedError");
		}
	});

	return {
		document: documentProxy,
		terminate() {
			terminated = true;
			for (const entry of listeners) entry.target.removeEventListener(entry.type, entry.wrapped, entry.options);
			listeners.clear();
		}
	};
}

export class PpermProcess extends EventTarget {
	#terminated = false;
	#active = new Set();
	#runtime;
	#maxStatements;
	#terminationPromise;
	#resolveTermination;

	constructor(options = {}) {
		super();
		const permissions = options.permissions ?? options;
		this.permissions = Object.freeze(normalizePermissions(permissions));
		this.#maxStatements = Math.max(1, Number(options.maxStatements ?? options.maxLoopIterations) || 100000);
		this.#terminationPromise = new Promise(resolve => { this.#resolveTermination = resolve; });
		let root = null;
		if (this.permissions.dom.enabled) {
			root = window.document.querySelector(this.permissions.dom.root);
			if (!root) throw new Error("DOM root not found: " + this.permissions.dom.root);
		}
		const check = () => {
			if (this.#terminated) throw new DOMException("Process has been terminated", "AbortError");
		};
		this.#runtime = root ? createProcessDocument(root, check) : null;
	}


	async run(code) {
		if (this.#terminated) throw new Error("Process has been terminated");
		const localCheckCount = { value: 0 };
		const check = () => {
			if (this.#terminated) throw new DOMException("Process has been terminated", "AbortError");
			localCheckCount.value++;
			if (localCheckCount.value > this.#maxStatements) {
				throw new DOMException("Execution stopped: statement budget exceeded", "TimeoutError");
			}
		};
		const instrumented = instrumentStatements(String(code));
		const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
		const execute = new AsyncFunction(
			"postMessage", "permissions", "document", guardedName,
			"fetch", "WebSocket", "EventSource", "XMLHttpRequest", "indexedDB", "caches",
			instrumented
		);
		const denyIf = (allowed, name, value) => allowed ? value : deny(name);
		const network = this.permissions.network;
		const storage = this.permissions.storage;
		const context = {
			postMessage: value => {
				if (this.#terminated) return;
				this.dispatchEvent(new CustomEvent("message", { detail: value }));
			},
			permissions: this.permissions,
			document: this.permissions.dom.enabled ? this.#runtime.document : undefined,
			check,
			network,
			storage
		};
		const active = execute(
			context.postMessage,
			context.permissions,
			context.document,
			check,
			denyIf(network.fetch, "fetch", window.fetch.bind(window)),
			denyIf(network.webSocket, "WebSocket", window.WebSocket),
			denyIf(network.eventSource, "EventSource", window.EventSource),
			denyIf(network.xmlHttpRequest, "XMLHttpRequest", window.XMLHttpRequest),
			denyIf(storage.indexedDB, "indexedDB", window.indexedDB),
			denyIf(storage.cache, "caches", window.caches)
		);
		this.#active.add(active);
		try {
			const result = await Promise.race([
				active,
				this.#terminationPromise.then(() => {
					throw new DOMException("Process has been terminated", "AbortError");
				})
			]);
			if (this.#terminated) throw new DOMException("Process has been terminated", "AbortError");
			return result;
		} catch (error) {
			this.dispatchEvent(new CustomEvent("error", { detail: error }));
			throw error;
		} finally {
			this.#active.delete(active);
		}
	}

	postMessage(value) {
		if (this.#terminated) throw new Error("Process has been terminated");
		this.dispatchEvent(new CustomEvent("message", { detail: value }));
	}

	terminate() {
		if (this.#terminated) return;
		this.#terminated = true;
		this.#resolveTermination();
		this.#runtime?.terminate();
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
