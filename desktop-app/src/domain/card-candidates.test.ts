import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateExcerpts, deriveCardCandidates, ignoreCardCandidate } from './card-candidates.ts';
import { cardAliasTerms, combinedTitleParts } from './cards.ts';
import type { Chapter, KnowledgeCard, KnowledgeGraphEdge, KnowledgeGraphNode, Project } from './project.ts';

const now = '2026-01-01T00:00:00.000Z';
const chapter = (id: number, content = ''): Chapter => ({ id, title: `第 ${id} 章`, content, wordCount: content.length, createdAt: now, updatedAt: now });
const card = (id: number, title: string, type: KnowledgeCard['type'] = '角色卡'): KnowledgeCard => ({ id, type, title, content: `- **name**：${title}`, createdAt: now, updatedAt: now });
const entity = (label: string, category: string): KnowledgeGraphNode => ({ id: `entity:${label}`, label, type: 'entity', category });
const mention = (chapterId: number, label: string): KnowledgeGraphEdge => ({ id: `chapter:${chapterId}->entity:${label}`, source: `chapter:${chapterId}`, target: `entity:${label}`, label: '章节提及', weight: 0.7 });
const project = (patch: Partial<Project> = {}): Project => ({
  id: 1, title: '城南夜雨', genre: '悬疑', status: 'writing', chapters: [], outline: [], outlines: [], cards: [], memories: [], memoryDocuments: [], graphNodes: [], graphEdges: [], createdAt: now, updatedAt: now, wordCount: 0,
  ...patch,
});

test('合并卡的标题按连接词拆开，每段都算这张卡的名字', () => {
  assert.deepEqual(combinedTitleParts('沈宏业与沈淮'), ['沈宏业', '沈淮']);
  assert.deepEqual(combinedTitleParts('临安古籍文献修复研究所与西湖墨庄'), ['临安古籍文献修复研究所', '西湖墨庄']);
  assert.deepEqual(combinedTitleParts('沈妄'), []);
  assert.ok(cardAliasTerms(card(1, '沈宏业与沈淮')).includes('沈宏业'));
});

test('待建卡候选只认反复出现：人物三章、其他四章且三字以上；有卡的、忽略的、泛称的不算；按章数排序', () => {
  const chapters = Array.from({ length: 8 }, (_, index) => chapter(index + 1, `第${index + 1}章正文，韩正来了。`));
  const book = project({
    chapters,
    cards: [card(1, '沈宏业与沈淮')],
    ignoredCardCandidates: ['老程'],
    graphNodes: [
      entity('韩正', '人物'), entity('杜秉文', '人物'), entity('老程', '人物'), entity('沈宏业', '人物'), entity('陈干事', '人物'),
      entity('什刹海后海北沿十八号四合院', '地点'), entity('江城', '地点'), entity('明制大婚华服', '物品'), entity('硬夹', '物品'), entity('天宇法务', '势力'),
    ],
    graphEdges: [
      mention(1, '韩正'), mention(2, '韩正'), mention(3, '韩正'), mention(4, '韩正'),
      mention(1, '杜秉文'), mention(2, '杜秉文'),
      mention(1, '老程'), mention(2, '老程'), mention(3, '老程'),
      mention(1, '沈宏业'), mention(2, '沈宏业'), mention(3, '沈宏业'),
      mention(1, '陈干事'), mention(2, '陈干事'), mention(3, '陈干事'),
      mention(1, '什刹海后海北沿十八号四合院'), mention(2, '什刹海后海北沿十八号四合院'), mention(3, '什刹海后海北沿十八号四合院'), mention(4, '什刹海后海北沿十八号四合院'), mention(5, '什刹海后海北沿十八号四合院'),
      mention(1, '江城'), mention(2, '江城'), mention(3, '江城'), mention(4, '江城'), mention(5, '江城'),
      mention(1, '明制大婚华服'), mention(2, '明制大婚华服'), mention(3, '明制大婚华服'), mention(4, '明制大婚华服'),
      mention(1, '硬夹'), mention(2, '硬夹'), mention(3, '硬夹'),
      mention(1, '天宇法务'), mention(2, '天宇法务'), mention(3, '天宇法务'), mention(4, '天宇法务'),
    ],
  });
  const candidates = deriveCardCandidates(book);
  // 杜秉文只两章、老程被忽略、沈宏业有合并卡、陈干事是泛称、江城两个字、硬夹只三章：都不算
  assert.deepEqual(candidates.map(item => [item.label, item.type, item.chapterNumbers.length]).sort(), [
    ['什刹海后海北沿十八号四合院', '地点卡', 5],
    ['天宇法务', '势力卡', 4],
    ['明制大婚华服', '物品卡', 4],
    ['韩正', '角色卡', 4],
  ].sort());
  assert.equal(candidates[0].label, '什刹海后海北沿十八号四合院', '章数最多的排最前');
  const ignored = ignoreCardCandidate(book, '韩正');
  assert.ok(!deriveCardCandidates(ignored).some(item => item.key === '韩正'));
  assert.deepEqual(ignored.ignoredCardCandidates, ['老程', '韩正']);
});

test('候选的正文依据：最近几章里围绕它出现的位置各截一段', () => {
  const book = project({ chapters: [chapter(1, `${'前'.repeat(900)}韩正推门进来。${'后'.repeat(900)}`), chapter(2, '没有他。'), chapter(3, '韩正又来了。')] });
  const excerpt = candidateExcerpts(book, { key: '韩正', label: '韩正', category: '人物', type: '角色卡', chapterNumbers: [1, 3] }, 3, 20);
  assert.ok(excerpt.includes('### 第 1 章'));
  assert.ok(excerpt.includes('韩正推门进来'));
  assert.ok(!excerpt.includes('前'.repeat(30)), '只截出现位置前后一段');
  assert.ok(excerpt.includes('### 第 3 章'));
  assert.ok(!excerpt.includes('### 第 2 章'));
});
