/**
 * 构建期守卫的纯函数实现（从 build-extension.mjs 抽出，便于单元测试）。
 * 行为与原内嵌版本完全一致，不改变构建产物。
 */

/**
 * 剥掉表达式中引号包裹的内容，避免误伤 Tailwind 类名里的斜杠（如 bg-primary-900/30）。
 */
export function stripQuoted(expr) {
    return expr
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

/**
 * 检查 HTML 里的 Alpine 属性表达式是否含 CSP 解析器不支持的语法。
 * 返回 { unsupportedSlash: string[], unsupportedComplex: string[] }，均为原始表达式。
 */
export function checkAlpineExpressions(html) {
    const unsupportedSlash = [];
    const unsupportedComplex = [];
    for (const m of html.matchAll(/\s(?:x-[\w.-]+|@[\w.:-]+|:[\w.-]+)="([^"]*)"/g)) {
        const bare = stripQuoted(m[1]);
        if (bare.includes('/')) unsupportedSlash.push(m[1]);
        if (bare.includes(';') || /&&\(/.test(bare)) unsupportedComplex.push(m[1]);
    }
    return { unsupportedSlash, unsupportedComplex };
}

const BUILTIN_METHODS = new Set(['then', 'catch', 'finally', '$nextTick', '$watch', '$dispatch', '$el', '$refs']);

/**
 * 检查 app 代码里 this.xxx() 调用是否都有对应方法定义。
 * 返回缺失的方法名数组（已去重）。
 */
export function checkMethodDefinitions(appCode) {
    const calledMethods = [...appCode.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
    const definedMethods = new Set([...appCode.matchAll(/^\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]));
    return [...new Set(calledMethods)].filter((name) => !definedMethods.has(name) && !BUILTIN_METHODS.has(name));
}
