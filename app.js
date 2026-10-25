'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const grants = {
	network: false,
	storage: false
};

const examples = {
	hello: 'console.log("Hello from CRADOS");\\nconsole.log("2 + 2 =", 2 + 2);',
	dom: 'document.body.innerHTML = "<h2>Guest DOM works.</h2><p>This is the guest document.</p>";\\nconsole.log("Rendered guest DOM.");',
	timer: 'console.log("Timer started");\\nsetTimeout(() => console.log("Timer fired"), 500);'
};

let database;
let guestSequence = 0;
let activeGuest;

function showPage(name) {
	$$('.page').forEach((page) => page.classList.toggle('hidden', page.id !== name));
	$$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.page === name));
}

function log(message) {
	const line = document.createElement('div');
	line.textContent = message;
	$('#output').append(line);
	$('#output').scrollTop = $('#output').scrollHeight;
}

function openDatabase() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open('crados-vfs', 1);

		request.onupgradeneeded = () => {
			request.result.createObjectStore('files', { keyPath: 'name' });
		};

		request.onsuccess = () => {
			database = request.result;
			resolve();
		};

		request.onerror = () => reject(request.error);
	});
}

function requestStore(mode, action) {
	return new Promise((resolve, reject) => {
		const transaction = database.transaction('files', mode);
		const request = action(transaction.objectStore('files'));

		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function listFiles() {
	return requestStore('readonly', (store) => store.getAll());
}

function readFile(name) {
	return requestStore('readonly', (store) => store.get(name));
}

function saveFile(file) {
	return requestStore('readwrite', (store) => store.put({
		...file,
		updated: Date.now()
	}));
}

function deleteFile(name) {
	return requestStore('readwrite', (store) => store.delete(name));
}

async function renderFiles() {
	const files = await listFiles();
	const root = $('#file-list');

	$('#file-count').textContent = `${files.length} 个文件`;
	root.replaceChildren();

	if (files.length === 0) {
		root.textContent = '暂无文件。';
		return;
	}

	files.forEach((file) => {
		const row = document.createElement('div');
		const name = document.createElement('span');
		const open = document.createElement('button');
		const remove = document.createElement('button');

		row.className = 'file-row';
		name.className = 'file-name';
		name.textContent = `${file.name} · ${file.content.length} 字符`;
		open.className = 'button';
		open.textContent = '编辑';
		open.onclick = () => editFile(file);
		remove.className = 'button';
		remove.textContent = '删除';
		remove.onclick = async () => {
			if (confirm(`确定删除 ${file.name}？`)) {
				await deleteFile(file.name);
				await renderFiles();
			}
		};

		row.append(name, open, remove);
		root.append(row);
	});
}

async function editFile(file) {
	const name = prompt('文件名（不能包含斜杠）', file.name);

	if (!name) {
		return;
	}

	if (name.includes('/') || name === '.' || name === '..') {
		alert('文件名无效。');
		return;
	}

	const content = prompt('文件内容', file.content);

	if (content === null) {
		return;
	}

	await saveFile({ name, content });
	await renderFiles();
}

function loadGrants() {
	try {
		Object.assign(grants, JSON.parse(localStorage.getItem('crados-grants') || '{}'));
	} catch {
		grants.network = false;
		grants.storage = false;
	}

	$$('[data-cap]').forEach((input) => {
		input.checked = grants[input.dataset.cap];
	});
}

function saveGrants() {
	localStorage.setItem('crados-grants', JSON.stringify(grants));
}

function guestDocument(id) {
	return [
		'<!doctype html><html><head><meta charset="utf-8">',
		'<style>body{font:13px monospace;color:#202124}</style>',
		'</head><body><script>',
		'const gid = ' + JSON.stringify(id) + ';',
		'let sequence = 0;',
		'const pending = new Map();',
		'function send(type, payload) { parent.postMessage({ tag: "crados", gid, type, payload }, "*"); }',
		'function call(cap, action, args) { return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); send("rpc", { id, cap, action, args }); }); }',
		'const guestConsole = { log: (...args) => send("log", args.map(String).join(" ")), error: (...args) => send("error", args.map(String).join(" ")) };',
		'const api = Object.freeze({',
		'fetch: (url, options = {}) => call("network", "fetch", { url: String(url), method: options.method || "GET", headers: options.headers || {}, body: options.body || "" }),',
		'files: Object.freeze({ list: () => call("storage", "list", {}), read: name => call("storage", "read", { name: String(name) }), write: (name, content) => call("storage", "write", { name: String(name), content: String(content) }) })',
		'});',
		'window.addEventListener("message", event => { const data = event.data; if (!data || data.tag !== "crados" || data.gid !== gid) return; if (data.type === "result") { const item = pending.get(data.payload.id); if (item) { pending.delete(data.payload.id); data.payload.ok ? item.resolve(data.payload.value) : item.reject(Error(data.payload.error)); } } if (data.type === "execute") { try { const fn = new Function("crados", "console", "document", "setTimeout", "clearTimeout", "Promise", data.source); fn(api, guestConsole, document, setTimeout, clearTimeout, Promise); } catch (error) { guestConsole.error(error.stack || error); } } });',
		'send("ready", {});',
		'<\\/script></body></html>'
	].join('');
}

function runGuest() {
	const previous = $('#guest');
	const frame = document.createElement('iframe');
	const id = ++guestSequence;

	frame.id = 'guest';
	frame.title = '沙箱应用';
	frame.setAttribute('sandbox', 'allow-scripts');
	frame.srcdoc = guestDocument(id);
	previous.replaceWith(frame);

	activeGuest = {
		id,
		frame,
		source: $('#source').value,
		ready: false
	};

	$('#output').textContent = '正在启动 Guest…';

	window.setTimeout(() => {
		if (activeGuest?.id === id && !activeGuest.ready) {
			log('Guest 启动超时。');
		}
	}, 1500);
}

function validFileName(name) {
	return Boolean(name) && !name.includes('/') && name !== '.' && name !== '..';
}

async function handleRpc(message) {
	const { id, cap, action, args = {} } = message.payload || {};
	let value;

	try {
		if (cap === 'network' && action === 'fetch') {
			if (!grants.network) {
				throw new Error('网络权限未授权。');
			}

			const url = new URL(args.url);

			if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
				throw new Error('只允许 HTTPS 或 localhost。');
			}

			const method = String(args.method || 'GET').toUpperCase();

			if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
				throw new Error('请求方法不允许。');
			}

			const response = await fetch(url, {
				method,
				headers: args.headers || {},
				body: ['GET', 'HEAD'].includes(method) ? undefined : String(args.body || '')
			});

			value = {
				status: response.status,
				ok: response.ok,
				body: (await response.text()).slice(0, 12000)
			};
		} else if (cap === 'storage') {
			if (!grants.storage) {
				throw new Error('文件权限未授权。');
			}

			if (action === 'list') {
				value = (await listFiles()).map((file) => file.name);
			} else if (action === 'read') {
				if (!validFileName(args.name)) {
					throw new Error('文件名无效。');
				}

				const file = await readFile(args.name);
				value = file ? file.content : null;
			} else if (action === 'write') {
				if (!validFileName(args.name)) {
					throw new Error('文件名无效。');
				}

				if (String(args.content).length > 100000) {
					throw new Error('文件不能超过 100 KB。');
				}

				await saveFile({ name: args.name, content: String(args.content) });
				value = true;
				await renderFiles();
			} else {
				throw new Error('未知文件操作。');
			}
		} else {
			throw new Error('未知权限或操作。');
		}

		activeGuest.frame.contentWindow.postMessage({
			tag: 'crados',
			gid: activeGuest.id,
			type: 'result',
			payload: { id, ok: true, value }
		}, '*');
	} catch (error) {
		activeGuest.frame.contentWindow.postMessage({
			tag: 'crados',
			gid: activeGuest.id,
			type: 'result',
			payload: { id, ok: false, error: error.message }
		}, '*');
	}
}

function handleMessage(event) {
	const data = event.data;

	if (!data || data.tag !== 'crados' || !activeGuest || data.gid !== activeGuest.id || event.source !== activeGuest.frame.contentWindow) {
		return;
	}

	if (data.type === 'ready') {
		activeGuest.ready = true;
		log('Guest 已就绪。');
		activeGuest.frame.contentWindow.postMessage({
			tag: 'crados',
			gid: activeGuest.id,
			type: 'execute',
			source: activeGuest.source
		}, '*');
	} else if (data.type === 'log' || data.type === 'error') {
		log(`[guest${data.type === 'error' ? ' error' : ''}] ${data.payload}`);
	} else if (data.type === 'rpc') {
		handleRpc(data);
	}
}

function updateClock() {
	$('#clock').textContent = new Date().toLocaleTimeString();
}

$$('[data-page]').forEach((button) => {
	button.addEventListener('click', () => showPage(button.dataset.page));
});

$$('[data-open]').forEach((button) => {
	button.addEventListener('click', () => showPage(button.dataset.open));
});

$$('[data-example]').forEach((button) => {
	button.addEventListener('click', () => {
		$('#source').value = examples[button.dataset.example];
		showPage('runtime');
	});
});

$$('[data-cap]').forEach((input) => {
	input.addEventListener('change', () => {
		grants[input.dataset.cap] = input.checked;
		saveGrants();
	});
});

$('#run').addEventListener('click', runGuest);
$('#clear').addEventListener('click', () => {
	$('#output').textContent = '';
});

$('#revoke').addEventListener('click', () => {
	Object.keys(grants).forEach((key) => {
		grants[key] = false;
	});
	$$('[data-cap]').forEach((input) => {
		input.checked = false;
	});
	saveGrants();
});

$('#new-file').addEventListener('click', () => editFile({ name: 'untitled.txt', content: '' }));

document.addEventListener('keydown', (event) => {
	if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
		runGuest();
	}
});

window.addEventListener('message', handleMessage);
updateClock();
window.setInterval(updateClock, 1000);
loadGrants();

openDatabase()
	.then(renderFiles)
	.catch((error) => log(`文件系统初始化失败：${error.message}`));
