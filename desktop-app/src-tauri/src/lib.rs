mod project_store;
mod github_backup;

mod resource_store;

use github_backup::{backup_project_to_github, load_project_from_github};
#[cfg(test)]
use github_backup::{clone_github_repository, ensure_git_identity, read_github_project, run_git, validate_github_backup_destination, validate_github_repository_url};

use resource_store::{
    delete_dismantle_book, delete_library_book, load_dismantle_books, load_library_books,
    load_ranking_books, load_writing_styles, open_dismantle_location, open_library_book_location,
    save_dismantle_books, save_library_books, save_ranking_books, save_writing_styles,
};

use project_store::{
    app_data_directory, graph_node_relative_path, load_projects, outline_relative_path, save_projects, safe_file_name,
};
#[cfg(test)]
use project_store::{graph_node_profile_from_markdown, graph_node_to_markdown};

use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{Emitter, Manager};

mod runtime;

use runtime::{call_agent_rpc, open_external_url, start_agent_runtime, AgentRuntimeState};

fn bdpan_command() -> Result<Command, String> {
    let mut candidates = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(home).join(".local/bin/bdpan"));
    }
    candidates.push(PathBuf::from("bdpan"));
    for candidate in candidates {
        if candidate.as_os_str() == "bdpan" || candidate.exists() {
            return Ok(Command::new(candidate));
        }
    }
    Err("未找到 bdpan 命令。请先安装百度网盘 Skill 的 CLI 工具。".to_string())
}

fn validate_cloud_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim().trim_matches('/');
    if trimmed.is_empty() || trimmed.contains("..") || trimmed.starts_with('~') || trimmed.starts_with('.') {
        return Err("云端路径无效，只能使用 /apps/bdpan/ 下的相对路径".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_cloud_backup_path(remote_path: &str, backup_path: &str) -> Result<String, String> {
    let base = validate_cloud_path(remote_path)?;
    let normalized = backup_path.trim().replace('\\', "/").trim_matches('/').to_string();
    let relative = normalized.strip_prefix("apps/bdpan/").unwrap_or(&normalized);
    let prefix = format!("{base}/");
    let file_name = relative.strip_prefix(&prefix).ok_or_else(|| "所选备份文件不在当前云端备份目录中".to_string())?;
    if file_name.is_empty() || file_name.contains('/') || file_name.contains("..") || !has_backup_extension(file_name) {
        return Err("所选云端文件不是有效的织章备份包".to_string());
    }
    validate_cloud_path(relative)
}

fn run_bdpan(args: &[&str]) -> Result<String, String> {
    run_bdpan_at(args, None)
}

fn run_bdpan_at(args: &[&str], working_directory: Option<&Path>) -> Result<String, String> {
    let mut command = bdpan_command()?;
    if let Some(directory) = working_directory {
        command.current_dir(directory);
    }
    let output = command
        .args(args)
        .output()
        .map_err(|error| format!("启动百度网盘工具失败: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if !stderr.is_empty() { stderr } else if !stdout.is_empty() { stdout } else { format!("bdpan 退出码 {}", output.status) });
    }
    Ok(if !stdout.is_empty() { stdout } else { stderr })
}

fn copy_directory_contents(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("创建恢复目录失败: {error}"))?;
    let entries = fs::read_dir(source).map_err(|error| format!("读取云端恢复目录失败: {error}"))?;
    for entry in entries.filter_map(Result::ok) {
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory_contents(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path).map_err(|error| format!("恢复文件失败: {error}"))?;
        }
    }
    Ok(())
}

pub(crate) fn copy_cloud_backup_contents(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("创建备份目录失败: {error}"))?;
    let entries = fs::read_dir(source).map_err(|error| format!("读取待备份目录失败: {error}"))?;
    for entry in entries.filter_map(Result::ok) {
        let file_name = entry.file_name();
        if file_name.to_string_lossy().starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| format!("读取备份文件类型失败: {error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let source_path = entry.path();
        let target_path = target.join(file_name);
        if file_type.is_dir() {
            copy_cloud_backup_contents(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path).map_err(|error| format!("备份文件失败: {error}"))?;
        }
    }
    Ok(())
}

const CLOUD_BACKUP_DIRECTORIES: [&str; 6] = ["projects", "books", "dismantles", "rankings", "styles", "agent-chats"];
const CLOUD_BACKUP_BUNDLE_NAME: &str = "Zhizhang-backup.zzbackup";
const CLOUD_BACKUP_MAGIC: &[u8] = b"ZZBACKUP\x01";
/// 改名前写出的备份包标识；只用于读取，不再写出
const LEGACY_CLOUD_BACKUP_MAGIC: &[u8] = b"ASWBACKUP\x01";
/// 两种扩展名都要能恢复，否则改名当天用户手上的备份全部作废
const BACKUP_EXTENSIONS: [&str; 2] = ["zzbackup", "aswbackup"];

fn has_backup_extension(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    BACKUP_EXTENSIONS.iter().any(|extension| lowered.ends_with(&format!(".{extension}")))
}

fn cloud_export_directory(app_data: &Path) -> PathBuf {
    app_data.join("cloud-export")
}

fn create_cloud_export(app_data: &Path, client_state: &Value) -> Result<PathBuf, String> {
    let export_root = cloud_export_directory(app_data);
    if export_root.exists() {
        fs::remove_dir_all(&export_root).map_err(|error| format!("清理旧备份缓存失败: {error}"))?;
    }
    fs::create_dir_all(&export_root).map_err(|error| format!("创建备份缓存失败: {error}"))?;
    for directory in CLOUD_BACKUP_DIRECTORIES {
        let source = app_data.join(directory);
        if source.exists() {
            copy_cloud_backup_contents(&source, &export_root.join(directory))?;
        }
    }
    let legacy_projects = app_data.join("projects.json");
    if legacy_projects.exists() {
        fs::copy(&legacy_projects, export_root.join("projects.json")).map_err(|error| format!("备份旧项目数据失败: {error}"))?;
    }
    let state = serde_json::to_vec_pretty(client_state).map_err(|error| format!("序列化本地设置失败: {error}"))?;
    fs::write(export_root.join("client-state.json"), state).map_err(|error| format!("写入本地设置备份失败: {error}"))?;
    Ok(export_root)
}

fn collect_cloud_backup_files(root: &Path, current: &Path, files: &mut Vec<(PathBuf, PathBuf)>) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|error| format!("读取备份包目录失败: {error}"))?;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| format!("读取备份包文件类型失败: {error}"))?;
        if file_type.is_dir() {
            collect_cloud_backup_files(root, &path, files)?;
        } else if file_type.is_file() {
            let relative = path.strip_prefix(root).map_err(|error| format!("计算备份相对路径失败: {error}"))?.to_path_buf();
            files.push((relative, path));
        }
    }
    Ok(())
}

fn write_cloud_backup_bundle(export_root: &Path, bundle_path: &Path) -> Result<u64, String> {
    let mut files = Vec::new();
    collect_cloud_backup_files(export_root, export_root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));

    let bundle_file = fs::File::create(bundle_path).map_err(|error| format!("创建完整备份包失败: {error}"))?;
    let mut bundle = GzEncoder::new(bundle_file, Compression::best());
    bundle.write_all(CLOUD_BACKUP_MAGIC).map_err(|error| format!("写入备份包标识失败: {error}"))?;
    bundle.write_all(&(files.len() as u64).to_le_bytes()).map_err(|error| format!("写入备份包索引失败: {error}"))?;

    for (relative, source) in files {
        let relative = relative.to_string_lossy().replace('\\', "/");
        let path_bytes = relative.as_bytes();
        let path_length = u32::try_from(path_bytes.len()).map_err(|_| "备份文件路径过长".to_string())?;
        let file_size = fs::metadata(&source).map_err(|error| format!("读取备份文件大小失败: {error}"))?.len();
        bundle.write_all(&path_length.to_le_bytes()).map_err(|error| format!("写入备份路径失败: {error}"))?;
        bundle.write_all(&file_size.to_le_bytes()).map_err(|error| format!("写入备份文件索引失败: {error}"))?;
        bundle.write_all(path_bytes).map_err(|error| format!("写入备份路径内容失败: {error}"))?;
        let mut input = fs::File::open(&source).map_err(|error| format!("打开备份文件失败: {error}"))?;
        std::io::copy(&mut input, &mut bundle).map_err(|error| format!("写入备份文件内容失败: {error}"))?;
    }
    bundle.flush().map_err(|error| format!("保存完整备份包失败: {error}"))?;
    let bundle_file = bundle.finish().map_err(|error| format!("完成备份包压缩失败: {error}"))?;
    bundle_file.sync_all().map_err(|error| format!("保存压缩备份包失败: {error}"))?;
    fs::metadata(bundle_path).map(|metadata| metadata.len()).map_err(|error| format!("读取完整备份包失败: {error}"))
}

fn read_bundle_number<const N: usize>(bundle: &mut dyn Read, label: &str) -> Result<[u8; N], String> {
    let mut bytes = [0_u8; N];
    bundle.read_exact(&mut bytes).map_err(|error| format!("读取备份包{label}失败: {error}"))?;
    Ok(bytes)
}

fn safe_bundle_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty() || path.is_absolute() || path.components().any(|component| !matches!(component, Component::Normal(_))) {
        return Err(format!("备份包包含不安全路径: {value}"));
    }
    Ok(path.to_path_buf())
}

fn extract_cloud_backup_bundle(bundle_path: &Path, export_root: &Path) -> Result<u64, String> {
    if export_root.exists() {
        fs::remove_dir_all(export_root).map_err(|error| format!("清理恢复解包目录失败: {error}"))?;
    }
    fs::create_dir_all(export_root).map_err(|error| format!("创建恢复解包目录失败: {error}"))?;
    let mut preview = fs::File::open(bundle_path).map_err(|error| format!("打开云端备份包失败: {error}"))?;
    let mut signature = [0_u8; 2];
    preview.read_exact(&mut signature).map_err(|error| format!("读取云端备份包格式失败: {error}"))?;
    let input = fs::File::open(bundle_path).map_err(|error| format!("重新打开云端备份包失败: {error}"))?;
    let mut bundle: Box<dyn Read> = if signature == [0x1f, 0x8b] {
        Box::new(GzDecoder::new(input))
    } else {
        Box::new(input)
    };
    let mut magic = vec![0_u8; CLOUD_BACKUP_MAGIC.len()];
    bundle.read_exact(&mut magic).map_err(|error| format!("读取云端备份包标识失败: {error}"))?;
    if magic != CLOUD_BACKUP_MAGIC && magic != LEGACY_CLOUD_BACKUP_MAGIC {
        return Err("云端文件不是有效的织章完整备份包".to_string());
    }
    let file_count = u64::from_le_bytes(read_bundle_number::<8>(&mut *bundle, "文件数量")?);
    if file_count > 1_000_000 {
        return Err("云端备份包文件数量异常".to_string());
    }

    for _ in 0..file_count {
        let path_length = u32::from_le_bytes(read_bundle_number::<4>(&mut *bundle, "路径长度")?) as usize;
        let file_size = u64::from_le_bytes(read_bundle_number::<8>(&mut *bundle, "文件大小")?);
        if path_length == 0 || path_length > 1_048_576 {
            return Err("云端备份包路径长度异常".to_string());
        }
        let mut path_bytes = vec![0_u8; path_length];
        bundle.read_exact(&mut path_bytes).map_err(|error| format!("读取备份文件路径失败: {error}"))?;
        let relative_text = String::from_utf8(path_bytes).map_err(|error| format!("备份文件路径编码错误: {error}"))?;
        let relative = safe_bundle_relative_path(&relative_text)?;
        let destination = export_root.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建恢复文件目录失败: {error}"))?;
        }
        let mut output = fs::File::create(&destination).map_err(|error| format!("创建恢复文件失败: {error}"))?;
        let copied = std::io::copy(&mut (&mut *bundle).take(file_size), &mut output).map_err(|error| format!("解包恢复文件失败: {error}"))?;
        if copied != file_size {
            return Err(format!("云端备份包内容不完整: {relative_text}"));
        }
    }
    Ok(file_count)
}

fn find_cloud_export(root: &Path, depth: usize) -> Option<PathBuf> {
    if root.join("client-state.json").exists() {
        return Some(root.to_path_buf());
    }
    if depth == 0 { return None; }
    fs::read_dir(root).ok()?.filter_map(Result::ok).find_map(|entry| {
        let path = entry.path();
        path.is_dir().then(|| find_cloud_export(&path, depth - 1)).flatten()
    })
}

fn replace_cloud_data(app_data: &Path, export_root: &Path) -> Result<(), String> {
    for directory in CLOUD_BACKUP_DIRECTORIES {
        let source = export_root.join(directory);
        let target = app_data.join(directory);
        if target.exists() {
            fs::remove_dir_all(&target).map_err(|error| format!("清理本地 {directory} 数据失败: {error}"))?;
        }
        if source.exists() {
            copy_directory_contents(&source, &target)?;
        }
    }
    let source_legacy = export_root.join("projects.json");
    let target_legacy = app_data.join("projects.json");
    if source_legacy.exists() {
        fs::copy(source_legacy, target_legacy).map_err(|error| format!("恢复旧项目数据失败: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn cloud_sync_status() -> Result<Value, String> {
    let output = run_bdpan(&["whoami", "--json"])?;
    let parsed = serde_json::from_str::<Value>(&output).unwrap_or_else(|_| serde_json::json!({ "raw": output }));
    Ok(parsed)
}

#[tauri::command]
fn baidu_login_url() -> Result<String, String> {
    run_bdpan(&["login", "--get-auth-url", "--accept-disclaimer"])
}

#[tauri::command]
fn complete_baidu_login(code: String) -> Result<Value, String> {
    let code = code.trim();
    if code.len() != 32 || !code.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("授权码格式无效，请粘贴百度网盘页面返回的 32 位授权码".to_string());
    }
    let mut command = bdpan_command()?;
    let mut child = command
        .args(["login", "--set-code-stdin", "--accept-disclaimer"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动百度网盘登录失败: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(format!("{code}\n").as_bytes()).map_err(|error| format!("提交授权码失败: {error}"))?;
    }
    let output = child.wait_with_output().map_err(|error| format!("等待登录结果失败: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(if stderr.trim().is_empty() { "百度网盘授权失败，请重新获取授权链接后再试。".to_string() } else { stderr.trim().to_string() });
    }
    let status = cloud_sync_status()?;
    Ok(status)
}

#[tauri::command]
async fn backup_projects_to_baidu(app: tauri::AppHandle, remote_path: String, client_state: Value) -> Result<Value, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || backup_projects_to_baidu_blocking(handle, remote_path, client_state))
        .await
        .map_err(|error| format!("云端备份任务中断: {error}"))?
}

fn backup_projects_to_baidu_blocking(app: tauri::AppHandle, remote_path: String, client_state: Value) -> Result<Value, String> {
    let remote_path = validate_cloud_path(&remote_path)?;
    let _ = app.emit("cloud-sync-progress", serde_json::json!({ "action": "backup", "stage": "prepare", "message": "正在整理小说、书籍、拆书、扫榜与本机设置..." }));
    let app_data = app_data_directory(&app)?;
    let export_root = create_cloud_export(&app_data, &client_state)?;
    let bundle_path = app_data.join(CLOUD_BACKUP_BUNDLE_NAME);
    if bundle_path.exists() {
        fs::remove_file(&bundle_path).map_err(|error| format!("清理旧完整备份包失败: {error}"))?;
    }
    let bundle_size = write_cloud_backup_bundle(&export_root, &bundle_path)?;
    let remote_target = format!("{remote_path}/{CLOUD_BACKUP_BUNDLE_NAME}");
    let _ = run_bdpan(&["mkdir", &remote_path]);
    let _ = app.emit("cloud-sync-progress", serde_json::json!({ "action": "backup", "stage": "upload", "message": format!("完整备份包已生成（{:.1} MB），正在后台上传到百度网盘...", bundle_size as f64 / 1_048_576.0) }));
    let output = run_bdpan_at(&["upload", CLOUD_BACKUP_BUNDLE_NAME, &remote_target], Some(&app_data))?;
    fs::remove_dir_all(&export_root).ok();
    fs::remove_file(&bundle_path).ok();
    let _ = app.emit("cloud-sync-progress", serde_json::json!({ "action": "backup", "stage": "done", "message": "完整备份已上传到百度网盘。" }));
    Ok(serde_json::json!({ "remotePath": remote_path, "remoteFile": remote_target, "message": output, "size": bundle_size, "scope": "projects, books, dismantles, rankings, styles, client-state" }))
}

#[tauri::command]
fn list_baidu_backups(remote_path: String) -> Result<Value, String> {
    let remote_path = validate_cloud_path(&remote_path)?;
    let output = run_bdpan(&["ls", &remote_path, "--json", "--order", "time", "--desc", "--limit", "1000"])?;
    let parsed: Value = serde_json::from_str(&output).map_err(|error| format!("百度网盘备份列表格式错误: {error}"))?;
    let entries = parsed.as_array().cloned().or_else(|| parsed.get("list").and_then(Value::as_array).cloned()).unwrap_or_default();
    let prefix = format!("/apps/bdpan/{remote_path}/");
    let files = entries.into_iter().filter_map(|entry| {
        if entry.get("isdir").and_then(Value::as_bool).unwrap_or(false) || entry.get("isdir").and_then(Value::as_i64).unwrap_or(0) != 0 {
            return None;
        }
        let path = entry.get("path").and_then(Value::as_str).unwrap_or_default();
        let name = entry.get("server_filename").and_then(Value::as_str)
            .or_else(|| entry.get("name").and_then(Value::as_str))
            .or_else(|| path.rsplit('/').next())
            .unwrap_or_default();
        if !path.starts_with(&prefix) || path[prefix.len()..].contains('/') || !has_backup_extension(name) {
            return None;
        }
        let relative_path = format!("{remote_path}/{name}");
        Some(serde_json::json!({
            "name": name,
            "path": relative_path,
            "fsId": entry.get("fs_id").map(|value| value.to_string().trim_matches('"').to_string()),
            "size": entry.get("size").and_then(Value::as_u64).unwrap_or(0),
            "modifiedAt": entry.get("server_mtime").and_then(Value::as_str).or_else(|| entry.get("server_ctime").and_then(Value::as_str)).unwrap_or_default(),
            "isBundle": true,
            "source": "bundle"
        }))
    }).collect::<Vec<_>>();
    Ok(serde_json::json!({ "files": files }))
}

#[tauri::command]
async fn restore_projects_from_baidu(app: tauri::AppHandle, remote_path: String, backup_path: Option<String>, backup_fs_id: Option<String>) -> Result<Value, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || restore_projects_from_baidu_blocking(handle, remote_path, backup_path, backup_fs_id))
        .await
        .map_err(|error| format!("云端恢复任务中断: {error}"))?
}

fn restore_projects_from_baidu_blocking(app: tauri::AppHandle, remote_path: String, backup_path: Option<String>, _backup_fs_id: Option<String>) -> Result<Value, String> {
    let remote_path = validate_cloud_path(&remote_path)?;
    let app_data = app_data_directory(&app)?;
    let _ = app.emit("cloud-sync-progress", serde_json::json!({ "action": "restore", "stage": "download", "message": "正在后台下载完整应用备份..." }));
    let restore_root = app_data.join(".cloud-restore");
    if restore_root.exists() {
        fs::remove_dir_all(&restore_root).map_err(|error| format!("清理上次恢复缓存失败: {error}"))?;
    }
    fs::create_dir_all(&restore_root).map_err(|error| format!("创建恢复缓存失败: {error}"))?;
    let selected_bundle = backup_path.as_deref().map(|path| validate_cloud_backup_path(&remote_path, path)).transpose()?;
    if backup_path.is_some() && selected_bundle.is_none() {
        return Err("请先选择要恢复的云端备份文件".to_string());
    }
    let remote_bundle = selected_bundle.clone().unwrap_or_else(|| format!("{remote_path}/{CLOUD_BACKUP_BUNDLE_NAME}"));
    let local_bundle = restore_root.join(CLOUD_BACKUP_BUNDLE_NAME);
    let local_bundle_text = format!(".cloud-restore/{CLOUD_BACKUP_BUNDLE_NAME}");
    let (output, export_root) = match run_bdpan_at(&["download", &remote_bundle, &local_bundle_text], Some(&app_data)) {
        Ok(output) => {
            let export_root = restore_root.join("cloud-export");
            extract_cloud_backup_bundle(&local_bundle, &export_root)?;
            (output, export_root)
        }
        Err(bundle_error) if backup_path.is_none() => {
            let output = run_bdpan_at(&["download", &remote_path, "cloud-restore"], Some(&app_data))
                .map_err(|legacy_error| format!("下载完整备份包失败: {bundle_error}\n兼容旧版目录备份也失败: {legacy_error}"))?;
            let export_root = find_cloud_export(&restore_root, 4)
                .ok_or_else(|| "云端下载完成，但没有找到完整应用备份。请确认云端目录包含有效备份。".to_string())?;
            (output, export_root)
        }
        Err(bundle_error) => return Err(format!("下载所选备份包失败: {bundle_error}")),
    };
    let client_state: Value = serde_json::from_str(&fs::read_to_string(export_root.join("client-state.json")).map_err(|error| format!("读取云端设置失败: {error}"))?)
        .map_err(|error| format!("云端设置格式错误: {error}"))?;
    let _ = app.emit("cloud-sync-progress", serde_json::json!({ "action": "restore", "stage": "apply", "message": "下载完成，正在恢复小说与本机配置..." }));
    replace_cloud_data(&app_data, &export_root)?;
    fs::remove_dir_all(&restore_root).ok();
    let _ = app.emit("cloud-sync-progress", serde_json::json!({ "action": "restore", "stage": "done", "message": "完整应用数据已恢复，正在重新载入。" }));
    Ok(serde_json::json!({ "remotePath": remote_path, "backupPath": remote_bundle, "message": output, "reloaded": true, "clientState": client_state }))
}

fn validate_agent_chat_id(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 120
        || !trimmed.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(format!("{label}格式无效"));
    }
    Ok(trimmed.to_string())
}

/// 导出目标目录：优先系统下载目录，其次文档目录，最后回退应用数据目录。
/// ponytail: 固定写入下载目录并「打开位置」，不引入文件选择器插件；需要任意路径时再加 tauri-plugin-dialog
fn export_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let target = app
        .path()
        .download_dir()
        .or_else(|_| app.path().document_dir())
        .or_else(|_| app_data_directory(app))
        .map_err(|error| format!("无法确定导出目录: {error}"))?
        .join("织章导出");
    fs::create_dir_all(&target).map_err(|error| format!("创建导出目录失败: {error}"))?;
    Ok(target)
}

/// 校验前端传入的文件名，禁止路径穿越和目录分隔符。
fn validate_export_file_name(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 200 {
        return Err("导出文件名长度无效".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err("导出文件名包含非法路径字符".to_string());
    }
    if !matches!(Path::new(trimmed).extension().and_then(|value| value.to_str()), Some("txt" | "md")) {
        return Err("导出只支持 .txt 与 .md".to_string());
    }
    Ok(safe_file_name(trimmed))
}

/// 把正文导出为本地 txt/md 文件，写入后在文件管理器中选中。
#[tauri::command]
fn export_text_file(app: tauri::AppHandle, file_name: String, content: String) -> Result<String, String> {
    let file_name = validate_export_file_name(&file_name)?;
    let path = export_directory(&app)?.join(&file_name);
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, content.as_bytes()).map_err(|error| format!("写入导出文件失败: {error}"))?;
    fs::rename(&temporary, &path).map_err(|error| format!("保存导出文件失败: {error}"))?;
    reveal_location(&path).ok();
    Ok(path.to_string_lossy().into_owned())
}

/// 把完整备份包导出到本地，不经过任何云服务。复用云备份的打包逻辑，格式与云端一致，可直接用于恢复。
#[tauri::command]
fn export_backup_bundle(app: tauri::AppHandle, client_state: Value) -> Result<Value, String> {
    let app_data = app_data_directory(&app)?;
    let export_root = create_cloud_export(&app_data, &client_state)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("读取系统时间失败: {error}"))?
        .as_secs();
    let bundle_path = export_directory(&app)?.join(format!("Zhizhang-{stamp}.zzbackup"));
    let size = write_cloud_backup_bundle(&export_root, &bundle_path);
    fs::remove_dir_all(&export_root).ok();
    let size = size?;
    reveal_location(&bundle_path).ok();
    Ok(serde_json::json!({ "path": bundle_path.to_string_lossy(), "size": size }))
}

/// 列出导出目录里的本地备份包，供恢复时选择。
#[tauri::command]
fn list_local_backups(app: tauri::AppHandle) -> Result<Value, String> {
    let directory = export_directory(&app)?;
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(&directory) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.file_name().and_then(|value| value.to_str()).is_some_and(has_backup_extension) {
                continue;
            }
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs())
                .unwrap_or(0);
            files.push(serde_json::json!({
                "name": path.file_name().unwrap_or_default().to_string_lossy(),
                "size": metadata.len(),
                "modifiedAt": modified,
            }));
        }
    }
    files.sort_by(|left, right| right["modifiedAt"].as_u64().cmp(&left["modifiedAt"].as_u64()));
    Ok(serde_json::json!({ "directory": directory.to_string_lossy(), "files": files }))
}

/// 从本地备份包恢复，与云端恢复共用解包与替换逻辑。只接受导出目录内的文件名，避免任意路径读取。
#[tauri::command]
fn restore_backup_bundle(app: tauri::AppHandle, file_name: String) -> Result<Value, String> {
    let trimmed = file_name.trim();
    if trimmed.is_empty()
        || trimmed.len() > 200
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || !has_backup_extension(trimmed)
    {
        return Err("备份文件名无效".to_string());
    }
    let bundle = export_directory(&app)?.join(safe_file_name(trimmed));
    if !bundle.is_file() {
        return Err("找不到所选备份包文件".to_string());
    }
    let app_data = app_data_directory(&app)?;
    let restore_root = app_data.join(".local-restore");
    if restore_root.exists() {
        fs::remove_dir_all(&restore_root).map_err(|error| format!("清理上次恢复缓存失败: {error}"))?;
    }
    let export_root = restore_root.join("cloud-export");
    extract_cloud_backup_bundle(&bundle, &export_root)?;
    let client_state: Value = serde_json::from_str(
        &fs::read_to_string(export_root.join("client-state.json"))
            .map_err(|error| format!("读取备份内设置失败: {error}"))?,
    )
    .map_err(|error| format!("备份内设置格式错误: {error}"))?;
    replace_cloud_data(&app_data, &export_root)?;
    fs::remove_dir_all(&restore_root).ok();
    Ok(serde_json::json!({ "reloaded": true, "clientState": client_state }))
}

#[tauri::command]
fn load_agent_chat(app: tauri::AppHandle, project_id: String, session_id: String) -> Result<Option<Value>, String> {
    let project_id = validate_agent_chat_id(&project_id, "小说 ID")?;
    let session_id = validate_agent_chat_id(&session_id, "会话 ID")?;
    let path = app_data_directory(&app)?.join("agent-chats").join(project_id).join(format!("{session_id}.json"));
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(path).map_err(|error| format!("读取项目 Agent 会话失败: {error}"))?;
    serde_json::from_str(&content).map(Some).map_err(|error| format!("项目 Agent 会话格式错误: {error}"))
}

#[tauri::command]
fn save_agent_chat(app: tauri::AppHandle, project_id: String, session_id: String, session: Value) -> Result<String, String> {
    let project_id = validate_agent_chat_id(&project_id, "小说 ID")?;
    let session_id = validate_agent_chat_id(&session_id, "会话 ID")?;
    if !session.is_object() {
        return Err("项目 Agent 会话必须是对象".to_string());
    }
    let directory = app_data_directory(&app)?.join("agent-chats").join(project_id);
    fs::create_dir_all(&directory).map_err(|error| format!("创建项目 Agent 会话目录失败: {error}"))?;
    let path = directory.join(format!("{session_id}.json"));
    let temporary = directory.join(format!("{session_id}.tmp"));
    fs::write(&temporary, serde_json::to_vec_pretty(&session).map_err(|error| format!("序列化项目 Agent 会话失败: {error}"))?)
        .map_err(|error| format!("写入项目 Agent 会话失败: {error}"))?;
    // Windows 上 fs::rename 会直接替换已存在的目标文件，先删除反而会多出一个文件缺失的窗口
    fs::rename(&temporary, &path).map_err(|error| format!("保存项目 Agent 会话失败: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

// 百度网盘备份实际走前端 HTTP 备份包（platform.ts），Rust 的目录打包只用于本地导出，
// 所以会话文件需要单独导出成一个 JSON 挂进 clientState 才能真正备份到云端
#[tauri::command]
fn export_agent_chats(app: tauri::AppHandle) -> Result<Value, String> {
    let root = app_data_directory(&app)?.join("agent-chats");
    let mut sessions = serde_json::Map::new();
    if !root.exists() {
        return Ok(Value::Object(sessions));
    }
    for project in fs::read_dir(&root).map_err(|error| format!("读取 Agent 会话目录失败: {error}"))? {
        let project = project.map_err(|error| format!("读取 Agent 会话目录失败: {error}"))?;
        if !project.path().is_dir() {
            continue;
        }
        let mut files = serde_json::Map::new();
        for entry in fs::read_dir(project.path()).map_err(|error| format!("读取 Agent 会话失败: {error}"))? {
            let path = entry.map_err(|error| format!("读取 Agent 会话失败: {error}"))?.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let name = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
            let content = fs::read_to_string(&path).map_err(|error| format!("读取 Agent 会话失败: {error}"))?;
            // 单个会话损坏不应该拖垮整次备份
            if let Ok(value) = serde_json::from_str::<Value>(&content) {
                files.insert(name, value);
            }
        }
        if !files.is_empty() {
            sessions.insert(project.file_name().to_string_lossy().into_owned(), Value::Object(files));
        }
    }
    Ok(Value::Object(sessions))
}

#[tauri::command]
fn import_agent_chats(app: tauri::AppHandle, sessions: Value) -> Result<usize, String> {
    let projects = sessions.as_object().ok_or_else(|| "Agent 会话备份格式无效".to_string())?;
    let root = app_data_directory(&app)?.join("agent-chats");
    let mut restored = 0usize;
    for (project_id, files) in projects {
        let project_id = validate_agent_chat_id(project_id, "小说 ID")?;
        let Some(files) = files.as_object() else {
            continue;
        };
        let directory = root.join(&project_id);
        fs::create_dir_all(&directory).map_err(|error| format!("创建 Agent 会话目录失败: {error}"))?;
        for (session_id, session) in files {
            let session_id = validate_agent_chat_id(session_id, "会话 ID")?;
            let bytes = serde_json::to_vec_pretty(session).map_err(|error| format!("序列化 Agent 会话失败: {error}"))?;
            fs::write(directory.join(format!("{session_id}.json")), bytes).map_err(|error| format!("写入 Agent 会话失败: {error}"))?;
            restored += 1;
        }
    }
    Ok(restored)
}

#[tauri::command]
fn projects_storage_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app_data_directory(&app)?
        .join("projects")
        .to_string_lossy()
        .into_owned())
}

pub(crate) fn find_project_directory(app: &tauri::AppHandle, project_id: i64) -> Result<PathBuf, String> {
    let root = app_data_directory(app)?.join("projects");
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
        {
            let metadata_path = entry.path().join("metadata.json");
            if let Ok(content) = fs::read_to_string(metadata_path) {
                if serde_json::from_str::<Value>(&content)
                    .ok()
                    .and_then(|value| value.get("id").and_then(Value::as_i64))
                    == Some(project_id)
                {
                    return Ok(entry.path());
                }
            }
        }
    }
    Err("找不到这本小说的本地目录".to_string())
}

fn reveal_location(path: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    Command::new("open")
        .args(["-R"])
        .arg(path)
        .status()
        .map_err(|error| format!("打开文件位置失败: {error}"))?;
    #[cfg(target_os = "windows")]
    Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .status()
        .map_err(|error| format!("打开文件位置失败: {error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(path.parent().unwrap_or(path))
        .status()
        .map_err(|error| format!("打开文件位置失败: {error}"))?;
    Ok(())
}

#[tauri::command]
fn open_project_location(app: tauri::AppHandle, project_id: i64) -> Result<String, String> {
    let target = find_project_directory(&app, project_id)?;
    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg(&target)
        .status()
        .map_err(|error| format!("打开文件夹失败: {error}"))?;
    #[cfg(target_os = "windows")]
    Command::new("explorer")
        .arg(&target)
        .status()
        .map_err(|error| format!("打开文件夹失败: {error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(&target)
        .status()
        .map_err(|error| format!("打开文件夹失败: {error}"))?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_chapter_location(
    app: tauri::AppHandle,
    project_id: i64,
    chapter_title: String,
) -> Result<String, String> {
    let path = find_project_directory(&app, project_id)?
        .join("章节")
        .join(format!("{}.md", safe_file_name(&chapter_title)));
    if !path.exists() {
        return Err("章节 Markdown 尚未保存，请稍后再试".to_string());
    }
    reveal_location(&path)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_outline_location(
    app: tauri::AppHandle,
    project_id: i64,
    outline_title: Option<String>,
    outline_folder: Option<String>,
) -> Result<String, String> {
    let title = outline_title.unwrap_or_else(|| "大纲".to_string());
    // 大纲可能落在子目录里，定位时要把目录一并拼上
    let path = find_project_directory(&app, project_id)?
        .join("大纲")
        .join(outline_relative_path(outline_folder.as_deref(), &title));
    if !path.exists() {
        return Err("大纲 Markdown 尚未保存，请稍后再试".to_string());
    }
    reveal_location(&path)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_card_location(
    app: tauri::AppHandle,
    project_id: i64,
    card_type: String,
    card_title: String,
) -> Result<String, String> {
    let path = find_project_directory(&app, project_id)?
        .join("卡片")
        .join(safe_file_name(&card_type))
        .join(format!("{}.md", safe_file_name(&card_title)));
    if !path.exists() {
        return Err("卡片 Markdown 尚未保存，请稍后再试".to_string());
    }
    reveal_location(&path)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_graph_node_location(
    app: tauri::AppHandle,
    project_id: i64,
    node_id: String,
) -> Result<String, String> {
    let project_dir = find_project_directory(&app, project_id)?;
    let metadata: Value = serde_json::from_str(&fs::read_to_string(project_dir.join("metadata.json"))
        .map_err(|error| format!("读取图谱索引失败: {error}"))?)
        .map_err(|error| format!("图谱索引格式错误: {error}"))?;
    let node = metadata.get("graphNodes").and_then(Value::as_array)
        .and_then(|nodes| nodes.iter().find(|node| node.get("id").and_then(Value::as_str) == Some(node_id.as_str())))
        .ok_or_else(|| "找不到图谱节点档案".to_string())?;
    let relative_path = node.get("sourcePath").and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| graph_node_relative_path(node));
    let path = project_dir.join(relative_path);
    if !path.exists() {
        return Err("图谱档案尚未保存，请稍后再试".to_string());
    }
    reveal_location(&path)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn detect_system_proxy() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("scutil").arg("--proxy").output() {
            let text = String::from_utf8_lossy(&output.stdout);
            let mut http_enabled = false;
            let mut https_enabled = false;
            let mut host = String::new();
            let mut port = String::new();
            for line in text.lines() {
                let mut parts = line.splitn(2, ':').map(str::trim);
                let key = parts.next().unwrap_or_default();
                let value = parts.next().unwrap_or_default();
                match key {
                    "HTTPEnable" => http_enabled = value == "1",
                    "HTTPSEnable" => https_enabled = value == "1",
                    "HTTPProxy" | "HTTPSProxy" if host.is_empty() => host = value.to_string(),
                    "HTTPPort" | "HTTPSPort" if port.is_empty() => port = value.to_string(),
                    _ => {}
                }
            }
            if (http_enabled || https_enabled) && !host.is_empty() && !port.is_empty() {
                return Ok(Some(format!("http://{host}:{port}")));
            }
        }
    }
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                return Ok(Some(value.trim().to_string()));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn github_repository_url_only_accepts_owner_and_repository() {
        assert_eq!(
            validate_github_repository_url("https://github.com/example/novel.git").unwrap(),
            "https://github.com/example/novel.git"
        );
        assert_eq!(
            validate_github_repository_url("git@github.com:example/novel.git").unwrap(),
            "git@github.com:example/novel.git"
        );
        assert!(validate_github_repository_url("https://gitlab.com/example/novel.git").is_err());
        assert!(validate_github_repository_url("https://github.com/example").is_err());
        assert!(validate_github_repository_url("https://github.com/example/../secret.git").is_err());
        assert!(validate_github_repository_url("https://token@github.com/example/novel.git").is_err());
    }

    #[test]
    fn github_project_repository_round_trip_uses_real_git() {
        let root = std::env::temp_dir().join(format!(
            "zhizhang-git-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let bare = root.join("remote.git");
        fs::create_dir_all(&root).unwrap();
        let bare_text = bare.to_string_lossy().into_owned();
        run_git(&["init", "--bare", &bare_text], None).unwrap();

        let checkout = clone_github_repository(&root, &bare_text, "write-cache").unwrap();
        validate_github_backup_destination(&checkout, 42, "测试小说").unwrap();
        let project = json!({ "id": 42, "title": "测试小说", "chapters": [{ "id": 1, "title": "第一章", "content": "正文" }] });
        fs::write(checkout.join(".zhizhang-project.json"), serde_json::to_vec_pretty(&json!({
            "kind": "zhizhang-project", "schemaVersion": 1, "projectId": 42, "title": "测试小说"
        })).unwrap()).unwrap();
        fs::write(checkout.join("project.json"), serde_json::to_vec_pretty(&project).unwrap()).unwrap();
        ensure_git_identity(&checkout).unwrap();
        run_git(&["add", "--all"], Some(&checkout)).unwrap();
        run_git(&["commit", "-m", "测试备份"], Some(&checkout)).unwrap();
        run_git(&["push", "--set-upstream", "origin", "HEAD"], Some(&checkout)).unwrap();

        let restored_checkout = clone_github_repository(&root, &bare_text, "read-cache").unwrap();
        assert_eq!(read_github_project(&restored_checkout).unwrap(), project);
        validate_github_backup_destination(&restored_checkout, 42, "测试小说").unwrap();
        assert!(validate_github_backup_destination(&restored_checkout, 99, "另一本小说").is_err());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn selected_cloud_backup_must_stay_in_configured_directory() {
        assert_eq!(
            validate_cloud_backup_path(
                "Zhizhang/backup",
                "/apps/bdpan/Zhizhang/backup/Zhizhang-backup-2026-08-18.zzbackup"
            ).unwrap(),
            "Zhizhang/backup/Zhizhang-backup-2026-08-18.zzbackup"
        );
        assert!(validate_cloud_backup_path("Zhizhang/backup", "Zhizhang/other/backup.zzbackup").is_err());
        assert!(validate_cloud_backup_path("Zhizhang/backup", "Zhizhang/backup/../secret.zzbackup").is_err());
        assert!(validate_cloud_backup_path("Zhizhang/backup", "Zhizhang/backup/client-state.json").is_err());
    }

    #[test]
    fn cloud_backup_bundle_round_trip_supports_novel_paths() {
        let root = std::env::temp_dir().join(format!(
            "zhizhang-backup-test-{}",
            std::process::id()
        ));
        let source = root.join("source");
        let restored = root.join("restored");
        let chapter = source.join("projects/测试小说/章节/第 1 章 F级？可我隐藏天赋是SSS啊？.md");
        fs::create_dir_all(chapter.parent().unwrap()).unwrap();
        fs::write(&chapter, "第一章正文\n完整内容").unwrap();
        fs::write(source.join("client-state.json"), "{\"theme\":\"light\"}").unwrap();
        let bundle = root.join(CLOUD_BACKUP_BUNDLE_NAME);

        let size = write_cloud_backup_bundle(&source, &bundle).unwrap();
        let count = extract_cloud_backup_bundle(&bundle, &restored).unwrap();

        assert!(size > CLOUD_BACKUP_MAGIC.len() as u64);
        assert_eq!(&fs::read(&bundle).unwrap()[..2], &[0x1f, 0x8b]);
        assert_eq!(count, 2);
        assert_eq!(fs::read_to_string(restored.join(chapter.strip_prefix(&source).unwrap())).unwrap(), "第一章正文\n完整内容");
        assert_eq!(fs::read_to_string(restored.join("client-state.json")).unwrap(), "{\"theme\":\"light\"}");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn cloud_backup_restore_accepts_legacy_uncompressed_bundle() {
        let root = std::env::temp_dir().join(format!(
            "zhizhang-legacy-backup-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let bundle_path = root.join("legacy.aswbackup");
        let restored = root.join("restored");
        let relative = "projects/旧版小说/章节/第一章.md";
        let content = "旧版备份正文".as_bytes();
        let mut bundle = fs::File::create(&bundle_path).unwrap();
        bundle.write_all(CLOUD_BACKUP_MAGIC).unwrap();
        bundle.write_all(&1_u64.to_le_bytes()).unwrap();
        bundle.write_all(&(relative.len() as u32).to_le_bytes()).unwrap();
        bundle.write_all(&(content.len() as u64).to_le_bytes()).unwrap();
        bundle.write_all(relative.as_bytes()).unwrap();
        bundle.write_all(content).unwrap();
        bundle.flush().unwrap();

        assert_eq!(extract_cloud_backup_bundle(&bundle_path, &restored).unwrap(), 1);
        assert_eq!(fs::read_to_string(restored.join(relative)).unwrap(), "旧版备份正文");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn graph_node_document_preserves_profile_and_relationships() {
        let node = json!({
            "id": "entity:林舟",
            "label": "林舟",
            "type": "entity",
            "category": "人物",
            "status": "重伤后恢复中",
            "content": "## 人物状态\n- 在城南客栈养伤。\n- 对沈砚保持戒备。"
        });
        let related = json!({
            "id": "chapter:3",
            "label": "第3章 城南夜雨",
            "type": "chapter"
        });
        let edge = json!({
            "id": "chapter:3->entity:林舟",
            "source": "chapter:3",
            "target": "entity:林舟",
            "label": "章节提及",
            "weight": 0.7
        });

        let markdown = graph_node_to_markdown(&node, &[node.clone(), related], &[edge]);

        assert_eq!(graph_node_relative_path(&node), PathBuf::from("图谱/重要角色/林舟.md"));
        assert!(markdown.contains("- 当前状态：重伤后恢复中"));
        assert!(markdown.contains("第3章 城南夜雨｜章节提及｜来自对方｜权重：0.70"));
        assert_eq!(
            graph_node_profile_from_markdown(&markdown),
            "## 人物状态\n- 在城南客栈养伤。\n- 对沈砚保持戒备。"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(AgentRuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            start_agent_runtime,
            call_agent_rpc,
            cloud_sync_status,
            baidu_login_url,
            complete_baidu_login,
            backup_projects_to_baidu,
            list_baidu_backups,
            restore_projects_from_baidu,
            backup_project_to_github,
            load_project_from_github,
            load_agent_chat,
            save_agent_chat,
            export_agent_chats,
            import_agent_chats,
            load_projects,
            save_projects,
            load_dismantle_books,
            save_dismantle_books,
            load_library_books,
            save_library_books,
            delete_library_book,
            load_ranking_books,
            save_ranking_books,
            load_writing_styles,
            save_writing_styles,
            projects_storage_path,
            export_text_file,
            export_backup_bundle,
            list_local_backups,
            restore_backup_bundle,
            open_project_location,
            open_dismantle_location,
            delete_dismantle_book,
            open_library_book_location,
            open_chapter_location,
            open_outline_location,
            open_card_location,
            open_graph_node_location,
            open_external_url,
            detect_system_proxy
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
