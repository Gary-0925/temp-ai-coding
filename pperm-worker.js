let stopped = false;
let nextId = 1;
let root = null;
let documentProxy = null;
const nodes = new Map();
const listeners = new Map();
const nodeDataByProxy = new WeakMap();

function emit(type, data = {}) {
	if (!stopped) postMessage({ type, ...data });
}

function denied(name) {
	throw new DOMException("Permission denied: " + name, "NotAllowedError");
}

class PermissionGate {
	constructor(permissions) {
		this.permissions = permissions ?? {};
	}

	check(capability = "dom") {
		if (stopped) throw new DOMException("Process has been terminated", "AbortError");
		if (capability === "dom" && !this.permissions.dom?.enabled) denied("dom");
		if (capability === "fetch" && !this.permissions.network?.fetch) denied("fetch");
		if (capability === "webSocket" && !this.permissions.network?.webSocket) denied("WebSocket");
		if (capability === "eventSource" && !this.permissions.network?.eventSource) denied("EventSource");
		if (capability === "xmlHttpRequest" && !this.permissions.network?.xmlHttpRequest) denied("XMLHttpRequest");
		if (capability === "indexedDB" && !this.permissions.storage?.indexedDB) denied("indexedDB");
		if (capability === "cache" && !this.permissions.storage?.cache) denied("Cache API");
	}
}

const blockedElements = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "meta", "link", "style", "svg", "math", "portal", "fencedframe", "webview"]);
const blockedAttributes = new Set(["srcdoc", "nonce", "integrity", "is", "action", "formaction"]);
const urlAttributes = new Set(["href", "src", "action", "formaction", "poster", "cite", "xlink:href", "background", "data", "manifest"]);
const blockedProperties = new Set(["innerHTML", "outerHTML", "srcdoc", "insertAdjacentHTML", "setHTMLUnsafe", "setHTML", "outerText", "__proto__", "prototype", "constructor"]);

function safeElementName(value) {
	const name = String(value).toLowerCase();
	if (!/^[a-z][a-z0-9-]*$/.test(name) || name.includes("-") || blockedElements.has(name)) {
		throw new DOMException("Element type is not permitted", "NotAllowedError");
	}
	return name;
}

function safeAttribute(name, value) {
	name = String(name).toLowerCase();
	if (!/^[a-z_:][a-z0-9_.:-]*$/.test(name) || name.startsWith("on") || blockedAttributes.has(name)) {
		throw new DOMException("Attribute is not permitted: " + name, "NotAllowedError");
	}
	if (urlAttributes.has(name)) {
		const url = String(value).trim().replace(/[\u0000-\u0020]+/g, "");
		if (/^(javascript|vbscript):/i.test(url) || /^data:(text\/html|application\/xhtml\+xml)/i.test(url)) {
			throw new DOMException("Executable URLs are not permitted", "NotAllowedError");
		}
	}
	return name;
}

function safeStyle(property, value) {
	if (/url\s*\(|expression\s*\(|@import|-moz-binding|behavior\s*:|\\|\/\*/i.test(String(value))) {
		throw new DOMException("Resource-loading CSS is not permitted", "NotAllowedError");
	}
	return String(property);
}

function selectorMatches(node, selector) {
	if (!node || node.nodeType !== 1) return false;
	selector = String(selector).trim();
	if (!selector || /[\s>+~,:[]/.test(selector)) {
		throw new DOMException("Only simple tag, #id, and .class selectors are currently supported", "NotSupportedError");
	}
	if (selector === "*") return true;
	if (selector[0] === "#") return node.idName === selector.slice(1);
	if (selector[0] === ".") return node.className.split(/\s+/).includes(selector.slice(1));
	return node.tagName.toLowerCase() === selector.toLowerCase();
}

function raw(node) {
	return nodeDataByProxy.get(node) ?? node;
}

function setConnected(data, connected) {
	data.connected = connected;
	for (const child of data.children) setConnected(child, connected);
}

function serialize(data) {
	return {
		id: data.id, nodeType: data.nodeType, tagName: data.tagName, idName: data.idName,
		className: data.className, text: data.text, attributes: { ...data.attributes },
		styleData: { ...data.styleData }, children: data.children.map(serialize)
	};
}

function makeData(input = {}, parent = null) {
	const data = {
		id: input.id ?? nextId++, nodeType: input.nodeType ?? 1,
		tagName: input.tagName ?? "#text", idName: input.idName ?? "",
		className: input.className ?? "", text: input.text ?? "",
		attributes: { ...(input.attributes ?? {}) }, styleData: { ...(input.styleData ?? {}) },
		parent, children: [], connected: input.connected ?? true
	};
	nodes.set(data.id, data);
	data.children = (input.children ?? []).map(child => makeData(child, data));
	return data;
}

function emitMutation(data, op, extra = {}) {
	if (data.connected) emit("dom", { op, id: data.id, ...extra });
}

class PpermStyle {
	constructor(owner, gate) {
		this.owner = owner;
		this.gate = gate;
		return new Proxy(this, {
			get: (target, property) => {
				target.gate.check("dom");
				if (typeof property === "symbol") return Reflect.get(target, property, target);
				if (String(property).startsWith("_") || ["owner", "gate", "constructor", "__proto__", "prototype"].includes(String(property))) denied(String(property));
				if (property in target) {
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				}
				return target.owner.styleData[String(property)] ?? "";
			},
			set: (target, property, value) => {
				target.gate.check("dom");
				if (String(property).startsWith("_") || ["owner", "gate", "constructor", "__proto__", "prototype"].includes(String(property))) denied(String(property));
				const name = safeStyle(property, value);
				target.owner.styleData[name] = String(value);
				emitMutation(target.owner, "style", { property: name, value: String(value) });
				return true;
			}
		});
	}

	setProperty(name, value, priority = "") {
		this.gate.check("dom");
		const property = safeStyle(name, value);
		const cssValue = String(value);
		this.owner.styleData[property.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = cssValue;
		emitMutation(this.owner, "style", { property, value: cssValue, priority: String(priority) });
	}

	getPropertyValue(name) {
		this.gate.check("dom");
		return this.owner.styleData[String(name).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? "";
	}

	removeProperty(name) {
		this.gate.check("dom");
		const key = String(name).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		const oldValue = this.owner.styleData[key] ?? "";
		delete this.owner.styleData[key];
		emitMutation(this.owner, "style", { property: String(name), value: "" });
		return oldValue;
	}
}

class PpermTokenList {
	constructor(owner, gate) {
		this.owner = owner;
		this.gate = gate;
		return new Proxy(this, {
			get: (target, property) => {
				target.gate.check("dom");
				if (typeof property === "symbol") return Reflect.get(target, property, target);
				const name = String(property);
				if (name.startsWith("_") || ["owner", "gate", "constructor", "__proto__", "prototype"].includes(name)) denied(name);
				if (property in target) {
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				}
				return undefined;
			},
			set: (target, property, value) => {
				target.gate.check("dom");
				if (String(property).startsWith("_") || ["owner", "gate", "constructor", "__proto__", "prototype"].includes(String(property))) denied(String(property));
				if (property === "value") {
					target.owner.className = String(value);
					target.owner.attributes.class = target.owner.className;
					emitMutation(target.owner, "attribute", { name: "class", value: target.owner.className });
					return true;
				}
				denied(String(property));
			}
		});
	}

	_values() {
		this.gate.check("dom");
		return this.owner.className.split(/\s+/).filter(Boolean);
	}

	_commit(values) {
		this.gate.check("dom");
		this.owner.className = [...new Set(values)].join(" ");
		this.owner.attributes.class = this.owner.className;
		emitMutation(this.owner, "attribute", { name: "class", value: this.owner.className });
	}

	contains(value) {
		this.gate.check("dom");
		return this._values().includes(String(value));
	}

	add(...values) {
		this.gate.check("dom");
		this._commit([...this._values(), ...values.map(String)]);
	}

	remove(...values) {
		this.gate.check("dom");
		const removeSet = new Set(values.map(String));
		this._commit(this._values().filter(value => !removeSet.has(value)));
	}

	toggle(value, force) {
		this.gate.check("dom");
		const values = this._values();
		const has = values.includes(String(value));
		if (force === true || (!has && force !== false)) this._commit([...values, String(value)]);
		else if (has) this._commit(values.filter(item => item !== String(value)));
		return this._values().includes(String(value));
	}

	replace(oldValue, newValue) {
		this.gate.check("dom");
		const values = this._values();
		const index = values.indexOf(String(oldValue));
		if (index < 0) return false;
		values[index] = String(newValue);
		this._commit(values);
		return true;
	}

	get value() {
		this.gate.check("dom");
		return this.owner.className;
	}

	set value(value) {
		this.gate.check("dom");
		this.owner.className = String(value);
		this.owner.attributes.class = this.owner.className;
		emitMutation(this.owner, "attribute", { name: "class", value: this.owner.className });
	}

	[Symbol.iterator]() {
		this.gate.check("dom");
		return this._values()[Symbol.iterator]();
	}
}

class PpermNode {
	constructor(data, gate) {
		this._data = data;
		this._gate = gate;
		this._style = new PpermStyle(data, gate);
		this._classList = new PpermTokenList(data, gate);
		this._eventProperties = new Map();
		const proxy = new Proxy(this, {
			get: (target, property) => {
				target._gate.check("dom");
				if (typeof property === "symbol") return Reflect.get(target, property, target);
				const name = String(property);
				if (name.startsWith("_") || ["constructor", "__proto__", "prototype"].includes(name)) denied(name);
				if (property in target) {
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				}
				return undefined;
			},
			set: (target, property, value) => {
				target._gate.check("dom");
				const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
				if (descriptor?.set || descriptor?.writable || property in target) return Reflect.set(target, property, value, target);
				denied(String(property));
			}
		});
		nodeDataByProxy.set(this, this._data);
		nodeDataByProxy.set(proxy, this._data);
		return proxy;
	}


	get id() { this._gate.check("dom"); return this._data.idName; }
	set id(value) { this._gate.check("dom"); const text=String(value); this._data.idName=text; this._data.attributes.id=text; emitMutation(this._data,"attribute",{name:"id",value:text}); }
	get className() { this._gate.check("dom"); return this._data.className; }
	set className(value) { this._gate.check("dom"); const text=String(value); this._data.className=text; this._data.attributes.class=text; emitMutation(this._data,"attribute",{name:"class",value:text}); }
	get tagName() { this._gate.check("dom"); return this._data.tagName; }
	get nodeName() { this._gate.check("dom"); return this._data.tagName; }
	get nodeType() { this._gate.check("dom"); return this._data.nodeType; }
	get nodeValue() { this._gate.check("dom"); return this._data.nodeType===3||this._data.nodeType===8?this._data.text:null; }
	set nodeValue(value) { this._gate.check("dom"); if(this._data.nodeType===3||this._data.nodeType===8){this._data.text=value==null?"":String(value);emitMutation(this._data,"text",{value:this._data.text});} }
	get data() { this._gate.check("dom"); return this._data.nodeType===3||this._data.nodeType===8?this._data.text:null; }
	set data(value) { this._gate.check("dom"); if(this._data.nodeType===3||this._data.nodeType===8){this._data.text=value==null?"":String(value);emitMutation(this._data,"text",{value:this._data.text});} }
	get textContent() { this._gate.check("dom"); if(this._data.nodeType===3||this._data.nodeType===8)return this._data.text; return this._data.text+this._data.children.map(c=>new PpermNode(c,this._gate).textContent).join(""); }
	set textContent(value) { this._gate.check("dom"); const d=this._data; for(const c of d.children){c.parent=null;setConnected(c,false);} d.children=[];d.text=value==null?"":String(value);emitMutation(d,"text",{value:d.text}); }
	get innerText() { this._gate.check("dom"); if(this._data.nodeType===3||this._data.nodeType===8)return this._data.text; return this._data.text+this._data.children.map(c=>new PpermNode(c,this._gate).innerText).join(""); }
	set innerText(value) { this._gate.check("dom"); const d=this._data; for(const c of d.children){c.parent=null;setConnected(c,false);} d.children=[];d.text=value==null?"":String(value);emitMutation(d,"text",{value:d.text}); }
	get style() { this._gate.check("dom"); return this._style; }
	get classList() { this._gate.check("dom"); return this._classList; }
	get isConnected() { this._gate.check("dom"); return this._data.connected; }
	get ownerDocument() { this._gate.check("dom"); return documentProxy; }
	get attributes() { this._gate.check("dom"); return Object.entries(this._data.attributes).map(([name,value])=>({name,value})); }
	get parentNode() { this._gate.check("dom"); return this._data.parent?new PpermNode(this._data.parent,this._gate):null; }
	get parentElement() { this._gate.check("dom"); return this._data.parent?.nodeType===1?new PpermNode(this._data.parent,this._gate):null; }
	get children() { this._gate.check("dom"); return this._data.children.filter(c=>c.nodeType===1).map(c=>new PpermNode(c,this._gate)); }
	get childNodes() { this._gate.check("dom"); return this._data.children.map(c=>new PpermNode(c,this._gate)); }
	get firstChild() { this._gate.check("dom"); const c=this._data.children[0];return c?new PpermNode(c,this._gate):null; }
	get lastChild() { this._gate.check("dom"); const a=this._data.children;return a.length?new PpermNode(a[a.length-1],this._gate):null; }
	get firstElementChild() { this._gate.check("dom"); const c=this._data.children.find(x=>x.nodeType===1);return c?new PpermNode(c,this._gate):null; }
	get lastElementChild() { this._gate.check("dom"); for(let i=this._data.children.length-1;i>=0;i--)if(this._data.children[i].nodeType===1)return new PpermNode(this._data.children[i],this._gate);return null; }
	get nextSibling() { this._gate.check("dom"); if(!this._data.parent)return null;const a=this._data.parent.children,i=a.indexOf(this._data);return a[i+1]?new PpermNode(a[i+1],this._gate):null; }
	get previousSibling() { this._gate.check("dom"); if(!this._data.parent)return null;const a=this._data.parent.children,i=a.indexOf(this._data);return i>0?new PpermNode(a[i-1],this._gate):null; }
	get nextElementSibling() { this._gate.check("dom"); if(!this._data.parent)return null;const a=this._data.parent.children.filter(c=>c.nodeType===1),i=a.indexOf(this._data);return a[i+1]?new PpermNode(a[i+1],this._gate):null; }
	get previousElementSibling() { this._gate.check("dom"); if(!this._data.parent)return null;const a=this._data.parent.children.filter(c=>c.nodeType===1),i=a.indexOf(this._data);return i>0?new PpermNode(a[i-1],this._gate):null; }
	hasChildNodes() { this._gate.check("dom"); return this._data.children.length>0; }
	contains(other) { this._gate.check("dom"); let n=raw(other);while(n){if(n===this._data)return true;n=n.parent;}return false; }
	get href() { this._gate.check("dom"); return this._data.attributes.href??""; }
	set href(value) { this._gate.check("dom"); const text=String(value);safeAttribute("href",text);this._data.attributes.href=text;emitMutation(this._data,"attribute",{name:"href",value:text}); }
	get src() { this._gate.check("dom"); return this._data.attributes.src??""; }
	set src(value) { this._gate.check("dom"); const text=String(value);safeAttribute("src",text);this._data.attributes.src=text;emitMutation(this._data,"attribute",{name:"src",value:text}); }
	get poster() { this._gate.check("dom"); return this._data.attributes.poster??""; }
	set poster(value) { this._gate.check("dom"); const text=String(value);safeAttribute("poster",text);this._data.attributes.poster=text;emitMutation(this._data,"attribute",{name:"poster",value:text}); }
	get title() { this._gate.check("dom"); return this._data.attributes.title??""; }
	set title(value) { this._gate.check("dom"); const text=String(value);this._data.attributes.title=text;emitMutation(this._data,"attribute",{name:"title",value:text}); }
	get value() { this._gate.check("dom"); return this._data.value??this._data.attributes.value??""; }
	set value(value) { this._gate.check("dom"); if(value!==null&&(typeof value==="object"||typeof value==="function"))throw new TypeError("DOM property value must be primitive");this._data.value=value;emitMutation(this._data,"property",{property:"value",value}); }
	get checked() { this._gate.check("dom"); return this._data.checked??false; }
	set checked(value) { this._gate.check("dom"); this._data.checked=Boolean(value);emitMutation(this._data,"property",{property:"checked",value:this._data.checked}); }
	get disabled() { this._gate.check("dom"); return this._data.disabled??false; }
	set disabled(value) { this._gate.check("dom"); this._data.disabled=Boolean(value);emitMutation(this._data,"property",{property:"disabled",value:this._data.disabled}); }
	get name() { this._gate.check("dom"); return this._data.attributes.name??""; }
	set name(value) { this._gate.check("dom"); const text=String(value);this._data.attributes.name=text;emitMutation(this._data,"attribute",{name:"name",value:text}); }
	get type() { this._gate.check("dom"); return this._data.attributes.type??""; }
	set type(value) { this._gate.check("dom"); const text=String(value);this._data.attributes.type=text;emitMutation(this._data,"attribute",{name:"type",value:text}); }

	get onclick() { this._gate.check("dom"); return this._eventProperties.get("onclick") ?? null; }
	set onclick(value) {
		this._gate.check("dom");
		const old = this._eventProperties.get("onclick");
		if (old) this.removeEventListener("click", old);
		if (value == null) { this._eventProperties.delete("onclick"); return; }
		if (typeof value !== "function") throw new TypeError("onclick must be a function or null");
		this._eventProperties.set("onclick", value);
		this.addEventListener("click", value);
	}

	get onchange() { this._gate.check("dom"); return this._eventProperties.get("onchange") ?? null; }
	set onchange(value) {
		this._gate.check("dom");
		const old = this._eventProperties.get("onchange");
		if (old) this.removeEventListener("change", old);
		if (value == null) { this._eventProperties.delete("onchange"); return; }
		if (typeof value !== "function") throw new TypeError("onchange must be a function or null");
		this._eventProperties.set("onchange", value);
		this.addEventListener("change", value);
	}

	get oninput() { this._gate.check("dom"); return this._eventProperties.get("oninput") ?? null; }
	set oninput(value) {
		this._gate.check("dom");
		const old = this._eventProperties.get("oninput");
		if (old) this.removeEventListener("input", old);
		if (value == null) { this._eventProperties.delete("oninput"); return; }
		if (typeof value !== "function") throw new TypeError("oninput must be a function or null");
		this._eventProperties.set("oninput", value);
		this.addEventListener("input", value);
	}

	get onsubmit() { this._gate.check("dom"); return this._eventProperties.get("onsubmit") ?? null; }
	set onsubmit(value) {
		this._gate.check("dom");
		const old = this._eventProperties.get("onsubmit");
		if (old) this.removeEventListener("submit", old);
		if (value == null) { this._eventProperties.delete("onsubmit"); return; }
		if (typeof value !== "function") throw new TypeError("onsubmit must be a function or null");
		this._eventProperties.set("onsubmit", value);
		this.addEventListener("submit", value);
	}

	get onfocus() { this._gate.check("dom"); return this._eventProperties.get("onfocus") ?? null; }
	set onfocus(value) {
		this._gate.check("dom");
		const old = this._eventProperties.get("onfocus");
		if (old) this.removeEventListener("focus", old);
		if (value == null) { this._eventProperties.delete("onfocus"); return; }
		if (typeof value !== "function") throw new TypeError("onfocus must be a function or null");
		this._eventProperties.set("onfocus", value);
		this.addEventListener("focus", value);
	}

	get onblur() { this._gate.check("dom"); return this._eventProperties.get("onblur") ?? null; }
	set onblur(value) {
		this._gate.check("dom");
		const old = this._eventProperties.get("onblur");
		if (old) this.removeEventListener("blur", old);
		if (value == null) { this._eventProperties.delete("onblur"); return; }
		if (typeof value !== "function") throw new TypeError("onblur must be a function or null");
		this._eventProperties.set("onblur", value);
		this.addEventListener("blur", value);
	}
	get innerHTML() { this._gate.check("dom"); denied("innerHTML"); }
	set innerHTML(value) { this._gate.check("dom"); denied("innerHTML"); }
	get outerHTML() { this._gate.check("dom"); denied("outerHTML"); }
	set outerHTML(value) { this._gate.check("dom"); denied("outerHTML"); }
	get outerText() { this._gate.check("dom"); denied("outerText"); }
	set outerText(value) { this._gate.check("dom"); denied("outerText"); }
	get srcdoc() { this._gate.check("dom"); denied("srcdoc"); }
	set srcdoc(value) { this._gate.check("dom"); denied("srcdoc"); }
	get insertAdjacentHTML() { this._gate.check("dom"); return () => { this._gate.check("dom"); denied("insertAdjacentHTML"); }; }
	get setHTMLUnsafe() { this._gate.check("dom"); return () => { this._gate.check("dom"); denied("setHTMLUnsafe"); }; }
	get setHTML() { this._gate.check("dom"); return () => { this._gate.check("dom"); denied("setHTML"); }; }

	getAttribute(name) {
		this._gate.check("dom");
		return this._data.attributes[String(name).toLowerCase()] ?? null;
	}

	hasAttribute(name) {
		this._gate.check("dom");
		return Object.hasOwn(this._data.attributes, String(name).toLowerCase());
	}

	setAttribute(name, value) {
		this._gate.check("dom");
		const safeName = safeAttribute(name, value);
		if (safeName === "style") safeStyle("style", value);
		const text = String(value);
		this._data.attributes[safeName] = text;
		if (safeName === "id") this._data.idName = text;
		if (safeName === "class") this._data.className = text;
		emitMutation(this._data, "attribute", { name: safeName, value: text });
	}

	removeAttribute(name) {
		this._gate.check("dom");
		const safeName = String(name).toLowerCase();
		if (safeName.startsWith("on") || blockedAttributes.has(safeName)) denied("attribute " + safeName);
		delete this._data.attributes[safeName];
		if (safeName === "id") this._data.idName = "";
		if (safeName === "class") this._data.className = "";
		emitMutation(this._data, "removeAttribute", { name: safeName });
	}

	matches(selector) {
		this._gate.check("dom");
		return selectorMatches(this._data, selector);
	}

	querySelector(selector) {
		this._gate.check("dom");
		return this.querySelectorAll(selector)[0] ?? null;
	}

	querySelectorAll(selector) {
		this._gate.check("dom");
		const results = [];
		const walk = node => {
			for (const child of node.children) {
				if (selectorMatches(child, selector)) results.push(new PpermNode(child, this._gate));
				walk(child);
			}
		};
		walk(this._data);
		return results;
	}

	closest(selector) {
		this._gate.check("dom");
		let node = this._data;
		while (node) {
			if (selectorMatches(node, selector)) return new PpermNode(node, this._gate);
			node = node.parent;
		}
		return null;
	}

	_appendRaw(child, before = null) {
		this._gate.check("dom");
		const parent = this._data;
		if (!(child instanceof PpermNode)) throw new TypeError("Expected a pperm Node");
		const item = raw(child);
		if (item === root) denied("moving the permitted root");
		if (item === parent || this.contains(child)) throw new DOMException("The operation would create a cycle", "HierarchyRequestError");
		if (before && before.parent !== parent) throw new DOMException("Reference node is not a child", "NotFoundError");
		if (item.nodeType === 11) {
			for (const nested of [...item.children]) this._appendRaw(new PpermNode(nested, this._gate), before ? new PpermNode(before, this._gate) : null);
			item.children = [];
			return child;
		}
		if (item.parent) new PpermNode(item.parent, this._gate).removeChild(child);
		item.parent = parent;
		setConnected(item, parent.connected);
		const index = before ? parent.children.indexOf(before) : -1;
		if (index < 0) parent.children.push(item);
		else parent.children.splice(index, 0, item);
		if (item.connected) emit("dom", { op: before ? "insert" : "append", id: parent.id, child: serialize(item), beforeId: before?.id ?? null });
		return child;
	}

	appendChild(child) {
		this._gate.check("dom");
		return this._appendRaw(child);
	}

	append(...items) {
		this._gate.check("dom");
		for (const item of items) this._appendRaw(item instanceof PpermNode ? item : new PpermNode(makeData({ nodeType: 3, tagName: "#text", text: String(item), connected: false }), this._gate));
	}

	prepend(...items) {
		this._gate.check("dom");
		const before = this._data.children[0] ?? null;
		for (const item of [...items].reverse()) this._appendRaw(item instanceof PpermNode ? item : new PpermNode(makeData({ nodeType: 3, tagName: "#text", text: String(item), connected: false }), this._gate), before);
	}

	insertBefore(child, before) {
		this._gate.check("dom");
		return this._appendRaw(child, before == null ? null : raw(before));
	}

	replaceChild(child, oldChild) {
		this._gate.check("dom");
		const old = raw(oldChild);
		if (!this._data.children.includes(old)) throw new DOMException("Node is not a child", "NotFoundError");
		if (raw(child) === old) return oldChild;
		this._appendRaw(child, old);
		this.removeChild(oldChild);
		return oldChild;
	}

	before(...items) {
		this._gate.check("dom");
		const parent = this._data.parent;
		if (!parent) return;
		const before = new PpermNode(parent, this._gate);
		for (const item of items) before.insertBefore(item instanceof PpermNode ? item : new PpermNode(makeData({ nodeType: 3, tagName: "#text", text: String(item), connected: false }), this._gate), this);
	}

	after(...items) {
		this._gate.check("dom");
		const parent = this._data.parent;
		if (!parent) return;
		const siblings = parent.children;
		const next = siblings[siblings.indexOf(this._data) + 1] ?? null;
		for (const item of items) new PpermNode(parent, this._gate).insertBefore(item instanceof PpermNode ? item : new PpermNode(makeData({ nodeType: 3, tagName: "#text", text: String(item), connected: false }), this._gate), next ? new PpermNode(next, this._gate) : null);
	}

	removeChild(child) {
		this._gate.check("dom");
		const item = raw(child);
		const index = this._data.children.indexOf(item);
		if (index < 0) throw new DOMException("Node is not a child", "NotFoundError");
		if (item === root) denied("removing the permitted root");
		this._data.children.splice(index, 1);
		item.parent = null;
		setConnected(item, false);
		emitMutation(this._data, "remove", { childId: item.id });
		return child;
	}

	replaceChildren(...items) {
		this._gate.check("dom");
		for (const child of [...this._data.children]) this.removeChild(new PpermNode(child, this._gate));
		this.append(...items);
	}

	remove() {
		this._gate.check("dom");
		if (this._data === root) denied("removing the permitted root");
		if (this._data.parent) new PpermNode(this._data.parent, this._gate).removeChild(this);
	}

	contains(other) {
		this._gate.check("dom");
		let node = raw(other);
		while (node) {
			if (node === this._data) return true;
			node = node.parent;
		}
		return false;
	}

	addEventListener(type, callback, options = {}) {
		this._gate.check("dom");
		if (callback == null) return;
		if (typeof callback !== "function" && typeof callback.handleEvent !== "function") throw new TypeError("Listener must be a function or an object with handleEvent");
		const listenerId = nextId++;
		const record = { node: this._data, type: String(type), callback, once: typeof options === "boolean" ? false : !!options?.once, capture: typeof options === "boolean" ? options : !!options?.capture };
		listeners.set(listenerId, record);
		emit("listen", { id: this._data.id, listenerId, eventType: record.type, once: record.once, capture: record.capture });
	}

	removeEventListener(type, callback, options = {}) {
		this._gate.check("dom");
		const capture = typeof options === "boolean" ? options : !!options?.capture;
		for (const [id, record] of listeners) {
			if (record.node === this._data && record.type === String(type) && record.callback === callback && record.capture === capture) {
				listeners.delete(id);
				emit("unlisten", { id: this._data.id, listenerId: id, eventType: record.type });
			}
		}
	}

	dispatchEvent(event) {
		this._gate.check("dom");
		if (!event || typeof event.type !== "string") throw new TypeError("dispatchEvent expects an Event-like object");
		const eventData = { type: event.type, detail: event.detail ?? null, bubbles: !!event.bubbles, cancelable: !!event.cancelable };
		emit("dispatch", { id: this._data.id, event: eventData });
		return true;
	}

	click() {
		this._gate.check("dom");
		emit("dispatch", { id: this._data.id, event: { type: "click", detail: null, bubbles: true, cancelable: true } });
	}

	focus() {
		this._gate.check("dom");
		emitMutation(this._data, "focus");
	}

	blur() {
		this._gate.check("dom");
		emitMutation(this._data, "blur");
	}

	cloneNode(deep = false) {
		this._gate.check("dom");
		const copy = serialize(this._data);
		const renew = item => {
			item.id = nextId++;
			if (item.nodeType === 1) { item.idName = ""; item.attributes = { ...item.attributes }; delete item.attributes.id; }
			if (!deep) item.children = [];
			else item.children.forEach(renew);
		};
		renew(copy);
		const data = makeData({ ...copy, connected: false });
		setConnected(data, false);
		return new PpermNode(data, this._gate);
	}

	getBoundingClientRect() {
		this._gate.check("dom");
		throw new DOMException("Layout measurements are asynchronous across the Worker bridge and are not supported yet", "NotSupportedError");
	}
}

class PpermDocument {
	constructor(gate) {
		this._gate = gate;
		return new Proxy(this, {
			get: (target, property) => {
				target._gate.check("dom");
				if (typeof property === "symbol") return Reflect.get(target, property, target);
				const name = String(property);
				if (name.startsWith("_") || ["constructor", "__proto__", "prototype"].includes(name)) denied(name);
				if (property in target) {
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				}
				return target._get(property);
			},
			set: (target, property, value) => {
				target._gate.check("dom");
				if (String(property).startsWith("_") || ["constructor", "__proto__", "prototype"].includes(String(property))) denied(String(property));
				if (property === "title") { emit("documentTitle", { value: String(value) }); return true; }
				throw new DOMException("Document property is read-only or unsupported: " + String(property), "NotSupportedError");
			}
		});
	}

	_get(property) {
		this._gate.check("dom");
		switch (property) {
			case "body": case "documentElement": return new PpermNode(root, this._gate);
			case "nodeType": return 9;
			case "title": return "";
			case "querySelector": return selector => this.querySelector(selector);
			case "querySelectorAll": return selector => this.querySelectorAll(selector);
			case "getElementById": return id => this.querySelector("#" + String(id));
			case "getElementsByClassName": return name => this.querySelectorAll("." + String(name).trim().split(/\s+/)[0]);
			case "getElementsByTagName": return name => this.querySelectorAll(String(name));
			case "createElement": return tag => this.createElement(tag);
			case "createTextNode": return text => this.createTextNode(text);
			case "createComment": return text => this.createComment(text);
			case "createDocumentFragment": return () => this.createDocumentFragment();
			case "createEvent": return () => { this._gate.check("dom"); throw new DOMException("Use dispatchEvent with an Event-like object", "NotSupportedError"); };
			case "addEventListener": return (type, callback, options) => this.body.addEventListener(type, callback, options);
			case "removeEventListener": return (type, callback, options) => this.body.removeEventListener(type, callback, options);
			default: return undefined;
		}
	}

	querySelector(selector) {
		this._gate.check("dom");
		return this.querySelectorAll(selector)[0] ?? null;
	}

	querySelectorAll(selector) {
		this._gate.check("dom");
		const out = [];
		const walk = data => {
			if (selectorMatches(data, selector)) out.push(new PpermNode(data, this._gate));
			data.children.forEach(walk);
		};
		walk(root);
		return out;
	}

	createElement(tagName, options) {
		this._gate.check("dom");
		if (options != null) throw new DOMException("Customized built-in elements are not supported", "NotSupportedError");
		const tag = safeElementName(tagName);
		return new PpermNode(makeData({ tagName: tag.toUpperCase(), connected: false }), this._gate);
	}

	createTextNode(text) {
		this._gate.check("dom");
		return new PpermNode(makeData({ nodeType: 3, tagName: "#text", text: String(text), connected: false }), this._gate);
	}

	createComment(text) {
		this._gate.check("dom");
		return new PpermNode(makeData({ nodeType: 8, tagName: "#comment", text: String(text), connected: false }), this._gate);
	}

	createDocumentFragment() {
		this._gate.check("dom");
		return new PpermNode(makeData({ nodeType: 11, tagName: "#fragment", connected: false }), this._gate);
	}
}

function errorPayload(error) {
	return { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack };
}

self.addEventListener("message", event => {
	const message = event.data;
	if (message?.type === "init") {
		try {
			const permissions = message.permissions ?? {};
			const gate = new PermissionGate(permissions);
			root = makeData(message.snapshot);
			nextId = Math.max(nextId, ...Array.from(nodes.keys(), id => Number(id) + 1));
			documentProxy = new PpermDocument(gate);
			const deniedGlobal = name => new Proxy(function() { gate.check(name); denied(name); }, {
				construct() { gate.check(name); denied(name); },
				get(_target, property) { gate.check(name); denied(name + "." + String(property)); }
			});
			const guarded = (name, capability, value) => new Proxy(value, {
				apply(target, thisArg, args) { gate.check(capability); return Reflect.apply(target, thisArg, args); },
				construct(target, args, newTarget) { gate.check(capability); return Reflect.construct(target, args, newTarget); },
				get(target, property, receiver) { gate.check(capability); return Reflect.get(target, property, receiver); }
			});
			const fetchApi = permissions.network?.fetch ? guarded("fetch", "fetch", self.fetch.bind(self)) : deniedGlobal("fetch");
			const WebSocketApi = permissions.network?.webSocket ? guarded("WebSocket", "webSocket", self.WebSocket) : deniedGlobal("WebSocket");
			const EventSourceApi = permissions.network?.eventSource ? guarded("EventSource", "eventSource", self.EventSource) : deniedGlobal("EventSource");
			const XhrApi = permissions.network?.xmlHttpRequest ? guarded("XMLHttpRequest", "xmlHttpRequest", self.XMLHttpRequest) : deniedGlobal("XMLHttpRequest");
			const indexedDBApi = permissions.storage?.indexedDB ? new Proxy(self.indexedDB, { get(target, property, receiver) { gate.check("indexedDB"); return Reflect.get(target, property, receiver); } }) : deniedGlobal("indexedDB");
			const cachesApi = permissions.storage?.cache ? new Proxy(self.caches, { get(target, property, receiver) { gate.check("cache"); return Reflect.get(target, property, receiver); } }) : deniedGlobal("caches");
			const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
			const run = new AsyncFunction("postMessage", "permissions", "document", "fetch", "WebSocket", "EventSource", "XMLHttpRequest", "indexedDB", "caches", message.code);
			Promise.resolve(run(value => emit("userMessage", { value }), permissions, permissions.dom?.enabled ? documentProxy : undefined, fetchApi, WebSocketApi, EventSourceApi, XhrApi, indexedDBApi, cachesApi))
				.then(value => emit("done", { value })).catch(error => emit("error", { error: errorPayload(error) }));
		} catch (error) {
			emit("error", { error: errorPayload(error) });
		}
	} else if (message?.type === "event") {
		const record = listeners.get(message.listenerId);
		if (!record || stopped) return;
		try {
			const eventObject = Object.freeze({
				type: message.event.type, detail: message.event.detail ?? null,
				target: new PpermNode(nodes.get(message.event.targetId ?? record.node.id) ?? record.node, new PermissionGate({ dom: { enabled: true } })),
				currentTarget: new PpermNode(record.node, new PermissionGate({ dom: { enabled: true } })),
				bubbles: !!message.event.bubbles, cancelable: !!message.event.cancelable,
				defaultPrevented: false, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}
			});
			if (typeof record.callback === "function") record.callback.call(new PpermNode(record.node, new PermissionGate({ dom: { enabled: true } })), eventObject);
			else record.callback.handleEvent(eventObject);
		} catch (error) {
			emit("error", { error: errorPayload(error) });
		}
		if (record.once) listeners.delete(message.listenerId);
	} else if (message?.type === "shutdown") {
		stopped = true;
		close();
	}
});
