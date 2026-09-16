use serde_json::Value;
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

/// 0.1.6 之前应用叫 ApiSaverWriter，bundle identifier 是 com.apisaverwriter.app。
/// Tauri 用 identifier 拼数据目录，改名后目录跟着变，老用户的小说会“看起来丢了”。
const LEGACY_APP_DATA_DIRECTORY: &str = "com.apisaverwriter.app";

/// 应用数据目录。新目录还不存在而旧目录在时，整体搬过来；搬不动就继续用旧目录，
/// 宁可留着旧名字也不让已有小说落空。
pub fn app_data_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录: {error}"))?;
    Ok(adopt_legacy_data_directory(directory))
}

fn adopt_legacy_data_directory(directory: PathBuf) -> PathBuf {
    if directory.exists() {
        return directory;
    }
    let Some(legacy) = directory.parent().map(|parent| parent.join(LEGACY_APP_DATA_DIRECTORY)) else {
        return directory;
    };
    if !legacy.is_dir() || legacy == directory {
        return directory;
    }
    match fs::rename(&legacy, &directory) {
        Ok(()) => directory,
        // 跨卷或目录被占用时搬不动：这次继续用旧目录，下次启动再试
        Err(error) => {
            eprintln!("旧数据目录迁移失败，继续使用 {}: {error}", legacy.display());
            legacy
        }
    }
}

/// 保存是整目录级的操作：读写改到后台线程后，自动保存、手动保存和启动读取可能重叠，必须串行
fn save_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 上次写入各文件的内容指纹
/// 一本书有近千个图谱档案、近两百个章节文件，以前每次自动保存都先清空再全量重写，
/// 编辑器每停顿一次就是上千次磁盘写入，整个应用跟着卡；现在只重写内容变了的文件
fn written_digests() -> &'static Mutex<HashMap<PathBuf, u64>> {
    static DIGESTS: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();
    DIGESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn content_digest(content: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    hasher.finish()
}

/// 内容与上次写入一致且文件仍在时跳过；文件被外部删掉会补回。返回是否真的写了
fn write_if_changed(path: &Path, content: &[u8]) -> Result<bool, String> {
    let digest = content_digest(content);
    let unchanged = written_digests()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(path)
        .is_some_and(|known| *known == digest);
    if unchanged && path.is_file() {
        return Ok(false);
    }
    fs::write(path, content).map_err(|error| format!("写入 {} 失败: {error}", path.display()))?;
    written_digests()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(path.to_path_buf(), digest);
    Ok(true)
}

/// 删除目录里不再对应任何条目的 Markdown：改名或删除的条目不留旧文件，保留的文件不再先删后写
fn remove_stale_markdown(dir: &Path, keep: &HashSet<PathBuf>) -> Result<(), String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md") || keep.contains(&path) {
            continue;
        }
        fs::remove_file(&path).map_err(|error| format!("清理旧文件 {} 失败: {error}", path.display()))?;
        written_digests()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&path);
    }
    Ok(())
}

#[cfg(test)]
mod data_directory_tests {
    use super::adopt_legacy_data_directory;
    use std::fs;

    #[test]
    fn 旧数据目录在改名后被接管() {
        let root = std::env::temp_dir().join(format!("zhizhang-migrate-{}", std::process::id()));
        let legacy = root.join(super::LEGACY_APP_DATA_DIRECTORY);
        let current = root.join("com.zhizhang.app");
        fs::create_dir_all(legacy.join("projects")).unwrap();
        fs::write(legacy.join("projects").join("metadata.json"), b"{}").unwrap();

        let resolved = adopt_legacy_data_directory(current.clone());
        assert_eq!(resolved, current, "新目录应当接管旧数据");
        assert!(current.join("projects").join("metadata.json").exists(), "小说文件必须跟着搬过去");
        assert!(!legacy.exists(), "搬完后旧目录不应残留");

        // 新目录已经存在时不再回看旧目录，避免二次搬运覆盖新数据
        fs::create_dir_all(&legacy).unwrap();
        assert_eq!(adopt_legacy_data_directory(current.clone()), current);
        assert!(legacy.exists());

        fs::remove_dir_all(&root).ok();
    }
}

#[tauri::command]
pub async fn load_projects(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    // 启动时要读几百个章节和近千个图谱档案；同步命令跑在主线程上，读盘期间整个窗口无响应
    tauri::async_runtime::spawn_blocking(move || load_projects_blocking(app))
        .await
        .map_err(|error| format!("读取小说任务中断: {error}"))?
}

fn load_projects_blocking(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    // 读盘期间不能有保存正在写一半
    let _guard = save_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let app_data = app_data_directory(&app)?;
    let root = app_data.join("projects");

    if root.exists() {
        let mut projects = Vec::new();
        let mut entries: Vec<_> = fs::read_dir(&root)
            .map_err(|error| format!("读取小说目录失败: {error}"))?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .collect();
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            let project_dir = entry.path();
            let metadata_path = project_dir.join("metadata.json");
            if !metadata_path.exists() {
                continue;
            }
            let metadata_content = fs::read_to_string(&metadata_path)
                .map_err(|error| format!("读取小说元数据失败: {error}"))?;
            let mut project: Value = serde_json::from_str(&metadata_content)
                .map_err(|error| format!("小说元数据格式错误: {error}"))?;

            if let Some(chapters) = project.get_mut("chapters").and_then(Value::as_array_mut) {
                for chapter in chapters {
                    let chapter_title = chapter
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("未命名章节");
                    let chapter_path = project_dir
                        .join("章节")
                        .join(format!("{}.md", safe_file_name(chapter_title)));
                    let legacy_chapter_id = chapter.get("id").and_then(Value::as_i64).unwrap_or(0);
                    let legacy_path = project_dir
                        .join("novel")
                        .join("chapters")
                        .join(format!("chapter-{legacy_chapter_id}.md"));
                    let source_path = if chapter_path.exists() {
                        chapter_path
                    } else {
                        legacy_path
                    };
                    if source_path.exists() {
                        let content = fs::read_to_string(source_path)
                            .map_err(|error| format!("读取章节 Markdown 失败: {error}"))?;
                        chapter["content"] = Value::String(content);
                    }
                }
            }

            if let Some(outlines) = project.get_mut("outlines").and_then(Value::as_array_mut) {
                for outline in outlines {
                    let title = outline
                        .get("title")
                        .and_then(Value::as_str)
                        .or_else(|| outline.get("kind").and_then(Value::as_str))
                        .unwrap_or("大纲");
                    let path = project_dir
                        .join("大纲")
                        .join(format!("{}.md", safe_file_name(title)));
                    if path.exists() {
                        if let Ok(content) = fs::read_to_string(path) {
                            outline["content"] = Value::String(content);
                        }
                    }
                }
            }
            if let Some(cards) = project.get_mut("cards").and_then(Value::as_array_mut) {
                for card in cards {
                    let card_type = card.get("type").and_then(Value::as_str).unwrap_or("角色卡");
                    let title = card
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("未命名卡片");
                    let path = project_dir
                        .join("卡片")
                        .join(card_type)
                        .join(format!("{}.md", safe_file_name(title)));
                    if path.exists() {
                        if let Ok(content) = fs::read_to_string(path) {
                            let (body, state_section) = content.split_once("\n## 当前状态\n").map(|(body, state)| (body, Some(state))).unwrap_or((content.as_str(), None));
                            card["content"] = Value::String(body.to_string());
                            if card.get("currentState").and_then(Value::as_str).unwrap_or("").trim().is_empty() {
                                if let Some(state) = state_section {
                                    let state = state.split("\n## 状态历史\n").next().unwrap_or(state).trim();
                                    if !state.is_empty() && state != "暂无" { card["currentState"] = Value::String(state.to_string()); }
                                }
                            }
                        }
                    }
                }
            }
            // Chapter snapshots stay structured in metadata; aggregated documents are user-editable
            // Markdown, so read their file contents back into the project on every launch.
            if let Some(documents) = project.get_mut("memoryDocuments").and_then(Value::as_array_mut) {
                for document in documents {
                    let title = document
                        .get("title")
                        .or_else(|| document.get("kind"))
                        .and_then(Value::as_str)
                        .unwrap_or("章节快照");
                    let path = project_dir
                        .join("记忆")
                        .join(format!("{}.md", safe_file_name(title)));
                    if let Ok(content) = fs::read_to_string(path) {
                        document["content"] = Value::String(content);
                    }
                }
            }
            // 图谱节点的详细档案以 Markdown 作为事实来源；metadata 仅保留索引字段。
            if let Some(nodes) = project.get_mut("graphNodes").and_then(Value::as_array_mut) {
                for node in nodes {
                    let relative_path = node.get("sourcePath").and_then(Value::as_str)
                        .map(PathBuf::from)
                        .unwrap_or_else(|| graph_node_relative_path(node));
                    let path = project_dir.join(&relative_path);
                    if let Ok(content) = fs::read_to_string(&path) {
                        node["content"] = Value::String(graph_node_profile_from_markdown(&content));
                    }
                    node["sourcePath"] = Value::String(relative_path.to_string_lossy().into_owned());
                }
            }
            projects.push(project);
        }

        if !projects.is_empty() {
            return Ok(Some(Value::Array(projects)));
        }
    }

    // 兼容上一版单文件存储，下一次保存时会自动拆分为目录结构。
    let legacy_path = app_data.join("projects.json");
    if legacy_path.exists() {
        let content = fs::read_to_string(&legacy_path)
            .map_err(|error| format!("读取旧版小说文件失败: {error}"))?;
        let projects = serde_json::from_str(&content)
            .map_err(|error| format!("旧版小说文件格式错误: {error}"))?;
        return Ok(Some(projects));
    }

    Ok(None)
}


#[tauri::command]
pub async fn save_projects(app: tauri::AppHandle, projects: Value) -> Result<String, String> {
    // 同步命令跑在主线程上，写上千个文件时整个窗口都会卡住；改到阻塞线程池，并用锁保证两次保存不交错
    tauri::async_runtime::spawn_blocking(move || save_projects_blocking(app, projects))
        .await
        .map_err(|error| format!("保存小说任务中断: {error}"))?
}

fn save_projects_blocking(app: tauri::AppHandle, projects: Value) -> Result<String, String> {
    let _guard = save_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let app_data = app_data_directory(&app)?;
    let root = app_data.join("projects");
    fs::create_dir_all(&root).map_err(|error| format!("创建小说目录失败: {error}"))?;
    let project_array = projects
        .as_array()
        .ok_or_else(|| "小说数据必须是数组".to_string())?;

    let mut current_directories = Vec::new();
    let mut used_directory_names = HashSet::new();
    for project in project_array {
        let id = project.get("id").and_then(Value::as_i64).unwrap_or(0);
        let title = project
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("未命名小说");
        let base = safe_folder_name(title);
        let mut directory_name = base.clone();
        if !used_directory_names.insert(directory_name.clone()) {
            directory_name = format!("{base}-{id}");
            used_directory_names.insert(directory_name.clone());
        }
        current_directories.push(directory_name);
    }

    // 删除已在应用中删除的小说目录，避免留下用户误以为仍存在的旧项目。
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !current_directories.contains(&name) {
                fs::remove_dir_all(entry.path())
                    .map_err(|error| format!("清理旧小说目录失败: {error}"))?;
            }
        }
    }

    for (index, project) in project_array.iter().enumerate() {
        project
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "小说缺少有效 ID".to_string())?;
        let project_dir = root.join(&current_directories[index]);
        let chapters_dir = project_dir.join("章节");
        let outline_dir = project_dir.join("大纲");
        let cards_dir = project_dir.join("卡片");
        let memories_dir = project_dir.join("记忆");
        let graph_dir = project_dir.join("图谱");
        fs::create_dir_all(&chapters_dir).map_err(|error| format!("创建章节目录失败: {error}"))?;
        fs::create_dir_all(&outline_dir).map_err(|error| format!("创建大纲目录失败: {error}"))?;
        fs::create_dir_all(&cards_dir).map_err(|error| format!("创建卡片目录失败: {error}"))?;
        fs::create_dir_all(&memories_dir).map_err(|error| format!("创建记忆目录失败: {error}"))?;
        fs::create_dir_all(&graph_dir).map_err(|error| format!("创建图谱目录失败: {error}"))?;
        // 不再先清空目录再全量重写：只写内容有变化的文件，最后删掉不再对应任何条目的旧文件
        let mut kept_chapter_files = HashSet::new();
        let mut kept_outline_files = HashSet::new();
        let mut kept_card_files = HashSet::new();

        let mut metadata = project.clone();
        if let Some(chapters) = metadata.get_mut("chapters").and_then(Value::as_array_mut) {
            for chapter in chapters.iter_mut() {
                let content = chapter.get("content").and_then(Value::as_str).unwrap_or("");
                let chapter_title = chapter
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("未命名章节");
                let path = chapters_dir.join(format!("{}.md", safe_file_name(chapter_title)));
                write_if_changed(&path, content.as_bytes())?;
                kept_chapter_files.insert(path);
                chapter["content"] = Value::String(String::new());
            }
        }
        remove_stale_markdown(&chapters_dir, &kept_chapter_files)?;

        if let Some(outlines) = metadata.get_mut("outlines").and_then(Value::as_array_mut) {
            for outline in outlines.iter_mut() {
                let title = outline
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("大纲");
                let content = outline.get("content").and_then(Value::as_str).unwrap_or("");
                let path = outline_dir.join(format!("{}.md", safe_file_name(title)));
                write_if_changed(&path, content.as_bytes())?;
                kept_outline_files.insert(path);
                outline["content"] = Value::String(String::new());
            }
        }
        // 兼容旧版本的树形大纲，同时让目录中始终存在可打开的大纲文件。
        if metadata
            .get("outlines")
            .and_then(Value::as_array)
            .map(|items| items.is_empty())
            .unwrap_or(true)
        {
            let outline_markdown = outline_to_markdown(project.get("outline"));
            let path = outline_dir.join("大纲.md");
            write_if_changed(&path, outline_markdown.as_bytes())?;
            kept_outline_files.insert(path);
        }
        remove_stale_markdown(&outline_dir, &kept_outline_files)?;

        if let Some(cards) = metadata.get_mut("cards").and_then(Value::as_array_mut) {
            for card in cards.iter_mut() {
                let card_type = card.get("type").and_then(Value::as_str).unwrap_or("角色卡");
                let title = card
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("未命名卡片");
                let content = card.get("content").and_then(Value::as_str).unwrap_or("");
                let current_state = card.get("currentState").and_then(Value::as_str).unwrap_or("");
                let state_history = card.get("stateHistory").and_then(Value::as_array).map(|items| {
                    items.iter().rev().take(5).filter_map(|item| {
                        let chapter_title = item.get("chapterTitle").and_then(Value::as_str).unwrap_or("全文检索");
                        let changes = item.get("changes").and_then(Value::as_str).unwrap_or("");
                        if changes.trim().is_empty() { None } else { Some(format!("- {chapter_title}：{changes}")) }
                    }).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
                }).unwrap_or_default();
                let type_dir = cards_dir.join(card_type);
                fs::create_dir_all(&type_dir)
                    .map_err(|error| format!("创建卡片分类目录失败: {error}"))?;
                let path = type_dir.join(format!("{}.md", safe_file_name(title)));
                let markdown = format!("{content}\n\n## 当前状态\n{}\n\n## 状态历史\n{}\n", if current_state.trim().is_empty() { "暂无" } else { current_state }, if state_history.trim().is_empty() { "- 暂无" } else { &state_history });
                write_if_changed(&path, markdown.as_bytes())?;
                kept_card_files.insert(path);
                card["content"] = Value::String(String::new());
            }
        }
        if let Ok(entries) = fs::read_dir(&cards_dir) {
            for entry in entries.filter_map(Result::ok).filter(|entry| entry.path().is_dir()) {
                remove_stale_markdown(&entry.path(), &kept_card_files)?;
            }
        }
        if let Some(memories) = metadata.get_mut("memories").and_then(Value::as_array_mut) {
            for memory in memories.iter_mut() {
                let title = memory
                    .get("chapterTitle")
                    .and_then(Value::as_str)
                    .unwrap_or("章节记忆");
                let content = chapter_memory_to_markdown(memory);
                write_if_changed(&memories_dir.join(format!("{}.md", safe_file_name(title))), content.as_bytes())?;
            }
        }
        if let Some(documents) = metadata.get_mut("memoryDocuments").and_then(Value::as_array_mut) {
            for document in documents.iter_mut() {
                let title = document
                    .get("title")
                    .or_else(|| document.get("kind"))
                    .and_then(Value::as_str)
                    .unwrap_or("章节快照");
                let content = document.get("content").and_then(Value::as_str).unwrap_or("");
                write_if_changed(&memories_dir.join(format!("{}.md", safe_file_name(title))), content.as_bytes())?;
            }
        }
        let graph_edges: &[Value] = project.get("graphEdges").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        let graph_node_snapshots: &[Value] = project.get("graphNodes").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        // 索引建一次：以前近千个节点各自扫一遍近三千条关系、再线性查对端标签，一次保存要几百万次比较
        let graph_index = build_graph_index(graph_node_snapshots, graph_edges);
        if let Some(nodes) = metadata.get_mut("graphNodes").and_then(Value::as_array_mut) {
            for node in nodes.iter_mut() {
                let relative_path = graph_node_relative_path(node);
                let path = project_dir.join(&relative_path);
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| format!("创建图谱档案目录失败: {error}"))?;
                }
                write_if_changed(&path, graph_node_markdown_with_index(node, &graph_index).as_bytes())?;
                node["sourcePath"] = Value::String(relative_path.to_string_lossy().into_owned());
                node["content"] = Value::String(String::new());
            }
        }

        let metadata_content = serde_json::to_vec_pretty(&metadata)
            .map_err(|error| format!("序列化小说元数据失败: {error}"))?;
        write_if_changed(&project_dir.join("metadata.json"), &metadata_content)?;
    }

    let legacy_path = app_data.join("projects.json");
    if legacy_path.exists() {
        let _ = fs::remove_file(legacy_path);
    }
    Ok(root.to_string_lossy().into_owned())
}


pub fn graph_node_folder(node: &Value) -> &'static str {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("entity");
    let category = node.get("category").and_then(Value::as_str).unwrap_or("");
    match node_type {
        "chapter" => "章节事件",
        "outline" => "大纲设定",
        "card" if category.contains("角色") || category.contains("人物") => "重要角色",
        "card" if category.contains("地点") => "地点与场景",
        "card" if category.contains("势力") => "组织与势力",
        "card" => "物品与设定",
        "entity" if category.contains("人物") || category.contains("角色") => "重要角色",
        "entity" if category.contains("地点") || category.contains("场景") => "地点与场景",
        "entity" if category.contains("势力") || category.contains("组织") => "组织与势力",
        "entity" if category.contains("物品") || category.contains("金手指") => "物品与设定",
        _ => "其他实体",
    }
}


pub fn graph_node_type_label(node: &Value) -> String {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("entity");
    let category = node.get("category").and_then(Value::as_str).unwrap_or("");
    match node_type {
        "chapter" => "章节".to_string(),
        "outline" => "大纲".to_string(),
        "card" => if category.is_empty() { "知识卡".to_string() } else { category.to_string() },
        _ => if category.is_empty() { "实体".to_string() } else { category.to_string() },
    }
}


pub fn graph_node_relative_path(node: &Value) -> PathBuf {
    let title = node.get("label").and_then(Value::as_str).unwrap_or("未命名节点");
    PathBuf::from("图谱")
        .join(graph_node_folder(node))
        .join(format!("{}.md", safe_file_name(title)))
}


pub fn graph_node_profile_from_markdown(content: &str) -> String {
    let marker = "\n## 档案内容\n";
    let Some((_, after)) = content.split_once(marker) else { return content.trim().to_string(); };
    after.split("\n## 关系网络\n").next().unwrap_or(after).trim().to_string()
}


pub fn graph_edge_default_weight(label: &str) -> f64 {
    match label {
        "本章引用" => 1.0,
        "状态更新" => 0.95,
        "章节主角" => 0.92,
        "状态引用" => 0.88,
        "正文提及" => 0.75,
        "章节提及" => 0.70,
        _ => 0.65,
    }
}


/// 图谱档案渲染用的索引：按节点 id 查标签、查相连的关系
pub struct GraphIndex<'a> {
    labels: HashMap<&'a str, &'a str>,
    edges: HashMap<&'a str, Vec<&'a Value>>,
}

/// 建一次索引给全部节点共用；单个节点渲染时也可以临时建一个小的
pub fn build_graph_index<'a>(nodes: &'a [Value], edges: &'a [Value]) -> GraphIndex<'a> {
    let mut labels = HashMap::new();
    for node in nodes {
        if let (Some(id), Some(label)) = (node.get("id").and_then(Value::as_str), node.get("label").and_then(Value::as_str)) {
            // 同一 id 重复出现时沿用先出现的那个，与旧的线性查找结果一致
            labels.entry(id).or_insert(label);
        }
    }
    let mut by_node: HashMap<&str, Vec<&Value>> = HashMap::new();
    for edge in edges {
        let source = edge.get("source").and_then(Value::as_str).unwrap_or("");
        let target = edge.get("target").and_then(Value::as_str).unwrap_or("");
        by_node.entry(source).or_default().push(edge);
        if target != source {
            by_node.entry(target).or_default().push(edge);
        }
    }
    GraphIndex { labels, edges: by_node }
}

/// 单个节点的档案渲染：只有测试用，正式保存走 build_graph_index 共用一份索引
#[cfg(test)]
pub fn graph_node_to_markdown(node: &Value, nodes: &[Value], edges: &[Value]) -> String {
    graph_node_markdown_with_index(node, &build_graph_index(nodes, edges))
}

pub fn graph_node_markdown_with_index(node: &Value, index: &GraphIndex) -> String {
    let id = node.get("id").and_then(Value::as_str).unwrap_or("");
    let title = node.get("label").and_then(Value::as_str).unwrap_or("未命名节点");
    let content = node.get("content").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).unwrap_or("待补充。");
    let status = node.get("status").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).unwrap_or("待补充");
    let mut relation_lines = Vec::new();
    for edge in index.edges.get(id).map(Vec::as_slice).unwrap_or(&[]) {
        let source = edge.get("source").and_then(Value::as_str).unwrap_or("");
        let target = edge.get("target").and_then(Value::as_str).unwrap_or("");
        let other_id = if source == id { target } else { source };
        let other_label = index.labels.get(other_id).copied().unwrap_or(other_id);
        let relation = edge.get("label").and_then(Value::as_str).unwrap_or("关联");
        let direction = if source == id { "指向对方" } else { "来自对方" };
        let weight = edge.get("weight").and_then(Value::as_f64).unwrap_or_else(|| graph_edge_default_weight(relation)).clamp(0.1, 1.0);
        relation_lines.push(format!("- {other_label}｜{relation}｜{direction}｜权重：{weight:.2}"));
    }
    let relation_text = if relation_lines.is_empty() { "- 暂无".to_string() } else { relation_lines.join("\n") };
    format!("# {title}\n\n<!-- Zhizhang Graph Node: {id} -->\n\n## 基础信息\n- 节点类型：{}\n- 当前状态：{status}\n- 来源路径：{}\n\n## 档案内容\n{content}\n\n## 关系网络\n{relation_text}\n", graph_node_type_label(node), graph_node_relative_path(node).to_string_lossy())
}


pub fn safe_folder_name(value: &str) -> String {
    let cleaned: String = value
        .trim()
        .chars()
        .map(|character| {
            if "\\/:*?\"<>|".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(['.', ' ']).trim();
    if cleaned.is_empty() {
        "未命名小说".to_string()
    } else {
        cleaned.to_string()
    }
}


pub fn safe_file_name(value: &str) -> String {
    let name = safe_folder_name(value);
    if name.is_empty() {
        "未命名".to_string()
    } else {
        name
    }
}


pub fn markdown_list(memory: &Value, field: &str) -> String {
    memory
        .get(field)
        .and_then(Value::as_array)
        .map(|items| {
            let rendered = items
                .iter()
                .filter_map(Value::as_str)
                .filter(|item| !item.trim().is_empty())
                .map(|item| format!("- {item}"))
                .collect::<Vec<_>>();
            if rendered.is_empty() { "- 暂无".to_string() } else { rendered.join("\n") }
        })
        .unwrap_or_else(|| "- 暂无".to_string())
}


pub fn chapter_memory_to_markdown(memory: &Value) -> String {
    let title = memory
        .get("chapterTitle")
        .and_then(Value::as_str)
        .unwrap_or("章节记忆");
    let summary = memory.get("summary").and_then(Value::as_str).unwrap_or("暂无摘要");
    let ending_hook = memory.get("endingHook").and_then(Value::as_str).unwrap_or("暂无");
    format!(
        "# {title} 记忆快照\n\n## 章节摘要\n{summary}\n\n## 关键词\n{}\n\n## 人物状态变化\n{}\n\n## 角色认知变化\n{}\n\n## 伏笔变化\n{}\n\n## 时间线事件\n{}\n\n## 设定事实\n{}\n\n## 冲突\n{}\n\n## 章末钩子\n{ending_hook}\n",
        markdown_list(memory, "keywords"),
        markdown_list(memory, "characterStateChanges"),
        markdown_list(memory, "knowledgeChanges"),
        markdown_list(memory, "foreshadowingChanges"),
        markdown_list(memory, "timelineEvents"),
        markdown_list(memory, "canonFacts"),
        markdown_list(memory, "conflicts"),
    )
}


pub fn outline_to_markdown(outline: Option<&Value>) -> String {
    fn visit(nodes: &[Value], output: &mut String, depth: usize) {
        for node in nodes {
            let title = node
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("未命名节点");
            let description = node
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            output.push_str(&format!("{} {}\n", "#".repeat((depth + 1).min(6)), title));
            if !description.is_empty() {
                output.push_str(description);
                output.push_str("\n\n");
            }
            if let Some(children) = node.get("children").and_then(Value::as_array) {
                visit(children, output, depth + 1);
            }
        }
    }

    let mut output = String::from("# 小说大纲\n\n");
    if let Some(nodes) = outline.and_then(Value::as_array) {
        visit(nodes, &mut output, 0);
    }
    output
}

#[cfg(test)]
mod incremental_write_tests {
    use super::{remove_stale_markdown, write_if_changed};
    use std::collections::HashSet;
    use std::fs;

    #[test]
    fn 内容没变不重写_变了才写_被删的文件会补回_旧文件按保留清单清理() {
        let root = std::env::temp_dir().join(format!("zhizhang-incremental-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("a.md");
        assert!(write_if_changed(&path, b"one").unwrap());
        assert!(!write_if_changed(&path, b"one").unwrap(), "内容没变不该再写");
        assert!(write_if_changed(&path, b"two").unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        fs::remove_file(&path).unwrap();
        assert!(write_if_changed(&path, b"two").unwrap(), "文件被外部删掉时要补回");

        let stale = root.join("b.md");
        fs::write(&stale, b"old").unwrap();
        remove_stale_markdown(&root, &HashSet::from([path.clone()])).unwrap();
        assert!(path.exists());
        assert!(!stale.exists(), "不在保留清单里的旧文件要删掉");

        fs::remove_dir_all(&root).ok();
    }
}


