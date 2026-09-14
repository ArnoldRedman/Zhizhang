import type { AIDetectionChapter, AIDetectionLabel, AIDetectionReport, AIDetectionSegment, Chapter, Project } from './project';
import { aiDetectionSource } from './chapter.ts';
import { countNovelCharacters } from '../utils/text.ts';

/**
 * 本地启发式 AI 检测：句长均匀度、逻辑连接词、口语词、心理描写套话、段落均匀度
 * 不调模型，只给作者一个粗略的参考；分段必须原样保留段落分隔符，编辑器高亮层要按同一份文本对齐
 */

export const aiDetectionLabel = (confidence: number): AIDetectionLabel => {
  if (confidence >= 0.99) return 'AI 特征';
  if (confidence >= 0.5) return '疑似 AI';
  return '人工';
};

export const splitAIDetectionSegments = (text: string, chapterScore: number): AIDetectionSegment[] => {
  // Keep paragraph separators in the segment so stored offsets remain aligned
  // with the editor content when the result is rendered as an overlay.
  const parts = text.match(/[\s\S]*?(?:\n{2,}|$)/gu) ?? [text];
  let order = 0;
  return parts.filter(part => part.length > 0).map(part => {
    const sentences = part.split(/[。！？!?\n]/u).map(item => item.trim()).filter(Boolean);
    const lengths = sentences.map(item => item.length);
    const average = lengths.length ? lengths.reduce((sum, length) => sum + length, 0) / lengths.length : 0;
    const variance = lengths.length ? lengths.reduce((sum, length) => sum + (length - average) ** 2, 0) / lengths.length : 0;
    const uniformity = lengths.length ? Math.max(0, 100 - Math.sqrt(variance) * 2) : 50;
    const logicCount = ['但是', '不过', '然而', '因此', '所以', '首先', '其次', '最后', '总之'].reduce((sum, word) => sum + part.split(word).length - 1, 0);
    const colloquialCount = ['咋', '啥', '呗', '嘛', '呢', '啊', '呀', '咯', '喽', '琢磨', '寻思'].reduce((sum, word) => sum + part.split(word).length - 1, 0);
    const templateCount = ['首先', '其次', '最后', '总之', '综上所述', '值得注意的是', '需要注意的是', '通过这种方式'].reduce((sum, word) => sum + part.split(word).length - 1, 0);
    const normalizedLength = Math.max(1, part.replace(/\s+/gu, '').length);
    const localSignal = 0.08 + uniformity / 100 * 0.2 + Math.min(1, logicCount / Math.max(1, sentences.length)) * 0.18 + (1 - Math.min(1, colloquialCount / Math.max(1, sentences.length))) * 0.14 + chapterScore * 0.16;
    const stronglyTemplated = sentences.length >= 4 && uniformity >= 88 && (templateCount >= 3 || logicCount >= 5);
    const confidence = stronglyTemplated ? 0.99 : Math.max(0, Math.min(0.98, Number((localSignal + (normalizedLength < 30 ? 0.03 : 0)).toFixed(3))));
    return { order: ++order, text: part, confidence, label: aiDetectionLabel(confidence) };
  });
};

export const analyzeAIChapter = (chapter: Chapter): AIDetectionChapter => {
  const text = aiDetectionSource(chapter.content);
  const sentences = text.split(/[。！？\n]/u).map(item => item.trim()).filter(Boolean);
  const lengths = sentences.map(item => item.length);
  const average = lengths.length ? lengths.reduce((sum, length) => sum + length, 0) / lengths.length : 0;
  const variance = lengths.length ? lengths.reduce((sum, length) => sum + (length - average) ** 2, 0) / lengths.length : 0;
  const sentenceUniformity = lengths.length ? Math.max(0, 100 - Math.sqrt(variance) * 2) : 50;
  const logicWords = ['但是', '不过', '然而', '因此', '所以', '首先', '其次', '最后', '总之', '综上所述'];
  const colloquialWords = ['咋', '啥', '呗', '嘛', '呢', '啊', '呀', '咯', '喽', '琢磨', '寻思', '要得'];
  const psychologicalPatterns = ['心里一', '心里头', '心里有', '心里明白', '心里盘算'];
  const perHundred = (count: number) => text.length ? count / (text.length / 100) : 0;
  const logicFrequency = perHundred(logicWords.reduce((sum, word) => sum + text.split(word).length - 1, 0));
  const colloquialFrequency = perHundred(colloquialWords.reduce((sum, word) => sum + text.split(word).length - 1, 0));
  const psychologicalFrequency = perHundred(psychologicalPatterns.reduce((sum, word) => sum + text.split(word).length - 1, 0));
  const paragraphs = text.split(/\n\n/u).map(item => item.trim()).filter(Boolean);
  const paragraphLengths = paragraphs.map(item => item.length);
  const paragraphAverage = paragraphLengths.length ? paragraphLengths.reduce((sum, length) => sum + length, 0) / paragraphLengths.length : 0;
  const paragraphVariance = paragraphLengths.length ? paragraphLengths.reduce((sum, length) => sum + (length - paragraphAverage) ** 2, 0) / paragraphLengths.length : 0;
  const paragraphUniformity = paragraphs.length > 1 ? Math.max(0, 100 - Math.sqrt(paragraphVariance)) : 50;
  const logicScore = Math.min(1, logicFrequency * 10 / 100);
  const colloquialScore = Math.min(1, colloquialFrequency * 20 / 100);
  const aiRate = Math.min(100, Math.max(0, sentenceUniformity / 100 * 25 + logicScore * 25 + (1 - colloquialScore) * 25 + Math.min(1, psychologicalFrequency * 5) * 15 + paragraphUniformity / 100 * 10));
  const segments = splitAIDetectionSegments(chapter.content, aiRate / 100);
  return {
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    wordCount: countNovelCharacters(chapter.content),
    sentenceUniformity: Number(sentenceUniformity.toFixed(1)),
    logicFrequency: Number(logicFrequency.toFixed(2)),
    colloquialFrequency: Number(colloquialFrequency.toFixed(2)),
    psychologicalFrequency: Number(psychologicalFrequency.toFixed(2)),
    paragraphUniformity: Number(paragraphUniformity.toFixed(1)),
    aiRate: Number(aiRate.toFixed(1)),
    humanRate: Number((100 - aiRate).toFixed(1)),
    segments,
    label: aiDetectionLabel(aiRate / 100),
  };
};

export const buildAIDetectionReport = (project: Project, scope: 'chapter' | 'book', chapter?: Chapter): AIDetectionReport => {
  const chapters = (scope === 'chapter' && chapter ? [chapter] : project.chapters).filter(item => item.content.trim()).map(analyzeAIChapter);
  const averageAIRate = chapters.length ? chapters.reduce((sum, item) => sum + item.aiRate, 0) / chapters.length : 0;
  const level = averageAIRate < 30 ? '极低' : averageAIRate < 45 ? '低' : averageAIRate < 60 ? '中等' : '高';
  const suggestion = averageAIRate < 30 ? '文本具有较强的人类写作特征。' : averageAIRate < 45 ? '文本具有人类写作特征，可保持具体动作和口语表达。' : averageAIRate < 60 ? '文本存在混合特征，建议增加句式变化和个性化细节。' : '文本具有较多模板化特征，建议使用去 AI 味技能复写后再检测。';
  return { updatedAt: new Date().toISOString(), scope, chapters, averageAIRate: Number(averageAIRate.toFixed(1)), level, suggestion, provider: '本地启发式' };
};
