import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyGraphDedupeSuggestion, cleanupKnowledgeGraph, deferredHonorifics, mergeGraphNodes } from './graph-cleanup.ts';
import { cardAliasLines, cardAliasTerms, cardSearchTermGroups } from './cards.ts';
import { entityCoreLabel, isGenericEntityLabel, stripEntityTypeSuffix } from './entity-terms.ts';
import type { KnowledgeCard, KnowledgeGraphEdge, KnowledgeGraphNode, Project } from './project.ts';

const now = '2026-01-01T00:00:00.000Z';
const card = (id: number, title: string, content = `- **name**：${title}`): KnowledgeCard => ({ id, type: '角色卡', title, content, createdAt: now, updatedAt: now });
const entity = (label: string, category = '人物', content?: string): KnowledgeGraphNode => ({ id: `entity:${label}`, label, type: 'entity', category, content });
const mention = (chapter: number, target: string): KnowledgeGraphEdge => ({ id: `chapter:${chapter}->${target}`, source: `chapter:${chapter}`, target, label: '章节提及', weight: 0.7 });
const relation = (source: string, target: string, label: string): KnowledgeGraphEdge => ({ id: `${source}->${target}:${label}`, source, target, label, weight: 0.8 });
const project = (patch: Partial<Project> = {}): Project => ({
  id: 1, title: '城南夜雨', genre: '悬疑', status: 'writing', chapters: [], outline: [], outlines: [], cards: [], memories: [], memoryDocuments: [], graphNodes: [], graphEdges: [], createdAt: now, updatedAt: now, wordCount: 0,
  ...patch,
});

test('卡片别名：认英文字段的缩进列表与中文顿号列表，括号说明剥掉；称谓不进定位词但进合并称呼', () => {
  const content = '- **name**：姜正霖\n\n- **aliases**：\n  - 姜老董事长\n  - 姜叔叔\n  - 父亲\n\n- **archetype**：长者\n- 别名：老姜、姜董（第 3 章起）';
  assert.deepEqual(cardAliasLines(content), ['姜正霖', '姜老董事长', '姜叔叔', '父亲', '老姜', '姜董']);
  const primary = cardSearchTermGroups(card(1, '姜正霖', content)).primary;
  assert.ok(primary.includes('姜老董事长'));
  assert.ok(!primary.includes('父亲'), '称谓不能当正文定位主词');
  assert.ok(cardAliasTerms(card(1, '姜正霖', content)).includes('父亲'));
});

test('泛称判定：称谓、姓氏加职务、"的"字描述、群体都算；具名人物不算', () => {
  for (const label of ['爷爷', '老太爷', '韩律师', '陆师傅', '夏老', '孙叔叔', '圆框眼镜的女学徒', '林素华的徒弟', '四名年轻学徒', '绣娘们', '总建筑师', '抄纸老人', '高个学徒', '糕点铺老板娘', '栖迟书肆伙计', '沈妄之父', '阿婆（秦有娣之母）', '邵', '研究院来人', '责任编辑']) {
    assert.equal(isGenericEntityLabel(label), true, label);
  }
  for (const label of ['姜正霖', '沈妄', '韩正', '夏承安', '阿德里安·韦伯', '小满', '老程', '《破晓的四合院》', '沈崇义']) {
    assert.equal(isGenericEntityLabel(label), false, label);
  }
  // 势力、物品不套人物的称谓规则："天宇法务"是势力，"审核责任说明"是文件
  assert.equal(isGenericEntityLabel('天宇法务', '势力'), false);
  assert.equal(isGenericEntityLabel('天宇法务', '人物'), true);
  assert.equal(isGenericEntityLabel('法务', '势力'), true);
  assert.equal(stripEntityTypeSuffix('沈妄（人物）'), '沈妄');
  assert.equal(stripEntityTypeSuffix('民政局(地点)'), '民政局');
});

test('合并节点：边改指向目标、自环丢掉、重复边只留一条、写过的档案接到目标末尾', () => {
  const base = project({
    graphNodes: [entity('姜正霖', '人物', '## 档案\n沈妄的岳父，一直坐轮椅。'), entity('姜老太爷')],
    graphEdges: [mention(3, 'entity:姜老太爷'), mention(3, 'entity:姜正霖'), relation('entity:姜老太爷', 'entity:姜正霖', '同一人'), relation('entity:姜老太爷', 'card:1', '父亲')],
  });
  const merged = mergeGraphNodes(base, 'entity:姜老太爷', 'entity:姜正霖');
  assert.deepEqual(merged.graphNodes.map(node => node.label), ['姜正霖']);
  assert.equal(merged.graphEdges.filter(edge => edge.label === '章节提及').length, 1);
  assert.ok(!merged.graphEdges.some(edge => edge.source === edge.target));
  assert.ok(merged.graphEdges.some(edge => edge.source === 'entity:姜正霖' && edge.target === 'card:1' && edge.label === '父亲'));
  assert.ok(merged.graphNodes[0].content?.includes('沈妄的岳父'));
});

test('本地清理：别名与后缀并进卡片、错别字并进卡片、泛称删、长尾删、有真实关系的留', () => {
  const cardNode: KnowledgeGraphNode = { id: 'card:1', label: '姜正霖', type: 'card', category: '角色卡' };
  const base = project({
    cards: [card(1, '姜正霖', '- **aliases**：\n  - 姜老董事长'), card(2, '沈妄')],
    graphNodes: [
      cardNode, { id: 'card:2', label: '沈妄', type: 'card', category: '角色卡' },
      entity('沈妄'), entity('沈妄（人物）'), entity('姜老董事长'), entity('姜正林'), entity('爷爷'), entity('韩律师'),
      entity('韩正'), entity('于阿姨'), entity('宋晓宇'), entity('晓宇'), entity('桑皮纸', '物品'), entity('梧桐路', '地点'), entity('梧桐路（地点）', '地点'),
      { id: 'chapter:3', label: '第 3 章', type: 'chapter' }, { id: 'chapter:4', label: '第 4 章', type: 'chapter' },
    ],
    graphEdges: [
      mention(3, 'entity:沈妄'), mention(4, 'entity:沈妄（人物）'), mention(3, 'entity:姜老董事长'), mention(3, 'entity:姜正林'), mention(4, 'entity:姜正林'),
      mention(3, 'entity:爷爷'), mention(3, 'entity:韩律师'), mention(3, 'entity:韩正'), mention(4, 'entity:韩正'), mention(3, 'entity:于阿姨'),
      mention(3, 'entity:宋晓宇'), relation('entity:宋晓宇', 'card:2', '学徒'), mention(4, 'entity:晓宇'), mention(3, 'entity:桑皮纸'), mention(3, 'entity:梧桐路'), mention(4, 'entity:梧桐路（地点）'),
    ],
  });
  const { project: cleaned, report } = cleanupKnowledgeGraph(base);
  const labels = cleaned.graphNodes.filter(node => node.type === 'entity').map(node => node.label).sort();
  // 沈妄 与 沈妄（人物） 并进卡；姜老董事长 按别名并进卡；姜正林 错别字并进卡；爷爷、韩律师 泛称删；于阿姨 姓氏加称谓删；桑皮纸 长尾删；韩正 两章提到留；宋晓宇 有真实关系留；梧桐路 两个并成一个且两章提到留
  assert.deepEqual(labels, ['宋晓宇', '梧桐路', '韩正']);
  assert.ok(report.merged.some(item => item.from === '姜正林' && item.to === '姜正霖' && item.reason === '疑似错别字'));
  assert.ok(report.merged.some(item => item.from === '沈妄（人物）' && item.to === '沈妄'));
  assert.ok(report.removed.some(item => item.label === '爷爷'));
  assert.ok(report.removed.some(item => item.label === '桑皮纸'));
  assert.ok(report.merged.some(item => item.from === '晓宇' && item.to === '宋晓宇' && item.reason === '昵称'));
  assert.ok(cleaned.graphEdges.some(edge => edge.target === 'entity:宋晓宇' && edge.source === 'chapter:4'));
  // 并进卡片的边都指向卡片节点
  assert.ok(cleaned.graphEdges.some(edge => edge.target === 'card:1' && edge.source === 'chapter:4'));
  assert.ok(cleaned.graphEdges.some(edge => edge.target === 'card:2' && edge.source === 'chapter:4'));
  // 再清一遍什么都不动
  const again = cleanupKnowledgeGraph(cleaned);
  assert.equal(again.report.merged.length + again.report.removed.length, 0);
});

test('本地清理：势力与物品的变体按核心名并成一个，地点并进卡片标题片段，事件全删，两章提到的道具也删', () => {
  const place: KnowledgeCard = { ...card(5, '江城梧桐路58号老洋房顶楼601'), type: '地点卡' };
  const base = project({
    cards: [place],
    graphNodes: [
      { id: 'card:5', label: place.title, type: 'card', category: '地点卡' },
      entity('天宇法务', '势力'), entity('天宇法务部', '势力'), entity('天宇法务天团', '势力'),
      entity('《不可撤销家族信托母本契约正本》', '物品'), entity('不可撤销家族信托母本契约', '物品'), entity('信托母本复印件', '物品'),
      entity('梧桐路601', '地点'), entity('老洋房', '地点'), entity('冬至家宴', '事件'), entity('钢印机', '物品'), entity('宫灯', '物品'),
      { id: 'chapter:3', label: '第 3 章', type: 'chapter' }, { id: 'chapter:4', label: '第 4 章', type: 'chapter' }, { id: 'chapter:5', label: '第 5 章', type: 'chapter' },
    ],
    graphEdges: [
      mention(3, 'entity:天宇法务'), mention(4, 'entity:天宇法务部'), mention(5, 'entity:天宇法务天团'),
      mention(3, 'entity:《不可撤销家族信托母本契约正本》'), mention(4, 'entity:《不可撤销家族信托母本契约正本》'), mention(5, 'entity:不可撤销家族信托母本契约'), mention(5, 'entity:信托母本复印件'),
      mention(3, 'entity:梧桐路601'), mention(4, 'entity:老洋房'), mention(3, 'entity:冬至家宴'), mention(4, 'entity:冬至家宴'),
      mention(3, 'entity:钢印机'), mention(4, 'entity:钢印机'), mention(3, 'entity:宫灯'), mention(4, 'entity:宫灯'), mention(5, 'entity:宫灯'),
    ],
  });
  const { project: cleaned, report } = cleanupKnowledgeGraph(base);
  const labels = cleaned.graphNodes.filter(node => node.type === 'entity').map(node => node.label).sort();
  // 天宇法务三个并成一个（名字取最短，结尾的"法务"不算称谓）；信托契约两个并成一个共三章留下，"信托母本复印件"核心名不同不并、且只提过一次删掉；梧桐路与老洋房并进地点卡；冬至家宴删；钢印机两章删；宫灯三章留
  assert.deepEqual(labels, ['不可撤销家族信托母本契约', '天宇法务', '宫灯']);
  assert.equal(cleaned.graphEdges.filter(edge => edge.target === 'entity:天宇法务').length, 3);
  assert.ok(report.merged.some(item => item.from === '天宇法务天团' && item.to === '天宇法务' && item.reason === '同一事物的变体'));
  assert.ok(report.merged.some(item => item.from === '梧桐路601' && item.to === place.title && item.reason === '卡片标题片段'));
  assert.ok(cleaned.graphEdges.some(edge => edge.target === 'card:5' && edge.source === 'chapter:4'));
  assert.ok(report.removed.some(item => item.label === '冬至家宴'));
  assert.ok(report.removed.some(item => item.label === '钢印机'));
});

test('模型建议：from 对得上实体、to 对得上卡片称呼或实体才合并；对不上的跳过', () => {
  const base = project({
    cards: [card(1, '姜正霖')],
    graphNodes: [{ id: 'card:1', label: '姜正霖', type: 'card', category: '角色卡' }, entity('老太爷'), entity('姜老'), entity('杜秉文'), entity('杜老')],
    graphEdges: [mention(3, 'entity:老太爷'), mention(3, 'entity:姜老'), mention(3, 'entity:杜秉文'), mention(4, 'entity:杜老')],
  });
  const { project: next, report } = applyGraphDedupeSuggestion(base, {
    merges: [{ from: '老太爷', to: '姜正霖' }, { from: '杜老', to: '杜秉文' }, { from: '不存在', to: '姜正霖' }, { from: '姜老', to: '也不存在' }],
    removes: [{ name: '姜老', reason: '尊称' }],
  });
  assert.deepEqual(next.graphNodes.filter(node => node.type === 'entity').map(node => node.label), ['杜秉文']);
  assert.equal(report.merged.length, 2);
  assert.equal(report.removed.length, 1);
  assert.ok(next.graphEdges.some(edge => edge.target === 'card:1'));
});

test('带姓的尊称：deferHonorifics 时被提过两次以上的先留给模型，否则按泛称删', () => {
  const base = project({
    graphNodes: [entity('姜老太爷'), entity('夏老'), entity('爷爷')],
    graphEdges: [mention(3, 'entity:姜老太爷'), mention(4, 'entity:姜老太爷'), mention(3, 'entity:夏老'), mention(3, 'entity:爷爷'), mention(4, 'entity:爷爷')],
  });
  const deferred = cleanupKnowledgeGraph(base, { deferHonorifics: true });
  assert.deepEqual(deferred.project.graphNodes.map(node => node.label), ['姜老太爷']);
  assert.deepEqual(deferredHonorifics(deferred.project).map(node => node.label), ['姜老太爷']);
  const strict = cleanupKnowledgeGraph(base);
  assert.equal(strict.project.graphNodes.length, 0);
});

test('核心名：势力剥组织后缀最多两层，物品剥书名号与版本后缀，人物不剥', () => {
  assert.equal(entityCoreLabel('沈氏实业集团有限公司', '势力'), '沈氏实业');
  assert.equal(entityCoreLabel('天宇法务天团', '势力'), '天宇法务');
  assert.equal(entityCoreLabel('天宇集团', '势力'), '天宇');
  assert.equal(entityCoreLabel('《不可撤销家族信托母本契约正本》', '物品'), '不可撤销家族信托母本契约');
  assert.equal(entityCoreLabel('桑皮纸样本', '物品'), '桑皮纸');
  assert.equal(entityCoreLabel('韩正（人物）', '人物'), '韩正');
  assert.equal(entityCoreLabel('陆师傅', '人物'), '陆师傅');
});
