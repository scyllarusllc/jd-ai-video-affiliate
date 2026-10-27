import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src-tauri/src/login-monitor.js', import.meta.url), 'utf8');
function monitor(texts, links = []) {
  const nodes = texts.map(value => ({
    textContent: typeof value === 'string' ? value : value.text,
    get innerText() { return this.textContent; },
    children: [],
    getClientRects: () => typeof value === 'string' || !value.hidden ? [1] : [],
  }));
  const location = { href: 'https://dr.jd.com/' };
  const handlers = {};
  const frames = [];
  const window = { location, addEventListener: (name, callback) => { handlers[name] = callback; } };
  window.top = window.self = window;
  let poll;
  runInNewContext(source.replace('__SESSION_TOKEN__', 'test-token'), {
    URL, window, document: { body: {}, querySelectorAll: selector => selector === 'iframe' ? frames : selector === 'a[href]' ? links.map(href => ({ getAttribute: () => href })) : nodes },
    getComputedStyle: () => ({ visibility: 'visible' }),
    setInterval: callback => { poll = callback; },
  });
  return { location, poll, nodes, window, frames, handlers };
}

test('QR success wins over the still-visible login form', () => {
  const { poll, location } = monitor(['扫码登录', '登录成功']);
  poll();
  assert.equal(location.href, 'https://session-status.invalid/test-token/logged_in');
});
test('hidden success text never marks a logged-out page as logged in', () => {
  const { poll, location } = monitor([{ text: '登录成功', hidden: true }, '扫码登录']);
  poll();
  assert.ok(location.href.endsWith('/logged_out'));
});
test('logout and unrecognized screen replace a previous success', () => {
  const { poll, location, nodes } = monitor(['登录成功']);
  poll();
  nodes[0].textContent = '密码登录';
  poll();
  assert.ok(location.href.endsWith('/logged_out'));
  nodes[0].textContent = '加载中';
  poll();
  assert.ok(location.href.endsWith('/unknown'));
});
test('authenticated logout control is recognized; ordinary content is not', () => {
  for (const [text, expected] of [['退出登录', 'logged_in'], ['如何登录成功', 'unknown']]) {
    const { poll, location } = monitor([text]);
    poll();
    assert.ok(location.href.endsWith('/' + expected));
  }
});
test('subframes report through their parent without navigating', () => {
  const { poll, location, window } = monitor(['登录成功']);
  window.top = { postMessage() {} };
  poll();
  assert.equal(location.href, 'https://dr.jd.com/');
});

test('visible platform login iframe is synchronized, hidden and foreign frames are ignored', () => {
  const context = monitor(['扫码登录']);
  const frame = { contentWindow: {}, isConnected: true, getClientRects: () => [1] };
  context.frames.push(frame);
  const event = { origin: 'https://passport.jd.com', source: frame.contentWindow,
    data: { token: 'test-token', status: 'logged_in' } };
  context.handlers.message({ ...event, origin: 'https://jd.com.evil.example' });
  context.poll();
  assert.ok(context.location.href.endsWith('/logged_out'));
  context.handlers.message({ ...event, data: { token: 'wrong-token', status: 'logged_in' } });
  context.poll();
  assert.ok(context.location.href.endsWith('/logged_out'));
  context.handlers.message(event);
  context.poll();
  assert.ok(context.location.href.endsWith('/logged_in'));
  frame.getClientRects = () => [];
  context.poll();
  assert.ok(context.location.href.endsWith('/logged_out'));
});

test('generic homepage or a plan label alone never proves login', () => {
  const { poll, location } = monitor(['体验套餐']);
  location.href = 'https://www.doubao.com/chat/';
  poll();
  assert.ok(location.href.endsWith('/unknown'));
});

test('verified Doubao account badge and same-origin private drive identify logged-in UI', () => {
  const { poll, location } = monitor(['体验套餐'], ['/chat/drive/?from=sidebar_ai_drive']);
  location.href = 'https://www.doubao.com/chat/';
  poll();
  assert.ok(location.href.endsWith('/logged_in'));
});
test('foreign drive links cannot identify a Doubao login', () => {
  const { poll, location } = monitor(['体验套餐'], ['https://evil.example/chat/drive/']);
  location.href = 'https://www.doubao.com/chat/';
  poll();
  assert.ok(location.href.endsWith('/unknown'));
});

test('verified Doubao login stays recognized when its sidebar is collapsed', () => {
  const page = 'https://www.doubao.com/chat/';
  const context = monitor(['体验套餐'], ['/chat/drive/?from=sidebar_ai_drive']);
  context.location.href = page;
  context.poll();
  assert.ok(context.location.href.endsWith('/logged_in'));
  context.nodes[0].getClientRects = () => [];
  context.location.href = page;
  context.poll();
  assert.ok(context.location.href.endsWith('/logged_in'));
  context.nodes.push({ textContent: '扫码登录', innerText: '扫码登录', getClientRects: () => [1] });
  context.location.href = page;
  context.poll();
  assert.ok(context.location.href.endsWith('/logged_out'));
});

test('hidden profile on an unverified page cannot establish login', () => {
  const context = monitor([{ text: '体验套餐', hidden: true }], ['/chat/drive/']);
  context.location.href = 'https://www.doubao.com/chat/';
  context.poll();
  assert.ok(context.location.href.endsWith('/unknown'));
});

test('explicit login screen overrides a leftover logout menu', () => {
  const context = monitor(['退出登录', '密码登录']);
  context.poll();
  assert.ok(context.location.href.endsWith('/logged_out'));
});

test('manual status probe immediately reports the current page state', () => {
  const context = monitor(['登录成功']);
  context.handlers['jd-status-probe']();
  assert.ok(context.location.href.endsWith('/logged_in'));
});
