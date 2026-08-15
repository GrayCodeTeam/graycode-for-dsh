/**
 * regexGuard 单元测试（F-11 补强）：validateRegexPattern / hasNestedQuantifiedGroups
 * 危险/安全形态矩阵 + 长度上限 + 非法语法 + 修饰符透传。
 *
 * audit-tests.md F-11：此前仅 (a+)+ 一个用例间接覆盖。本文件直测：
 * - 危险形态：平铺组内量词/分支（(a+)+、(a*)*、(a|a)+、(a?)+、(a{2,})*）、
 *   嵌套分组（((a+)+)+、(?:a+|(?:ab))+）、弱量词放大强内层（((a+)+)?）、
 *   定长放大强内层（((a+)+){2}）、可变范围量词（(a{3,})+）
 * - 安全形态：字面量组（(abc)+）、定长范围（(a{2}){2}）、弱内层弱量词（(a+)?）、
 *   字符类内量词（[a+]+）、转义括号（\(a+\)+）、非捕获组（(?:ab)+）、
 *   断言组（(?=a+)b）、无分组连续量词（\d+\s+\w+）
 * - 长度上限 MAX_REGEX_SOURCE_LENGTH=500（超长拒绝、边界放行）
 * - 非法语法（未闭合括号/字符类、占有量词 (ab){2,3}+、a**b）→ Invalid
 * - hasNestedQuantifiedGroups 扫描器自身的正反例（不含 | 分支，其属文档化盲区）
 * - M3：hasAmbiguousAdjacentQuantifiers 相邻无界量词启发式（a+a+、.*a.*b 等）正反例
 */
import { describe, expect, test } from 'vitest'
import {
  hasAmbiguousAdjacentQuantifiers,
  hasNestedQuantifiedGroups,
  MAX_REGEX_SOURCE_LENGTH,
  validateRegexPattern,
} from '../../src/shared/regexGuard.ts'

function expectAccepted(pattern: string, flags?: string): void {
  const result = validateRegexPattern(pattern, flags)
  expect(result.ok, `expected ${JSON.stringify(pattern)} to be accepted, got: ${result.ok ? '' : result.error}`).toBe(true)
}

function expectRejected(pattern: string, messagePart?: RegExp): void {
  const result = validateRegexPattern(pattern)
  if (result.ok) {
    expect.unreachable(`expected ${JSON.stringify(pattern)} to be rejected`)
    return
  }
  if (messagePart) expect(result.error).toMatch(messagePart)
}

describe('validateRegexPattern 长度上限', () => {
  test('MAX_REGEX_SOURCE_LENGTH=500：超长拒绝（too long），边界放行', () => {
    expect(MAX_REGEX_SOURCE_LENGTH).toBe(500)
    expectAccepted('a'.repeat(500))
    const tooLong = validateRegexPattern('a'.repeat(501))
    expect(tooLong.ok).toBe(false)
    if (!tooLong.ok) {
      expect(tooLong.error).toMatch(/too long/i)
      expect(tooLong.error).toContain('501')
    }
  })
})

describe('validateRegexPattern 危险形态（ReDoS）', () => {
  test.each([
    '(a+)+', // 经典灾难性回溯
    '(a*)*',
    '(a|a)+', // 组内分支 + 闭组量词
    '(a?)+', // 组内可选量词
    '(a{2,})*', // 组内可变范围量词
    '((a+)+)+', // 嵌套分组（正则启发式 [^()]* 跨不过，扫描式兜底）
    '((a|a)+)+',
    '(?:a+|(?:ab))+', // 嵌套 + 裸量词原子
    '((a+)+)?', // 弱量词放大强内层
    '((a+)+){2}', // 定长 {n} 放大强内层
    '(a{3,})+', // 可变范围量词修饰闭组
    // M3：无分组相邻/交替无界量词（原文档化盲区，现由 hasAmbiguousAdjacentQuantifiers 拦截）
    'a+a+', // 同字面量相邻量词 → 失败匹配二次回溯
    'a*a+',
    '.*a.*b', // 通配符 . 交替量词
    'a+.*x',
    '\\d+\\d+', // 同转义类相邻量词
    '[a-z]+[a-z]+', // 同字符类相邻量词
  ])('拒绝危险模式 %s', pattern => {
    expectRejected(pattern, /Dangerous regular expression pattern detected/)
  })
})

describe('validateRegexPattern 安全形态（不误伤）', () => {
  test.each([
    'abc',
    'a+b',
    'a{3}',
    '(abc)+', // 组内无量词 → 线性安全
    '(foo)*',
    '(a{2}){2}', // 定长内层 + 定长外层
    '(a+)?', // 弱内层 + 弱量词 → 线性
    '(a|b)c',
    '[a+]+', // 字符类内量词不算
    '\\(a+\\)+', // 转义括号是字面量
    '(?:ab)+', // 非捕获组前缀 ? 不是量词
    '(?=a+)b', // 断言组
    '\\d+\\s+\\w+', // 无分组连续量词（互异互不相交的类，线性安全，M3 不误伤）
    'a+b+c', // 不同字面量的相邻量词 → 线性
    '.+\\.js$', // 单个 . 量词后接转义字面量 → 线性
    '^[a-z0-9_-]+$',
    '(ab)*a+', // 量化闭组 + 后随量词原子：文档化局限（不扩展组内容分析）
  ])('接受安全模式 %s', pattern => {
    expectAccepted(pattern)
  })
})

describe('validateRegexPattern 非法语法', () => {
  test.each(['(unclosed', '[abc', 'a**b', '(ab){2,3}+'])('非法语法 %s → Invalid regular expression', pattern => {
    expectRejected(pattern, /^Invalid regular expression:/)
  })
})

describe('validateRegexPattern 修饰符', () => {
  test('flags 透传并生效（大小写不敏感匹配）', () => {
    const result = validateRegexPattern('abc', 'gi')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.regex.flags).toBe('gi')
      expect(result.regex.test('xABCx')).toBe(true)
    }
  })
})

describe('hasNestedQuantifiedGroups 扫描器正反例', () => {
  test.each(['((a+)+)+', '(a+)+', '((ab)+)+', '((a+)+)?', '((a+)+){2}', '(a{3,})+', '(?:a+|(?:ab))+'])(
    '危险 %s → true',
    pattern => {
      expect(hasNestedQuantifiedGroups(pattern)).toBe(true)
    },
  )

  test.each(['a+', '(abc)+', '(a+)?', '(a{2}){2}', '(?:ab)+', '[a+]+', '\\(a+\\)+', '(?=a+)b'])(
    '安全 %s → false',
    pattern => {
      expect(hasNestedQuantifiedGroups(pattern)).toBe(false)
    },
  )

  test('组内 | 分支歧义为文档化盲区：扫描器放行但 validateRegexPattern 组合检测仍拒绝', () => {
    // 扫描器对 (a|a)+ 不判危险（已知局限：不做定长分支判定）
    expect(hasNestedQuantifiedGroups('(a|a)+')).toBe(false)
    // 组合检测（正则启发式）仍拒绝
    expectRejected('(a|a)+')
  })
})

describe('hasAmbiguousAdjacentQuantifiers（M3 相邻无界量词）', () => {
  test.each(['a+a+', 'a*a+', '.*a.*b', 'a+.*x', '\\d+\\d+', '[a-z]+[a-z]+', 'a+?a+?'])('危险 %s → true', pattern => {
    expect(hasAmbiguousAdjacentQuantifiers(pattern)).toBe(true)
  })

  test.each([
    '\\d+\\s+\\w+', // 互异互不相交 → 线性
    'a+b',
    'a+b+c', // 不同字面量
    '(abc)+',
    '[a-z]+\\d+', // 不相交类
    'a{3}', // 定长不算无界
    '.+\\.js$', // . 量词后无第二个无界量词
  ])('安全 %s → false', pattern => {
    expect(hasAmbiguousAdjacentQuantifiers(pattern)).toBe(false)
  })
})
