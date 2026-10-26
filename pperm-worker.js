let stopped = false;
let nextId = 1;
let root;
const nodes = new Map();
const listeners = new Map();

function emit(type, data = {}) {
	if (!stopped) postMessage({ type, ...data });
}

function build(data, parent = null) {
	const node = {
		__node: true, id: data.id, nodeType: data.nodeType ?? 1,
		tagName: data.tagName ?? "#text", idName: data.idName ?? "",
		className: data.className ?? "", text: data.text ?? "",
		attributes: { ...(data.attributes ?? {}) }, styleData: { ...(data.styleData ?? {}) },
		parent, children: [], connected: true, eventHandlers: {}
	};
	nodes.set(node.id, node);
	node.children = (data.children ?? []).map(child => build(child, node));
	return node;
}

const blockedElementNames = new Set([
	"script", "iframe", "frame", "frameset", "object", "embed", "applet",
	"base", "meta", "link", "style", "svg", "math", "portal", "fencedframe",
	"webview"
]);
const blockedAttributeNames = new Set(["srcdoc", "nonce", "integrity", "is", "formaction", "action"]);
const urlAttributeNames = new Set(["href", "src", "action", "formaction", "poster", "cite", "xlink:href", "background", "data", "manifest"]);
const blockedPropertyNames = new Set([
	"innerHTML", "outerHTML", "srcdoc", "insertAdjacentHTML", "setHTMLUnsafe",
	"setHTML", "outerText", "innerText"
]);
const urlPropertyNames = new Set(["href", "src", "action", "formAction", "poster", "cite", "background", "data", "manifest"]);

function assertSafeElementName(value) {
	const name = String(value).toLowerCase();
	if (!/^[a-z][a-z0-9-]*$/.test(name) || name.includes("-") || blockedElementNames.has(name)) {
		throw new DOMException("Element type is not permitted by the DOM bridge", "NotAllowedError");
	}
	return name;
}

function assertSafeAttribute(name, value) {
	name = String(name).toLowerCase();
	if (!/^[a-z_:][a-z0-9_.:-]*$/.test(name) || name.startsWith("on") || blockedAttributeNames.has(name)) {
		throw new DOMException("Attribute is not permitted by the DOM bridge: " + name, "NotAllowedError");
	}
	if (urlAttributeNames.has(name)) {
		const url = String(value).trim().replace(/[\u0000-\u0020]+/g, "");
		if (/^(javascript|vbscript):/i.test(url) || /^data:(text\/html|application\/xhtml\+xml)/i.test(url)) {
			throw new DOMException("Executable URLs are not permitted by the DOM bridge", "NotAllowedError");
		}
	}
	return name;
}

function assertSafeProperty(name, value) {
	name = String(name);
	if (blockedPropertyNames.has(name) || name.startsWith("__")) {
		throw new DOMException("DOM property is not permitted by the bridge: " + name, "NotAllowedError");
	}
	if (/^on[a-z]+$/i.test(name)) {
		throw new DOMException("Use a function callback for event-handler properties", "NotAllowedError");
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

function matches(node, selector) {
	if (!node || node.nodeType !== 1) return false;
	selector = String(selector).trim();
	if (!selector || /[\s>+~,:\[]/.test(selector)) {
		throw new DOMException("Only simple tag, #id, and .class selectors are supported in the Worker DOM bridge", "NotSupportedError");
	}
	if (selector[0] === "#") return node.idName === selector.slice(1);
	if (selector[0] === ".") return node.className.split(/\s+/).includes(selector.slice(1));
	return selector === "*" || node.tagName.toLowerCase() === selector.toLowerCase();
}

function query(selector, scope = root, includeScope = false) {
	const out = [];
	function walk(node) {
		if ((includeScope || node !== scope) && matches(node, selector)) out.push(node);
		node.children.forEach(walk);
	}
	walk(scope);
	return out;
}

function setConnected(node, connected) {
	node.connected = connected;
	for (const child of node.children) setConnected(child, connected);
}

function serialize(node) {
	node = raw(node);
	return { id: node.id, nodeType: node.nodeType, tagName: node.tagName, idName: node.idName,
		className: node.className, text: node.text, attributes: { ...node.attributes },
		styleData: { ...node.styleData }, children: node.children.map(serialize) };
}

function mutate(op, node, data = {}) {
	if (node.connected) emit("dom", { op, id: node.id, ...data });
}

function wrap(node) {
	if (!node) return null;
	const style = new Proxy({}, {
		get(_, key) {
			if (key === "setProperty") return (name, value, priority = "") => {
				const property = assertSafeStyle(name, value);
				const cssValue = String(value);
				node.styleData[property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = cssValue;
				mutate("style", node, { property, value: cssValue, priority: String(priority) });
			};
			if (key === "getPropertyValue") return name => node.styleData[String(name).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? "";
			if (key === "removeProperty") return name => {
				const property = String(name);
				const keyName = property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
				const previous = node.styleData[keyName] ?? "";
				delete node.styleData[keyName];
				mutate("style", node, { property, value: "" });
				return previous;
			};
			return node.styleData[key] ?? "";
		},
		set(_, key, value) {
			const property = assertSafeStyle(key, value);
			node.styleData[property] = String(value);
			mutate("style", node, { property, value: String(value) });
			return true;
		}
	});
	const classList = {
		contains: value => node.className.split(/\s+/).includes(String(value)),
		add: (...values) => { node.className = [...new Set((node.className + " " + values.join(" ")).trim().split(/\s+/).filter(Boolean))].join(" "); node.attributes.class = node.className; mutate("attribute", node, { name: "class", value: node.className }); },
		remove: (...values) => { const rm = new Set(values.map(String)); node.className = node.className.split(/\s+/).filter(x => x && !rm.has(x)).join(" "); node.attributes.class = node.className; mutate("attribute", node, { name: "class", value: node.className }); },
		toggle: (value, force) => { const has = classList.contains(value); if (force === true || (!has && force !== false)) classList.add(value); else if (has) classList.remove(value); return classList.contains(value); },
		replace: (oldValue, newValue) => {
			if (!classList.contains(oldValue)) return false;
			const values = node.className.split(/\s+/).filter(Boolean);
			const index = values.indexOf(String(oldValue));
			if (index >= 0) values[index] = String(newValue);
			node.className = [...new Set(values)].join(" ");
			node.attributes.class = node.className;
			mutate("attribute", node, { name: "class", value: node.className });
			return true;
		}
	};
	const proxy = new Proxy(node, {
		get(t, p) {
			if (p === "__node") return true;
			if (p === "__raw") return t;
			if (p === "id") return t.idName;
			if (p === "className") return t.className;
			if (p === "tagName" || p === "nodeName") return t.tagName;
			if (p === "nodeType") return t.nodeType;
			if (p === "textContent" || p === "innerText") return t.nodeType === 3 ? t.text : t.text + t.children.map(x => wrap(x).textContent).join("");
			if (p === "parentNode") return wrap(t.parent);
			if (p === "parentElement") return t.parent?.nodeType === 1 ? wrap(t.parent) : null;
			if (p === "children") return t.children.filter(child => child.nodeType === 1).map(wrap);
			if (p === "childNodes") return t.children.map(wrap);
			if (p === "firstChild") return wrap(t.children[0]);
			if (p === "lastChild") return wrap(t.children[t.children.length - 1]);
			if (p === "firstElementChild") return wrap(t.children.find(child => child.nodeType === 1));
			if (p === "lastElementChild") return wrap([...t.children].reverse().find(child => child.nodeType === 1));
			if (p === "nextSibling" || p === "previousSibling" || p === "nextElementSibling" || p === "previousElementSibling") {
				if (!t.parent) return null;
				const siblings = p.includes("Element") ? t.parent.children.filter(child => child.nodeType === 1) : t.parent.children;
				const index = siblings.indexOf(t);
				if (index < 0) return null;
				return wrap(siblings[index + (p.startsWith("next") ? 1 : -1)]);
			}
			if (p === "hasChildNodes") return () => t.children.length > 0;
			if (p === "nodeValue" || p === "data") return t.nodeType === 3 || t.nodeType === 8 ? t.text : null;
			if (p === "style") return style;
			if (p === "classList") return classList;
			if (p === "isConnected") return t.connected;
			if (p === "ownerDocument") return documentProxy;
			if (p === "getAttribute") return name => t.attributes[String(name)] ?? null;
			if (p === "hasAttribute") return name => Object.hasOwn(t.attributes, String(name));
			if (p === "setAttribute") return (name, value) => {
				name = assertSafeAttribute(name, value);
				value = String(value);
				t.attributes[name] = value;
				if (name === "id") t.idName = value;
				if (name === "class") t.className = value;
				if (name === "style") assertSafeStyle("style", value);
				mutate("attribute", t, { name, value });
			};
			if (p === "removeAttribute") return name => {
				name = String(name).toLowerCase();
				if (name.startsWith("on") || blockedAttributeNames.has(name)) throw new DOMException("Attribute is not permitted by the DOM bridge: " + name, "NotAllowedError");
				delete t.attributes[name];
				if (name === "id") t.idName = "";
				if (name === "class") t.className = "";
				mutate("removeAttribute", t, { name });
			};
			if (p === "matches") return selector => matches(t, selector);
			if (p === "querySelector") return selector => wrap(query(selector, t)[0]);
			if (p === "querySelectorAll") return selector => query(selector, t).map(wrap);
			if (p === "closest") return selector => { let n = t; while (n) { if (matches(n, selector)) return wrap(n); n = n.parent; } return null; };
			if (p === "appendChild") return child => append(t, raw(child));
			if (p === "append") return (...args) => { for (const item of args) append(t, item?.__node ? raw(item) : makeText(String(item))); };
			if (p === "prepend") return (...args) => {
				const before = t.children[0] ?? null;
				for (const item of args) insert(t, item?.__node ? raw(item) : makeText(String(item)), before);
			};
			if (p === "insertBefore") return (child, before) => insert(t, raw(child), before == null ? null : raw(before));
			if (p === "replaceChild") return (child, oldChild) => {
				const old = raw(oldChild);
				if (!t.children.includes(old)) throw new DOMException("Node is not a child", "NotFoundError");
				if (raw(child) === old) return oldChild;
				insert(t, raw(child), old);
				remove(t, old);
				return oldChild;
			};
			if (p === "before" || p === "after") return (...args) => {
				if (!t.parent) return;
				const before = p === "before" ? t : t.parent.children[t.parent.children.indexOf(t) + 1] ?? null;
				for (const item of args) insert(t.parent, item?.__node ? raw(item) : makeText(String(item)), before);
			};
			if (p === "removeChild") return child => remove(t, raw(child));
			if (p === "replaceChildren") return (...args) => { [...t.children].forEach(child => remove(t, child)); args.forEach(item => append(t, item?.__node ? raw(item) : makeText(String(item)))); };
			if (p === "remove") return () => { if (t === root) throw new DOMException("Cannot remove the permitted root", "NotAllowedError"); if (t.parent) remove(t.parent, t); };
			if (p === "addEventListener") return (type, callback, options) => { if (typeof callback !== "function") return; const listenerId = nextId++; listeners.set(listenerId, { node: t, type: String(type), callback, once: !!options?.once }); emit("listen", { id: t.id, listenerId, eventType: String(type), once: !!options?.once }); };
			if (p === "removeEventListener") return (type, callback) => { for (const [id, l] of listeners) if (l.node === t && l.type === String(type) && l.callback === callback) { listeners.delete(id); emit("unlisten", { id: t.id, listenerId: id, eventType: l.type }); } };
			if (p === "contains") return other => { let n = raw(other); while (n) { if (n === t) return true; n = n.parent; } return false; };
			if (/^on[a-z]+$/i.test(String(p))) return t.eventHandlers[p]?.callback ?? null;
			if (p === "click") return () => {
				const event = Object.freeze({ type: "click", target: wrap(t), currentTarget: wrap(t), detail: null });
				for (const [id, listener] of [...listeners]) {
					if (listener.node !== t || listener.type !== "click") continue;
					listener.callback.call(wrap(t), event);
					if (listener.once) listeners.delete(id);
				}
			};
			if (p === "focus" || p === "blur") return () => mutate(p, t);
			if (p === "cloneNode") return deep => {
				const data = serialize(t);
				const renew = item => { item.id = nextId++; if (!deep) item.children = []; else item.children.forEach(renew); };
				renew(data);
				const copy = build(data);
				setConnected(copy, false);
				return wrap(copy);
			};
			return undefined;
		},
		set(t, p, value) {
			if (/^on[a-z]+$/i.test(String(p))) {
				const property = String(p);
				const previous = t.eventHandlers[property];
				if (previous) {
					listeners.delete(previous.listenerId);
					emit("unlisten", { id: t.id, listenerId: previous.listenerId, eventType: property.slice(2) });
					delete t.eventHandlers[property];
				}
				if (value == null) return true;
				if (typeof value !== "function") throw new TypeError(property + " must be a function or null");
				const eventType = property.slice(2).toLowerCase();
				const listenerId = nextId++;
				listeners.set(listenerId, { node: t, type: eventType, callback: value, once: false });
				t.eventHandlers[property] = { listenerId, callback: value };
				emit("listen", { id: t.id, listenerId, eventType, once: false });
				return true;
			}
			if (p === "id") { t.idName = String(value); t.attributes.id = t.idName; mutate("attribute", t, { name: "id", value: t.idName }); }
			else if (p === "className") { t.className = String(value); t.attributes.class = t.className; mutate("attribute", t, { name: "class", value: t.className }); }
			else if (p === "textContent" || p === "innerText") {
				for (const child of t.children) { child.parent = null; setConnected(child, false); }
				t.children = [];
				t.text = String(value);
				mutate("text", t, { value: t.text });
			}
			else if (p === "nodeValue" || p === "data") {
				if (t.nodeType !== 3 && t.nodeType !== 8) return true;
				t.text = String(value);
				mutate("text", t, { value: t.text });
			}
			else if (p === "innerHTML") throw new DOMException("innerHTML is not supported; use textContent or createElement", "NotSupportedError");
			else {
				const property = assertSafeProperty(p, value);
				if (typeof value === "function" || (value !== null && typeof value === "object")) {
					throw new TypeError("DOM properties bridged to the main thread must use serializable primitive values");
				}
				t[property] = value;
				mutate("property", t, { property, value });
			}
			return true;
		}
	});
	return proxy;
}

function raw(node) { return node?.__raw ?? node; }

function makeText(text) {
	const node = { __node: true, id: nextId++, nodeType: 3, tagName: "#text", idName: "", className: "", text, attributes: {}, styleData: {}, parent: null, children: [], connected: false };
	nodes.set(node.id, node);
	return node;
}

function append(parent, child) {
	if (!child?.__node) throw new TypeError("appendChild expects a pperm node");
	if (child.nodeType === 11) {
		for (const item of [...child.children]) append(parent, item);
		child.children = [];
		return wrap(child);
	}
	if (child === root) throw new DOMException("Cannot move the permitted root", "NotAllowedError");
	if (child.parent) remove(child.parent, child);
	child.parent = parent;
	setConnected(child, parent.connected);
	parent.children.push(child);
	if (child.connected) emit("dom", { op: "append", id: parent.id, child: serialize(child) });
	return wrap(child);
}

function insert(parent, child, before) {
	if (!child?.__node) throw new TypeError("insertBefore expects a pperm node");
	if (before != null && before.parent !== parent) throw new DOMException("Reference node is not a child", "NotFoundError");
	if (child.nodeType === 11) {
		for (const item of [...child.children]) insert(parent, item, before);
		child.children = [];
		return wrap(child);
	}
	if (child === root) throw new DOMException("Cannot move the permitted root", "NotAllowedError");
	if (child === before) return wrap(child);
	if (child.parent) remove(child.parent, child);
	child.parent = parent;
	setConnected(child, parent.connected);
	const index = before == null ? -1 : parent.children.indexOf(before);
	if (index < 0) parent.children.push(child);
	else parent.children.splice(index, 0, child);
	if (child.connected) emit("dom", { op: "insert", id: parent.id, child: serialize(child), beforeId: before?.id ?? null });
	return wrap(child);
}

function remove(parent, child) {
	const i = parent.children.indexOf(child);
	if (i < 0) throw new DOMException("Node is not a child", "NotFoundError");
	if (child === root) throw new DOMException("Cannot remove the permitted root", "NotAllowedError");
	parent.children.splice(i, 1);
	child.parent = null;
	setConnected(child, false);
	if (parent.connected) emit("dom", { op: "remove", id: parent.id, childId: child.id });
	return wrap(child);
}

const documentProxy = new Proxy({}, {
	get(_, p) {
		if (p === "body" || p === "documentElement") return wrap(root);
		if (p === "querySelector") return selector => wrap(query(selector, root, true)[0]);
		if (p === "querySelectorAll") return selector => query(selector, root, true).map(wrap);
		if (p === "getElementById") return id => wrap(query("#" + String(id), root, true)[0]);
		if (p === "getElementsByClassName") return name => query("." + String(name).trim().split(/\s+/)[0], root, true).map(wrap);
		if (p === "getElementsByTagName") return name => query(String(name), root, true).map(wrap);
		if (p === "createElement") return tag => { const safeTag = assertSafeElementName(tag); const n = build({ id: nextId++, tagName: safeTag.toUpperCase() }); n.connected = false; return wrap(n); };
		if (p === "createTextNode") return text => wrap(makeText(String(text)));
		if (p === "createComment") return text => { const n = makeText(String(text)); n.nodeType = 8; n.tagName = "#comment"; return wrap(n); };
		if (p === "createDocumentFragment") { const n = build({ id: nextId++, nodeType: 11, tagName: "#fragment" }); setConnected(n, false); return wrap(n); }
		if (p === "nodeType") return 9;
		if (p === "addEventListener" || p === "removeEventListener") return wrap(root)[p];
		return undefined;
	},
	set(_, p, value) {
		if (p === "title") { emit("documentTitle", { value: String(value) }); return true; }
		throw new DOMException("Unsupported document property", "NotAllowedError");
	}
});

self.addEventListener("message", event => {
	const m = event.data;
	if (m?.type === "init") {
		root = build(m.snapshot);
		nextId = Math.max(nextId, ...Array.from(nodes.keys(), id => Number(id) + 1));
		const deny = name => new Proxy(function() { throw new DOMException(name + " is not permitted", "NotAllowedError"); }, { construct() { throw new DOMException(name + " is not permitted", "NotAllowedError"); } });
		const allowed = m.permissions;
		const guard = (ok, name, value) => ok ? value : deny(name);
		const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
		try {
			const run = new AsyncFunction("postMessage", "permissions", "document", "fetch", "WebSocket", "EventSource", "XMLHttpRequest", "indexedDB", "caches", m.code);
			Promise.resolve(run(
				value => emit("userMessage", { value }), allowed,
				allowed.dom.enabled ? documentProxy : undefined,
				guard(allowed.network.fetch, "fetch", self.fetch?.bind(self)),
				guard(allowed.network.webSocket, "WebSocket", self.WebSocket),
				guard(allowed.network.eventSource, "EventSource", self.EventSource),
				guard(allowed.network.xmlHttpRequest, "XMLHttpRequest", self.XMLHttpRequest),
				guard(allowed.storage.indexedDB, "indexedDB", self.indexedDB),
				guard(allowed.storage.cache, "caches", self.caches)
			)).then(value => emit("done", { value })).catch(error => emit("error", { error: { name: error?.name, message: error?.message, stack: error?.stack } }));
		} catch (error) { emit("error", { error: { name: error?.name, message: error?.message, stack: error?.stack } }); }
	} else if (m?.type === "event") {
		const l = listeners.get(m.listenerId);
		if (!l || stopped) return;
		try { l.callback.call(wrap(l.node), Object.freeze({ type: m.event.type, target: wrap(l.node), currentTarget: wrap(l.node), detail: m.event.detail ?? null })); }
		catch (error) { emit("error", { error: { name: error?.name, message: error?.message, stack: error?.stack } }); }
		if (l.once) listeners.delete(m.listenerId);
	} else if (m?.type === "shutdown") { stopped = true; close(); }
});
