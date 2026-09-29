/**
 * 重写历史章时，卡片和设定里常写着更晚的章号（「第 151～204 章领证」）
 * 状态历史能按章回退，这种句子不能。整句丢掉，不靠提示词提醒模型假装没看见
 *
 * ponytail: 只认阿拉伯数字章号。中文数字（「第一百五十一章」）要加转换后再认
 */
const chapterRefPattern = /第\s*(\d{1,4})\s*(?:[～~\-—–至到]\s*(\d{1,4})\s*)?章/gu;

export function mentionsFutureChapter(text: string, chapterNumber: number): boolean {
  if (!chapterNumber || chapterNumber < 1) return false;
  for (const match of text.matchAll(chapterRefPattern)) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    // 区间盖住本章（「156～205章」里写第 180 章）是卷名，不是还没发生的事
    if (match[2] && low <= chapterNumber && chapterNumber <= high) continue;
    if (low > chapterNumber || high > chapterNumber) return true;
  }
  return false;
}

/** 按句号和换行切句，含更晚章号的句子整句去掉，其余原样 */
export function omitFutureChapterFacts(text: string, chapterNumber: number): string {
  if (!text || !chapterNumber || chapterNumber < 1) return text;
  const pieces = text.split(/([。！？\n])/u);
  let sentence = "";
  let kept = "";
  const flush = (delimiter: string) => {
    if (!mentionsFutureChapter(sentence, chapterNumber)) kept += sentence + delimiter;
    sentence = "";
  };
  for (const piece of pieces) {
    if (piece === "。" || piece === "！" || piece === "？" || piece === "\n") flush(piece);
    else sentence += piece;
  }
  if (sentence && !mentionsFutureChapter(sentence, chapterNumber)) kept += sentence;
  return kept.replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}
