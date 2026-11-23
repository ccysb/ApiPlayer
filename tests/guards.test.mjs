import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripQuoted, checkAlpineExpressions, checkMethodDefinitions } from '../scripts/lib/guards.mjs';

test('stripQuoted 剥掉单引号内容', () => {
    assert.equal(stripQuoted("go('/a/b')"), "go('')");
});

test('stripQuoted 剥掉双引号与反引号内容', () => {
    assert.equal(stripQuoted('a "x/y" b'), 'a "" b');
    assert.equal(stripQuoted('a `x;y` b'), 'a `` b');
});

test('Alpine 守卫：引号内斜杠放行（Tailwind 类名）', () => {
    const html = '<button class="bg-primary-900/30" @click="go(\'/path\')">x</button>';
    const { unsupportedSlash, unsupportedComplex } = checkAlpineExpressions(html);
    assert.deepEqual(unsupportedSlash, []);
    assert.deepEqual(unsupportedComplex, []);
});

test('Alpine 守卫：裸斜杠拦截', () => {
    const html = '<button x-text="a/b">x</button>';
    const { unsupportedSlash } = checkAlpineExpressions(html);
    assert.deepEqual(unsupportedSlash, ['a/b']);
});

test('Alpine 守卫：分号组合语句拦截', () => {
    const html = '<button @click="foo(); bar()">x</button>';
    const { unsupportedComplex } = checkAlpineExpressions(html);
    assert.deepEqual(unsupportedComplex, ['foo(); bar()']);
});

test('Alpine 守卫：&&( 逗号表达式拦截', () => {
    const html = '<button @click="page>1&&(page--,loadData())">x</button>';
    const { unsupportedComplex } = checkAlpineExpressions(html);
    assert.equal(unsupportedComplex.length, 1);
});

test('方法守卫：缺失方法被列出', () => {
    const code = `
        function app() {
            init() { this.applyPortraitNarrow(); },
            good() {}
        }
    `;
    assert.deepEqual(checkMethodDefinitions(code), ['applyPortraitNarrow']);
});

test('方法守卫：合法方法与内置方法放行', () => {
    const code = `
        function app() {
            init() { this.good(); this.$nextTick(); },
            good() {}
        }
    `;
    assert.deepEqual(checkMethodDefinitions(code), []);
});

test('方法守卫：async 方法算作已定义', () => {
    const code = `
        function app() {
            init() { this.loadData(); },
            async loadData() {}
        }
    `;
    assert.deepEqual(checkMethodDefinitions(code), []);
});
