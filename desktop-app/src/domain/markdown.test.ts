import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownExcerpt, renderMarkdown } from './markdown.ts';

test('GFM 表格渲染成 table，含对齐与表头', () => {
  const html = renderMarkdown(['| 境界 | 破坏力 |', '| --- | :-: |', '| 一境 | 破砖墙 |', '| 五境 | 抹一座城 |'].join('\n'));
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th style="text-align:left">境界</th>'));
  assert.ok(html.includes('<th style="text-align:center">破坏力</th>'));
  assert.ok(html.includes('<td style="text-align:left">五境</td>'));
  assert.ok(html.includes('<td style="text-align:center">抹一座城</td>'));
});

test('缺分隔行时不当表格，竖线按原文段落输出', () => {
  const html = renderMarkdown('| 不是表格 |\n普通一行');
  assert.ok(!html.includes('<table>'));
  assert.ok(html.includes('| 不是表格 |'));
});

test('围栏代码块里的竖线和星号原样保留，不被当成表格或强调', () => {
  const html = renderMarkdown(['```', '| a | b |', '**not bold**', '```'].join('\n'));
  assert.ok(html.includes('| a | b |'));
  assert.ok(html.includes('**not bold**'));
  assert.ok(!html.includes('<table>'));
  assert.ok(!html.includes('<strong>'));
});

test('标题、引用、列表与行内强调都能渲染，尖括号被转义', () => {
  const html = renderMarkdown(['## 二、宗门', '> 引一句', '- 甲 **加粗**', '1. 乙 `code`', '<script>x</script>'].join('\n'));
  assert.ok(html.includes('<h2>二、宗门</h2>'));
  assert.ok(html.includes('<blockquote>引一句</blockquote>'));
  assert.ok(html.includes('<li>甲 <strong>加粗</strong></li>'));
  assert.ok(html.includes('<li>乙 <code>code</code></li>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('摘要跳过标题与表格行，优先取正文首句', () => {
  assert.equal(markdownExcerpt('# 标题\n| a | b |\n他是谁？'), '他是谁？');
  assert.equal(markdownExcerpt(''), '');
});
