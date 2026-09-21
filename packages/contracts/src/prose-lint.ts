/**
 * 正文本地验证门：不调模型、毫秒级、字节稳定的纯函数
 * 规则移植自 oh-story 的 check-ai-patterns.js / check-degeneration.js / check-outline-copy.js，
 * 正则与阈值原样保留（它们在真人语料上校准过），另加本书实测出的开头/结尾同型、沉默词密度与对话密度。
 * 放在契约层是因为桌面端要在草稿面板上即时显示，运行时要在连续创作里按 blocking 决定是否定向修订，
 * 两端必须对同一段正文报出同一份结果。不依赖任何 Node 或浏览器特有 API。
 */

export type LintSeverity = 'blocking' | 'advisory';

export interface LintFinding {
  type: string;
  severity: LintSeverity;
  /** 行号从 1 起，按原文物理行计 */
  line: number;
  column: number;
  excerpt: string;
  message: string;
}

export interface LintContext {
  /** 本章构思/章纲全文：outline-copy 用它比对，没有就不查 */
  outline?: string;
  /** 最近几章的开头句与结尾句（各一句），opening-echo / ending-echo 用；按时间顺序，最后一项是紧邻上一章 */
  recentOpenings?: string[];
  recentEndings?: string[];
  /** 作者允许的字面片段（一行一个），命中这些片段的风格类 finding 不报 */
  allowedPhrases?: string[];
}

/**
 * 成对引号（台词、系统播报、弹幕）。片段一律不跨行：正文漏收引号很常见（多段台词只在末段收尾、
 * 全半角混用），允许跨行配对时一个未闭合的开引号会把后面几百字全算成引号内，整段叙述被静默豁免
 */
const quotePairs: ReadonlyArray<readonly [string, string]> = [['「', '」'], ['『', '』'], ['【', '】'], ['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"]];
const quotePatterns = quotePairs.map(([open, close]) => new RegExp(`${open}[^${close}\\n]*${close}`, 'g'));

/** 可见字：汉字、全角字母、半角字母数字；密度类规则的分母和长短句判定都按这个口径 */
const visiblePattern = /[一-鿿Ａ-ｚA-Za-z0-9]/g;
const stopChars = new Set(['。', '！', '？', '!', '?', '\n']);

/** markdown 结构行：标题、引用、列表、有序列表、表格、分隔线，不是叙述正文，所有规则都跳过 */
const structuralPattern = /^(?:#|>|[-*+]\s|\d+[.)]\s|\||-{3,}$|[*_]{3,}$)/;
/** 章标题行：本应用的标题格式是「第 12 章」带空格，比原脚本放宽了数字两侧的空白 */
const chapterTitlePattern = /^第\s*[零一二三四五六七八九十百千万两\d]+\s*章(?:\s|_|$)/;

interface ProseLine {
  line: number;
  /** 原始行及其去空白形态：退化类规则（复读/截断/占位/工程词）看这一份，不受允许片段影响 */
  text: string;
  trimmed: string;
  /** 允许片段已换成等长「？」占位的行：风格类规则只看这一份 */
  styled: string;
  /** styled 再把成对引号等长遮掉：逐处 blocking 规则在它上面定位，列号与原文一致 */
  masked: string;
  /** styled 去首尾空白、去掉成对引号片段后的叙述部分，密度类规则只数它的可见字数 */
  narrative: string;
  narrativeLength: number;
  /** 与上一条正文行之间隔着标题、列表、分隔线或代码围栏：碎句号计数、跨段并列窗口和跨行对比句扫描在这里断开 */
  afterBreak: boolean;
}

function visibleLength(text: string): number {
  return (text.match(visiblePattern) || []).length;
}

function stripQuoted(text: string): string {
  return quotePatterns.reduce((out, pattern) => out.replace(pattern, ''), text);
}

/**
 * 引号片段（含引号）换成等长「？」：既豁免台词，又保住原文偏移。占位用「？」而不是句号，
 * 因为它要截断各规则的 [^。！？!?] 否定类，又不能替 trailer-summary 的句末 [。！] 伪造出终止符
 */
function maskQuoted(text: string): string {
  return quotePatterns.reduce((out, pattern) => out.replace(pattern, match => '？'.repeat(match.length)), text);
}

/** 允许的字面片段同样换成等长「？」：风格类规则看不见它，占位符也不会跨过片段拼出新的命中 */
function maskAllowed(text: string, phrases: readonly string[]): string {
  return phrases.reduce((out, phrase) => out.replaceAll(phrase, '？'.repeat(phrase.length)), text);
}

/** 引号片段（含引号本身）的 [start, end) 区间 */
function quotedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const pattern of quotePatterns) {
    for (const match of text.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function compact(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function splitSentences(text: string): string[] {
  return text.split(/[。！？!?]/).map(item => item.trim()).filter(Boolean);
}

/** 取命中位置所在的整句，做密度类规则的样例 */
function sentenceAround(text: string, index: number): string {
  let start = index;
  while (start > 0 && !stopChars.has(text[start - 1])) start -= 1;
  let end = index;
  while (end < text.length && !stopChars.has(text[end])) end += 1;
  return compact(text.slice(start, end));
}

function finding(type: string, severity: LintSeverity, line: number, column: number, excerpt: string, message: string): LintFinding {
  return { type, severity, line, column, excerpt, message };
}

/** YAML front matter 只认「首行 --- 且 40 行内有 key: value 再遇 ---」，避免把正文开头的分隔线当成元数据吞掉 */
function hasYamlFrontMatter(lines: readonly string[]): boolean {
  if (!lines.length || lines[0].trim() !== '---') return false;
  let sawField = false;
  for (let index = 1; index < Math.min(lines.length, 40); index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === '---') return sawField;
    if (/^[A-Za-z0-9_-]+:\s*/.test(trimmed)) sawField = true;
  }
  return false;
}

/** 把原文拆成参与检查的正文行：跳过 front matter、代码围栏、空行和结构行，其余行预先算好各规则要看的形态 */
function collectLines(text: string, allowedPhrases: readonly string[] = []): ProseLine[] {
  const raw = text.split(/\r?\n/);
  // 设置里「一行一个」难免带空行，空片段会让 replaceAll 在每个字符之间插占位
  const phrases = allowedPhrases.map(item => item.trim()).filter(Boolean);
  const lines: ProseLine[] = [];
  let inFrontMatter = hasYamlFrontMatter(raw);
  let fence: { char: string; length: number } | null = null;
  let afterBreak = false;
  for (let index = 0; index < raw.length; index += 1) {
    const trimmed = raw[index].trim();
    if (inFrontMatter) {
      if (index > 0 && trimmed === '---') inFrontMatter = false;
      afterBreak = true;
      continue;
    }
    const marker = /^(?:`{3,}|~{3,})/.exec(trimmed);
    if (fence) {
      if (marker && marker[0][0] === fence.char && marker[0].length >= fence.length) fence = null;
      afterBreak = true;
      continue;
    }
    if (marker) {
      fence = { char: marker[0][0], length: marker[0].length };
      afterBreak = true;
      continue;
    }
    if (!trimmed) continue;
    if (structuralPattern.test(trimmed) || chapterTitlePattern.test(trimmed)) {
      afterBreak = true;
      continue;
    }
    const styled = maskAllowed(raw[index], phrases);
    const narrative = stripQuoted(styled.trim());
    lines.push({ line: index + 1, text: raw[index], trimmed, styled, masked: maskQuoted(styled), narrative, narrativeLength: visibleLength(narrative), afterBreak });
    afterBreak = false;
  }
  return lines;
}

// ---- 对比句式（不是 A，而是 B）：跨行扫描，成对引号内豁免 ----

const softSeparators = new Set(['，', ',', '、', '；', ';', '：', ':']);
const hardSeparators = new Set(['。', '.', '！', '!', '？', '?']);
const maxNegativeSpan = 80;
const maxPositiveSpan = 80;
/** 「不是A就是B / 也是B」里紧贴的「是」是连词的一部分；含「不」以沿用「不是A，也不是B」第二段不算翻转 */
const compactEitherOrPrev = new Set(['不', '就', '也']);
/** 「…，是吗 / 是吧 / 是嘛」是反问尾巴，不是否定后的肯定翻转 */
const tagParticles = new Set(['吗', '吧', '嘛']);
/** 「不是第一次来。是的，他还记得」里的「是的/是啊」是承接确认，不是翻转 */
const affirmationTagParticles = new Set(['的', '啊', '呀', '呢']);
const affirmationTagBoundary = new Set(['', '，', ',', '。', '.', '！', '!', '？', '?', '、', '；', ';', '：', ':', '\n', '\r', '\t', ' ']);

function isAffirmationTagAt(text: string, index: number): boolean {
  if (text[index] !== '是') return false;
  if (!affirmationTagParticles.has(text[index + 1])) return false;
  return affirmationTagBoundary.has(text[index + 2] || '');
}

/** 跳过行内空白与换行（含空行），停在下一个实义字符：「不是A。（空行）是B」这种分段揭示句也要抓 */
function skipGap(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t' || text[cursor] === '\r' || text[cursor] === '\n')) cursor += 1;
  return cursor;
}

/** 从「不是」之后找肯定翻转的「是/而是」结束位置，找不到返回 -1 */
function findPositiveFlipEnd(candidate: string): number {
  let index = 2;
  let scanned = 0;
  let crossedSeparator = false;
  while (index < candidate.length && scanned <= maxNegativeSpan) {
    const char = candidate[index];
    if (candidate.startsWith('而是', index)) return index + 2;
    if (softSeparators.has(char)) {
      const next = skipGap(candidate, index + 1);
      if (candidate.startsWith('而是', next)) return next + 2;
      if (candidate[next] === '是' && !tagParticles.has(candidate[next + 1]) && !isAffirmationTagAt(candidate, next)) return next + 1;
      crossedSeparator = true;
    }
    if (hardSeparators.has(char)) {
      const next = skipGap(candidate, index + 1);
      if (candidate[next] === '是' && !tagParticles.has(candidate[next + 1]) && !isAffirmationTagAt(candidate, next)) return next + 1;
      if (char !== '.') break;
      crossedSeparator = true;
    }
    if (stopChars.has(char)) break;
    // 紧凑形「不是A是B」只认第一个分句：过了分隔符之后的「是」多半是只是/可是/还是这类连词的尾字，
    // 没有词表分不清「，他是」和「，可是」，硬门禁上误报（逼着重写好句）比漏报代价更大
    if (char === '是' && !compactEitherOrPrev.has(candidate[index - 1]) && !crossedSeparator) return index + 1;
    index += 1;
    scanned += 1;
  }
  return -1;
}

function extractNotIs(candidate: string, markerEnd: number): string {
  let end = markerEnd;
  const limit = Math.min(candidate.length, markerEnd + maxPositiveSpan);
  while (end < limit && !stopChars.has(candidate[end])) end += 1;
  return candidate.slice(0, end).replace(/[\s|）)】\]]+$/u, '');
}

/** 连续正文行拼成一块扫描，行首偏移用来把命中位置换算回行号与列号 */
function scanNotIsBlock(block: readonly ProseLine[]): LintFinding[] {
  const text = block.map(item => item.styled).join('\n');
  const starts: number[] = [];
  let cursor = 0;
  for (const item of block) {
    starts.push(cursor);
    cursor += item.styled.length + 1;
  }
  const quoted = quotedRanges(text);
  const findings: LintFinding[] = [];
  let offset = 0;
  while (offset < text.length) {
    const start = text.indexOf('不是', offset);
    if (start === -1) break;
    // 引号内是台词：口语里「不是A，是B」是自然辩解或反问；「是不是」是问句
    const skip = quoted.some(([from, to]) => start >= from && start < to) || (start > 0 && text[start - 1] === '是');
    const markerEnd = skip ? -1 : findPositiveFlipEnd(text.slice(start));
    if (markerEnd === -1) {
      offset = start + 2;
      continue;
    }
    const raw = extractNotIs(text.slice(start), markerEnd);
    if (raw.length >= 4) {
      let row = 0;
      while (row + 1 < starts.length && starts[row + 1] <= start) row += 1;
      findings.push(finding('not-is-comparison', 'blocking', block[row].line, start - starts[row] + 1, compact(raw), '高频 AI 对比句式「不是A，而是B」：删掉否定铺垫，直接写后项，或改成动作、细节呈现'));
    }
    offset = start + Math.max(raw.length, 2);
  }
  return findings;
}

function findNotIs(lines: readonly ProseLine[]): LintFinding[] {
  const findings: LintFinding[] = [];
  let block: ProseLine[] = [];
  for (const line of lines) {
    if (line.afterBreak && block.length) {
      findings.push(...scanNotIsBlock(block));
      block = [];
    }
    block.push(line);
  }
  if (block.length) findings.push(...scanNotIsBlock(block));
  return findings;
}

// ---- 实战漏网句式：逐处 blocking，只扫引号外，位置与摘录取自原文 ----

/** 反序对比「是A，不是B」；前字排除表覆盖全部「X是」连词/副词合成词（还是/只是/可是…） */
const reverseNotIsPattern = /是([^。！？!?\n，,]{1,12})[，,]\s*(?:而)?不是([^。！？!?\n]{1,20})/g;
const reverseNotIsPrevExclude = new Set([...compactEitherOrPrev, '还', '只', '可', '但', '于', '倒', '像', '若', '要', '正', '便', '总', '老', '更', '最', '算', '怕', '凡', '或', '即', '自', '竟', '原', '本', '仍', '许', '净', '光', '单', '尽']);

/**
 * 否定排比：同句 ≥2 个「没有X，」连排，或「没X，没Y，只是Z」先否定后肯定。只收「没/没有」段，
 * 「不哭不闹」类真人叙述太常见不收。光杆「没」要挡黏着语素（沉没/淹没…）和时间惯用语（没多久/没等X）
 */
const negationParadePatterns = [
  /(?:没有[^。！？!?\n，,]{1,12}[，,]){2}/g,
  /(?<![沉淹埋出隐湮吞覆漫泯])没(?!有?过?多久)(?:有)?[^。！？!?\n，,]{1,12}[，,]\s*没(?!有?过?多久)(?:有)?[^。！？!?\n，,]{1,16}[，,。.][^。！？!?\n，,]{0,6}只(?:是|会|有)/g,
];

/** 音量反差腔「声音不高，第一句却…」：音量词与转折词都放开，只固定「声音不X…却/但/偏」骨架 */
const voiceContrastPattern = /声音(?:并)?不[大高响亮][^。！？!?\n]{0,16}[却但偏]/g;

const emDashPattern = /——|—|--+/g;

/** 预告式收尾：「正式拉开序幕」是场内报幕，不是叙述者预告，lookbehind 排除 */
const trailerEndingPattern = /没人知道|谁也不知道|谁也没想到|殊不知|(?:这)?才刚刚开(?:始|头)|正(?:朝着|向着)[^。！？!?\n]{0,24}(?:压|涌|袭|逼)(?:了?过去|了?过来|来)|(?<!正式)拉开(?:序幕|帷幕)|即将(?:开始|来临|降临)/g;
/**
 * 章尾状态总结体：各分支都要求落在句末断言位，否则会吃进条件从句（等这一切结束了，我们就…）、
 * 成语跨匹配（这一刻…命中注定）、系表（这一战的结果是注定的）和否定认知（他不知道这一切意味着什么）
 */
const trailerSummaryPattern = /这一(?:夜|天|刻|战|年|局|役)[，,]?[^。！？!?，,\n]{0,6}(?<!命中)(?<!是)注定[^。！？!?\n]{0,8}[。！]|就这样[，,][^。！？!?，,\n]{0,8}(?:一切|全部)[^。！？!?，,\n]{0,4}(?:结束了|落幕|收场)[。！]|这一切[，,]?[^。！？!?，,\n]{0,6}(?:都)?(?:说明|意味着|结束了)(?!的)(?:(?!什么)[^。！？!?\n]){0,6}[。！]|(?:新的篇章|新的旅程|崭新的篇章|新的人生)[^。！？!?\n]{0,6}(?:开始|拉开|展开)|命运[^。！？!?\n]{0,6}齿轮/g;
/** 文末窗口按剥引号后的可见字数取，按行取整，边界行整行计入 */
const trailerWindowChars = 600;

/** 工整并列只做 advisory，故意连台词一起扫：点单「不放辣，不放葱」靠对象最短长度排除 */
const decisionFramePattern = /至于([\u3400-\u9fff]{1,3})不\1[，,]\s*怎么\1/g;
const repeatedNegativeVerbPattern = /不([\u3400-\u9fff]{1,2})([\u3400-\u9fff]{2,8})[，,]\s*不\1([\u3400-\u9fff]{2,8})/g;
const crossNegationStart = /^不是[^。！？!?\n]{1,24}[。！？!?]?$/;
const crossNegationMiddle = /^(?:也|还)不是[^。！？!?\n]{1,24}[。！？!?]?$/;
const crossNegationEnd = /^只是[^。！？!?\n]{1,32}[。！？!?]?$/;

function findReverseNotIs(lines: readonly ProseLine[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const line of lines) {
    for (const match of line.masked.matchAll(reverseNotIsPattern)) {
      const start = match.index;
      if (reverseNotIsPrevExclude.has(line.masked[start - 1])) continue;
      // 「是不是…」问句起头；「是的，…不是…」承接确认；「…，不是吗/么/吧」反问尾巴
      if (line.masked[start + 1] === '不' || isAffirmationTagAt(line.masked, start) || /^[吗么吧]/.test(match[2])) continue;
      findings.push(finding('reverse-not-is', 'blocking', line.line, start + 1, compact(line.styled.slice(start, start + match[0].length)), '反序对比腔「是A，不是B」与「不是A，是B」同族：删掉后置否定，直接写 A 的具体表现'));
    }
  }
  return findings;
}

function findNegationParade(lines: readonly ProseLine[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const line of lines) {
    const spans: Array<[number, number]> = [];
    for (const pattern of negationParadePatterns) {
      for (const match of line.masked.matchAll(pattern)) spans.push([match.index, match.index + match[0].length]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    // 两条正则可能在同一片文字上重叠命中，按区间去重只报一次
    let lastEnd = -1;
    for (const [start, end] of spans) {
      if (start < lastEnd) {
        lastEnd = Math.max(lastEnd, end);
        continue;
      }
      lastEnd = end;
      findings.push(finding('negation-parade', 'blocking', line.line, start + 1, compact(line.styled.slice(start, end)), '否定排比「没有X，没有Y…」/「没X，没Y，只是Z」：删掉否定清单，直接写现场实际有什么，最多留一个最有信息量的否定'));
    }
  }
  return findings;
}

function findVoiceContrast(lines: readonly ProseLine[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const line of lines) {
    for (const match of line.masked.matchAll(voiceContrastPattern)) {
      findings.push(finding('voice-contrast', 'blocking', line.line, match.index + 1, compact(match[0]), '音量反差腔「声音不大/不高…却/但…」：删掉音量铺垫，直接写声音落进场子的具体效果（谁停了手、哪排安静了）'));
    }
  }
  return findings;
}

/** 破折号全文都查（含台词）：正文产物不保留 `——` `—` `--` */
function findEmDash(lines: readonly ProseLine[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const line of lines) {
    for (const match of line.styled.matchAll(emDashPattern)) {
      findings.push(finding('em-dash', 'blocking', line.line, match.index + 1, compact(line.styled.slice(Math.max(0, match.index - 8), match.index + match[0].length + 8)), '破折号按功能改写：打断改成动作或短句，拖长音改省略或动作，插入说明改逗号或冒号；勿一律改句号'));
    }
  }
  return findings;
}

/** 预告式收尾与章尾总结体只扫文末窗口：正文中段的「没人知道」多为普通叙述 */
function findTrailer(lines: readonly ProseLine[]): LintFinding[] {
  const window: ProseLine[] = [];
  let accumulated = 0;
  for (let index = lines.length - 1; index >= 0 && accumulated < trailerWindowChars; index -= 1) {
    window.unshift(lines[index]);
    accumulated += lines[index].narrativeLength;
  }
  const findings: LintFinding[] = [];
  for (const line of window) {
    for (const match of line.masked.matchAll(trailerEndingPattern)) {
      findings.push(finding('trailer-ending', 'blocking', line.line, match.index + 1, compact(match[0]), '预告式总结收尾「没人知道/才刚刚开始/正朝着…压过去」：结尾停在具体动作、画面或一句台词上，别替读者预告下一章'));
    }
    for (const match of line.masked.matchAll(trailerSummaryPattern)) {
      findings.push(finding('trailer-summary', 'blocking', line.line, match.index + 1, compact(match[0]), '章尾状态总结体「这一夜注定…/这一切都结束了/新的篇章/命运的齿轮」：收束状态是规划口径，正文落到最后一个具体动作或台词上'));
    }
  }
  return findings;
}

function findFormulaicParallelism(lines: readonly ProseLine[]): LintFinding[] {
  const findings: LintFinding[] = [];
  const rules: ReadonlyArray<readonly [RegExp, string]> = [
    [decisionFramePattern, '「至于X不X，怎么X」把同一决定拆成工整栏目：若只是复述章纲，压成角色当下的一次判断或直接动作'],
    [repeatedNegativeVerbPattern, '同动词「不V A，不V B」容易写成否定清单：按语境复核，保留真正有功能的一项'],
  ];
  for (const line of lines) {
    for (const [pattern, message] of rules) {
      for (const match of line.styled.matchAll(pattern)) {
        findings.push(finding('formulaic-parallelism', 'advisory', line.line, match.index + 1, compact(match[0]), message));
      }
    }
  }
  // 跨段「不是A / 也不是B / 只是C」既可能是章纲复述，也可能是正常的辩解或悬念排除，纯句法分不清，只提示
  let window: ProseLine[] = [];
  for (const line of lines) {
    if (line.afterBreak || (window.length && line.line - window[window.length - 1].line > 2)) window = [];
    window.push(line);
    if (window.length > 3) window.shift();
    if (window.length !== 3) continue;
    const [first, second, third] = window.map(item => maskQuoted(item.styled.trim()));
    if (!crossNegationStart.test(first) || !crossNegationMiddle.test(second) || !crossNegationEnd.test(third)) continue;
    findings.push(finding('formulaic-parallelism', 'advisory', window[0].line, 1, compact(window.map(item => item.trimmed).join(' / ')), '跨段「不是… / 也不是… / 只是…」可能是工整否定铺排，也可能承担辩解或悬念排除：只在重复章纲或拖慢画面时改写'));
  }
  return findings;
}

// ---- 退化指纹：复读、截断、占位/拒绝语、工程词。看原始行，不受允许片段豁免 ----

/** 长句（可见字 ≥12）出现 ≥3 次判为打转，紧邻整行重复（可见字 ≥8）判为即时循环；短句、弹幕、台词刷屏是体裁手法，豁免 */
const repeatMinLength = 12;
const repeatMinCount = 3;
const adjacentMinLength = 8;

/**
 * hard = 任何位置都判（正文里永不合法）；soft = 只判成对引号外（系统流、AI 伴侣题材里角色台词
 * 「作为AI，我会保护你」是合法对话）。型号后缀（AI语言模型/AI助手…）必须可选吃掉，否则最典型的退化开场整类漏检
 */
const placeholderPatterns: ReadonlyArray<{ pattern: RegExp; label: string; hard: boolean }> = [
  { pattern: /作为(一个)?(AI|人工智能|大?语言模型|智能助手|聊天助手)(?:语言模型|大?模型|助手|机器人)?(?=[，,。、；;：:！!？?\s）)」』"】]|我|无法|不能|没法|$)/, label: '元信息泄漏（AI 自指）', hard: false },
  { pattern: /\uFFFD/, label: '乱码（替换字符）', hard: true },
  { pattern: /^(Sure|Certainly|Here'?s|As an AI|I (?:cannot|can't|am unable|apologize))/, label: '元信息泄漏（英文 AI 腔）', hard: true },
  { pattern: /[（(](此处|以下|这里|下文|后续)?\s*(省略|略)(去|过)?[^）)]{0,10}[）)]/, label: '占位符（括号省略）', hard: true },
  { pattern: /(未完待续|TODO|占位符|placeholder)/, label: '占位符', hard: true },
  { pattern: /我(无法|不能)(继续(写|创作|生成|下去)|生成(内容|文本|正文)?|创作|续写|完成(这个|本)?(章|篇|创作|请求))/, label: '元信息泄漏（生成拒绝语）', hard: false },
];

/** 一级：纯写作流水线术语，正文里几乎永不合法；「章纲」是本应用的构思文档名，一并纳入 */
const metaTier1Pattern = /细纲|情节点|卷纲|功能标签|目标情绪|字数目标|章首钩子|章尾钩子|章纲/;
/** 二级：章节结构词与歧义词，角色在故事内真实讨论「第X章」或故事内系统用语时属例外，只提示 */
const metaTier2Pattern = /第[一二三四五六七八九十百千万两0-9]+章|本章|这一章|上一章|下一章|上章|下章|前一章|后一章|前文|后文|伏笔|读者|任务描述/;

function findVerbatimRepeat(lines: readonly ProseLine[]): LintFinding[] {
  const findings: LintFinding[] = [];
  // 纯台词/弹幕复沓（引号外叙述很短）豁免；「叙述 + 引号内物件」混合行的整行复读仍判
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trimmed === lines[index - 1].trimmed && visibleLength(stripQuoted(lines[index].trimmed)) >= adjacentMinLength) {
      findings.push(finding('verbatim-repeat', 'blocking', lines[index].line, 1, compact(lines[index].trimmed), '逐行复读（紧邻整行重复）：疑似模型打转，重写本段、删掉重复'));
    }
  }
  // 只豁免引号内台词，引号外叙述句仍参与复读计数；每个复读句只在首次出现处报一次
  const counts = new Map<string, number>();
  for (const line of lines) {
    for (const sentence of splitSentences(stripQuoted(line.trimmed))) {
      if (visibleLength(sentence) >= repeatMinLength) counts.set(sentence, (counts.get(sentence) || 0) + 1);
    }
  }
  const reported = new Set<string>();
  for (const line of lines) {
    for (const sentence of splitSentences(stripQuoted(line.trimmed))) {
      const count = counts.get(sentence) || 0;
      if (count < repeatMinCount || reported.has(sentence)) continue;
      reported.add(sentence);
      findings.push(finding('verbatim-repeat', 'blocking', line.line, 1, compact(sentence), `长句复读（同句出现 ${count} 次）：疑似模型打转，重写、保留一处`));
    }
  }
  return findings;
}

/** 写完的章节落在句末或收尾标点上，否则就是被模型中途切断 */
function findTruncated(lines: readonly ProseLine[]): LintFinding[] {
  const last = lines[lines.length - 1];
  if (!last || /[。！？!?…”"』」）)】]$/.test(last.trimmed)) return [];
  return [finding('truncated', 'blocking', last.line, last.text.trimEnd().length, compact(last.trimmed.slice(-24)), '疑似截断：正文末尾未以句末或收尾标点结束，可能被模型中途切断；补完结尾或重写收尾')];
}

function findPlaceholderLeak(lines: readonly ProseLine[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const line of lines) {
    const indent = line.text.length - line.text.trimStart().length;
    const outside = maskQuoted(line.trimmed);
    for (const { pattern, label, hard } of placeholderPatterns) {
      const match = pattern.exec(hard ? line.trimmed : outside);
      if (!match) continue;
      findings.push(finding('placeholder-leak', 'blocking', line.line, indent + match.index + 1, compact(line.trimmed.slice(Math.max(0, match.index - 4), match.index + 20)), `${label}：正文混入元信息、拒绝语或占位符，重写本段干净落地`));
      break;
    }
  }
  return findings;
}

function findMetaLeak(lines: readonly ProseLine[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const line of lines) {
    const indent = line.text.length - line.text.trimStart().length;
    const outside = maskQuoted(line.trimmed);
    const excerptAt = (index: number) => compact(line.trimmed.slice(Math.max(0, index - 6), index + 18));
    let match = metaTier1Pattern.exec(outside);
    let quoted = false;
    // 一级词只在成对引号内出现时降级：写手/编剧题材里角色在故事内真讨论创作，台词里可能合法
    if (!match) {
      match = metaTier1Pattern.exec(line.trimmed);
      quoted = Boolean(match);
    }
    if (match) {
      findings.push(finding('meta-leak', quoted ? 'advisory' : 'blocking', line.line, indent + match.index + 1, excerptAt(match.index), `工程词泄漏：「${match[0]}」是写作流水线术语，正文里不该出现，改成角色或场景内的表达${quoted ? '；例外：角色为作者或编剧、在故事内真实讨论创作时台词里可能合法' : ''}`));
      continue;
    }
    match = metaTier2Pattern.exec(line.trimmed);
    if (match) {
      findings.push(finding('meta-leak', 'advisory', line.line, indent + match.index + 1, excerptAt(match.index), `元信息泄漏：「${match[0]}」疑似章节结构词混入正文，改成角色当下可感知的事件锚点或相对时间；角色在故事内真实阅读「第X章」或故事内系统用语属例外`));
    }
  }
  return findings;
}

// ---- 分布型指纹：只提示，不自动改。次数与每千字密度双门槛同时达标才报，全文只报一条 ----

/** 碎句号：连续 6 个可见字 ≤5 的叙述短句无呼吸；只数叙述句，对话/弹幕/系统播报成片短句是正常形态 */
const stutterMinRun = 6;
const stutterMaxSentence = 5;
/** 长段落按原始字符数算，手机阅读的保守阈值 */
const longParagraphChars = 200;
/** 微动作复读：「V了下 / V了一下 / 松了半圈」式轻量补语高密度复现是删减过头的电报体指纹 */
const microTicPattern = /了(?:[一两三几半])?[下阵圈道声眼口气会]/g;
const microTicMinHits = 5;
const microTicPerKilo = 6;
/** 套式反应细节：部位 + 轻微动作、「平静得像在念」式语气比喻、喉结/眼圈/声音放轻等通用情绪尾巴 */
const stockReactionPatterns = [
  /(?:指尖|手指|指节|手背|掌心|拳头|袖口|衣角|裙角|下唇|嘴唇|唇角|嘴角|眉头|眼底|眸光|目光|视线|肩膀|呼吸)[^。！？!?\n]{0,16}(?:轻轻|微微|缓缓|悄然|不自觉|无意识|下意识|攥紧|握紧|收紧|绞紧|泛白|发白|叩|敲|摩挲|抿紧|抿成|移开|垂下|躲开|一颤|颤了?一下|停了?一下|顿了?一下)/g,
  /(?:语气|声音)[^。！？!?\n]{0,12}(?:平静|冷静|平淡|冷淡|淡漠|平直)[^。！？!?\n]{0,12}(?:像|仿佛|如同|好像)[^。！？!?\n]{0,16}(?:念|读|报|说|陈述|宣判|背诵)/g,
  /(?:胸口|心口)[^。！？!?\n]{0,16}(?:像|仿佛|如同|好像)[^。！？!?\n]{0,16}(?:撞|锤|压|攥|堵)[^。！？!?\n]{0,8}(?:一下|一记|一拳)?/g,
  /(?:声音|嗓音|语气)[^。！？!?\n]{0,12}(?:放轻|压低|发紧|发颤|很轻|轻了些)/g,
  /(?:喉结|喉头|喉咙)[^。！？!?\n]{0,10}(?:滚|动|紧|堵|发涩|发干)/g,
  /(?:眼眶|眼圈|鼻子)[^。！？!?\n]{0,8}(?:发红|红了|发热|发酸|一酸)/g,
  /(?:抿了?下唇|抿了?抿唇|抿了?下嘴|抿着笑)/g,
];
const stockReactionMinHits = 4;
/** 真人语料校准：长篇章尺度 1.0→1.5 误报几乎不动，短篇整篇 1.0 时误报 5.57%，1.5 降到 1.46% */
const stockReactionPerKilo = 1.5;
/** 监控摄像头式动作清单：同段连续堆叠通用动作动词，且用逗号顿号串成步骤表 */
const actionListVerbPattern = /伸手|抬手|探手|拿起|拿过|取出|取过|掏出|摸出|抓起|攥住|握住|捏住|按住|推开|拉开|打开|关上|放下|递给|挑开|掀开|扯开|拧开|倒出|端起|转身|回头|抬头|低头|弯腰|俯身|走到|走向|坐下|站起|看向|看着|盯着|扫过/g;
const actionListMinHits = 5;
const actionListMinSeparators = 4;
/** 抽象总结复读：把角色当下经历拔成「命运/棋局/这一刻终于明白/才刚刚开始」的作者总结 */
const abstractSummaryPatterns = [
  /这一刻[，,]?[^\n。！？!?]{0,24}(?:终于|才)(?:明白|意识到)/g,
  /从这一刻开始/g,
  /(?:命运|宿命)[^\n。！？!?]{0,28}(?:齿轮|棋局|獠牙|改写|推向|安排)/g,
  /早已[^\n。！？!?]{0,8}(?:布好|安排好)[^\n。！？!?]{0,8}(?:棋局|局)/g,
  /前所未有的(?:决意|清醒|勇气|力量|恐惧|平静|信念)/g,
  /(?:反击|复仇|战争|较量|故事|命运)[^\n。！？!?]{0,12}才刚刚开始/g,
  /(?:新的开始|全新的开始)/g,
];
const abstractSummaryMinHits = 3;
const abstractSummaryPerKilo = 4;
/** 套词密度：单个「仿佛/一丝」是正常中文，高密度聚集才成模板腔；词表只收明确标为高危的形态 */
const clichePatterns = [
  /仿佛|犹如|宛若|如同/g,
  /一丝|一抹|些许|几分|隐约/g,
  /深吸一口气|缓缓|微微|轻轻|淡淡/g,
  /眼中闪过|嘴角勾起|眸光微微一闪|指节泛白|目光锐利|眼神锐利/g,
  /心中涌起一股|心头一震|心中一动|心下了然|心中暗道|心中一凛/g,
  /不容置疑|不容置喙|不易察觉|显而易见|毫无疑问|不可否认/g,
  /声音不大[，,]?却带着|语气平静无波|平静无波|声音平直|听不出情绪/g,
  /不知何时|唾手可得|无声翻涌|沉默(?:在[^。！？!?\n]{0,16})?蔓延|难以言说/g,
  /散发着一股|冰冷的光|格外刺眼|深邃而冰冷/g,
];
const clicheMinHits = 8;
const clichePerKilo = 12;
/** 比喻标记；「像」前后排除头像/图像/不像等合成词 */
const metaphorMarkerPattern = /好像|像是|仿佛|宛如|如同|犹如|(?<![不头图画影录摄肖])像(?![头像素])/g;
const metaphorLikePhrasePattern = /(?:死|水|冰|火|潮水|石头|木头|机器|纸|铁|鬼|死人|刀|针|网|墙)一样/g;
const metaphorMinHits = 7;
const metaphorPerKilo = 3;
/** 解释链：「他知道/他明白/这意味着/必须需要」连续替读者推理，读感像报告；core 桶至少两类才报 */
const reasoningChainPatterns: ReadonlyArray<{ key: string; core: boolean; pattern: RegExp }> = [
  { key: 'mental', core: true, pattern: /(?<![不没未无])(?:他|她|我)?(?:知道|明白|意识到|清楚|判断|确认|分析)/g },
  { key: 'connector', core: true, pattern: /这意味着|也就是说|换句话说|真正的问题(?:在于)?|问题在于|关键在于|在这种情况下|按照这个逻辑|只有这样|想到这里/g },
  { key: 'modal', core: true, pattern: /(?:(?<!不)(?:必须|需要|应该|只要|就会|可能|可以|能够|无法)|不能)[^。！？!?\n]{0,16}(?:判断|确认|承担|维持|稳住|控制|扩大|失控|带来|造成|理解|默认|回家|进门|核对|筛选|减少|建立|风险|结果|秩序|责任)/g },
  { key: 'abstract', core: false, pattern: /(?:任务|条件|风险|来源|逻辑|局面|结果|责任|秩序|规则|信息不足|决策能力)/g },
];
const reasoningMinHits = 8;
const reasoningCoreMinHits = 4;
const reasoningMinBuckets = 2;
const reasoningPerKilo = 18;
/** 引号强调：叙述里 1～4 字短词加引号。真人转述海报标语也这么写，所以只做 advisory */
const quoteEmphasisMinHits = 3;
const quoteEmphasisMaxVisible = 4;
const speechVerbPattern = /[说道问喊答念叫回吼骂写读唱嘀咕]/;

interface HitCount {
  hits: number;
  firstLine: number;
  samples: string[];
}

/** 在引号外叙述里数一组正则的命中，记住首行和去重后的前几条样例 */
function countHits(lines: readonly ProseLine[], patterns: readonly RegExp[], sample: (match: RegExpExecArray, narrative: string) => string, maxSamples: number): HitCount {
  const count: HitCount = { hits: 0, firstLine: 0, samples: [] };
  for (const line of lines) {
    for (const pattern of patterns) {
      for (const match of line.narrative.matchAll(pattern)) {
        count.hits += 1;
        if (!count.firstLine) count.firstLine = line.line;
        const item = sample(match, line.narrative);
        if (count.samples.length < maxSamples && item && !count.samples.includes(item)) count.samples.push(item);
      }
    }
  }
  return count;
}

function narrativeTotal(lines: readonly ProseLine[]): number {
  return lines.reduce((sum, line) => sum + line.narrativeLength, 0);
}

/** 双门槛：次数够且每千字密度够才返回一条 advisory */
function densityFinding(type: string, count: HitCount, total: number, minHits: number, minPerKilo: number, message: (perKilo: string) => string, joiner = ' '): LintFinding[] {
  if (!total || count.hits < minHits) return [];
  const perKilo = (count.hits / total) * 1000;
  if (perKilo < minPerKilo) return [];
  return [finding(type, 'advisory', count.firstLine, 1, compact(count.samples.join(joiner)), message(perKilo.toFixed(1)))];
}

function findPeriodStutter(lines: readonly ProseLine[]): LintFinding[] {
  const findings: LintFinding[] = [];
  let run: string[] = [];
  let runLine = 0;
  const flush = () => {
    if (run.length >= stutterMinRun) {
      findings.push(finding('period-stutter', 'advisory', runLine, 1, compact(run.slice(0, 6).join(' ')), `碎句号：连续 ${run.length} 个短句无呼吸；把碎句合并成中长句，补回画面与连接`));
    }
    run = [];
  };
  for (const line of lines) {
    // 结构行重置计数；纯对话行成片短句是正常形态，也重置；空行是一句一段排版，不打断
    if (line.afterBreak || !line.narrativeLength) {
      flush();
      continue;
    }
    for (const sentence of splitSentences(line.narrative)) {
      if (visibleLength(sentence) > stutterMaxSentence) {
        flush();
        continue;
      }
      if (!run.length) runLine = line.line;
      run.push(sentence);
    }
  }
  flush();
  return findings;
}

function findLongParagraph(lines: readonly ProseLine[]): LintFinding[] {
  return lines
    .filter(line => line.trimmed.length > longParagraphChars)
    .map(line => finding('long-paragraph', 'advisory', line.line, 1, compact(line.trimmed.slice(0, 40)), `段落过长（${line.trimmed.length} 字）：按镜头、新动作、新线索或视线切换断段，别一段到底`));
}

function findMicroActionTic(lines: readonly ProseLine[]): LintFinding[] {
  const count = countHits(lines, [microTicPattern], match => match[0], 6);
  return densityFinding('micro-action-tic', count, narrativeTotal(lines), microTicMinHits, microTicPerKilo, perKilo => `微动作复读：「了下/了一下」式轻量补语 ${count.hits} 处（${perKilo}/千字）；合并动作节拍、换具体细节，别每个动作都补一个轻反应尾巴`);
}

function findStockReactionTic(lines: readonly ProseLine[]): LintFinding[] {
  const count = countHits(lines, stockReactionPatterns, (match, narrative) => sentenceAround(narrative, match.index), 6);
  return densityFinding('stock-reaction-tic', count, narrativeTotal(lines), stockReactionMinHits, stockReactionPerKilo, perKilo => `套式反应细节：指尖/指节/喉结/眼圈/声音放轻等通用反应 ${count.hits} 处（${perKilo}/千字）；逐处做删除测试，只标注情绪、不改变选择或动作结果的删掉`, ' | ');
}

function findAbstractSummaryTic(lines: readonly ProseLine[]): LintFinding[] {
  const count = countHits(lines, abstractSummaryPatterns, match => compact(match[0]), 6);
  return densityFinding('abstract-summary-tic', count, narrativeTotal(lines), abstractSummaryMinHits, abstractSummaryPerKilo, perKilo => `抽象总结复读：命运/棋局/这一刻终于明白/才刚刚开始等作者总结 ${count.hits} 处（${perKilo}/千字）；回到角色当下可见的文件、动作、对话或物理后果`, ' | ');
}

function findClicheDensityTic(lines: readonly ProseLine[]): LintFinding[] {
  const count = countHits(lines, clichePatterns, match => match[0], 8);
  return densityFinding('cliche-density-tic', count, narrativeTotal(lines), clicheMinHits, clichePerKilo, perKilo => `套词密度过高：高危 AI 套词 ${count.hits} 处（${perKilo}/千字）；不要同义词轮换，改成角色当下可见的动作、物件、对话和具体后果`);
}

function findMetaphorDensityTic(lines: readonly ProseLine[]): LintFinding[] {
  const count = countHits(lines, [metaphorMarkerPattern], (match, narrative) => sentenceAround(narrative, match.index), 6);
  // 「X一样」前 8 字里已有比喻标记的，是同一个比喻，不重复计数
  for (const line of lines) {
    for (const match of line.narrative.matchAll(metaphorLikePhrasePattern)) {
      if (/好像|像是|像|仿佛|宛如|如同|犹如/.test(line.narrative.slice(Math.max(0, match.index - 8), match.index))) continue;
      count.hits += 1;
      if (!count.firstLine) count.firstLine = line.line;
      const item = sentenceAround(line.narrative, match.index);
      if (count.samples.length < 6 && item && !count.samples.includes(item)) count.samples.push(item);
    }
  }
  return densityFinding('metaphor-density-tic', count, narrativeTotal(lines), metaphorMinHits, metaphorPerKilo, perKilo => `比喻密度过高：像/好像/仿佛/如同等比喻标记 ${count.hits} 处（${perKilo}/千字）；保留最有叙事功能的少数比喻，其余回到具体动作、物件、声音或后果`, ' | ');
}

function findReasoningChainTic(lines: readonly ProseLine[]): LintFinding[] {
  const count: HitCount = { hits: 0, firstLine: 0, samples: [] };
  let coreHits = 0;
  const buckets = new Set<string>();
  for (const line of lines) {
    for (const { key, core, pattern } of reasoningChainPatterns) {
      for (const match of line.narrative.matchAll(pattern)) {
        count.hits += 1;
        if (core) coreHits += 1;
        buckets.add(key);
        if (!count.firstLine) count.firstLine = line.line;
        const item = compact(match[0]);
        if (count.samples.length < 8 && !count.samples.includes(item)) count.samples.push(item);
      }
    }
  }
  if (coreHits < reasoningCoreMinHits || buckets.size < reasoningMinBuckets) return [];
  return densityFinding('reasoning-chain-tic', count, narrativeTotal(lines), reasoningMinHits, reasoningPerKilo, perKilo => `解释链密度过高：知道/明白/这意味着/必须/需要等判断链 ${count.hits} 处（${perKilo}/千字）；把判断落到角色当下可见的动作、物件、对话和现场反馈`, ' | ');
}

function findActionListTic(lines: readonly ProseLine[]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const line of lines) {
    const verbs = [...line.narrative.matchAll(actionListVerbPattern)].map(match => match[0]);
    if (verbs.length < actionListMinHits) continue;
    const separators = (line.narrative.match(/[，、；;]/g) || []).length;
    if (separators < actionListMinSeparators) continue;
    findings.push(finding('action-list-tic', 'advisory', line.line, 1, compact(verbs.slice(0, 8).join(' ')), `监控摄像头式动作清单：同段连续动作动词 ${verbs.length} 个、分隔符 ${separators} 个；合并琐碎步骤，只保留有情绪或情节功能的动作`));
  }
  return findings;
}

/** 叙述层短词加引号强调；排除【】面板、引语动词邻接的极短台词、含句读的台词、引号套引号，以及引号外没有叙述的行 */
function findQuoteEmphasisTic(lines: readonly ProseLine[]): LintFinding[] {
  const count: HitCount = { hits: 0, firstLine: 0, samples: [] };
  for (const line of lines) {
    if (!line.narrativeLength) continue;
    const text = line.styled;
    const ranges = quotedRanges(text);
    for (const [start, end] of ranges) {
      if (text[start] === '【') continue;
      if (ranges.some(([from, to]) => from <= start && end <= to && (from !== start || to !== end))) continue;
      const inner = text.slice(start + 1, end - 1);
      const visible = visibleLength(inner);
      if (visible < 1 || visible > quoteEmphasisMaxVisible || /[。！？!?…，,；;：:]/.test(inner)) continue;
      if (speechVerbPattern.test(text.slice(Math.max(0, start - 6), start)) || speechVerbPattern.test(text.slice(end, end + 3))) continue;
      count.hits += 1;
      if (!count.firstLine) count.firstLine = line.line;
      if (count.samples.length < 6 && !count.samples.includes(inner)) count.samples.push(inner);
    }
  }
  if (count.hits < quoteEmphasisMinHits) return [];
  return [finding('quote-emphasis-tic', 'advisory', count.firstLine, 1, compact(count.samples.join(' ')), `引号强调滥用：叙述里 1～4 字短词加引号强调 ${count.hits} 处；只留真正反讽或转述必要的一两处，其余去掉引号直接写`)];
}

// ---- 本应用自加：开头/结尾同型、沉默词密度、对话密度、照搬章纲 ----

/** 报时式开头：周几/日期/时段起头，且前 14 字内有逗号（「周三上午，他到了码头」） */
const timeOpeningPattern = /^(?:周[一二三四五六日]|\d+月\d+日|清晨|入夜|傍晚|上午|下午|中午|深夜|次日|三日后|一周后|正月|初春|三月|冬至|启程当日)/;
const lampNightOpeningPattern = /灯亮了一夜|天没亮|天还没亮|一夜|天亮/;
const stillnessEndingPattern = /没再说|没动|没关|没答|没催|没去动|没抹平|没再碰|没再问|没有挪|站着没动/;
const liftEndingPattern = /温暖|辽阔|苍茫|宁谧|流淌|金光|余晖|相知相契|浩然|永安|阴霾|属于他们的|新的一天/;
/** 沉默词：引号外「没问 / 默默 / 点了点头」这类零反应词，本书实测过一整章人人只在沉默点头 */
const silencePattern = /没问|没说话|没再说|没接话|没接这|没有说|默默|淡淡|没吭声|没应|没回头|嗯了一声|应了一声|点了点头|点头/g;
const silencePerKilo = 2.5;
/** 次数下限沿用其他密度规则的做法：几百字的短稿里一个「点头」就 5/千字，没有下限会把短稿全报上 */
const silenceMinHits = 3;
/** 对话行：以成对引号起头的行；每千字少于 3 行且全文够长才报 */
const dialogueLinePattern = /^[“「"]/;
const dialogueMinPerKilo = 3;
const dialogueMinChars = 800;
/** 照搬章纲：只比汉字、连续重合 ≥16 字，报最长的前 8 段 */
const outlineCopyMinRun = 16;
const outlineCopyReportTop = 8;
const outlineCopyMaxRun = 200;
const hanPattern = /[一-鿿]/;

/** 开头句的「型」：报时式 / 灯夜式 / 钥匙式 / other；同型只在非 other 时算 */
export function classifyOpening(sentence: string): string {
  const head = sentence.trim();
  if (timeOpeningPattern.test(head) && /[，,]/.test(head.slice(0, 14))) return '报时式';
  if (lampNightOpeningPattern.test(head.slice(0, 20))) return '灯夜式';
  if (head.slice(0, 20).includes('钥匙')) return '钥匙式';
  return 'other';
}

/** 结尾句的「型」：灯上收尾 / 否定静止式 / 抒情升华式 / other */
export function classifyEnding(sentence: string): string {
  if (sentence.includes('灯')) return '灯上收尾';
  if (stillnessEndingPattern.test(sentence)) return '否定静止式';
  if (liftEndingPattern.test(sentence)) return '抒情升华式';
  return 'other';
}

/** 一行的第一句：到第一个句末标点（连同紧跟的收引号）为止，没有句末标点就取整行 */
function openingOf(line: string): string {
  const match = /^[^。！？!?]*[。！？!?]+[”"』」’')）]*/.exec(line);
  return match ? match[0] : line;
}

/** 一行的最后一句：先剥掉行尾的收尾标点与收引号，再找上一个句末标点；开头残留的收引号一并去掉 */
function endingOf(line: string): string {
  const tail = /[。！？!?…”"』」’')）]+$/.exec(line);
  const head = tail ? line.slice(0, tail.index) : line;
  const cut = Math.max(...['。', '！', '？', '!', '?'].map(mark => head.lastIndexOf(mark)));
  return (cut < 0 ? line : line.slice(cut + 1)).replace(/^[”"』」’')）]+/, '').trim();
}

/** 正文第一句（跳过标题行和结构行），供账本记录最近几章的开头 */
export function firstSentence(text: string): string {
  const lines = collectLines(text);
  return lines.length ? openingOf(lines[0].trimmed) : '';
}

/** 正文最后一句，供账本记录最近几章的结尾 */
export function lastSentence(text: string): string {
  const lines = collectLines(text);
  return lines.length ? endingOf(lines[lines.length - 1].trimmed) : '';
}

/** 与最近三章全部同型升 blocking，与任一同型 advisory；本章或对方是 other 都不算 */
function echoFinding(type: string, kind: string, recent: readonly string[], classify: (sentence: string) => string, line: number, excerpt: string, label: string): LintFinding[] {
  if (kind === 'other' || !recent.length) return [];
  const kinds = recent.map(classify);
  const lastThree = kinds.slice(-3);
  const streak = lastThree.length === 3 && lastThree.every(item => item === kind);
  if (!streak && !kinds.includes(kind)) return [];
  const message = streak ? `${label}句连续三章都是「${kind}」：换一种进入或离开场景的方式` : `${label}句与最近几章之一同型（「${kind}」）：换一种进入或离开场景的方式`;
  return [finding(type, streak ? 'blocking' : 'advisory', line, 1, compact(excerpt), message)];
}

function findEchoes(lines: readonly ProseLine[], context: LintContext): LintFinding[] {
  if (!lines.length) return [];
  const first = lines[0];
  const last = lines[lines.length - 1];
  // 型的判定看允许片段遮掉后的句子：作者放行的开头写法不再算同型
  return [
    ...echoFinding('opening-echo', classifyOpening(openingOf(first.styled.trim())), context.recentOpenings || [], classifyOpening, first.line, openingOf(first.trimmed), '开头'),
    ...echoFinding('ending-echo', classifyEnding(endingOf(last.styled.trim())), context.recentEndings || [], classifyEnding, last.line, endingOf(last.trimmed), '结尾'),
  ];
}

function findSilenceDensity(lines: readonly ProseLine[]): LintFinding[] {
  const count = countHits(lines, [silencePattern], match => match[0], 8);
  return densityFinding('silence-density', count, narrativeTotal(lines), silenceMinHits, silencePerKilo, perKilo => `沉默词密度过高：没问/没说话/默默/点了点头等零反应词 ${count.hits} 处（${perKilo}/千字）；人物不能一整章只在沉默点头，给他们一句台词或一个有后果的动作`);
}

function findDialogueSparse(lines: readonly ProseLine[]): LintFinding[] {
  const total = lines.reduce((sum, line) => sum + visibleLength(line.trimmed), 0);
  if (total < dialogueMinChars) return [];
  const dialogueLines = lines.filter(line => dialogueLinePattern.test(line.trimmed)).length;
  const perKilo = (dialogueLines / total) * 1000;
  if (perKilo >= dialogueMinPerKilo) return [];
  return [finding('dialogue-sparse', 'advisory', lines[0].line, 1, `对话 ${dialogueLines} 行 / 全文 ${total} 字`, `对话过少：每千字只有 ${perKilo.toFixed(1)} 行对话；叙述压着人物不开口，读者听不到人物的声线`)];
}

/**
 * 照搬章纲：正文与章纲都只留汉字后比对，标点、加粗、【】标注造成的差异不算。
 * 贪心扫描：每个起点二分求「仍是章纲子串」的最长延伸（子串的前缀仍是子串，单调），命中区间不重叠。
 * 词面相同不等于照搬：系统面板、誓词、固定专名本就该一致，所以只提供证据，advisory
 */
function findOutlineCopy(lines: readonly ProseLine[], outline: string | undefined): LintFinding[] {
  if (!outline) return [];
  const target = outline.replace(/[^一-鿿]/g, '');
  // 正文汉字逐个记住来源行列，命中片段才能换算回原文位置
  const chars: string[] = [];
  const origin: Array<{ line: number; column: number }> = [];
  for (const line of lines) {
    for (let index = 0; index < line.styled.length; index += 1) {
      if (!hanPattern.test(line.styled[index])) continue;
      chars.push(line.styled[index]);
      origin.push({ line: line.line, column: index + 1 });
    }
  }
  const source = chars.join('');
  if (source.length < outlineCopyMinRun || target.length < outlineCopyMinRun) return [];
  const hits: Array<{ start: number; length: number }> = [];
  let index = 0;
  while (index < source.length) {
    if (index + outlineCopyMinRun > source.length || !target.includes(source.slice(index, index + outlineCopyMinRun))) {
      index += 1;
      continue;
    }
    let best = outlineCopyMinRun;
    let low = outlineCopyMinRun;
    let high = Math.min(source.length - index, outlineCopyMaxRun);
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (target.includes(source.slice(index, index + mid))) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    hits.push({ start: index, length: best });
    index += best;
  }
  return hits.sort((a, b) => b.length - a.length).slice(0, outlineCopyReportTop).map(hit => {
    const at = origin[hit.start];
    return finding('outline-copy', 'advisory', at.line, at.column, source.slice(hit.start, hit.start + hit.length), `照搬章纲：连续 ${hit.length} 字与构思原文重合；章纲只锁功能与结果，句子在正文现场写，系统面板、誓词、固定专名等功能性重合可保留`);
  });
}

/** 对一章正文跑全部规则，结果按行列排序；context 缺省时只跑不需要外部资料的规则 */
export function lintProse(text: string, context: LintContext = {}): LintFinding[] {
  const lines = collectLines(text, context.allowedPhrases);
  const findings = [
    ...findNotIs(lines), ...findReverseNotIs(lines), ...findNegationParade(lines), ...findVoiceContrast(lines), ...findEmDash(lines), ...findTrailer(lines),
    ...findVerbatimRepeat(lines), ...findTruncated(lines), ...findPlaceholderLeak(lines), ...findMetaLeak(lines),
    ...findPeriodStutter(lines), ...findLongParagraph(lines), ...findMicroActionTic(lines), ...findStockReactionTic(lines), ...findActionListTic(lines),
    ...findAbstractSummaryTic(lines), ...findClicheDensityTic(lines), ...findMetaphorDensityTic(lines), ...findReasoningChainTic(lines),
    ...findQuoteEmphasisTic(lines), ...findFormulaicParallelism(lines),
    ...findOutlineCopy(lines, context.outline), ...findEchoes(lines, context), ...findSilenceDensity(lines), ...findDialogueSparse(lines),
  ];
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

export function hasBlocking(findings: readonly LintFinding[]): boolean {
  return findings.some(item => item.severity === 'blocking');
}
