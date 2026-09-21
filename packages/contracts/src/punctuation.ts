/**
 * 标点归一：引号风格统一与停顿标点（省略号、破折号、双连字符、分隔线）替换
 * 停顿规则移植自 oh-story normalize-punctuation.js 的 choosePauseReplacement；引号转换是本应用自己的：
 * 原脚本默认不动引号，而本书恰恰是引号风格漂了多次，所以做成按项目设置统一到一种风格。
 * 两个入口都是确定性替换，运行时在「采用草稿」和「全书统一标点」时调用，桌面端预览也用同一份
 */

/** “” / 「」 / "" */
export type QuoteStyle = 'curly' | 'corner' | 'ascii';

export interface PunctuationReport {
  text: string;
  /** 替换了多少处 */
  changes: number;
  /** 引号未闭合、原样保留的行号（从 1 起） */
  unbalancedLines: number[];
}

/**
 * 只转双引号族：“” 「」 与 ASCII "。‘’ 与 『』 是对话里的嵌套引用，'' 多半是撇号，都不动；【】是系统面板与标注，不动
 * 方向引号按开闭分别映射，ASCII 引号没有方向，按同一行内出现的奇偶次序判开闭
 */
const quoteTargets: Record<QuoteStyle, { open: string; close: string }> = {
  curly: { open: '“', close: '”' },
  corner: { open: '「', close: '」' },
  ascii: { open: '"', close: '"' },
};
const doubleQuotePattern = /[“”「」"]/g;

/** 逐行拆开并记住各自的行尾：只改标点的一步不该顺手把全文行尾翻成 CRLF 或 LF */
function splitLines(text: string): { lines: string[]; endings: string[] } {
  const lines: string[] = [];
  const endings: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const newline = text.indexOf('\n', cursor);
    if (newline === -1) {
      lines.push(text.slice(cursor));
      endings.push('');
      break;
    }
    const crlf = newline > cursor && text[newline - 1] === '\r';
    lines.push(text.slice(cursor, crlf ? newline - 1 : newline));
    endings.push(crlf ? '\r\n' : '\n');
    cursor = newline + 1;
  }
  return { lines, endings };
}

/** 引号是否在同一行内成对闭合：方向引号按栈配对，ASCII 引号按偶数个 */
function quotesBalanced(line: string): boolean {
  let curly = 0;
  let corner = 0;
  let ascii = 0;
  for (const char of line) {
    if (char === '“') curly += 1;
    else if (char === '”') curly -= 1;
    else if (char === '「') corner += 1;
    else if (char === '」') corner -= 1;
    else if (char === '"') ascii += 1;
    // 先出现收引号也是未闭合
    if (curly < 0 || corner < 0) return false;
  }
  return curly === 0 && corner === 0 && ascii % 2 === 0;
}

/** 全文引号统一到一种风格；【】不动；未闭合的引号所在行原样保留并记入 unbalancedLines */
export function normalizeQuotes(text: string, style: QuoteStyle): PunctuationReport {
  const { lines, endings } = splitLines(text);
  const target = quoteTargets[style];
  const unbalancedLines: number[] = [];
  let changes = 0;
  const output = lines.map((line, index) => {
    if (!quotesBalanced(line)) {
      unbalancedLines.push(index + 1);
      return line + endings[index];
    }
    let asciiSeen = 0;
    const converted = line.replace(doubleQuotePattern, char => {
      let replacement: string;
      if (char === '"') {
        asciiSeen += 1;
        replacement = asciiSeen % 2 ? target.open : target.close;
      } else {
        replacement = char === '“' || char === '「' ? target.open : target.close;
      }
      if (replacement !== char) changes += 1;
      return replacement;
    });
    return converted + endings[index];
  });
  return { text: output.join(''), changes, unbalancedLines };
}

// ---- 停顿标点 ----

const pausePattern = /…+|\.{3,}|——|—|--+/g;

function previousNonSpace(text: string, index: number): string {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(text[cursor])) return text[cursor];
  }
  return '';
}

function nextNonSpace(text: string, index: number): string {
  for (let cursor = index; cursor < text.length; cursor += 1) {
    if (!/\s/.test(text[cursor])) return text[cursor];
  }
  return '';
}

const isSentencePunctuation = (char: string): boolean => /[，,。.!！?？;；:：…]$/.test(char);
const isPunctuation = (char: string): boolean => /[，,。.!！?？;；:：、…"“”'‘’」』）)]/.test(char);
const isClosingQuote = (char: string): boolean => /["”」』]/.test(char);
const isOpeningDelimiter = (char: string): boolean => /[「『（(“‘]/.test(char);

/**
 * 停顿符号按上下文决定替换：正文产物不保留 `……` `——` `—` `--`，对话打断和数字区间也不例外。
 * 数字之间是区间（3到5）；句末删掉或补句号；后接「因为/原来/…」这类揭示语或前接「原因/答案/…」用冒号；其余是逗号
 */
function choosePauseReplacement(text: string, start: number, length: number): string {
  const before = previousNonSpace(text, start - 1);
  const after = nextNonSpace(text, start + length);
  const rest = text.slice(start + length).trimStart();
  if (before === '') return '';
  // 紧跟开引号或开括号的停顿属于句首边界，删空即可，避免产出「，…」或「。」开头的引号
  if (isOpeningDelimiter(before)) return '';
  if (/\d/.test(before) && /\d/.test(after)) return '到';
  if (isClosingQuote(after)) return isSentencePunctuation(before) ? '' : '。';
  if (!after) return isSentencePunctuation(before) ? '' : '。';
  if (isSentencePunctuation(before) || isPunctuation(after)) return '';
  if (/^(因为|原来|这是|那是|也就是|换句话|说白了|所谓|答案|原因|结果|真相|问题在于)/.test(rest)) return '：';
  if (/(原因|答案|真相|结果|结论|问题|选择|意思)$/.test(text.slice(0, start).trim())) return '：';
  return '，';
}

/** 一遍替换；返回改完的行和替换次数 */
function normalizePausesOnce(line: string): { line: string; changes: number } {
  let changes = 0;
  const output = line.replace(pausePattern, (token, offset: number) => {
    changes += 1;
    return choosePauseReplacement(line, offset, token.length);
  });
  return { line: output, changes };
}

/**
 * 省略号、破折号、双连字符按 choosePauseReplacement 规则替换，`---` 整行删除。
 * 删空停顿符会把两侧的半角点或连字符粘成新的 `...` / `--`（「他.……..说」→「他...说」），
 * 一遍留不干净，所以反复归一到不动点：每遍至少把一个停顿字符换成非停顿字符，必然收敛
 */
export function normalizePauses(text: string): PunctuationReport {
  const { lines, endings } = splitLines(text);
  let changes = 0;
  const output: string[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === '---') {
      changes += 1;
      return;
    }
    let current = line;
    for (;;) {
      const pass = normalizePausesOnce(current);
      if (pass.line === current) break;
      changes += pass.changes;
      current = pass.line;
    }
    output.push(current + endings[index]);
  });
  return { text: output.join(''), changes, unbalancedLines: [] };
}

/** 统计三种双引号各出现多少次，返回占多数的风格；全为 0 返回 undefined；平局按 curly > corner > ascii（本应用缺省是弯引号） */
export function detectQuoteStyle(text: string): QuoteStyle | undefined {
  const counts: Record<QuoteStyle, number> = { curly: 0, corner: 0, ascii: 0 };
  for (const match of text.matchAll(doubleQuotePattern)) {
    const char = match[0];
    if (char === '“' || char === '”') counts.curly += 1;
    else if (char === '「' || char === '」') counts.corner += 1;
    else counts.ascii += 1;
  }
  let best: QuoteStyle | undefined;
  for (const style of ['curly', 'corner', 'ascii'] as const) {
    if (counts[style] > 0 && (!best || counts[style] > counts[best])) best = style;
  }
  return best;
}
