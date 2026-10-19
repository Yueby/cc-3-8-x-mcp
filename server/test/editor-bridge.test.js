'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const bridgeModule = require('../editor-bridge.js');

let bridge;
let bridgeUrl;
const token = 'a'.repeat(64);

function post(body, options) {
    options = options || {};
    return new Promise((resolve, reject) => {
        const url = new URL(bridgeUrl);
        const data = options.rawBody === undefined ? JSON.stringify(body) : options.rawBody;
        const headers = {
            'Content-Type': options.contentType || 'application/json',
            'Content-Length': Buffer.byteLength(data),
        };
        if (options.authorized !== false) headers.Authorization = `Bearer ${token}`;
        if (options.origin) headers.Origin = options.origin;
        const req = http.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve({ statusCode: res.statusCode, body: JSON.parse(raw) });
            });
        });
        req.on('error', reject);
        req.end(data);
    });
}

before(async () => {
    bridge = bridgeModule.createEditorBridge({
        name: 'bridge-test',
        version: '3.0.0',
        port: 0,
        authToken: token,
        maxBodyBytes: 256,
        tools: [
            {
                name: 'echo',
                description: 'echo args',
                inputSchema: { type: 'object' },
                handler: async (args) => args,
            },
            {
                name: 'fail',
                handler: async () => { throw new Error('expected failure'); },
            },
        ],
        resources: [
            {
                uri: 'cocos://test',
                name: 'test resource',
                mimeType: 'application/json',
                read: async () => ({ ok: true }),
            },
        ],
    });
    await bridge.start();
    bridgeUrl = `http://127.0.0.1:${bridge.port}/bridge`;
});

after(async () => {
    if (bridge) await bridge.stop();
});

test('describe 一次返回 Bridge 版本、tools 和 resources', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'bridge/describe', params: {} });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.result.bridgeApiVersion, 1);
    assert.equal(res.body.result.serverInfo.name, 'bridge-test');
    assert.deepEqual(res.body.result.tools.map((tool) => tool.name), ['echo', 'fail']);
    assert.deepEqual(res.body.result.resources.map((resource) => resource.uri), ['cocos://test']);
});

test('invoke 保持原 MCP tool result 契约，并把异常变成 isError', async () => {
    const ok = await post({
        jsonrpc: '2.0', id: 2, method: 'bridge/invoke',
        params: { name: 'echo', arguments: { value: 7 } },
    });
    assert.equal(ok.body.result.isError, undefined);
    // 紧凑 JSON 输出：按解析后的内容断言，不绑定缩进/空格格式
    assert.equal(JSON.parse(ok.body.result.content[0].text).value, 7);

    const failed = await post({
        jsonrpc: '2.0', id: 3, method: 'bridge/invoke',
        params: { name: 'fail', arguments: {} },
    });
    assert.equal(failed.body.result.isError, true);
    assert.match(failed.body.result.content[0].text, /expected failure/);
});

test('read-resource 返回 Gateway 可直接转成 MCP 的 contents', async () => {
    const res = await post({
        jsonrpc: '2.0', id: 4, method: 'bridge/read-resource',
        params: { uri: 'cocos://test' },
    });
    assert.equal(res.body.result.contents[0].mimeType, 'application/json');
    assert.equal(JSON.parse(res.body.result.contents[0].text).ok, true);
});

test('工具返回对象时使用紧凑 JSON，不带缩进换行', async () => {
    const res = await post({
        jsonrpc: '2.0', id: 5, method: 'bridge/invoke',
        params: { name: 'echo', arguments: { value: 7 } },
    });
    const text = res.body.result.content[0].text;
    assert.equal(text.includes('\n'), false);
    assert.ok(text.length < JSON.stringify(JSON.parse(text), null, 2).length);
});

test('拒绝无 token、浏览器 Origin、错误 Content-Type 和超限 body', async () => {
    const request = { jsonrpc: '2.0', id: 5, method: 'bridge/ping', params: {} };
    assert.equal((await post(request, { authorized: false })).statusCode, 401);
    assert.equal((await post(request, { origin: 'http://example.com' })).statusCode, 403);
    assert.equal((await post(request, { contentType: 'text/plain' })).statusCode, 415);
    assert.equal((await post(null, { rawBody: JSON.stringify({ data: 'x'.repeat(300) }) })).statusCode, 413);
});
