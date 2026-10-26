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
		styleData: { ...data.styleData }, value: data.value, checked: data.checked, disabled: data.disabled, muted: data.muted,
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
		value: input.value, checked: input.checked, disabled: input.disabled, muted: input.muted, selected: input.selected,
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
		const next = {};
		for (const declaration of text.split(";")) {
			const index = declaration.indexOf(":");
			if (index < 0) continue;
			const name = declaration.slice(0, index).trim();
			const valueText = declaration.slice(index + 1).trim();
			if (name) {
				const safeName = safeStyle(name, valueText);
				const key = safeName.startsWith("--") ? safeName : safeName.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
				next[key] = valueText;
			}
		}
		this.#owner.styleData = next;
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

	_commit(values, method, args) {
		this.#gate.check("dom");
		this.#owner.className = [...new Set(values)].join(" ");
		this.#owner.attributes.class = this.#owner.className;
		emitMutation(this.#owner, "classList", { method, args });
	}

	_validateTokens(values) {
		this.#gate.check("dom");
		for (const value of values) {
			if (value === "") throw new DOMException("The token must not be empty", "SyntaxError");
			if (/\s/.test(value)) throw new DOMException("The token must not contain whitespace", "InvalidCharacterError");
		}
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
		const tokens = values.map(String);
		this._validateTokens(tokens);
		this._commit([...this._values(), ...tokens], "add", tokens);
	}

	remove(...values) {
		this.#gate.check("dom");
		const tokens = values.map(String);
		this._validateTokens(tokens);
		const removeSet = new Set(tokens);
		this._commit(this._values().filter(value => !removeSet.has(value)), "remove", tokens);
	}

	toggle(value, force) {
		this.#gate.check("dom");
		const token = String(value);
		this._validateTokens([token]);
		if (force !== undefined && typeof force !== "boolean") throw new TypeError("The force argument must be a boolean");
		const values = this._values();
		const has = values.includes(token);
		if (force === true || (!has && force !== false)) this._commit([...values, token], "toggle", force === undefined ? [token] : [token, force]);
		else if (has && force !== true) this._commit(values.filter(item => item !== token), "toggle", force === undefined ? [token] : [token, force]);
		return this._values().includes(token);
	}

	replace(oldValue, newValue) {
		this.#gate.check("dom");
		const oldToken = String(oldValue), newToken = String(newValue);
		this._validateTokens([oldToken, newToken]);
		const values = this._values();
		const index = values.indexOf(oldToken);
		if (index < 0) return false;
		values[index] = newToken;
		this._commit(values, "replace", [oldToken, newToken]);
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

const ordinaryAttributeProperties = new Map([
	["id", { attribute: "id", kind: "string", field: "idName" }],
	["className", { attribute: "class", kind: "string", field: "className" }],
	["title", { attribute: "title", kind: "string" }],
	["name", { attribute: "name", kind: "string" }],
	["type", { attribute: "type", kind: "string" }],
	["defaultValue", { attribute: "value", kind: "string" }],
	["accessKey", { attribute: "accesskey", kind: "string" }],
	["accept", { attribute: "accept", kind: "string" }],
	["alt", { attribute: "alt", kind: "string" }],
	["autocomplete", { attribute: "autocomplete", kind: "string" }],
	["capture", { attribute: "capture", kind: "string" }],
	["cite", { attribute: "cite", kind: "string" }],
	["contentEditable", { attribute: "contenteditable", kind: "string" }],
	["crossOrigin", { attribute: "crossorigin", kind: "string" }],
	["dir", { attribute: "dir", kind: "string" }],
	["draggable", { attribute: "draggable", kind: "string" }],
	["enterKeyHint", { attribute: "enterkeyhint", kind: "string" }],
	["formEnctype", { attribute: "formenctype", kind: "string" }],
	["formMethod", { attribute: "formmethod", kind: "string" }],
	["formTarget", { attribute: "formtarget", kind: "string" }],
	["htmlFor", { attribute: "for", kind: "string" }],
	["inputMode", { attribute: "inputmode", kind: "string" }],
	["lang", { attribute: "lang", kind: "string" }],
	["max", { attribute: "max", kind: "string" }],
	["media", { attribute: "media", kind: "string" }],
	["min", { attribute: "min", kind: "string" }],
	["placeholder", { attribute: "placeholder", kind: "string" }],
	["referrerPolicy", { attribute: "referrerpolicy", kind: "string" }],
	["rel", { attribute: "rel", kind: "string" }],
	["role", { attribute: "role", kind: "string" }],
	["scope", { attribute: "scope", kind: "string" }],
	["slot", { attribute: "slot", kind: "string" }],
	["spellcheck", { attribute: "spellcheck", kind: "string" }],
	["step", { attribute: "step", kind: "string" }],
	["target", { attribute: "target", kind: "string" }],
	["translate", { attribute: "translate", kind: "string" }],
	["wrap", { attribute: "wrap", kind: "string" }],
	["label", { attribute: "label", kind: "string" }],
	["sizes", { attribute: "sizes", kind: "string" }],
	["defaultSelected", { attribute: "selected", kind: "boolean" }],
	["hidden", { attribute: "hidden", kind: "boolean" }],
	["multiple", { attribute: "multiple", kind: "boolean" }],
	["required", { attribute: "required", kind: "boolean" }],
	["readOnly", { attribute: "readonly", kind: "boolean" }],
	["autofocus", { attribute: "autofocus", kind: "boolean" }],
	["controls", { attribute: "controls", kind: "boolean" }],
	["loop", { attribute: "loop", kind: "boolean" }],
	["muted", { attribute: "muted", kind: "stateBoolean" }],
	["open", { attribute: "open", kind: "boolean" }],
	["reversed", { attribute: "reversed", kind: "boolean" }],
	["noValidate", { attribute: "novalidate", kind: "boolean" }],
	["playsInline", { attribute: "playsinline", kind: "boolean" }],
	["defaultChecked", { attribute: "checked", kind: "boolean" }],
	["defaultMuted", { attribute: "muted", kind: "boolean" }],
	["disablePictureInPicture", { attribute: "disablepictureinpicture", kind: "boolean" }],
	["disableRemotePlayback", { attribute: "disableremoteplayback", kind: "boolean" }],
]);
const eventPropertyNames = new Set(["onclick","onchange","oninput","onsubmit","onfocus","onblur","ondblclick","oncontextmenu","onmousedown","onmouseup","onmousemove","onmouseover","onmouseout","onmouseenter","onmouseleave","onkeydown","onkeyup","onkeypress","onwheel","onscroll","onload","onerror","onreset","onselect","oninvalid","onfocusin","onfocusout","onpointerdown","onpointerup","onpointermove","onpointerover","onpointerout","onpointerenter","onpointerleave","onpointercancel","ontouchstart","ontouchmove","ontouchend","ontouchcancel","ondrag","ondragstart","ondragend","ondragenter","ondragover","ondragleave","ondrop","oncopy","oncut","onpaste","onanimationstart","onanimationend","onanimationiteration","ontransitionend","onplay","onpause","onended","ontimeupdate","onvolumechange","oncanplay","onwaiting","onprogress","oncanplaythrough","onratechange","onseeking","onseeked"]);

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
		const proxy = new Proxy(this, {
			get(target, property) {
				if (typeof property === "string" && ordinaryAttributeProperties.has(property)) {
					target.#gate.check("dom");
					const { attribute, kind, field } = ordinaryAttributeProperties.get(property);
					if (field) return target.#data[field];
					if (kind === "boolean") return Object.hasOwn(target.#data.attributes, attribute);
					if (kind === "stateBoolean") return target.#data.muted ?? Object.hasOwn(target.#data.attributes, attribute);
					return target.#data.attributes[attribute] ?? "";
				}
				if (typeof property === "string" && eventPropertyNames.has(property)) {
					target.#gate.check("dom");
					return target.#eventProperties.get(property) ?? null;
				}
				if (typeof property === "string" && ["__proto__", "prototype", "constructor"].includes(property)) denied(property);
				if (property in target) {
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				}
				if (typeof property === "string") denied("DOM property " + property);
				return Reflect.get(target, property, target);
			},
			set(target, property, value) {
				if (typeof property === "string" && ordinaryAttributeProperties.has(property)) {
					target.#gate.check("dom");
					const { attribute, kind, field } = ordinaryAttributeProperties.get(property);
					let next = value;
					if (kind === "boolean" || kind === "stateBoolean") { next = Boolean(value); safeAttribute(attribute, ""); }
					else { next = String(value); safeAttribute(attribute, next); }
					if (kind === "boolean") {
						if (next) target.#data.attributes[attribute] = "";
						else delete target.#data.attributes[attribute];
					} else if (kind === "stateBoolean") target.#data.muted = next;
					else target.#data.attributes[attribute] = next;
					if (field) target.#data[field] = next;
					emitMutation(target.#data, "reflectedProperty", { property, attribute, value: next, kind });
					return true;
				}
				if (typeof property === "string" && eventPropertyNames.has(property)) {
					target.#gate.check("dom");
					if (value != null && typeof value !== "function") throw new TypeError(property + " must be a function or null");
					const old = target.#eventProperties.get(property);
					const type = property.slice(2);
					if (old) target.removeEventListener(type, old);
					if (value == null) target.#eventProperties.delete(property);
					else { target.#eventProperties.set(property, value); target.addEventListener(type, value); }
					return true;
				}
				if (typeof property === "string" && ["__proto__", "prototype", "constructor"].includes(property)) denied(property);
				if (property in target) return Reflect.set(target, property, value, target);
				if (typeof property === "string") denied("DOM property " + property);
				return Reflect.set(target, property, value, target);
			}
		});
		nodeDataByInstance.set(proxy, this.#data);
		return proxy;
	}


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
	set innerText(value) { this.#gate.check("dom"); const d=this.#data; for(const c of d.children){c.parent=null;setConnected(c,false);} d.children=[];d.text=value==null?"":String(value);emitMutation(d,"innerText",{value:d.text}); }
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
	set href(value) { this.#gate.check("dom"); const text=String(value);safeAttribute("href",text);this.#data.attributes.href=text;emitMutation(this.#data,"urlProperty",{property:"href",value:text}); }
	get src() { this.#gate.check("dom"); return this.#data.attributes.src??""; }
	set src(value) { this.#gate.check("dom"); const text=String(value);safeAttribute("src",text);this.#data.attributes.src=text;emitMutation(this.#data,"urlProperty",{property:"src",value:text}); }
	get poster() { this.#gate.check("dom"); return this.#data.attributes.poster??""; }
	set poster(value) { this.#gate.check("dom"); const text=String(value);safeAttribute("poster",text);this.#data.attributes.poster=text;emitMutation(this.#data,"urlProperty",{property:"poster",value:text}); }
	get value() { this.#gate.check("dom"); return this.#data.value??this.#data.attributes.value??""; }
	set value(value) { this.#gate.check("dom"); if(value!==null&&(typeof value==="object"||typeof value==="function"))throw new TypeError("DOM property value must be primitive");const text=String(value);this.#data.value=text;emitMutation(this.#data,"formProperty",{property:"value",value:text}); }
	get checked() { this.#gate.check("dom"); return this.#data.checked ?? Object.hasOwn(this.#data.attributes, "checked"); }
	set checked(value) { this.#gate.check("dom"); this.#data.checked=Boolean(value);emitMutation(this.#data,"formProperty",{property:"checked",value:this.#data.checked}); }
	get disabled() { this.#gate.check("dom"); return this.#data.disabled ?? Object.hasOwn(this.#data.attributes, "disabled"); }
	set disabled(value) { this.#gate.check("dom"); this.#data.disabled = Boolean(value); if (this.#data.disabled) this.#data.attributes.disabled = ""; else delete this.#data.attributes.disabled; emitMutation(this.#data, "formProperty", { property: "disabled", value: this.#data.disabled }); }

	get selected() { this.#gate.check("dom"); return this.#data.selected ?? Object.hasOwn(this.#data.attributes, "selected"); }
	set selected(value) { this.#gate.check("dom"); this.#data.selected = Boolean(value); emitMutation(this.#data, "formProperty", { property: "selected", value: this.#data.selected }); }
	get tabIndex() { this.#gate.check("dom"); return this.#data.tabIndex ?? Number(this.#data.attributes["tabindex"] ?? 0); }
	set tabIndex(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("tabIndex must be a finite number"); this.#data.tabIndex = number; emitMutation(this.#data, "numericProperty", { property: "tabIndex", value: number }); }
	get width() { this.#gate.check("dom"); return this.#data.width ?? Number(this.#data.attributes["width"] ?? 0); }
	set width(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("width must be a finite number"); this.#data.width = number; emitMutation(this.#data, "numericProperty", { property: "width", value: number }); }
	get height() { this.#gate.check("dom"); return this.#data.height ?? Number(this.#data.attributes["height"] ?? 0); }
	set height(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("height must be a finite number"); this.#data.height = number; emitMutation(this.#data, "numericProperty", { property: "height", value: number }); }
	get rows() { this.#gate.check("dom"); return this.#data.rows ?? Number(this.#data.attributes["rows"] ?? 0); }
	set rows(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("rows must be a finite number"); this.#data.rows = number; emitMutation(this.#data, "numericProperty", { property: "rows", value: number }); }
	get cols() { this.#gate.check("dom"); return this.#data.cols ?? Number(this.#data.attributes["cols"] ?? 0); }
	set cols(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("cols must be a finite number"); this.#data.cols = number; emitMutation(this.#data, "numericProperty", { property: "cols", value: number }); }
	get maxLength() { this.#gate.check("dom"); return this.#data.maxLength ?? Number(this.#data.attributes["maxlength"] ?? 0); }
	set maxLength(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("maxLength must be a finite number"); this.#data.maxLength = number; emitMutation(this.#data, "numericProperty", { property: "maxLength", value: number }); }
	get minLength() { this.#gate.check("dom"); return this.#data.minLength ?? Number(this.#data.attributes["minlength"] ?? 0); }
	set minLength(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("minLength must be a finite number"); this.#data.minLength = number; emitMutation(this.#data, "numericProperty", { property: "minLength", value: number }); }
	get rowSpan() { this.#gate.check("dom"); return this.#data.rowSpan ?? Number(this.#data.attributes["rowspan"] ?? 0); }
	set rowSpan(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("rowSpan must be a finite number"); this.#data.rowSpan = number; emitMutation(this.#data, "numericProperty", { property: "rowSpan", value: number }); }
	get colSpan() { this.#gate.check("dom"); return this.#data.colSpan ?? Number(this.#data.attributes["colspan"] ?? 0); }
	set colSpan(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("colSpan must be a finite number"); this.#data.colSpan = number; emitMutation(this.#data, "numericProperty", { property: "colSpan", value: number }); }
	get size() { this.#gate.check("dom"); return this.#data.size ?? Number(this.#data.attributes["size"] ?? 0); }
	set size(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("size must be a finite number"); this.#data.size = number; emitMutation(this.#data, "numericProperty", { property: "size", value: number }); }
	get start() { this.#gate.check("dom"); return this.#data.start ?? Number(this.#data.attributes["start"] ?? 0); }
	set start(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("start must be a finite number"); this.#data.start = number; emitMutation(this.#data, "numericProperty", { property: "start", value: number }); }
	get span() { this.#gate.check("dom"); return this.#data.span ?? Number(this.#data.attributes["span"] ?? 0); }
	set span(value) { this.#gate.check("dom"); const number = Number(value); if (!Number.isFinite(number)) throw new TypeError("span must be a finite number"); this.#data.span = number; emitMutation(this.#data, "numericProperty", { property: "span", value: number }); }

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
		if (shouldHave === present) return shouldHave;
		if (shouldHave) this.#data.attributes[safeName] = "";
		else delete this.#data.attributes[safeName];
		if (safeName === "id") this.#data.idName = shouldHave ? "" : "";
		if (safeName === "class") this.#data.className = shouldHave ? "" : "";
		emitMutation(this.#data, "toggleAttribute", { name: safeName, force: shouldHave });
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
