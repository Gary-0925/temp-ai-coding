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
let editingFile = null;

function showPage(name) {
	$$('.page').forEach((page) => page.classList.toggle('hidden', page.id !== name));
	$$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.page === name));
}

function formatValue(value) {
	if (typeof value === 'string') {
		return value;
	}

	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function log(message) {
	const output = $('#output');
	const line = document.createElement('div');

	line.textContent = message;
	output.append(line);
	output.scrollTop = output.scrollHeight;

	while (output.childElementCount > 500) {
		output.firstElementChild.remove();
	}
}

function openDatabase() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open('crados-vfs', 1);

		request.onupgradeneeded = () => {
			request.result.createObjectStore('files', { keyPath: 'name' });
		};

		request.onsuccess = () => {
			database = request.result;
			database.onversionchange = () => database.close();
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
		transaction.onabort = () => reject(transaction.error || new Error('文件事务失败。'));
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

function validFileName(name) {
	return typeof name === 'string' && name.trim().length > 0 && name.length <= 120 && !/[\\/\\\\\\0]/.test(name) && name !== '.' && name !== '..';
}

function showFileEditor(file = { name: '', content: '' }) {
	editingFile = file.name || null;
	$('#file-name').value = file.name;
	$('#file-content').value = file.content;
	$('#file-error').textContent = '';
	$('#file-form').classList.remove('hidden');
	$('#file-name').focus();
}

function closeFileEditor() {
	editingFile = null;
	$('#file-form').classList.add('hidden');
	$('#file-error').textContent = '';
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

	files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

	files.forEach((file) => {
		const row = document.createElement('div');
		const info = document.createElement('div');
		const title = document.createElement('strong');
		const meta = document.createElement('small');
		const edit = document.createElement('button');
		const run = document.createElement('button');
		const exportButton = document.createElement('button');
		const remove = document.createElement('button');

		row.className = 'file-row';
		info.className = 'file-name';
		title.textContent = file.name;
		meta.textContent = `${file.content.length} 字符 · ${new Date(file.updated || 0).toLocaleString()}`;
		info.append(title, meta);
		edit.className = 'button';
		edit.textContent = '编辑';
		edit.addEventListener('click', () => showFileEditor(file));
		run.className = 'button';
		run.textContent = '打开';
		run.addEventListener('click', () => {
			$('#source').value = file.content;
			showPage('runtime');
			$('#runtime-status').textContent = `已打开：${file.name}`;
		});
		exportButton.className = 'button';
		exportButton.textContent = '导出';
		exportButton.addEventListener('click', () => downloadFile(file.name, file.content));
		remove.className = 'button';
		remove.textContent = '删除';
		remove.addEventListener('click', async () => {
			if (confirm(`确定删除「${file.name}」？`)) {
				await deleteFile(file.name);
				if (editingFile === file.name) {
					closeFileEditor();
				}
				await renderFiles();
			}
		});

		row.append(info, edit, run, exportButton, remove);
		root.append(row);
	});
}

function downloadFile(name, content) {
	const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');

	link.href = url;
	link.download = name;
	link.click();
	URL.revokeObjectURL(url);
}

async function submitFile(event) {
	event.preventDefault();

	const name = $('#file-name').value.trim();
	const content = $('#file-content').value;

	if (!validFileName(name)) {
		$('#file-error').textContent = '文件名不能为空，且不能包含路径分隔符。';
		return;
	}

	if (content.length > 1000000) {
		$('#file-error').textContent = '文件内容不能超过 1 MB。';
		return;
	}

	if (editingFile && editingFile !== name) {
		const existing = await readFile(name);

		if (existing && !confirm(`「${name}」已存在，是否覆盖？`)) {
			return;
		}

		await deleteFile(editingFile);
	}

	await saveFile({ name, content });
	closeFileEditor();
	await renderFiles();
}

function loadGrants() {
	try {
		const saved = JSON.parse(localStorage.getItem('crados-grants') || '{}');
		grants.network = saved.network === true;
		grants.storage = saved.storage === true;
	} catch {
		grants.network = false;
		grants.storage = false;
	}

	$$('[data-cap]').forEach((input) => {
		input.checked = grants[input.dataset.cap];
	});
}

function saveGrants() {
	try {
		localStorage.setItem('crados-grants', JSON.stringify(grants));
	} catch (error) {
		log(`权限设置无法保存：${error.message}`);
	}
}

function guestDocument(id) {
	return [
		'<!doctype html><html><head><meta charset="utf-8">',
		'<style>body{font:13px monospace;color:#222}</style>',
		'</head><body><script>',
		'const gid = ' + JSON.stringify(id) + ';',
		'let sequence = 0;',
		'const pending = new Map();',
		'function send(type, payload) { parent.postMessage({ tag: "crados", gid, type, payload }, "*"); }',
		'function call(cap, action, args) { return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); send("rpc", { id, cap, action, args }); }); }',
		'const guestConsole = { log: (...args) => send("log", args.map(value => { try { return typeof value === "string" ? value : JSON.stringify(value); } catch { return String(value); } }).join(" ")), error: (...args) => send("error", args.map(value => { try { return typeof value === "string" ? value : JSON.stringify(value); } catch { return String(value); } }).join(" ")) };',
		'const api = Object.freeze({',
		'fetch: (url, options = {}) => call("network", "fetch", { url: String(url), method: options.method || "GET", headers: options.headers || {}, body: options.body || "" }),',
		'files: Object.freeze({ list: () => call("storage", "list", {}), read: name => call("storage", "read", { name: String(name) }), write: (name, content) => call("storage", "write", { name: String(name), content: String(content) }) })',
		'});',
		'window.addEventListener("message", event => { const data = event.data; if (!data || data.tag !== "crados" || data.gid !== gid) return; if (data.type === "result") { const item = pending.get(data.payload.id); if (item) { pending.delete(data.payload.id); data.payload.ok ? item.resolve(data.payload.value) : item.reject(Error(data.payload.error)); } } if (data.type === "execute") { try { const fn = new Function("crados", "console", "document", "setTimeout", "clearTimeout", "Promise", data.source); fn(api, guestConsole, document, setTimeout, clearTimeout, Promise); } catch (error) { guestConsole.error(error.stack || error); } } });',
		'send("ready", {});',
		'</script></body></html>'
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

	$('#output').replaceChildren();
	$('#runtime-status').textContent = '正在启动';

	window.setTimeout(() => {
		if (activeGuest?.id === id && !activeGuest.ready) {
			log('Guest 启动超时。');
			$('#runtime-status').textContent = '启动失败';
		}
	}, 2000);
}

function sendRpcResult(guest, id, ok, payload) {
	if (!guest?.frame.isConnected) {
		return;
	}

	guest.frame.contentWindow.postMessage({
		tag: 'crados',
		gid: guest.id,
		type: 'result',
		payload: { id, ok, ...(ok ? { value: payload } : { error: payload }) }
	}, '*');
}

async function handleRpc(message, guest) {
	const { id, cap, action, args = {} } = message.payload || {};

	try {
		if (!Number.isSafeInteger(id)) {
			throw new Error('无效的请求编号。');
		}

		let value;

		if (cap === 'network' && action === 'fetch') {
			if (!grants.network) {
				throw new Error('网络权限未授权。');
			}

			const url = new URL(args.url);

			if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
				throw new Error('只允许 HTTPS 或 localhost。');
			}

			const method = String(args.method || 'GET').toUpperCase();

			if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
				throw new Error('请求方法不允许。');
			}

			const headers = new Headers();

			if (args.headers && typeof args.headers === 'object') {
				Object.entries(args.headers).slice(0, 30).forEach(([key, item]) => {
					if (typeof item === 'string' && !['cookie', 'host', 'origin', 'referer', 'content-length'].includes(key.toLowerCase())) {
						headers.set(key, item.slice(0, 2000));
					}
				});
			}

			const controller = new AbortController();
			const timeout = window.setTimeout(() => controller.abort(), 15000);

			try {
				const response = await fetch(url, {
					method,
					headers,
					body: ['GET', 'HEAD'].includes(method) ? undefined : String(args.body || '').slice(0, 100000),
					credentials: 'omit',
					redirect: 'error',
					signal: controller.signal
				});

				value = {
					status: response.status,
					ok: response.ok,
					headers: Object.fromEntries([...response.headers].slice(0, 30)),
					body: (await response.text()).slice(0, 20000)
				};
			} finally {
				clearTimeout(timeout);
			}
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

				const content = String(args.content);

				if (content.length > 1000000) {
					throw new Error('文件不能超过 1 MB。');
				}

				await saveFile({ name: args.name, content });
				value = true;
				await renderFiles();
			} else {
				throw new Error('未知文件操作。');
			}
		} else {
			throw new Error('未知权限或操作。');
		}

		sendRpcResult(guest, id, true, value);
	} catch (error) {
		sendRpcResult(guest, id, false, error.message || String(error));
	}
}

function handleMessage(event) {
	const data = event.data;

	if (!data || data.tag !== 'crados' || !activeGuest || data.gid !== activeGuest.id || event.source !== activeGuest.frame.contentWindow) {
		return;
	}

	if (data.type === 'ready') {
		activeGuest.ready = true;
		$('#runtime-status').textContent = '运行中';
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
		handleRpc(data, activeGuest);
	}
}

async function saveSource() {
	const suggested = $('#runtime-status').textContent.startsWith('已打开：')
		? $('#runtime-status').textContent.slice(4)
		: 'main.js';
	const name = prompt('保存为文件名', suggested);

	if (name === null) {
		return;
	}

	if (!validFileName(name)) {
		alert('文件名无效。');
		return;
	}

	const existing = await readFile(name);

	if (existing && !confirm(`「${name}」已存在，是否覆盖？`)) {
		return;
	}

	await saveFile({ name, content: $('#source').value });
	await renderFiles();
	$('#runtime-status').textContent = `已保存：${name}`;
}

async function importFile(event) {
	const file = event.target.files?.[0];

	if (!file) {
		return;
	}

	try {
		if (file.size > 1000000) {
			throw new Error('导入文件不能超过 1 MB。');
		}

		const content = await file.text();
		const existing = await readFile(file.name);

		if (existing && !confirm(`「${file.name}」已存在，是否覆盖？`)) {
			return;
		}

		await saveFile({ name: file.name, content });
		await renderFiles();
	} catch (error) {
		alert(`导入失败：${error.message}`);
	} finally {
		event.target.value = '';
	}
}

$$('[data-page]').forEach((button) => {
	button.addEventListener('click', () => showPage(button.dataset.page));
});

$$('[data-example]').forEach((button) => {
	button.addEventListener('click', () => {
		$('#source').value = examples[button.dataset.example];
		$('#runtime-status').textContent = '示例已载入';
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
$('#save-source').addEventListener('click', () => saveSource().catch((error) => alert(error.message)));
$('#clear').addEventListener('click', () => $('#output').replaceChildren());
$('#new-file').addEventListener('click', () => showFileEditor());
$('#cancel-file').addEventListener('click', closeFileEditor);
$('#file-form').addEventListener('submit', (event) => submitFile(event).catch((error) => {
	$('#file-error').textContent = error.message;
}));
$('#import-file').addEventListener('click', () => $('#import-input').click());
$('#import-input').addEventListener('change', importFile);

$('#revoke').addEventListener('click', () => {
	Object.keys(grants).forEach((key) => {
		grants[key] = false;
	});
	$$('[data-cap]').forEach((input) => {
		input.checked = false;
	});
	saveGrants();
});

$('#source').addEventListener('keydown', (event) => {
	if (event.key === 'Tab') {
		event.preventDefault();
		const start = event.target.selectionStart;
		const end = event.target.selectionEnd;
		event.target.setRangeText('\t', start, end, 'end');
	}
});

document.addEventListener('keydown', (event) => {
	if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
		event.preventDefault();
		runGuest();
	}
});

window.addEventListener('message', handleMessage);
loadGrants();

openDatabase()
	.then(renderFiles)
	.catch((error) => {
		$('#file-list').textContent = `文件系统初始化失败：${error.message}`;
		$('#file-count').textContent = '不可用';
	});
