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
		parent, children: [], connected: true
	};
	nodes.set(node.id, node);
	node.children = (data.children ?? []).map(child => build(child, node));
	return node;
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
		get(_, key) { return node.styleData[key] ?? ""; },
		set(_, key, value) { node.styleData[key] = String(value); mutate("style", node, { property: String(key), value: String(value) }); return true; }
	});
	const classList = {
		contains: value => node.className.split(/\s+/).includes(String(value)),
		add: (...values) => { node.className = [...new Set((node.className + " " + values.join(" ")).trim().split(/\s+/).filter(Boolean))].join(" "); node.attributes.class = node.className; mutate("attribute", node, { name: "class", value: node.className }); },
		remove: (...values) => { const rm = new Set(values.map(String)); node.className = node.className.split(/\s+/).filter(x => x && !rm.has(x)).join(" "); node.attributes.class = node.className; mutate("attribute", node, { name: "class", value: node.className }); },
		toggle: (value, force) => { const has = classList.contains(value); if (force === true || (!has && force !== false)) classList.add(value); else if (has) classList.remove(value); return classList.contains(value); }
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
			if (p === "parentNode" || p === "parentElement") return wrap(t.parent);
			if (p === "children" || p === "childNodes") return t.children.map(wrap);
			if (p === "firstChild" || p === "firstElementChild") return wrap(t.children[0]);
			if (p === "lastChild" || p === "lastElementChild") return wrap(t.children[t.children.length - 1]);
			if (p === "style") return style;
			if (p === "classList") return classList;
			if (p === "isConnected") return t.connected;
			if (p === "ownerDocument") return documentProxy;
			if (p === "getAttribute") return name => t.attributes[String(name)] ?? null;
			if (p === "hasAttribute") return name => Object.hasOwn(t.attributes, String(name));
			if (p === "setAttribute") return (name, value) => { name = String(name); value = String(value); t.attributes[name] = value; if (name === "id") t.idName = value; if (name === "class") t.className = value; mutate("attribute", t, { name, value }); };
			if (p === "removeAttribute") return name => { name = String(name); delete t.attributes[name]; if (name === "id") t.idName = ""; if (name === "class") t.className = ""; mutate("removeAttribute", t, { name }); };
			if (p === "matches") return selector => matches(t, selector);
			if (p === "querySelector") return selector => wrap(query(selector, t)[0]);
			if (p === "querySelectorAll") return selector => query(selector, t).map(wrap);
			if (p === "closest") return selector => { let n = t; while (n) { if (matches(n, selector)) return wrap(n); n = n.parent; } return null; };
			if (p === "appendChild") return child => append(t, raw(child));
			if (p === "append" || p === "prepend") return (...args) => { const items = p === "prepend" ? [...args].reverse() : args; for (const item of items) append(t, item?.__node ? raw(item) : makeText(String(item))); if (p === "prepend") { /* insertion order is represented by reverse iteration */ } };
			if (p === "removeChild") return child => remove(t, raw(child));
			if (p === "replaceChildren") return (...args) => { [...t.children].forEach(child => remove(t, child)); args.forEach(item => append(t, item?.__node ? raw(item) : makeText(String(item)))); };
			if (p === "remove") return () => { if (t === root) throw new DOMException("Cannot remove the permitted root", "NotAllowedError"); if (t.parent) remove(t.parent, t); };
			if (p === "addEventListener") return (type, callback, options) => { if (typeof callback !== "function") return; const listenerId = nextId++; listeners.set(listenerId, { node: t, type: String(type), callback, once: !!options?.once }); emit("listen", { id: t.id, listenerId, eventType: String(type), once: !!options?.once }); };
			if (p === "removeEventListener") return (type, callback) => { for (const [id, l] of listeners) if (l.node === t && l.type === String(type) && l.callback === callback) { listeners.delete(id); emit("unlisten", { id: t.id, listenerId: id, eventType: l.type }); } };
			if (p === "contains") return other => { let n = raw(other); while (n) { if (n === t) return true; n = n.parent; } return false; };
			if (p === "click" || p === "focus" || p === "blur") return () => mutate(p, t);
			if (p === "cloneNode") return deep => { const data = serialize(t); data.id = nextId++; if (!deep) data.children = []; return wrap(build(data)); };
			return undefined;
		},
		set(t, p, value) {
			if (p === "id") { t.idName = String(value); t.attributes.id = t.idName; mutate("attribute", t, { name: "id", value: t.idName }); }
			else if (p === "className") { t.className = String(value); t.attributes.class = t.className; mutate("attribute", t, { name: "class", value: t.className }); }
			else if (p === "textContent" || p === "innerText") { t.text = String(value); t.children = []; mutate("text", t, { value: t.text }); }
			else if (p === "innerHTML") throw new DOMException("innerHTML is not supported; use textContent or createElement", "NotSupportedError");
			else if (p === "value" || p === "checked" || p === "disabled" || p === "title") { t.attributes[String(p)] = String(value); mutate("property", t, { property: String(p), value }); }
			else t[p] = value;
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
	if (child === root) throw new DOMException("Cannot move the permitted root", "NotAllowedError");
	if (child.parent) remove(child.parent, child);
	child.parent = parent;
	child.connected = parent.connected;
	parent.children.push(child);
	if (child.connected) emit("dom", { op: "append", id: parent.id, child: serialize(child) });
	return wrap(child);
}

function remove(parent, child) {
	const i = parent.children.indexOf(child);
	if (i < 0) throw new DOMException("Node is not a child", "NotFoundError");
	if (child === root) throw new DOMException("Cannot remove the permitted root", "NotAllowedError");
	parent.children.splice(i, 1);
	child.parent = null;
	child.connected = false;
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
		if (p === "createElement") return tag => { const n = build({ id: nextId++, tagName: String(tag).toUpperCase() }); n.connected = false; return wrap(n); };
		if (p === "createTextNode") return text => wrap(makeText(String(text)));
		if (p === "createComment") return text => { const n = makeText(String(text)); n.nodeType = 8; n.tagName = "#comment"; return wrap(n); };
		if (p === "createDocumentFragment") return () => { const n = build({ id: nextId++, nodeType: 11, tagName: "#fragment" }); n.connected = false; return wrap(n); };
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
