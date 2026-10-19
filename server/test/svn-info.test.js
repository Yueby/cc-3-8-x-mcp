'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSvnInfoReader, parseSvnInfoXml, classifyFailure } = require('../svn-info.js');

// 取自真实 `svn info --xml .` 输出（TortoiseSVN 1.14.5）
const VERSIONED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry
   kind="dir"
   path="."
   revision="30940">
<url>http://svn.example.com/svn/REPO/client/cocos/GOT</url>
<relative-url>^/client/cocos/GOT</relative-url>
<wc-info>
<wcroot-abspath>E:/Workspace/GOT</wcroot-abspath>
</wc-info>
<commit
   revision="30933">
<author>someone</author>
</commit>
</entry>
</info>
`;

const CHINESE_XML = VERSIONED_XML.replace(
    '<relative-url>^/client/cocos/GOT</relative-url>',
    '<relative-url>^/client/cocos/GOT/GOTPL001_FZYF%E5%BC%80%E7%96%86%E6%89%A9%E5%9C%9F</relative-url>'
);

const UNVERSIONED_STDERR = [
    "svn: warning: W155010: The node 'E:\\Workspace\\GOT\\proj' was not found.",
    "svn: E200009: Could not display info for all targets because some targets don't exist",
].join('\n');

/** 构造替身 execFile：记录每次调用，并按给定结果回调 */
function createFakeExecFile(result) {
    const calls = [];
    const fake = function (file, args, options, callback) {
        calls.push({ file, args, options });
        setImmediate(() => callback(result.err || null, result.stdout || '', result.stderr || ''));
    };
    fake.calls = calls;
    return fake;
}

test('parseSvnInfoXml 取 entry 自身的版本号，而不是 commit 的版本号', () => {
    assert.deepEqual(parseSvnInfoXml(VERSIONED_XML), { url: '^/client/cocos/GOT', revision: '30940' });
});

test('parseSvnInfoXml 还原百分号编码的中文相对路径', () => {
    assert.equal(parseSvnInfoXml(CHINESE_XML).url, '^/client/cocos/GOT/GOTPL001_FZYF开疆扩土');
});

test('parseSvnInfoXml 对空 info 或无效输入返回 null', () => {
    assert.equal(parseSvnInfoXml('<?xml version="1.0"?>\n<info>\n</info>\n'), null);
    assert.equal(parseSvnInfoXml(''), null);
    assert.equal(parseSvnInfoXml(undefined), null);
});

test('classifyFailure 用错误码识别未版本化，与系统语言无关', () => {
    assert.equal(classifyFailure({ code: 1 }, UNVERSIONED_STDERR), 'unversioned');
    assert.equal(classifyFailure({ code: 1 }, "svn: E155007: 'X' is not a working copy"), 'unversioned');
    // 本地化文案里仍带错误码，因此同样可识别
    assert.equal(classifyFailure({ code: 1 }, 'svn: E155007: “X”不是工作副本'), 'unversioned');
});

test('classifyFailure 把未安装 svn、超时和未知错误归为 unavailable', () => {
    assert.equal(classifyFailure({ code: 'ENOENT' }, ''), 'unavailable');
    assert.equal(classifyFailure({ killed: true, signal: 'SIGTERM' }, ''), 'unavailable');
    assert.equal(classifyFailure({ code: 1 }, 'svn: E170013: Unable to connect to a repository'), 'unavailable');
});

test('read 已版本化目录返回路径与版本号，并通过 cwd 传目录、参数仅含 ASCII', async () => {
    const execFile = createFakeExecFile({ stdout: CHINESE_XML });
    const reader = createSvnInfoReader({ execFile, getCwd: () => 'E:\\项目\\圈出未来' });

    const info = await reader.read();

    assert.deepEqual(info, { state: 'versioned', url: '^/client/cocos/GOT/GOTPL001_FZYF开疆扩土', revision: '30940' });
    assert.equal(execFile.calls.length, 1);
    assert.equal(execFile.calls[0].file, 'svn');
    assert.deepEqual(execFile.calls[0].args, ['info', '--xml', '.']);
    assert.equal(execFile.calls[0].options.cwd, 'E:\\项目\\圈出未来');
    assert.ok(execFile.calls[0].args.every((arg) => /^[\x20-\x7e]*$/.test(arg)));
});

test('read 未版本化目录返回 unversioned 且 url/revision 为空', async () => {
    const execFile = createFakeExecFile({ err: { code: 1 }, stderr: UNVERSIONED_STDERR });
    const info = await createSvnInfoReader({ execFile, getCwd: () => 'D:\\proj' }).read();
    assert.deepEqual(info, { state: 'unversioned', url: '', revision: '' });
});

test('read 在 svn 不可用或输出无法解析时返回 unavailable', async () => {
    const missing = createFakeExecFile({ err: { code: 'ENOENT' } });
    assert.equal((await createSvnInfoReader({ execFile: missing, getCwd: () => 'D:\\p' }).read()).state, 'unavailable');

    const garbage = createFakeExecFile({ stdout: 'not xml' });
    assert.equal((await createSvnInfoReader({ execFile: garbage, getCwd: () => 'D:\\p' }).read()).state, 'unavailable');
});

test('read 在缓存时长内复用结果，过期后重新查询', async () => {
    const execFile = createFakeExecFile({ stdout: VERSIONED_XML });
    let time = 1000;
    const reader = createSvnInfoReader({ execFile, getCwd: () => 'D:\\p', now: () => time, ttlMs: 5000 });

    await reader.read();
    time += 4999;
    await reader.read();
    assert.equal(execFile.calls.length, 1);

    time += 2;
    await reader.read();
    assert.equal(execFile.calls.length, 2);
});

test('read 并发请求合并为一次 svn 调用，目录变化时重新查询', async () => {
    const execFile = createFakeExecFile({ stdout: VERSIONED_XML });
    let cwd = 'D:\\a';
    const reader = createSvnInfoReader({ execFile, getCwd: () => cwd, now: () => 0, ttlMs: 5000 });

    await Promise.all([reader.read(), reader.read(), reader.read()]);
    assert.equal(execFile.calls.length, 1);

    cwd = 'D:\\b';
    await reader.read();
    assert.equal(execFile.calls.length, 2);
    assert.equal(execFile.calls[1].options.cwd, 'D:\\b');
});
