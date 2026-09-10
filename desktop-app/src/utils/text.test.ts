import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  splitChapterTitleHeading,
  stripChapterNumberPrefix,
  applyDraftChapterTitle,
  cleanChapterTitleName,
  isPlaceholderChapterTitle,
  parseChapterNumber,
  extractChapterNumber,
  formatNovelForPlatform,
  combineContentAndAuthorNote,
} from './text.ts';

test('章节草稿标题：正文开头的 # 标题被剥出来，重复标题行只取第一行', () => {
  const split = splitChapterTitleHeading('# 第 151 章 黑暗中的后退\n# 第 151 章 黑暗中的后退\n\n林砚僵在门前。');
  assert.equal(split.title, '第 151 章 黑暗中的后退');
  assert.equal(split.content, '林砚僵在门前。');
});

test('章节草稿标题：正文里合法的 Markdown 小节不当成章节标题', () => {
  const split = splitChapterTitleHeading('## 他终究还是回头了，可惜太晚。\n\n后面还有正文。');
  assert.equal(split.title, '');
  assert.equal(split.content, '## 他终究还是回头了，可惜太晚。\n\n后面还有正文。');
});

test('章节草稿标题：占位编号标题补上标题名，章号沿用应用自己的编号', () => {
  assert.equal(applyDraftChapterTitle('第 4 章', '第四章 夜访寒潭'), '第 4 章 夜访寒潭');
  assert.equal(applyDraftChapterTitle('第 4 章', '夜访寒潭'), '第 4 章 夜访寒潭');
  assert.equal(applyDraftChapterTitle('第 4 章', '第四章：夜访寒潭'), '第 4 章 夜访寒潭');
});

test('章节草稿标题：没有章号的占位标题只取标题名，不采用模型数的章号', () => {
  // “新章节”是插在书中间的，模型数的章号大概率对不上真实位置，只留标题名
  assert.equal(applyDraftChapterTitle('新章节', '第四章 夜访寒潭'), '夜访寒潭');
  assert.equal(applyDraftChapterTitle('', '夜访寒潭'), '夜访寒潭');
});

test('章节草稿标题：作者已经起过名的章节不被模型标题覆盖', () => {
  assert.equal(applyDraftChapterTitle('第 4 章 旧城门', '第四章 夜访寒潭'), '第 4 章 旧城门');
  assert.equal(applyDraftChapterTitle('楔子', '第四章 夜访寒潭'), '楔子');
});

test('章节草稿标题：模型只写了章号没写标题名时保持占位标题', () => {
  assert.equal(applyDraftChapterTitle('第 4 章', '第四章'), '第 4 章');
  assert.equal(applyDraftChapterTitle('第 4 章', ''), '第 4 章');
});

test('占位标题判定：批量补标题按它挑出还没有名字的章节', () => {
  for (const title of ['第 12 章', '第十二章', '新章节', '未命名章节', '无标题', '  ', '']) {
    assert.equal(isPlaceholderChapterTitle(title), true, title);
  }
  for (const title of ['第 12 章 夜雨敲窗', '夜雨敲窗', '楔子']) {
    assert.equal(isPlaceholderChapterTitle(title), false, title);
  }
});

test('标题清洗：模型带回的书名号、引号和句末标点逐层剥掉', () => {
  assert.equal(cleanChapterTitleName('《夜雨敲窗》。'), '夜雨敲窗');
  assert.equal(cleanChapterTitleName('“夜雨敲窗”'), '夜雨敲窗');
  assert.equal(cleanChapterTitleName('夜雨敲窗！？'), '夜雨敲窗');
  // 多行只取第一行：模型偶尔在标题后面接一句说明
  assert.equal(cleanChapterTitleName('夜雨敲窗\n（本章完）'), '夜雨敲窗');
  // 正常标题里的标点不该被误剥
  assert.equal(cleanChapterTitleName('夜雨，敲窗人'), '夜雨，敲窗人');
});

test('中文数字解析：支持阿拉伯数字、十、百、千、带空格与两', () => {
  assert.equal(parseChapterNumber('13'), 13);
  assert.equal(parseChapterNumber('一'), 1);
  assert.equal(parseChapterNumber('十'), 10);
  assert.equal(parseChapterNumber('十三'), 13);
  assert.equal(parseChapterNumber(' 十三 '), 13);
  assert.equal(parseChapterNumber('二十'), 20);
  assert.equal(parseChapterNumber('二十五'), 25);
  assert.equal(parseChapterNumber('一百零五'), 105);
  assert.equal(parseChapterNumber('两百三十四'), 234);
  assert.equal(parseChapterNumber('一千零五'), 1005);
  assert.equal(parseChapterNumber('无章号'), null);
});

test('章号提取：支持中文数字章号与带空格格式', () => {
  assert.equal(extractChapterNumber('第 13 章'), 13);
  assert.equal(extractChapterNumber('第十三 章'), 13);
  assert.equal(extractChapterNumber('第 十三 章'), 13);
  assert.equal(extractChapterNumber('第150章'), 150);
  assert.equal(extractChapterNumber('第一百二十回'), 120);
  assert.equal(extractChapterNumber('未命名章节'), null);
});

test('章节草稿标题：支持 overwrite 模式统一定名覆盖', () => {
  assert.equal(applyDraftChapterTitle('第 4 章 旧城门', '第四章 夜访寒潭', { overwrite: true }), '第 4 章 夜访寒潭');
  assert.equal(applyDraftChapterTitle('第 十三 章 旧城门', '第十三章：夜访寒潭', { overwrite: true }), '第 十三 章 夜访寒潭');
});

test('多平台排版预设：标准模式段首加全角双空格，清理空白并压缩连续空行', () => {
  const input = '  第一段文字。  \n\n\n\n   第二段文字。\n\u3000\u3000第三段文字。';
  const expected = '\u3000\u3000第一段文字。\n\n\u3000\u3000第二段文字。\n\u3000\u3000第三段文字。';
  assert.equal(formatNovelForPlatform(input, 'standard'), expected);
});

test('多平台排版预设：纯净模式清理首尾空白，不加缩进', () => {
  const input = '  \u3000第一段文字。  \n\n\n   第二段文字。';
  const expected = '第一段文字。\n\n第二段文字。';
  assert.equal(formatNovelForPlatform(input, 'clean'), expected);
});

test('多平台排版预设：紧凑模式段首缩进且滤除所有空行', () => {
  const input = '第一段。\n\n\n第二段。\n\n第三段。';
  const expected = '\u3000\u3000第一段。\n\u3000\u3000第二段。\n\u3000\u3000第三段。';
  assert.equal(formatNovelForPlatform(input, 'compact'), expected);
});

test('多平台排版预设：原样模式不改变任何格式', () => {
  const input = '  空格保留\n\n\n   多空行保留';
  assert.equal(formatNovelForPlatform(input, 'raw'), input);
});

test('合并正文与作家的话：正确附带作家的话与降级兜底', () => {
  const content = '夜深了，林砚合上了书。';
  const note = '求月票！明天保底三更！';
  const combined = combineContentAndAuthorNote(content, note, 'standard');
  assert.equal(combined, '\u3000\u3000夜深了，林砚合上了书。\n\n【作家的话】\n求月票！明天保底三更！');

  // 作话为空时仅输出格式化正文
  assert.equal(combineContentAndAuthorNote(content, '', 'standard'), '\u3000\u3000夜深了，林砚合上了书。');
  assert.equal(combineContentAndAuthorNote(content, '   ', 'standard'), '\u3000\u3000夜深了，林砚合上了书。');

  // 正文为空但有作话时仅输出作话
  assert.equal(combineContentAndAuthorNote('', note, 'standard'), '【作家的话】\n求月票！明天保底三更！');
});

test('复制标题：去掉章号前缀只留标题名', () => {
  assert.equal(stripChapterNumberPrefix('第12章 夜雨敲窗'), '夜雨敲窗');
  assert.equal(stripChapterNumberPrefix('第 3 章：入城'), '入城');
  assert.equal(stripChapterNumberPrefix('第一百零三回·归途'), '归途');
  assert.equal(stripChapterNumberPrefix('没有章号的标题'), '没有章号的标题');
});

test('复制标题：只有章号占位的标题原样保留', () => {
  assert.equal(stripChapterNumberPrefix('第5章'), '第5章');
});
