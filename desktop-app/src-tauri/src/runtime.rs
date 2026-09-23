use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};

struct AgentRuntimeProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Drop for AgentRuntimeProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub(crate) struct AgentRuntimeState {
    process: Arc<Mutex<Option<AgentRuntimeProcess>>>,
}

/// Agent 子进程最近的 stderr 输出，请求失败时回传给界面，便于定位真实原因
static AGENT_STDERR: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn record_agent_stderr(line: String) {
    if let Ok(mut buffer) = AGENT_STDERR.lock() {
        buffer.push(line);
        let overflow = buffer.len().saturating_sub(20);
        if overflow > 0 { buffer.drain(0..overflow); }
    }
}

fn recent_agent_stderr() -> String {
    match AGENT_STDERR.lock() {
        Ok(buffer) if !buffer.is_empty() => format!("\nAgent 进程日志：\n{}", buffer.join("\n")),
        _ => String::new(),
    }
}

fn node_executable() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = bundled_agent_resource("node") {
        candidates.push(path);
    }
    if let Some(path) = bundled_agent_resource("node.exe") {
        candidates.push(path);
    }
    if let Ok(value) = std::env::var("ZHIZHANG_NODE") {
        if !value.trim().is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }
    // Finder/launched applications do not inherit a shell's PATH, so probe the
    // common per-user Node locations before relying on the bare command name.
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        candidates.push(home.join(".local/bin/node"));
        candidates.push(home.join(".volta/bin/node"));
        candidates.push(home.join(".fnm/current/bin/node"));
        if let Ok(entries) = fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions = entries.filter_map(Result::ok).map(|entry| entry.path()).collect::<Vec<_>>();
            versions.sort();
            versions.reverse();
            candidates.extend(versions.into_iter().map(|version| version.join("bin/node")));
        }
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("node"),
    ]);

    let mut attempted = Vec::new();
    let mut seen = HashSet::new();
    for candidate in candidates {
        let key = candidate.to_string_lossy().to_string();
        if !seen.insert(key.clone()) { continue; }
        attempted.push(key);
        if Command::new(&candidate).arg("--version").output().map(|output| output.status.success()).unwrap_or(false) {
            return Ok(candidate);
        }
    }
    Err(format!("找不到可用的 Node.js 运行时（已检查 {}）。可设置 ZHIZHANG_NODE 指向 node 可执行文件。", attempted.join("、")))
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("仅允许打开 http/https 链接".to_string());
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut value = Command::new("open");
        value.arg(trimmed);
        value
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut value = Command::new("cmd");
        value.args(["/C", "start", "", trimmed]);
        value
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut value = Command::new("xdg-open");
        value.arg(trimmed);
        value
    };
    #[cfg(any(target_os = "ios", target_os = "android"))]
    return Err("移动端使用系统链接回退".to_string());
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    command.spawn().map(|_| ()).map_err(|error| format!("打开外部链接失败：{error}"))
}

fn spawn_agent_runtime() -> Result<AgentRuntimeProcess, String> {
    let script = agent_runtime_script()?;
    let node = node_executable()?;
    let mut child = Command::new(&node)
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动 Agent 进程失败: {error}"))?;
    let stdin = child.stdin.take().ok_or_else(|| "无法打开 Agent 输入通道".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "无法打开 Agent 输出通道".to_string())?;
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let text = line.trim_end().to_string();
                if !text.is_empty() {
                    // Agent 子进程的崩溃栈和错误日志以前被直接丢弃，排查时看不到任何线索
                    eprintln!("[agent-runtime] {text}");
                    record_agent_stderr(text);
                }
                line.clear();
            }
        });
    }
    Ok(AgentRuntimeProcess { child, stdin, stdout: BufReader::new(stdout) })
}

fn start_agent_runtime_blocking(process: Arc<Mutex<Option<AgentRuntimeProcess>>>) -> Result<String, String> {
    let script = agent_runtime_script()?;
    // 必须用 try_lock：某个模型请求正在占用管道时，预热不能排队等待，
    // 否则调用方（界面按钮、用量轮询）会一直挂在这里，看起来就是整个应用卡死
    let mut process = match process.try_lock() {
        Ok(guard) => guard,
        Err(_) => return Ok(format!("Agent runtime busy: {}", script.display())),
    };
    let running = process.as_mut().map(|runtime| runtime.child.try_wait().map(|status| status.is_none()).unwrap_or(false)).unwrap_or(false);
    if !running {
        if let Some(mut old) = process.take() { let _ = old.child.kill(); }
        *process = Some(spawn_agent_runtime()?);
    }
    Ok(format!("Agent runtime ready: {}", script.display()))
}

#[tauri::command]
pub async fn start_agent_runtime(state: State<'_, AgentRuntimeState>) -> Result<String, String> {
    // 探测 node 可执行文件和拉起子进程都是阻塞 IO，不能跑在主线程上
    let process = state.process.clone();
    tauri::async_runtime::spawn_blocking(move || start_agent_runtime_blocking(process))
        .await
        .map_err(|error| format!("Agent 预热线程退出：{error}"))?
}

#[tauri::command]
fn call_agent_rpc_blocking(app: tauri::AppHandle, process: Arc<Mutex<Option<AgentRuntimeProcess>>>, method: String, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut runtime = process.lock().map_err(|_| "Agent runtime 状态锁定失败".to_string())?;
    let request = serde_json::json!({ "id": 1, "method": method, "params": params });
    for attempt in 0..2 {
        let needs_spawn = runtime.as_mut().map(|process| process.child.try_wait().map(|status| status.is_some()).unwrap_or(true)).unwrap_or(true);
        if needs_spawn {
            if let Some(mut old) = runtime.take() { let _ = old.child.kill(); }
            *runtime = Some(spawn_agent_runtime()?);
        }
        let active = runtime.as_mut().ok_or_else(|| "Agent runtime 未启动".to_string())?;
        if let Err(error) = active.stdin.write_all(format!("{}\n", request).as_bytes()).and_then(|_| active.stdin.flush()) {
            let _ = active.child.kill();
            if attempt == 0 { continue; }
            return Err(format!("发送 Agent 请求失败: {error}{}", recent_agent_stderr()));
        }
        let mut response: Option<Value> = None;
        for line in active.stdout.by_ref().lines() {
            let line = match line {
                Ok(value) => value,
                Err(error) => {
                    // 读通道坏掉后必须结束这个进程，否则残留输出会串到下一次请求上
                    let _ = active.child.kill();
                    return Err(format!("读取 Agent 输出失败: {error}{}", recent_agent_stderr()));
                }
            };
            if line.trim().is_empty() { continue; }
            // 依赖库偶尔往 stdout 打印非 JSON 提示；直接丢弃，不能因此判定整次请求失败
            let Ok(payload) = serde_json::from_str::<Value>(&line) else {
                eprintln!("[agent-runtime] 非 JSON 输出被忽略: {}", line.chars().take(200).collect::<String>());
                continue;
            };
            if payload.get("type").and_then(Value::as_str) == Some("agent_stream") {
                if let Some(event) = payload.get("event") {
                    let mut event = event.clone();
                    if let Some(run_id) = payload.get("runId") { event["runId"] = run_id.clone(); }
                    // 进度事件发送失败不应中断正在进行的生成
                    if let Err(error) = app.emit("agent-progress", event) {
                        eprintln!("[agent-runtime] 转发进度事件失败: {error}");
                    }
                }
                continue;
            }
            response = Some(payload);
            break;
        }
        if let Some(response) = response {
            if let Some(error) = response.get("error") {
                return Err(format!("{}{}", error.get("message").and_then(Value::as_str).unwrap_or("Agent 执行失败"), recent_agent_stderr()));
            }
            return Ok(response.get("result").cloned().unwrap_or(response));
        }
        if let Some(mut old) = runtime.take() { let _ = old.child.kill(); }
    }
    Err(format!("Agent 重启后仍未返回结果，请检查网络设置{}", recent_agent_stderr()))
}

#[tauri::command]
pub async fn call_agent_rpc(app: tauri::AppHandle, state: State<'_, AgentRuntimeState>, method: String, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let process = state.process.clone();
    tauri::async_runtime::spawn_blocking(move || call_agent_rpc_blocking(app, process, method, params))
        .await
        .map_err(|error| format!("Agent 任务线程退出：{error}"))?
}

fn agent_runtime_script() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    #[cfg(debug_assertions)]
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sidecars/agent-runtime/dist/main.js"));
    if let Some(path) = bundled_agent_resource("main.cjs") {
        candidates.push(path);
    }
    candidates.extend([
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sidecars/agent-runtime/dist/main.js"),
        PathBuf::from("../sidecars/agent-runtime/dist/main.js"),
        PathBuf::from("sidecars/agent-runtime/dist/main.js"),
    ]);
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            // macOS bundle: Contents/MacOS/<binary> -> Contents/Resources/agent-runtime/main.js
            candidates.push(directory.join("../Resources/agent-runtime/main.cjs"));
            candidates.push(directory.join("agent-runtime/main.cjs"));
        }
    }
    candidates
        .into_iter()
        .find(|path| Path::new(path).exists())
        .ok_or_else(|| "找不到 Agent runtime，请先构建 sidecars/agent-runtime".to_string())
}

fn bundled_agent_resource(name: &str) -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let directory = executable.parent()?;
    let candidates = [
        directory.join("../Resources/agent-runtime").join(name),
        directory.join("agent-runtime").join(name),
    ];
    candidates.into_iter().find(|path| path.exists())
}

