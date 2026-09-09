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
}

export interface OutlineNode {
  id: number;
  title: string;
  description: string;
  type: 'arc' | 'chapter' | 'scene';
  children?: OutlineNode[];
  status: 'planned' | 'writing' | 'completed';
}

export type OutlineKind = '总纲' | '章纲' | '世界观与作品设定';

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
