export function countNovelCharacters(content: string): number {
  return [...content.replace(/[\s\u200B-\u200D\uFEFF]/gu, '')].length;
}

/** 模型写在正文开头的章节标题行，以及剥掉标题行之后的纯正文 */
export interface ChapterDraftHeading {
  title: string;
  content: string;
}

/** 新建章节时自动生成的编号占位标题，作者还没给这一章起名 */
const numberedPlaceholderTitle = /^第\s*[\d零一二三四五六七八九十百千两]+\s*[章回节]$/u;
/** 连章号都没有的占位标题 */
const blankPlaceholderTitle = /^(?:新章节|未命名章节|无标题)$/u;
/** 标题名前的章号前缀：模型经常把章号数错，章号一律以应用自己的编号为准 */
const chapterNumberPrefix = /^第\s*[\d零一二三四五六七八九十百千两]+\s*[章回节]\s*[：:·、.\-—]?\s*/u;

/** 这一章还没有真正的名字，只有创建时的编号占位；批量补标题就是按它挑章节 */
export const isPlaceholderChapterTitle = (value: string): boolean => {
  const current = value.trim();
  return !current || numberedPlaceholderTitle.test(current) || blankPlaceholderTitle.test(current);
};

/**
 * 模型给的标题名里常带的多余包装：书名号、引号、句末标点
 * “《夜雨敲窗》。”这种套层要反复剥：单轮只能去掉最外一层
 */
export const cleanChapterTitleName = (value: string): string => {
  let name = value.trim().split(/\n/u)[0].trim();
  for (let round = 0; round < 4; round += 1) {
    const stripped = name
      .replace(/^[《【["'“‘（(]+/u, '')
      .replace(/[》】\]"'”’）)]+$/u, '')
      .replace(/[。！？…、；，!?]+$/u, '')
      .trim();
    if (stripped === name) break;
    name = stripped;
  }
  return name.slice(0, 60);
};

/**
 * 章节标题属于标题栏，不属于正文：把模型补在正文开头的 # 标题行拆出来
 * 标题不能直接丢掉——它是模型唯一给出章节名的地方，丢了标题栏就只剩“第 N 章”占位
 * 模型偶尔连写多行重复标题，最多剥 3 行；标题只取第一行，其余重复行丢掉
 */
export const splitChapterTitleHeading = (value: string): ChapterDraftHeading => {
  let content = value.trim();
  let title = '';
  for (let round = 0; round < 3; round += 1) {
    const match = /^#{1,3}\s*([^\n]{1,40})\n+/u.exec(content);
    if (!match) break;
    const titleLine = match[1].trim();
    // 只有看起来像章节名才剥（含“第 x 章”或较短且无标点的标题）；避免误伤正文里合法的 Markdown 小节
    const looksLikeChapterTitle = /第[\s\d零一二三四五六七八九十百千两]+章/u.test(titleLine)
      || (titleLine.length > 0 && !/[，。！？；：、“”…—]/u.test(titleLine) && titleLine.length <= 20);
    const rest = content.slice(match[0].length).trim();
    if (!looksLikeChapterTitle || !rest) break;
    if (!title) title = titleLine;
    content = rest;
  }
  return { title, content };
};

/**
 * 将中文数字或阿拉伯数字字符串转为正整数
 * 支持 "13", "十三", "二十一", "一百零五", "两百三十四" 等
 */
export function parseChapterNumber(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  }
  if (typeof raw !== 'string') return null;
  const str = raw.trim().replace(/\s+/g, '');
  if (!str) return null;
  if (/^\d+$/.test(str)) {
    const n = Number(str);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const digitMap: Record<string, number> = {
    '零': 0, '〇': 0, '0': 0,
    '一': 1, '1': 1,
    '二': 2, '两': 2, '2': 2,
    '三': 3, '3': 3,
    '四': 4, '4': 4,
    '五': 5, '5': 5,
    '六': 6, '6': 6,
    '七': 7, '7': 7,
    '八': 8, '8': 8,
    '九': 9, '9': 9,
  };
  let total = 0;
  let section = 0;
  let currentNum = 0;
  let hasDigit = false;
  for (let i = 0; i < str.length; i += 1) {
    const char = str[i];
    if (char in digitMap) {
      currentNum = digitMap[char];
      hasDigit = true;
    } else if (char === '十') {
      if (!hasDigit && i === 0) currentNum = 1;
      section += (currentNum || (hasDigit ? 0 : 1)) * 10;
      currentNum = 0;
      hasDigit = true;
    } else if (char === '百') {
      section += currentNum * 100;
      currentNum = 0;
      hasDigit = true;
    } else if (char === '千') {
      section += currentNum * 1000;
      currentNum = 0;
      hasDigit = true;
    } else if (char === '万') {
      total += (section + currentNum) * 10000;
      section = 0;
      currentNum = 0;
      hasDigit = true;
    } else {
      return null;
    }
  }
  total += section + currentNum;
  return hasDigit && total > 0 ? total : null;
}

/** 从章节标题中提取章号（支持“第13章”、“第 十三 章”、“第一百二十回”等） */
export function extractChapterNumber(title: string): number | null {
  const match = /^第\s*([\d零〇一二两三四五六七八九十百千0-9\s]+)\s*[章回节]/u.exec(title.trim());
  if (!match) return null;
  return parseChapterNumber(match[1]);
}

/**
 * 用模型写的标题行补全章节标题
 * 默认只有占位标题才补，且沿用应用自己的章号；overwrite 为 true 时允许全书统一定名覆盖
 */
export const applyDraftChapterTitle = (currentTitle: string, draftHeading: string, options: { overwrite?: boolean } = {}): string => {
  const name = draftHeading.trim().replace(chapterNumberPrefix, '').trim();
  if (!name) return currentTitle;
  const current = currentTitle.trim();
  if (numberedPlaceholderTitle.test(current)) return `${current} ${name}`;
  if (!current || blankPlaceholderTitle.test(current)) return name;
  if (options.overwrite) {
    const prefixMatch = chapterNumberPrefix.exec(current);
    if (prefixMatch) {
      const prefix = prefixMatch[0].replace(/[：:·、.\-—\s]+$/u, '').trim();
      return `${prefix} ${name}`;
    }
    return name;
  }
  return currentTitle;
};

/** 多平台网文排版预设模式 */
export type PlatformFormatPreset = 'standard' | 'clean' | 'compact' | 'raw';

export const platformFormatPresetLabels: Record<PlatformFormatPreset, string> = {
  standard: '标准排版（起点/番茄，段首缩进两字符）',
  clean: '纯净文本（公众号/知乎，无缩进）',
  compact: '紧凑排版（段首缩进，无空行）',
  raw: '保持原样（未做格式转换）',
};

/**
 * 将章节正文排版转换为各网文发布平台所需格式
 * - standard (起点/番茄等推荐): 段首两个全角空格（\u3000\u3000），清理段首尾空白，连续空行压缩为单空行
 * - clean (纯净无缩进): 清理段首尾空白，无缩进，连续空行压缩为单空行（适合公众号/知乎等）
 * - compact (紧凑无空行): 段首两个全角空格（\u3000\u3000），过滤所有纯空行
 * - raw (保持原样): 原样输出
 */
export function formatNovelForPlatform(content: string, preset: PlatformFormatPreset = 'standard'): string {
  if (!content) return '';
  if (preset === 'raw') return content;

  const lines = content.split(/\r?\n/u);

  if (preset === 'clean') {
    const result: string[] = [];
    let prevEmpty = false;
    for (const line of lines) {
      const trimmed = line.replace(/^[\s\u3000\uFEFF]+|[\s\u3000\uFEFF]+$/gu, '');
      if (!trimmed) {
        if (!prevEmpty) {
          result.push('');
          prevEmpty = true;
        }
      } else {
        result.push(trimmed);
        prevEmpty = false;
      }
    }
    return result.join('\n');
  }

  if (preset === 'compact') {
    const result: string[] = [];
    for (const line of lines) {
      const trimmed = line.replace(/^[\s\u3000\uFEFF]+|[\s\u3000\uFEFF]+$/gu, '');
      if (trimmed) {
        result.push(`\u3000\u3000${trimmed}`);
      }
    }
    return result.join('\n');
  }

  // standard 默认：段首双全角空格，保留单空行
  const result: string[] = [];
  let prevEmpty = false;
  for (const line of lines) {
    const trimmed = line.replace(/^[\s\u3000\uFEFF]+|[\s\u3000\uFEFF]+$/gu, '');
    if (!trimmed) {
      if (!prevEmpty) {
        result.push('');
        prevEmpty = true;
      }
    } else {
      result.push(`\u3000\u3000${trimmed}`);
      prevEmpty = false;
    }
  }
  return result.join('\n');
}

/** 合并章节正文与作家的话（用于单输入框发布的平台） */
export function combineContentAndAuthorNote(
  content: string,
  authorNote?: string,
  preset: PlatformFormatPreset = 'standard',
): string {
  const formattedContent = formatNovelForPlatform(content, preset);
  const trimmedNote = (authorNote || '').trim();
  if (!trimmedNote) return formattedContent;
  if (!formattedContent.trim()) return `【作家的话】\n${trimmedNote}`;
  return `${formattedContent}\n\n【作家的话】\n${trimmedNote}`;
}

