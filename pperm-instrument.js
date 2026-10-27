const tickPrefix = "__pperm_tick_";

function nodeChildren(node) {
	const children = [];
	for (const key of Object.keys(node)) {
		if (["start", "end", "loc", "range", "type", "extra"].includes(key)) continue;
		const value = node[key];
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item && typeof item === "object" && typeof item.type === "string") children.push(item);
			}
		} else if (value && typeof value === "object" && typeof value.type === "string") {
			children.push(value);
		}
	}
	return children;
}

function collectEdits(node, source, tick, edits) {
	if (!node || typeof node !== "object" || typeof node.type !== "string") return;
	const type = node.type;
	const body = node.body;
	const isLoop = ["WhileStatement", "DoWhileStatement", "ForStatement", "ForInStatement", "ForOfStatement"].includes(type);
	const isFunction = ["FunctionDeclaration", "FunctionExpression"].includes(type);
	const isArrow = type === "ArrowFunctionExpression";
	if ((isLoop || isFunction || isArrow) && body) {
		if (body.type === "BlockStatement") {
			let position = body.start + 1;
			let text = tick + "();";
			for (const statement of body.body) {
				if (statement.type !== "ExpressionStatement" || statement.expression?.type !== "Literal" || typeof statement.expression.value !== "string") break;
				position = statement.end;
				text = ";" + tick + "();";
			}
			edits.push({ pos: position, order: 0, text });
		} else if (isLoop) {
			edits.push({ pos: body.start, order: 1, text: "{" + tick + "();" });
			edits.push({ pos: body.end, order: 0, text: "}" });
		}
	}
	if (type === "SwitchCase") {
		const statements = node.consequent ?? [];
		if (statements.length) edits.push({ pos: statements[0].start, order: 1, text: tick + "();" });
	}
	for (const child of nodeChildren(node)) collectEdits(child, source, tick, edits);
}

function chooseTickName(source) {
	let suffix = 0;
	while (source.includes(tickPrefix + suffix)) suffix++;
	return tickPrefix + suffix;
}

export function instrument(code, parse, options = {}) {
	const source = String(code);
	const tick = chooseTickName(source);
	const prefix = "(async function(){\n";
	const suffix = "\n})";
	const wrapped = prefix + source + suffix;
	let parsed;
	try {
		parsed = parse(wrapped, { ecmaVersion: "latest", sourceType: "script", ranges: true, allowReturnOutsideFunction: false });
	} catch (error) {
		const syntax = new SyntaxError(error?.message ?? "Invalid JavaScript source");
		syntax.name = "SyntaxError";
		throw syntax;
	}
	const outer = parsed.body?.[0]?.expression;
	if (!outer || outer.type !== "FunctionExpression" || !outer.body) throw new SyntaxError("Unable to instrument source");
	const edits = [];
	collectEdits(outer.body, wrapped, tick, edits);
	if (!edits.length) return { code: source, tick, instrumented: true, points: 0 };
	const offset = prefix.length;
	const local = edits.map(edit => ({ ...edit, pos: edit.pos - offset })).filter(edit => edit.pos >= 0 && edit.pos <= source.length);
	local.sort((a, b) => b.pos - a.pos || b.order - a.order);
	let output = source;
	for (const edit of local) output = output.slice(0, edit.pos) + edit.text + output.slice(edit.pos);
	return { code: output, tick, instrumented: true, points: local.length };
}

export async function loadParser() {
	try {
		const module = await import("acorn");
		return typeof module.parse === "function" ? module.parse : null;
	} catch {
		return null;
	}
}
