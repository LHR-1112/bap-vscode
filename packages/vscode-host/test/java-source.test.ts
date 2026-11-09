import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendNestedClass,
  classStemFromPath,
  deriveFullClassFromSource,
  isValidFullClassName,
  isValidMethodName,
  parseJavaPackage,
} from '../src/java-source';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bap-js-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 在临时目录写一个 .java 文件，返回绝对路径。 */
function writeJava(rel: string, source: string): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, source, 'utf8');
  return p;
}

function derive(rel: string, source: string): string | undefined {
  const p = writeJava(rel, source);
  return deriveFullClassFromSource(tmp, p, source);
}

describe('parseJavaPackage / classStemFromPath', () => {
  it('解析普通 package 声明（允许缩进与换行）', () => {
    expect(parseJavaPackage('package com.x;')).toBe('com.x');
    expect(parseJavaPackage('\n  package a.b.c;\nclass X {}')).toBe('a.b.c');
    expect(parseJavaPackage('class X {}')).toBeUndefined();
    expect(parseJavaPackage('')).toBeUndefined();
  });

  it('classStemFromPath 去 .java 并拒绝 module-info / package-info', () => {
    expect(classStemFromPath('/ws/src/com/x/Foo.java')).toBe('Foo');
    expect(classStemFromPath('/ws/src/com/x/package-info.java')).toBeUndefined();
    expect(classStemFromPath('/ws/src/com/x/module-info.java')).toBeUndefined();
    expect(classStemFromPath('/ws/src/com/x/Foo.txt')).toBeUndefined();
  });
});

describe('deriveFullClassFromSource', () => {
  it('1) package com.x; + Foo.java → com.x.Foo', () => {
    expect(derive('src/core/Foo.java', 'package com.x;\npublic class Foo {}')).toBe('com.x.Foo');
  });

  it('2) 无 package 时：路径可推导则用路径，否则 undefined（走 InputBox）', () => {
    expect(derive('Foo.java', 'public class Foo {}')).toBeUndefined();
    // src/<folder>/ 布局且无 package 时，路径推导同样得到 Foo。
    expect(derive('src/core/Foo.java', 'public class Foo {}')).toBe('Foo');
  });

  it('3) 注释里的 package 不误判', () => {
    const source = [
      '// package fake.line;',
      '/* package fake.block;',
      '   package fake.block2; */',
      'package real.pkg;',
      'class X {}',
    ].join('\n');
    expect(parseJavaPackage(source)).toBe('real.pkg');
    expect(derive('src/core/X.java', source)).toBe('real.pkg.X');

    const commentsOnly = '// package fake.one;\n/*\npackage fake.two;\n*/\nclass X {}';
    expect(parseJavaPackage(commentsOnly)).toBeUndefined();
    expect(derive('src/core/X.java', commentsOnly)).toBe('X');
  });

  it('4) package-info.java / module-info.java 返回 undefined', () => {
    expect(derive('com/x/package-info.java', 'package com.x;')).toBeUndefined();
    expect(derive('com/x/module-info.java', 'module com.x {}')).toBeUndefined();
  });

  it('7) src/<folder> 布局与 .classpath 布局都能得到正确类名', () => {
    // 常规 src/<folder>/<pkg...>/<Class>.java
    expect(derive('src/core/com/foo/Bar.java', 'package com.foo;\nclass Bar {}')).toBe('com.foo.Bar');
    // .classpath 布局：源码不在工程根的 src/ 下，依赖 package 声明
    expect(derive('module/src/com/foo/Baz.java', 'package com.foo;\nclass Baz {}')).toBe('com.foo.Baz');
    // .classpath 布局且无 package：路径无法推导 -> undefined，由 InputBox 兜底
    expect(derive('module/src/com/foo/Qux.java', 'class Qux {}')).toBeUndefined();
  });
});

describe('标识符校验', () => {
  it('5) isValidFullClassName 合法/非法用例', () => {
    expect(isValidFullClassName('Foo')).toBe(true);
    expect(isValidFullClassName('com.example.Foo')).toBe(true);
    expect(isValidFullClassName('com.example._Foo$1')).toBe(true);
    expect(isValidFullClassName('')).toBe(false);
    expect(isValidFullClassName('com..Foo')).toBe(false);
    expect(isValidFullClassName('.com.Foo')).toBe(false);
    expect(isValidFullClassName('com.example.')).toBe(false);
    expect(isValidFullClassName('com.1Foo')).toBe(false);
    expect(isValidFullClassName('com.exa mple.Foo')).toBe(false);
    expect(isValidFullClassName('com.example.class')).toBe(false);
  });

  it('5) isValidMethodName 合法/非法用例（含构造器标记）', () => {
    expect(isValidMethodName('hello')).toBe(true);
    expect(isValidMethodName('_x1$')).toBe(true);
    expect(isValidMethodName('')).toBe(false);
    expect(isValidMethodName('1bad')).toBe(false);
    expect(isValidMethodName('a.b')).toBe(false);
    expect(isValidMethodName('a-b')).toBe(false);
    expect(isValidMethodName('<init>')).toBe(false);
    expect(isValidMethodName('<clinit>')).toBe(false);
    expect(isValidMethodName('class')).toBe(false);
  });
});

describe('appendNestedClass', () => {
  it('6) 嵌套类链拼接；非法链返回 undefined', () => {
    expect(appendNestedClass('com.x.Outer', ['Inner'])).toBe('com.x.Outer.Inner');
    expect(appendNestedClass('com.x.Outer', ['Inner', 'Deep'])).toBe('com.x.Outer.Inner.Deep');
    expect(appendNestedClass('com.x.Outer', [])).toBe('com.x.Outer');

    expect(appendNestedClass('com.x.Outer', [''])).toBeUndefined();
    expect(appendNestedClass('com.x.Outer', ['1Bad'])).toBeUndefined();
    expect(appendNestedClass('com.x.Outer', ['Inner', 'a.b'])).toBeUndefined();
    expect(appendNestedClass('com..Outer', ['Inner'])).toBeUndefined();
    expect(appendNestedClass('', ['Inner'])).toBeUndefined();
  });
});
