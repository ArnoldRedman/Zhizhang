export type DismantleChapterStatus = 'pending' | 'analyzing' | 'analyzed' | 'rewritten';

export interface DismantleChapter {
  id: string;
  number: number;
  title: string;
  sourceContent: string;
  wordCount: number;
  summary: string;
  detailedOutline: string;
  plotBeats: string[];
  characterDynamics: string[];
  setupPayoff: string[];
  pacing: string;
  rewriteContent: string;
  status: DismantleChapterStatus;
  sourcePath?: string;
  outlinePath?: string;
  rewritePath?: string;
  updatedAt: string;
}

export interface DismantleBook {
  id: string;
  title: string;
  sourceFileName: string;
  chapters: DismantleChapter[];
  boundProjectId?: number;
  sourceLibraryBookId?: string;
  /** 全书聚合：逐章拆解之上再做一次整书级提炼，写作时按目标情绪召回 */
  aggregate?: DismantleAggregate;
  createdAt: string;
  updatedAt: string;
}

/** 情绪模块卡：只留情绪链与功能位，人物场景道具触发条件全换，防止对标写成套壳 */
export interface EmotionModule {
  id: string;
  name: string;
  /** 读者在这里想要什么 */
  readerNeed: string;
  trigger: string;
  /** 戏剧单元：前状态 → 触发 → 后状态 */
  arc: string;
  replaceable: string;
  antiCopy: string;
  /** 与本模块最贴近的基调 */
  tone: string;
}

/** 原文锚点：一段三五百字的原文，标了基调；写作时同基调只给一段，模仿手法不抄字句 */
export interface StyleAnchor {
  tone: string;
  source: string;
  point: string;
  excerpt: string;
}

export interface DismantleAggregate {
  /** 文风档案 Markdown：句长分布、标点习惯、段落节奏、对话标签、角色语气区分、可借鉴技巧 */
  styleProfile: string;
  anchors: StyleAnchor[];
  emotionModules: EmotionModule[];
  /** 节奏表 Markdown：关键信息 → 扩写技法 → 情绪触动点 → 爆发或冷却 */
  rhythm: string;
  /** 参与聚合的章号 */
  chapterNumbers: number[];
  updatedAt: string;
}

export interface LibraryBookChapter {
  id: string;
  number: number;
  title: string;
  url: string;
  content: string;
  wordCount: number;
  downloaded: boolean;
  unavailableReason?: string;
  outline?: string;
}

export interface LibraryBook {
  id: string;
  title: string;
  author: string;
  source: string;
  sourceId?: string;
  sourceBookId?: string;
  url: string;
  intro: string;
  cover?: string;
  category?: string;
  wordCount?: number;
  chapters: LibraryBookChapter[];
  downloadedAt?: string;
  createdAt: string;
  updatedAt: string;
  localPath?: string;
  fontCss?: string;
}

export type RankingPlatform = 'fanqie' | 'qidian' | 'faloo';
export type RankingType = 'read' | 'new' | 'hot' | 'completed' | 'collect';
export type FanqieSection = 'male-read' | 'male-new' | 'female-read' | 'female-new';

export interface RankingCategoryOption {
  id: string;
  label: string;
  url: string;
  gender: 'male' | 'female';
  list: 'read' | 'new';
}

export interface RankingBook {
  id: string;
  sourceId?: string;
  title: string;
  author: string;
  intro: string;
  cover?: string;
  category?: string;
  rank: number;
  rankType: RankingType;
  gender: 'male' | 'female' | 'all';
  platform: RankingPlatform;
  sourceBookId?: string;
  url: string;
  wordCount?: number;
  readCount?: number;
  fetchedAt: string;
  sourceName?: string;
}

export interface WritingStyle {
  id: string;
  name: string;
  description: string;
  tags: string[];
  content: string;
  sourceBookId?: string;
  createdAt: string;
  updatedAt: string;
  sourcePath?: string;
}
