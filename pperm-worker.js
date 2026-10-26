let stopped = false;
let nextId = 1;
let root = null;
let documentProxy = null;
let documentTitle = "";
const nodes = new Map();
const listeners = new Map();
const nodeDataByInstance = new WeakMap();

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
	property = String(property).trim();
	if (!/^(?:--[a-z0-9_-]+|-?[a-z][a-z0-9-]*)$/i.test(property) || ["__proto__", "prototype", "constructor"].includes(property.toLowerCase())) {
		throw new DOMException("CSS property name is not permitted", "NotAllowedError");
	}
	if (/url\s*\(|expression\s*\(|@import|-moz-binding|behavior\s*:|\\|\/\*/i.test(String(value))) {
		throw new DOMException("Resource-loading CSS is not permitted", "NotAllowedError");
	}
	return property;
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
	return nodeDataByInstance.get(node) ?? node;
}

function setConnected(data, connected) {
	data.connected = connected;
	for (const child of data.children) setConnected(child, connected);
}

function serialize(data) {
	return {
		id: data.id, nodeType: data.nodeType, tagName: data.tagName, idName: data.idName,
		className: data.className, text: data.text, attributes: { ...data.attributes },
		styleData: { ...data.styleData }, value: data.value, checked: data.checked, disabled: data.disabled,
		selected: data.selected, indeterminate: data.indeterminate, tabIndex: data.tabIndex, width: data.width,
		height: data.height, rows: data.rows, cols: data.cols, maxLength: data.maxLength, minLength: data.minLength,
		rowSpan: data.rowSpan, colSpan: data.colSpan, size: data.size, start: data.start, span: data.span,
		children: data.children.map(serialize)
	};
}

function makeData(input = {}, parent = null) {
	const data = {
		id: input.id ?? nextId++, nodeType: input.nodeType ?? 1,
		tagName: input.tagName ?? "#text", idName: input.idName ?? "",
		className: input.className ?? "", text: input.text ?? "",
		attributes: { ...(input.attributes ?? {}) }, styleData: { ...(input.styleData ?? {}) },
		value: input.value, checked: input.checked, disabled: input.disabled, selected: input.selected,
		indeterminate: input.indeterminate, tabIndex: input.tabIndex, width: input.width, height: input.height,
		rows: input.rows, cols: input.cols, maxLength: input.maxLength, minLength: input.minLength,
		rowSpan: input.rowSpan, colSpan: input.colSpan, size: input.size, start: input.start, span: input.span,
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
	#owner;
	#gate;
	constructor(owner, gate) {
		this.#owner = owner;
		this.#gate = gate;
		Object.preventExtensions(this);
		return new Proxy(this, {
			get(target, property) {
				if (typeof property === "string" && ["__proto__", "prototype", "constructor"].includes(property)) denied(property);
				if (typeof property !== "string" || property in target) {
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				}
				target.#gate.check("dom");
				const key = property === "cssFloat" ? "float" : property.startsWith("--") ? property : property.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
				return target.#owner.styleData[key] ?? "";
			},
			set(target, property, value) {
				if (typeof property === "string" && ["__proto__", "prototype", "constructor"].includes(property)) denied(property);
				if (typeof property !== "string" || property in target) return Reflect.set(target, property, value, target);
				target.#gate.check("dom");
				const name = property === "cssFloat" ? "float" : property.startsWith("--") ? property : property.replace(/[A-Z]/g, character => "-" + character.toLowerCase());
				const cssValue = String(value);
				const safeName = safeStyle(name, cssValue);
				const key = safeName.startsWith("--") ? safeName : safeName.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
				target.#owner.styleData[key] = cssValue;
				emitMutation(target.#owner, "style", { property: safeName, value: cssValue });
				return true;
			}
		});
	}

	get cssText() {
		this.#gate.check("dom");
		return Object.entries(this.#owner.styleData).map(([name, value]) => (name.startsWith("--") ? name : name.replace(/[A-Z]/g, c => "-" + c.toLowerCase())) + ": " + value + ";").join(" ");
	}
	set cssText(value) {
		this.#gate.check("dom");
		const text = String(value);
		safeStyle("style", text);
		this.#owner.styleData = {};
		emitMutation(this.#owner, "styleText", { value: text });
	}
	get length() { this.#gate.check("dom"); return Object.keys(this.#owner.styleData).length; }
	item(index) { this.#gate.check("dom"); const name = Object.keys(this.#owner.styleData)[Number(index)];
		return name == null ? "" : (name.startsWith("--") ? name : name.replace(/[A-Z]/g, c => "-" + c.toLowerCase())); }
	setProperty(name, value, priority = "") {
		this.#gate.check("dom");
		const cssValue = String(value);
		const property = safeStyle(name, cssValue);
		const cssPriority = String(priority);
		if (cssPriority.trim() && cssPriority.trim().toLowerCase() !== "important") {
			throw new TypeError("CSS priority must be empty or \"important\"");
		}
		const key = property.startsWith("--") ? property : property.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		if (cssValue === "") delete this.#owner.styleData[key];
		else this.#owner.styleData[key] = cssValue;
		emitMutation(this.#owner, "styleSetProperty", { property, value: cssValue, priority: cssPriority });
	}
	getPropertyValue(name) {
		this.#gate.check("dom");
		const property = String(name);
		const key = property.startsWith("--") ? property : property.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		return this.#owner.styleData[key] ?? "";
	}
	getPropertyPriority(name) { this.#gate.check("dom"); return ""; }
	[Symbol.iterator]() { this.#gate.check("dom"); return Array.from({ length: this.length }, (_, index) => this.item(index))[Symbol.iterator](); }
	removeProperty(name) {
		this.#gate.check("dom");
		const property = safeStyle(name, "");
		const key = property.startsWith("--") ? property : property.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		const oldValue = this.#owner.styleData[key] ?? "";
		delete this.#owner.styleData[key];
		emitMutation(this.#owner, "styleRemoveProperty", { property });
		return oldValue;
	}
}

class PpermTokenList {
	#owner;
	#gate;
	constructor(owner, gate) {
		this.#owner = owner;
		this.#gate = gate;
		Object.preventExtensions(this);
	}

	_values() {
		this.#gate.check("dom");
		return this.#owner.className.split(/\s+/).filter(Boolean);
	}

	_commit(values) {
		this.#gate.check("dom");
		this.#owner.className = [...new Set(values)].join(" ");
		this.#owner.attributes.class = this.#owner.className;
		emitMutation(this.#owner, "attribute", { name: "class", value: this.#owner.className });
	}

	get length() { this.#gate.check("dom"); return this._values().length; }

	item(index) {
		this.#gate.check("dom");
		return this._values()[Number(index)] ?? null;
	}

	entries() {
		this.#gate.check("dom");
		return this._values().entries();
	}

	keys() {
		this.#gate.check("dom");
		return this._values().keys();
	}

	values() {
		this.#gate.check("dom");
		return this._values().values();
	}

	forEach(callback, thisArg) {
		this.#gate.check("dom");
		if (typeof callback !== "function") throw new TypeError("Callback must be a function");
		this._values().forEach((value, index, values) => callback.call(thisArg, value, value, this));
	}

	toString() {
		this.#gate.check("dom");
		return this.#owner.className;
	}

	contains(value) {
		this.#gate.check("dom");
		return this._values().includes(String(value));
	}

	add(...values) {
		this.#gate.check("dom");
		this._commit([...this._values(), ...values.map(String)]);
	}

	remove(...values) {
		this.#gate.check("dom");
		const removeSet = new Set(values.map(String));
		this._commit(this._values().filter(value => !removeSet.has(value)));
	}

	toggle(value, force) {
		this.#gate.check("dom");
		const values = this._values();
		const has = values.includes(String(value));
		if (force === true || (!has && force !== false)) this._commit([...values, String(value)]);
		else if (has) this._commit(values.filter(item => item !== String(value)));
		return this._values().includes(String(value));
	}

	replace(oldValue, newValue) {
		this.#gate.check("dom");
		const values = this._values();
		const index = values.indexOf(String(oldValue));
		if (index < 0) return false;
		values[index] = String(newValue);
		this._commit(values);
		return true;
	}

	get value() {
		this.#gate.check("dom");
		return this.#owner.className;
	}

	set value(value) {
		this.#gate.check("dom");
		this.#owner.className = String(value);
		this.#owner.attributes.class = this.#owner.className;
		emitMutation(this.#owner, "attribute", { name: "class", value: this.#owner.className });
	}

	[Symbol.iterator]() {
		this.#gate.check("dom");
		return this._values()[Symbol.iterator]();
	}
}

class PpermNode {
	#data;
	#gate;
	#style;
	#classList;
	#eventProperties;
	constructor(data, gate) {
		this.#data = data;
		this.#gate = gate;
		this.#style = new PpermStyle(data, gate);
		this.#classList = new PpermTokenList(data, gate);
		this.#eventProperties = new Map();
		nodeDataByInstance.set(this, this.#data);
		Object.preventExtensions(this);
	}


	get id() { this.#gate.check("dom"); return this.#data.idName; }
	set id(value) { this.#gate.check("dom"); const text=String(value); this.#data.idName=text; this.#data.attributes.id=text; emitMutation(this.#data,"attribute",{name:"id",value:text}); }
	get className() { this.#gate.check("dom"); return this.#data.className; }
	set className(value) { this.#gate.check("dom"); const text=String(value); this.#data.className=text; this.#data.attributes.class=text; emitMutation(this.#data,"attribute",{name:"class",value:text}); }
	get tagName() { this.#gate.check("dom"); return this.#data.tagName; }
	get nodeName() { this.#gate.check("dom"); return this.#data.tagName; }
	get nodeType() { this.#gate.check("dom"); return this.#data.nodeType; }
	get localName() { this.#gate.check("dom"); return this.#data.nodeType === 1 ? this.#data.tagName.toLowerCase() : null; }
	get namespaceURI() { this.#gate.check("dom"); return this.#data.nodeType === 1 ? "http://www.w3.org/1999/xhtml" : null; }
	get prefix() { this.#gate.check("dom"); return null; }
	get baseURI() { this.#gate.check("dom"); return documentProxy?.baseURI ?? ""; }
	get isContentEditable() {
		this.#gate.check("dom");
		for (let node = this.#data; node; node = node.parent) {
			if (!Object.hasOwn(node.attributes, "contenteditable")) continue;
			const value = String(node.attributes.contenteditable).toLowerCase();
			if (value === "false") return false;
			if (value === "" || value === "true" || value === "plaintext-only") return true;
		}
		return false;
	}
	get offsetParent() { this.#gate.check("dom"); throw new DOMException("Layout measurements are asynchronous across the Worker bridge and are not supported yet", "NotSupportedError"); }
	get offsetWidth() { this.#gate.check("dom"); throw new DOMException("Layout measurements are asynchronous across the Worker bridge and are not supported yet", "NotSupportedError"); }
	get offsetHeight() { this.#gate.check("dom"); throw new DOMException("Layout measurements are asynchronous across the Worker bridge and are not supported yet", "NotSupportedError"); }
	get offsetTop() { this.#gate.check("dom"); throw new DOMException("Layout measurements are asynchronous across the Worker bridge and are not supported yet", "NotSupportedError"); }
	get offsetLeft() { this.#gate.check("dom"); throw new DOMException("Layout measurements are asynchronous across the Worker bridge and are not supported yet", "NotSupportedError"); }
	get clientWidth() { this.#gate.check("dom"); throw new DOMException("Layout measurements are asynchronous across the Worker bridge and are not supported yet", "NotSupportedError"); }
	get clientHeight() { this.#gate.check("dom"); throw new DOMException("Layout measurements are asynchronous across the Worker bridge and are not supported yet", "NotSupportedError"); }
	get clientTop() { this.#gate.check("dom"); throw new DOMException("Layout measurements are asynchronous across the Worker bridge and are not supported yet", "NotSupportedError"); }
	get clientLeft() { this.#gate.check("dom"); throw new DOMException("Layout measurements are asynchronous across the Worker bridge and are not supported yet", "NotSupportedError"); }
	get scrollWidth() { this.#gate.check("dom"); throw new DOMException("Layout measurements are asynchronous across the Worker bridge and are not supported yet", "NotSupportedError"); }
	get scrollHeight() { this.#gate.check("dom"); throw new DOMException("Layout measurements are asynchronous across the Worker bridge and are not supported yet", "NotSupportedError"); }
	get scrollTop() { this.#gate.check("dom"); throw new DOMException("Scrolling is not exposed by the DOM bridge", "NotSupportedError"); }
	set scrollTop(value) { this.#gate.check("dom"); throw new DOMException("Scrolling is not exposed by the DOM bridge", "NotSupportedError"); }
	get scrollLeft() { this.#gate.check("dom"); throw new DOMException("Scrolling is not exposed by the DOM bridge", "NotSupportedError"); }
	set scrollLeft(value) { this.#gate.check("dom"); throw new DOMException("Scrolling is not exposed by the DOM bridge", "NotSupportedError"); }
	get childElementCount() { this.#gate.check("dom"); return this.#data.children.filter(child => child.nodeType === 1).length; }
	get dataset() {
		this.#gate.check("dom");
		const result = {};
		for (const [name] of Object.entries(this.#data.attributes)) {
			if (!name.startsWith("data-") || name.length <= 5) continue;
			const key = name.slice(5).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
			if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) continue;
			const node = this;
			Object.defineProperty(result, key, {
				enumerable: true,
					get() { node.#gate.check("dom"); return node.#data.attributes[name]; },
					set(value) { node.#gate.check("dom"); node.setAttribute(name, value); }
			});
		}
		return Object.preventExtensions(result);
	}
	get nodeValue() { this.#gate.check("dom"); return this.#data.nodeType===3||this.#data.nodeType===8?this.#data.text:null; }
	set nodeValue(value) { this.#gate.check("dom"); if(this.#data.nodeType===3||this.#data.nodeType===8){this.#data.text=value==null?"":String(value);emitMutation(this.#data,"text",{value:this.#data.text});} }
	get data() { this.#gate.check("dom"); return this.#data.nodeType===3||this.#data.nodeType===8?this.#data.text:null; }
	set data(value) { this.#gate.check("dom"); if(this.#data.nodeType===3||this.#data.nodeType===8){this.#data.text=value==null?"":String(value);emitMutation(this.#data,"text",{value:this.#data.text});} }
	get textContent() { this.#gate.check("dom"); if(this.#data.nodeType===3||this.#data.nodeType===8)return this.#data.text; return this.#data.text+this.#data.children.map(c=>new PpermNode(c,this.#gate).textContent).join(""); }
	set textContent(value) { this.#gate.check("dom"); const d=this.#data; for(const c of d.children){c.parent=null;setConnected(c,false);} d.children=[];d.text=value==null?"":String(value);emitMutation(d,"text",{value:d.text}); }
	get innerText() { this.#gate.check("dom"); if(this.#data.nodeType===3||this.#data.nodeType===8)return this.#data.text; return this.#data.text+this.#data.children.map(c=>new PpermNode(c,this.#gate).innerText).join(""); }
	set innerText(value) { this.#gate.check("dom"); const d=this.#data; for(const c of d.children){c.parent=null;setConnected(c,false);} d.children=[];d.text=value==null?"":String(value);emitMutation(d,"text",{value:d.text}); }
	get style() { this.#gate.check("dom"); return this.#style; }
	get classList() { this.#gate.check("dom"); return this.#classList; }
	get isConnected() { this.#gate.check("dom"); return this.#data.connected; }
	get ownerDocument() { this.#gate.check("dom"); return documentProxy; }
	get attributes() { this.#gate.check("dom"); return Object.entries(this.#data.attributes).filter(([name]) => !name.toLowerCase().startsWith("on") && !blockedAttributes.has(name.toLowerCase())).map(([name,value])=>({name,value})); }
	get parentNode() { this.#gate.check("dom"); if (this.#data === root) return documentProxy; return this.#data.parent ? new PpermNode(this.#data.parent, this.#gate) : null; }
	get parentElement() { this.#gate.check("dom"); return this.#data.parent?.nodeType===1?new PpermNode(this.#data.parent,this.#gate):null; }
	get children() { this.#gate.check("dom"); return this.#data.children.filter(c=>c.nodeType===1).map(c=>new PpermNode(c,this.#gate)); }
	get childNodes() { this.#gate.check("dom"); return this.#data.children.map(c=>new PpermNode(c,this.#gate)); }
	get firstChild() { this.#gate.check("dom"); const c=this.#data.children[0];return c?new PpermNode(c,this.#gate):null; }
	get lastChild() { this.#gate.check("dom"); const a=this.#data.children;return a.length?new PpermNode(a[a.length-1],this.#gate):null; }
	get firstElementChild() { this.#gate.check("dom"); const c=this.#data.children.find(x=>x.nodeType===1);return c?new PpermNode(c,this.#gate):null; }
	get lastElementChild() { this.#gate.check("dom"); for(let i=this.#data.children.length-1;i>=0;i--)if(this.#data.children[i].nodeType===1)return new PpermNode(this.#data.children[i],this.#gate);return null; }
	get nextSibling() { this.#gate.check("dom"); if(!this.#data.parent)return null;const a=this.#data.parent.children,i=a.indexOf(this.#data);return a[i+1]?new PpermNode(a[i+1],this.#gate):null; }
	get previousSibling() { this.#gate.check("dom"); if(!this.#data.parent)return null;const a=this.#data.parent.children,i=a.indexOf(this.#data);return i>0?new PpermNode(a[i-1],this.#gate):null; }
	get nextElementSibling() { this.#gate.check("dom"); if(!this.#data.parent)return null;const a=this.#data.parent.children.filter(c=>c.nodeType===1),i=a.indexOf(this.#data);return a[i+1]?new PpermNode(a[i+1],this.#gate):null; }
	get previousElementSibling() { this.#gate.check("dom"); if(!this.#data.parent)return null;const a=this.#data.parent.children.filter(c=>c.nodeType===1),i=a.indexOf(this.#data);return i>0?new PpermNode(a[i-1],this.#gate):null; }
	getRootNode(options = {}) {
		this.#gate.check("dom");
		if (this.#data.connected) return documentProxy;
		let node = this.#data;
		while (node.parent) node = node.parent;
		return new PpermNode(node, this.#gate);
	}

	isSameNode(other) {
		this.#gate.check("dom");
		return raw(other) === this.#data;
	}

	isEqualNode(other) {
		this.#gate.check("dom");
		const candidate = raw(other);
		if (!candidate || typeof candidate !== "object") return false;
		const equal = (left, right) => {
			if (left.nodeType !== right.nodeType || left.tagName !== right.tagName || left.idName !== right.idName || left.className !== right.className || left.text !== right.text) return false;
			if (JSON.stringify(left.attributes) !== JSON.stringify(right.attributes) || JSON.stringify(left.styleData) !== JSON.stringify(right.styleData) || left.children.length !== right.children.length) return false;
			return left.children.every((child, index) => equal(child, right.children[index]));
		};
		return equal(this.#data, candidate);
	}

	compareDocumentPosition(other) {
		this.#gate.check("dom");
		const candidate = raw(other);
		if (!candidate || typeof candidate !== "object" || typeof candidate.nodeType !== "number") return 1 | 32;
		if (candidate === this.#data) return 0;
		if (this.contains(other)) return 4 | 16;
		if (new PpermNode(candidate, this.#gate).contains(this)) return 2 | 8;
		const rootOf = node => { while (node.parent) node = node.parent; return node; };
		const leftRoot = rootOf(this.#data), rightRoot = rootOf(candidate);
		if (leftRoot !== rightRoot) return 1 | 32;
		const order = [];
		const walk = node => { order.push(node); node.children.forEach(walk); };
		walk(leftRoot);
		return order.indexOf(this.#data) < order.indexOf(candidate) ? 4 : 2;
	}

	normalize() {
		this.#gate.check("dom");
		const visit = parent => {
			let previousText = null;
			for (let index = 0; index < parent.children.length;) {
				const child = parent.children[index];
				if (child.nodeType === 3) {
					if (child.text === "") {
						parent.children.splice(index, 1);
						child.parent = null;
						setConnected(child, false);
						emitMutation(parent, "remove", { childId: child.id });
						continue;
					}
					if (previousText) {
						previousText.text += child.text;
						emitMutation(previousText, "text", { value: previousText.text });
						parent.children.splice(index, 1);
						child.parent = null;
						setConnected(child, false);
						emitMutation(parent, "remove", { childId: child.id });
						continue;
					}
					previousText = child;
				} else {
					previousText = null;
					visit(child);
				}
				index++;
			}
		};
		visit(this.#data);
	}

	getClientRects() {
		this.#gate.check("dom");
		throw new DOMException("Layout measurements are asynchronous across the Worker bridge and are not supported yet", "NotSupportedError");
	}

	scrollIntoView() {
		this.#gate.check("dom");
		throw new DOMException("Scrolling is not exposed by the DOM bridge", "NotSupportedError");
	}

	attachShadow() {
		this.#gate.check("dom");
		denied("attachShadow");
	}

	get shadowRoot() { this.#gate.check("dom"); return null; }
	get assignedSlot() { this.#gate.check("dom"); return null; }

	hasChildNodes() { this.#gate.check("dom"); return this.#data.children.length>0; }
	get href() { this.#gate.check("dom"); return this.#data.attributes.href??""; }
	set href(value) { this.#gate.check("dom"); const text=String(value);safeAttribute("href",text);this.#data.attributes.href=text;emitMutation(this.#data,"attribute",{name:"href",value:text}); }
	get src() { this.#gate.check("dom"); return this.#data.attributes.src??""; }
	set src(value) { this.#gate.check("dom"); const text=String(value);safeAttribute("src",text);this.#data.attributes.src=text;emitMutation(this.#data,"attribute",{name:"src",value:text}); }
	get poster() { this.#gate.check("dom"); return this.#data.attributes.poster??""; }
	set poster(value) { this.#gate.check("dom"); const text=String(value);safeAttribute("poster",text);this.#data.attributes.poster=text;emitMutation(this.#data,"attribute",{name:"poster",value:text}); }
	get title() { this.#gate.check("dom"); return this.#data.attributes.title??""; }
	set title(value) { this.#gate.check("dom"); const text=String(value);this.#data.attributes.title=text;emitMutation(this.#data,"attribute",{name:"title",value:text}); }
	get value() { this.#gate.check("dom"); return this.#data.value??this.#data.attributes.value??""; }
	set value(value) { this.#gate.check("dom"); if(value!==null&&(typeof value==="object"||typeof value==="function"))throw new TypeError("DOM property value must be primitive");this.#data.value=value;emitMutation(this.#data,"property",{property:"value",value}); }
	get checked() { this.#gate.check("dom"); return this.#data.checked ?? Object.hasOwn(this.#data.attributes, "checked"); }
	set checked(value) { this.#gate.check("dom"); this.#data.checked=Boolean(value);emitMutation(this.#data,"property",{property:"checked",value:this.#data.checked}); }
	get disabled() { this.#gate.check("dom"); return this.#data.disabled ?? Object.hasOwn(this.#data.attributes, "disabled"); }
	set disabled(value) { this.#gate.check("dom"); this.#data.disabled = Boolean(value); if (this.#data.disabled) this.#data.attributes.disabled = ""; else delete this.#data.attributes.disabled; emitMutation(this.#data, "property", { property: "disabled", value: this.#data.disabled }); }
	get name() { this.#gate.check("dom"); return this.#data.attributes.name??""; }
	set name(value) { this.#gate.check("dom"); const text=String(value);this.#data.attributes.name=text;emitMutation(this.#data,"attribute",{name:"name",value:text}); }
	get type() { this.#gate.check("dom"); return this.#data.attributes.type??""; }
	set type(value) { this.#gate.check("dom"); const text=String(value);this.#data.attributes.type=text;emitMutation(this.#data,"attribute",{name:"type",value:text}); }
	get defaultValue() { this.#gate.check("dom"); return this.#data.attributes.value ?? ""; }
	set defaultValue(value) { this.#gate.check("dom"); this.setAttribute("value", value); }
	get defaultSelected() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "selected"); }
	set defaultSelected(value) { this.#gate.check("dom"); if (value) this.#data.attributes.selected = ""; else delete this.#data.attributes.selected; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "selected", value: "" } : { name: "selected" }); }

	get accessKey() { this.#gate.check("dom"); return this.#data.attributes["accesskey"] ?? ""; }
	set accessKey(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("accesskey", text); this.#data.attributes["accesskey"] = text; emitMutation(this.#data, "attribute", { name: "accesskey", value: text }); }
	get accept() { this.#gate.check("dom"); return this.#data.attributes["accept"] ?? ""; }
	set accept(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("accept", text); this.#data.attributes["accept"] = text; emitMutation(this.#data, "attribute", { name: "accept", value: text }); }
	get alt() { this.#gate.check("dom"); return this.#data.attributes["alt"] ?? ""; }
	set alt(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("alt", text); this.#data.attributes["alt"] = text; emitMutation(this.#data, "attribute", { name: "alt", value: text }); }
	get autocomplete() { this.#gate.check("dom"); return this.#data.attributes["autocomplete"] ?? ""; }
	set autocomplete(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("autocomplete", text); this.#data.attributes["autocomplete"] = text; emitMutation(this.#data, "attribute", { name: "autocomplete", value: text }); }
	get capture() { this.#gate.check("dom"); return this.#data.attributes["capture"] ?? ""; }
	set capture(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("capture", text); this.#data.attributes["capture"] = text; emitMutation(this.#data, "attribute", { name: "capture", value: text }); }
	get cite() { this.#gate.check("dom"); return this.#data.attributes["cite"] ?? ""; }
	set cite(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("cite", text); this.#data.attributes["cite"] = text; emitMutation(this.#data, "attribute", { name: "cite", value: text }); }
	get contentEditable() { this.#gate.check("dom"); return this.#data.attributes["contenteditable"] ?? ""; }
	set contentEditable(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("contenteditable", text); this.#data.attributes["contenteditable"] = text; emitMutation(this.#data, "attribute", { name: "contenteditable", value: text }); }
	get crossOrigin() { this.#gate.check("dom"); return this.#data.attributes["crossorigin"] ?? ""; }
	set crossOrigin(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("crossorigin", text); this.#data.attributes["crossorigin"] = text; emitMutation(this.#data, "attribute", { name: "crossorigin", value: text }); }
	get dir() { this.#gate.check("dom"); return this.#data.attributes["dir"] ?? ""; }
	set dir(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("dir", text); this.#data.attributes["dir"] = text; emitMutation(this.#data, "attribute", { name: "dir", value: text }); }
	get draggable() { this.#gate.check("dom"); return this.#data.attributes["draggable"] ?? ""; }
	set draggable(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("draggable", text); this.#data.attributes["draggable"] = text; emitMutation(this.#data, "attribute", { name: "draggable", value: text }); }
	get enterKeyHint() { this.#gate.check("dom"); return this.#data.attributes["enterkeyhint"] ?? ""; }
	set enterKeyHint(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("enterkeyhint", text); this.#data.attributes["enterkeyhint"] = text; emitMutation(this.#data, "attribute", { name: "enterkeyhint", value: text }); }
	get formEnctype() { this.#gate.check("dom"); return this.#data.attributes["formenctype"] ?? ""; }
	set formEnctype(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("formenctype", text); this.#data.attributes["formenctype"] = text; emitMutation(this.#data, "attribute", { name: "formenctype", value: text }); }
	get formMethod() { this.#gate.check("dom"); return this.#data.attributes["formmethod"] ?? ""; }
	set formMethod(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("formmethod", text); this.#data.attributes["formmethod"] = text; emitMutation(this.#data, "attribute", { name: "formmethod", value: text }); }
	get formTarget() { this.#gate.check("dom"); return this.#data.attributes["formtarget"] ?? ""; }
	set formTarget(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("formtarget", text); this.#data.attributes["formtarget"] = text; emitMutation(this.#data, "attribute", { name: "formtarget", value: text }); }
	get htmlFor() { this.#gate.check("dom"); return this.#data.attributes["for"] ?? ""; }
	set htmlFor(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("for", text); this.#data.attributes["for"] = text; emitMutation(this.#data, "attribute", { name: "for", value: text }); }
	get inputMode() { this.#gate.check("dom"); return this.#data.attributes["inputmode"] ?? ""; }
	set inputMode(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("inputmode", text); this.#data.attributes["inputmode"] = text; emitMutation(this.#data, "attribute", { name: "inputmode", value: text }); }
	get lang() { this.#gate.check("dom"); return this.#data.attributes["lang"] ?? ""; }
	set lang(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("lang", text); this.#data.attributes["lang"] = text; emitMutation(this.#data, "attribute", { name: "lang", value: text }); }
	get max() { this.#gate.check("dom"); return this.#data.attributes["max"] ?? ""; }
	set max(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("max", text); this.#data.attributes["max"] = text; emitMutation(this.#data, "attribute", { name: "max", value: text }); }
	get media() { this.#gate.check("dom"); return this.#data.attributes["media"] ?? ""; }
	set media(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("media", text); this.#data.attributes["media"] = text; emitMutation(this.#data, "attribute", { name: "media", value: text }); }
	get min() { this.#gate.check("dom"); return this.#data.attributes["min"] ?? ""; }
	set min(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("min", text); this.#data.attributes["min"] = text; emitMutation(this.#data, "attribute", { name: "min", value: text }); }
	get placeholder() { this.#gate.check("dom"); return this.#data.attributes["placeholder"] ?? ""; }
	set placeholder(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("placeholder", text); this.#data.attributes["placeholder"] = text; emitMutation(this.#data, "attribute", { name: "placeholder", value: text }); }
	get referrerPolicy() { this.#gate.check("dom"); return this.#data.attributes["referrerpolicy"] ?? ""; }
	set referrerPolicy(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("referrerpolicy", text); this.#data.attributes["referrerpolicy"] = text; emitMutation(this.#data, "attribute", { name: "referrerpolicy", value: text }); }
	get rel() { this.#gate.check("dom"); return this.#data.attributes["rel"] ?? ""; }
	set rel(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("rel", text); this.#data.attributes["rel"] = text; emitMutation(this.#data, "attribute", { name: "rel", value: text }); }
	get role() { this.#gate.check("dom"); return this.#data.attributes["role"] ?? ""; }
	set role(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("role", text); this.#data.attributes["role"] = text; emitMutation(this.#data, "attribute", { name: "role", value: text }); }
	get scope() { this.#gate.check("dom"); return this.#data.attributes["scope"] ?? ""; }
	set scope(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("scope", text); this.#data.attributes["scope"] = text; emitMutation(this.#data, "attribute", { name: "scope", value: text }); }
	get slot() { this.#gate.check("dom"); return this.#data.attributes["slot"] ?? ""; }
	set slot(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("slot", text); this.#data.attributes["slot"] = text; emitMutation(this.#data, "attribute", { name: "slot", value: text }); }
	get spellcheck() { this.#gate.check("dom"); return this.#data.attributes["spellcheck"] ?? ""; }
	set spellcheck(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("spellcheck", text); this.#data.attributes["spellcheck"] = text; emitMutation(this.#data, "attribute", { name: "spellcheck", value: text }); }
	get step() { this.#gate.check("dom"); return this.#data.attributes["step"] ?? ""; }
	set step(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("step", text); this.#data.attributes["step"] = text; emitMutation(this.#data, "attribute", { name: "step", value: text }); }
	get target() { this.#gate.check("dom"); return this.#data.attributes["target"] ?? ""; }
	set target(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("target", text); this.#data.attributes["target"] = text; emitMutation(this.#data, "attribute", { name: "target", value: text }); }
	get translate() { this.#gate.check("dom"); return this.#data.attributes["translate"] ?? ""; }
	set translate(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("translate", text); this.#data.attributes["translate"] = text; emitMutation(this.#data, "attribute", { name: "translate", value: text }); }
	get wrap() { this.#gate.check("dom"); return this.#data.attributes["wrap"] ?? ""; }
	set wrap(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("wrap", text); this.#data.attributes["wrap"] = text; emitMutation(this.#data, "attribute", { name: "wrap", value: text }); }
	get label() { this.#gate.check("dom"); return this.#data.attributes["label"] ?? ""; }
	set label(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("label", text); this.#data.attributes["label"] = text; emitMutation(this.#data, "attribute", { name: "label", value: text }); }
	get sizes() { this.#gate.check("dom"); return this.#data.attributes["sizes"] ?? ""; }
	set sizes(value) { this.#gate.check("dom"); const text = String(value); safeAttribute("sizes", text); this.#data.attributes["sizes"] = text; emitMutation(this.#data, "attribute", { name: "sizes", value: text }); }
	get hidden() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "hidden"); }
	set hidden(value) { this.#gate.check("dom"); if (value) this.#data.attributes["hidden"] = ""; else delete this.#data.attributes["hidden"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "hidden", value: "" } : { name: "hidden" }); }
	get multiple() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "multiple"); }
	set multiple(value) { this.#gate.check("dom"); if (value) this.#data.attributes["multiple"] = ""; else delete this.#data.attributes["multiple"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "multiple", value: "" } : { name: "multiple" }); }
	get required() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "required"); }
	set required(value) { this.#gate.check("dom"); if (value) this.#data.attributes["required"] = ""; else delete this.#data.attributes["required"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "required", value: "" } : { name: "required" }); }
	get readOnly() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "readonly"); }
	set readOnly(value) { this.#gate.check("dom"); if (value) this.#data.attributes["readonly"] = ""; else delete this.#data.attributes["readonly"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "readonly", value: "" } : { name: "readonly" }); }
	get selected() { this.#gate.check("dom"); return this.#data.selected ?? Object.hasOwn(this.#data.attributes, "selected"); }
	set selected(value) { this.#gate.check("dom"); this.#data.selected = Boolean(value); emitMutation(this.#data, "property", { property: "selected", value: this.#data.selected }); }
	get autofocus() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "autofocus"); }
	set autofocus(value) { this.#gate.check("dom"); if (value) this.#data.attributes["autofocus"] = ""; else delete this.#data.attributes["autofocus"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "autofocus", value: "" } : { name: "autofocus" }); }
	get controls() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "controls"); }
	set controls(value) { this.#gate.check("dom"); if (value) this.#data.attributes["controls"] = ""; else delete this.#data.attributes["controls"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "controls", value: "" } : { name: "controls" }); }
	get loop() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "loop"); }
	set loop(value) { this.#gate.check("dom"); if (value) this.#data.attributes["loop"] = ""; else delete this.#data.attributes["loop"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "loop", value: "" } : { name: "loop" }); }
	get muted() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "muted"); }
	set muted(value) { this.#gate.check("dom"); if (value) this.#data.attributes["muted"] = ""; else delete this.#data.attributes["muted"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "muted", value: "" } : { name: "muted" }); }
	get open() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "open"); }
	set open(value) { this.#gate.check("dom"); if (value) this.#data.attributes["open"] = ""; else delete this.#data.attributes["open"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "open", value: "" } : { name: "open" }); }
	get reversed() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "reversed"); }
	set reversed(value) { this.#gate.check("dom"); if (value) this.#data.attributes["reversed"] = ""; else delete this.#data.attributes["reversed"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "reversed", value: "" } : { name: "reversed" }); }
	get noValidate() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "novalidate"); }
	set noValidate(value) { this.#gate.check("dom"); if (value) this.#data.attributes["novalidate"] = ""; else delete this.#data.attributes["novalidate"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "novalidate", value: "" } : { name: "novalidate" }); }
	get playsInline() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "playsinline"); }
	set playsInline(value) { this.#gate.check("dom"); if (value) this.#data.attributes["playsinline"] = ""; else delete this.#data.attributes["playsinline"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "playsinline", value: "" } : { name: "playsinline" }); }
	get defaultChecked() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "defaultchecked"); }
	set defaultChecked(value) { this.#gate.check("dom"); if (value) this.#data.attributes["defaultchecked"] = ""; else delete this.#data.attributes["defaultchecked"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "defaultchecked", value: "" } : { name: "defaultchecked" }); }
	get defaultMuted() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "defaultmuted"); }
	set defaultMuted(value) { this.#gate.check("dom"); if (value) this.#data.attributes["defaultmuted"] = ""; else delete this.#data.attributes["defaultmuted"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "defaultmuted", value: "" } : { name: "defaultmuted" }); }
	get disablePictureInPicture() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "disablepictureinpicture"); }
	set disablePictureInPicture(value) { this.#gate.check("dom"); if (value) this.#data.attributes["disablepictureinpicture"] = ""; else delete this.#data.attributes["disablepictureinpicture"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "disablepictureinpicture", value: "" } : { name: "disablepictureinpicture" }); }
	get disableRemotePlayback() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "disableremoteplayback"); }
	set disableRemotePlayback(value) { this.#gate.check("dom"); if (value) this.#data.attributes["disableremoteplayback"] = ""; else delete this.#data.attributes["disableremoteplayback"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "disableremoteplayback", value: "" } : { name: "disableremoteplayback" }); }
	get tabIndex() { this.#gate.check("dom"); return this.#data.tabIndex ?? Number(this.#data.attributes["tabindex"] ?? 0); }
	set tabIndex(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("tabIndex must be a finite number"); this.#data.tabIndex = number; emitMutation(this.#data, "property", { property: "tabIndex", value: number }); }
	get width() { this.#gate.check("dom"); return this.#data.width ?? Number(this.#data.attributes["width"] ?? 0); }
	set width(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("width must be a finite number"); this.#data.width = number; emitMutation(this.#data, "property", { property: "width", value: number }); }
	get height() { this.#gate.check("dom"); return this.#data.height ?? Number(this.#data.attributes["height"] ?? 0); }
	set height(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("height must be a finite number"); this.#data.height = number; emitMutation(this.#data, "property", { property: "height", value: number }); }
	get rows() { this.#gate.check("dom"); return this.#data.rows ?? Number(this.#data.attributes["rows"] ?? 0); }
	set rows(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("rows must be a finite number"); this.#data.rows = number; emitMutation(this.#data, "property", { property: "rows", value: number }); }
	get cols() { this.#gate.check("dom"); return this.#data.cols ?? Number(this.#data.attributes["cols"] ?? 0); }
	set cols(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("cols must be a finite number"); this.#data.cols = number; emitMutation(this.#data, "property", { property: "cols", value: number }); }
	get maxLength() { this.#gate.check("dom"); return this.#data.maxLength ?? Number(this.#data.attributes["maxlength"] ?? 0); }
	set maxLength(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("maxLength must be a finite number"); this.#data.maxLength = number; emitMutation(this.#data, "property", { property: "maxLength", value: number }); }
	get minLength() { this.#gate.check("dom"); return this.#data.minLength ?? Number(this.#data.attributes["minlength"] ?? 0); }
	set minLength(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("minLength must be a finite number"); this.#data.minLength = number; emitMutation(this.#data, "property", { property: "minLength", value: number }); }
	get rowSpan() { this.#gate.check("dom"); return this.#data.rowSpan ?? Number(this.#data.attributes["rowspan"] ?? 0); }
	set rowSpan(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("rowSpan must be a finite number"); this.#data.rowSpan = number; emitMutation(this.#data, "property", { property: "rowSpan", value: number }); }
	get colSpan() { this.#gate.check("dom"); return this.#data.colSpan ?? Number(this.#data.attributes["colspan"] ?? 0); }
	set colSpan(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("colSpan must be a finite number"); this.#data.colSpan = number; emitMutation(this.#data, "property", { property: "colSpan", value: number }); }
	get size() { this.#gate.check("dom"); return this.#data.size ?? Number(this.#data.attributes["size"] ?? 0); }
	set size(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("size must be a finite number"); this.#data.size = number; emitMutation(this.#data, "property", { property: "size", value: number }); }
	get start() { this.#gate.check("dom"); return this.#data.start ?? Number(this.#data.attributes["start"] ?? 0); }
	set start(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("start must be a finite number"); this.#data.start = number; emitMutation(this.#data, "property", { property: "start", value: number }); }
	get span() { this.#gate.check("dom"); return this.#data.span ?? Number(this.#data.attributes["span"] ?? 0); }
	set span(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("span must be a finite number"); this.#data.span = number; emitMutation(this.#data, "property", { property: "span", value: number }); }

	get onclick() { this.#gate.check("dom"); return this.#eventProperties.get("onclick") ?? null; }
	set onclick(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onclick must be a function or null");
		const old = this.#eventProperties.get("onclick");
		if (old) this.removeEventListener("click", old);
		if (value == null) { this.#eventProperties.delete("onclick"); return; }
		this.#eventProperties.set("onclick", value);
		this.addEventListener("click", value);
	}

	get onchange() { this.#gate.check("dom"); return this.#eventProperties.get("onchange") ?? null; }
	set onchange(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onchange must be a function or null");
		const old = this.#eventProperties.get("onchange");
		if (old) this.removeEventListener("change", old);
		if (value == null) { this.#eventProperties.delete("onchange"); return; }
		this.#eventProperties.set("onchange", value);
		this.addEventListener("change", value);
	}

	get oninput() { this.#gate.check("dom"); return this.#eventProperties.get("oninput") ?? null; }
	set oninput(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("oninput must be a function or null");
		const old = this.#eventProperties.get("oninput");
		if (old) this.removeEventListener("input", old);
		if (value == null) { this.#eventProperties.delete("oninput"); return; }
		this.#eventProperties.set("oninput", value);
		this.addEventListener("input", value);
	}

	get onsubmit() { this.#gate.check("dom"); return this.#eventProperties.get("onsubmit") ?? null; }
	set onsubmit(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onsubmit must be a function or null");
		const old = this.#eventProperties.get("onsubmit");
		if (old) this.removeEventListener("submit", old);
		if (value == null) { this.#eventProperties.delete("onsubmit"); return; }
		this.#eventProperties.set("onsubmit", value);
		this.addEventListener("submit", value);
	}

	get onfocus() { this.#gate.check("dom"); return this.#eventProperties.get("onfocus") ?? null; }
	set onfocus(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onfocus must be a function or null");
		const old = this.#eventProperties.get("onfocus");
		if (old) this.removeEventListener("focus", old);
		if (value == null) { this.#eventProperties.delete("onfocus"); return; }
		this.#eventProperties.set("onfocus", value);
		this.addEventListener("focus", value);
	}

	get onblur() { this.#gate.check("dom"); return this.#eventProperties.get("onblur") ?? null; }
	set onblur(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onblur must be a function or null");
		const old = this.#eventProperties.get("onblur");
		if (old) this.removeEventListener("blur", old);
		if (value == null) { this.#eventProperties.delete("onblur"); return; }
		this.#eventProperties.set("onblur", value);
		this.addEventListener("blur", value);
	}
	get ondblclick() { this.#gate.check("dom"); return this.#eventProperties.get("ondblclick") ?? null; }
	set ondblclick(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("ondblclick must be a function or null");
		const old = this.#eventProperties.get("ondblclick");
		if (old) this.removeEventListener("dblclick", old);
		if (value == null) { this.#eventProperties.delete("ondblclick"); return; }
		this.#eventProperties.set("ondblclick", value);
		this.addEventListener("dblclick", value);
	}

	get oncontextmenu() { this.#gate.check("dom"); return this.#eventProperties.get("oncontextmenu") ?? null; }
	set oncontextmenu(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("oncontextmenu must be a function or null");
		const old = this.#eventProperties.get("oncontextmenu");
		if (old) this.removeEventListener("contextmenu", old);
		if (value == null) { this.#eventProperties.delete("oncontextmenu"); return; }
		this.#eventProperties.set("oncontextmenu", value);
		this.addEventListener("contextmenu", value);
	}

	get onmousedown() { this.#gate.check("dom"); return this.#eventProperties.get("onmousedown") ?? null; }
	set onmousedown(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onmousedown must be a function or null");
		const old = this.#eventProperties.get("onmousedown");
		if (old) this.removeEventListener("mousedown", old);
		if (value == null) { this.#eventProperties.delete("onmousedown"); return; }
		this.#eventProperties.set("onmousedown", value);
		this.addEventListener("mousedown", value);
	}

	get onmouseup() { this.#gate.check("dom"); return this.#eventProperties.get("onmouseup") ?? null; }
	set onmouseup(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onmouseup must be a function or null");
		const old = this.#eventProperties.get("onmouseup");
		if (old) this.removeEventListener("mouseup", old);
		if (value == null) { this.#eventProperties.delete("onmouseup"); return; }
		this.#eventProperties.set("onmouseup", value);
		this.addEventListener("mouseup", value);
	}

	get onmousemove() { this.#gate.check("dom"); return this.#eventProperties.get("onmousemove") ?? null; }
	set onmousemove(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onmousemove must be a function or null");
		const old = this.#eventProperties.get("onmousemove");
		if (old) this.removeEventListener("mousemove", old);
		if (value == null) { this.#eventProperties.delete("onmousemove"); return; }
		this.#eventProperties.set("onmousemove", value);
		this.addEventListener("mousemove", value);
	}

	get onmouseover() { this.#gate.check("dom"); return this.#eventProperties.get("onmouseover") ?? null; }
	set onmouseover(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onmouseover must be a function or null");
		const old = this.#eventProperties.get("onmouseover");
		if (old) this.removeEventListener("mouseover", old);
		if (value == null) { this.#eventProperties.delete("onmouseover"); return; }
		this.#eventProperties.set("onmouseover", value);
		this.addEventListener("mouseover", value);
	}

	get onmouseout() { this.#gate.check("dom"); return this.#eventProperties.get("onmouseout") ?? null; }
	set onmouseout(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onmouseout must be a function or null");
		const old = this.#eventProperties.get("onmouseout");
		if (old) this.removeEventListener("mouseout", old);
		if (value == null) { this.#eventProperties.delete("onmouseout"); return; }
		this.#eventProperties.set("onmouseout", value);
		this.addEventListener("mouseout", value);
	}

	get onmouseenter() { this.#gate.check("dom"); return this.#eventProperties.get("onmouseenter") ?? null; }
	set onmouseenter(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onmouseenter must be a function or null");
		const old = this.#eventProperties.get("onmouseenter");
		if (old) this.removeEventListener("mouseenter", old);
		if (value == null) { this.#eventProperties.delete("onmouseenter"); return; }
		this.#eventProperties.set("onmouseenter", value);
		this.addEventListener("mouseenter", value);
	}

	get onmouseleave() { this.#gate.check("dom"); return this.#eventProperties.get("onmouseleave") ?? null; }
	set onmouseleave(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onmouseleave must be a function or null");
		const old = this.#eventProperties.get("onmouseleave");
		if (old) this.removeEventListener("mouseleave", old);
		if (value == null) { this.#eventProperties.delete("onmouseleave"); return; }
		this.#eventProperties.set("onmouseleave", value);
		this.addEventListener("mouseleave", value);
	}

	get onkeydown() { this.#gate.check("dom"); return this.#eventProperties.get("onkeydown") ?? null; }
	set onkeydown(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onkeydown must be a function or null");
		const old = this.#eventProperties.get("onkeydown");
		if (old) this.removeEventListener("keydown", old);
		if (value == null) { this.#eventProperties.delete("onkeydown"); return; }
		this.#eventProperties.set("onkeydown", value);
		this.addEventListener("keydown", value);
	}

	get onkeyup() { this.#gate.check("dom"); return this.#eventProperties.get("onkeyup") ?? null; }
	set onkeyup(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onkeyup must be a function or null");
		const old = this.#eventProperties.get("onkeyup");
		if (old) this.removeEventListener("keyup", old);
		if (value == null) { this.#eventProperties.delete("onkeyup"); return; }
		this.#eventProperties.set("onkeyup", value);
		this.addEventListener("keyup", value);
	}

	get onkeypress() { this.#gate.check("dom"); return this.#eventProperties.get("onkeypress") ?? null; }
	set onkeypress(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onkeypress must be a function or null");
		const old = this.#eventProperties.get("onkeypress");
		if (old) this.removeEventListener("keypress", old);
		if (value == null) { this.#eventProperties.delete("onkeypress"); return; }
		this.#eventProperties.set("onkeypress", value);
		this.addEventListener("keypress", value);
	}

	get onwheel() { this.#gate.check("dom"); return this.#eventProperties.get("onwheel") ?? null; }
	set onwheel(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onwheel must be a function or null");
		const old = this.#eventProperties.get("onwheel");
		if (old) this.removeEventListener("wheel", old);
		if (value == null) { this.#eventProperties.delete("onwheel"); return; }
		this.#eventProperties.set("onwheel", value);
		this.addEventListener("wheel", value);
	}

	get onscroll() { this.#gate.check("dom"); return this.#eventProperties.get("onscroll") ?? null; }
	set onscroll(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onscroll must be a function or null");
		const old = this.#eventProperties.get("onscroll");
		if (old) this.removeEventListener("scroll", old);
		if (value == null) { this.#eventProperties.delete("onscroll"); return; }
		this.#eventProperties.set("onscroll", value);
		this.addEventListener("scroll", value);
	}

	get onload() { this.#gate.check("dom"); return this.#eventProperties.get("onload") ?? null; }
	set onload(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onload must be a function or null");
		const old = this.#eventProperties.get("onload");
		if (old) this.removeEventListener("load", old);
		if (value == null) { this.#eventProperties.delete("onload"); return; }
		this.#eventProperties.set("onload", value);
		this.addEventListener("load", value);
	}

	get onerror() { this.#gate.check("dom"); return this.#eventProperties.get("onerror") ?? null; }
	set onerror(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onerror must be a function or null");
		const old = this.#eventProperties.get("onerror");
		if (old) this.removeEventListener("error", old);
		if (value == null) { this.#eventProperties.delete("onerror"); return; }
		this.#eventProperties.set("onerror", value);
		this.addEventListener("error", value);
	}

	get onreset() { this.#gate.check("dom"); return this.#eventProperties.get("onreset") ?? null; }
	set onreset(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onreset must be a function or null");
		const old = this.#eventProperties.get("onreset");
		if (old) this.removeEventListener("reset", old);
		if (value == null) { this.#eventProperties.delete("onreset"); return; }
		this.#eventProperties.set("onreset", value);
		this.addEventListener("reset", value);
	}

	get onselect() { this.#gate.check("dom"); return this.#eventProperties.get("onselect") ?? null; }
	set onselect(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onselect must be a function or null");
		const old = this.#eventProperties.get("onselect");
		if (old) this.removeEventListener("select", old);
		if (value == null) { this.#eventProperties.delete("onselect"); return; }
		this.#eventProperties.set("onselect", value);
		this.addEventListener("select", value);
	}

	get oninvalid() { this.#gate.check("dom"); return this.#eventProperties.get("oninvalid") ?? null; }
	set oninvalid(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("oninvalid must be a function or null");
		const old = this.#eventProperties.get("oninvalid");
		if (old) this.removeEventListener("invalid", old);
		if (value == null) { this.#eventProperties.delete("oninvalid"); return; }
		this.#eventProperties.set("oninvalid", value);
		this.addEventListener("invalid", value);
	}

	get onfocusin() { this.#gate.check("dom"); return this.#eventProperties.get("onfocusin") ?? null; }
	set onfocusin(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onfocusin must be a function or null");
		const old = this.#eventProperties.get("onfocusin");
		if (old) this.removeEventListener("focusin", old);
		if (value == null) { this.#eventProperties.delete("onfocusin"); return; }
		this.#eventProperties.set("onfocusin", value);
		this.addEventListener("focusin", value);
	}

	get onfocusout() { this.#gate.check("dom"); return this.#eventProperties.get("onfocusout") ?? null; }
	set onfocusout(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onfocusout must be a function or null");
		const old = this.#eventProperties.get("onfocusout");
		if (old) this.removeEventListener("focusout", old);
		if (value == null) { this.#eventProperties.delete("onfocusout"); return; }
		this.#eventProperties.set("onfocusout", value);
		this.addEventListener("focusout", value);
	}

	get onpointerdown() { this.#gate.check("dom"); return this.#eventProperties.get("onpointerdown") ?? null; }
	set onpointerdown(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onpointerdown must be a function or null");
		const old = this.#eventProperties.get("onpointerdown");
		if (old) this.removeEventListener("pointerdown", old);
		if (value == null) { this.#eventProperties.delete("onpointerdown"); return; }
		this.#eventProperties.set("onpointerdown", value);
		this.addEventListener("pointerdown", value);
	}

	get onpointerup() { this.#gate.check("dom"); return this.#eventProperties.get("onpointerup") ?? null; }
	set onpointerup(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onpointerup must be a function or null");
		const old = this.#eventProperties.get("onpointerup");
		if (old) this.removeEventListener("pointerup", old);
		if (value == null) { this.#eventProperties.delete("onpointerup"); return; }
		this.#eventProperties.set("onpointerup", value);
		this.addEventListener("pointerup", value);
	}

	get onpointermove() { this.#gate.check("dom"); return this.#eventProperties.get("onpointermove") ?? null; }
	set onpointermove(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onpointermove must be a function or null");
		const old = this.#eventProperties.get("onpointermove");
		if (old) this.removeEventListener("pointermove", old);
		if (value == null) { this.#eventProperties.delete("onpointermove"); return; }
		this.#eventProperties.set("onpointermove", value);
		this.addEventListener("pointermove", value);
	}

	get onpointerover() { this.#gate.check("dom"); return this.#eventProperties.get("onpointerover") ?? null; }
	set onpointerover(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onpointerover must be a function or null");
		const old = this.#eventProperties.get("onpointerover");
		if (old) this.removeEventListener("pointerover", old);
		if (value == null) { this.#eventProperties.delete("onpointerover"); return; }
		this.#eventProperties.set("onpointerover", value);
		this.addEventListener("pointerover", value);
	}

	get onpointerout() { this.#gate.check("dom"); return this.#eventProperties.get("onpointerout") ?? null; }
	set onpointerout(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onpointerout must be a function or null");
		const old = this.#eventProperties.get("onpointerout");
		if (old) this.removeEventListener("pointerout", old);
		if (value == null) { this.#eventProperties.delete("onpointerout"); return; }
		this.#eventProperties.set("onpointerout", value);
		this.addEventListener("pointerout", value);
	}

	get onpointerenter() { this.#gate.check("dom"); return this.#eventProperties.get("onpointerenter") ?? null; }
	set onpointerenter(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onpointerenter must be a function or null");
		const old = this.#eventProperties.get("onpointerenter");
		if (old) this.removeEventListener("pointerenter", old);
		if (value == null) { this.#eventProperties.delete("onpointerenter"); return; }
		this.#eventProperties.set("onpointerenter", value);
		this.addEventListener("pointerenter", value);
	}

	get onpointerleave() { this.#gate.check("dom"); return this.#eventProperties.get("onpointerleave") ?? null; }
	set onpointerleave(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onpointerleave must be a function or null");
		const old = this.#eventProperties.get("onpointerleave");
		if (old) this.removeEventListener("pointerleave", old);
		if (value == null) { this.#eventProperties.delete("onpointerleave"); return; }
		this.#eventProperties.set("onpointerleave", value);
		this.addEventListener("pointerleave", value);
	}

	get onpointercancel() { this.#gate.check("dom"); return this.#eventProperties.get("onpointercancel") ?? null; }
	set onpointercancel(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onpointercancel must be a function or null");
		const old = this.#eventProperties.get("onpointercancel");
		if (old) this.removeEventListener("pointercancel", old);
		if (value == null) { this.#eventProperties.delete("onpointercancel"); return; }
		this.#eventProperties.set("onpointercancel", value);
		this.addEventListener("pointercancel", value);
	}

	get ontouchstart() { this.#gate.check("dom"); return this.#eventProperties.get("ontouchstart") ?? null; }
	set ontouchstart(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("ontouchstart must be a function or null");
		const old = this.#eventProperties.get("ontouchstart");
		if (old) this.removeEventListener("touchstart", old);
		if (value == null) { this.#eventProperties.delete("ontouchstart"); return; }
		this.#eventProperties.set("ontouchstart", value);
		this.addEventListener("touchstart", value);
	}

	get ontouchmove() { this.#gate.check("dom"); return this.#eventProperties.get("ontouchmove") ?? null; }
	set ontouchmove(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("ontouchmove must be a function or null");
		const old = this.#eventProperties.get("ontouchmove");
		if (old) this.removeEventListener("touchmove", old);
		if (value == null) { this.#eventProperties.delete("ontouchmove"); return; }
		this.#eventProperties.set("ontouchmove", value);
		this.addEventListener("touchmove", value);
	}

	get ontouchend() { this.#gate.check("dom"); return this.#eventProperties.get("ontouchend") ?? null; }
	set ontouchend(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("ontouchend must be a function or null");
		const old = this.#eventProperties.get("ontouchend");
		if (old) this.removeEventListener("touchend", old);
		if (value == null) { this.#eventProperties.delete("ontouchend"); return; }
		this.#eventProperties.set("ontouchend", value);
		this.addEventListener("touchend", value);
	}

	get ontouchcancel() { this.#gate.check("dom"); return this.#eventProperties.get("ontouchcancel") ?? null; }
	set ontouchcancel(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("ontouchcancel must be a function or null");
		const old = this.#eventProperties.get("ontouchcancel");
		if (old) this.removeEventListener("touchcancel", old);
		if (value == null) { this.#eventProperties.delete("ontouchcancel"); return; }
		this.#eventProperties.set("ontouchcancel", value);
		this.addEventListener("touchcancel", value);
	}

	get ondrag() { this.#gate.check("dom"); return this.#eventProperties.get("ondrag") ?? null; }
	set ondrag(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("ondrag must be a function or null");
		const old = this.#eventProperties.get("ondrag");
		if (old) this.removeEventListener("drag", old);
		if (value == null) { this.#eventProperties.delete("ondrag"); return; }
		this.#eventProperties.set("ondrag", value);
		this.addEventListener("drag", value);
	}

	get ondragstart() { this.#gate.check("dom"); return this.#eventProperties.get("ondragstart") ?? null; }
	set ondragstart(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("ondragstart must be a function or null");
		const old = this.#eventProperties.get("ondragstart");
		if (old) this.removeEventListener("dragstart", old);
		if (value == null) { this.#eventProperties.delete("ondragstart"); return; }
		this.#eventProperties.set("ondragstart", value);
		this.addEventListener("dragstart", value);
	}

	get ondragend() { this.#gate.check("dom"); return this.#eventProperties.get("ondragend") ?? null; }
	set ondragend(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("ondragend must be a function or null");
		const old = this.#eventProperties.get("ondragend");
		if (old) this.removeEventListener("dragend", old);
		if (value == null) { this.#eventProperties.delete("ondragend"); return; }
		this.#eventProperties.set("ondragend", value);
		this.addEventListener("dragend", value);
	}

	get ondragenter() { this.#gate.check("dom"); return this.#eventProperties.get("ondragenter") ?? null; }
	set ondragenter(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("ondragenter must be a function or null");
		const old = this.#eventProperties.get("ondragenter");
		if (old) this.removeEventListener("dragenter", old);
		if (value == null) { this.#eventProperties.delete("ondragenter"); return; }
		this.#eventProperties.set("ondragenter", value);
		this.addEventListener("dragenter", value);
	}

	get ondragover() { this.#gate.check("dom"); return this.#eventProperties.get("ondragover") ?? null; }
	set ondragover(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("ondragover must be a function or null");
		const old = this.#eventProperties.get("ondragover");
		if (old) this.removeEventListener("dragover", old);
		if (value == null) { this.#eventProperties.delete("ondragover"); return; }
		this.#eventProperties.set("ondragover", value);
		this.addEventListener("dragover", value);
	}

	get ondragleave() { this.#gate.check("dom"); return this.#eventProperties.get("ondragleave") ?? null; }
	set ondragleave(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("ondragleave must be a function or null");
		const old = this.#eventProperties.get("ondragleave");
		if (old) this.removeEventListener("dragleave", old);
		if (value == null) { this.#eventProperties.delete("ondragleave"); return; }
		this.#eventProperties.set("ondragleave", value);
		this.addEventListener("dragleave", value);
	}

	get ondrop() { this.#gate.check("dom"); return this.#eventProperties.get("ondrop") ?? null; }
	set ondrop(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("ondrop must be a function or null");
		const old = this.#eventProperties.get("ondrop");
		if (old) this.removeEventListener("drop", old);
		if (value == null) { this.#eventProperties.delete("ondrop"); return; }
		this.#eventProperties.set("ondrop", value);
		this.addEventListener("drop", value);
	}

	get oncopy() { this.#gate.check("dom"); return this.#eventProperties.get("oncopy") ?? null; }
	set oncopy(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("oncopy must be a function or null");
		const old = this.#eventProperties.get("oncopy");
		if (old) this.removeEventListener("copy", old);
		if (value == null) { this.#eventProperties.delete("oncopy"); return; }
		this.#eventProperties.set("oncopy", value);
		this.addEventListener("copy", value);
	}

	get oncut() { this.#gate.check("dom"); return this.#eventProperties.get("oncut") ?? null; }
	set oncut(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("oncut must be a function or null");
		const old = this.#eventProperties.get("oncut");
		if (old) this.removeEventListener("cut", old);
		if (value == null) { this.#eventProperties.delete("oncut"); return; }
		this.#eventProperties.set("oncut", value);
		this.addEventListener("cut", value);
	}

	get onpaste() { this.#gate.check("dom"); return this.#eventProperties.get("onpaste") ?? null; }
	set onpaste(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onpaste must be a function or null");
		const old = this.#eventProperties.get("onpaste");
		if (old) this.removeEventListener("paste", old);
		if (value == null) { this.#eventProperties.delete("onpaste"); return; }
		this.#eventProperties.set("onpaste", value);
		this.addEventListener("paste", value);
	}

	get onanimationstart() { this.#gate.check("dom"); return this.#eventProperties.get("onanimationstart") ?? null; }
	set onanimationstart(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onanimationstart must be a function or null");
		const old = this.#eventProperties.get("onanimationstart");
		if (old) this.removeEventListener("animationstart", old);
		if (value == null) { this.#eventProperties.delete("onanimationstart"); return; }
		this.#eventProperties.set("onanimationstart", value);
		this.addEventListener("animationstart", value);
	}

	get onanimationend() { this.#gate.check("dom"); return this.#eventProperties.get("onanimationend") ?? null; }
	set onanimationend(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onanimationend must be a function or null");
		const old = this.#eventProperties.get("onanimationend");
		if (old) this.removeEventListener("animationend", old);
		if (value == null) { this.#eventProperties.delete("onanimationend"); return; }
		this.#eventProperties.set("onanimationend", value);
		this.addEventListener("animationend", value);
	}

	get onanimationiteration() { this.#gate.check("dom"); return this.#eventProperties.get("onanimationiteration") ?? null; }
	set onanimationiteration(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onanimationiteration must be a function or null");
		const old = this.#eventProperties.get("onanimationiteration");
		if (old) this.removeEventListener("animationiteration", old);
		if (value == null) { this.#eventProperties.delete("onanimationiteration"); return; }
		this.#eventProperties.set("onanimationiteration", value);
		this.addEventListener("animationiteration", value);
	}

	get ontransitionend() { this.#gate.check("dom"); return this.#eventProperties.get("ontransitionend") ?? null; }
	set ontransitionend(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("ontransitionend must be a function or null");
		const old = this.#eventProperties.get("ontransitionend");
		if (old) this.removeEventListener("transitionend", old);
		if (value == null) { this.#eventProperties.delete("ontransitionend"); return; }
		this.#eventProperties.set("ontransitionend", value);
		this.addEventListener("transitionend", value);
	}

	get onplay() { this.#gate.check("dom"); return this.#eventProperties.get("onplay") ?? null; }
	set onplay(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onplay must be a function or null");
		const old = this.#eventProperties.get("onplay");
		if (old) this.removeEventListener("play", old);
		if (value == null) { this.#eventProperties.delete("onplay"); return; }
		this.#eventProperties.set("onplay", value);
		this.addEventListener("play", value);
	}

	get onpause() { this.#gate.check("dom"); return this.#eventProperties.get("onpause") ?? null; }
	set onpause(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onpause must be a function or null");
		const old = this.#eventProperties.get("onpause");
		if (old) this.removeEventListener("pause", old);
		if (value == null) { this.#eventProperties.delete("onpause"); return; }
		this.#eventProperties.set("onpause", value);
		this.addEventListener("pause", value);
	}

	get onended() { this.#gate.check("dom"); return this.#eventProperties.get("onended") ?? null; }
	set onended(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onended must be a function or null");
		const old = this.#eventProperties.get("onended");
		if (old) this.removeEventListener("ended", old);
		if (value == null) { this.#eventProperties.delete("onended"); return; }
		this.#eventProperties.set("onended", value);
		this.addEventListener("ended", value);
	}

	get ontimeupdate() { this.#gate.check("dom"); return this.#eventProperties.get("ontimeupdate") ?? null; }
	set ontimeupdate(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("ontimeupdate must be a function or null");
		const old = this.#eventProperties.get("ontimeupdate");
		if (old) this.removeEventListener("timeupdate", old);
		if (value == null) { this.#eventProperties.delete("ontimeupdate"); return; }
		this.#eventProperties.set("ontimeupdate", value);
		this.addEventListener("timeupdate", value);
	}

	get onvolumechange() { this.#gate.check("dom"); return this.#eventProperties.get("onvolumechange") ?? null; }
	set onvolumechange(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onvolumechange must be a function or null");
		const old = this.#eventProperties.get("onvolumechange");
		if (old) this.removeEventListener("volumechange", old);
		if (value == null) { this.#eventProperties.delete("onvolumechange"); return; }
		this.#eventProperties.set("onvolumechange", value);
		this.addEventListener("volumechange", value);
	}

	get oncanplay() { this.#gate.check("dom"); return this.#eventProperties.get("oncanplay") ?? null; }
	set oncanplay(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("oncanplay must be a function or null");
		const old = this.#eventProperties.get("oncanplay");
		if (old) this.removeEventListener("canplay", old);
		if (value == null) { this.#eventProperties.delete("oncanplay"); return; }
		this.#eventProperties.set("oncanplay", value);
		this.addEventListener("canplay", value);
	}

	get onwaiting() { this.#gate.check("dom"); return this.#eventProperties.get("onwaiting") ?? null; }
	set onwaiting(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onwaiting must be a function or null");
		const old = this.#eventProperties.get("onwaiting");
		if (old) this.removeEventListener("waiting", old);
		if (value == null) { this.#eventProperties.delete("onwaiting"); return; }
		this.#eventProperties.set("onwaiting", value);
		this.addEventListener("waiting", value);
	}

	get onprogress() { this.#gate.check("dom"); return this.#eventProperties.get("onprogress") ?? null; }
	set onprogress(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onprogress must be a function or null");
		const old = this.#eventProperties.get("onprogress");
		if (old) this.removeEventListener("progress", old);
		if (value == null) { this.#eventProperties.delete("onprogress"); return; }
		this.#eventProperties.set("onprogress", value);
		this.addEventListener("progress", value);
	}

	get oncanplaythrough() { this.#gate.check("dom"); return this.#eventProperties.get("oncanplaythrough") ?? null; }
	set oncanplaythrough(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("oncanplaythrough must be a function or null");
		const old = this.#eventProperties.get("oncanplaythrough");
		if (old) this.removeEventListener("canplaythrough", old);
		if (value == null) { this.#eventProperties.delete("oncanplaythrough"); return; }
		this.#eventProperties.set("oncanplaythrough", value);
		this.addEventListener("canplaythrough", value);
	}

	get onratechange() { this.#gate.check("dom"); return this.#eventProperties.get("onratechange") ?? null; }
	set onratechange(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onratechange must be a function or null");
		const old = this.#eventProperties.get("onratechange");
		if (old) this.removeEventListener("ratechange", old);
		if (value == null) { this.#eventProperties.delete("onratechange"); return; }
		this.#eventProperties.set("onratechange", value);
		this.addEventListener("ratechange", value);
	}

	get onseeking() { this.#gate.check("dom"); return this.#eventProperties.get("onseeking") ?? null; }
	set onseeking(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onseeking must be a function or null");
		const old = this.#eventProperties.get("onseeking");
		if (old) this.removeEventListener("seeking", old);
		if (value == null) { this.#eventProperties.delete("onseeking"); return; }
		this.#eventProperties.set("onseeking", value);
		this.addEventListener("seeking", value);
	}

	get onseeked() { this.#gate.check("dom"); return this.#eventProperties.get("onseeked") ?? null; }
	set onseeked(value) {
		this.#gate.check("dom");
		if (value != null && typeof value !== "function") throw new TypeError("onseeked must be a function or null");
		const old = this.#eventProperties.get("onseeked");
		if (old) this.removeEventListener("seeked", old);
		if (value == null) { this.#eventProperties.delete("onseeked"); return; }
		this.#eventProperties.set("onseeked", value);
		this.addEventListener("seeked", value);
	}

	get innerHTML() { this.#gate.check("dom"); denied("innerHTML"); }
	set innerHTML(value) { this.#gate.check("dom"); denied("innerHTML"); }
	get outerHTML() { this.#gate.check("dom"); denied("outerHTML"); }
	set outerHTML(value) { this.#gate.check("dom"); denied("outerHTML"); }
	get outerText() { this.#gate.check("dom"); denied("outerText"); }
	set outerText(value) { this.#gate.check("dom"); denied("outerText"); }
	get srcdoc() { this.#gate.check("dom"); denied("srcdoc"); }
	set srcdoc(value) { this.#gate.check("dom"); denied("srcdoc"); }
	get insertAdjacentHTML() { this.#gate.check("dom"); return () => { this.#gate.check("dom"); denied("insertAdjacentHTML"); }; }
	get setHTMLUnsafe() { this.#gate.check("dom"); return () => { this.#gate.check("dom"); denied("setHTMLUnsafe"); }; }
	get setHTML() { this.#gate.check("dom"); return () => { this.#gate.check("dom"); denied("setHTML"); }; }

	getAttributeNames() {
		this.#gate.check("dom");
		return Object.keys(this.#data.attributes).filter(name => !name.toLowerCase().startsWith("on") && !blockedAttributes.has(name.toLowerCase()));
	}

	hasAttributes() {
		this.#gate.check("dom");
		return Object.keys(this.#data.attributes).some(name => !name.toLowerCase().startsWith("on") && !blockedAttributes.has(name.toLowerCase()));
	}

	toggleAttribute(name, force) {
		this.#gate.check("dom");
		const safeName = String(name).toLowerCase();
		if (!/^[a-z_:][a-z0-9_.:-]*$/.test(safeName) || safeName.startsWith("on") || blockedAttributes.has(safeName)) denied("attribute " + safeName);
		const present = Object.hasOwn(this.#data.attributes, safeName);
		const shouldHave = force === undefined ? !present : Boolean(force);
		if (shouldHave) {
			if (!present) this.setAttribute(safeName, "");
		} else if (present) this.removeAttribute(safeName);
		return shouldHave;
	}

	getAttributeNS(namespace, localName) {
		this.#gate.check("dom");
		if (namespace !== null && namespace !== "") throw new DOMException("Namespaced attributes are not supported", "NotSupportedError");
		return this.getAttribute(localName);
	}

	setAttributeNS(namespace, qualifiedName, value) {
		this.#gate.check("dom");
		if (namespace !== null && namespace !== "") throw new DOMException("Namespaced attributes are not supported", "NotSupportedError");
		if (String(qualifiedName).includes(":")) throw new DOMException("Namespaced attributes are not supported", "NotSupportedError");
		return this.setAttribute(qualifiedName, value);
	}

	removeAttributeNS(namespace, localName) {
		this.#gate.check("dom");
		if (namespace !== null && namespace !== "") throw new DOMException("Namespaced attributes are not supported", "NotSupportedError");
		return this.removeAttribute(localName);
	}

	insertAdjacentText(position, text) {
		this.#gate.check("dom");
		const value = String(text);
		const where = String(position).toLowerCase();
		const node = new PpermNode(makeData({ nodeType: 3, tagName: "#text", text: value, connected: false }), this.#gate);
		if (where === "beforebegin") {
			if (!this.#data.parent) throw new DOMException("The element has no parent", "NoModificationAllowedError");
			new PpermNode(this.#data.parent, this.#gate).insertBefore(node, this);
		} else if (where === "afterend") {
			if (!this.#data.parent) throw new DOMException("The element has no parent", "NoModificationAllowedError");
			const siblings = this.#data.parent.children;
			const index = siblings.indexOf(this.#data);
			new PpermNode(this.#data.parent, this.#gate).insertBefore(node, siblings[index + 1] ? new PpermNode(siblings[index + 1], this.#gate) : null);
		} else if (where === "afterbegin") this.prepend(node);
		else if (where === "beforeend") this.append(node);
		else throw new DOMException("Invalid position", "SyntaxError");
		return node;
	}

	insertAdjacentElement(position, element) {
		this.#gate.check("dom");
		if (!(element instanceof PpermNode)) throw new TypeError("Expected a pperm Node");
		const where = String(position).toLowerCase();
		if (where === "afterbegin") { this.prepend(element); return element; }
		if (where === "beforeend") { this.appendChild(element); return element; }
		if (!this.#data.parent) throw new DOMException("The element has no parent", "NoModificationAllowedError");
		const siblings = this.#data.parent.children;
		const index = siblings.indexOf(this.#data);
		const parent = new PpermNode(this.#data.parent, this.#gate);
		if (where === "beforebegin") { parent.insertBefore(element, this); return element; }
		if (where === "afterend") { parent.insertBefore(element, siblings[index + 1] ? new PpermNode(siblings[index + 1], this.#gate) : null); return element; }
		throw new DOMException("Invalid position", "SyntaxError");
	}

	getAttribute(name) {
		this.#gate.check("dom");
		const safeName = String(name).toLowerCase();
		if (safeName.startsWith("on") || blockedAttributes.has(safeName)) denied("attribute " + safeName);
		return this.#data.attributes[safeName] ?? null;
	}

	hasAttribute(name) {
		this.#gate.check("dom");
		return Object.hasOwn(this.#data.attributes, String(name).toLowerCase());
	}

	setAttribute(name, value) {
		this.#gate.check("dom");
		const safeName = safeAttribute(name, value);
		if (safeName === "style") safeStyle("style", value);
		const text = String(value);
		this.#data.attributes[safeName] = text;
		if (safeName === "id") this.#data.idName = text;
		if (safeName === "class") this.#data.className = text;
		if (safeName === "disabled") this.#data.disabled = true;
		emitMutation(this.#data, "attribute", { name: safeName, value: text });
	}

	removeAttribute(name) {
		this.#gate.check("dom");
		const safeName = String(name).toLowerCase();
		if (safeName.startsWith("on") || blockedAttributes.has(safeName)) denied("attribute " + safeName);
		delete this.#data.attributes[safeName];
		if (safeName === "id") this.#data.idName = "";
		if (safeName === "class") this.#data.className = "";
		if (safeName === "disabled") this.#data.disabled = false;
		emitMutation(this.#data, "removeAttribute", { name: safeName });
	}

	matches(selector) {
		this.#gate.check("dom");
		return selectorMatches(this.#data, selector);
	}

	querySelector(selector) {
		this.#gate.check("dom");
		return this.querySelectorAll(selector)[0] ?? null;
	}

	querySelectorAll(selector) {
		this.#gate.check("dom");
		const results = [];
		const walk = node => {
			for (const child of node.children) {
				if (selectorMatches(child, selector)) results.push(new PpermNode(child, this.#gate));
				walk(child);
			}
		};
		walk(this.#data);
		return results;
	}

	closest(selector) {
		this.#gate.check("dom");
		let node = this.#data;
		while (node) {
			if (selectorMatches(node, selector)) return new PpermNode(node, this.#gate);
			node = node.parent;
		}
		return null;
	}

	_appendRaw(child, before = null) {
		this.#gate.check("dom");
		const parent = this.#data;
		if (!(child instanceof PpermNode)) throw new TypeError("Expected a pperm Node");
		const item = raw(child);
		if (item === root) denied("moving the permitted root");
		if (item === parent || this.contains(child)) throw new DOMException("The operation would create a cycle", "HierarchyRequestError");
		if (before && before.parent !== parent) throw new DOMException("Reference node is not a child", "NotFoundError");
		if (item.nodeType === 11) {
			for (const nested of [...item.children]) this._appendRaw(new PpermNode(nested, this.#gate), before ? new PpermNode(before, this.#gate) : null);
			item.children = [];
			return child;
		}
		if (item.parent) new PpermNode(item.parent, this.#gate).removeChild(child);
		item.parent = parent;
		setConnected(item, parent.connected);
		const index = before ? parent.children.indexOf(before) : -1;
		if (index < 0) parent.children.push(item);
		else parent.children.splice(index, 0, item);
		if (item.connected) emit("dom", { op: before ? "insert" : "append", id: parent.id, child: serialize(item), beforeId: before?.id ?? null });
		return child;
	}

	appendChild(child) {
		this.#gate.check("dom");
		return this._appendRaw(child);
	}

	append(...items) {
		this.#gate.check("dom");
		for (const item of items) this._appendRaw(item instanceof PpermNode ? item : new PpermNode(makeData({ nodeType: 3, tagName: "#text", text: String(item), connected: false }), this.#gate));
	}

	prepend(...items) {
		this.#gate.check("dom");
		const before = this.#data.children[0] ?? null;
		for (const item of [...items].reverse()) this._appendRaw(item instanceof PpermNode ? item : new PpermNode(makeData({ nodeType: 3, tagName: "#text", text: String(item), connected: false }), this.#gate), before);
	}

	insertBefore(child, before) {
		this.#gate.check("dom");
		return this._appendRaw(child, before == null ? null : raw(before));
	}

	replaceChild(child, oldChild) {
		this.#gate.check("dom");
		const old = raw(oldChild);
		if (!this.#data.children.includes(old)) throw new DOMException("Node is not a child", "NotFoundError");
		if (raw(child) === old) return oldChild;
		this._appendRaw(child, old);
		this.removeChild(oldChild);
		return oldChild;
	}

	before(...items) {
		this.#gate.check("dom");
		const parent = this.#data.parent;
		if (!parent) return;
		const before = new PpermNode(parent, this.#gate);
		for (const item of items) before.insertBefore(item instanceof PpermNode ? item : new PpermNode(makeData({ nodeType: 3, tagName: "#text", text: String(item), connected: false }), this.#gate), this);
	}

	after(...items) {
		this.#gate.check("dom");
		const parent = this.#data.parent;
		if (!parent) return;
		const siblings = parent.children;
		const next = siblings[siblings.indexOf(this.#data) + 1] ?? null;
		for (const item of items) new PpermNode(parent, this.#gate).insertBefore(item instanceof PpermNode ? item : new PpermNode(makeData({ nodeType: 3, tagName: "#text", text: String(item), connected: false }), this.#gate), next ? new PpermNode(next, this.#gate) : null);
	}

	removeChild(child) {
		this.#gate.check("dom");
		const item = raw(child);
		const index = this.#data.children.indexOf(item);
		if (index < 0) throw new DOMException("Node is not a child", "NotFoundError");
		if (item === root) denied("removing the permitted root");
		this.#data.children.splice(index, 1);
		item.parent = null;
		setConnected(item, false);
		emitMutation(this.#data, "remove", { childId: item.id });
		return child;
	}

	replaceChildren(...items) {
		this.#gate.check("dom");
		for (const child of [...this.#data.children]) this.removeChild(new PpermNode(child, this.#gate));
		this.append(...items);
	}

	remove() {
		this.#gate.check("dom");
		if (this.#data === root) denied("removing the permitted root");
		if (this.#data.parent) new PpermNode(this.#data.parent, this.#gate).removeChild(this);
	}

	contains(other) {
		this.#gate.check("dom");
		let node = raw(other);
		while (node) {
			if (node === this.#data) return true;
			node = node.parent;
		}
		return false;
	}

	addEventListener(type, callback, options = {}) {
		this.#gate.check("dom");
		if (callback == null) return;
		if (typeof callback !== "function" && typeof callback.handleEvent !== "function") throw new TypeError("Listener must be a function or an object with handleEvent");
		const listenerId = nextId++;
		const record = { node: this.#data, type: String(type), callback, once: typeof options === "boolean" ? false : !!options?.once, capture: typeof options === "boolean" ? options : !!options?.capture };
		listeners.set(listenerId, record);
		emit("listen", { id: this.#data.id, listenerId, eventType: record.type, once: record.once, capture: record.capture });
	}

	removeEventListener(type, callback, options = {}) {
		this.#gate.check("dom");
		const capture = typeof options === "boolean" ? options : !!options?.capture;
		for (const [id, record] of listeners) {
			if (record.node === this.#data && record.type === String(type) && record.callback === callback && record.capture === capture) {
				listeners.delete(id);
				emit("unlisten", { id: this.#data.id, listenerId: id, eventType: record.type });
			}
		}
	}

	dispatchEvent(event) {
		this.#gate.check("dom");
		if (!event || typeof event.type !== "string") throw new TypeError("dispatchEvent expects an Event-like object");
		const eventData = { type: event.type, detail: event.detail ?? null, bubbles: !!event.bubbles, cancelable: !!event.cancelable };
		emit("dispatch", { id: this.#data.id, event: eventData });
		return true;
	}

	click() {
		this.#gate.check("dom");
		emit("dispatch", { id: this.#data.id, event: { type: "click", detail: null, bubbles: true, cancelable: true } });
	}

	focus() {
		this.#gate.check("dom");
		emitMutation(this.#data, "focus");
	}

	blur() {
		this.#gate.check("dom");
		emitMutation(this.#data, "blur");
	}

	cloneNode(deep = false) {
		this.#gate.check("dom");
		const copy = serialize(this.#data);
		const renew = item => {
			item.id = nextId++;
			if (item.nodeType === 1) { item.idName = ""; item.attributes = { ...item.attributes }; delete item.attributes.id; }
			if (!deep) item.children = [];
			else item.children.forEach(renew);
		};
		renew(copy);
		const data = makeData({ ...copy, connected: false });
		setConnected(data, false);
		return new PpermNode(data, this.#gate);
	}

	getBoundingClientRect() {
		this.#gate.check("dom");
		throw new DOMException("Layout measurements are asynchronous across the Worker bridge and are not supported yet", "NotSupportedError");
	}
}

class PpermDocument {
	#gate;
	constructor(gate) {
		this.#gate = gate;
		Object.preventExtensions(this);
	}

	get body() { this.#gate.check("dom"); return new PpermNode(root, this.#gate); }
	get documentElement() { this.#gate.check("dom"); return new PpermNode(root, this.#gate); }
	get nodeType() { this.#gate.check("dom"); return 9; }
	get nodeName() { this.#gate.check("dom"); return "#document"; }
	get title() { this.#gate.check("dom"); return documentTitle; }
	set title(value) { this.#gate.check("dom"); documentTitle = String(value); emit("documentTitle", { value: documentTitle }); }
	get documentURI() { this.#gate.check("dom"); return ""; }
	get URL() { this.#gate.check("dom"); return ""; }
	get baseURI() { this.#gate.check("dom"); return ""; }
	get compatMode() { this.#gate.check("dom"); return "CSS1Compat"; }
	get characterSet() { this.#gate.check("dom"); return "UTF-8"; }
	get contentType() { this.#gate.check("dom"); return "text/html"; }
	get readyState() { this.#gate.check("dom"); return "complete"; }
	get defaultView() { this.#gate.check("dom"); return null; }
	get activeElement() { this.#gate.check("dom"); return null; }
	get head() { this.#gate.check("dom"); return null; }
	get doctype() { this.#gate.check("dom"); return null; }
	get forms() { this.#gate.check("dom"); return this.getElementsByTagName("form"); }
	get images() { this.#gate.check("dom"); return this.getElementsByTagName("img"); }
	get links() { this.#gate.check("dom"); return [...this.getElementsByTagName("a"), ...this.getElementsByTagName("area")]; }
	get scripts() { this.#gate.check("dom"); return []; }
	get children() { this.#gate.check("dom"); return [new PpermNode(root, this.#gate)]; }
	get childNodes() { this.#gate.check("dom"); return [new PpermNode(root, this.#gate)]; }
	get firstChild() { this.#gate.check("dom"); return new PpermNode(root, this.#gate); }
	get lastChild() { this.#gate.check("dom"); return new PpermNode(root, this.#gate); }
	get implementation() { this.#gate.check("dom"); return Object.freeze({ hasFeature: () => { this.#gate.check("dom"); return false; } }); }

	getElementById(id) {
		this.#gate.check("dom");
		const value = String(id);
		let result = null;
		const walk = data => {
			if (result) return;
			if (data.nodeType === 1 && data.idName === value) {
				result = new PpermNode(data, this.#gate);
				return;
			}
			data.children.forEach(walk);
		};
		walk(root);
		return result;
	}

	getElementsByClassName(name) {
		this.#gate.check("dom");
		const classes = String(name).trim().split(/\s+/).filter(Boolean);
		if (!classes.length) return [];
		const out = [];
		const walk = data => {
			if (data.nodeType === 1 && classes.every(value => data.className.split(/\s+/).includes(value))) out.push(new PpermNode(data, this.#gate));
			data.children.forEach(walk);
		};
		walk(root);
		return out;
	}

	getElementsByTagName(name) {
		this.#gate.check("dom");
		const value = String(name);
		if (value === "*") {
			const out = [];
			const walk = data => { if (data.nodeType === 1) out.push(new PpermNode(data, this.#gate)); data.children.forEach(walk); };
			walk(root);
			return out;
		}
		return this.querySelectorAll(value);
	}

	querySelector(selector) {
		this.#gate.check("dom");
		return this.querySelectorAll(selector)[0] ?? null;
	}

	querySelectorAll(selector) {
		this.#gate.check("dom");
		const out = [];
		const walk = data => {
			if (selectorMatches(data, selector)) out.push(new PpermNode(data, this.#gate));
			data.children.forEach(walk);
		};
		walk(root);
		return out;
	}

	createElement(tagName, options) {
		this.#gate.check("dom");
		if (options != null) throw new DOMException("Customized built-in elements are not supported", "NotSupportedError");
		const tag = safeElementName(tagName);
		return new PpermNode(makeData({ tagName: tag.toUpperCase(), connected: false }), this.#gate);
	}

	createElementNS(namespace, qualifiedName) {
		this.#gate.check("dom");
		if (namespace !== null && namespace !== "http://www.w3.org/1999/xhtml") denied("createElementNS namespace");
		return this.createElement(qualifiedName);
	}

	createTextNode(text) {
		this.#gate.check("dom");
		return new PpermNode(makeData({ nodeType: 3, tagName: "#text", text: String(text), connected: false }), this.#gate);
	}

	createComment(text) {
		this.#gate.check("dom");
		return new PpermNode(makeData({ nodeType: 8, tagName: "#comment", text: String(text), connected: false }), this.#gate);
	}

	createDocumentFragment() {
		this.#gate.check("dom");
		return new PpermNode(makeData({ nodeType: 11, tagName: "#fragment", connected: false }), this.#gate);
	}

	createEvent() {
		this.#gate.check("dom");
		throw new DOMException("Use dispatchEvent with an Event-like object", "NotSupportedError");
	}

	addEventListener(type, callback, options) {
		this.#gate.check("dom");
		return new PpermNode(root, this.#gate).addEventListener(type, callback, options);
	}

	removeEventListener(type, callback, options) {
		this.#gate.check("dom");
		return new PpermNode(root, this.#gate).removeEventListener(type, callback, options);
	}

	importNode(node, deep = false) {
		this.#gate.check("dom");
		if (!(node instanceof PpermNode)) throw new TypeError("Expected a pperm Node");
		return node.cloneNode(deep);
	}

	adoptNode(node) {
		this.#gate.check("dom");
		if (!(node instanceof PpermNode)) throw new TypeError("Expected a pperm Node");
		if (raw(node) === root) denied("adopting the permitted root");
		if (raw(node).parent) new PpermNode(raw(node).parent, this.#gate).removeChild(node);
		return node;
	}

	getElementsByTagNameNS(namespace, localName) {
		this.#gate.check("dom");
		if (namespace !== null && namespace !== "*" && namespace !== "http://www.w3.org/1999/xhtml") return [];
		return this.getElementsByTagName(localName);
	}

	getElementsByName(name) {
		this.#gate.check("dom");
		const value = String(name);
		const out = [];
		const walk = data => {
			if (data.nodeType === 1 && data.attributes.name === value) out.push(new PpermNode(data, this.#gate));
			data.children.forEach(walk);
		};
		walk(root);
		return out;
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
			documentTitle = String(message.documentTitle ?? "");
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
