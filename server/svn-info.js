'use strict';

/**
 * SVN 工作副本信息读取：异步执行 svn，不阻塞编辑器主进程，并在短时间内复用结果。
 *
 * 设计要点：
 * 1. 目录通过 execFile 的 cwd 传入，命令参数里只放 ASCII（目标固定为 '.'）。
 *    Windows 上把含中文的项目路径作为命令行参数交给 svn.exe 会被编码转换弄坏，
 *    表现为"节点不存在"，从而把已版本化的目录误判为未版本化。
 * 2. 使用 --xml 输出：字段名固定、不随系统语言变化，一次进程调用同时拿到路径和版本号。
 * 3. 未版本化/不可用通过 stderr 里的 SVN 错误码判断（错误码不随语言变化），不匹配本地化文案。
 */

/** 表示"目录不在 SVN 版本控制内"的错误码：不是工作副本 / 节点不存在 / 部分目标不存在 */
var UNVERSIONED_CODES = ['E155007', 'W155010', 'E200009'];

var DEFAULT_TTL_MS = 5000;
var DEFAULT_TIMEOUT_MS = 3000;

/** 还原 svn 对相对 URL 做的百分号编码，便于展示中文路径；解码失败时原样返回 */
function decodeUrl(text) {
    try { return decodeURIComponent(text); } catch (e) { return text; }
}

/**
 * 从 `svn info --xml` 的输出中取出相对 URL 和工作副本版本号。
 * @param {string} xml svn info --xml 的 stdout
 * @returns {{url: string, revision: string} | null} 解析失败返回 null
 */
function parseSvnInfoXml(xml) {
    var text = String(xml || '');
    var rev = /<entry\b[^>]*\brevision="(\d+)"/.exec(text);
    if (!rev) return null;
    var url = /<relative-url>([\s\S]*?)<\/relative-url>/.exec(text);
    return { url: url ? decodeUrl(url[1].trim()) : '', revision: rev[1] };
}

/**
 * 判断 svn 失败的原因。
 * @param {Error|null} err execFile 回调里的错误
 * @param {string} stderr svn 的 stderr
 * @returns {'unversioned'|'unavailable'} unversioned 表示目录未纳入 SVN；其余（未安装、超时等）为 unavailable
 */
function classifyFailure(err, stderr) {
    if (err && (err.code === 'ENOENT' || err.killed)) return 'unavailable';
    var text = String(stderr || '');
    for (var i = 0; i < UNVERSIONED_CODES.length; i++) {
        if (text.indexOf(UNVERSIONED_CODES[i]) >= 0) return 'unversioned';
    }
    return 'unavailable';
}

/**
 * 创建 SVN 信息读取器。
 * @param {object} options
 * @param {Function} options.execFile child_process.execFile（测试时注入替身）
 * @param {Function} options.getCwd 返回要查询的目录，每次读取时调用
 * @param {Function} [options.now] 返回毫秒时间戳，默认 Date.now
 * @param {number} [options.ttlMs] 结果缓存时长，默认 5000
 * @param {number} [options.timeoutMs] svn 超时，默认 3000
 * @returns {{read: function(): Promise<{state: string, url: string, revision: string}>}}
 *   state 为 versioned / unversioned / unavailable；非 versioned 时 url 和 revision 为空串
 */
function createSvnInfoReader(options) {
    var execFile = options.execFile;
    var getCwd = options.getCwd;
    var now = options.now || Date.now;
    var ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
    var timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
    var cached = null;   // { at, cwd, promise }：缓存的是 promise，因此并发请求会合并为一次进程调用

    function query(cwd) {
        return new Promise(function (resolve) {
            execFile('svn', ['info', '--xml', '.'], {
                cwd: cwd,
                encoding: 'utf-8',
                timeout: timeoutMs,
                windowsHide: true,
            }, function (err, stdout, stderr) {
                if (err) {
                    resolve({ state: classifyFailure(err, stderr), url: '', revision: '' });
                    return;
                }
                var info = parseSvnInfoXml(stdout);
                resolve(info
                    ? { state: 'versioned', url: info.url, revision: info.revision }
                    : { state: 'unavailable', url: '', revision: '' });
            });
        });
    }

    return {
        read: function () {
            var cwd = getCwd();
            if (cached && cached.cwd === cwd && now() - cached.at < ttlMs) return cached.promise;
            cached = { at: now(), cwd: cwd, promise: query(cwd) };
            return cached.promise;
        },
    };
}

module.exports = {
    createSvnInfoReader: createSvnInfoReader,
    parseSvnInfoXml: parseSvnInfoXml,
    classifyFailure: classifyFailure,
};
