'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const bridgeModule = require('../../server/editor-bridge.js');

let tempHome;
let bridge;
let gateway;
let nextId = 1;
const pending = new Map();

function callGateway(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`gateway response timeout: ${method}`));
        }, 5000);
        pending.set(id, { resolve, reject, timer });
        gateway.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    });
}

before(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-mcp-gateway-test-'));
    const token = 'f'.repeat(64);
    bridge = bridgeModule.createEditorBridge({
        name: 'integration-bridge',
        version: '3.0.0',
        port: 0,
        authToken: token,
        tools: [{
            name: 'echo',
            description: 'echo integration args',
            inputSchema: { type: 'object' },
            handler: async (args) => ({ echoed: args }),
        }],
        resources: [{
            uri: 'cocos://integration',
            name: 'integration resource',
            mimeType: 'application/json',
            read: async () => ({ integrated: true }),
        }],
    });
    await bridge.start();

    const registryDir = path.join(tempHome, '.cocos-mcp', 'editors');
    fs.mkdirSync(registryDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(registryDir, `${process.pid}.json`), JSON.stringify({
        pid: process.pid,
        projectPath: '/tmp/integration-project',
        projectShortName: 'integration',
        url: `http://127.0.0.1:${bridge.port}/bridge`,
        transport: 'editor-bridge',
        extensionVersion: '3.0.0',
        gatewayApiVersion: 2,
        bridgeApiVersion: 1,
        authToken: token,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });

    gateway = spawn(process.execPath, [path.join(__dirname, '..', 'bin.js')], {
        // Windows 上 os.homedir() 读 USERPROFILE 而不是 HOME，两个都要隔离，否则网关会扫到真实注册目录
        env: Object.assign({}, process.env, { HOME: tempHome, USERPROFILE: tempHome }),
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    gateway.on('exit', (code) => {
        for (const item of pending.values()) {
            clearTimeout(item.timer);
            item.reject(new Error(`gateway exited early: ${code}`));
        }
        pending.clear();
    });
    const lines = readline.createInterface({ input: gateway.stdout });
    lines.on('line', (line) => {
        let message;
        try { message = JSON.parse(line); } catch (error) { return; }
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error(message.error.message));
        else item.resolve(message.result);
    });
});

after(async () => {
    if (gateway && gateway.exitCode == null) gateway.kill('SIGTERM');
    if (bridge) await bridge.stop();
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true });
});

test('Gateway 通过 Editor Bridge 聚合并转发 tool/resource', async () => {
    const initialized = await callGateway('initialize', {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'integration-test', version: '1' },
        capabilities: {},
    });
    assert.equal(initialized.serverInfo.name, 'cocos-mcp-gateway');

    const listed = await callGateway('tools/list');
    assert.equal(listed.tools.some((tool) => tool.name === 'integration__echo'), true);

    const called = await callGateway('tools/call', {
        name: 'integration__echo',
        arguments: { value: 9 },
    });
    // Bridge 输出为紧凑 JSON：按解析后的内容断言，不绑定缩进/空格格式
    assert.equal(JSON.parse(called.content[0].text).echoed.value, 9);

    const resources = await callGateway('resources/list');
    const resource = resources.resources.find((item) => item.name.includes('integration resource'));
    assert.ok(resource);

    const read = await callGateway('resources/read', { uri: resource.uri });
    assert.equal(JSON.parse(read.contents[0].text).integrated, true);
});
