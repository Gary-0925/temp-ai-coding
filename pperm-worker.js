export function workerMain() {
	"use strict";
	let stopped = false;
	let remoteResources = false;
	let remotePolicy = { enabled: false, allow: [] };
	let htmlEnabled = false;
	let htmlElements = new Set();
	let htmlAttributes = new Set();
	let htmlVoidElements = new Set();
	let htmlLimits = { length: 262144, nodes: 2000, depth: 64, attributeLength: 4096 };
	let channel = null;
	let initialized = false;
	let storageRequestId = 1;
	const storagePending = new Map();
	let nextId = 1;
	let root = null;
	let documentProxy = null;
	let documentTitle = "";
	const nodes = new Map();
	const listeners = new Map();
	const nodeDataByInstance = new WeakMap();
	let runtimeLimits = { steps: Infinity, timers: 64, timerCalls: Infinity, minTimerDelayMs: 0, heartbeatMs: 100, messagesPerSecond: Infinity, netRequests: Infinity };
	let runtime = { allowEval: false, globals: [], highResolutionTime: false };
	let baseURI = "https://pperm.invalid/";
	let tickName = null;
	let steps = 0;
	let halted = false;
	let heartbeatHandle = null;
	let netRequestId = 1;
	const netPending = new Map();
	let emitWindowStart = 0;
	let emitBudget = 0;
	let activeTimers = 0;
	let timerCalls = 0;
	const timerHandles = new Map();
	let connections = 0;
	let gate = null;
	const nativeURL = self.URL;
	const nativeResponse = self.Response;
	const nativeDateNow = Date.now.bind(Date);

	function emit(type, data = {}) {
		if (stopped || !channel) return;
		if (type !== "quota" && type !== "ready" && type !== "done" && type !== "error") {
			const now = nativeDateNow();
			if (now - emitWindowStart >= 1000) { emitWindowStart = now; emitBudget = 0; }
			if (++emitBudget > runtimeLimits.messagesPerSecond) { halt("messagesPerSecond"); return; }
		}
		channel.postMessage({ type, ...data });
	}

	function halt(name) {
		const error = new DOMException("Execution stopped: " + name + " limit exceeded", "QuotaExceededError");
		if (!halted) {
			halted = true;
			try { channel?.postMessage({ type: "quota", name, steps }); } catch {}
		}
		throw error;
	}

	function tick() {
		if (halted) throw new DOMException("Execution stopped", "QuotaExceededError");
		steps++;
		if (steps > runtimeLimits.steps) halt("steps");
		if ((steps & 16383) === 0 && channel) channel.postMessage({ type: "usage", steps });
	}

	function denied(name) {
		throw new DOMException("Permission denied: " + name, "NotAllowedError");
	}

	function deniedGlobal(name) {
		return new Proxy(function () { denied(name); }, {
			apply() { denied(name); },
			construct() { denied(name); },
			get(_target, property) { denied(name + "." + String(property)); }
		});
	}

	class PermissionGate {
		constructor(policy) {
			this.policy = policy ?? {};
		}

		check(capability = "dom") {
			if (stopped) throw new DOMException("Process has been terminated", "AbortError");
			if (capability === "dom" && !this.policy.dom?.enabled) denied("dom");
			if (capability === "fetch" && !this.policy.network?.fetch?.enabled) denied("fetch");
			if (capability === "webSocket" && !this.policy.network?.webSocket?.enabled) denied("WebSocket");
			if (capability === "eventSource" && !this.policy.network?.eventSource?.enabled) denied("EventSource");
			if (capability === "xmlHttpRequest" && !this.policy.network?.xmlHttpRequest?.enabled) denied("XMLHttpRequest");
			if (capability === "storage" && !this.policy.storage?.enabled) denied("storage");
		}
	}

	const blockedElements = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "meta", "link", "style", "svg", "math", "portal", "fencedframe", "webview"]);
	const blockedAttributes = new Set(["srcdoc", "nonce", "integrity", "is", "action", "formaction", "srcset", "imagesrcset", "ping"]);
	const urlAttributes = new Set(["href", "src", "action", "formaction", "poster", "cite", "xlink:href", "background", "data", "manifest"]);
	const executableDataURL = /^data:(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|text\/css)/i;
	const localResourceURL = /^(?:#|about:blank$|blob:|data:(?!text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|text\/css)[-a-z0-9._+\/]*[,;])/i;
	const htmlDropElements = new Set([
		"script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
		"base", "meta", "link", "title", "svg", "math", "template", "noscript", "xmp",
		"plaintext", "noembed", "noframes", "param", "source", "track", "audio", "video",
		"portal", "fencedframe", "webview"
	]);
	const htmlDangerousCSS = /url\s*\(|@import|expression\s*\(|-moz-binding|behavior\s*:|var\s*\(|image-set\s*\(|\\|\/\*/i;

	function safeElementName(value) {
		const name = String(value).toLowerCase();
		if (!/^[a-z][a-z0-9-]*$/.test(name) || name.includes("-") || blockedElements.has(name)) {
			throw new DOMException("Element type is not permitted", "NotAllowedError");
		}
		return name;
	}

	function globToRegExp(glob) {
		let pattern = "^";
		for (const character of glob) {
			if (character === "*") pattern += ".*";
			else if (character === "?") pattern += "[^/]";
			else pattern += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
		return new RegExp(pattern + "$", "i");
	}

	function matchURL(pattern, value) {
		let target;
		try { target = new nativeURL(String(value), baseURI); } catch { return false; }
		if (target.protocol !== "http:" && target.protocol !== "https:") return false;
		if (pattern === "*") return true;
		if (pattern.startsWith("/")) {
			const base = new nativeURL(baseURI).origin;
			return globToRegExp(base + pattern).test(target.protocol + "//" + target.host + target.pathname + target.search);
		}
		const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(pattern) ? pattern : "https://" + pattern;
		if (!/^https?:\/\//i.test(normalized)) return false;
		return globToRegExp(normalized).test(target.protocol + "//" + target.host + target.pathname + target.search);
	}

	function safeURL(name, value) {
		const url = String(value).trim().replace(/[\u0000-\u0020]+/g, "");
		if (/^(?:javascript|vbscript):/i.test(url) || executableDataURL.test(url)) {
			throw new DOMException("Executable URLs are not permitted", "NotAllowedError");
		}
		if (localResourceURL.test(url)) return;
		if (!remotePolicy.enabled || !remotePolicy.allow.some(pattern => matchURL(pattern, url))) {
			throw new DOMException("Remote resource URL is not permitted: " + name, "NotAllowedError");
		}
	}

	function safeAttribute(name, value) {
		name = String(name).toLowerCase();
		if (!/^[a-z_:][a-z0-9_.:-]*$/.test(name) || name.startsWith("on") || blockedAttributes.has(name)) {
			throw new DOMException("Attribute is not permitted: " + name, "NotAllowedError");
		}
		if (urlAttributes.has(name)) safeURL(name, value);
		return name;
	}

	function safeStyle(property, value) {
		property = String(property).trim();
		if (!/^(?:--[a-z0-9_-]+|-?[a-z][a-z0-9-]*)$/i.test(property) || ["__proto__", "prototype", "constructor"].includes(property.toLowerCase())) {
			throw new DOMException("CSS property name is not permitted", "NotAllowedError");
		}
		if (htmlDangerousCSS.test(String(value))) {
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
			styleData: { ...data.styleData }, stylePriorityData: { ...(data.stylePriorityData ?? {}) }, value: data.value, checked: data.checked, disabled: data.disabled, muted: data.muted,
			selected: data.selected, indeterminate: data.indeterminate, tabIndex: data.tabIndex, width: data.width,
			height: data.height, rows: data.rows, cols: data.cols, maxLength: data.maxLength, minLength: data.minLength,
			rowSpan: data.rowSpan, colSpan: data.colSpan, size: data.size, start: data.start, span: data.span,
			html: data.html === true,
			children: data.children.map(serialize)
		};
	}

	function makeData(input = {}, parent = null) {
		const data = {
			id: input.id ?? nextId++, nodeType: input.nodeType ?? 1,
			tagName: input.tagName ?? "#text", idName: input.idName ?? "",
			className: input.className ?? "", text: input.text ?? "",
			attributes: { ...(input.attributes ?? {}) }, styleData: { ...(input.styleData ?? {}) }, stylePriorityData: { ...(input.stylePriorityData ?? {}) },
			value: input.value, checked: input.checked, disabled: input.disabled, muted: input.muted, selected: input.selected,
			indeterminate: input.indeterminate, tabIndex: input.tabIndex, width: input.width, height: input.height,
			rows: input.rows, cols: input.cols, maxLength: input.maxLength, minLength: input.minLength,
			rowSpan: input.rowSpan, colSpan: input.colSpan, size: input.size, start: input.start, span: input.span,
			parent, children: [], connected: input.connected ?? true, html: input.html === true
		};
		nodes.set(data.id, data);
		data.children = (input.children ?? []).map(child => makeData(child, data));
		return data;
	}

	function emitMutation(data, op, extra = {}) {
		if (data.connected) emit("dom", { op, id: data.id, ...extra });
	}

	function decodeHTMLEntities(value) {
		return String(value).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi, (match, entity) => {
			const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
			if (entity[0] === "#") {
				const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
				if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
				try { return String.fromCodePoint(code); } catch { return match; }
			}
			return Object.hasOwn(named, entity.toLowerCase()) ? named[entity.toLowerCase()] : match;
		});
	}

	function parseHTMLFragment(input) {
		const text = String(input).slice(0, htmlLimits.length);
		const root = { tag: null, children: [] };
		const stack = [root];
		let index = 0;
		let count = 0;
		const append = node => {
			if (++count > htmlLimits.nodes) throw new DOMException("HTML content exceeds the node limit", "NotAllowedError");
			stack[stack.length - 1].children.push(node);
		};
		while (index < text.length) {
			const start = text.indexOf("<", index);
			if (start < 0) { append({ type: "text", text: decodeHTMLEntities(text.slice(index)) }); break; }
			if (start > index) append({ type: "text", text: decodeHTMLEntities(text.slice(index, start)) });
			if (text.startsWith("<!--", start)) {
				const end = text.indexOf("-->", start + 4);
				index = end < 0 ? text.length : end + 3;
				continue;
			}
			if (text.startsWith("<!", start) || text.startsWith("<?", start)) {
				const end = text.indexOf(">", start + 2);
				index = end < 0 ? text.length : end + 1;
				continue;
			}
			const closing = text.startsWith("</", start);
			let cursor = start + (closing ? 2 : 1);
			const nameStart = cursor;
			while (cursor < text.length && /[a-z0-9-]/i.test(text[cursor])) cursor++;
			const tag = text.slice(nameStart, cursor).toLowerCase();
			if (!tag) { append({ type: "text", text: "<" }); index = start + 1; continue; }
			if (closing) {
				const end = text.indexOf(">", cursor);
				index = end < 0 ? text.length : end + 1;
				for (let depth = stack.length - 1; depth > 0; depth--) {
					if (stack[depth].tag === tag) { stack.length = depth; break; }
				}
				continue;
			}
			const attributes = {};
			let selfClosing = false;
			let terminated = false;
			while (cursor < text.length) {
				while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
				if (cursor >= text.length) break;
				if (text[cursor] === ">") { cursor++; terminated = true; break; }
				if (text.startsWith("/>", cursor)) { cursor += 2; selfClosing = true; terminated = true; break; }
				const attributeStart = cursor;
				while (cursor < text.length && /[^\s"'` <>=]/.test(text[cursor])) cursor++;
				const name = text.slice(attributeStart, cursor).toLowerCase();
				if (!name) { cursor++; continue; }
				while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
				let value = "";
				if (text[cursor] === "=") {
					cursor++;
					while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
					const quote = text[cursor];
					if (quote === '"' || quote === "'") {
						cursor++;
						const end = text.indexOf(quote, cursor);
						value = decodeHTMLEntities(end < 0 ? text.slice(cursor) : text.slice(cursor, end));
						cursor = end < 0 ? text.length : end + 1;
					} else {
						const valueStart = cursor;
						while (cursor < text.length && !/[\s>]/.test(text[cursor])) cursor++;
						value = decodeHTMLEntities(text.slice(valueStart, cursor));
					}
				}
				if (/^[a-z_:][a-z0-9_.:-]*$/.test(name) && !Object.hasOwn(attributes, name) && value.length <= htmlLimits.attributeLength) attributes[name] = value;
			}
			index = cursor;
			if (!terminated) break;
			if (htmlDropElements.has(tag)) {
				const pattern = new RegExp("</\\s*" + tag + "(?=[\\s>/])", "i");
				const match = pattern.exec(text.slice(index));
				if (!match) { index = text.length; }
				else {
					index += match.index;
					const end = text.indexOf(">", index);
					index = end < 0 ? text.length : end + 1;
				}
				continue;
			}
			const element = { type: "element", tag, attributes, children: [] };
			append(element);
			if (!selfClosing && !htmlVoidElements.has(tag)) {
				if (stack.length >= htmlLimits.depth) throw new DOMException("HTML content exceeds the depth limit", "NotAllowedError");
				stack.push(element);
			}
		}
		return root.children;
	}

	function sanitizeHTMLTree(parsed) {
		const out = [];
		const visit = (node, target) => {
			if (node.type === "text") { target.push({ type: "text", text: node.text }); return; }
			if (!htmlElements.has(node.tag)) {
				for (const child of node.children) visit(child, target);
				return;
			}
			const attributes = {};
			for (const [name, value] of Object.entries(node.attributes)) {
				if (name.startsWith("on") || blockedAttributes.has(name)) continue;
				if (!htmlAttributes.has(name) && !/^data-[a-z0-9-]+$/.test(name) && !/^aria-[a-z0-9-]+$/.test(name)) continue;
				if (name === "style" && htmlDangerousCSS.test(value)) continue;
				if (urlAttributes.has(name)) {
					try { safeURL(name, value); }
					catch { continue; }
				}
				attributes[name] = value;
			}
			const clean = { type: "element", tag: node.tag, attributes, children: [] };
			target.push(clean);
			for (const child of node.children) visit(child, clean.children);
		};
		for (const node of parsed) visit(node, out);
		return out;
	}

	function parseInlineStyle(value) {
		const styleData = {};
		for (const declaration of String(value).split(";")) {
			const colon = declaration.indexOf(":");
			if (colon < 1) continue;
			const property = declaration.slice(0, colon).trim();
			if (!/^(?:--[a-z0-9_-]+|-?[a-z][a-z0-9-]*)$/i.test(property)) continue;
			const key = property.startsWith("--") ? property : property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
			styleData[key] = declaration.slice(colon + 1).trim();
		}
		return styleData;
	}

	function htmlToNodeData(node, connected) {
		if (node.type === "text") return { nodeType: 3, tagName: "#text", text: node.text, connected, html: true };
		const attributes = { ...node.attributes };
		return {
			nodeType: 1,
			tagName: node.tag,
			idName: attributes.id ?? "",
			className: attributes.class ?? "",
			attributes,
			styleData: attributes.style ? parseInlineStyle(attributes.style) : {},
			connected,
			html: true,
			children: node.children.map(child => htmlToNodeData(child, connected))
		};
	}

	function dropHTMLChildren(data) {
		const removed = new Set();
		const walk = node => {
			removed.add(node.id);
			setConnected(node, false);
			for (const child of node.children) walk(child);
		};
		for (const child of data.children) walk(child);
		for (const id of removed) nodes.delete(id);
		for (const [listenerId, record] of [...listeners]) {
			if (removed.has(record.node.id)) listeners.delete(listenerId);
		}
	}

	function escapeHTMLText(value) {
		return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}

	function serializeHTML(children) {
		const parts = [];
		const write = node => {
			if (node.nodeType === 3) { parts.push(escapeHTMLText(node.text ?? "")); return; }
			if (node.nodeType !== 1) return;
			const tag = String(node.tagName).toLowerCase();
			parts.push("<" + tag);
			for (const [name, value] of Object.entries(node.attributes ?? {})) {
				parts.push(" " + name + '="' + escapeHTMLText(value).replace(/"/g, "&quot;") + '"');
			}
			parts.push(">");
			if (htmlVoidElements.has(tag)) return;
			for (const child of node.children ?? []) write(child);
			parts.push("</" + tag + ">");
		};
		for (const child of children) write(child);
		return parts.join("");
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
					delete target.#owner.stylePriorityData[key];
					emitMutation(target.#owner, "style", { property: safeName, value: cssValue });
					return true;
				}
			});
		}

		get cssText() {
			this.#gate.check("dom");
			return Object.entries(this.#owner.styleData).map(([name, value]) => (name.startsWith("--") ? name : name.replace(/[A-Z]/g, c => "-" + c.toLowerCase())) + ": " + value + (this.#owner.stylePriorityData[name] === "important" ? " !important" : "") + ";").join(" ");
		}
		set cssText(value) {
			this.#gate.check("dom");
			const text = String(value);
			safeStyle("style", text);
			const next = {};
			const priorities = {};
			for (const declaration of text.split(";")) {
				const index = declaration.indexOf(":");
				if (index < 0) continue;
				const name = declaration.slice(0, index).trim();
				let valueText = declaration.slice(index + 1).trim();
				if (name) {
					const safeName = safeStyle(name, valueText);
					const key = safeName.startsWith("--") ? safeName : safeName.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
					if (/!\s*important\s*$/i.test(valueText)) {
						valueText = valueText.replace(/!\s*important\s*$/i, "").trim();
						priorities[key] = "important";
					}
					next[key] = valueText;
				}
			}
			this.#owner.styleData = next;
			this.#owner.stylePriorityData = priorities;
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
			if (cssValue === "") { delete this.#owner.styleData[key]; delete this.#owner.stylePriorityData[key]; }
			else {
				this.#owner.styleData[key] = cssValue;
				if (cssPriority.trim().toLowerCase() === "important") this.#owner.stylePriorityData[key] = "important";
				else delete this.#owner.stylePriorityData[key];
			}
			emitMutation(this.#owner, "styleSetProperty", { property, value: cssValue, priority: cssPriority });
		}
		getPropertyValue(name) {
			this.#gate.check("dom");
			const property = String(name);
			const key = property.startsWith("--") ? property : property.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
			return this.#owner.styleData[key] ?? "";
		}
		getPropertyPriority(name) {
			this.#gate.check("dom");
			const property = String(name);
			const key = property.startsWith("--") ? property : property.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
			return this.#owner.stylePriorityData[key] ?? "";
		}
		[Symbol.iterator]() { this.#gate.check("dom"); return Array.from({ length: this.length }, (_, index) => this.item(index))[Symbol.iterator](); }
		removeProperty(name) {
			this.#gate.check("dom");
			const property = safeStyle(name, "");
			const key = property.startsWith("--") ? property : property.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
			const oldValue = this.#owner.styleData[key] ?? "";
			delete this.#owner.styleData[key];
			delete this.#owner.stylePriorityData[key];
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
			const token = String(value);
			this._validateTokens([token]);
			return this._values().includes(token);
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
			const node = this;
			const attributeName = key => {
				if (typeof key !== "string" || !key || ["__proto__", "prototype", "constructor"].includes(key)) return null;
				if (/-[a-z]/.test(key)) throw new DOMException("Invalid dataset property name", "SyntaxError");
				return "data-" + key.replace(/[A-Z]/g, character => "-" + character.toLowerCase());
			};
			const propertyName = name => name.slice(5).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
			return new Proxy({}, {
				get(_target, property) {
					if (typeof property !== "string") return undefined;
					node.#gate.check("dom");
					const name = attributeName(property);
					return name ? node.#data.attributes[name] : undefined;
				},
				set(_target, property, value) {
					if (typeof property !== "string") return false;
					node.#gate.check("dom");
					const name = attributeName(property);
					if (!name) denied("dataset property");
					node.setAttribute(name, String(value));
					return true;
				},
				deleteProperty(_target, property) {
					if (typeof property !== "string") return true;
					node.#gate.check("dom");
					const name = attributeName(property);
					if (!name) denied("dataset property");
					if (Object.hasOwn(node.#data.attributes, name)) node.removeAttribute(name);
					return true;
				},
				has(_target, property) {
					if (typeof property !== "string") return false;
					node.#gate.check("dom");
					const name = attributeName(property);
					return !!name && Object.hasOwn(node.#data.attributes, name);
				},
				ownKeys() {
					node.#gate.check("dom");
					return Object.keys(node.#data.attributes)
						.filter(name => name.startsWith("data-") && name.length > 5)
						.map(propertyName);
				},
				getOwnPropertyDescriptor(_target, property) {
					if (typeof property !== "string") return undefined;
					node.#gate.check("dom");
					const name = attributeName(property);
					if (!name || !Object.hasOwn(node.#data.attributes, name)) return undefined;
					return { configurable: true, enumerable: true, writable: true, value: node.#data.attributes[name] };
				}
			});
		}
		get nodeValue() { this.#gate.check("dom"); return this.#data.nodeType === 3 || this.#data.nodeType === 8 ? this.#data.text : null; }
		set nodeValue(value) { this.#gate.check("dom"); if(this.#data.nodeType === 3 || this.#data.nodeType === 8){this.#data.text = value == null ? "" : String(value);emitMutation(this.#data,"text",{value:this.#data.text});} }
		get data() { this.#gate.check("dom"); return this.#data.nodeType === 3 || this.#data.nodeType === 8 ? this.#data.text : null; }
		set data(value) { this.#gate.check("dom"); if(this.#data.nodeType === 3 || this.#data.nodeType === 8){this.#data.text = value == null ? "" : String(value);emitMutation(this.#data,"text",{value:this.#data.text});} }
		get textContent() { this.#gate.check("dom"); if(this.#data.nodeType === 3 || this.#data.nodeType === 8)return this.#data.text; return this.#data.text + this.#data.children.map(c=>new PpermNode(c,this.#gate).textContent).join(""); }
		set textContent(value) { this.#gate.check("dom"); const d = this.#data; for(const c of d.children){c.parent = null;setConnected(c,false);} d.children = [];d.text = value == null ? "" : String(value);emitMutation(d,"text",{value:d.text}); }
		get innerText() { this.#gate.check("dom"); if(this.#data.nodeType === 3 || this.#data.nodeType === 8)return this.#data.text; return this.#data.text + this.#data.children.map(c=>new PpermNode(c,this.#gate).innerText).join(""); }
		set innerText(value) { this.#gate.check("dom"); const d = this.#data; for(const c of d.children){c.parent = null;setConnected(c,false);} d.children = [];d.text = value == null ? "" : String(value);emitMutation(d,"innerText",{value:d.text}); }
		get style() { this.#gate.check("dom"); return this.#style; }
		get classList() { this.#gate.check("dom"); return this.#classList; }
		get isConnected() { this.#gate.check("dom"); return this.#data.connected; }
		get ownerDocument() { this.#gate.check("dom"); return documentProxy; }
		get attributes() { this.#gate.check("dom"); return Object.entries(this.#data.attributes).filter(([name]) => !name.toLowerCase().startsWith("on") && !blockedAttributes.has(name.toLowerCase())).map(([name,value])=>({name,value})); }
		get parentNode() { this.#gate.check("dom"); if (this.#data === root) return documentProxy; return this.#data.parent ? new PpermNode(this.#data.parent, this.#gate) : null; }
		get parentElement() { this.#gate.check("dom"); return this.#data.parent?.nodeType === 1 ? new PpermNode(this.#data.parent,this.#gate) : null; }
		get children() { this.#gate.check("dom"); return this.#data.children.filter(c=>c.nodeType === 1).map(c=>new PpermNode(c,this.#gate)); }
		get childNodes() { this.#gate.check("dom"); return this.#data.children.map(c=>new PpermNode(c,this.#gate)); }
		get firstChild() { this.#gate.check("dom"); const c = this.#data.children[0];return c ? new PpermNode(c,this.#gate) : null; }
		get lastChild() { this.#gate.check("dom"); const a = this.#data.children;return a.length ? new PpermNode(a[a.length - 1],this.#gate) : null; }
		get firstElementChild() { this.#gate.check("dom"); const c = this.#data.children.find(x=>x.nodeType === 1);return c ? new PpermNode(c,this.#gate) : null; }
		get lastElementChild() { this.#gate.check("dom"); for(let i = this.#data.children.length - 1;i >= 0;i--)if(this.#data.children[i].nodeType === 1)return new PpermNode(this.#data.children[i],this.#gate);return null; }
		get nextSibling() { this.#gate.check("dom"); if(!this.#data.parent)return null;const a = this.#data.parent.children,i = a.indexOf(this.#data);return a[i + 1] ? new PpermNode(a[i + 1],this.#gate) : null; }
		get previousSibling() { this.#gate.check("dom"); if(!this.#data.parent)return null;const a = this.#data.parent.children,i = a.indexOf(this.#data);return i > 0 ? new PpermNode(a[i - 1],this.#gate) : null; }
		get nextElementSibling() { this.#gate.check("dom"); if(!this.#data.parent)return null;const a = this.#data.parent.children.filter(c=>c.nodeType === 1),i = a.indexOf(this.#data);return a[i + 1] ? new PpermNode(a[i + 1],this.#gate) : null; }
		get previousElementSibling() { this.#gate.check("dom"); if(!this.#data.parent)return null;const a = this.#data.parent.children.filter(c=>c.nodeType === 1),i = a.indexOf(this.#data);return i > 0 ? new PpermNode(a[i - 1],this.#gate) : null; }
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

		hasChildNodes() { this.#gate.check("dom"); return this.#data.children.length > 0; }
		get href() { this.#gate.check("dom"); return this.#data.attributes.href ?? ""; }
		set href(value) { this.#gate.check("dom"); const text = String(value);safeAttribute("href",text);this.#data.attributes.href = text;emitMutation(this.#data,"urlProperty",{property:"href",value:text}); }
		get src() { this.#gate.check("dom"); return this.#data.attributes.src ?? ""; }
		set src(value) { this.#gate.check("dom"); const text = String(value);safeAttribute("src",text);this.#data.attributes.src = text;emitMutation(this.#data,"urlProperty",{property:"src",value:text}); }
		get poster() { this.#gate.check("dom"); return this.#data.attributes.poster ?? ""; }
		set poster(value) { this.#gate.check("dom"); const text = String(value);safeAttribute("poster",text);this.#data.attributes.poster = text;emitMutation(this.#data,"urlProperty",{property:"poster",value:text}); }
		get value() { this.#gate.check("dom"); return this.#data.value ?? this.#data.attributes.value ?? ""; }
		set value(value) { this.#gate.check("dom"); if(value !== null && (typeof value === "object" || typeof value === "function"))throw new TypeError("DOM property value must be primitive");const text = String(value);this.#data.value = text;emitMutation(this.#data,"formProperty",{property:"value",value:text}); }
		get checked() { this.#gate.check("dom"); return this.#data.checked ?? Object.hasOwn(this.#data.attributes, "checked"); }
		set checked(value) { this.#gate.check("dom"); this.#data.checked = Boolean(value);emitMutation(this.#data,"formProperty",{property:"checked",value:this.#data.checked}); }
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

		get innerHTML() {
			this.#gate.check("dom");
			if (!htmlEnabled) denied("innerHTML");
			if (this.#data.nodeType !== 1) return escapeHTMLText(this.#data.text ?? "");
			return serializeHTML(this.#data.children);
		}
		set innerHTML(value) {
			this.#gate.check("dom");
			if (!htmlEnabled) denied("innerHTML");
			if (this.#data.nodeType !== 1) throw new DOMException("innerHTML is only supported on element nodes", "HierarchyRequestError");
			const text = String(value);
			if (text.length > htmlLimits.length) throw new DOMException("HTML content is too large", "NotAllowedError");
			const parsed = sanitizeHTMLTree(parseHTMLFragment(text));
			dropHTMLChildren(this.#data);
			this.#data.text = "";
			this.#data.children = parsed.map(node => makeData(htmlToNodeData(node, this.#data.connected), this.#data));
			emitMutation(this.#data, "html", { children: this.#data.children.map(serialize) });
		}
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
			if (safeName === "id") this.#data.idName = "";
			if (safeName === "class") this.#data.className = "";
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
		set title(value) { this.#gate.check("dom"); denied("document.title"); }
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

	function freezeValue(value) {
		if (value && typeof value === "object") {
			for (const key of Object.keys(value)) freezeValue(value[key]);
			Object.freeze(value);
		}
		return value;
	}

	const natives = {
		fetch: typeof self.fetch === "function" ? self.fetch.bind(self) : undefined,
		XMLHttpRequest: self.XMLHttpRequest,
		WebSocket: self.WebSocket,
		EventSource: self.EventSource,
		setTimeout: self.setTimeout.bind(self),
		clearTimeout: self.clearTimeout.bind(self),
		setInterval: self.setInterval.bind(self),
		clearInterval: self.clearInterval.bind(self),
		queueMicrotask: typeof self.queueMicrotask === "function" ? self.queueMicrotask.bind(self) : callback => Promise.resolve().then(callback),
		performanceNow: typeof self.performance?.now === "function" ? self.performance.now.bind(self.performance) : () => 0,
		AsyncFunction: Object.getPrototypeOf(async function () {}).constructor,
		Function: self.Function,
		eval: self.eval,
		addEventListener: self.addEventListener
	};

	function guardedMicrotask(callback) {
		if (typeof callback !== "function") throw new TypeError("queueMicrotask callback must be a function");
		return natives.queueMicrotask(() => { tick(); callback(); });
	}

	function createTimers() {
		const wrap = (native, isInterval) => (callback, delay, ...args) => {
			if (typeof callback === "string") throw new DOMException("String timers are not permitted", "NotAllowedError");
			if (typeof callback !== "function") throw new TypeError("Timer callback must be a function");
			if (halted) throw new DOMException("Execution stopped", "QuotaExceededError");
			if (++timerCalls > runtimeLimits.timerCalls) halt("timerCalls");
			if (activeTimers >= runtimeLimits.timers) throw new DOMException("Active timer limit exceeded", "QuotaExceededError");
			const actual = Math.max(runtimeLimits.minTimerDelayMs, Math.min(2147483647, Number(delay) || 0));
			let handle = null;
			const wrapped = (...callArgs) => {
				if (!isInterval) { activeTimers = Math.max(0, activeTimers - 1); timerHandles.delete(handle); }
				tick();
				return callback(...callArgs);
			};
			handle = native(wrapped, actual, ...args);
			activeTimers++;
			timerHandles.set(handle, { isInterval });
			return handle;
		};
		const clear = native => handle => {
			if (timerHandles.delete(handle)) activeTimers = Math.max(0, activeTimers - 1);
			native(handle);
		};
		return {
			setTimeout: wrap(natives.setTimeout, false),
			setInterval: wrap(natives.setInterval, true),
			clearTimeout: clear(natives.clearTimeout),
			clearInterval: clear(natives.clearInterval)
		};
	}

	function extractFetchInit(init) {
		const out = { method: "GET" };
		if (!init || typeof init !== "object") return out;
		if (typeof init.method === "string") out.method = init.method;
		if (init.body != null) out.body = typeof init.body === "string" ? init.body : String(init.body);
		const headers = [];
		const push = (name, value) => headers.push([String(name), String(value)]);
		if (init.headers) {
			if (Array.isArray(init.headers)) {
				for (const entry of init.headers) if (Array.isArray(entry) && entry.length >= 2) push(entry[0], entry[1]);
			} else if (typeof init.headers.forEach === "function") {
				init.headers.forEach((value, name) => push(name, value));
			} else {
				for (const [name, value] of Object.entries(init.headers)) push(name, value);
			}
		}
		if (headers.length) out.headers = headers;
		return out;
	}

	function createNetworkApi() {
		const request = (api, input, init) => new Promise((resolve, reject) => {
			if (stopped || !channel) { reject(new DOMException("Process has been terminated", "AbortError")); return; }
			try { gate.check(api); } catch (error) { reject(error); return; }
			let url;
			try { url = new nativeURL(String(input?.href ?? input), baseURI).href; }
			catch { reject(new TypeError("Invalid network URL")); return; }
			const requestId = netRequestId++;
			netPending.set(requestId, { resolve, reject });
			channel.postMessage({ type: "net", api, requestId, url, init: extractFetchInit(init) });
		});
		const build = result => {
			const withBody = result.status !== 204 && result.status !== 205 && result.status !== 304;
			const response = new nativeResponse(withBody ? result.body : null, {
				status: result.status,
				statusText: result.statusText,
				headers: result.headers ?? []
			});
			try { Object.defineProperty(response, "url", { value: result.url ?? "", configurable: true }); } catch {}
			return response;
		};
		return {
			request,
			build,
			fetch: (input, init) => request("fetch", input, init).then(build)
		};
	}

	function createXhrApi(network) {
		return class PpermXMLHttpRequest {
			constructor() {
				this.readyState = 0;
				this.status = 0;
				this.statusText = "";
				this.responseText = "";
				this.response = null;
				this.responseType = "";
				this.timeout = 0;
				this.withCredentials = false;
				this.onreadystatechange = null;
				this.onload = null;
				this.onerror = null;
				this.ontimeout = null;
				this.onloadend = null;
				this._method = "GET";
				this._url = "";
				this._headers = [];
				this._responseHeaders = [];
				this._aborted = false;
			}
			open(method, url) {
				gate.check("xmlHttpRequest");
				this._method = String(method);
				this._url = String(url);
				this._change(1);
			}
			setRequestHeader(name, value) { this._headers.push([String(name), String(value)]); }
			getResponseHeader(name) {
				const key = String(name).toLowerCase();
				const entry = this._responseHeaders.find(pair => String(pair[0]).toLowerCase() === key);
				return entry ? entry[1] : null;
			}
			getAllResponseHeaders() { return this._responseHeaders.map(pair => pair[0] + ": " + pair[1]).join("\r\n") + "\r\n"; }
			abort() { this._aborted = true; }
			_change(state) { this.readyState = state; if (typeof this.onreadystatechange === "function") this.onreadystatechange({ target: this }); }
			send(body) {
				gate.check("xmlHttpRequest");
				Promise.resolve().then(() => this._aborted ? null : network.request("xmlHttpRequest", this._url, {
					method: this._method,
					headers: this._headers,
					body: body == null ? null : String(body)
				})).then(result => {
					if (this._aborted || !result) return;
					this.status = result.status;
					this.statusText = result.statusText;
					this._responseHeaders = result.headers ?? [];
					const value = new TextDecoder().decode(result.body);
					this.responseText = value;
					if (this.responseType === "json") { try { this.response = JSON.parse(value); } catch { this.response = null; } }
					else if (this.responseType === "arraybuffer") this.response = result.body;
					else this.response = value;
					this._change(4);
					if (typeof this.onload === "function") this.onload({ target: this });
					if (typeof this.onloadend === "function") this.onloadend({ target: this });
				}).catch(() => {
					if (this._aborted) return;
					if (typeof this.onerror === "function") this.onerror({ target: this });
					if (typeof this.onloadend === "function") this.onloadend({ target: this });
				});
			}
		};
	}

	function createConnectionApi(capability, Native, max) {
		if (!Native) return deniedGlobal(capability);
		return new Proxy(Native, {
			construct(target, args, newTarget) {
				gate.check(capability);
				if (++connections > max) throw new DOMException("Connection limit exceeded", "QuotaExceededError");
				return Reflect.construct(target, args, newTarget);
			}
		});
	}

	function startHeartbeat() {
		heartbeatHandle = natives.setInterval(() => {
			if (!stopped && channel) channel.postMessage({ type: "heartbeat", steps });
		}, Math.max(25, Math.min(1000, runtimeLimits.heartbeatMs)));
	}

	function shutdown() {
		stopped = true;
		if (heartbeatHandle !== null) { try { natives.clearInterval(heartbeatHandle); } catch {} }
		heartbeatHandle = null;
		for (const handle of timerHandles.keys()) { try { natives.clearTimeout(handle); } catch {} }
		timerHandles.clear();
		for (const pending of storagePending.values()) pending.reject(new DOMException("Process has been terminated", "AbortError"));
		storagePending.clear();
		for (const pending of netPending.values()) pending.reject(new DOMException("Process has been terminated", "AbortError"));
		netPending.clear();
	}

	const blockedNames = [
		"fetch", "XMLHttpRequest", "WebSocket", "EventSource", "indexedDB", "caches", "cookieStore",
		"Worker", "SharedWorker", "ServiceWorker", "ServiceWorkerRegistration", "importScripts",
		"close", "postMessage", "onmessage", "onmessageerror", "onerror", "onoffline", "ononline",
		"onlanguagechange", "onrejectionhandled", "onunhandledrejection", "onconnect",
		"BroadcastChannel", "MessageChannel", "MessagePort", "WorkerGlobalScope",
		"DedicatedWorkerGlobalScope", "SharedWorkerGlobalScope", "ServiceWorkerGlobalScope",
		"WorkerLocation", "WorkerNavigator", "navigator", "location", "performance", "scheduler",
		"origin", "isSecureContext", "crossOriginIsolated", "reportError", "constructor",
		"URL", "Blob", "File", "FileReader", "FileReaderSync", "FormData", "createImageBitmap",
		"ImageData", "ImageBitmap", "OffscreenCanvas", "Notification", "PushManager",
		"PaymentRequest", "WebTransport", "WebSocketStream", "RTCDataChannel", "RTCPeerConnection",
		"setTimeout", "setInterval", "clearTimeout", "clearInterval"
	];

	const frozenNames = [
		"Object", "Function", "Array", "String", "Number", "Boolean", "Symbol", "BigInt",
		"RegExp", "Date", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Promise", "Proxy",
		"Reflect", "Math", "JSON", "Error", "EvalError", "RangeError", "ReferenceError",
		"SyntaxError", "TypeError", "URIError", "AggregateError", "ArrayBuffer",
		"SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray",
		"Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float16Array", "Float32Array",
		"Float64Array", "BigInt64Array", "BigUint64Array", "Atomics", "Intl", "WebAssembly",
		"DOMException", "EventTarget", "Event", "CustomEvent", "MessageEvent", "ErrorEvent",
		"TextEncoder", "TextDecoder", "URLSearchParams", "AbortController", "AbortSignal",
		"structuredClone", "console", "crypto"
	];

	const exposableGlobals = new Set([
		"URL", "URLSearchParams", "Blob", "File", "FormData", "Response", "Headers", "Request",
		"AbortController", "AbortSignal", "TextEncoder", "TextDecoder", "crypto", "console",
		"atob", "btoa", "structuredClone", "queueMicrotask", "performance", "navigator", "location"
	]);

	function installLockdown(options) {
		const { timers, allowEval, highResolutionTime, globals } = options;
		const chain = [];
		for (let current = self; current; current = Object.getPrototypeOf(current)) chain.push(current);
		const denyCompile = function () { throw new DOMException("Dynamic code generation is disabled", "NotAllowedError"); };
		const coarseNow = () => Math.floor(natives.performanceNow() / 10) * 10;
		const replacements = new Map([
			["setTimeout", timers.setTimeout],
			["setInterval", timers.setInterval],
			["clearTimeout", timers.clearTimeout],
			["clearInterval", timers.clearInterval],
			["queueMicrotask", guardedMicrotask],
			["performance", Object.freeze({ now: highResolutionTime ? () => natives.performanceNow() : coarseNow })],
			["navigator", Object.freeze({ userAgent: "", language: "", languages: Object.freeze([]), hardwareConcurrency: 0, onLine: true })],
			["location", Object.freeze({ href: "", origin: "null", protocol: "data:", host: "", hostname: "", port: "", pathname: "", search: "", hash: "" })],
			["origin", "null"],
			["Function", allowEval ? natives.Function : denyCompile],
			["eval", allowEval ? natives.eval : denyCompile]
		]);
		for (const name of globals) {
			if (!exposableGlobals.has(name) || replacements.has(name)) continue;
			const value = self[name];
			if (value === undefined) continue;
			replacements.set(name, value);
		}
		for (let index = 0; index < Math.min(3, chain.length); index++) {
			for (const name of blockedNames) {
				if (!Object.getOwnPropertyDescriptor(chain[index], name)) continue;
				if (index === 0 && replacements.has(name)) continue;
				Object.defineProperty(chain[index], name, { configurable: false, enumerable: false, writable: false, value: undefined });
			}
		}
		for (const [name, value] of replacements) {
			try { Object.defineProperty(self, name, { configurable: false, enumerable: false, writable: false, value }); } catch {}
		}
		for (const name of blockedNames) {
			if (replacements.has(name) || Object.prototype.hasOwnProperty.call(self, name)) continue;
			Object.defineProperty(self, name, { configurable: false, enumerable: false, writable: false, value: undefined });
		}
		if (!allowEval) {
			for (const prototype of [
				natives.Function.prototype,
				Object.getPrototypeOf(async function () {}),
				Object.getPrototypeOf(function* () {}),
				Object.getPrototypeOf(async function* () {})
			]) {
				if (!prototype) continue;
				try { Object.defineProperty(prototype, "constructor", { configurable: false, writable: false, value: denyCompile }); } catch {}
			}
			try { Object.freeze(natives.Function.prototype); } catch {}
		}
		if (chain[3]) {
			Object.defineProperty(chain[3], "addEventListener", {
				configurable: false,
				writable: false,
				value: function (type, listener, options) {
					if (this === self && String(type) === "message") throw new DOMException("Global message listeners are not permitted", "NotAllowedError");
					return Reflect.apply(natives.addEventListener, this, [type, listener, options]);
				}
			});
		}
		for (const name of frozenNames) {
			const value = self[name];
			if (!value) continue;
			try {
				Object.freeze(value);
				if (typeof value === "function" && value.prototype) Object.freeze(value.prototype);
			} catch {}
		}
		for (const prototype of [
			Object.getPrototypeOf(async function () {}),
			Object.getPrototypeOf(function* () {}),
			Object.getPrototypeOf(async function* () {}),
			chain[1], chain[2], chain[3]
		]) {
			if (prototype) { try { Object.freeze(prototype); } catch {} }
		}
	}

	function createStorageApi(gate) {
		const call = (op, args) => new Promise((resolve, reject) => {
			if (stopped || !channel) {
				reject(new DOMException("Process has been terminated", "AbortError"));
				return;
			}
			try {
				gate.check("storage");
			} catch (error) {
				reject(error);
				return;
			}
			const requestId = storageRequestId++;
			storagePending.set(requestId, { resolve, reject });
			channel.postMessage({ type: "storage", requestId, op, args });
		});
		return Object.freeze({
			get: key => call("get", [key]),
			set: (key, value) => call("set", [key, value]),
			delete: key => call("delete", [key]),
			keys: () => call("keys", []),
			clear: () => call("clear", [])
		});
	}

	function onPortMessage(event) {
		const message = event.data;
		if (message?.type === "event") {
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
		} else if (message?.type === "storageResult" || message?.type === "storageError") {
			const pending = storagePending.get(message.requestId);
			if (!pending) return;
			storagePending.delete(message.requestId);
			if (message.type === "storageResult") pending.resolve(message.value);
			else {
				const error = new Error(message.error?.message ?? "Storage operation failed");
				Object.defineProperty(error, "name", { value: message.error?.name ?? "Error", configurable: true, writable: true });
				pending.reject(error);
			}
		} else if (message?.type === "netResult" || message?.type === "netError") {
			const pending = netPending.get(message.requestId);
			if (!pending) return;
			netPending.delete(message.requestId);
			if (message.type === "netResult") pending.resolve(message);
			else {
				const error = new Error(message.error?.message ?? "Network request failed");
				Object.defineProperty(error, "name", { value: message.error?.name ?? "Error", configurable: true, writable: true });
				pending.reject(error);
			}
		} else if (message?.type === "shutdown") {
			shutdown();
		}
	}

	function onInit(event) {
		if (initialized || event.data?.type !== "init") return;
		initialized = true;
		const message = event.data;
		channel = event.ports?.[0];
		if (!channel) return;
		channel.addEventListener("message", onPortMessage);
		channel.start();
		try {
			const policy = freezeValue(JSON.parse(JSON.stringify(message.policy ?? {})));
			runtimeLimits = {
				steps: policy.execution.steps,
				timers: policy.timers.maxActive,
				timerCalls: policy.timers.maxCalls,
				minTimerDelayMs: policy.timers.minDelayMs,
				heartbeatMs: policy.execution.heartbeatMs,
				messagesPerSecond: policy.messages.perSecond
			};
			runtime = policy.runtime;
			baseURI = String(message.baseURI ?? baseURI);
			tickName = typeof message.tick === "string" ? message.tick : null;
			remotePolicy = policy.dom.remoteResources;
			remoteResources = !!remotePolicy.enabled;
			htmlEnabled = !!policy.dom.innerHTML;
			const htmlPolicyData = message.htmlPolicy ?? {};
			htmlElements = new Set(Array.isArray(htmlPolicyData.elements) ? htmlPolicyData.elements : []);
			htmlAttributes = new Set(Array.isArray(htmlPolicyData.attributes) ? htmlPolicyData.attributes : []);
			htmlVoidElements = new Set(Array.isArray(htmlPolicyData.voidElements) ? htmlPolicyData.voidElements : []);
			htmlLimits = htmlPolicyData.limits ?? htmlLimits;
			gate = new PermissionGate(policy);
			root = makeData(message.snapshot);
			documentTitle = String(message.documentTitle ?? "");
			nextId = Math.max(nextId, ...Array.from(nodes.keys(), id => Number(id) + 1));
			documentProxy = new PpermDocument(gate);
			const timers = createTimers();
			installLockdown({ timers, allowEval: runtime.allowEval, highResolutionTime: runtime.highResolutionTime, globals: runtime.globals });
			const network = createNetworkApi();
			const fetchApi = policy.network.fetch.enabled ? network.fetch : deniedGlobal("fetch");
			const XhrApi = policy.network.xmlHttpRequest.enabled ? createXhrApi(network) : deniedGlobal("XMLHttpRequest");
			const WebSocketApi = policy.network.webSocket.enabled ? createConnectionApi("webSocket", natives.WebSocket, policy.network.webSocket.maxConnections) : deniedGlobal("WebSocket");
			const EventSourceApi = policy.network.eventSource.enabled ? createConnectionApi("eventSource", natives.EventSource, policy.network.eventSource.maxConnections) : deniedGlobal("EventSource");
			const storageApi = policy.storage.enabled ? createStorageApi(gate) : deniedGlobal("storage");
			const names = ["postMessage", "policy", "document", "fetch", "WebSocket", "EventSource", "XMLHttpRequest", "indexedDB", "caches", "storage"];
			const args = [
				value => emit("userMessage", { value }),
				policy,
				policy.dom.enabled ? documentProxy : undefined,
				fetchApi, WebSocketApi, EventSourceApi, XhrApi,
				deniedGlobal("indexedDB"), deniedGlobal("caches"), storageApi
			];
			if (tickName) { names.push(tickName); args.push(tick); }
			const run = new natives.AsyncFunction(...names, message.code);
			emit("ready");
			startHeartbeat();
			Promise.resolve(run(...args)).then(value => emit("done", { value, steps })).catch(error => emit("error", { error: errorPayload(error), steps }));
		} catch (error) {
			emit("error", { error: errorPayload(error), steps });
		}
	}

	self.addEventListener("message", onInit);
}
