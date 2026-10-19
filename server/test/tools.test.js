'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { defineTools } = require('../tools.js');

function createTools(calls) {
    return defineTools({
        msg: async function () {
            const args = Array.from(arguments);
            calls.push(args);
            return { ok: true };
        },
        local: {},
    });
}

function createTreeTool(tree) {
    const tools = defineTools({ msg: async () => tree, local: {} });
    return tools.find((item) => item.name === 'scene_query_node_tree');
}

function sampleTree() {
    return {
        name: 'Main', active: true, locked: false, type: 'cc.Scene', uuid: 'root',
        prefab: { state: 0, isUnwrappable: false },
        children: [
            {
                name: 'A', active: true, locked: false, type: 'cc.Node', uuid: 'a',
                prefab: { state: 1, isUnwrappable: true },
                children: [
                    { name: 'A1', active: false, locked: false, type: 'cc.Node', uuid: 'a1', prefab: { state: 1 }, children: [] },
                    { name: 'A2', active: true, locked: false, type: 'cc.Node', uuid: 'a2', prefab: { state: 1 }, children: [] },
                ],
            },
            { name: 'B', active: true, locked: false, type: 'cc.Node', uuid: 'b', prefab: { state: 0 }, children: [] },
        ],
    };
}

test('scene_query_node_tree 未传裁剪参数时原样返回完整树', async () => {
    const tree = sampleTree();
    const result = await createTreeTool(tree).handler({});
    assert.equal(result, tree);
});

test('scene_query_node_tree brief 只保留基础字段并递归生效，且不修改原树', async () => {
    const tree = sampleTree();
    const before = JSON.stringify(tree);
    const result = await createTreeTool(tree).handler({ brief: true });

    assert.deepEqual(Object.keys(result).sort(), ['active', 'children', 'name', 'type', 'uuid']);
    assert.equal(result.children[0].children[1].name, 'A2');
    assert.equal(result.children[0].prefab, undefined);
    assert.equal(result.children[0].children[0].active, false);
    assert.equal(JSON.stringify(tree), before);
});

test('scene_query_node_tree depth 截断子树并给出 childCount', async () => {
    const tool = createTreeTool(sampleTree());

    const rootOnly = await tool.handler({ depth: 0 });
    assert.equal(rootOnly.childCount, 2);
    assert.deepEqual(rootOnly.children, []);
    assert.deepEqual(rootOnly.prefab, { state: 0, isUnwrappable: false });

    const oneLevel = await tool.handler({ depth: 1, brief: true });
    assert.deepEqual(oneLevel.children.map((child) => child.name), ['A', 'B']);
    assert.equal(oneLevel.children[0].childCount, 2);
    assert.deepEqual(oneLevel.children[0].children, []);
    assert.equal(oneLevel.children[1].childCount, undefined);

    const full = await tool.handler({ depth: 5, brief: true });
    assert.equal(full.children[0].children.length, 2);
});

test('scene_query_node_tree 拒绝非法 depth，且场景为空时原样返回', async () => {
    const tool = createTreeTool(sampleTree());
    await assert.rejects(() => tool.handler({ depth: -1 }), /depth 必须是 >= 0 的整数/);
    await assert.rejects(() => tool.handler({ depth: 1.5 }), /depth 必须是 >= 0 的整数/);
    await assert.rejects(() => tool.handler({ depth: '2' }), /depth 必须是 >= 0 的整数/);
    assert.equal(await createTreeTool(null).handler({ brief: true }), null);
});

test('scene_execute_script 直接转发 execute-scene-script，不经过组件方法', async () => {
    const calls = [];
    const tools = createTools(calls);
    const tool = tools.find((item) => item.name === 'scene_execute_script');

    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.required, ['extension', 'method']);
    await tool.handler({
        extension: 'spine-vat-pipeline',
        method: 'getBakeBatchStatus',
        args: [{ verbose: true }],
    });

    assert.deepEqual(calls, [[
        'scene',
        'execute-scene-script',
        {
            name: 'spine-vat-pipeline',
            method: 'getBakeBatchStatus',
            args: [{ verbose: true }],
        },
    ]]);
});

test('scene_execute_script 缺省 args 使用空数组，原组件工具路由保持不变', async () => {
    const calls = [];
    const tools = createTools(calls);
    const scriptTool = tools.find((item) => item.name === 'scene_execute_script');
    const componentTool = tools.find((item) => item.name === 'scene_execute_component_method');

    await scriptTool.handler({ extension: 'demo-extension', method: 'inspect' });
    await componentTool.handler({ uuid: 'node-uuid', name: 'refresh', args: [1] });

    assert.deepEqual(calls, [
        ['scene', 'execute-scene-script', {
            name: 'demo-extension',
            method: 'inspect',
            args: [],
        }],
        ['scene', 'execute-component-method', {
            uuid: 'node-uuid',
            name: 'refresh',
            args: [1],
        }],
    ]);
});
