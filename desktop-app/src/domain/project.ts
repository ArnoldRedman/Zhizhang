export type TagTab = '主分类' | '主题' | '角色' | '情节';
export type Channel = '男频' | '女频';

export interface ChapterSnapshot {
  content: string;
  wordCount: number;
  savedAt: string;
  /** 产生快照的原因，例如“AI 润色”、“去 AI 味” */
  reason: string;
}

export interface Chapter {
  id: number;
  title: string;
  content: string;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
  /** 覆盖正文前的历史版本，最新在前 */
  snapshots?: ChapterSnapshot[];
  /** 作家的话 / 作家寄语 (PS)，不计入正文字数 */
  authorNote?: string;
  /** 作者的正文批注：按原文片段定位，"按批注修订"时只改批注所在段落 */
  annotations?: Array<{ id: string; quote: string; note: string; createdAt: string }>;
}

export interface OutlineNode {
  id: number;
  title: string;
  description: string;
  type: 'arc' | 'chapter' | 'scene';
  children?: OutlineNode[];
  status: 'planned' | 'writing' | 'completed';
}

export type OutlineKind = '总纲' | '章纲' | '世界观与作品设定' | '审查报告';

export interface OutlineDocument {
  id: number;
  kind: OutlineKind;
  chapterId?: number;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export type CardType = '角色卡' | '物品卡' | '地点卡' | '势力卡' | '金手指卡';

export interface KnowledgeCard {
  id: number;
  type: CardType;
  title: string;
  content: string;
  currentState?: string;
  stateHistory?: Array<{ chapterId: number; chapterTitle: string; status: string; changes: string; updatedAt: string }>;
  /** 常驻：写正文与生成章纲时每章必带，不看正文里有没有提到 */
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterMemory {
  id: number;
  chapterId: number;
  chapterTitle: string;
  summary: string;
  keywords: string[];
  characterStateChanges: string[];
  knowledgeChanges: string[];
  foreshadowingChanges: string[];
  foreshadowingItems?: Array<{ text: string; status: 'active' | 'progressing' | 'resolved' | 'overdue'; priority: 'high' | 'normal' | 'low'; plantedChapter?: number; targetChapter?: number }>;
  timelineEvents: string[];
  canonFacts: string[];
  conflicts: string[];
  /** 人物关系与情绪：谁对谁是什么态度、这一章两人之间变了什么；感情线靠它承接，只记事务的记忆写不出感情 */
  relationshipState?: string[];
  /** 本章读者新知道的事：一致性审查用它查有没有泄底 */
  readerKnown?: string[];
  /** 本章埋下但读者还不知道的真相：进账本的"作者真相"，不进正文提示词的读者视图 */
  authorTruth?: string[];
  /** 本章结尾对下一章的承诺：下一章构思要回应它，一致性审查查兑现 */
  nextChapterPromise?: string;
  /** 本章新出现的具名人物、地点、物件、规则：收编进卡片候选 */
  newlyIntroduced?: string[];
  endingHook: string;
  sourceChapterNumber?: number;
  createdAt: string;
  updatedAt: string;
}

export type MemoryDocumentKind = '章节快照' | '人物状态' | '角色认知' | '伏笔追踪' | '时间线' | '设定事实' | '冲突';

export interface MemoryDocument {
  id: string;
  kind: MemoryDocumentKind;
  title: string;
  content: string;
  updatedAt: string;
  manuallyEdited?: boolean;
}

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  type: 'chapter' | 'card' | 'outline' | 'entity';
  category?: string;
  content?: string;
  sourcePath?: string;
  status?: string;
  sourceChapterIds?: number[];
  updatedAt?: string;
}

export interface KnowledgeGraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  weight?: number;
  sourceChapterId?: number;
  updatedAt?: string;
}

export type AIDetectionLabel = '人工' | '疑似 AI' | 'AI 特征';

export interface AIDetectionSegment {
  order: number;
  text: string;
  confidence: number;
  label: AIDetectionLabel;
}

export interface AIDetectionChapter {
  chapterId: number;
  chapterTitle: string;
  wordCount: number;
  sentenceUniformity: number;
  logicFrequency: number;
  colloquialFrequency: number;
  psychologicalFrequency: number;
  paragraphUniformity: number;
  aiRate: number;
  humanRate: number;
  segments: AIDetectionSegment[];
  label: AIDetectionLabel;
}

export interface AIDetectionReport {
  updatedAt: string;
  scope: 'chapter' | 'book';
  chapters: AIDetectionChapter[];
  averageAIRate: number;
  level: string;
  suggestion: string;
  provider: '本地启发式';
}

export interface Project {
  id: number;
  title: string;
  genre: string;
  subgenre?: string;
  tags?: Partial<Record<TagTab, string[]>>;
  cover?: string;
  protagonist1?: string;
  protagonist2?: string;
  synopsis?: string;
  status: 'writing' | 'completed';
  chapters: Chapter[];
  outline: OutlineNode[];
  outlines: OutlineDocument[];
  cards: KnowledgeCard[];
  memories: ChapterMemory[];
  memoryDocuments: MemoryDocument[];
  graphNodes: KnowledgeGraphNode[];
  graphEdges: KnowledgeGraphEdge[];
  createdAt: string;
  updatedAt: string;
  wordCount: number;
  publishConfig?: unknown;
  publishRecords?: unknown;
  aiDetection?: AIDetectionReport;
  chapterTargetWords?: number;
  styleProfileId?: string;
  sourceDismantleBookId?: string;
  authorPreferences?: string[];
  /** 审查档位：full 四视角、lean 两视角、solo 一次合并审查；缺省 lean */
  reviewMode?: 'full' | 'lean' | 'solo';
  /** 全书引号风格；验证门把每章统一到它。缺省按已有正文侦测 */
  quoteStyle?: 'curly' | 'corner' | 'ascii';
  /** 作者允许的字面句式（一行一个）：验证门命中它们时不报风格类问题 */
  allowedPhrases?: string[];
  githubRepositoryUrl?: string;
  /** 每日码字量，键为本地日期 YYYY-MM-DD */
  dailyWords?: Record<string, number>;
  /** 回收站：删除的章节，最新在前 */
  deletedChapters?: DeletedChapter[];
  /** 小说本身被删除的时间；有值时列表不展示，但本地文件仍保留 */
  deletedAt?: string;
}

export interface DeletedChapter {
  chapter: Chapter;
  /** 删除前的下标，恢复时尽量插回原位 */
  index: number;
  deletedAt: string;
}
