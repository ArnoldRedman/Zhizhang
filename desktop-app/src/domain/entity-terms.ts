/**
 * 不该单独成为图谱节点的称谓与泛称
 * 记忆提炼把正文里的"爷爷""韩律师""圆框眼镜的女学徒"都当实体抽出来，一本书攒出一百多个只有名字没有内容的人物节点；
 * 这些词要么是某个已有人物的称呼（该合并进卡片），要么根本不是一个人（该删）。卡片、图谱合并、图谱清理三处共用这一份
 */
export const relationalTerms = new Set([
  '爷爷', '奶奶', '外公', '外婆', '父亲', '母亲', '爸爸', '妈妈', '爸', '妈', '哥哥', '姐姐', '弟弟', '妹妹', '哥', '姐', '嫂子', '嫂嫂',
  '叔叔', '伯伯', '大伯', '二伯', '舅舅', '姑姑', '姨妈', '阿姨', '婶婶', '堂哥', '堂弟', '堂姐', '堂妹', '表哥', '表弟', '表姐', '表妹',
  '丈夫', '妻子', '老公', '老婆', '前夫', '前妻', '未婚夫', '未婚妻', '孙女', '孙子', '女儿', '儿子', '岳父', '岳母', '公公', '婆婆',
  '老太爷', '老爷子', '老先生', '老人', '老人家', '老头', '老者', '长者', '晚辈', '长辈', '先生', '女士', '小姐', '少爷', '姑娘', '夫人', '太太',
  '师傅', '老师傅', '师父', '徒弟', '学徒', '学徒们', '伙计', '伙计们', '助理', '秘书', '司机', '保安', '保镖', '管家', '管事', '护士', '医生', '大夫',
  '律师', '法官', '公证员', '登记员', '干事', '主任', '经理', '老板', '掌柜', '院长', '局长', '队长', '处长', '科长', '所长', '馆长', '校长', '教授',
  '记者', '摄影师', '编辑', '责任编辑', '导演', '客人', '来客', '访客', '来人', '路人', '众人', '大家', '年轻人', '中年人', '中年女人', '中年男人', '女人', '男人',
  '孩子', '小孩', '少年', '少女', '青年', '绣娘', '绣娘们', '工人', '工人们', '匠人', '老匠人', '手艺人', '村民', '邻居', '同事', '朋友', '发小', '同学',
  '总建筑师', '建筑师', '设计师', '联络人', '代表', '经办人', '经办人员', '陪同人员', '工作人员', '服务员', '前台', '门卫',
  '阿婆', '阿公', '老板娘', '法务', '安保', '安保队长', '警卫', '志愿者', '嘉宾', '观众', '读者', '学生', '老师', '专家', '学者', '领导', '官员',
]);

/** 记忆提炼给实体名加的类型后缀："沈妄（人物）""民政局（地点）"，同一个人因此裂成两个节点 */
const typeSuffixPattern = /[（(]\s*(?:人物|角色|角色卡|地点|场景|物品|势力|组织|事件|设定|实体)\s*[）)]$/u;

export const stripEntityTypeSuffix = (label: string) => label.replace(typeSuffixPattern, '').trim();

/** 势力名常见的部门与组织后缀："天宇法务 / 天宇法务部 / 天宇法务天团"是一回事；长的在前，先匹配长的 */
const orgSuffixes = ['有限公司', '天团', '团队', '总部', '分部', '部门', '集团', '公司', '方面', '一方', '部', '处', '组', '科', '室', '局', '团', '所', '方'];
/** 物品名常见的版本与形态后缀："信托母本契约 / 信托母本契约正本 / 信托母本契约复印件"指同一份东西 */
const itemSuffixes = ['复印件', '扫描件', '原件', '正本', '副本', '样本', '试样', '样纸', '残卷', '残本', '母本', '抄本', '拓本', '拓片', '一册', '一卷', '一份', '照片'];

/**
 * 实体名归到"核心名"：剥类型后缀、括号说明、书名号与引号，再按类别剥组织或版本后缀
 * 图谱合并与图谱清理都用它判"是不是同一个东西"；核心名相同才并，不做模糊匹配
 */
export const entityCoreLabel = (label: string, category?: string): string => {
  let core = stripEntityTypeSuffix(label).replace(/[（(][^）)]*[）)]/gu, '').trim();
  core = core.replace(/^[《「『‘'"“]+|[》」』’'"”]+$/gu, '').trim();
  const suffixes = /势力|组织/u.test(category || '') ? orgSuffixes : /物品|设定/u.test(category || '') ? itemSuffixes : [];
  // 最多剥两层："沈氏实业集团有限公司"先去"有限公司"再去"集团"，和"沈氏实业"才对得上
  for (let round = 0; round < 2; round += 1) {
    const suffix = suffixes.find(item => core.length > item.length + 1 && core.endsWith(item));
    if (!suffix) break;
    core = core.slice(0, -suffix.length).trim();
  }
  return core;
};

/** 地点、势力这类卡的标题是长描述（"江城梧桐路58号老洋房顶楼601"），实体名是它的一段就算命中；这些通用词除外 */
const genericPlaceWords = new Set(['研究所', '研究院', '医院', '学院', '大学', '中心', '法庭', '法院', '别墅', '书肆', '老宅', '酒店', '机场', '车站', '公司', '集团', '博物馆', '图书馆', '庄园', '殿堂', '画室', '展厅', '病房', '疗养', '苏黎世', '瑞士', '江城', '京城', '临安', '南洋', '西湖']);

/** 实体名剥掉数字后至少三个字、不是通用词、且是某张同类卡片标题的一段：并进那张卡 */
export const matchesCardTitleFragment = (label: string, cardTitle: string): boolean => {
  const core = entityCoreLabel(label).replace(/[0-9０-９]+/gu, '').trim();
  if (core.length < 3 || genericPlaceWords.has(core)) return false;
  return cardTitle.includes(core);
};

/** 带姓的尊称、简称："姜老太爷""夏老""韩律师"：多半是某个具名人物的称呼，规则不知道是谁，要交给模型并进正主 */
export const isSurnamedHonorific = (label: string) => {
  const normalized = stripEntityTypeSuffix(label).replace(/[（(][^）)]*[）)]/gu, '').trim();
  return /^[一-鿿]{1,2}(?:老太爷|老爷子|老先生|律师|师傅|老师傅|院长|局长|队长|所长|馆长|主任|经理|老板|掌柜|博士|教授|医生|大夫|干事|助理|秘书|司机|阿姨|叔叔|伯伯|大爷|大妈|老|总|董|哥|姐|叔|伯)$/u.test(normalized) && !relationalTerms.has(normalized);
};

/**
 * 是不是一个不该单独成节点的泛称
 * 整个词在称谓表里、以"的"引出的描述（"林素华的徒弟""圆框眼镜的女学徒"）、带数量的群体（"四名年轻学徒"）、以"们"结尾的都算
 * 姓氏加称谓、描述加身份这两条只对人物用："天宇法务"是势力，结尾的"法务"不能让它变成泛称
 */
export const isGenericEntityLabel = (label: string, category?: string) => {
  // 括号里的说明剥掉再判："阿婆（秦有娣之母）"就是"阿婆"
  const normalized = stripEntityTypeSuffix(label).replace(/[（(][^）)]*[）)]/gu, '').trim();
  if (!normalized) return true;
  if (normalized.length === 1) return true;
  // 书名号里的是作品名，"《破晓的四合院》"里有"的"也不是描述
  if (/^[《「『][^》」』]+[》」』]$/u.test(normalized)) return false;
  if (relationalTerms.has(normalized)) return true;
  if (/的/u.test(normalized) && normalized.length >= 4) return true;
  if (/^[一二两三四五六七八九十几数百千][名个位群批些]/u.test(normalized)) return true;
  if (/们$/u.test(normalized)) return true;
  const personLike = !category || /人物|角色|实体/u.test(category);
  if (!personLike) return false;
  // "沈妄之父""秦有娣之兄"：某人的亲属，正文没给名字
  if (/之(?:父|母|兄|弟|姐|妹|妻|夫|子|女|友)$/u.test(normalized)) return true;
  // 姓氏加称谓："韩律师""陆师傅""孙院长""夏老"：是某个具名人物的称呼，不是独立的人
  if (/^[一-鿿]{1,2}(?:律师|师傅|老师傅|院长|局长|队长|所长|馆长|主任|经理|老板|掌柜|博士|教授|医生|大夫|干事|助理|秘书|司机|阿姨|叔叔|伯伯|大爷|大妈|老)$/u.test(normalized)) return true;
  // 描述加身份："抄纸老人""高个学徒""糕点铺老板娘""栖迟书肆伙计"：结尾是称谓表里的身份词、前面是描述
  for (const term of relationalTerms) {
    if (term.length >= 2 && normalized.length > term.length && normalized.endsWith(term)) return true;
  }
  return false;
};
