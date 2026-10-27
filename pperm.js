import { workerMain } from "./pperm-worker.js";
import { instrument, loadParser } from "./pperm-instrument.js";

const defaultMethods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const forbiddenRequestHeaders = new Set([
	"cookie", "authorization", "proxy-authorization", "host", "origin", "referer",
	"content-length", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version"
]);

function objectOf(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function listOf(value) {
	return Array.isArray(value) ? value.map(item => String(item)) : [];
}

function limitOf(value, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	if (value === Infinity || value === "Infinity" || value === "unlimited") return Infinity;
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function flagOf(value) {
	return value === true;
}

function allowList(value) {
	if (value === "*") return ["*"];
	return Array.isArray(value) ? listOf(value) : [];
}

function httpRule(value) {
	if (value === true) value = { allow: "*" };
	const options = objectOf(value);
	const allow = allowList(options.allow);
	return {
		enabled: options.enabled !== false && allow.length > 0,
		allow,
		methods: (Array.isArray(options.methods) ? listOf(options.methods) : [...defaultMethods]).map(item => item.toUpperCase()),
		timeoutMs: limitOf(options.timeoutMs, 5000),
		maxRequestBytes: limitOf(options.maxRequestBytes, 65536),
		maxResponseBytes: limitOf(options.maxResponseBytes, 1048576)
	};
}

function socketRule(value) {
	if (value === true) value = { allow: "*" };
	const options = objectOf(value);
	const allow = allowList(options.allow);
	return {
		enabled: options.enabled !== false && allow.length > 0,
		allow,
		maxConnections: limitOf(options.maxConnections, 2)
	};
}

function remoteRule(value) {
	if (value === true) return { enabled: true, allow: ["*"] };
	if (Array.isArray(value)) return { enabled: value.length > 0, allow: listOf(value) };
	const options = objectOf(value);
	const allow = allowList(options.allow);
	return { enabled: options.enabled !== false && allow.length > 0, allow };
}

function normalizePolicy(raw) {
	const source = objectOf(raw);
	const network = objectOf(source.network);
	const storage = objectOf(source.storage);
	const dom = objectOf(source.dom);
	const html = objectOf(dom.html);
	const runtime = objectOf(source.runtime);
	const execution = objectOf(source.execution);
	const messages = objectOf(source.messages);
	const timers = objectOf(source.timers);
	const heartbeatMs = limitOf(execution.heartbeatMs, 100);
	const stalledMs = Math.max(limitOf(execution.stalledMs, 500), heartbeatMs * 2);
	return {
		network: {
			maxRequests: limitOf(network.maxRequests, 100),
			maxBytes: limitOf(network.maxBytes, 4194304),
			perSecond: limitOf(network.perSecond, 20),
			fetch: httpRule(network.fetch),
			xmlHttpRequest: httpRule(network.xmlHttpRequest),
			webSocket: socketRule(network.webSocket),
			eventSource: socketRule(network.eventSource)
		},
		storage: {
			enabled: storage.enabled === true,
			maxOps: limitOf(storage.maxOps, 10000),
			maxKeys: limitOf(storage.maxKeys, 1000),
			maxBytes: limitOf(storage.maxBytes, 1048576),
			maxValueBytes: limitOf(storage.maxValueBytes, 65536)
		},
		dom: {
			enabled: dom.enabled === true,
			root: typeof dom.root === "string" && dom.root ? dom.root : "body",
			remoteResources: remoteRule(dom.remoteResources),
			innerHTML: flagOf(dom.innerHTML),
			allowTags: Array.isArray(dom.allowTags) ? listOf(dom.allowTags).map(item => item.toLowerCase()) : null,
			denyTags: Array.isArray(dom.denyTags) ? listOf(dom.denyTags).map(item => item.toLowerCase()) : [],
			allowAttributes: Array.isArray(dom.allowAttributes) ? listOf(dom.allowAttributes).map(item => item.toLowerCase()) : null,
			allowEvents: Array.isArray(dom.allowEvents) ? listOf(dom.allowEvents).map(item => item.toLowerCase()) : null,
			maxMutations: limitOf(dom.maxMutations, 50000),
			maxNodes: limitOf(dom.maxNodes, 20000),
			maxBytes: limitOf(dom.maxBytes, 4194304),
			maxDepth: limitOf(dom.maxDepth, 64),
			html: {
				maxLength: limitOf(html.maxLength, 262144),
				maxNodes: limitOf(html.maxNodes, 2000),
				maxAttributeLength: limitOf(html.maxAttributeLength, 4096)
			}
		},
		runtime: {
			allowEval: flagOf(runtime.allowEval),
			globals: Array.isArray(runtime.globals) ? listOf(runtime.globals) : [],
			highResolutionTime: flagOf(runtime.highResolutionTime)
		},
		execution: {
			steps: limitOf(execution.steps, 10000000),
			wallMs: limitOf(execution.wallMs, 10000),
			startMs: limitOf(execution.startMs, 5000),
			heartbeatMs,
			stalledMs
		},
		messages: {
			maxCount: limitOf(messages.maxCount, 100000),
			maxBytes: limitOf(messages.maxBytes, 33554432),
			perSecond: limitOf(messages.perSecond, 4000)
		},
		timers: {
			maxActive: limitOf(timers.maxActive, 64),
			maxCalls: limitOf(timers.maxCalls, 10000),
			minDelayMs: limitOf(timers.minDelayMs, 4)
		}
	};
}

function deriveLimits(policy) {
	return {
		steps: policy.execution.steps,
		wallMs: policy.execution.wallMs,
		startMs: policy.execution.startMs,
		heartbeatMs: policy.execution.heartbeatMs,
		stalledMs: policy.execution.stalledMs,
		messages: policy.messages.maxCount,
		messageBytes: policy.messages.maxBytes,
		messagesPerSecond: policy.messages.perSecond,
		domMutations: policy.dom.maxMutations,
		domNodes: policy.dom.maxNodes,
		domBytes: policy.dom.maxBytes,
		htmlLength: policy.dom.html.maxLength,
		htmlNodes: policy.dom.html.maxNodes,
		htmlDepth: policy.dom.maxDepth,
		htmlAttributeLength: policy.dom.html.maxAttributeLength,
		netRequests: policy.network.maxRequests,
		netBytes: policy.network.maxBytes,
		netRequestsPerSecond: policy.network.perSecond,
		storageOps: policy.storage.maxOps,
		storageKeys: policy.storage.maxKeys,
		storageBytes: policy.storage.maxBytes,
		storageValueBytes: policy.storage.maxValueBytes,
		timers: policy.timers.maxActive,
		timerCalls: policy.timers.maxCalls,
		minTimerDelayMs: policy.timers.minDelayMs
	};
}

function mergePolicies(base, extra) {
	const left = objectOf(base);
	const right = objectOf(extra);
	const result = {};
	for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
		const a = left[key];
		const b = right[key];
		if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
			result[key] = mergePolicies(a, b);
		} else {
			result[key] = b === undefined ? a : b;
		}
	}
	return result;
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
	try { target = new URL(value, globalThis.location?.href ?? "https://pperm.invalid/"); }
	catch { return false; }
	if (target.protocol !== "http:" && target.protocol !== "https:") return false;
	if (pattern === "*") return true;
	if (pattern.startsWith("/")) {
		const base = globalThis.location?.origin ?? "";
		if (!base) return false;
		return globToRegExp(base + pattern).test(target.protocol + "//" + target.host + target.pathname + target.search);
	}
	const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(pattern) ? pattern : "https://" + pattern;
	if (!/^https?:\/\//i.test(normalized)) return false;
	return globToRegExp(normalized).test(target.protocol + "//" + target.host + target.pathname + target.search);
}

function estimateSize(value, depth = 0, budget = null) {
	const state = budget ?? { left: 20000 };
	if (depth > 8 || state.left-- <= 0) return 0;
	if (typeof value === "string") return value.length * 2 + 8;
	if (value === null || value === undefined) return 8;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return 16;
	if (value instanceof ArrayBuffer) return value.byteLength + 8;
	if (ArrayBuffer.isView(value)) return value.byteLength + 8;
	if (Array.isArray(value)) {
		let total = 8;
		for (const item of value) total += estimateSize(item, depth + 1, state);
		return total;
	}
	if (typeof value === "object") {
		let total = 8;
		for (const key of Object.keys(value)) {
			total += key.length + 8 + estimateSize(value[key], depth + 1, state);
			if (state.left <= 0) break;
		}
		return total;
	}
	return 8;
}

function serializeError(error) {
	return { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack };
}

class QuotaLedger {
	constructor(limits, onViolation) {
		this.limits = { ...limits };
		this.usage = Object.fromEntries(Object.keys(limits).map(key => [key, 0]));
		this.windows = new Map();
		this.onViolation = onViolation;
		this.violation = null;
	}

	consume(name, amount = 1) {
		const max = this.limits[name];
		if (max === undefined || max === null) return;
		if (max === Infinity) { this.usage[name] += amount; return; }
		if (this.usage[name] + amount > max) this.fail(name, amount);
		this.usage[name] += amount;
	}

	gauge(name, value) {
		const max = this.limits[name];
		if (max === undefined || max === null || max === Infinity) { this.usage[name] = value; return; }
		if (value > max) this.fail(name, value - this.usage[name]);
		this.usage[name] = value;
	}

	rate(name, amount = 1, windowMs = 1000) {
		const max = this.limits[name];
		if (max === undefined || max === null || max === Infinity) return;
		const now = performance.now();
		const window = this.windows.get(name) ?? { start: now, count: 0 };
		if (now - window.start >= windowMs) { window.start = now; window.count = 0; }
		window.count += amount;
		this.windows.set(name, window);
		if (window.count > max) this.fail(name, amount, window.count - amount);
	}

	fail(name, amount, used = this.usage[name]) {
		const error = new DOMException("Quota exceeded: " + name + " (limit " + this.limits[name] + ", used " + used + ", requested " + amount + ")", "QuotaExceededError");
		error.quota = name;
		error.limit = this.limits[name];
		error.used = this.usage[name];
		this.onViolation?.(error);
		throw error;
	}

	snapshot() {
		return { ...this.usage, limits: { ...this.limits } };
	}
}

class Scheduler {
	#limit = 4;
	#active = 0;
	#queue = [];

	configure(value) {
		const next = limitOf(value, this.#limit);
		if (next < 1) return;
		this.#limit = Math.floor(next);
		this.#drain();
	}

	acquire() {
		if (this.#active < this.#limit) {
			this.#active++;
			return Promise.resolve(() => this.release());
		}
		return new Promise(resolve => this.#queue.push(resolve));
	}

	release() {
		this.#active = Math.max(0, this.#active - 1);
		this.#drain();
	}

	#drain() {
		while (this.#queue.length && this.#active < this.#limit) {
			const next = this.#queue.shift();
			this.#active++;
			next(() => this.release());
		}
	}

	get active() { return this.#active; }
	get queued() { return this.#queue.length; }
	get limit() { return this.#limit; }
}

const scheduler = new Scheduler();

async function readLimited(response, maxBytes, ledger) {
	if (!response.body) return new ArrayBuffer(0);
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	let exceeded = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			ledger.consume("netBytes", value.byteLength);
			total += value.byteLength;
			if (total > maxBytes) { exceeded = true; await reader.cancel(); break; }
			chunks.push(value);
		}
	} finally {
		try { reader.releaseLock(); } catch {}
	}
	if (exceeded) throw new DOMException("Network response exceeds the response byte limit", "QuotaExceededError");
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
	return output.buffer;
}

class NetBroker {
	constructor(network, ledger) {
		this.network = network;
		this.ledger = ledger;
	}

	#authorize(rule, input, method) {
		if (!rule?.enabled) throw new DOMException("Network access is not permitted", "NotAllowedError");
		let url;
		try { url = new URL(String(input), globalThis.location?.href ?? "https://pperm.invalid/"); }
		catch { throw new DOMException("Invalid network URL", "NotAllowedError"); }
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new DOMException("Unsupported network protocol", "NotAllowedError");
		if (!rule.methods.includes(method)) throw new DOMException("HTTP method is not permitted: " + method, "NotAllowedError");
		if (!rule.allow.some(pattern => matchURL(pattern, url.href))) throw new DOMException("Network origin is not permitted: " + url.origin, "NotAllowedError");
		return url;
	}

	async fetch(message) {
		const rule = this.network[message.api === "xmlHttpRequest" ? "xmlHttpRequest" : "fetch"];
		const init = objectOf(message.init);
		const method = String(init.method ?? "GET").toUpperCase();
		const url = this.#authorize(rule, message.url ?? "", method);
		this.ledger.consume("netRequests", 1);
		this.ledger.rate("netRequestsPerSecond", 1);
		const body = init.body == null ? null : String(init.body);
		if (body && body.length > rule.maxRequestBytes) throw new DOMException("Request body exceeds the request byte limit", "QuotaExceededError");
		if (body) this.ledger.consume("netBytes", body.length);
		const headers = {};
		const collect = (name, value) => {
			const key = String(name).toLowerCase();
			if (forbiddenRequestHeaders.has(key) || !/^[a-z0-9-]+$/.test(key)) return;
			headers[String(name)] = String(value);
		};
		if (Array.isArray(init.headers)) {
			for (const entry of init.headers) if (Array.isArray(entry) && entry.length >= 2) collect(entry[0], entry[1]);
		} else {
			for (const [name, value] of Object.entries(objectOf(init.headers))) collect(name, value);
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), rule.timeoutMs);
		let response;
		try {
			response = await fetch(url.href, {
				method, headers, body, credentials: "omit", referrerPolicy: "no-referrer",
				redirect: "error", cache: "no-store", mode: "cors", signal: controller.signal
			});
		} catch (error) {
			throw new Error("Network request failed: " + (error?.message ?? String(error)));
		} finally {
			clearTimeout(timer);
		}
		const buffer = await readLimited(response, rule.maxResponseBytes, this.ledger);
		const responseHeaders = [];
		for (const [name, value] of response.headers) responseHeaders.push([name, value]);
		return { status: response.status, statusText: response.statusText, url: response.url, headers: responseHeaders, body: buffer };
	}
}

class StorageBroker {
	#map = new Map();
	#bytes = 0;
	#ledger;
	#limits;

	constructor(ledger, limits) {
		this.#ledger = ledger;
		this.#limits = limits;
	}

	#key(value) {
		if (typeof value !== "string" || !value || value.length > 512) throw new TypeError("Storage key must be a non-empty string up to 512 characters");
		return value;
	}

	#size(value) {
		let text;
		try { text = JSON.stringify(value); }
		catch { throw new TypeError("Storage value must be JSON-serializable"); }
		if (text === undefined) throw new TypeError("Storage value must not be undefined");
		const size = new TextEncoder().encode(text).length;
		if (size > this.#limits.storageValueBytes) throw new DOMException("Storage value exceeds the value byte limit", "QuotaExceededError");
		return { text, size };
	}

	async apply(op, args) {
		this.#ledger.consume("storageOps", 1);
		const list = Array.isArray(args) ? args : [];
		switch (op) {
			case "get": {
				const record = this.#map.get(this.#key(list[0]));
				return record ? JSON.parse(record.text) : undefined;
			}
			case "set": {
				const key = this.#key(list[0]);
				const { text, size } = this.#size(list[1]);
				const previous = this.#map.get(key);
				if (!previous && this.#map.size + 1 > this.#limits.storageKeys) throw new DOMException("Storage key limit exceeded", "QuotaExceededError");
				const next = this.#bytes + size - (previous?.size ?? 0);
				this.#ledger.gauge("storageBytes", next);
				this.#bytes = next;
				this.#map.set(key, { text, size });
				return undefined;
			}
			case "delete": {
				const key = this.#key(list[0]);
				const previous = this.#map.get(key);
				if (previous) {
					const next = this.#bytes - previous.size;
					this.#ledger.gauge("storageBytes", next);
					this.#bytes = next;
					this.#map.delete(key);
				}
				return undefined;
			}
			case "keys": return [...this.#map.keys()];
			case "clear":
				this.#map.clear();
				this.#bytes = 0;
				this.#ledger.gauge("storageBytes", 0);
				return undefined;
			default: throw new DOMException("Unsupported storage operation: " + op, "NotAllowedError");
		}
	}
}

const htmlElementNames = new Set([
	"a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "blockquote", "br",
	"button", "caption", "cite", "code", "col", "colgroup", "data", "dd", "del",
	"details", "dfn", "div", "dl", "dt", "em", "fieldset", "figcaption", "figure",
	"footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "i",
	"img", "input", "ins", "kbd", "label", "legend", "li", "main", "mark", "menu",
	"meter", "nav", "ol", "optgroup", "option", "output", "p", "pre", "progress",
	"q", "rp", "rt", "ruby", "s", "samp", "section", "select", "small", "span",
	"strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th",
	"thead", "time", "tr", "u", "ul", "var", "wbr"
]);
const htmlVoidElementNames = new Set(["br", "col", "hr", "img", "input", "wbr"]);
const htmlAttributeNames = new Set([
	"class", "id", "name", "style", "title", "lang", "dir", "hidden", "tabindex", "role", "translate",
	"href", "target", "rel", "download", "hreflang", "type", "src", "alt", "width", "height",
	"loading", "decoding", "colspan", "rowspan", "headers", "scope", "span", "start", "reversed",
	"value", "open", "datetime", "cite", "disabled", "readonly", "placeholder", "maxlength",
	"minlength", "min", "max", "step", "size", "required", "multiple", "accept", "checked",
	"selected", "rows", "cols", "wrap", "inputmode", "pattern", "autocomplete", "list", "for", "label", "media"
]);
const htmlDangerousCSS = /url\s*\(|@import|expression\s*\(|-moz-binding|behavior\s*:|var\s*\(|image-set\s*\(|\\|\/\*/i;

const blockedElementNames = new Set([
	"script", "iframe", "frame", "frameset", "object", "embed", "applet",
	"base", "meta", "link", "style", "svg", "math", "portal", "fencedframe",
	"webview"
]);
const blockedPropertyNames = new Set([
	"innerHTML", "outerHTML", "srcdoc", "insertAdjacentHTML", "setHTMLUnsafe",
	"setHTML", "outerText", "innerText", "__proto__", "prototype", "constructor",
	"formAction", "action", "srcset", "imagesrcset", "ping"
]);
const blockedAttributeNames = new Set([
	"srcdoc", "nonce", "integrity", "is", "formaction", "action",
	"srcset", "imagesrcset", "ping"
]);
const urlPropertyNames = new Set(["href", "src", "poster", "cite", "background", "data", "manifest"]);
const urlAttributeNames = new Set([
	"href", "src", "action", "formaction", "poster", "cite", "xlink:href",
	"background", "data", "manifest"
]);

function assertSafeElementName(value) {
	const name = String(value).toLowerCase();
	if (!/^[a-z][a-z0-9-]*$/.test(name) || name.includes("-") || blockedElementNames.has(name)) {
		throw new DOMException("Element type is not permitted by the DOM bridge", "NotAllowedError");
	}
	return name;
}

const executableDataURL = /^data:(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|text\/css)/i;
const localResourceURL = /^(?:#|about:blank$|blob:|data:(?!text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|text\/css)[-a-z0-9._+\/]*[,;])/i;

function assertSafeURL(name, value, remoteResources) {
	const url = String(value).trim().replace(/[\u0000-\u0020]+/g, "");
	if (/^(?:javascript|vbscript):/i.test(url) || executableDataURL.test(url)) {
		throw new DOMException("Executable URLs are not permitted by the DOM bridge", "NotAllowedError");
	}
	if (localResourceURL.test(url)) return name;
	const policy = remoteResources && typeof remoteResources === "object" ? remoteResources : (remoteResources ? { enabled: true, allow: ["*"] } : { enabled: false, allow: [] });
	if (!policy.enabled || !policy.allow.some(pattern => matchURL(pattern, url))) {
		throw new DOMException("Remote resource URL is not permitted by the DOM bridge: " + name, "NotAllowedError");
	}
	return name;
}

function assertSafeAttribute(name, value, remoteResources = false) {
	name = String(name).toLowerCase();
	if (!/^[a-z_:][a-z0-9_.:-]*$/.test(name) || name.startsWith("on") || blockedAttributeNames.has(name)) {
		throw new DOMException("Attribute is not permitted by the DOM bridge: " + name, "NotAllowedError");
	}
	if (urlAttributeNames.has(name)) assertSafeURL(name, value, remoteResources);
	return name;
}

function assertSafeProperty(name, value, remoteResources = false) {
	name = String(name);
	if (blockedPropertyNames.has(name) || name.startsWith("__") || /^on[a-z]+$/i.test(name)) {
		throw new DOMException("DOM property is not permitted by the bridge: " + name, "NotAllowedError");
	}
	if (urlPropertyNames.has(name)) assertSafeURL(name, value, remoteResources);
	return name;
}

function assertSafeStyle(property, value) {
	property = String(property).trim();
	const css = String(value);
	if (!/^(?:--[a-z0-9_-]+|-?[a-z][a-z0-9-]*)$/i.test(property) || ["__proto__", "prototype", "constructor"].includes(property.toLowerCase())) {
		throw new DOMException("CSS property name is not permitted by the DOM bridge", "NotAllowedError");
	}
	if (htmlDangerousCSS.test(css)) {
		throw new DOMException("CSS resource loading and executable CSS are not permitted by the DOM bridge", "NotAllowedError");
	}
	return property;
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

function applySafeHTMLStyle(node, value) {
	const text = String(value);
	if (htmlDangerousCSS.test(text)) {
		throw new DOMException("CSS resource loading is not permitted in HTML content", "NotAllowedError");
	}
	const probe = document.createElement("div");
	probe.style.cssText = text;
	const names = [];
	for (let index = 0; index < probe.style.length; index++) names.push(probe.style[index]);
	for (const property of names) {
		const cssValue = probe.style.getPropertyValue(property);
		try { assertSafeStyle(property, cssValue); }
		catch { continue; }
		node.style.setProperty(property, cssValue, probe.style.getPropertyPriority(property) === "important" ? "important" : "");
	}
}

function createSanitizedNode(data, ids, remoteResources, state) {
	if (++state.nodes > state.limits.nodes) throw new DOMException("HTML content exceeds the node limit", "NotAllowedError");
	if (state.depth > state.limits.depth) throw new DOMException("HTML content exceeds the depth limit", "NotAllowedError");
	if (!data || typeof data !== "object") throw new DOMException("Invalid HTML node", "NotAllowedError");
	if (data.nodeType === 3) return document.createTextNode(String(data.text ?? "").slice(0, state.limits.length));
	if (data.nodeType !== 1) throw new DOMException("Only elements and text are permitted in HTML content", "NotAllowedError");
	const tagName = String(data.tagName ?? "").toLowerCase();
	if (!htmlElementNames.has(tagName)) throw new DOMException("HTML element is not permitted: " + tagName, "NotAllowedError");
	assertSafeElementName(tagName);
	if (!Number.isSafeInteger(data.id) || data.id < 1 || ids.has(data.id)) throw new DOMException("Invalid HTML node id", "NotAllowedError");
	const node = document.createElement(tagName);
	ids.set(data.id, node);
	const attributes = data.attributes ?? {};
	for (const [name, rawValue] of Object.entries(attributes)) {
		const key = String(name).toLowerCase();
		if (++state.attributes > state.limits.nodes * 8) throw new DOMException("HTML content exceeds the attribute limit", "NotAllowedError");
		const value = decodeHTMLEntities(String(rawValue));
		if (value.length > state.limits.attributeLength) throw new DOMException("HTML attribute is too long", "NotAllowedError");
		if (!htmlAttributeNames.has(key) && !/^data-[a-z0-9-]+$/.test(key) && !/^aria-[a-z0-9-]+$/.test(key)) {
			throw new DOMException("HTML attribute is not permitted: " + key, "NotAllowedError");
		}
		assertSafeAttribute(key, value, remoteResources);
		if (key === "style") { applySafeHTMLStyle(node, value); continue; }
		if (key === "id" || key === "name") continue;
		node.setAttribute(key, value);
	}
	const children = Array.isArray(data.children) ? data.children : [];
	if (children.length && htmlVoidElementNames.has(tagName)) throw new DOMException("Void HTML element cannot have children", "NotAllowedError");
	state.depth++;
	for (const child of children) node.appendChild(createSanitizedNode(child, ids, remoteResources, state));
	state.depth--;
	return node;
}

function snapshotNode(node, ids, state) {
	if (node.nodeType === 1 && blockedElementNames.has(node.localName.toLowerCase())) return null;
	const id = state.nextId++;
	ids.set(id, node);
	const attributes = {};
	if (node.nodeType === 1) {
		for (const attr of node.attributes) {
			const name = attr.name.toLowerCase();
			if (!name.startsWith("on") && !["srcdoc", "nonce", "integrity", "is", "action", "formaction"].includes(name)) attributes[attr.name] = attr.value;
		}
	}
	const styleData = {};
	const stylePriorityData = {};
	if (node.nodeType === 1) {
		for (let i = 0; i < node.style.length; i++) {
			const name = node.style[i];
			const key = name.startsWith("--") ? name : name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
			styleData[key] = node.style.getPropertyValue(name);
			stylePriorityData[key] = node.style.getPropertyPriority(name);
		}
	}
	return {
		id,
		nodeType: node.nodeType,
		tagName: node.nodeType === 1 ? node.tagName : node.nodeName,
		idName: node.nodeType === 1 ? node.id : "",
		className: node.nodeType === 1 ? node.className : "",
		text: node.nodeType === 3 || node.nodeType === 8 ? node.nodeValue ?? "" : "",
		attributes,
		styleData,
		stylePriorityData,
		value: node.nodeType === 1 && "value" in node ? node.value : undefined,
		checked: node.nodeType === 1 && "checked" in node ? node.checked : undefined,
		disabled: node.nodeType === 1 && "disabled" in node ? node.disabled : undefined,
		muted: node.nodeType === 1 && "muted" in node ? node.muted : undefined,
		selected: node.nodeType === 1 && "selected" in node ? node.selected : undefined,
		indeterminate: node.nodeType === 1 && "indeterminate" in node ? node.indeterminate : undefined,
		tabIndex: node.nodeType === 1 && "tabIndex" in node ? node.tabIndex : undefined,
		width: node.nodeType === 1 && "width" in node ? node.width : undefined,
		height: node.nodeType === 1 && "height" in node ? node.height : undefined,
		rows: node.nodeType === 1 && "rows" in node ? node.rows : undefined,
		cols: node.nodeType === 1 && "cols" in node ? node.cols : undefined,
		maxLength: node.nodeType === 1 && "maxLength" in node ? node.maxLength : undefined,
		minLength: node.nodeType === 1 && "minLength" in node ? node.minLength : undefined,
		rowSpan: node.nodeType === 1 && "rowSpan" in node ? node.rowSpan : undefined,
		colSpan: node.nodeType === 1 && "colSpan" in node ? node.colSpan : undefined,
		size: node.nodeType === 1 && "size" in node ? node.size : undefined,
		start: node.nodeType === 1 && "start" in node ? node.start : undefined,
		span: node.nodeType === 1 && "span" in node ? node.span : undefined,
		children: Array.from(node.childNodes, child => snapshotNode(child, ids, state)).filter(Boolean)
	};
}

function createNativeNode(data, ids, remoteResources) {
	let node;
	if (data.nodeType === 3) node = document.createTextNode(data.text ?? "");
	else if (data.nodeType === 8) node = document.createComment(data.text ?? "");
	else if (data.nodeType === 11) node = document.createDocumentFragment();
	else {
		const tagName = assertSafeElementName(data.tagName ?? "div");
		node = document.createElement(tagName);
		for (const [name, value] of Object.entries(data.attributes ?? {})) {
			try {
				const safeName = assertSafeAttribute(name, value, remoteResources);
				if (safeName === "style") assertSafeStyle("style", value);
				if (data.html && (safeName === "id" || safeName === "name")) continue;
				node.setAttribute(safeName, String(value));
			} catch (error) {
				if (error?.name === "NotAllowedError") throw error;
			}
		}
		for (const [name, value] of Object.entries(data.styleData ?? {})) {
			try {
				const property = name.startsWith("--") ? name : name.replace(/[A-Z]/g, character => "-" + character.toLowerCase());
				const safeName = assertSafeStyle(property, value);
				const priority = String(data.stylePriorityData?.[name] ?? "");
				if (priority && priority.toLowerCase() !== "important") throw new TypeError("Invalid CSS priority");
				node.style.setProperty(safeName, String(value), priority);
			} catch (error) {
				if (error?.name === "NotAllowedError") throw error;
			}
		}
		if (data.text) node.textContent = data.text;
	}
	ids.set(data.id, node);
	for (const child of data.children ?? []) node.appendChild(createNativeNode(child, ids, remoteResources));
	if (data.value !== undefined && "value" in node) node.value = data.value;
	if (data.checked !== undefined && "checked" in node) node.checked = data.checked;
	if (data.disabled !== undefined && "disabled" in node) node.disabled = data.disabled;
	if (data.muted !== undefined && "muted" in node) node.muted = data.muted;
	if (data.selected !== undefined && "selected" in node) node.selected = data.selected;
	if (data.indeterminate !== undefined && "indeterminate" in node) node.indeterminate = data.indeterminate;
	if (data.tabIndex !== undefined && "tabIndex" in node) node.tabIndex = data.tabIndex;
	if (data.width !== undefined && "width" in node) node.width = data.width;
	if (data.height !== undefined && "height" in node) node.height = data.height;
	if (data.rows !== undefined && "rows" in node) node.rows = data.rows;
	if (data.cols !== undefined && "cols" in node) node.cols = data.cols;
	if (data.maxLength !== undefined && "maxLength" in node) node.maxLength = data.maxLength;
	if (data.minLength !== undefined && "minLength" in node) node.minLength = data.minLength;
	if (data.rowSpan !== undefined && "rowSpan" in node) node.rowSpan = data.rowSpan;
	if (data.colSpan !== undefined && "colSpan" in node) node.colSpan = data.colSpan;
	if (data.size !== undefined && "size" in node) node.size = data.size;
	if (data.start !== undefined && "start" in node) node.start = data.start;
	if (data.span !== undefined && "span" in node) node.span = data.span;
	return node;
}

class DomPermissionPolicy {
	constructor(policy) {
		this.policy = policy;
	}

	check() {
		if (!this.policy.dom.enabled) {
			throw new DOMException("DOM permission is not enabled", "NotAllowedError");
		}
	}

	checkElement(name) {
		this.check();
		const safe = assertSafeElementName(name);
		const dom = this.policy.dom;
		if (dom.denyTags.includes(safe)) throw new DOMException("Element is denied by the DOM policy: " + safe, "NotAllowedError");
		if (dom.allowTags && !dom.allowTags.includes(safe)) throw new DOMException("Element is not in the DOM element allowlist: " + safe, "NotAllowedError");
		return safe;
	}

	checkAttribute(name, value) {
		this.check();
		const safe = assertSafeAttribute(name, value, this.policy.dom.remoteResources);
		const dom = this.policy.dom;
		const key = String(name).toLowerCase();
		if (dom.allowAttributes && !dom.allowAttributes.includes(key) && !/^(?:data|aria)-[a-z0-9-]+$/.test(key)) {
			throw new DOMException("Attribute is not in the DOM attribute allowlist: " + key, "NotAllowedError");
		}
		return safe;
	}

	checkProperty(name, value) {
		this.check();
		return assertSafeProperty(name, value, this.policy.dom.remoteResources);
	}

	checkStyle(property, value) {
		this.check();
		return assertSafeStyle(property, value);
	}
}

class DomBridge {
	constructor(policy, limits, ledger) {
		this.config = policy;
		this.limits = limits;
		this.ledger = ledger;
		this.policy = new DomPermissionPolicy(policy);
	}

	#validateTree(data, depth, counter) {
		if (!data || typeof data !== "object") throw new DOMException("Invalid DOM node payload", "NotAllowedError");
		if (depth > this.limits.htmlDepth) throw new DOMException("DOM tree exceeds the depth limit", "NotAllowedError");
		counter.count();
		if (data.nodeType === 1) {
			this.policy.checkElement(data.tagName ?? "div");
			for (const [name, value] of Object.entries(data.attributes ?? {})) this.policy.checkAttribute(name, value);
		}
		for (const child of data.children ?? []) this.#validateTree(child, depth + 1, counter);
	}

	apply(message, ids, root) {
		this.policy.check();
		this.ledger.consume("domMutations", 1);
		this.ledger.consume("domBytes", estimateSize(message));
		const payloads = [];
		if (message.child) payloads.push(message.child);
		if (message.op === "html" && Array.isArray(message.children)) payloads.push(...message.children);
		const counter = { count: () => this.ledger.consume("domNodes", 1) };
		for (const payload of payloads) this.#validateTree(payload, 0, counter);
		const target = ids.get(message.id);
		if (!target && message.op !== "documentTitle") {
			throw new DOMException("Unknown DOM bridge node", "NotFoundError");
		}
		switch (message.op) {
			case "documentTitle": return this.setDocumentTitle(message);
			case "text": return this.setText(target, message);
			case "innerText": return this.setInnerText(target, message);
			case "urlProperty": return this.setURLProperty(target, message);
			case "numericProperty": return this.setNumericProperty(target, message);
			case "style": return this.setStyle(target, message);
			case "styleText": return this.setStyleText(target, message);
			case "styleSetProperty": return this.setStyleProperty(target, message);
			case "styleRemoveProperty": return this.removeStyleProperty(target, message);
			case "classList": return this.setClassList(target, message);
			case "attribute": return this.setAttribute(target, message);
			case "removeAttribute": return this.removeAttribute(target, message);
			case "toggleAttribute": return this.toggleAttribute(target, message);
			case "formProperty": return this.setFormProperty(target, message);
			case "reflectedProperty": return this.setReflectedProperty(target, message);
			case "append": return this.appendChild(target, message, ids, root);
			case "insert": return this.insertBefore(target, message, ids, root);
			case "remove": return this.removeChild(target, message, ids, root);
			case "html": return this.setHTML(target, message, ids);
			case "focus": return this.focus(target);
			case "blur": return this.blur(target);
			default: throw new DOMException("Unsupported DOM bridge operation: " + message.op, "NotSupportedError");
		}
	}

	setDocumentTitle(message) {
		this.policy.check();
		throw new DOMException("Writing document.title is not permitted by the DOM bridge", "NotAllowedError");
	}

	setText(target, message) {
		this.policy.check();
		target.textContent = String(message.value);
	}

	setInnerText(target, message) {
		this.policy.check();
		target.innerText = String(message.value);
	}

	setURLProperty(target, message) {
		this.policy.check();
		const property = String(message.property);
		if (!["href", "src", "poster"].includes(property)) {
			throw new DOMException("Unsupported URL property: " + property, "NotAllowedError");
		}
		const value = String(message.value);
		this.policy.checkProperty(property, value);
		const attribute = this.policy.checkAttribute(property, value);
		if (property in target) target[property] = value;
		else target.setAttribute(attribute, value);
	}

	setNumericProperty(target, message) {
		this.policy.check();
		const property = String(message.property);
		if (!["tabIndex", "width", "height", "rows", "cols", "maxLength", "minLength", "rowSpan", "colSpan", "size", "start", "span"].includes(property)) {
			throw new DOMException("Unsupported numeric DOM property: " + property, "NotAllowedError");
		}
		const value = Number(message.value);
		if (!Number.isFinite(value)) throw new TypeError(property + " must be a finite number");
		if (property in target) target[property] = value;
		else target.setAttribute(property.toLowerCase(), String(value));
	}

	setStyle(target, message) {
		this.policy.check();
		const property = this.policy.checkStyle(message.property, message.value);
		if (property.includes("-")) {
			if (message.value === "") target.style.removeProperty(property);
			else target.style.setProperty(property, String(message.value), message.priority ?? "");
		} else target.style[property] = String(message.value);
	}

	setStyleText(target, message) {
		this.policy.check();
		const value = String(message.value);
		this.policy.checkStyle("style", value);
		target.style.cssText = value;
	}

	setStyleProperty(target, message) {
		this.policy.check();
		const value = String(message.value);
		const property = this.policy.checkStyle(message.property, value);
		const priority = String(message.priority ?? "");
		if (priority.trim() && priority.trim().toLowerCase() !== "important") {
			throw new TypeError("CSS priority must be empty or \"important\"");
		}
		target.style.setProperty(property, value, priority);
	}

	removeStyleProperty(target, message) {
		this.policy.check();
		const property = this.policy.checkStyle(message.property, "");
		target.style.removeProperty(property);
	}

	setClassList(target, message) {
		this.policy.check();
		const method = String(message.method);
		if (!["add", "remove", "toggle", "replace"].includes(method)) {
			throw new DOMException("Unsupported classList operation: " + method, "NotAllowedError");
		}
		const args = message.args;
		if (!Array.isArray(args) || args.length > 256 || args.some(value => typeof value !== "string" && typeof value !== "boolean")) {
			throw new TypeError("Invalid classList arguments");
		}
		const expected = method === "replace" ? 2 : method === "toggle" ? [1, 2] : null;
		if (method === "replace" && args.length !== expected) throw new TypeError("replace expects two tokens");
		if (method === "toggle" && (args.length < expected[0] || args.length > expected[1])) throw new TypeError("toggle expects a token and optional force");
		if ((method === "add" || method === "remove") && args.some(value => typeof value !== "string")) throw new TypeError("classList tokens must be strings");
		if (method === "toggle" && (typeof args[0] !== "string" || (args.length === 2 && typeof args[1] !== "boolean"))) throw new TypeError("Invalid toggle arguments");
		if (method === "replace" && args.some(value => typeof value !== "string")) throw new TypeError("replace tokens must be strings");
		const tokens = method === "toggle" ? [args[0]] : args;
		for (const token of tokens) {
			if (token === "") throw new DOMException("The token must not be empty", "SyntaxError");
			if (/\s/.test(token)) throw new DOMException("The token must not contain whitespace", "InvalidCharacterError");
		}
		target.classList[method](...args);
	}

	setAttribute(target, message) {
		this.policy.check();
		const name = this.policy.checkAttribute(message.name, message.value);
		if (name === "style") this.policy.checkStyle("style", message.value);
		target.setAttribute(name, String(message.value));
	}

	toggleAttribute(target, message) {
		this.policy.check();
		const name = this.policy.checkAttribute(message.name, "");
		if (typeof message.force !== "boolean") throw new TypeError("toggleAttribute force must be a boolean");
		target.toggleAttribute(name, message.force);
	}

	removeAttribute(target, message) {
		this.policy.check();
		const name = String(message.name).toLowerCase();
		if (!/^[a-z_:][a-z0-9_.:-]*$/.test(name) || name.startsWith("on") ||
			["srcdoc", "nonce", "integrity", "is", "action", "formaction"].includes(name)) {
			throw new DOMException("Attribute is not permitted by the DOM bridge: " + name, "NotAllowedError");
		}
		target.removeAttribute(name);
	}

	setFormProperty(target, message) {
		this.policy.check();
		const property = String(message.property);
		if (!["value", "checked", "disabled", "selected"].includes(property)) {
			throw new DOMException("Unsupported form-state property: " + property, "NotAllowedError");
		}
		this.policy.checkProperty(property, message.value);
		if (property === "value") {
			if (message.value !== null && (typeof message.value === "object" || typeof message.value === "function")) {
				throw new TypeError("DOM property value must be primitive");
			}
			target.value = String(message.value);
		} else target[property] = Boolean(message.value);
	}

	setReflectedProperty(target, message) {
		this.policy.check();
		const property = this.policy.checkProperty(message.property, message.value);
		const attribute = this.policy.checkAttribute(message.attribute, message.kind === "string" ? message.value : "");
		if (message.kind === "boolean" || message.kind === "stateBoolean") {
			const value = Boolean(message.value);
			if (property in target) target[property] = value;
			else if (value) target.setAttribute(attribute, "");
			else target.removeAttribute(attribute);
			return;
		}
		const value = String(message.value);
		if (property in target) target[property] = value;
		else target.setAttribute(attribute, value);
	}

	appendChild(target, message, ids, root) {
		this.policy.check();
		const child = createNativeNode(message.child, ids, this.config.dom.remoteResources);
		if (child === root || child.contains?.(root)) throw new DOMException("Cannot move the permitted root", "NotAllowedError");
		target.appendChild(child);
	}

	insertBefore(target, message, ids, root) {
		this.policy.check();
		const before = message.beforeId == null ? null : ids.get(message.beforeId);
		if (message.beforeId != null && !before) throw new DOMException("Unknown reference node", "NotFoundError");
		const child = createNativeNode(message.child, ids, this.config.dom.remoteResources);
		if (child === root || child.contains?.(root)) throw new DOMException("Cannot move the permitted root", "NotAllowedError");
		target.insertBefore(child, before);
	}

	setHTML(target, message, ids) {
		this.policy.check();
		if (!this.config.dom.innerHTML) throw new DOMException("innerHTML permission is not enabled", "NotAllowedError");
		for (const [id, node] of [...ids]) {
			if (node !== target && target.contains(node)) ids.delete(id);
		}
		const children = Array.isArray(message.children) ? message.children : [];
		const state = {
			nodes: 0,
			attributes: 0,
			depth: 0,
			limits: {
				length: this.limits.htmlLength,
				nodes: this.limits.htmlNodes,
				depth: this.limits.htmlDepth,
				attributeLength: this.limits.htmlAttributeLength
			}
		};
		const nodes = children.map(child => createSanitizedNode(child, ids, this.config.dom.remoteResources, state));
		target.replaceChildren(...nodes);
	}

	removeChild(target, message, ids, root) {
		this.policy.check();
		const child = ids.get(message.childId);
		if (!child || child.parentNode !== target) throw new DOMException("Node is not a child", "NotFoundError");
		if (child === root) throw new DOMException("Cannot remove the permitted root", "NotAllowedError");
		target.removeChild(child);
	}

	focus(target) {
		this.policy.check();
		target.focus();
	}

	blur(target) {
		this.policy.check();
		target.blur();
	}
}

function sandboxBootstrap() {
	"use strict";
	let started = false;
	const onMessage = event => {
		if (started || event.data?.type !== "init") return;
		started = true;
		removeEventListener("message", onMessage);
		const port = event.ports?.[0];
		if (!port) return;
		try {
			const source = "(" + event.data.workerSource + ")();";
			const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
			const worker = new Worker(url);
			worker.onerror = error => parent.postMessage({ type: "pperm-worker-error", message: error.message ?? "Worker failed" }, "*");
			worker.postMessage({
				type: "init",
				code: event.data.code,
				tick: event.data.tick,
				policy: event.data.policy,
				documentTitle: event.data.documentTitle,
				htmlPolicy: event.data.htmlPolicy,
				snapshot: event.data.snapshot,
				baseURI: event.data.baseURI,
			}, [port]);
		} catch (error) {
			port.postMessage({ type: "error", error: { name: error?.name ?? "Error", message: error?.message ?? String(error) } });
		}
	};
	addEventListener("message", onMessage);
}

function cspSources(rules) {
	const sources = [];
	for (const rule of rules) {
		if (!rule?.enabled) continue;
		for (const pattern of rule.allow ?? []) {
			if (pattern === "*") { sources.push("https:", "wss:"); continue; }
			if (pattern.startsWith("/")) { sources.push("'self'"); continue; }
			const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(pattern) ? pattern : "https://" + pattern;
			try {
				const url = new URL(normalized);
				if (url.protocol === "ws:" || url.protocol === "wss:") sources.push(url.protocol + "//" + url.host);
				else if (url.protocol === "http:" || url.protocol === "https:") sources.push(url.protocol + "//" + url.host);
			} catch {}
		}
	}
	return [...new Set(sources)];
}

function buildCSP(policy) {
	const sources = cspSources([policy.network.webSocket, policy.network.eventSource]);
	return [
		"default-src 'none'",
		"script-src 'unsafe-inline' 'unsafe-eval' blob:",
		"worker-src blob:",
		"connect-src " + (sources.length ? sources.join(" ") : "'none'"),
		"img-src 'none'",
		"media-src 'none'",
		"font-src 'none'",
		"style-src 'none'",
		"object-src 'none'",
		"frame-src 'none'",
		"child-src 'none'",
		"manifest-src 'none'",
		"form-action 'none'",
		"base-uri 'none'"
	].join("; ");
}

function buildSandboxDocument(csp) {
	return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '"><script>(' + sandboxBootstrap.toString() + ')();<\/script></head><body></body></html>';
}

let nextProcessId = 1;
let cachedParser = null;
let parserRequested = false;

async function getParser() {
	if (!parserRequested) {
		parserRequested = true;
		cachedParser = await loadParser();
	}
	return cachedParser;
}

export class PpermProcess extends EventTarget {
	#id = 0;
	#state = "idle";
	#terminated = false;
	#frame = null;
	#port = null;
	#timer = null;
	#watchdog = null;
	#resolveTermination;
	#terminationPromise;
	#running = false;
	#finish = null;
	#kill = null;
	#root = null;
	#nodeIds = new Map();
	#domBridge;
	#storage;
	#netBroker;
	#ledger;
	#domListeners = [];
	#pendingListeners = [];
	#startedAt = 0;
	#lastBeat = 0;
	#steps = 0;
	#release = null;
	#instrumented = false;

	constructor(options = {}) {
		super();
		const config = normalizePolicy(options);
		this.policy = Object.freeze(config);
		this.limits = Object.freeze(deriveLimits(config));
		this.#id = nextProcessId++;
		this.#ledger = new QuotaLedger(this.limits, error => this.dispatchEvent(new CustomEvent("quota", { detail: error })));
		this.#domBridge = new DomBridge(this.policy, this.limits, this.#ledger);
		this.#storage = new StorageBroker(this.#ledger, this.limits);
		this.#netBroker = new NetBroker(this.policy.network, this.#ledger);
		this.#terminationPromise = new Promise(resolve => { this.#resolveTermination = resolve; });
		if (this.policy.dom.enabled) {
			this.#root = document.querySelector(this.policy.dom.root);
			if (!this.#root) throw new Error("DOM root not found: " + this.policy.dom.root);
			if (blockedElementNames.has(this.#root.localName.toLowerCase())) throw new DOMException("The configured DOM root is not permitted", "NotAllowedError");
		}
	}

	get id() { return this.#id; }
	get state() { return this.#state; }
	get terminated() { return this.#terminated; }
	get instrumented() { return this.#instrumented; }
	get finished() { return this.#terminationPromise; }
	get usage() {
		return {
			...this.#ledger.snapshot(),
			steps: this.#steps,
			elapsedMs: this.#startedAt ? performance.now() - this.#startedAt : 0,
			state: this.#state,
			instrumented: this.#instrumented
		};
	}

	#setState(state) {
		if (this.#state === state) return;
		this.#state = state;
		this.dispatchEvent(new CustomEvent("state", { detail: state }));
	}

	#htmlPolicy() {
		return {
			elements: [...htmlElementNames],
			voidElements: [...htmlVoidElementNames],
			attributes: [...htmlAttributeNames],
			limits: {
				length: this.limits.htmlLength,
				nodes: this.limits.htmlNodes,
				depth: this.limits.htmlDepth,
				attributeLength: this.limits.htmlAttributeLength
			}
		};
	}

	async run(code) {
		if (this.#terminated) throw new DOMException("Process has been terminated", "AbortError");
		if (this.#running) throw new Error("A pperm process can run only one script at a time");
		this.#running = true;
		this.#setState("queued");
		const release = await scheduler.acquire();
		this.#release = release;
		if (this.#terminated) {
			release();
			this.#release = null;
			this.#running = false;
			throw new DOMException("Process has been terminated", "AbortError");
		}
		this.#setState("starting");
		let source = String(code);
		let tick = null;
		const parser = await getParser();
		if (parser && this.limits.steps !== Infinity) {
			try {
				const result = instrument(source, parser);
				source = result.code;
				tick = result.tick;
				this.#instrumented = result.points > 0;
			} catch (error) {
				release();
				this.#release = null;
				this.#running = false;
				this.#setState("failed");
				throw error;
			}
		} else {
			this.#instrumented = false;
		}
		return this.#launch(source, tick, release);
	}

	#launch(source, tick, release) {
		return new Promise((resolve, reject) => {
			let settled = false;
			let snapshot;
			let channel;
			let onPortMessage;
			let onWindowMessage;
			const finish = (error, value) => {
				if (settled) return;
				settled = true;
				this.#finish = null;
				this.#kill = null;
				clearTimeout(this.#timer);
				clearInterval(this.#watchdog);
				this.#timer = null;
				this.#watchdog = null;
				if (onWindowMessage) window.removeEventListener("message", onWindowMessage);
				if (channel) {
					channel.port1.removeEventListener("message", onPortMessage);
					try { channel.port1.close(); } catch {}
				}
				this.#port = null;
				try { this.#frame?.remove(); } catch {}
				this.#frame = null;
				this.#running = false;
				for (const entry of this.#domListeners) {
					try { entry.target.removeEventListener(entry.type, entry.handler, { capture: !!entry.capture }); } catch {}
				}
				this.#domListeners = [];
				this.#pendingListeners = [];
				if (release) release();
				if (this.#release === release) this.#release = null;
				if (error) {
					this.#setState(error.name === "AbortError" ? "terminated" : "failed");
					this.dispatchEvent(new CustomEvent("error", { detail: error }));
					reject(error);
				} else {
					this.#setState("done");
					this.dispatchEvent(new CustomEvent("done", { detail: value }));
					resolve(value);
				}
			};
			const kill = error => {
				if (settled) return;
				try { channel?.port1.close(); } catch {}
				try { this.#frame?.remove(); } catch {}
				finish(error);
				if (!this.#terminated) {
					this.#terminated = true;
					this.#resolveTermination();
					this.dispatchEvent(new Event("terminate"));
				}
			};
			this.#finish = finish;
			this.#kill = kill;

			onPortMessage = event => {
				if (settled || this.#terminated) return;
				const message = event.data;
				this.#lastBeat = performance.now();
				try {
					this.#ledger.consume("messages", 1);
					this.#ledger.consume("messageBytes", estimateSize(message));
					this.#ledger.rate("messagesPerSecond", 1);
				} catch (error) { kill(error); return; }
				try {
					if (message?.type === "ready") {
						this.#setState("running");
						this.#startedAt = performance.now();
						this.#lastBeat = this.#startedAt;
						clearTimeout(this.#timer);
						this.#timer = null;
						this.#watchdog = setInterval(() => {
							const now = performance.now();
							if (now - this.#startedAt > this.limits.wallMs) kill(new DOMException("Execution stopped: wall time limit exceeded", "TimeoutError"));
							else if (now - this.#lastBeat > this.limits.stalledMs) kill(new DOMException("Execution stopped: worker is blocked", "TimeoutError"));
						}, Math.max(25, Math.min(250, this.limits.heartbeatMs)));
					} else if (message?.type === "heartbeat" || message?.type === "usage") {
						const steps = Number(message.steps) || 0;
						this.#steps = Math.max(this.#steps, steps);
						if (steps > this.limits.steps) kill(new DOMException("Execution stopped: step limit exceeded", "QuotaExceededError"));
					} else if (message?.type === "quota") {
						this.#steps = Math.max(this.#steps, Number(message.steps) || 0);
						const error = new DOMException("Execution stopped: " + String(message.name ?? "quota") + " limit exceeded", "QuotaExceededError");
						error.quota = message.name;
						kill(error);
					} else if (message?.type === "userMessage") {
						this.dispatchEvent(new CustomEvent("message", { detail: message.value }));
					} else if (message?.type === "dom") {
						if (!this.#root) throw new DOMException("DOM permission is not enabled", "NotAllowedError");
						if (message.op === "html") this.#pruneRemovedListeners(message.id);
						this.#domBridge.apply(message, this.#nodeIds, this.#root);
						const pending = this.#pendingListeners.splice(0);
						for (const item of pending) this.#attachListener(item);
					} else if (message?.type === "listen") {
						this.#attachListener(message);
					} else if (message?.type === "unlisten") {
						this.#domBridge.policy.check();
						this.#ledger.consume("domMutations", 1);
						for (const entry of this.#domListeners) {
							if (entry.listenerId === message.listenerId) entry.target.removeEventListener(entry.type, entry.handler, { capture: !!entry.capture });
						}
						this.#domListeners = this.#domListeners.filter(entry => entry.listenerId !== message.listenerId);
						this.#pendingListeners = this.#pendingListeners.filter(entry => entry.listenerId !== message.listenerId);
					} else if (message?.type === "documentTitle") {
						this.#domBridge.apply({ op: "documentTitle", value: message.value }, this.#nodeIds, this.#root);
					} else if (message?.type === "dispatch") {
						this.#dispatchWorkerEvent(message);
					} else if (message?.type === "storage") {
						if (!this.policy.storage.enabled) throw new DOMException("Storage permission is not enabled", "NotAllowedError");
						this.#storage.apply(message.op, message.args ?? []).then(
							value => this.#port?.postMessage({ type: "storageResult", requestId: message.requestId, value }),
							error => this.#port?.postMessage({ type: "storageError", requestId: message.requestId, error: serializeError(error) })
						);
					} else if (message?.type === "net") {
						if (!this.policy.network.fetch.enabled && !this.policy.network.xmlHttpRequest.enabled) throw new DOMException("Network permission is not enabled", "NotAllowedError");
						this.#netBroker.fetch(message).then(
							result => {
								try { this.#port?.postMessage({ type: "netResult", requestId: message.requestId, ...result }, [result.body]); }
								catch { this.#port?.postMessage({ type: "netError", requestId: message.requestId, error: { name: "Error", message: "Response transfer failed" } }); }
							},
							error => this.#port?.postMessage({ type: "netError", requestId: message.requestId, error: serializeError(error) })
						);
					} else if (message?.type === "done") {
						this.#steps = Math.max(this.#steps, Number(message.steps) || 0);
						finish(null, message.value);
					} else if (message?.type === "error") {
						this.#steps = Math.max(this.#steps, Number(message.steps) || 0);
						const error = new Error(message.error?.message ?? "Worker execution failed");
						error.name = message.error?.name ?? "Error";
						if (message.error?.stack) error.stack = message.error.stack;
						finish(error);
					}
				} catch (error) {
					finish(error);
				}
			};

			onWindowMessage = event => {
				if (settled || event.source !== this.#frame?.contentWindow) return;
				if (event.data?.type === "pperm-worker-error") {
					const error = new Error(event.data.message || "Worker failed");
					error.name = "WorkerError";
					finish(error);
				}
			};

			try {
				if (this.#root) {
					this.#nodeIds = new Map();
					snapshot = snapshotNode(this.#root, this.#nodeIds, { nextId: 1 });
				} else {
					snapshot = { id: 1, nodeType: 1, tagName: "BODY", idName: "", className: "", text: "", attributes: {}, styleData: {}, children: [] };
					this.#nodeIds = new Map();
				}
				channel = new MessageChannel();
				this.#port = channel.port1;
				channel.port1.addEventListener("message", onPortMessage);
				channel.port1.start();
				window.addEventListener("message", onWindowMessage);
				this.#frame = document.createElement("iframe");
				this.#frame.setAttribute("sandbox", "allow-scripts");
				this.#frame.setAttribute("aria-hidden", "true");
				this.#frame.setAttribute("tabindex", "-1");
				this.#frame.setAttribute("width", "0");
				this.#frame.setAttribute("height", "0");
				this.#frame.style.display = "none";
				this.#frame.srcdoc = buildSandboxDocument(buildCSP(this.policy));
				this.#frame.addEventListener("load", () => {
					if (settled || this.#terminated) return;
					this.#frame.contentWindow.postMessage({
						type: "init",
						workerSource: workerMain.toString(),
						code: source,
						tick,
						policy: this.policy,
						documentTitle: "",
						htmlPolicy: this.#htmlPolicy(),
						snapshot,
						baseURI: location.href,
						}, "*", [channel.port2]);
				}, { once: true });
				(document.body ?? document.documentElement).appendChild(this.#frame);
				this.#timer = setTimeout(() => kill(new DOMException("Isolated worker failed to start", "TimeoutError")), Math.max(2000, this.limits.startMs));
			} catch (error) {
				finish(error);
			}
		});
	}

	#pruneRemovedListeners(id) {
		const target = this.#nodeIds.get(id);
		if (!target) return;
		const removed = new Set();
		for (const [nodeId, node] of this.#nodeIds) {
			if (node !== target && target.contains(node)) removed.add(nodeId);
		}
		this.#domListeners = this.#domListeners.filter(entry => {
			if (entry.target === target || !target.contains(entry.target)) return true;
			entry.target.removeEventListener(entry.type, entry.handler, { capture: !!entry.capture });
			return false;
		});
		this.#pendingListeners = this.#pendingListeners.filter(entry => !removed.has(entry.id));
	}

	#dispatchWorkerEvent(message) {
		this.#domBridge.policy.check();
		this.#ledger.consume("domMutations", 1);
		const target = this.#nodeIds.get(message.id);
		if (!target || !this.#port) throw new DOMException("Unknown event target", "NotFoundError");
		const type = String(message.event?.type ?? "");
		if (!type) throw new TypeError("Event type is required");
		this.#assertEvent(type);
		const path = [];
		for (let node = target; node; node = node.parentNode) {
			path.push(node);
			if (!message.event?.bubbles) break;
		}
		const eventData = {
			...message.event,
			type,
			targetId: message.id,
			bubbles: !!message.event?.bubbles,
			cancelable: !!message.event?.cancelable
		};
		const deliver = (node, capture) => {
			for (const entry of [...this.#domListeners]) {
				if (entry.target !== node || entry.type !== type || !!entry.capture !== capture) continue;
				this.#port?.postMessage({ type: "event", listenerId: entry.listenerId, event: eventData });
				if (entry.once) {
					entry.target.removeEventListener(entry.type, entry.handler, { capture: !!entry.capture });
					this.#domListeners = this.#domListeners.filter(item => item !== entry);
				}
			}
		};
		for (const node of [...path].reverse()) deliver(node, true);
		for (const node of path) deliver(node, false);
	}

	#assertEvent(type) {
		const allowed = this.policy.dom.allowEvents;
		if (allowed && !allowed.includes(String(type).toLowerCase())) throw new DOMException("DOM event is not permitted: " + type, "NotAllowedError");
	}

	#findNodeId(target) {
		for (const [id, node] of this.#nodeIds) if (node === target) return id;
		return null;
	}

	#attachListener(message) {
		this.#domBridge.policy.check();
		this.#ledger.consume("domMutations", 1);
		if (!Number.isSafeInteger(message.listenerId) || typeof message.eventType !== "string" || !message.eventType || message.eventType.length > 128) {
			throw new DOMException("Invalid DOM listener request", "NotAllowedError");
		}
		this.#assertEvent(message.eventType);
		const target = this.#nodeIds.get(message.id);
		if (!target) {
			this.#pendingListeners.push(message);
			return;
		}
		const handler = nativeEvent => {
			if (this.#terminated || !this.#port) return;
			this.#port.postMessage({
				type: "event",
				listenerId: message.listenerId,
				event: {
					type: nativeEvent.type,
					detail: nativeEvent.detail ?? null,
					targetId: this.#findNodeId(nativeEvent.target),
					bubbles: !!nativeEvent.bubbles,
					cancelable: !!nativeEvent.cancelable
				}
			});
			if (message.once) {
				target.removeEventListener(message.eventType, handler, { capture: !!message.capture });
				this.#domListeners = this.#domListeners.filter(entry => entry.handler !== handler);
			}
		};
		target.addEventListener(message.eventType, handler, { once: !!message.once, capture: !!message.capture });
		this.#domListeners.push({ target, type: message.eventType, handler, listenerId: message.listenerId, once: !!message.once, capture: !!message.capture });
	}

	postMessage(value) {
		if (this.#terminated) throw new DOMException("Process has been terminated", "AbortError");
		this.dispatchEvent(new CustomEvent("message", { detail: value }));
	}

	terminate() {
		if (this.#terminated) return;
		this.#terminated = true;
		try { this.#port?.postMessage({ type: "shutdown" }); } catch {}
		this.#resolveTermination();
		this.#kill?.(new DOMException("Process has been terminated", "AbortError"));
		this.#finish?.(new DOMException("Process has been terminated", "AbortError"));
		this.dispatchEvent(new Event("terminate"));
	}
}

export function create(options = {}) {
	return new PpermProcess(options);
}

export function spawn(code, options = {}) {
	const process = create(options);
	const result = process.run(code);
	return Object.assign(result, { process });
}

export function all(tasks, options = {}) {
	const entries = Array.isArray(tasks) ? tasks : [];
	const jobs = entries.map(task => {
		let code;
		let taskOptions = options;
		if (typeof task === "function") code = "(" + task.toString() + ")()";
		else if (typeof task === "string") code = task;
		else {
			const item = objectOf(task);
			code = String(item.code ?? "");
			taskOptions = mergePolicies(options, item.options);
		}
		const process = create(taskOptions);
		return { process, result: process.run(code) };
	});
	const promise = Promise.all(jobs.map(job => job.result));
	return Object.assign(promise, { processes: jobs.map(job => job.process) });
}

function configureHost(options = {}) {
	const config = objectOf(options);
	if (config.maxConcurrency !== undefined) scheduler.configure(config.maxConcurrency);
	return hostStats();
}

function hostStats() {
	return { maxConcurrency: scheduler.limit, active: scheduler.active, queued: scheduler.queued };
}

export const host = {
	configure: configureHost,
	get stats() { return hostStats(); }
};

export const pperm = {
	create,
	spawn,
	all,
	host
};
export default pperm;
