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
	#owner;
	#gate;
	constructor(owner, gate) {
		this.#owner = owner;
		this.#gate = gate;
		Object.preventExtensions(this);
	}

	get cssText() {
		this.#gate.check("dom");
		return Object.entries(this.#owner.styleData).map(([name, value]) => name.replace(/[A-Z]/g, c => "-" + c.toLowerCase()) + ": " + value + ";").join(" ");
	}
	set cssText(value) {
		this.#gate.check("dom");
		const text = String(value);
		if (/url\s*\(|expression\s*\(|@import|-moz-binding|behavior\s*:|\\|\/\*/i.test(text)) denied("cssText");
		const next = {};
		for (const declaration of text.split(";")) {
			const index = declaration.indexOf(":");
			if (index < 0) continue;
			const name = declaration.slice(0, index).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
			const valueText = declaration.slice(index + 1).trim();
			if (name) { safeStyle(name, valueText); next[name] = valueText; }
		}
		this.#owner.styleData = next;
		emitMutation(this.#owner, "style", { property: "cssText", value: text });
	}
	get length() { this.#gate.check("dom"); return Object.keys(this.#owner.styleData).length; }
	item(index) { this.#gate.check("dom"); return Object.keys(this.#owner.styleData)[Number(index)]?.replace(/[A-Z]/g, c => "-" + c.toLowerCase()) ?? ""; }
	setProperty(name, value, priority = "") {
		this.#gate.check("dom");
		const property = safeStyle(name, value);
		const cssValue = String(value);
		this.#owner.styleData[property.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = cssValue;
		emitMutation(this.#owner, "style", { property, value: cssValue, priority: String(priority) });
	}
	getPropertyValue(name) {
		this.#gate.check("dom");
		return this.#owner.styleData[String(name).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? "";
	}
	getPropertyPriority(name) { this.#gate.check("dom"); return ""; }
	removeProperty(name) {
		this.#gate.check("dom");
		const key = String(name).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		const oldValue = this.#owner.styleData[key] ?? "";
		delete this.#owner.styleData[key];
		emitMutation(this.#owner, "style", { property: String(name), value: "" });
		return oldValue;
	}
	get accentColor() { this.#gate.check("dom"); return this.#owner.styleData.accentColor ?? ""; }
	set accentColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("accentColor", text); this.#owner.styleData.accentColor = text; emitMutation(this.#owner, "style", { property: "accentColor", value: text }); }
	get alignContent() { this.#gate.check("dom"); return this.#owner.styleData.alignContent ?? ""; }
	set alignContent(value) { this.#gate.check("dom"); const text = String(value); safeStyle("alignContent", text); this.#owner.styleData.alignContent = text; emitMutation(this.#owner, "style", { property: "alignContent", value: text }); }
	get alignItems() { this.#gate.check("dom"); return this.#owner.styleData.alignItems ?? ""; }
	set alignItems(value) { this.#gate.check("dom"); const text = String(value); safeStyle("alignItems", text); this.#owner.styleData.alignItems = text; emitMutation(this.#owner, "style", { property: "alignItems", value: text }); }
	get alignSelf() { this.#gate.check("dom"); return this.#owner.styleData.alignSelf ?? ""; }
	set alignSelf(value) { this.#gate.check("dom"); const text = String(value); safeStyle("alignSelf", text); this.#owner.styleData.alignSelf = text; emitMutation(this.#owner, "style", { property: "alignSelf", value: text }); }
	get all() { this.#gate.check("dom"); return this.#owner.styleData.all ?? ""; }
	set all(value) { this.#gate.check("dom"); const text = String(value); safeStyle("all", text); this.#owner.styleData.all = text; emitMutation(this.#owner, "style", { property: "all", value: text }); }
	get animation() { this.#gate.check("dom"); return this.#owner.styleData.animation ?? ""; }
	set animation(value) { this.#gate.check("dom"); const text = String(value); safeStyle("animation", text); this.#owner.styleData.animation = text; emitMutation(this.#owner, "style", { property: "animation", value: text }); }
	get animationDelay() { this.#gate.check("dom"); return this.#owner.styleData.animationDelay ?? ""; }
	set animationDelay(value) { this.#gate.check("dom"); const text = String(value); safeStyle("animationDelay", text); this.#owner.styleData.animationDelay = text; emitMutation(this.#owner, "style", { property: "animationDelay", value: text }); }
	get animationDirection() { this.#gate.check("dom"); return this.#owner.styleData.animationDirection ?? ""; }
	set animationDirection(value) { this.#gate.check("dom"); const text = String(value); safeStyle("animationDirection", text); this.#owner.styleData.animationDirection = text; emitMutation(this.#owner, "style", { property: "animationDirection", value: text }); }
	get animationDuration() { this.#gate.check("dom"); return this.#owner.styleData.animationDuration ?? ""; }
	set animationDuration(value) { this.#gate.check("dom"); const text = String(value); safeStyle("animationDuration", text); this.#owner.styleData.animationDuration = text; emitMutation(this.#owner, "style", { property: "animationDuration", value: text }); }
	get animationFillMode() { this.#gate.check("dom"); return this.#owner.styleData.animationFillMode ?? ""; }
	set animationFillMode(value) { this.#gate.check("dom"); const text = String(value); safeStyle("animationFillMode", text); this.#owner.styleData.animationFillMode = text; emitMutation(this.#owner, "style", { property: "animationFillMode", value: text }); }
	get animationIterationCount() { this.#gate.check("dom"); return this.#owner.styleData.animationIterationCount ?? ""; }
	set animationIterationCount(value) { this.#gate.check("dom"); const text = String(value); safeStyle("animationIterationCount", text); this.#owner.styleData.animationIterationCount = text; emitMutation(this.#owner, "style", { property: "animationIterationCount", value: text }); }
	get animationName() { this.#gate.check("dom"); return this.#owner.styleData.animationName ?? ""; }
	set animationName(value) { this.#gate.check("dom"); const text = String(value); safeStyle("animationName", text); this.#owner.styleData.animationName = text; emitMutation(this.#owner, "style", { property: "animationName", value: text }); }
	get animationPlayState() { this.#gate.check("dom"); return this.#owner.styleData.animationPlayState ?? ""; }
	set animationPlayState(value) { this.#gate.check("dom"); const text = String(value); safeStyle("animationPlayState", text); this.#owner.styleData.animationPlayState = text; emitMutation(this.#owner, "style", { property: "animationPlayState", value: text }); }
	get animationTimingFunction() { this.#gate.check("dom"); return this.#owner.styleData.animationTimingFunction ?? ""; }
	set animationTimingFunction(value) { this.#gate.check("dom"); const text = String(value); safeStyle("animationTimingFunction", text); this.#owner.styleData.animationTimingFunction = text; emitMutation(this.#owner, "style", { property: "animationTimingFunction", value: text }); }
	get appearance() { this.#gate.check("dom"); return this.#owner.styleData.appearance ?? ""; }
	set appearance(value) { this.#gate.check("dom"); const text = String(value); safeStyle("appearance", text); this.#owner.styleData.appearance = text; emitMutation(this.#owner, "style", { property: "appearance", value: text }); }
	get aspectRatio() { this.#gate.check("dom"); return this.#owner.styleData.aspectRatio ?? ""; }
	set aspectRatio(value) { this.#gate.check("dom"); const text = String(value); safeStyle("aspectRatio", text); this.#owner.styleData.aspectRatio = text; emitMutation(this.#owner, "style", { property: "aspectRatio", value: text }); }
	get backfaceVisibility() { this.#gate.check("dom"); return this.#owner.styleData.backfaceVisibility ?? ""; }
	set backfaceVisibility(value) { this.#gate.check("dom"); const text = String(value); safeStyle("backfaceVisibility", text); this.#owner.styleData.backfaceVisibility = text; emitMutation(this.#owner, "style", { property: "backfaceVisibility", value: text }); }
	get background() { this.#gate.check("dom"); return this.#owner.styleData.background ?? ""; }
	set background(value) { this.#gate.check("dom"); const text = String(value); safeStyle("background", text); this.#owner.styleData.background = text; emitMutation(this.#owner, "style", { property: "background", value: text }); }
	get backgroundAttachment() { this.#gate.check("dom"); return this.#owner.styleData.backgroundAttachment ?? ""; }
	set backgroundAttachment(value) { this.#gate.check("dom"); const text = String(value); safeStyle("backgroundAttachment", text); this.#owner.styleData.backgroundAttachment = text; emitMutation(this.#owner, "style", { property: "backgroundAttachment", value: text }); }
	get backgroundBlendMode() { this.#gate.check("dom"); return this.#owner.styleData.backgroundBlendMode ?? ""; }
	set backgroundBlendMode(value) { this.#gate.check("dom"); const text = String(value); safeStyle("backgroundBlendMode", text); this.#owner.styleData.backgroundBlendMode = text; emitMutation(this.#owner, "style", { property: "backgroundBlendMode", value: text }); }
	get backgroundClip() { this.#gate.check("dom"); return this.#owner.styleData.backgroundClip ?? ""; }
	set backgroundClip(value) { this.#gate.check("dom"); const text = String(value); safeStyle("backgroundClip", text); this.#owner.styleData.backgroundClip = text; emitMutation(this.#owner, "style", { property: "backgroundClip", value: text }); }
	get backgroundColor() { this.#gate.check("dom"); return this.#owner.styleData.backgroundColor ?? ""; }
	set backgroundColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("backgroundColor", text); this.#owner.styleData.backgroundColor = text; emitMutation(this.#owner, "style", { property: "backgroundColor", value: text }); }
	get backgroundImage() { this.#gate.check("dom"); return this.#owner.styleData.backgroundImage ?? ""; }
	set backgroundImage(value) { this.#gate.check("dom"); const text = String(value); safeStyle("backgroundImage", text); this.#owner.styleData.backgroundImage = text; emitMutation(this.#owner, "style", { property: "backgroundImage", value: text }); }
	get backgroundOrigin() { this.#gate.check("dom"); return this.#owner.styleData.backgroundOrigin ?? ""; }
	set backgroundOrigin(value) { this.#gate.check("dom"); const text = String(value); safeStyle("backgroundOrigin", text); this.#owner.styleData.backgroundOrigin = text; emitMutation(this.#owner, "style", { property: "backgroundOrigin", value: text }); }
	get backgroundPosition() { this.#gate.check("dom"); return this.#owner.styleData.backgroundPosition ?? ""; }
	set backgroundPosition(value) { this.#gate.check("dom"); const text = String(value); safeStyle("backgroundPosition", text); this.#owner.styleData.backgroundPosition = text; emitMutation(this.#owner, "style", { property: "backgroundPosition", value: text }); }
	get backgroundRepeat() { this.#gate.check("dom"); return this.#owner.styleData.backgroundRepeat ?? ""; }
	set backgroundRepeat(value) { this.#gate.check("dom"); const text = String(value); safeStyle("backgroundRepeat", text); this.#owner.styleData.backgroundRepeat = text; emitMutation(this.#owner, "style", { property: "backgroundRepeat", value: text }); }
	get backgroundSize() { this.#gate.check("dom"); return this.#owner.styleData.backgroundSize ?? ""; }
	set backgroundSize(value) { this.#gate.check("dom"); const text = String(value); safeStyle("backgroundSize", text); this.#owner.styleData.backgroundSize = text; emitMutation(this.#owner, "style", { property: "backgroundSize", value: text }); }
	get blockSize() { this.#gate.check("dom"); return this.#owner.styleData.blockSize ?? ""; }
	set blockSize(value) { this.#gate.check("dom"); const text = String(value); safeStyle("blockSize", text); this.#owner.styleData.blockSize = text; emitMutation(this.#owner, "style", { property: "blockSize", value: text }); }
	get border() { this.#gate.check("dom"); return this.#owner.styleData.border ?? ""; }
	set border(value) { this.#gate.check("dom"); const text = String(value); safeStyle("border", text); this.#owner.styleData.border = text; emitMutation(this.#owner, "style", { property: "border", value: text }); }
	get borderBlock() { this.#gate.check("dom"); return this.#owner.styleData.borderBlock ?? ""; }
	set borderBlock(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBlock", text); this.#owner.styleData.borderBlock = text; emitMutation(this.#owner, "style", { property: "borderBlock", value: text }); }
	get borderBlockColor() { this.#gate.check("dom"); return this.#owner.styleData.borderBlockColor ?? ""; }
	set borderBlockColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBlockColor", text); this.#owner.styleData.borderBlockColor = text; emitMutation(this.#owner, "style", { property: "borderBlockColor", value: text }); }
	get borderBlockEnd() { this.#gate.check("dom"); return this.#owner.styleData.borderBlockEnd ?? ""; }
	set borderBlockEnd(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBlockEnd", text); this.#owner.styleData.borderBlockEnd = text; emitMutation(this.#owner, "style", { property: "borderBlockEnd", value: text }); }
	get borderBlockEndColor() { this.#gate.check("dom"); return this.#owner.styleData.borderBlockEndColor ?? ""; }
	set borderBlockEndColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBlockEndColor", text); this.#owner.styleData.borderBlockEndColor = text; emitMutation(this.#owner, "style", { property: "borderBlockEndColor", value: text }); }
	get borderBlockEndStyle() { this.#gate.check("dom"); return this.#owner.styleData.borderBlockEndStyle ?? ""; }
	set borderBlockEndStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBlockEndStyle", text); this.#owner.styleData.borderBlockEndStyle = text; emitMutation(this.#owner, "style", { property: "borderBlockEndStyle", value: text }); }
	get borderBlockEndWidth() { this.#gate.check("dom"); return this.#owner.styleData.borderBlockEndWidth ?? ""; }
	set borderBlockEndWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBlockEndWidth", text); this.#owner.styleData.borderBlockEndWidth = text; emitMutation(this.#owner, "style", { property: "borderBlockEndWidth", value: text }); }
	get borderBlockStart() { this.#gate.check("dom"); return this.#owner.styleData.borderBlockStart ?? ""; }
	set borderBlockStart(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBlockStart", text); this.#owner.styleData.borderBlockStart = text; emitMutation(this.#owner, "style", { property: "borderBlockStart", value: text }); }
	get borderBlockStartColor() { this.#gate.check("dom"); return this.#owner.styleData.borderBlockStartColor ?? ""; }
	set borderBlockStartColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBlockStartColor", text); this.#owner.styleData.borderBlockStartColor = text; emitMutation(this.#owner, "style", { property: "borderBlockStartColor", value: text }); }
	get borderBlockStartStyle() { this.#gate.check("dom"); return this.#owner.styleData.borderBlockStartStyle ?? ""; }
	set borderBlockStartStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBlockStartStyle", text); this.#owner.styleData.borderBlockStartStyle = text; emitMutation(this.#owner, "style", { property: "borderBlockStartStyle", value: text }); }
	get borderBlockStartWidth() { this.#gate.check("dom"); return this.#owner.styleData.borderBlockStartWidth ?? ""; }
	set borderBlockStartWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBlockStartWidth", text); this.#owner.styleData.borderBlockStartWidth = text; emitMutation(this.#owner, "style", { property: "borderBlockStartWidth", value: text }); }
	get borderBottom() { this.#gate.check("dom"); return this.#owner.styleData.borderBottom ?? ""; }
	set borderBottom(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBottom", text); this.#owner.styleData.borderBottom = text; emitMutation(this.#owner, "style", { property: "borderBottom", value: text }); }
	get borderBottomColor() { this.#gate.check("dom"); return this.#owner.styleData.borderBottomColor ?? ""; }
	set borderBottomColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBottomColor", text); this.#owner.styleData.borderBottomColor = text; emitMutation(this.#owner, "style", { property: "borderBottomColor", value: text }); }
	get borderBottomLeftRadius() { this.#gate.check("dom"); return this.#owner.styleData.borderBottomLeftRadius ?? ""; }
	set borderBottomLeftRadius(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBottomLeftRadius", text); this.#owner.styleData.borderBottomLeftRadius = text; emitMutation(this.#owner, "style", { property: "borderBottomLeftRadius", value: text }); }
	get borderBottomRightRadius() { this.#gate.check("dom"); return this.#owner.styleData.borderBottomRightRadius ?? ""; }
	set borderBottomRightRadius(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBottomRightRadius", text); this.#owner.styleData.borderBottomRightRadius = text; emitMutation(this.#owner, "style", { property: "borderBottomRightRadius", value: text }); }
	get borderBottomStyle() { this.#gate.check("dom"); return this.#owner.styleData.borderBottomStyle ?? ""; }
	set borderBottomStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBottomStyle", text); this.#owner.styleData.borderBottomStyle = text; emitMutation(this.#owner, "style", { property: "borderBottomStyle", value: text }); }
	get borderBottomWidth() { this.#gate.check("dom"); return this.#owner.styleData.borderBottomWidth ?? ""; }
	set borderBottomWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderBottomWidth", text); this.#owner.styleData.borderBottomWidth = text; emitMutation(this.#owner, "style", { property: "borderBottomWidth", value: text }); }
	get borderCollapse() { this.#gate.check("dom"); return this.#owner.styleData.borderCollapse ?? ""; }
	set borderCollapse(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderCollapse", text); this.#owner.styleData.borderCollapse = text; emitMutation(this.#owner, "style", { property: "borderCollapse", value: text }); }
	get borderColor() { this.#gate.check("dom"); return this.#owner.styleData.borderColor ?? ""; }
	set borderColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderColor", text); this.#owner.styleData.borderColor = text; emitMutation(this.#owner, "style", { property: "borderColor", value: text }); }
	get borderImage() { this.#gate.check("dom"); return this.#owner.styleData.borderImage ?? ""; }
	set borderImage(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderImage", text); this.#owner.styleData.borderImage = text; emitMutation(this.#owner, "style", { property: "borderImage", value: text }); }
	get borderImageOutset() { this.#gate.check("dom"); return this.#owner.styleData.borderImageOutset ?? ""; }
	set borderImageOutset(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderImageOutset", text); this.#owner.styleData.borderImageOutset = text; emitMutation(this.#owner, "style", { property: "borderImageOutset", value: text }); }
	get borderImageRepeat() { this.#gate.check("dom"); return this.#owner.styleData.borderImageRepeat ?? ""; }
	set borderImageRepeat(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderImageRepeat", text); this.#owner.styleData.borderImageRepeat = text; emitMutation(this.#owner, "style", { property: "borderImageRepeat", value: text }); }
	get borderImageSlice() { this.#gate.check("dom"); return this.#owner.styleData.borderImageSlice ?? ""; }
	set borderImageSlice(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderImageSlice", text); this.#owner.styleData.borderImageSlice = text; emitMutation(this.#owner, "style", { property: "borderImageSlice", value: text }); }
	get borderImageSource() { this.#gate.check("dom"); return this.#owner.styleData.borderImageSource ?? ""; }
	set borderImageSource(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderImageSource", text); this.#owner.styleData.borderImageSource = text; emitMutation(this.#owner, "style", { property: "borderImageSource", value: text }); }
	get borderImageWidth() { this.#gate.check("dom"); return this.#owner.styleData.borderImageWidth ?? ""; }
	set borderImageWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderImageWidth", text); this.#owner.styleData.borderImageWidth = text; emitMutation(this.#owner, "style", { property: "borderImageWidth", value: text }); }
	get borderInline() { this.#gate.check("dom"); return this.#owner.styleData.borderInline ?? ""; }
	set borderInline(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderInline", text); this.#owner.styleData.borderInline = text; emitMutation(this.#owner, "style", { property: "borderInline", value: text }); }
	get borderInlineColor() { this.#gate.check("dom"); return this.#owner.styleData.borderInlineColor ?? ""; }
	set borderInlineColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderInlineColor", text); this.#owner.styleData.borderInlineColor = text; emitMutation(this.#owner, "style", { property: "borderInlineColor", value: text }); }
	get borderInlineEnd() { this.#gate.check("dom"); return this.#owner.styleData.borderInlineEnd ?? ""; }
	set borderInlineEnd(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderInlineEnd", text); this.#owner.styleData.borderInlineEnd = text; emitMutation(this.#owner, "style", { property: "borderInlineEnd", value: text }); }
	get borderInlineEndColor() { this.#gate.check("dom"); return this.#owner.styleData.borderInlineEndColor ?? ""; }
	set borderInlineEndColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderInlineEndColor", text); this.#owner.styleData.borderInlineEndColor = text; emitMutation(this.#owner, "style", { property: "borderInlineEndColor", value: text }); }
	get borderInlineEndStyle() { this.#gate.check("dom"); return this.#owner.styleData.borderInlineEndStyle ?? ""; }
	set borderInlineEndStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderInlineEndStyle", text); this.#owner.styleData.borderInlineEndStyle = text; emitMutation(this.#owner, "style", { property: "borderInlineEndStyle", value: text }); }
	get borderInlineEndWidth() { this.#gate.check("dom"); return this.#owner.styleData.borderInlineEndWidth ?? ""; }
	set borderInlineEndWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderInlineEndWidth", text); this.#owner.styleData.borderInlineEndWidth = text; emitMutation(this.#owner, "style", { property: "borderInlineEndWidth", value: text }); }
	get borderInlineStart() { this.#gate.check("dom"); return this.#owner.styleData.borderInlineStart ?? ""; }
	set borderInlineStart(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderInlineStart", text); this.#owner.styleData.borderInlineStart = text; emitMutation(this.#owner, "style", { property: "borderInlineStart", value: text }); }
	get borderInlineStartColor() { this.#gate.check("dom"); return this.#owner.styleData.borderInlineStartColor ?? ""; }
	set borderInlineStartColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderInlineStartColor", text); this.#owner.styleData.borderInlineStartColor = text; emitMutation(this.#owner, "style", { property: "borderInlineStartColor", value: text }); }
	get borderInlineStartStyle() { this.#gate.check("dom"); return this.#owner.styleData.borderInlineStartStyle ?? ""; }
	set borderInlineStartStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderInlineStartStyle", text); this.#owner.styleData.borderInlineStartStyle = text; emitMutation(this.#owner, "style", { property: "borderInlineStartStyle", value: text }); }
	get borderInlineStartWidth() { this.#gate.check("dom"); return this.#owner.styleData.borderInlineStartWidth ?? ""; }
	set borderInlineStartWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderInlineStartWidth", text); this.#owner.styleData.borderInlineStartWidth = text; emitMutation(this.#owner, "style", { property: "borderInlineStartWidth", value: text }); }
	get borderInlineStyle() { this.#gate.check("dom"); return this.#owner.styleData.borderInlineStyle ?? ""; }
	set borderInlineStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderInlineStyle", text); this.#owner.styleData.borderInlineStyle = text; emitMutation(this.#owner, "style", { property: "borderInlineStyle", value: text }); }
	get borderInlineWidth() { this.#gate.check("dom"); return this.#owner.styleData.borderInlineWidth ?? ""; }
	set borderInlineWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderInlineWidth", text); this.#owner.styleData.borderInlineWidth = text; emitMutation(this.#owner, "style", { property: "borderInlineWidth", value: text }); }
	get borderLeft() { this.#gate.check("dom"); return this.#owner.styleData.borderLeft ?? ""; }
	set borderLeft(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderLeft", text); this.#owner.styleData.borderLeft = text; emitMutation(this.#owner, "style", { property: "borderLeft", value: text }); }
	get borderLeftColor() { this.#gate.check("dom"); return this.#owner.styleData.borderLeftColor ?? ""; }
	set borderLeftColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderLeftColor", text); this.#owner.styleData.borderLeftColor = text; emitMutation(this.#owner, "style", { property: "borderLeftColor", value: text }); }
	get borderLeftStyle() { this.#gate.check("dom"); return this.#owner.styleData.borderLeftStyle ?? ""; }
	set borderLeftStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderLeftStyle", text); this.#owner.styleData.borderLeftStyle = text; emitMutation(this.#owner, "style", { property: "borderLeftStyle", value: text }); }
	get borderLeftWidth() { this.#gate.check("dom"); return this.#owner.styleData.borderLeftWidth ?? ""; }
	set borderLeftWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderLeftWidth", text); this.#owner.styleData.borderLeftWidth = text; emitMutation(this.#owner, "style", { property: "borderLeftWidth", value: text }); }
	get borderRadius() { this.#gate.check("dom"); return this.#owner.styleData.borderRadius ?? ""; }
	set borderRadius(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderRadius", text); this.#owner.styleData.borderRadius = text; emitMutation(this.#owner, "style", { property: "borderRadius", value: text }); }
	get borderRight() { this.#gate.check("dom"); return this.#owner.styleData.borderRight ?? ""; }
	set borderRight(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderRight", text); this.#owner.styleData.borderRight = text; emitMutation(this.#owner, "style", { property: "borderRight", value: text }); }
	get borderRightColor() { this.#gate.check("dom"); return this.#owner.styleData.borderRightColor ?? ""; }
	set borderRightColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderRightColor", text); this.#owner.styleData.borderRightColor = text; emitMutation(this.#owner, "style", { property: "borderRightColor", value: text }); }
	get borderRightStyle() { this.#gate.check("dom"); return this.#owner.styleData.borderRightStyle ?? ""; }
	set borderRightStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderRightStyle", text); this.#owner.styleData.borderRightStyle = text; emitMutation(this.#owner, "style", { property: "borderRightStyle", value: text }); }
	get borderRightWidth() { this.#gate.check("dom"); return this.#owner.styleData.borderRightWidth ?? ""; }
	set borderRightWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderRightWidth", text); this.#owner.styleData.borderRightWidth = text; emitMutation(this.#owner, "style", { property: "borderRightWidth", value: text }); }
	get borderSpacing() { this.#gate.check("dom"); return this.#owner.styleData.borderSpacing ?? ""; }
	set borderSpacing(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderSpacing", text); this.#owner.styleData.borderSpacing = text; emitMutation(this.#owner, "style", { property: "borderSpacing", value: text }); }
	get borderStyle() { this.#gate.check("dom"); return this.#owner.styleData.borderStyle ?? ""; }
	set borderStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderStyle", text); this.#owner.styleData.borderStyle = text; emitMutation(this.#owner, "style", { property: "borderStyle", value: text }); }
	get borderTop() { this.#gate.check("dom"); return this.#owner.styleData.borderTop ?? ""; }
	set borderTop(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderTop", text); this.#owner.styleData.borderTop = text; emitMutation(this.#owner, "style", { property: "borderTop", value: text }); }
	get borderTopColor() { this.#gate.check("dom"); return this.#owner.styleData.borderTopColor ?? ""; }
	set borderTopColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderTopColor", text); this.#owner.styleData.borderTopColor = text; emitMutation(this.#owner, "style", { property: "borderTopColor", value: text }); }
	get borderTopLeftRadius() { this.#gate.check("dom"); return this.#owner.styleData.borderTopLeftRadius ?? ""; }
	set borderTopLeftRadius(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderTopLeftRadius", text); this.#owner.styleData.borderTopLeftRadius = text; emitMutation(this.#owner, "style", { property: "borderTopLeftRadius", value: text }); }
	get borderTopRightRadius() { this.#gate.check("dom"); return this.#owner.styleData.borderTopRightRadius ?? ""; }
	set borderTopRightRadius(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderTopRightRadius", text); this.#owner.styleData.borderTopRightRadius = text; emitMutation(this.#owner, "style", { property: "borderTopRightRadius", value: text }); }
	get borderTopStyle() { this.#gate.check("dom"); return this.#owner.styleData.borderTopStyle ?? ""; }
	set borderTopStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderTopStyle", text); this.#owner.styleData.borderTopStyle = text; emitMutation(this.#owner, "style", { property: "borderTopStyle", value: text }); }
	get borderTopWidth() { this.#gate.check("dom"); return this.#owner.styleData.borderTopWidth ?? ""; }
	set borderTopWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderTopWidth", text); this.#owner.styleData.borderTopWidth = text; emitMutation(this.#owner, "style", { property: "borderTopWidth", value: text }); }
	get borderWidth() { this.#gate.check("dom"); return this.#owner.styleData.borderWidth ?? ""; }
	set borderWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("borderWidth", text); this.#owner.styleData.borderWidth = text; emitMutation(this.#owner, "style", { property: "borderWidth", value: text }); }
	get bottom() { this.#gate.check("dom"); return this.#owner.styleData.bottom ?? ""; }
	set bottom(value) { this.#gate.check("dom"); const text = String(value); safeStyle("bottom", text); this.#owner.styleData.bottom = text; emitMutation(this.#owner, "style", { property: "bottom", value: text }); }
	get boxShadow() { this.#gate.check("dom"); return this.#owner.styleData.boxShadow ?? ""; }
	set boxShadow(value) { this.#gate.check("dom"); const text = String(value); safeStyle("boxShadow", text); this.#owner.styleData.boxShadow = text; emitMutation(this.#owner, "style", { property: "boxShadow", value: text }); }
	get boxSizing() { this.#gate.check("dom"); return this.#owner.styleData.boxSizing ?? ""; }
	set boxSizing(value) { this.#gate.check("dom"); const text = String(value); safeStyle("boxSizing", text); this.#owner.styleData.boxSizing = text; emitMutation(this.#owner, "style", { property: "boxSizing", value: text }); }
	get breakAfter() { this.#gate.check("dom"); return this.#owner.styleData.breakAfter ?? ""; }
	set breakAfter(value) { this.#gate.check("dom"); const text = String(value); safeStyle("breakAfter", text); this.#owner.styleData.breakAfter = text; emitMutation(this.#owner, "style", { property: "breakAfter", value: text }); }
	get breakBefore() { this.#gate.check("dom"); return this.#owner.styleData.breakBefore ?? ""; }
	set breakBefore(value) { this.#gate.check("dom"); const text = String(value); safeStyle("breakBefore", text); this.#owner.styleData.breakBefore = text; emitMutation(this.#owner, "style", { property: "breakBefore", value: text }); }
	get breakInside() { this.#gate.check("dom"); return this.#owner.styleData.breakInside ?? ""; }
	set breakInside(value) { this.#gate.check("dom"); const text = String(value); safeStyle("breakInside", text); this.#owner.styleData.breakInside = text; emitMutation(this.#owner, "style", { property: "breakInside", value: text }); }
	get captionSide() { this.#gate.check("dom"); return this.#owner.styleData.captionSide ?? ""; }
	set captionSide(value) { this.#gate.check("dom"); const text = String(value); safeStyle("captionSide", text); this.#owner.styleData.captionSide = text; emitMutation(this.#owner, "style", { property: "captionSide", value: text }); }
	get caretColor() { this.#gate.check("dom"); return this.#owner.styleData.caretColor ?? ""; }
	set caretColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("caretColor", text); this.#owner.styleData.caretColor = text; emitMutation(this.#owner, "style", { property: "caretColor", value: text }); }
	get clear() { this.#gate.check("dom"); return this.#owner.styleData.clear ?? ""; }
	set clear(value) { this.#gate.check("dom"); const text = String(value); safeStyle("clear", text); this.#owner.styleData.clear = text; emitMutation(this.#owner, "style", { property: "clear", value: text }); }
	get clip() { this.#gate.check("dom"); return this.#owner.styleData.clip ?? ""; }
	set clip(value) { this.#gate.check("dom"); const text = String(value); safeStyle("clip", text); this.#owner.styleData.clip = text; emitMutation(this.#owner, "style", { property: "clip", value: text }); }
	get color() { this.#gate.check("dom"); return this.#owner.styleData.color ?? ""; }
	set color(value) { this.#gate.check("dom"); const text = String(value); safeStyle("color", text); this.#owner.styleData.color = text; emitMutation(this.#owner, "style", { property: "color", value: text }); }
	get columnCount() { this.#gate.check("dom"); return this.#owner.styleData.columnCount ?? ""; }
	set columnCount(value) { this.#gate.check("dom"); const text = String(value); safeStyle("columnCount", text); this.#owner.styleData.columnCount = text; emitMutation(this.#owner, "style", { property: "columnCount", value: text }); }
	get columnGap() { this.#gate.check("dom"); return this.#owner.styleData.columnGap ?? ""; }
	set columnGap(value) { this.#gate.check("dom"); const text = String(value); safeStyle("columnGap", text); this.#owner.styleData.columnGap = text; emitMutation(this.#owner, "style", { property: "columnGap", value: text }); }
	get columnRule() { this.#gate.check("dom"); return this.#owner.styleData.columnRule ?? ""; }
	set columnRule(value) { this.#gate.check("dom"); const text = String(value); safeStyle("columnRule", text); this.#owner.styleData.columnRule = text; emitMutation(this.#owner, "style", { property: "columnRule", value: text }); }
	get columnRuleColor() { this.#gate.check("dom"); return this.#owner.styleData.columnRuleColor ?? ""; }
	set columnRuleColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("columnRuleColor", text); this.#owner.styleData.columnRuleColor = text; emitMutation(this.#owner, "style", { property: "columnRuleColor", value: text }); }
	get columnRuleStyle() { this.#gate.check("dom"); return this.#owner.styleData.columnRuleStyle ?? ""; }
	set columnRuleStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("columnRuleStyle", text); this.#owner.styleData.columnRuleStyle = text; emitMutation(this.#owner, "style", { property: "columnRuleStyle", value: text }); }
	get columnRuleWidth() { this.#gate.check("dom"); return this.#owner.styleData.columnRuleWidth ?? ""; }
	set columnRuleWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("columnRuleWidth", text); this.#owner.styleData.columnRuleWidth = text; emitMutation(this.#owner, "style", { property: "columnRuleWidth", value: text }); }
	get columnSpan() { this.#gate.check("dom"); return this.#owner.styleData.columnSpan ?? ""; }
	set columnSpan(value) { this.#gate.check("dom"); const text = String(value); safeStyle("columnSpan", text); this.#owner.styleData.columnSpan = text; emitMutation(this.#owner, "style", { property: "columnSpan", value: text }); }
	get columnWidth() { this.#gate.check("dom"); return this.#owner.styleData.columnWidth ?? ""; }
	set columnWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("columnWidth", text); this.#owner.styleData.columnWidth = text; emitMutation(this.#owner, "style", { property: "columnWidth", value: text }); }
	get columns() { this.#gate.check("dom"); return this.#owner.styleData.columns ?? ""; }
	set columns(value) { this.#gate.check("dom"); const text = String(value); safeStyle("columns", text); this.#owner.styleData.columns = text; emitMutation(this.#owner, "style", { property: "columns", value: text }); }
	get contain() { this.#gate.check("dom"); return this.#owner.styleData.contain ?? ""; }
	set contain(value) { this.#gate.check("dom"); const text = String(value); safeStyle("contain", text); this.#owner.styleData.contain = text; emitMutation(this.#owner, "style", { property: "contain", value: text }); }
	get containIntrinsicSize() { this.#gate.check("dom"); return this.#owner.styleData.containIntrinsicSize ?? ""; }
	set containIntrinsicSize(value) { this.#gate.check("dom"); const text = String(value); safeStyle("containIntrinsicSize", text); this.#owner.styleData.containIntrinsicSize = text; emitMutation(this.#owner, "style", { property: "containIntrinsicSize", value: text }); }
	get content() { this.#gate.check("dom"); return this.#owner.styleData.content ?? ""; }
	set content(value) { this.#gate.check("dom"); const text = String(value); safeStyle("content", text); this.#owner.styleData.content = text; emitMutation(this.#owner, "style", { property: "content", value: text }); }
	get cursor() { this.#gate.check("dom"); return this.#owner.styleData.cursor ?? ""; }
	set cursor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("cursor", text); this.#owner.styleData.cursor = text; emitMutation(this.#owner, "style", { property: "cursor", value: text }); }
	get direction() { this.#gate.check("dom"); return this.#owner.styleData.direction ?? ""; }
	set direction(value) { this.#gate.check("dom"); const text = String(value); safeStyle("direction", text); this.#owner.styleData.direction = text; emitMutation(this.#owner, "style", { property: "direction", value: text }); }
	get display() { this.#gate.check("dom"); return this.#owner.styleData.display ?? ""; }
	set display(value) { this.#gate.check("dom"); const text = String(value); safeStyle("display", text); this.#owner.styleData.display = text; emitMutation(this.#owner, "style", { property: "display", value: text }); }
	get emptyCells() { this.#gate.check("dom"); return this.#owner.styleData.emptyCells ?? ""; }
	set emptyCells(value) { this.#gate.check("dom"); const text = String(value); safeStyle("emptyCells", text); this.#owner.styleData.emptyCells = text; emitMutation(this.#owner, "style", { property: "emptyCells", value: text }); }
	get filter() { this.#gate.check("dom"); return this.#owner.styleData.filter ?? ""; }
	set filter(value) { this.#gate.check("dom"); const text = String(value); safeStyle("filter", text); this.#owner.styleData.filter = text; emitMutation(this.#owner, "style", { property: "filter", value: text }); }
	get flex() { this.#gate.check("dom"); return this.#owner.styleData.flex ?? ""; }
	set flex(value) { this.#gate.check("dom"); const text = String(value); safeStyle("flex", text); this.#owner.styleData.flex = text; emitMutation(this.#owner, "style", { property: "flex", value: text }); }
	get flexBasis() { this.#gate.check("dom"); return this.#owner.styleData.flexBasis ?? ""; }
	set flexBasis(value) { this.#gate.check("dom"); const text = String(value); safeStyle("flexBasis", text); this.#owner.styleData.flexBasis = text; emitMutation(this.#owner, "style", { property: "flexBasis", value: text }); }
	get flexDirection() { this.#gate.check("dom"); return this.#owner.styleData.flexDirection ?? ""; }
	set flexDirection(value) { this.#gate.check("dom"); const text = String(value); safeStyle("flexDirection", text); this.#owner.styleData.flexDirection = text; emitMutation(this.#owner, "style", { property: "flexDirection", value: text }); }
	get flexFlow() { this.#gate.check("dom"); return this.#owner.styleData.flexFlow ?? ""; }
	set flexFlow(value) { this.#gate.check("dom"); const text = String(value); safeStyle("flexFlow", text); this.#owner.styleData.flexFlow = text; emitMutation(this.#owner, "style", { property: "flexFlow", value: text }); }
	get flexGrow() { this.#gate.check("dom"); return this.#owner.styleData.flexGrow ?? ""; }
	set flexGrow(value) { this.#gate.check("dom"); const text = String(value); safeStyle("flexGrow", text); this.#owner.styleData.flexGrow = text; emitMutation(this.#owner, "style", { property: "flexGrow", value: text }); }
	get flexShrink() { this.#gate.check("dom"); return this.#owner.styleData.flexShrink ?? ""; }
	set flexShrink(value) { this.#gate.check("dom"); const text = String(value); safeStyle("flexShrink", text); this.#owner.styleData.flexShrink = text; emitMutation(this.#owner, "style", { property: "flexShrink", value: text }); }
	get flexWrap() { this.#gate.check("dom"); return this.#owner.styleData.flexWrap ?? ""; }
	set flexWrap(value) { this.#gate.check("dom"); const text = String(value); safeStyle("flexWrap", text); this.#owner.styleData.flexWrap = text; emitMutation(this.#owner, "style", { property: "flexWrap", value: text }); }
	get float() { this.#gate.check("dom"); return this.#owner.styleData.float ?? ""; }
	set float(value) { this.#gate.check("dom"); const text = String(value); safeStyle("float", text); this.#owner.styleData.float = text; emitMutation(this.#owner, "style", { property: "float", value: text }); }
	get font() { this.#gate.check("dom"); return this.#owner.styleData.font ?? ""; }
	set font(value) { this.#gate.check("dom"); const text = String(value); safeStyle("font", text); this.#owner.styleData.font = text; emitMutation(this.#owner, "style", { property: "font", value: text }); }
	get fontFamily() { this.#gate.check("dom"); return this.#owner.styleData.fontFamily ?? ""; }
	set fontFamily(value) { this.#gate.check("dom"); const text = String(value); safeStyle("fontFamily", text); this.#owner.styleData.fontFamily = text; emitMutation(this.#owner, "style", { property: "fontFamily", value: text }); }
	get fontFeatureSettings() { this.#gate.check("dom"); return this.#owner.styleData.fontFeatureSettings ?? ""; }
	set fontFeatureSettings(value) { this.#gate.check("dom"); const text = String(value); safeStyle("fontFeatureSettings", text); this.#owner.styleData.fontFeatureSettings = text; emitMutation(this.#owner, "style", { property: "fontFeatureSettings", value: text }); }
	get fontKerning() { this.#gate.check("dom"); return this.#owner.styleData.fontKerning ?? ""; }
	set fontKerning(value) { this.#gate.check("dom"); const text = String(value); safeStyle("fontKerning", text); this.#owner.styleData.fontKerning = text; emitMutation(this.#owner, "style", { property: "fontKerning", value: text }); }
	get fontOpticalSizing() { this.#gate.check("dom"); return this.#owner.styleData.fontOpticalSizing ?? ""; }
	set fontOpticalSizing(value) { this.#gate.check("dom"); const text = String(value); safeStyle("fontOpticalSizing", text); this.#owner.styleData.fontOpticalSizing = text; emitMutation(this.#owner, "style", { property: "fontOpticalSizing", value: text }); }
	get fontSize() { this.#gate.check("dom"); return this.#owner.styleData.fontSize ?? ""; }
	set fontSize(value) { this.#gate.check("dom"); const text = String(value); safeStyle("fontSize", text); this.#owner.styleData.fontSize = text; emitMutation(this.#owner, "style", { property: "fontSize", value: text }); }
	get fontSizeAdjust() { this.#gate.check("dom"); return this.#owner.styleData.fontSizeAdjust ?? ""; }
	set fontSizeAdjust(value) { this.#gate.check("dom"); const text = String(value); safeStyle("fontSizeAdjust", text); this.#owner.styleData.fontSizeAdjust = text; emitMutation(this.#owner, "style", { property: "fontSizeAdjust", value: text }); }
	get fontStretch() { this.#gate.check("dom"); return this.#owner.styleData.fontStretch ?? ""; }
	set fontStretch(value) { this.#gate.check("dom"); const text = String(value); safeStyle("fontStretch", text); this.#owner.styleData.fontStretch = text; emitMutation(this.#owner, "style", { property: "fontStretch", value: text }); }
	get fontStyle() { this.#gate.check("dom"); return this.#owner.styleData.fontStyle ?? ""; }
	set fontStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("fontStyle", text); this.#owner.styleData.fontStyle = text; emitMutation(this.#owner, "style", { property: "fontStyle", value: text }); }
	get fontSynthesis() { this.#gate.check("dom"); return this.#owner.styleData.fontSynthesis ?? ""; }
	set fontSynthesis(value) { this.#gate.check("dom"); const text = String(value); safeStyle("fontSynthesis", text); this.#owner.styleData.fontSynthesis = text; emitMutation(this.#owner, "style", { property: "fontSynthesis", value: text }); }
	get fontVariant() { this.#gate.check("dom"); return this.#owner.styleData.fontVariant ?? ""; }
	set fontVariant(value) { this.#gate.check("dom"); const text = String(value); safeStyle("fontVariant", text); this.#owner.styleData.fontVariant = text; emitMutation(this.#owner, "style", { property: "fontVariant", value: text }); }
	get fontWeight() { this.#gate.check("dom"); return this.#owner.styleData.fontWeight ?? ""; }
	set fontWeight(value) { this.#gate.check("dom"); const text = String(value); safeStyle("fontWeight", text); this.#owner.styleData.fontWeight = text; emitMutation(this.#owner, "style", { property: "fontWeight", value: text }); }
	get gap() { this.#gate.check("dom"); return this.#owner.styleData.gap ?? ""; }
	set gap(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gap", text); this.#owner.styleData.gap = text; emitMutation(this.#owner, "style", { property: "gap", value: text }); }
	get grid() { this.#gate.check("dom"); return this.#owner.styleData.grid ?? ""; }
	set grid(value) { this.#gate.check("dom"); const text = String(value); safeStyle("grid", text); this.#owner.styleData.grid = text; emitMutation(this.#owner, "style", { property: "grid", value: text }); }
	get gridArea() { this.#gate.check("dom"); return this.#owner.styleData.gridArea ?? ""; }
	set gridArea(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridArea", text); this.#owner.styleData.gridArea = text; emitMutation(this.#owner, "style", { property: "gridArea", value: text }); }
	get gridAutoColumns() { this.#gate.check("dom"); return this.#owner.styleData.gridAutoColumns ?? ""; }
	set gridAutoColumns(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridAutoColumns", text); this.#owner.styleData.gridAutoColumns = text; emitMutation(this.#owner, "style", { property: "gridAutoColumns", value: text }); }
	get gridAutoFlow() { this.#gate.check("dom"); return this.#owner.styleData.gridAutoFlow ?? ""; }
	set gridAutoFlow(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridAutoFlow", text); this.#owner.styleData.gridAutoFlow = text; emitMutation(this.#owner, "style", { property: "gridAutoFlow", value: text }); }
	get gridAutoRows() { this.#gate.check("dom"); return this.#owner.styleData.gridAutoRows ?? ""; }
	set gridAutoRows(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridAutoRows", text); this.#owner.styleData.gridAutoRows = text; emitMutation(this.#owner, "style", { property: "gridAutoRows", value: text }); }
	get gridColumn() { this.#gate.check("dom"); return this.#owner.styleData.gridColumn ?? ""; }
	set gridColumn(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridColumn", text); this.#owner.styleData.gridColumn = text; emitMutation(this.#owner, "style", { property: "gridColumn", value: text }); }
	get gridColumnEnd() { this.#gate.check("dom"); return this.#owner.styleData.gridColumnEnd ?? ""; }
	set gridColumnEnd(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridColumnEnd", text); this.#owner.styleData.gridColumnEnd = text; emitMutation(this.#owner, "style", { property: "gridColumnEnd", value: text }); }
	get gridColumnGap() { this.#gate.check("dom"); return this.#owner.styleData.gridColumnGap ?? ""; }
	set gridColumnGap(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridColumnGap", text); this.#owner.styleData.gridColumnGap = text; emitMutation(this.#owner, "style", { property: "gridColumnGap", value: text }); }
	get gridColumnStart() { this.#gate.check("dom"); return this.#owner.styleData.gridColumnStart ?? ""; }
	set gridColumnStart(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridColumnStart", text); this.#owner.styleData.gridColumnStart = text; emitMutation(this.#owner, "style", { property: "gridColumnStart", value: text }); }
	get gridRow() { this.#gate.check("dom"); return this.#owner.styleData.gridRow ?? ""; }
	set gridRow(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridRow", text); this.#owner.styleData.gridRow = text; emitMutation(this.#owner, "style", { property: "gridRow", value: text }); }
	get gridRowEnd() { this.#gate.check("dom"); return this.#owner.styleData.gridRowEnd ?? ""; }
	set gridRowEnd(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridRowEnd", text); this.#owner.styleData.gridRowEnd = text; emitMutation(this.#owner, "style", { property: "gridRowEnd", value: text }); }
	get gridRowGap() { this.#gate.check("dom"); return this.#owner.styleData.gridRowGap ?? ""; }
	set gridRowGap(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridRowGap", text); this.#owner.styleData.gridRowGap = text; emitMutation(this.#owner, "style", { property: "gridRowGap", value: text }); }
	get gridRowStart() { this.#gate.check("dom"); return this.#owner.styleData.gridRowStart ?? ""; }
	set gridRowStart(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridRowStart", text); this.#owner.styleData.gridRowStart = text; emitMutation(this.#owner, "style", { property: "gridRowStart", value: text }); }
	get gridTemplate() { this.#gate.check("dom"); return this.#owner.styleData.gridTemplate ?? ""; }
	set gridTemplate(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridTemplate", text); this.#owner.styleData.gridTemplate = text; emitMutation(this.#owner, "style", { property: "gridTemplate", value: text }); }
	get gridTemplateAreas() { this.#gate.check("dom"); return this.#owner.styleData.gridTemplateAreas ?? ""; }
	set gridTemplateAreas(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridTemplateAreas", text); this.#owner.styleData.gridTemplateAreas = text; emitMutation(this.#owner, "style", { property: "gridTemplateAreas", value: text }); }
	get gridTemplateColumns() { this.#gate.check("dom"); return this.#owner.styleData.gridTemplateColumns ?? ""; }
	set gridTemplateColumns(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridTemplateColumns", text); this.#owner.styleData.gridTemplateColumns = text; emitMutation(this.#owner, "style", { property: "gridTemplateColumns", value: text }); }
	get gridTemplateRows() { this.#gate.check("dom"); return this.#owner.styleData.gridTemplateRows ?? ""; }
	set gridTemplateRows(value) { this.#gate.check("dom"); const text = String(value); safeStyle("gridTemplateRows", text); this.#owner.styleData.gridTemplateRows = text; emitMutation(this.#owner, "style", { property: "gridTemplateRows", value: text }); }
	get height() { this.#gate.check("dom"); return this.#owner.styleData.height ?? ""; }
	set height(value) { this.#gate.check("dom"); const text = String(value); safeStyle("height", text); this.#owner.styleData.height = text; emitMutation(this.#owner, "style", { property: "height", value: text }); }
	get hyphens() { this.#gate.check("dom"); return this.#owner.styleData.hyphens ?? ""; }
	set hyphens(value) { this.#gate.check("dom"); const text = String(value); safeStyle("hyphens", text); this.#owner.styleData.hyphens = text; emitMutation(this.#owner, "style", { property: "hyphens", value: text }); }
	get imageRendering() { this.#gate.check("dom"); return this.#owner.styleData.imageRendering ?? ""; }
	set imageRendering(value) { this.#gate.check("dom"); const text = String(value); safeStyle("imageRendering", text); this.#owner.styleData.imageRendering = text; emitMutation(this.#owner, "style", { property: "imageRendering", value: text }); }
	get inlineSize() { this.#gate.check("dom"); return this.#owner.styleData.inlineSize ?? ""; }
	set inlineSize(value) { this.#gate.check("dom"); const text = String(value); safeStyle("inlineSize", text); this.#owner.styleData.inlineSize = text; emitMutation(this.#owner, "style", { property: "inlineSize", value: text }); }
	get inset() { this.#gate.check("dom"); return this.#owner.styleData.inset ?? ""; }
	set inset(value) { this.#gate.check("dom"); const text = String(value); safeStyle("inset", text); this.#owner.styleData.inset = text; emitMutation(this.#owner, "style", { property: "inset", value: text }); }
	get insetBlock() { this.#gate.check("dom"); return this.#owner.styleData.insetBlock ?? ""; }
	set insetBlock(value) { this.#gate.check("dom"); const text = String(value); safeStyle("insetBlock", text); this.#owner.styleData.insetBlock = text; emitMutation(this.#owner, "style", { property: "insetBlock", value: text }); }
	get insetBlockEnd() { this.#gate.check("dom"); return this.#owner.styleData.insetBlockEnd ?? ""; }
	set insetBlockEnd(value) { this.#gate.check("dom"); const text = String(value); safeStyle("insetBlockEnd", text); this.#owner.styleData.insetBlockEnd = text; emitMutation(this.#owner, "style", { property: "insetBlockEnd", value: text }); }
	get insetBlockStart() { this.#gate.check("dom"); return this.#owner.styleData.insetBlockStart ?? ""; }
	set insetBlockStart(value) { this.#gate.check("dom"); const text = String(value); safeStyle("insetBlockStart", text); this.#owner.styleData.insetBlockStart = text; emitMutation(this.#owner, "style", { property: "insetBlockStart", value: text }); }
	get insetInline() { this.#gate.check("dom"); return this.#owner.styleData.insetInline ?? ""; }
	set insetInline(value) { this.#gate.check("dom"); const text = String(value); safeStyle("insetInline", text); this.#owner.styleData.insetInline = text; emitMutation(this.#owner, "style", { property: "insetInline", value: text }); }
	get insetInlineEnd() { this.#gate.check("dom"); return this.#owner.styleData.insetInlineEnd ?? ""; }
	set insetInlineEnd(value) { this.#gate.check("dom"); const text = String(value); safeStyle("insetInlineEnd", text); this.#owner.styleData.insetInlineEnd = text; emitMutation(this.#owner, "style", { property: "insetInlineEnd", value: text }); }
	get insetInlineStart() { this.#gate.check("dom"); return this.#owner.styleData.insetInlineStart ?? ""; }
	set insetInlineStart(value) { this.#gate.check("dom"); const text = String(value); safeStyle("insetInlineStart", text); this.#owner.styleData.insetInlineStart = text; emitMutation(this.#owner, "style", { property: "insetInlineStart", value: text }); }
	get isolation() { this.#gate.check("dom"); return this.#owner.styleData.isolation ?? ""; }
	set isolation(value) { this.#gate.check("dom"); const text = String(value); safeStyle("isolation", text); this.#owner.styleData.isolation = text; emitMutation(this.#owner, "style", { property: "isolation", value: text }); }
	get justifyContent() { this.#gate.check("dom"); return this.#owner.styleData.justifyContent ?? ""; }
	set justifyContent(value) { this.#gate.check("dom"); const text = String(value); safeStyle("justifyContent", text); this.#owner.styleData.justifyContent = text; emitMutation(this.#owner, "style", { property: "justifyContent", value: text }); }
	get justifyItems() { this.#gate.check("dom"); return this.#owner.styleData.justifyItems ?? ""; }
	set justifyItems(value) { this.#gate.check("dom"); const text = String(value); safeStyle("justifyItems", text); this.#owner.styleData.justifyItems = text; emitMutation(this.#owner, "style", { property: "justifyItems", value: text }); }
	get justifySelf() { this.#gate.check("dom"); return this.#owner.styleData.justifySelf ?? ""; }
	set justifySelf(value) { this.#gate.check("dom"); const text = String(value); safeStyle("justifySelf", text); this.#owner.styleData.justifySelf = text; emitMutation(this.#owner, "style", { property: "justifySelf", value: text }); }
	get left() { this.#gate.check("dom"); return this.#owner.styleData.left ?? ""; }
	set left(value) { this.#gate.check("dom"); const text = String(value); safeStyle("left", text); this.#owner.styleData.left = text; emitMutation(this.#owner, "style", { property: "left", value: text }); }
	get letterSpacing() { this.#gate.check("dom"); return this.#owner.styleData.letterSpacing ?? ""; }
	set letterSpacing(value) { this.#gate.check("dom"); const text = String(value); safeStyle("letterSpacing", text); this.#owner.styleData.letterSpacing = text; emitMutation(this.#owner, "style", { property: "letterSpacing", value: text }); }
	get lineBreak() { this.#gate.check("dom"); return this.#owner.styleData.lineBreak ?? ""; }
	set lineBreak(value) { this.#gate.check("dom"); const text = String(value); safeStyle("lineBreak", text); this.#owner.styleData.lineBreak = text; emitMutation(this.#owner, "style", { property: "lineBreak", value: text }); }
	get lineHeight() { this.#gate.check("dom"); return this.#owner.styleData.lineHeight ?? ""; }
	set lineHeight(value) { this.#gate.check("dom"); const text = String(value); safeStyle("lineHeight", text); this.#owner.styleData.lineHeight = text; emitMutation(this.#owner, "style", { property: "lineHeight", value: text }); }
	get listStyle() { this.#gate.check("dom"); return this.#owner.styleData.listStyle ?? ""; }
	set listStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("listStyle", text); this.#owner.styleData.listStyle = text; emitMutation(this.#owner, "style", { property: "listStyle", value: text }); }
	get listStyleImage() { this.#gate.check("dom"); return this.#owner.styleData.listStyleImage ?? ""; }
	set listStyleImage(value) { this.#gate.check("dom"); const text = String(value); safeStyle("listStyleImage", text); this.#owner.styleData.listStyleImage = text; emitMutation(this.#owner, "style", { property: "listStyleImage", value: text }); }
	get listStylePosition() { this.#gate.check("dom"); return this.#owner.styleData.listStylePosition ?? ""; }
	set listStylePosition(value) { this.#gate.check("dom"); const text = String(value); safeStyle("listStylePosition", text); this.#owner.styleData.listStylePosition = text; emitMutation(this.#owner, "style", { property: "listStylePosition", value: text }); }
	get listStyleType() { this.#gate.check("dom"); return this.#owner.styleData.listStyleType ?? ""; }
	set listStyleType(value) { this.#gate.check("dom"); const text = String(value); safeStyle("listStyleType", text); this.#owner.styleData.listStyleType = text; emitMutation(this.#owner, "style", { property: "listStyleType", value: text }); }
	get margin() { this.#gate.check("dom"); return this.#owner.styleData.margin ?? ""; }
	set margin(value) { this.#gate.check("dom"); const text = String(value); safeStyle("margin", text); this.#owner.styleData.margin = text; emitMutation(this.#owner, "style", { property: "margin", value: text }); }
	get marginBlock() { this.#gate.check("dom"); return this.#owner.styleData.marginBlock ?? ""; }
	set marginBlock(value) { this.#gate.check("dom"); const text = String(value); safeStyle("marginBlock", text); this.#owner.styleData.marginBlock = text; emitMutation(this.#owner, "style", { property: "marginBlock", value: text }); }
	get marginBlockEnd() { this.#gate.check("dom"); return this.#owner.styleData.marginBlockEnd ?? ""; }
	set marginBlockEnd(value) { this.#gate.check("dom"); const text = String(value); safeStyle("marginBlockEnd", text); this.#owner.styleData.marginBlockEnd = text; emitMutation(this.#owner, "style", { property: "marginBlockEnd", value: text }); }
	get marginBlockStart() { this.#gate.check("dom"); return this.#owner.styleData.marginBlockStart ?? ""; }
	set marginBlockStart(value) { this.#gate.check("dom"); const text = String(value); safeStyle("marginBlockStart", text); this.#owner.styleData.marginBlockStart = text; emitMutation(this.#owner, "style", { property: "marginBlockStart", value: text }); }
	get marginBottom() { this.#gate.check("dom"); return this.#owner.styleData.marginBottom ?? ""; }
	set marginBottom(value) { this.#gate.check("dom"); const text = String(value); safeStyle("marginBottom", text); this.#owner.styleData.marginBottom = text; emitMutation(this.#owner, "style", { property: "marginBottom", value: text }); }
	get marginInline() { this.#gate.check("dom"); return this.#owner.styleData.marginInline ?? ""; }
	set marginInline(value) { this.#gate.check("dom"); const text = String(value); safeStyle("marginInline", text); this.#owner.styleData.marginInline = text; emitMutation(this.#owner, "style", { property: "marginInline", value: text }); }
	get marginInlineEnd() { this.#gate.check("dom"); return this.#owner.styleData.marginInlineEnd ?? ""; }
	set marginInlineEnd(value) { this.#gate.check("dom"); const text = String(value); safeStyle("marginInlineEnd", text); this.#owner.styleData.marginInlineEnd = text; emitMutation(this.#owner, "style", { property: "marginInlineEnd", value: text }); }
	get marginInlineStart() { this.#gate.check("dom"); return this.#owner.styleData.marginInlineStart ?? ""; }
	set marginInlineStart(value) { this.#gate.check("dom"); const text = String(value); safeStyle("marginInlineStart", text); this.#owner.styleData.marginInlineStart = text; emitMutation(this.#owner, "style", { property: "marginInlineStart", value: text }); }
	get marginLeft() { this.#gate.check("dom"); return this.#owner.styleData.marginLeft ?? ""; }
	set marginLeft(value) { this.#gate.check("dom"); const text = String(value); safeStyle("marginLeft", text); this.#owner.styleData.marginLeft = text; emitMutation(this.#owner, "style", { property: "marginLeft", value: text }); }
	get marginRight() { this.#gate.check("dom"); return this.#owner.styleData.marginRight ?? ""; }
	set marginRight(value) { this.#gate.check("dom"); const text = String(value); safeStyle("marginRight", text); this.#owner.styleData.marginRight = text; emitMutation(this.#owner, "style", { property: "marginRight", value: text }); }
	get marginTop() { this.#gate.check("dom"); return this.#owner.styleData.marginTop ?? ""; }
	set marginTop(value) { this.#gate.check("dom"); const text = String(value); safeStyle("marginTop", text); this.#owner.styleData.marginTop = text; emitMutation(this.#owner, "style", { property: "marginTop", value: text }); }
	get marginTrim() { this.#gate.check("dom"); return this.#owner.styleData.marginTrim ?? ""; }
	set marginTrim(value) { this.#gate.check("dom"); const text = String(value); safeStyle("marginTrim", text); this.#owner.styleData.marginTrim = text; emitMutation(this.#owner, "style", { property: "marginTrim", value: text }); }
	get mask() { this.#gate.check("dom"); return this.#owner.styleData.mask ?? ""; }
	set mask(value) { this.#gate.check("dom"); const text = String(value); safeStyle("mask", text); this.#owner.styleData.mask = text; emitMutation(this.#owner, "style", { property: "mask", value: text }); }
	get maxBlockSize() { this.#gate.check("dom"); return this.#owner.styleData.maxBlockSize ?? ""; }
	set maxBlockSize(value) { this.#gate.check("dom"); const text = String(value); safeStyle("maxBlockSize", text); this.#owner.styleData.maxBlockSize = text; emitMutation(this.#owner, "style", { property: "maxBlockSize", value: text }); }
	get maxHeight() { this.#gate.check("dom"); return this.#owner.styleData.maxHeight ?? ""; }
	set maxHeight(value) { this.#gate.check("dom"); const text = String(value); safeStyle("maxHeight", text); this.#owner.styleData.maxHeight = text; emitMutation(this.#owner, "style", { property: "maxHeight", value: text }); }
	get maxInlineSize() { this.#gate.check("dom"); return this.#owner.styleData.maxInlineSize ?? ""; }
	set maxInlineSize(value) { this.#gate.check("dom"); const text = String(value); safeStyle("maxInlineSize", text); this.#owner.styleData.maxInlineSize = text; emitMutation(this.#owner, "style", { property: "maxInlineSize", value: text }); }
	get maxWidth() { this.#gate.check("dom"); return this.#owner.styleData.maxWidth ?? ""; }
	set maxWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("maxWidth", text); this.#owner.styleData.maxWidth = text; emitMutation(this.#owner, "style", { property: "maxWidth", value: text }); }
	get minBlockSize() { this.#gate.check("dom"); return this.#owner.styleData.minBlockSize ?? ""; }
	set minBlockSize(value) { this.#gate.check("dom"); const text = String(value); safeStyle("minBlockSize", text); this.#owner.styleData.minBlockSize = text; emitMutation(this.#owner, "style", { property: "minBlockSize", value: text }); }
	get minHeight() { this.#gate.check("dom"); return this.#owner.styleData.minHeight ?? ""; }
	set minHeight(value) { this.#gate.check("dom"); const text = String(value); safeStyle("minHeight", text); this.#owner.styleData.minHeight = text; emitMutation(this.#owner, "style", { property: "minHeight", value: text }); }
	get minInlineSize() { this.#gate.check("dom"); return this.#owner.styleData.minInlineSize ?? ""; }
	set minInlineSize(value) { this.#gate.check("dom"); const text = String(value); safeStyle("minInlineSize", text); this.#owner.styleData.minInlineSize = text; emitMutation(this.#owner, "style", { property: "minInlineSize", value: text }); }
	get minWidth() { this.#gate.check("dom"); return this.#owner.styleData.minWidth ?? ""; }
	set minWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("minWidth", text); this.#owner.styleData.minWidth = text; emitMutation(this.#owner, "style", { property: "minWidth", value: text }); }
	get objectFit() { this.#gate.check("dom"); return this.#owner.styleData.objectFit ?? ""; }
	set objectFit(value) { this.#gate.check("dom"); const text = String(value); safeStyle("objectFit", text); this.#owner.styleData.objectFit = text; emitMutation(this.#owner, "style", { property: "objectFit", value: text }); }
	get objectPosition() { this.#gate.check("dom"); return this.#owner.styleData.objectPosition ?? ""; }
	set objectPosition(value) { this.#gate.check("dom"); const text = String(value); safeStyle("objectPosition", text); this.#owner.styleData.objectPosition = text; emitMutation(this.#owner, "style", { property: "objectPosition", value: text }); }
	get opacity() { this.#gate.check("dom"); return this.#owner.styleData.opacity ?? ""; }
	set opacity(value) { this.#gate.check("dom"); const text = String(value); safeStyle("opacity", text); this.#owner.styleData.opacity = text; emitMutation(this.#owner, "style", { property: "opacity", value: text }); }
	get order() { this.#gate.check("dom"); return this.#owner.styleData.order ?? ""; }
	set order(value) { this.#gate.check("dom"); const text = String(value); safeStyle("order", text); this.#owner.styleData.order = text; emitMutation(this.#owner, "style", { property: "order", value: text }); }
	get outline() { this.#gate.check("dom"); return this.#owner.styleData.outline ?? ""; }
	set outline(value) { this.#gate.check("dom"); const text = String(value); safeStyle("outline", text); this.#owner.styleData.outline = text; emitMutation(this.#owner, "style", { property: "outline", value: text }); }
	get outlineColor() { this.#gate.check("dom"); return this.#owner.styleData.outlineColor ?? ""; }
	set outlineColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("outlineColor", text); this.#owner.styleData.outlineColor = text; emitMutation(this.#owner, "style", { property: "outlineColor", value: text }); }
	get outlineOffset() { this.#gate.check("dom"); return this.#owner.styleData.outlineOffset ?? ""; }
	set outlineOffset(value) { this.#gate.check("dom"); const text = String(value); safeStyle("outlineOffset", text); this.#owner.styleData.outlineOffset = text; emitMutation(this.#owner, "style", { property: "outlineOffset", value: text }); }
	get outlineStyle() { this.#gate.check("dom"); return this.#owner.styleData.outlineStyle ?? ""; }
	set outlineStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("outlineStyle", text); this.#owner.styleData.outlineStyle = text; emitMutation(this.#owner, "style", { property: "outlineStyle", value: text }); }
	get outlineWidth() { this.#gate.check("dom"); return this.#owner.styleData.outlineWidth ?? ""; }
	set outlineWidth(value) { this.#gate.check("dom"); const text = String(value); safeStyle("outlineWidth", text); this.#owner.styleData.outlineWidth = text; emitMutation(this.#owner, "style", { property: "outlineWidth", value: text }); }
	get overflow() { this.#gate.check("dom"); return this.#owner.styleData.overflow ?? ""; }
	set overflow(value) { this.#gate.check("dom"); const text = String(value); safeStyle("overflow", text); this.#owner.styleData.overflow = text; emitMutation(this.#owner, "style", { property: "overflow", value: text }); }
	get overflowAnchor() { this.#gate.check("dom"); return this.#owner.styleData.overflowAnchor ?? ""; }
	set overflowAnchor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("overflowAnchor", text); this.#owner.styleData.overflowAnchor = text; emitMutation(this.#owner, "style", { property: "overflowAnchor", value: text }); }
	get overflowWrap() { this.#gate.check("dom"); return this.#owner.styleData.overflowWrap ?? ""; }
	set overflowWrap(value) { this.#gate.check("dom"); const text = String(value); safeStyle("overflowWrap", text); this.#owner.styleData.overflowWrap = text; emitMutation(this.#owner, "style", { property: "overflowWrap", value: text }); }
	get overflowX() { this.#gate.check("dom"); return this.#owner.styleData.overflowX ?? ""; }
	set overflowX(value) { this.#gate.check("dom"); const text = String(value); safeStyle("overflowX", text); this.#owner.styleData.overflowX = text; emitMutation(this.#owner, "style", { property: "overflowX", value: text }); }
	get overflowY() { this.#gate.check("dom"); return this.#owner.styleData.overflowY ?? ""; }
	set overflowY(value) { this.#gate.check("dom"); const text = String(value); safeStyle("overflowY", text); this.#owner.styleData.overflowY = text; emitMutation(this.#owner, "style", { property: "overflowY", value: text }); }
	get overscrollBehavior() { this.#gate.check("dom"); return this.#owner.styleData.overscrollBehavior ?? ""; }
	set overscrollBehavior(value) { this.#gate.check("dom"); const text = String(value); safeStyle("overscrollBehavior", text); this.#owner.styleData.overscrollBehavior = text; emitMutation(this.#owner, "style", { property: "overscrollBehavior", value: text }); }
	get overscrollBehaviorBlock() { this.#gate.check("dom"); return this.#owner.styleData.overscrollBehaviorBlock ?? ""; }
	set overscrollBehaviorBlock(value) { this.#gate.check("dom"); const text = String(value); safeStyle("overscrollBehaviorBlock", text); this.#owner.styleData.overscrollBehaviorBlock = text; emitMutation(this.#owner, "style", { property: "overscrollBehaviorBlock", value: text }); }
	get overscrollBehaviorInline() { this.#gate.check("dom"); return this.#owner.styleData.overscrollBehaviorInline ?? ""; }
	set overscrollBehaviorInline(value) { this.#gate.check("dom"); const text = String(value); safeStyle("overscrollBehaviorInline", text); this.#owner.styleData.overscrollBehaviorInline = text; emitMutation(this.#owner, "style", { property: "overscrollBehaviorInline", value: text }); }
	get overscrollBehaviorX() { this.#gate.check("dom"); return this.#owner.styleData.overscrollBehaviorX ?? ""; }
	set overscrollBehaviorX(value) { this.#gate.check("dom"); const text = String(value); safeStyle("overscrollBehaviorX", text); this.#owner.styleData.overscrollBehaviorX = text; emitMutation(this.#owner, "style", { property: "overscrollBehaviorX", value: text }); }
	get overscrollBehaviorY() { this.#gate.check("dom"); return this.#owner.styleData.overscrollBehaviorY ?? ""; }
	set overscrollBehaviorY(value) { this.#gate.check("dom"); const text = String(value); safeStyle("overscrollBehaviorY", text); this.#owner.styleData.overscrollBehaviorY = text; emitMutation(this.#owner, "style", { property: "overscrollBehaviorY", value: text }); }
	get padding() { this.#gate.check("dom"); return this.#owner.styleData.padding ?? ""; }
	set padding(value) { this.#gate.check("dom"); const text = String(value); safeStyle("padding", text); this.#owner.styleData.padding = text; emitMutation(this.#owner, "style", { property: "padding", value: text }); }
	get paddingBlock() { this.#gate.check("dom"); return this.#owner.styleData.paddingBlock ?? ""; }
	set paddingBlock(value) { this.#gate.check("dom"); const text = String(value); safeStyle("paddingBlock", text); this.#owner.styleData.paddingBlock = text; emitMutation(this.#owner, "style", { property: "paddingBlock", value: text }); }
	get paddingBlockEnd() { this.#gate.check("dom"); return this.#owner.styleData.paddingBlockEnd ?? ""; }
	set paddingBlockEnd(value) { this.#gate.check("dom"); const text = String(value); safeStyle("paddingBlockEnd", text); this.#owner.styleData.paddingBlockEnd = text; emitMutation(this.#owner, "style", { property: "paddingBlockEnd", value: text }); }
	get paddingBlockStart() { this.#gate.check("dom"); return this.#owner.styleData.paddingBlockStart ?? ""; }
	set paddingBlockStart(value) { this.#gate.check("dom"); const text = String(value); safeStyle("paddingBlockStart", text); this.#owner.styleData.paddingBlockStart = text; emitMutation(this.#owner, "style", { property: "paddingBlockStart", value: text }); }
	get paddingBottom() { this.#gate.check("dom"); return this.#owner.styleData.paddingBottom ?? ""; }
	set paddingBottom(value) { this.#gate.check("dom"); const text = String(value); safeStyle("paddingBottom", text); this.#owner.styleData.paddingBottom = text; emitMutation(this.#owner, "style", { property: "paddingBottom", value: text }); }
	get paddingInline() { this.#gate.check("dom"); return this.#owner.styleData.paddingInline ?? ""; }
	set paddingInline(value) { this.#gate.check("dom"); const text = String(value); safeStyle("paddingInline", text); this.#owner.styleData.paddingInline = text; emitMutation(this.#owner, "style", { property: "paddingInline", value: text }); }
	get paddingInlineEnd() { this.#gate.check("dom"); return this.#owner.styleData.paddingInlineEnd ?? ""; }
	set paddingInlineEnd(value) { this.#gate.check("dom"); const text = String(value); safeStyle("paddingInlineEnd", text); this.#owner.styleData.paddingInlineEnd = text; emitMutation(this.#owner, "style", { property: "paddingInlineEnd", value: text }); }
	get paddingInlineStart() { this.#gate.check("dom"); return this.#owner.styleData.paddingInlineStart ?? ""; }
	set paddingInlineStart(value) { this.#gate.check("dom"); const text = String(value); safeStyle("paddingInlineStart", text); this.#owner.styleData.paddingInlineStart = text; emitMutation(this.#owner, "style", { property: "paddingInlineStart", value: text }); }
	get paddingLeft() { this.#gate.check("dom"); return this.#owner.styleData.paddingLeft ?? ""; }
	set paddingLeft(value) { this.#gate.check("dom"); const text = String(value); safeStyle("paddingLeft", text); this.#owner.styleData.paddingLeft = text; emitMutation(this.#owner, "style", { property: "paddingLeft", value: text }); }
	get paddingRight() { this.#gate.check("dom"); return this.#owner.styleData.paddingRight ?? ""; }
	set paddingRight(value) { this.#gate.check("dom"); const text = String(value); safeStyle("paddingRight", text); this.#owner.styleData.paddingRight = text; emitMutation(this.#owner, "style", { property: "paddingRight", value: text }); }
	get paddingTop() { this.#gate.check("dom"); return this.#owner.styleData.paddingTop ?? ""; }
	set paddingTop(value) { this.#gate.check("dom"); const text = String(value); safeStyle("paddingTop", text); this.#owner.styleData.paddingTop = text; emitMutation(this.#owner, "style", { property: "paddingTop", value: text }); }
	get pageBreakAfter() { this.#gate.check("dom"); return this.#owner.styleData.pageBreakAfter ?? ""; }
	set pageBreakAfter(value) { this.#gate.check("dom"); const text = String(value); safeStyle("pageBreakAfter", text); this.#owner.styleData.pageBreakAfter = text; emitMutation(this.#owner, "style", { property: "pageBreakAfter", value: text }); }
	get pageBreakBefore() { this.#gate.check("dom"); return this.#owner.styleData.pageBreakBefore ?? ""; }
	set pageBreakBefore(value) { this.#gate.check("dom"); const text = String(value); safeStyle("pageBreakBefore", text); this.#owner.styleData.pageBreakBefore = text; emitMutation(this.#owner, "style", { property: "pageBreakBefore", value: text }); }
	get pageBreakInside() { this.#gate.check("dom"); return this.#owner.styleData.pageBreakInside ?? ""; }
	set pageBreakInside(value) { this.#gate.check("dom"); const text = String(value); safeStyle("pageBreakInside", text); this.#owner.styleData.pageBreakInside = text; emitMutation(this.#owner, "style", { property: "pageBreakInside", value: text }); }
	get perspective() { this.#gate.check("dom"); return this.#owner.styleData.perspective ?? ""; }
	set perspective(value) { this.#gate.check("dom"); const text = String(value); safeStyle("perspective", text); this.#owner.styleData.perspective = text; emitMutation(this.#owner, "style", { property: "perspective", value: text }); }
	get perspectiveOrigin() { this.#gate.check("dom"); return this.#owner.styleData.perspectiveOrigin ?? ""; }
	set perspectiveOrigin(value) { this.#gate.check("dom"); const text = String(value); safeStyle("perspectiveOrigin", text); this.#owner.styleData.perspectiveOrigin = text; emitMutation(this.#owner, "style", { property: "perspectiveOrigin", value: text }); }
	get placeContent() { this.#gate.check("dom"); return this.#owner.styleData.placeContent ?? ""; }
	set placeContent(value) { this.#gate.check("dom"); const text = String(value); safeStyle("placeContent", text); this.#owner.styleData.placeContent = text; emitMutation(this.#owner, "style", { property: "placeContent", value: text }); }
	get placeItems() { this.#gate.check("dom"); return this.#owner.styleData.placeItems ?? ""; }
	set placeItems(value) { this.#gate.check("dom"); const text = String(value); safeStyle("placeItems", text); this.#owner.styleData.placeItems = text; emitMutation(this.#owner, "style", { property: "placeItems", value: text }); }
	get placeSelf() { this.#gate.check("dom"); return this.#owner.styleData.placeSelf ?? ""; }
	set placeSelf(value) { this.#gate.check("dom"); const text = String(value); safeStyle("placeSelf", text); this.#owner.styleData.placeSelf = text; emitMutation(this.#owner, "style", { property: "placeSelf", value: text }); }
	get pointerEvents() { this.#gate.check("dom"); return this.#owner.styleData.pointerEvents ?? ""; }
	set pointerEvents(value) { this.#gate.check("dom"); const text = String(value); safeStyle("pointerEvents", text); this.#owner.styleData.pointerEvents = text; emitMutation(this.#owner, "style", { property: "pointerEvents", value: text }); }
	get position() { this.#gate.check("dom"); return this.#owner.styleData.position ?? ""; }
	set position(value) { this.#gate.check("dom"); const text = String(value); safeStyle("position", text); this.#owner.styleData.position = text; emitMutation(this.#owner, "style", { property: "position", value: text }); }
	get quotes() { this.#gate.check("dom"); return this.#owner.styleData.quotes ?? ""; }
	set quotes(value) { this.#gate.check("dom"); const text = String(value); safeStyle("quotes", text); this.#owner.styleData.quotes = text; emitMutation(this.#owner, "style", { property: "quotes", value: text }); }
	get resize() { this.#gate.check("dom"); return this.#owner.styleData.resize ?? ""; }
	set resize(value) { this.#gate.check("dom"); const text = String(value); safeStyle("resize", text); this.#owner.styleData.resize = text; emitMutation(this.#owner, "style", { property: "resize", value: text }); }
	get right() { this.#gate.check("dom"); return this.#owner.styleData.right ?? ""; }
	set right(value) { this.#gate.check("dom"); const text = String(value); safeStyle("right", text); this.#owner.styleData.right = text; emitMutation(this.#owner, "style", { property: "right", value: text }); }
	get rotate() { this.#gate.check("dom"); return this.#owner.styleData.rotate ?? ""; }
	set rotate(value) { this.#gate.check("dom"); const text = String(value); safeStyle("rotate", text); this.#owner.styleData.rotate = text; emitMutation(this.#owner, "style", { property: "rotate", value: text }); }
	get rowGap() { this.#gate.check("dom"); return this.#owner.styleData.rowGap ?? ""; }
	set rowGap(value) { this.#gate.check("dom"); const text = String(value); safeStyle("rowGap", text); this.#owner.styleData.rowGap = text; emitMutation(this.#owner, "style", { property: "rowGap", value: text }); }
	get scale() { this.#gate.check("dom"); return this.#owner.styleData.scale ?? ""; }
	set scale(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scale", text); this.#owner.styleData.scale = text; emitMutation(this.#owner, "style", { property: "scale", value: text }); }
	get scrollBehavior() { this.#gate.check("dom"); return this.#owner.styleData.scrollBehavior ?? ""; }
	set scrollBehavior(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollBehavior", text); this.#owner.styleData.scrollBehavior = text; emitMutation(this.#owner, "style", { property: "scrollBehavior", value: text }); }
	get scrollMargin() { this.#gate.check("dom"); return this.#owner.styleData.scrollMargin ?? ""; }
	set scrollMargin(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollMargin", text); this.#owner.styleData.scrollMargin = text; emitMutation(this.#owner, "style", { property: "scrollMargin", value: text }); }
	get scrollMarginBlock() { this.#gate.check("dom"); return this.#owner.styleData.scrollMarginBlock ?? ""; }
	set scrollMarginBlock(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollMarginBlock", text); this.#owner.styleData.scrollMarginBlock = text; emitMutation(this.#owner, "style", { property: "scrollMarginBlock", value: text }); }
	get scrollMarginBlockEnd() { this.#gate.check("dom"); return this.#owner.styleData.scrollMarginBlockEnd ?? ""; }
	set scrollMarginBlockEnd(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollMarginBlockEnd", text); this.#owner.styleData.scrollMarginBlockEnd = text; emitMutation(this.#owner, "style", { property: "scrollMarginBlockEnd", value: text }); }
	get scrollMarginBlockStart() { this.#gate.check("dom"); return this.#owner.styleData.scrollMarginBlockStart ?? ""; }
	set scrollMarginBlockStart(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollMarginBlockStart", text); this.#owner.styleData.scrollMarginBlockStart = text; emitMutation(this.#owner, "style", { property: "scrollMarginBlockStart", value: text }); }
	get scrollMarginBottom() { this.#gate.check("dom"); return this.#owner.styleData.scrollMarginBottom ?? ""; }
	set scrollMarginBottom(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollMarginBottom", text); this.#owner.styleData.scrollMarginBottom = text; emitMutation(this.#owner, "style", { property: "scrollMarginBottom", value: text }); }
	get scrollMarginInline() { this.#gate.check("dom"); return this.#owner.styleData.scrollMarginInline ?? ""; }
	set scrollMarginInline(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollMarginInline", text); this.#owner.styleData.scrollMarginInline = text; emitMutation(this.#owner, "style", { property: "scrollMarginInline", value: text }); }
	get scrollMarginInlineEnd() { this.#gate.check("dom"); return this.#owner.styleData.scrollMarginInlineEnd ?? ""; }
	set scrollMarginInlineEnd(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollMarginInlineEnd", text); this.#owner.styleData.scrollMarginInlineEnd = text; emitMutation(this.#owner, "style", { property: "scrollMarginInlineEnd", value: text }); }
	get scrollMarginInlineStart() { this.#gate.check("dom"); return this.#owner.styleData.scrollMarginInlineStart ?? ""; }
	set scrollMarginInlineStart(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollMarginInlineStart", text); this.#owner.styleData.scrollMarginInlineStart = text; emitMutation(this.#owner, "style", { property: "scrollMarginInlineStart", value: text }); }
	get scrollMarginLeft() { this.#gate.check("dom"); return this.#owner.styleData.scrollMarginLeft ?? ""; }
	set scrollMarginLeft(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollMarginLeft", text); this.#owner.styleData.scrollMarginLeft = text; emitMutation(this.#owner, "style", { property: "scrollMarginLeft", value: text }); }
	get scrollMarginRight() { this.#gate.check("dom"); return this.#owner.styleData.scrollMarginRight ?? ""; }
	set scrollMarginRight(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollMarginRight", text); this.#owner.styleData.scrollMarginRight = text; emitMutation(this.#owner, "style", { property: "scrollMarginRight", value: text }); }
	get scrollMarginTop() { this.#gate.check("dom"); return this.#owner.styleData.scrollMarginTop ?? ""; }
	set scrollMarginTop(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollMarginTop", text); this.#owner.styleData.scrollMarginTop = text; emitMutation(this.#owner, "style", { property: "scrollMarginTop", value: text }); }
	get scrollPadding() { this.#gate.check("dom"); return this.#owner.styleData.scrollPadding ?? ""; }
	set scrollPadding(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollPadding", text); this.#owner.styleData.scrollPadding = text; emitMutation(this.#owner, "style", { property: "scrollPadding", value: text }); }
	get scrollPaddingBlock() { this.#gate.check("dom"); return this.#owner.styleData.scrollPaddingBlock ?? ""; }
	set scrollPaddingBlock(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollPaddingBlock", text); this.#owner.styleData.scrollPaddingBlock = text; emitMutation(this.#owner, "style", { property: "scrollPaddingBlock", value: text }); }
	get scrollPaddingBlockEnd() { this.#gate.check("dom"); return this.#owner.styleData.scrollPaddingBlockEnd ?? ""; }
	set scrollPaddingBlockEnd(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollPaddingBlockEnd", text); this.#owner.styleData.scrollPaddingBlockEnd = text; emitMutation(this.#owner, "style", { property: "scrollPaddingBlockEnd", value: text }); }
	get scrollPaddingBlockStart() { this.#gate.check("dom"); return this.#owner.styleData.scrollPaddingBlockStart ?? ""; }
	set scrollPaddingBlockStart(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollPaddingBlockStart", text); this.#owner.styleData.scrollPaddingBlockStart = text; emitMutation(this.#owner, "style", { property: "scrollPaddingBlockStart", value: text }); }
	get scrollPaddingBottom() { this.#gate.check("dom"); return this.#owner.styleData.scrollPaddingBottom ?? ""; }
	set scrollPaddingBottom(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollPaddingBottom", text); this.#owner.styleData.scrollPaddingBottom = text; emitMutation(this.#owner, "style", { property: "scrollPaddingBottom", value: text }); }
	get scrollPaddingInline() { this.#gate.check("dom"); return this.#owner.styleData.scrollPaddingInline ?? ""; }
	set scrollPaddingInline(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollPaddingInline", text); this.#owner.styleData.scrollPaddingInline = text; emitMutation(this.#owner, "style", { property: "scrollPaddingInline", value: text }); }
	get scrollPaddingInlineEnd() { this.#gate.check("dom"); return this.#owner.styleData.scrollPaddingInlineEnd ?? ""; }
	set scrollPaddingInlineEnd(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollPaddingInlineEnd", text); this.#owner.styleData.scrollPaddingInlineEnd = text; emitMutation(this.#owner, "style", { property: "scrollPaddingInlineEnd", value: text }); }
	get scrollPaddingInlineStart() { this.#gate.check("dom"); return this.#owner.styleData.scrollPaddingInlineStart ?? ""; }
	set scrollPaddingInlineStart(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollPaddingInlineStart", text); this.#owner.styleData.scrollPaddingInlineStart = text; emitMutation(this.#owner, "style", { property: "scrollPaddingInlineStart", value: text }); }
	get scrollPaddingLeft() { this.#gate.check("dom"); return this.#owner.styleData.scrollPaddingLeft ?? ""; }
	set scrollPaddingLeft(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollPaddingLeft", text); this.#owner.styleData.scrollPaddingLeft = text; emitMutation(this.#owner, "style", { property: "scrollPaddingLeft", value: text }); }
	get scrollPaddingRight() { this.#gate.check("dom"); return this.#owner.styleData.scrollPaddingRight ?? ""; }
	set scrollPaddingRight(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollPaddingRight", text); this.#owner.styleData.scrollPaddingRight = text; emitMutation(this.#owner, "style", { property: "scrollPaddingRight", value: text }); }
	get scrollPaddingTop() { this.#gate.check("dom"); return this.#owner.styleData.scrollPaddingTop ?? ""; }
	set scrollPaddingTop(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollPaddingTop", text); this.#owner.styleData.scrollPaddingTop = text; emitMutation(this.#owner, "style", { property: "scrollPaddingTop", value: text }); }
	get scrollSnapAlign() { this.#gate.check("dom"); return this.#owner.styleData.scrollSnapAlign ?? ""; }
	set scrollSnapAlign(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollSnapAlign", text); this.#owner.styleData.scrollSnapAlign = text; emitMutation(this.#owner, "style", { property: "scrollSnapAlign", value: text }); }
	get scrollSnapStop() { this.#gate.check("dom"); return this.#owner.styleData.scrollSnapStop ?? ""; }
	set scrollSnapStop(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollSnapStop", text); this.#owner.styleData.scrollSnapStop = text; emitMutation(this.#owner, "style", { property: "scrollSnapStop", value: text }); }
	get scrollSnapType() { this.#gate.check("dom"); return this.#owner.styleData.scrollSnapType ?? ""; }
	set scrollSnapType(value) { this.#gate.check("dom"); const text = String(value); safeStyle("scrollSnapType", text); this.#owner.styleData.scrollSnapType = text; emitMutation(this.#owner, "style", { property: "scrollSnapType", value: text }); }
	get shapeOutside() { this.#gate.check("dom"); return this.#owner.styleData.shapeOutside ?? ""; }
	set shapeOutside(value) { this.#gate.check("dom"); const text = String(value); safeStyle("shapeOutside", text); this.#owner.styleData.shapeOutside = text; emitMutation(this.#owner, "style", { property: "shapeOutside", value: text }); }
	get tabSize() { this.#gate.check("dom"); return this.#owner.styleData.tabSize ?? ""; }
	set tabSize(value) { this.#gate.check("dom"); const text = String(value); safeStyle("tabSize", text); this.#owner.styleData.tabSize = text; emitMutation(this.#owner, "style", { property: "tabSize", value: text }); }
	get tableLayout() { this.#gate.check("dom"); return this.#owner.styleData.tableLayout ?? ""; }
	set tableLayout(value) { this.#gate.check("dom"); const text = String(value); safeStyle("tableLayout", text); this.#owner.styleData.tableLayout = text; emitMutation(this.#owner, "style", { property: "tableLayout", value: text }); }
	get textAlign() { this.#gate.check("dom"); return this.#owner.styleData.textAlign ?? ""; }
	set textAlign(value) { this.#gate.check("dom"); const text = String(value); safeStyle("textAlign", text); this.#owner.styleData.textAlign = text; emitMutation(this.#owner, "style", { property: "textAlign", value: text }); }
	get textAlignLast() { this.#gate.check("dom"); return this.#owner.styleData.textAlignLast ?? ""; }
	set textAlignLast(value) { this.#gate.check("dom"); const text = String(value); safeStyle("textAlignLast", text); this.#owner.styleData.textAlignLast = text; emitMutation(this.#owner, "style", { property: "textAlignLast", value: text }); }
	get textDecoration() { this.#gate.check("dom"); return this.#owner.styleData.textDecoration ?? ""; }
	set textDecoration(value) { this.#gate.check("dom"); const text = String(value); safeStyle("textDecoration", text); this.#owner.styleData.textDecoration = text; emitMutation(this.#owner, "style", { property: "textDecoration", value: text }); }
	get textDecorationColor() { this.#gate.check("dom"); return this.#owner.styleData.textDecorationColor ?? ""; }
	set textDecorationColor(value) { this.#gate.check("dom"); const text = String(value); safeStyle("textDecorationColor", text); this.#owner.styleData.textDecorationColor = text; emitMutation(this.#owner, "style", { property: "textDecorationColor", value: text }); }
	get textDecorationLine() { this.#gate.check("dom"); return this.#owner.styleData.textDecorationLine ?? ""; }
	set textDecorationLine(value) { this.#gate.check("dom"); const text = String(value); safeStyle("textDecorationLine", text); this.#owner.styleData.textDecorationLine = text; emitMutation(this.#owner, "style", { property: "textDecorationLine", value: text }); }
	get textDecorationStyle() { this.#gate.check("dom"); return this.#owner.styleData.textDecorationStyle ?? ""; }
	set textDecorationStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("textDecorationStyle", text); this.#owner.styleData.textDecorationStyle = text; emitMutation(this.#owner, "style", { property: "textDecorationStyle", value: text }); }
	get textIndent() { this.#gate.check("dom"); return this.#owner.styleData.textIndent ?? ""; }
	set textIndent(value) { this.#gate.check("dom"); const text = String(value); safeStyle("textIndent", text); this.#owner.styleData.textIndent = text; emitMutation(this.#owner, "style", { property: "textIndent", value: text }); }
	get textOverflow() { this.#gate.check("dom"); return this.#owner.styleData.textOverflow ?? ""; }
	set textOverflow(value) { this.#gate.check("dom"); const text = String(value); safeStyle("textOverflow", text); this.#owner.styleData.textOverflow = text; emitMutation(this.#owner, "style", { property: "textOverflow", value: text }); }
	get textRendering() { this.#gate.check("dom"); return this.#owner.styleData.textRendering ?? ""; }
	set textRendering(value) { this.#gate.check("dom"); const text = String(value); safeStyle("textRendering", text); this.#owner.styleData.textRendering = text; emitMutation(this.#owner, "style", { property: "textRendering", value: text }); }
	get textShadow() { this.#gate.check("dom"); return this.#owner.styleData.textShadow ?? ""; }
	set textShadow(value) { this.#gate.check("dom"); const text = String(value); safeStyle("textShadow", text); this.#owner.styleData.textShadow = text; emitMutation(this.#owner, "style", { property: "textShadow", value: text }); }
	get textTransform() { this.#gate.check("dom"); return this.#owner.styleData.textTransform ?? ""; }
	set textTransform(value) { this.#gate.check("dom"); const text = String(value); safeStyle("textTransform", text); this.#owner.styleData.textTransform = text; emitMutation(this.#owner, "style", { property: "textTransform", value: text }); }
	get textUnderlineOffset() { this.#gate.check("dom"); return this.#owner.styleData.textUnderlineOffset ?? ""; }
	set textUnderlineOffset(value) { this.#gate.check("dom"); const text = String(value); safeStyle("textUnderlineOffset", text); this.#owner.styleData.textUnderlineOffset = text; emitMutation(this.#owner, "style", { property: "textUnderlineOffset", value: text }); }
	get top() { this.#gate.check("dom"); return this.#owner.styleData.top ?? ""; }
	set top(value) { this.#gate.check("dom"); const text = String(value); safeStyle("top", text); this.#owner.styleData.top = text; emitMutation(this.#owner, "style", { property: "top", value: text }); }
	get touchAction() { this.#gate.check("dom"); return this.#owner.styleData.touchAction ?? ""; }
	set touchAction(value) { this.#gate.check("dom"); const text = String(value); safeStyle("touchAction", text); this.#owner.styleData.touchAction = text; emitMutation(this.#owner, "style", { property: "touchAction", value: text }); }
	get transform() { this.#gate.check("dom"); return this.#owner.styleData.transform ?? ""; }
	set transform(value) { this.#gate.check("dom"); const text = String(value); safeStyle("transform", text); this.#owner.styleData.transform = text; emitMutation(this.#owner, "style", { property: "transform", value: text }); }
	get transformOrigin() { this.#gate.check("dom"); return this.#owner.styleData.transformOrigin ?? ""; }
	set transformOrigin(value) { this.#gate.check("dom"); const text = String(value); safeStyle("transformOrigin", text); this.#owner.styleData.transformOrigin = text; emitMutation(this.#owner, "style", { property: "transformOrigin", value: text }); }
	get transformStyle() { this.#gate.check("dom"); return this.#owner.styleData.transformStyle ?? ""; }
	set transformStyle(value) { this.#gate.check("dom"); const text = String(value); safeStyle("transformStyle", text); this.#owner.styleData.transformStyle = text; emitMutation(this.#owner, "style", { property: "transformStyle", value: text }); }
	get transition() { this.#gate.check("dom"); return this.#owner.styleData.transition ?? ""; }
	set transition(value) { this.#gate.check("dom"); const text = String(value); safeStyle("transition", text); this.#owner.styleData.transition = text; emitMutation(this.#owner, "style", { property: "transition", value: text }); }
	get transitionDelay() { this.#gate.check("dom"); return this.#owner.styleData.transitionDelay ?? ""; }
	set transitionDelay(value) { this.#gate.check("dom"); const text = String(value); safeStyle("transitionDelay", text); this.#owner.styleData.transitionDelay = text; emitMutation(this.#owner, "style", { property: "transitionDelay", value: text }); }
	get transitionDuration() { this.#gate.check("dom"); return this.#owner.styleData.transitionDuration ?? ""; }
	set transitionDuration(value) { this.#gate.check("dom"); const text = String(value); safeStyle("transitionDuration", text); this.#owner.styleData.transitionDuration = text; emitMutation(this.#owner, "style", { property: "transitionDuration", value: text }); }
	get transitionProperty() { this.#gate.check("dom"); return this.#owner.styleData.transitionProperty ?? ""; }
	set transitionProperty(value) { this.#gate.check("dom"); const text = String(value); safeStyle("transitionProperty", text); this.#owner.styleData.transitionProperty = text; emitMutation(this.#owner, "style", { property: "transitionProperty", value: text }); }
	get transitionTimingFunction() { this.#gate.check("dom"); return this.#owner.styleData.transitionTimingFunction ?? ""; }
	set transitionTimingFunction(value) { this.#gate.check("dom"); const text = String(value); safeStyle("transitionTimingFunction", text); this.#owner.styleData.transitionTimingFunction = text; emitMutation(this.#owner, "style", { property: "transitionTimingFunction", value: text }); }
	get translate() { this.#gate.check("dom"); return this.#owner.styleData.translate ?? ""; }
	set translate(value) { this.#gate.check("dom"); const text = String(value); safeStyle("translate", text); this.#owner.styleData.translate = text; emitMutation(this.#owner, "style", { property: "translate", value: text }); }
	get unicodeBidi() { this.#gate.check("dom"); return this.#owner.styleData.unicodeBidi ?? ""; }
	set unicodeBidi(value) { this.#gate.check("dom"); const text = String(value); safeStyle("unicodeBidi", text); this.#owner.styleData.unicodeBidi = text; emitMutation(this.#owner, "style", { property: "unicodeBidi", value: text }); }
	get userSelect() { this.#gate.check("dom"); return this.#owner.styleData.userSelect ?? ""; }
	set userSelect(value) { this.#gate.check("dom"); const text = String(value); safeStyle("userSelect", text); this.#owner.styleData.userSelect = text; emitMutation(this.#owner, "style", { property: "userSelect", value: text }); }
	get verticalAlign() { this.#gate.check("dom"); return this.#owner.styleData.verticalAlign ?? ""; }
	set verticalAlign(value) { this.#gate.check("dom"); const text = String(value); safeStyle("verticalAlign", text); this.#owner.styleData.verticalAlign = text; emitMutation(this.#owner, "style", { property: "verticalAlign", value: text }); }
	get visibility() { this.#gate.check("dom"); return this.#owner.styleData.visibility ?? ""; }
	set visibility(value) { this.#gate.check("dom"); const text = String(value); safeStyle("visibility", text); this.#owner.styleData.visibility = text; emitMutation(this.#owner, "style", { property: "visibility", value: text }); }
	get whiteSpace() { this.#gate.check("dom"); return this.#owner.styleData.whiteSpace ?? ""; }
	set whiteSpace(value) { this.#gate.check("dom"); const text = String(value); safeStyle("whiteSpace", text); this.#owner.styleData.whiteSpace = text; emitMutation(this.#owner, "style", { property: "whiteSpace", value: text }); }
	get widows() { this.#gate.check("dom"); return this.#owner.styleData.widows ?? ""; }
	set widows(value) { this.#gate.check("dom"); const text = String(value); safeStyle("widows", text); this.#owner.styleData.widows = text; emitMutation(this.#owner, "style", { property: "widows", value: text }); }
	get width() { this.#gate.check("dom"); return this.#owner.styleData.width ?? ""; }
	set width(value) { this.#gate.check("dom"); const text = String(value); safeStyle("width", text); this.#owner.styleData.width = text; emitMutation(this.#owner, "style", { property: "width", value: text }); }
	get willChange() { this.#gate.check("dom"); return this.#owner.styleData.willChange ?? ""; }
	set willChange(value) { this.#gate.check("dom"); const text = String(value); safeStyle("willChange", text); this.#owner.styleData.willChange = text; emitMutation(this.#owner, "style", { property: "willChange", value: text }); }
	get wordBreak() { this.#gate.check("dom"); return this.#owner.styleData.wordBreak ?? ""; }
	set wordBreak(value) { this.#gate.check("dom"); const text = String(value); safeStyle("wordBreak", text); this.#owner.styleData.wordBreak = text; emitMutation(this.#owner, "style", { property: "wordBreak", value: text }); }
	get wordSpacing() { this.#gate.check("dom"); return this.#owner.styleData.wordSpacing ?? ""; }
	set wordSpacing(value) { this.#gate.check("dom"); const text = String(value); safeStyle("wordSpacing", text); this.#owner.styleData.wordSpacing = text; emitMutation(this.#owner, "style", { property: "wordSpacing", value: text }); }
	get wordWrap() { this.#gate.check("dom"); return this.#owner.styleData.wordWrap ?? ""; }
	set wordWrap(value) { this.#gate.check("dom"); const text = String(value); safeStyle("wordWrap", text); this.#owner.styleData.wordWrap = text; emitMutation(this.#owner, "style", { property: "wordWrap", value: text }); }
	get writingMode() { this.#gate.check("dom"); return this.#owner.styleData.writingMode ?? ""; }
	set writingMode(value) { this.#gate.check("dom"); const text = String(value); safeStyle("writingMode", text); this.#owner.styleData.writingMode = text; emitMutation(this.#owner, "style", { property: "writingMode", value: text }); }
	get zIndex() { this.#gate.check("dom"); return this.#owner.styleData.zIndex ?? ""; }
	set zIndex(value) { this.#gate.check("dom"); const text = String(value); safeStyle("zIndex", text); this.#owner.styleData.zIndex = text; emitMutation(this.#owner, "style", { property: "zIndex", value: text }); }
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
	get parentNode() { this.#gate.check("dom"); return this.#data.parent?new PpermNode(this.#data.parent,this.#gate):null; }
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
	hasChildNodes() { this.#gate.check("dom"); return this.#data.children.length>0; }
	contains(other) { this.#gate.check("dom"); let n=raw(other);while(n){if(n===this.#data)return true;n=n.parent;}return false; }
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
	get checked() { this.#gate.check("dom"); return this.#data.checked??false; }
	set checked(value) { this.#gate.check("dom"); this.#data.checked=Boolean(value);emitMutation(this.#data,"property",{property:"checked",value:this.#data.checked}); }
	get disabled() { this.#gate.check("dom"); return this.#data.disabled??false; }
	set disabled(value) { this.#gate.check("dom"); this.#data.disabled=Boolean(value);emitMutation(this.#data,"property",{property:"disabled",value:this.#data.disabled}); }
	get name() { this.#gate.check("dom"); return this.#data.attributes.name??""; }
	set name(value) { this.#gate.check("dom"); const text=String(value);this.#data.attributes.name=text;emitMutation(this.#data,"attribute",{name:"name",value:text}); }
	get type() { this.#gate.check("dom"); return this.#data.attributes.type??""; }
	set type(value) { this.#gate.check("dom"); const text=String(value);this.#data.attributes.type=text;emitMutation(this.#data,"attribute",{name:"type",value:text}); }

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
	get selected() { this.#gate.check("dom"); return Object.hasOwn(this.#data.attributes, "selected"); }
	set selected(value) { this.#gate.check("dom"); if (value) this.#data.attributes["selected"] = ""; else delete this.#data.attributes["selected"]; emitMutation(this.#data, value ? "attribute" : "removeAttribute", value ? { name: "selected", value: "" } : { name: "selected" }); }
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
		const old = this.#eventProperties.get("onclick");
		if (old) this.removeEventListener("click", old);
		if (value == null) { this.#eventProperties.delete("onclick"); return; }
		if (typeof value !== "function") throw new TypeError("onclick must be a function or null");
		this.#eventProperties.set("onclick", value);
		this.addEventListener("click", value);
	}

	get onchange() { this.#gate.check("dom"); return this.#eventProperties.get("onchange") ?? null; }
	set onchange(value) {
		this.#gate.check("dom");
		const old = this.#eventProperties.get("onchange");
		if (old) this.removeEventListener("change", old);
		if (value == null) { this.#eventProperties.delete("onchange"); return; }
		if (typeof value !== "function") throw new TypeError("onchange must be a function or null");
		this.#eventProperties.set("onchange", value);
		this.addEventListener("change", value);
	}

	get oninput() { this.#gate.check("dom"); return this.#eventProperties.get("oninput") ?? null; }
	set oninput(value) {
		this.#gate.check("dom");
		const old = this.#eventProperties.get("oninput");
		if (old) this.removeEventListener("input", old);
		if (value == null) { this.#eventProperties.delete("oninput"); return; }
		if (typeof value !== "function") throw new TypeError("oninput must be a function or null");
		this.#eventProperties.set("oninput", value);
		this.addEventListener("input", value);
	}

	get onsubmit() { this.#gate.check("dom"); return this.#eventProperties.get("onsubmit") ?? null; }
	set onsubmit(value) {
		this.#gate.check("dom");
		const old = this.#eventProperties.get("onsubmit");
		if (old) this.removeEventListener("submit", old);
		if (value == null) { this.#eventProperties.delete("onsubmit"); return; }
		if (typeof value !== "function") throw new TypeError("onsubmit must be a function or null");
		this.#eventProperties.set("onsubmit", value);
		this.addEventListener("submit", value);
	}

	get onfocus() { this.#gate.check("dom"); return this.#eventProperties.get("onfocus") ?? null; }
	set onfocus(value) {
		this.#gate.check("dom");
		const old = this.#eventProperties.get("onfocus");
		if (old) this.removeEventListener("focus", old);
		if (value == null) { this.#eventProperties.delete("onfocus"); return; }
		if (typeof value !== "function") throw new TypeError("onfocus must be a function or null");
		this.#eventProperties.set("onfocus", value);
		this.addEventListener("focus", value);
	}

	get onblur() { this.#gate.check("dom"); return this.#eventProperties.get("onblur") ?? null; }
	set onblur(value) {
		this.#gate.check("dom");
		const old = this.#eventProperties.get("onblur");
		if (old) this.removeEventListener("blur", old);
		if (value == null) { this.#eventProperties.delete("onblur"); return; }
		if (typeof value !== "function") throw new TypeError("onblur must be a function or null");
		this.#eventProperties.set("onblur", value);
		this.addEventListener("blur", value);
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
		emitMutation(this.#data, "attribute", { name: safeName, value: text });
	}

	removeAttribute(name) {
		this.#gate.check("dom");
		const safeName = String(name).toLowerCase();
		if (safeName.startsWith("on") || blockedAttributes.has(safeName)) denied("attribute " + safeName);
		delete this.#data.attributes[safeName];
		if (safeName === "id") this.#data.idName = "";
		if (safeName === "class") this.#data.className = "";
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
	get forms() { this.#gate.check("dom"); return []; }
	get images() { this.#gate.check("dom"); return []; }
	get links() { this.#gate.check("dom"); return []; }
	get scripts() { this.#gate.check("dom"); return []; }
	get children() { this.#gate.check("dom"); return [new PpermNode(root, this.#gate)]; }
	get childNodes() { this.#gate.check("dom"); return [new PpermNode(root, this.#gate)]; }
	get firstChild() { this.#gate.check("dom"); return new PpermNode(root, this.#gate); }
	get lastChild() { this.#gate.check("dom"); return new PpermNode(root, this.#gate); }
	get implementation() { this.#gate.check("dom"); return Object.freeze({ hasFeature: () => { this.#gate.check("dom"); return false; } }); }

	getElementById(id) {
		this.#gate.check("dom");
		return this.querySelector("#" + String(id));
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
