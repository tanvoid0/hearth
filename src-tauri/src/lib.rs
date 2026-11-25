use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{LazyLock, Mutex};
use tauri::ipc::Channel;

#[derive(Serialize, Clone)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
}

// Directories whose contents are almost never useful to browse in an editor
// and can be enormous (node_modules especially) — skip them in the tree.
const SKIP_DIRS: [&str; 5] = ["node_modules", ".git", "target", "dist", ".hearth"];

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let dir = Path::new(&path);
    let read = fs::read_dir(dir).map_err(|e| format!("{}: {}", path, e))?;

    let mut entries: Vec<DirEntryInfo> = Vec::new();
    for entry in read {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        entries.push(DirEntryInfo {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: file_type.is_dir(),
        });
    }

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

/// Refuse a path that leaves `root`, following symlinks on the way.
///
/// A second implementation of what `resolveInProject` already does in
/// TypeScript, for the same reason `check_command` lives here rather than in
/// `terminal.ts`: the paths the agent works on come from a model, and the check
/// that stops one from reaching the rest of the disk shouldn't be one bug in one
/// file away from being gone. `root` is optional because the UI legitimately
/// reads outside the open project — the workspace scan looks for `.hearth`
/// markers in folders that aren't projects yet — so it's passed by the callers
/// handling model-supplied paths and omitted by the ones that aren't.
///
/// ponytail: a caller that omits `root` is unchecked, so this hardens against a
/// mistake in the resolver rather than against a frontend that has already been
/// taken over — at which point `invoke` is the attacker's, root argument and
/// all. Hold the open project in a static here if that ever stops being true.
fn inside(root: &str, path: &str) -> Result<(), String> {
    let base = fs::canonicalize(root).map_err(|e| format!("{}: {}", root, e))?;
    // A file that doesn't exist yet can't be canonicalized, so walk up to the
    // nearest ancestor that does and re-attach the rest. `..` is already gone by
    // then — canonicalize resolves it, which is the point.
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut probe = Path::new(path).to_path_buf();
    let resolved = loop {
        if let Ok(found) = fs::canonicalize(&probe) {
            break found;
        }
        match (probe.file_name().map(|n| n.to_os_string()), probe.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                probe = parent.to_path_buf();
            }
            _ => return Err(format!("{}: no such directory", path)),
        }
    };
    let target = tail.iter().rev().fold(resolved, |p, name| p.join(name));

    if target.starts_with(&base) {
        Ok(())
    } else {
        Err(format!("path escapes project root: {}", path))
    }
}

#[tauri::command]
fn read_text_file(path: String, root: Option<String>) -> Result<String, String> {
    if let Some(root) = root.as_deref() {
        inside(root, &path)?;
    }
    fs::read_to_string(&path).map_err(|e| format!("{}: {}", path, e))
}

#[tauri::command]
fn write_text_file(path: String, contents: String, root: Option<String>) -> Result<(), String> {
    if let Some(root) = root.as_deref() {
        inside(root, &path)?;
    }
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {}", parent.display(), e))?;
    }
    fs::write(&path, contents).map_err(|e| format!("{}: {}", path, e))
}

/// Whether anything is at this path — a file, a directory, either.
///
/// `write_file` needs this rather than "did a read succeed": `read_to_string`
/// fails on a PNG or any other non-UTF-8 file, so a read-based check reports
/// every binary in the project as absent and the guard against overwriting an
/// existing file doesn't fire for exactly the files that can't be merged.
#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

fn ollama_host() -> String {
    std::env::var("OLLAMA_HOST").unwrap_or_else(|_| "http://127.0.0.1:11434".into())
}

async fn ollama_get(path: &str) -> Result<serde_json::Value, String> {
    reqwest::get(format!("{}/{}", ollama_host(), path))
        .await
        .map_err(|e| format!("ollama unreachable at {}: {}", ollama_host(), e))?
        .json()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ollama_models() -> Result<serde_json::Value, String> {
    ollama_get("api/tags").await
}

/// What's loaded right now, and how much of it sits in VRAM. The 16 GB cliff
/// is silent otherwise: a model that spilled to CPU looks identical to one
/// that didn't, except that every step takes minutes.
#[tauri::command]
async fn ollama_ps() -> Result<serde_json::Value, String> {
    ollama_get("api/ps").await
}

/// Drop a model from VRAM now rather than waiting out Ollama's idle timeout.
/// Switching models mid-session otherwise leaves the old one resident for
/// minutes — which on a full card is exactly enough to push the new one onto
/// the CPU, and the slowdown then looks like a property of the new model.
#[tauri::command]
async fn ollama_unload(model: String) -> Result<(), String> {
    let res = reqwest::Client::new()
        .post(format!("{}/api/generate", ollama_host()))
        .json(&serde_json::json!({ "model": model, "keep_alive": 0 }))
        .send()
        .await
        .map_err(|e| format!("ollama unreachable at {}: {}", ollama_host(), e))?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("ollama /api/generate {}", res.status()))
    }
}

/// One `--query-gpu` field as a number, or `None` when we can't tell — no
/// NVIDIA GPU, no driver, or a machine where this shells out to nothing.
///
/// Deliberately shells out to `nvidia-smi` rather than taking an NVML crate:
/// the binary ships with the driver, and the two numbers wanted here don't
/// justify a dependency that would still only cover one vendor. The cost is a
/// process spawn, ~80ms measured on this machine — cheap once, not free on a
/// timer, which is what decides where each caller below runs.
fn nvidia_smi_query(field: &str) -> Option<f64> {
    let mut cmd = Command::new("nvidia-smi");
    cmd.arg(format!("--query-gpu={}", field));
    cmd.arg("--format=csv,noheader,nounits");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    // One line per GPU; the first is the one Ollama will use.
    String::from_utf8_lossy(&out.stdout).lines().next()?.trim().parse().ok()
}

/// Total VRAM in GB, or `None` when we can't tell.
///
/// This reports *capacity*, never a prediction. Disk size doesn't predict a
/// model's VRAM footprint — measured on this machine it ranges from 0.35× to
/// 1.21× — so anything that multiplied a `/api/tags` size by a guess would
/// steer users away from models that fit fine.
///
/// Sync because it's fetched once at startup; the spawn doesn't get a chance
/// to be felt on the main thread.
#[tauri::command]
fn gpu_total_vram_gb() -> Option<f64> {
    Some(nvidia_smi_query("memory.total")? * 1024.0 * 1024.0 / 1e9)
}

/// Current GPU utilisation as a percentage, or `None` when we can't tell.
///
/// A different question from the VRAM residency badge: that one says whether
/// the model *fits*, this says whether the card is actually *working*. Both
/// read 100% and 0% for unrelated reasons.
///
/// Off the main thread, unlike the capacity query above: this one is polled on
/// a timer while a turn runs, and 80ms of blocking a second would be visible
/// as jerk in the same UI it's reporting into.
#[tauri::command]
async fn gpu_utilization_pct() -> Option<f64> {
    tauri::async_runtime::spawn_blocking(|| nvidia_smi_query("utilization.gpu"))
        .await
        .ok()
        .flatten()
}

/// POST an Ollama endpoint that streams, forwarding each newline-delimited JSON
/// chunk to the frontend as it arrives. The frontend owns parsing — this only
/// deals in framing.
async fn ollama_stream(path: &str, body: serde_json::Value, on_chunk: Channel<String>) -> Result<(), String> {
    let mut res = reqwest::Client::new()
        .post(format!("{}/{}", ollama_host(), path))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("ollama unreachable at {}: {}", ollama_host(), e))?;

    if !res.status().is_success() {
        let status = res.status();
        let detail = res.text().await.unwrap_or_default();
        return Err(format!("ollama /{} {}: {}", path, status, detail));
    }

    // Buffer bytes, not strings: a chunk boundary can land mid-UTF-8-sequence.
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        buf.extend_from_slice(&chunk);
        for line in take_lines(&mut buf) {
            on_chunk.send(line).map_err(|e| e.to_string())?;
        }
    }
    let tail = String::from_utf8_lossy(&buf).trim().to_string();
    if !tail.is_empty() {
        on_chunk.send(tail).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Cancel handles for in-flight chat calls, keyed by the id the caller passed.
static CHAT_CANCELS: LazyLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>> =
    LazyLock::new(Default::default);

/// One model turn, abortable.
///
/// A flag checked between chunks wouldn't be enough: the longest wait in a turn
/// is the one *before* the first chunk, while Ollama loads a model — minutes on
/// a model that spilled to CPU, which is exactly when Stop gets pressed. So the
/// select drops the request future itself, which closes the connection and
/// stops the generation rather than only ignoring it.
#[tauri::command]
async fn ollama_chat(id: String, body: serde_json::Value, on_chunk: Channel<String>) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    CHAT_CANCELS.lock().unwrap().insert(id.clone(), tx);

    let result = tokio::select! {
        streamed = ollama_stream("api/chat", body, on_chunk) => streamed,
        _ = rx => Err(CANCELLED.to_string()),
    };

    CHAT_CANCELS.lock().unwrap().remove(&id);
    result
}

/// What a cancelled call rejects with. The frontend matches on it to tell a
/// deliberate Stop apart from a model that fell over.
const CANCELLED: &str = "cancelled";

#[tauri::command]
fn ollama_cancel(id: String) {
    if let Some(tx) = CHAT_CANCELS.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
}

/// Download a model, streaming `{status, total, completed}` progress. Multi-GB
/// and minutes long, so it reports rather than blocking silently.
#[tauri::command]
async fn ollama_pull(model: String, on_chunk: Channel<String>) -> Result<(), String> {
    ollama_stream("api/pull", serde_json::json!({ "model": model, "stream": true }), on_chunk).await
}

/// PID of the running dev server, if any. One at a time: one project is open
/// at a time, and a second server would only fight the first for the port.
static DEV_PID: Mutex<Option<u32>> = Mutex::new(None);

/// Lines the frontend reads as control events rather than log output.
const MARK: &str = "[hearth]";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Ask the OS for a free port and hand it straight back. Racy in principle —
/// something else can take it in the gap — but pairing it with `--strictPort`
/// turns that race into a loud failure in the log instead of vite silently
/// picking a different port that we'd then have to parse its banner for.
fn free_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| e.to_string())
}

/// Which package manager the project uses, read off its lockfile.
///
/// The lockfile rather than a `packageManager` field or a preference: it's the
/// file that decides whether the install the user already did counts. Running
/// `npm install` in a pnpm project doesn't just pick the wrong tool, it writes
/// a second lockfile and a `node_modules` layout the project's own scripts
/// don't expect. npm is the fallback because every Node install has it.
fn detect_pm(root: &str) -> &'static str {
    [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lockb", "bun"),
        ("bun.lock", "bun"),
    ]
    .into_iter()
    .find(|(lock, _)| Path::new(root).join(lock).exists())
    .map(|(_, pm)| pm)
    .unwrap_or("npm")
}

/// The same answer, for the frontend's install-on-demand chip. One lockfile
/// rule rather than a second one written in TypeScript.
#[tauri::command]
fn package_manager(root: String) -> &'static str {
    detect_pm(&root)
}

fn pm(root: &str, exe: &str, args: &[&str]) -> Command {
    // These are .cmd shims on Windows, which CreateProcess won't launch
    // directly. Going through cmd also gives `taskkill /T` a parent to walk
    // when stopping, since vite ends up a grandchild.
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.arg("/C").arg(exe).args(args);
        c.creation_flags(CREATE_NO_WINDOW); // no console flash on every spawn
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new(exe);
        c.args(args);
        c
    };
    cmd.current_dir(root)
        // Colour codes would land verbatim in the log panel, which renders
        // plain text.
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

fn forward(pipe: impl Read + Send + 'static, ch: Channel<String>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            if ch.send(line).is_err() {
                break; // window went away
            }
        }
    })
}

/// Run one npm command to completion, streaming stdout and stderr as they
/// arrive. Registers the PID first so `stop_dev` can interrupt a long
/// `npm install`, not just the server it precedes.
fn run_to_end(mut cmd: Command, ch: &Channel<String>) -> Result<i32, String> {
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    *DEV_PID.lock().unwrap() = Some(pid);

    let pumps: Vec<_> = [
        child.stdout.take().map(|p| forward(p, ch.clone())),
        child.stderr.take().map(|p| forward(p, ch.clone())),
    ]
    .into_iter()
    .flatten()
    .collect();

    let status = child.wait().map_err(|e| e.to_string());
    for pump in pumps {
        let _ = pump.join();
    }

    let mut held = DEV_PID.lock().unwrap();
    if *held == Some(pid) {
        *held = None;
    }
    status.map(|s| s.code().unwrap_or(-1))
}

/// How a package manager wants extra arguments handed to a script. npm and pnpm
/// need `--` to stop reading them as their own flags; yarn 1 warns about it and
/// bun rejects it.
fn script_args<'a>(manager: &str, script: &'a str, extra: &[&'a str]) -> Vec<&'a str> {
    let mut args = vec!["run", script];
    if !extra.is_empty() && matches!(manager, "npm" | "pnpm") {
        args.push("--");
    }
    args.extend_from_slice(extra);
    args
}

/// Start (installing first if needed) one of the project's scripts, and return
/// the port it was told to listen on — 0 for a script that isn't a server.
///
/// Returns as soon as the process is spawned: an install on a cold project runs
/// for minutes, so progress is reported through the event channel rather than by
/// making the caller wait here. `[hearth] phase:*` lines are the frontend's
/// state machine (installing → starting → ready), and the port and config flags
/// only go on when `serve` says this script is a vite dev server.
#[tauri::command]
fn run_dev(
    root: String,
    script: String,
    serve: bool,
    config: Option<String>,
    on_event: Channel<String>,
) -> Result<u16, String> {
    stop_dev()?;
    let port = if serve { free_port()? } else { 0 };
    let manager = detect_pm(&root);

    std::thread::spawn(move || {
        let fail = |msg: String| {
            let _ = on_event.send(format!("{} {}", MARK, msg));
        };

        if !Path::new(&root).join("node_modules").exists() {
            let _ = on_event.send(format!("{} phase:installing", MARK));
            let _ = on_event.send(format!("$ {} install", manager));
            match run_to_end(pm(&root, manager, &["install"]), &on_event) {
                Ok(0) => {}
                Ok(code) => return fail(format!("{} install failed (exit {})", manager, code)),
                Err(e) => return fail(format!("{} install could not start: {}", manager, e)),
            }
        }

        let port = port.to_string();
        let mut extra: Vec<&str> = Vec::new();
        if serve {
            // A generated config that wraps the project's own — see
            // `bridgeConfig` in workspace.ts. Only meaningful to vite, which is
            // the only thing `serve` is ever true for.
            if let Some(path) = config.as_deref() {
                extra.extend_from_slice(&["--config", path]);
            }
            extra.extend_from_slice(&["--port", &port, "--strictPort"]);
        }
        let args = script_args(manager, &script, &extra);

        let _ = on_event.send(format!("{} phase:starting", MARK));
        let _ = on_event.send(format!("$ {} {}", manager, args.join(" ")));
        match run_to_end(pm(&root, manager, &args), &on_event) {
            Ok(code) => fail(format!("{} exited (code {})", script, code)),
            Err(e) => fail(format!("{} could not start: {}", script, e)),
        }
    });

    Ok(port)
}

/// Kill a process *and everything it spawned*. Killing only the head leaves
/// grandchildren alive — a dev server still holding its port, or a build still
/// running under a closed terminal. The Windows orphan problem the build plan
/// flags in §9.
fn kill_tree(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    let killed = {
        use std::os::windows::process::CommandExt;
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
    };
    // ponytail: kills the named process only; a surviving grandchild keeps
    // whatever it holds. Spawn with `process_group(0)` and kill the group when
    // this app actually needs to run on unix.
    #[cfg(not(windows))]
    let killed = Command::new("kill").arg(pid.to_string()).status();

    killed.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn stop_dev() -> Result<(), String> {
    match DEV_PID.lock().unwrap().take() {
        Some(pid) => kill_tree(pid),
        None => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

struct Pty {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    pid: Option<u32>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Live PTY sessions, keyed by id. A map rather than the single slot `run_dev`
/// uses, because build plan §4.3 requires the agent's command execution to get
/// a PTY of its own, separate from the user's — that's a second key here, not a
/// second implementation, and retrofitting it later would be the harder job.
static PTYS: LazyLock<Mutex<HashMap<String, Pty>>> = LazyLock::new(Default::default);

fn on_path(exe: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(exe).is_file()))
        .unwrap_or(false)
}

/// PowerShell 7 if it's installed, then Windows PowerShell, then cmd — cmd is
/// always present, so the chain can't come up empty.
fn default_shell() -> String {
    #[cfg(windows)]
    {
        ["pwsh.exe", "powershell.exe"]
            .into_iter()
            .find(|exe| on_path(exe))
            .unwrap_or("cmd.exe")
            .to_string()
    }
    #[cfg(not(windows))]
    {
        let _ = on_path("sh");
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

/// Drain the longest valid-UTF-8 prefix, leaving a truncated trailing character
/// buffered for the next read.
///
/// PTY output has no framing at all — no newlines to resync on, unlike the
/// NDJSON path — so a read boundary lands mid-character routinely. Bytes that
/// are genuinely invalid (rather than merely incomplete) are dropped with a
/// replacement character: leaving them would stall the stream forever, since
/// they never become valid no matter how much more arrives.
fn take_utf8(buf: &mut Vec<u8>) -> Option<String> {
    let (valid, invalid) = match std::str::from_utf8(buf) {
        Ok(s) => (s.len(), 0),
        Err(e) => (e.valid_up_to(), e.error_len().unwrap_or(0)),
    };
    if valid == 0 && invalid == 0 {
        return None;
    }
    let head: Vec<u8> = buf.drain(..valid).collect();
    let mut out = String::from_utf8_lossy(&head).into_owned();
    if invalid > 0 {
        buf.drain(..invalid);
        out.push('\u{FFFD}');
    }
    Some(out)
}

#[tauri::command]
fn pty_open(id: String, cwd: String, cols: u16, rows: u16, on_data: Channel<String>) -> Result<(), String> {
    pty_close(id.clone())?; // reopening an id replaces the session behind it

    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(default_shell());
    cmd.cwd(&cwd);
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The slave handle has to go, or the reader below never sees EOF when the
    // shell exits — this process would still be holding the other end open.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let pid = child.process_id();

    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        let mut buf: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break, // shell exited, or the pty closed under us
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(text) = take_utf8(&mut buf) {
                        if on_data.send(text).is_err() {
                            break; // window went away
                        }
                    }
                }
            }
        }
        // Otherwise typing `exit` leaves a pane that silently ignores every
        // keystroke, with nothing to say the shell is gone.
        let _ = on_data.send("\r\n\u{1b}[2m[process exited]\u{1b}[0m\r\n".into());
    });

    PTYS.lock().unwrap().insert(id, Pty { master: pair.master, writer, pid, child });
    Ok(())
}

#[tauri::command]
fn pty_write(id: String, data: String) -> Result<(), String> {
    let mut ptys = PTYS.lock().unwrap();
    let pty = ptys.get_mut(&id).ok_or("no such terminal")?;
    pty.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    pty.writer.flush().map_err(|e| e.to_string())
}

/// Tell the shell how wide it is. Without this a resized window wraps at the
/// old width, which looks like corruption rather than a layout bug.
#[tauri::command]
fn pty_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    let ptys = PTYS.lock().unwrap();
    let pty = ptys.get(&id).ok_or("no such terminal")?;
    pty.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_close(id: String) -> Result<(), String> {
    let Some(mut pty) = PTYS.lock().unwrap().remove(&id) else {
        return Ok(());
    };
    // Whatever the user last ran is a child of the shell, so killing the shell
    // alone can leave a build running with nothing attached to it.
    if let Some(pid) = pty.pid {
        let _ = kill_tree(pid);
    }
    let _ = pty.child.kill();
    let _ = pty.child.wait();
    Ok(())
}

fn close_all_ptys() {
    let ids: Vec<String> = PTYS.lock().unwrap().keys().cloned().collect();
    for id in ids {
        let _ = pty_close(id);
    }
}

// ---------------------------------------------------------------------------
// Agent command execution
// ---------------------------------------------------------------------------

/// Programs the agent may run. An allowlist rather than a denylist of dangerous
/// things: a local model that hallucinates a command is running it on the
/// user's real machine, and "everything except the bad ones" needs the list of
/// bad ones to be complete, which it never is.
///
/// The escape hatch when this refuses something is the terminal — the user runs
/// it themselves, having read it.
const ALLOWED_PROGRAMS: [&str; 12] = [
    "npm", "pnpm", "yarn", "npx", "node", "deno", "bun", "cargo", "tsc", "vitest", "jest", "python",
];

/// git is allowed only for verbs that report. `push`, `reset`, `clean` and
/// friends destroy work that isn't recoverable from inside this app.
const ALLOWED_GIT_VERBS: [&str; 7] = ["status", "diff", "log", "show", "branch", "ls-files", "describe"];

/// Shell metacharacters. Rejecting these is what makes the allowlist mean
/// anything: `npm test && rm -rf .` passes any check that only reads the first
/// word.
const SHELL_METACHARACTERS: [char; 8] = ['&', '|', ';', '<', '>', '$', '`', '\n'];

/// Programs on the list above that will also take code on the command line.
///
/// Without this the allowlist means "run the project's own tooling"; with
/// `node -e <code>` it means "run anything", since no metacharacter is needed to
/// write a one-liner — and the first thing an arbitrary one-liner can do is read
/// the `.env` that `read_file` deliberately redacts.
const INTERPRETERS: [&str; 5] = ["node", "deno", "bun", "npx", "python"];

/// Whether a word hands an interpreter code instead of a file: `-e`, `--eval`,
/// `-p`/`--print` (node evaluates and prints), `-c`/`--command` (python), the
/// attached form (`python -cprint(1)`), the `--eval=…` form, and deno's `eval`
/// subcommand. `npx -p` is caught too, which is a package flag rather than an
/// eval — its long form `--package` still works and the error says so.
fn hands_over_code(word: &str) -> bool {
    if word == "eval" {
        return true;
    }
    if matches!(word.split('=').next().unwrap_or(word), "--eval" | "--print" | "--command") {
        return true;
    }
    let mut chars = word.chars();
    chars.next() == Some('-') && matches!(chars.next(), Some('e') | Some('p') | Some('c'))
}

fn check_command(command: &str) -> Result<(), String> {
    if let Some(bad) = command.chars().find(|c| SHELL_METACHARACTERS.contains(c)) {
        return Err(format!(
            "refused: '{}' is not allowed — run one program per call, without shell operators",
            bad
        ));
    }

    let mut words = command.split_whitespace();
    let program = words.next().ok_or("refused: empty command")?;
    // Reject a path to a program, not just its name: `./evil` and
    // `C:\x\npm.exe` both defeat a name-only check.
    if program.contains('/') || program.contains('\\') {
        return Err(format!("refused: '{}' must be a bare program name, not a path", program));
    }

    if program == "git" {
        let verb = words.next().unwrap_or("");
        return if ALLOWED_GIT_VERBS.contains(&verb) {
            Ok(())
        } else {
            Err(format!(
                "refused: git {} can modify or discard work — allowed git verbs are {}",
                verb,
                ALLOWED_GIT_VERBS.join(", ")
            ))
        };
    }

    if INTERPRETERS.contains(&program) {
        if let Some(flag) = words.find(|w| hands_over_code(w)) {
            return Err(format!(
                "refused: '{} {}' runs code given on the command line rather than the project's own tooling — put it in a file and run that, or ask the user to run it in the terminal (npx's package flag is spelled --package)",
                program, flag
            ));
        }
    }

    if ALLOWED_PROGRAMS.contains(&program) {
        Ok(())
    } else {
        Err(format!(
            "refused: '{}' is not an allowed program. Allowed: {}, and read-only git. Ask the user to run it in the terminal instead.",
            program,
            ALLOWED_PROGRAMS.join(", ")
        ))
    }
}

#[derive(Serialize)]
struct CommandOutput {
    exit_code: i32,
    output: String,
    timed_out: bool,
}

/// PID of the command the agent is currently running, if any.
///
/// Stop has to be able to reach it. The turn loop only checks its stop flag
/// between model calls, so without this a `npm test` that has three minutes of
/// timeout left holds the whole turn open after the button is pressed, and the
/// button looks broken.
///
/// ponytail: one slot, like `DEV_PID`. `install` goes through this path too, so
/// an install and an agent command overlapping leaves only the later one
/// killable. Key it by caller if something ever runs two on purpose.
static AGENT_PID: Mutex<Option<u32>> = Mutex::new(None);

#[tauri::command]
fn stop_command() -> Result<(), String> {
    match AGENT_PID.lock().unwrap().take() {
        Some(pid) => kill_tree(pid),
        None => Ok(()),
    }
}

fn drain(pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut text = String::new();
        // Lossy on purpose: a tool that emits one bad byte shouldn't cost the
        // agent the whole output.
        let mut bytes = Vec::new();
        let _ = BufReader::new(pipe).read_to_end(&mut bytes);
        text.push_str(&String::from_utf8_lossy(&bytes));
        text
    })
}

/// Run one program in the project and hand back what it printed.
///
/// Piped, not a PTY, even though the terminal next door is a PTY: a model
/// reading test output wants plain text, and a TTY makes tools emit colour and
/// progress-bar escapes that are pure noise in a tool result. Plan §4.3's
/// "separate PTY for the agent" is about not colliding with the user's shell,
/// which a separate process satisfies on its own.
#[tauri::command]
async fn run_command(cwd: String, command: String, timeout_secs: u64) -> Result<CommandOutput, String> {
    check_command(&command)?;
    tauri::async_runtime::spawn_blocking(move || run_blocking(&cwd, &command, timeout_secs))
        .await
        .map_err(|e| e.to_string())?
}

fn run_blocking(cwd: &str, command: &str, timeout_secs: u64) -> Result<CommandOutput, String> {
    {
        // ponytail: whitespace splitting, so a quoted argument containing a
        // space is split wrong. None of the allowed programs need one for the
        // things an agent runs (`npm test`, `npx tsc --noEmit`). Parse quotes
        // when something actually needs them.
        let args: Vec<&str> = command.split_whitespace().collect();

        // Node's tooling is `.cmd` shims on Windows, which CreateProcess won't
        // launch directly — same reason `npm()` goes through cmd. Safe here
        // only because `check_command` already rejected every metacharacter cmd
        // would act on.
        #[cfg(windows)]
        let mut cmd = {
            use std::os::windows::process::CommandExt;
            let mut c = Command::new("cmd");
            c.arg("/C").args(&args);
            c.creation_flags(CREATE_NO_WINDOW);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = Command::new(args[0]);
            c.args(&args[1..]);
            c
        };

        cmd.current_dir(&cwd)
            .env("NO_COLOR", "1")
            .env("FORCE_COLOR", "0")
            .env("CI", "1") // stops watch-mode test runners from never exiting
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("could not start '{}': {}", command, e))?;
        let pid = child.id();
        *AGENT_PID.lock().unwrap() = Some(pid);

        // Read on threads: waiting on a child while its pipes fill deadlocks.
        let out = child.stdout.take().map(drain);
        let err = child.stderr.take().map(drain);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
        let mut timed_out = false;
        // No `?` inside the loop: an early return would leave a dead pid in
        // AGENT_PID, and Windows recycles pids — the next Stop would kill
        // whatever inherited the number.
        let exit_code = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.code().unwrap_or(-1),
                Err(_) => break -1,
                Ok(None) if std::time::Instant::now() >= deadline => {
                    // Kill the tree: `npm test` is a shim around the runner, and
                    // killing the shim leaves the runner holding the pipes open,
                    // so the drain threads would never finish.
                    let _ = kill_tree(pid);
                    let _ = child.wait();
                    timed_out = true;
                    break -1;
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            }
        };
        // Cleared before the drains are joined: the process is gone by here, and
        // a Stop arriving while its output is still being read has nothing left
        // to kill.
        *AGENT_PID.lock().unwrap() = None;

        let mut output = String::new();
        for handle in [out, err].into_iter().flatten() {
            output.push_str(&handle.join().unwrap_or_default());
        }

        Ok(CommandOutput { exit_code, output, timed_out })
    }
}

#[derive(Serialize)]
struct GitOutput {
    code: i32,
    /// Kept apart from stderr, unlike `run_command`'s merged stream: this one
    /// carries file content back from `git show <sha>:<path>`, and a merged
    /// stream would splice git's warnings into the middle of a file.
    stdout: String,
    stderr: String,
}

/// Run git against Hearth's checkpoint repo (plan §7): a git dir under
/// `.hearth/git` with the project as its work tree, so checkpoints never
/// collide with the user's own `.git`.
///
/// No allowlist, unlike `run_command`. The args come from `git.ts` and never
/// from the model, and the whole point of this surface is the write verbs
/// (`commit`, `reset`) that `check_command` exists to refuse. They arrive as a
/// list, so there's no shell and nothing to parse.
#[tauri::command]
async fn git(root: String, args: Vec<String>) -> Result<GitOutput, String> {
    tauri::async_runtime::spawn_blocking(move || git_blocking(&root, &args))
        .await
        .map_err(|e| e.to_string())?
}

fn git_blocking(root: &str, args: &[String]) -> Result<GitOutput, String> {
    let git_dir = Path::new(root).join(".hearth").join("git");
    // `git init` won't create its own parent. Doing it here rather than in an
    // init path means no caller has to remember to.
    fs::create_dir_all(&git_dir).map_err(|e| e.to_string())?;

    let mut cmd = Command::new("git");
    cmd.arg(format!("--git-dir={}", git_dir.display()))
        .arg(format!("--work-tree={}", root))
        .args(args)
        .current_dir(root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd
        .output()
        .map_err(|e| format!("could not run git ({e}) — is it installed and on PATH?"))?;
    Ok(GitOutput {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct SearchHit {
    /// Relative to the project root with forward slashes — the same shape every
    /// other path the agent is given takes.
    path: String,
    line: u32,
    text: String,
}

/// Past this, a file is a bundle, a lockfile or a data dump. A hit in one is
/// never what the caller meant, and reading them is most of what a search costs.
const MAX_SEARCH_FILE_BYTES: u64 = 1_000_000;
/// One matching line, clipped. A minified line that slipped under the size cap
/// would otherwise be the entire result.
const MAX_HIT_CHARS: usize = 300;

/// Plain literal search across the project, case-insensitive.
///
/// Build plan §11 says "ripgrep search tool". This walks the tree itself rather
/// than shelling out to `rg`: the binary isn't something an offline-first app
/// can assume is installed, and a regex crate would be a dependency for a
/// feature whose whole job is finding a name someone already knows how to spell.
/// Regex is the upgrade path if literal search turns out not to be enough.
#[tauri::command]
fn search_files(root: String, query: String, max: usize) -> Result<Vec<SearchHit>, String> {
    if query.trim().is_empty() {
        return Err("empty search".into());
    }
    let mut hits = Vec::new();
    search_dir(Path::new(&root), Path::new(&root), &query.to_lowercase(), max, &mut hits);
    Ok(hits)
}

fn search_dir(dir: &Path, root: &Path, needle: &str, max: usize, hits: &mut Vec<SearchHit>) {
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = read.flatten().collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        if hits.len() >= max {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();

        if path.is_dir() {
            // Dot-directories are tooling state (.git, .hearth, .vscode); dot
            // *files* are project config someone may well be searching for.
            if !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                search_dir(&path, root, needle, max, hits);
            }
            continue;
        }
        if entry.metadata().map(|m| m.len() > MAX_SEARCH_FILE_BYTES).unwrap_or(true) {
            continue;
        }
        // Binaries fail to decode here, which is the sniffer.
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");

        for (i, line) in text.lines().enumerate() {
            if hits.len() >= max {
                return;
            }
            if line.to_lowercase().contains(needle) {
                hits.push(SearchHit {
                    path: rel.clone(),
                    line: i as u32 + 1,
                    text: line.trim().chars().take(MAX_HIT_CHARS).collect(),
                });
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Language server
// ---------------------------------------------------------------------------

/// The running tsserver, if any. One at a time, like the dev server: one
/// project is open at a time, and a second instance would only duplicate every
/// diagnostic.
struct Tsserver {
    stdin: std::process::ChildStdin,
    pid: u32,
    child: std::process::Child,
}

static TSSERVER: Mutex<Option<Tsserver>> = Mutex::new(None);

const TSSERVER_REL: &str = "node_modules/typescript/lib/tsserver.js";

/// Find a `tsserver.js` to run.
///
/// Build plan §2 names `typescript-language-server`; this talks to `tsserver`
/// directly, which is the thing that wrapper wraps and the same protocol VS
/// Code's own TypeScript support speaks. It needs no new dependency —
/// `typescript` is already installed here — and Monaco doesn't speak LSP
/// natively either, so the wire format would have to be translated either way.
///
/// The project's own TypeScript wins when it has one: that's the version its
/// code was written against, and the one its `npm run build` will use.
///
/// The fallback walks up from the working directory, which finds Hearth's own
/// copy under `tauri dev` and nothing at all in a packaged app — where
/// `bundled_tsserver` takes over.
fn tsserver_script(root: &str) -> Option<std::path::PathBuf> {
    let own = Path::new(root).join(TSSERVER_REL);
    if own.is_file() {
        return Some(own);
    }
    let mut dir = std::env::current_dir().ok()?;
    loop {
        let candidate = dir.join(TSSERVER_REL);
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// Hearth's own copy, shipped as a Tauri resource (see `bundle.resources`).
///
/// This is what makes type checking work in a packaged app: there's no
/// `node_modules` above the executable to walk up to, so without it every
/// project without its own TypeScript reported "unavailable" — which is honest,
/// but it's the majority of projects and the phase's whole point.
///
/// `node` itself is still expected on PATH. Bundling a runtime is a different
/// order of work, and every project Hearth runs already needs node for the
/// package manager and the dev server.
fn bundled_tsserver(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let path = app
        .path()
        .resolve("typescript/lib/tsserver.js", tauri::path::BaseDirectory::Resource)
        .ok()?;
    path.is_file().then_some(path)
}

/// Start tsserver for a project. Messages arrive on the channel as raw JSON
/// bodies — the frontend owns the protocol, this owns the framing, the same
/// split as `ollama_stream` and `run_dev`.
#[tauri::command]
fn ts_start(app: tauri::AppHandle, root: String, on_message: Channel<String>) -> Result<(), String> {
    ts_stop()?;
    let script = tsserver_script(&root).or_else(|| bundled_tsserver(&app)).ok_or(
        "no TypeScript found — language features need node_modules/typescript in the project or in Hearth's own install",
    )?;

    let mut cmd = Command::new("node");
    cmd.arg(&script)
        // Left on, this downloads @types packages from npm in the background —
        // network traffic an offline-first app shouldn't generate, for types
        // the project didn't ask for.
        .arg("--disableAutomaticTypingAcquisition")
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // tsserver logs nothing here unless asked; a full pipe with no reader
        // would block it.
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start tsserver with node ({e}) — is node on PATH?"))?;
    let stdin = child.stdin.take().ok_or("tsserver stdin")?;
    let mut stdout = child.stdout.take().ok_or("tsserver stdout")?;
    let pid = child.id();

    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        let mut buf: Vec<u8> = Vec::new();
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break, // tsserver exited, or the pipe closed
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    while let Some(msg) = take_message(&mut buf) {
                        if on_message.send(msg).is_err() {
                            return; // window went away
                        }
                    }
                }
            }
        }
    });

    *TSSERVER.lock().unwrap() = Some(Tsserver { stdin, pid, child });
    Ok(())
}

/// Send one request. tsserver reads newline-delimited JSON on stdin even though
/// it writes `Content-Length`-framed JSON on stdout.
#[tauri::command]
fn ts_send(body: String) -> Result<(), String> {
    let mut held = TSSERVER.lock().unwrap();
    let ts = held.as_mut().ok_or("language server not running")?;
    ts.stdin.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    ts.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
    ts.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn ts_stop() -> Result<(), String> {
    let Some(mut ts) = TSSERVER.lock().unwrap().take() else {
        return Ok(());
    };
    // Dropping stdin is the polite exit — tsserver shuts down on EOF. The kill
    // is for the case where it's wedged mid-check and never reads again.
    drop(ts.stdin);
    let _ = kill_tree(ts.pid);
    let _ = ts.child.kill();
    let _ = ts.child.wait();
    Ok(())
}

/// Drain one `Content-Length`-framed message body, leaving any partial tail.
///
/// Unlike the NDJSON path there's no newline to resync on, and unlike the PTY
/// path the length is declared up front — so the only real hazard is a header
/// that never completes. A header with no `Content-Length` is dropped rather
/// than waited on: it can never become valid, and waiting would stall every
/// message behind it forever, the same failure `take_utf8` avoids for bytes.
fn take_message(buf: &mut Vec<u8>) -> Option<String> {
    loop {
        let sep = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
        let len = String::from_utf8_lossy(&buf[..sep])
            .lines()
            .find_map(|l| l.strip_prefix("Content-Length:")?.trim().parse::<usize>().ok());
        let Some(len) = len else {
            buf.drain(..sep + 4);
            continue;
        };
        if buf.len() < sep + 4 + len {
            return None;
        }
        // The header counts bytes, not characters, so the split has to happen
        // on the byte buffer — a body with any non-ASCII in it lands short
        // otherwise.
        let body: Vec<u8> = buf.drain(..sep + 4 + len).skip(sep + 4).collect();
        return Some(String::from_utf8_lossy(&body).into_owned());
    }
}

/// Drain whole newline-terminated lines from `buf`, leaving any partial tail.
fn take_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buf.drain(..=nl).collect();
        let line = String::from_utf8_lossy(&line).trim().to_string();
        if !line.is_empty() {
            lines.push(line);
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::{check_command, inside, take_lines, take_message, take_utf8};
    use std::io::Write;

    /// The allowlist is only worth anything if it bounds what runs. A shell
    /// operator was always refused; code on the command line is the same hole
    /// with no metacharacter in it, and `node -e` can read the `.env` that
    /// `read_file` redacts.
    #[test]
    fn the_allowlist_refuses_code_given_on_the_command_line() {
        for allowed in [
            "npm test",
            "npx tsc --noEmit",
            "node scripts/build.js",
            "python manage.py",
            "cargo build -p hearth", // -p is a package flag, and cargo takes no code
            "npx --package typescript tsc",
            "node --experimental-strip-types x.ts", // starts with -e, isn't --eval
            "git status",
        ] {
            assert!(check_command(allowed).is_ok(), "should allow: {allowed}");
        }
        for refused in [
            "node -e console.log(1)",
            "node --eval=console.log(1)",
            "node -p require('fs').readFileSync('.env','utf8')",
            "python -c print(1)",
            "python -cprint(1)", // the attached form
            "deno eval console.log(1)",
            "bun -e console.log(1)",
            "npm test && rm -rf .",
            "./evil",
            "git push",
        ] {
            assert!(check_command(refused).is_err(), "should refuse: {refused}");
        }
    }

    /// The second copy of `resolveInProject`, which exists so that one bug in
    /// one TypeScript file isn't the only thing between a model-supplied path
    /// and the rest of the disk.
    #[test]
    fn a_path_outside_the_project_is_refused_symlinks_included() {
        use std::fs;

        let base = std::env::temp_dir().join(format!("hearth-inside-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("project");
        fs::create_dir_all(root.join("src")).expect("mkdir");
        fs::create_dir_all(base.join("secrets")).expect("mkdir");
        fs::write(base.join("secrets/keys.txt"), "shh").unwrap();
        let root_s = root.to_string_lossy().to_string();

        assert!(inside(&root_s, &root.join("src/a.ts").to_string_lossy()).is_ok());
        // Doesn't exist yet — write_file's case, resolved through its parent.
        assert!(inside(&root_s, &root.join("src/new/deep.ts").to_string_lossy()).is_ok());
        assert!(inside(&root_s, &root.join("../secrets/keys.txt").to_string_lossy()).is_err());
        assert!(inside(&root_s, &base.join("secrets/keys.txt").to_string_lossy()).is_err());

        // A link inside the project pointing out of it. The string check in
        // TypeScript can't see this one; canonicalize is why this is here.
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(base.join("secrets"), root.join("link")).is_ok();
        #[cfg(not(windows))]
        let linked = std::os::unix::fs::symlink(base.join("secrets"), root.join("link")).is_ok();
        if linked {
            assert!(inside(&root_s, &root.join("link/keys.txt").to_string_lossy()).is_err());
        } else {
            // Windows needs Developer Mode or an admin shell to make one.
            eprintln!("no symlink permission; skipping the symlink half");
        }

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn tsserver_framing_survives_arbitrary_chunk_boundaries() {
        // Two messages, the second holding a multi-byte character — so the
        // declared length (bytes) and the character count disagree, which is
        // exactly what a naive char-based split gets wrong.
        let bodies = ["{\"seq\":1}", "{\"text\":\"café ✓\"}"];
        let mut wire = Vec::new();
        for body in bodies {
            wire.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
            wire.extend_from_slice(body.as_bytes());
        }

        let mut buf = Vec::new();
        let mut got = Vec::new();
        for byte in &wire {
            buf.push(*byte);
            while let Some(msg) = take_message(&mut buf) {
                got.push(msg);
            }
        }
        assert_eq!(got, bodies);
        assert!(buf.is_empty());
    }

    #[test]
    fn a_header_without_a_length_does_not_stall_the_stream() {
        // It can never become valid, so waiting for it would block every
        // message behind it forever — the same trap `take_utf8` avoids.
        let mut buf = Vec::from(&b"Nonsense: 1\r\n\r\nContent-Length: 5\r\n\r\nhello"[..]);
        assert_eq!(take_message(&mut buf).as_deref(), Some("hello"));
    }

    /// End-to-end through the real thing: spawn tsserver the way `ts_start`
    /// does, open a JSX file with a mistake in it, and read a diagnostic back.
    ///
    /// This is the half where "it compiles" is furthest from "it works" — the
    /// protocol is newline-delimited going in and `Content-Length`-framed
    /// coming out, and nothing in the type system says so.
    #[test]
    fn tsserver_reports_a_type_error_in_a_jsx_file() {
        use std::fs;
        use std::io::Read;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        let root = std::env::temp_dir().join(format!("hearth-ts-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).expect("mkdir");
        // No @types/react and no node_modules here on purpose: `checkJs` alone
        // is what turns an undefined name into a compile error, and that's the
        // finding this phase rests on.
        fs::write(
            root.join("jsconfig.json"),
            r#"{"compilerOptions":{"checkJs":true,"jsx":"react-jsx"},"include":["src"]}"#,
        )
        .unwrap();
        let source = "export function total(items) {\n  return items + missingThing;\n}\n";
        let file = root.join("src/math.js");
        fs::write(&file, source).unwrap();

        let root_s = root.to_string_lossy().to_string();
        let Some(script) = super::tsserver_script(&root_s) else {
            // A packaged build with no bundled tsserver — the app reports this
            // as "not available" rather than as a clean project, and so does
            // this test rather than failing on someone else's machine.
            eprintln!("no tsserver.js found; skipping");
            return;
        };

        let mut child = Command::new("node")
            .arg(&script)
            .arg("--disableAutomaticTypingAcquisition")
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn tsserver");

        let mut stdin = child.stdin.take().unwrap();
        let file_s = file.to_string_lossy().replace('\\', "/");
        for req in [
            format!(
                r#"{{"seq":1,"type":"request","command":"open","arguments":{{"file":"{file_s}","projectRootPath":"{}"}}}}"#,
                root_s.replace('\\', "/")
            ),
            format!(r#"{{"seq":2,"type":"request","command":"geterr","arguments":{{"files":["{file_s}"],"delay":0}}}}"#),
        ] {
            stdin.write_all(req.as_bytes()).unwrap();
            stdin.write_all(b"\n").unwrap();
        }
        stdin.flush().unwrap();

        // Read on a thread so a server that never answers fails the test rather
        // than hanging it — the lesson from the PSReadLine hang next door.
        let mut stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let started = Instant::now();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            let mut buf: Vec<u8> = Vec::new();
            let mut seen = String::new();
            while let Ok(n) = stdout.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                while let Some(msg) = take_message(&mut buf) {
                    seen.push_str(&msg);
                    if msg.contains("semanticDiag") {
                        let _ = tx.send(msg);
                        return;
                    }
                }
            }
            let _ = tx.send(seen);
        });

        // Cold start loads the whole compiler; generous, and it returns as soon
        // as the event arrives.
        let got = rx.recv_timeout(Duration::from_secs(60)).unwrap_or_default();
        let elapsed = started.elapsed();
        let _ = child.kill();
        let _ = child.wait();
        let _ = fs::remove_dir_all(&root);

        assert!(
            got.contains("Cannot find name 'missingThing'"),
            "no type error came back after {:?}; got {:?}",
            elapsed,
            got
        );
    }

    /// The checkpoint sequence `git.ts` drives, against a real repo: init,
    /// baseline, a turn's commit, the name-status a card is built from, both
    /// sides of one file, and the rollback. Everything but the invoke wrapper —
    /// and it's the argument lists that break silently, not the wrapper.
    #[test]
    fn checkpoints_commit_diff_and_roll_back() {
        use std::fs;

        let root = std::env::temp_dir().join(format!("hearth-git-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).expect("mkdir");
        let root_s = root.to_string_lossy().to_string();
        let git = |args: &[&str]| {
            let owned: Vec<String> = args.iter().map(|a| a.to_string()).collect();
            super::git_blocking(&root_s, &owned).expect("git ran")
        };
        let commit = |message: &str| {
            git(&["add", "-A"]);
            git(&[
                "-c",
                "user.name=Hearth",
                "-c",
                "user.email=hearth@localhost",
                "commit",
                "-m",
                message,
            ]);
            git(&["rev-parse", "HEAD"]).stdout.trim().to_string()
        };

        fs::write(root.join("src/a.txt"), "before\n").unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/x.js"), "junk\n").unwrap();

        assert_eq!(git(&["init"]).code, 0);
        fs::write(root.join(".hearth/git/info/exclude"), "node_modules/\n.hearth/\n").unwrap();
        git(&["config", "core.autocrlf", "false"]);
        let baseline = commit("baseline");
        assert_eq!(baseline.len(), 40, "baseline sha: {baseline:?}");
        // Excluded, or `add -A` on a real project checkpoints somebody else's
        // dependency tree — slowly.
        assert!(!git(&["ls-files"]).stdout.contains("node_modules"));

        fs::write(root.join("src/a.txt"), "after\n").unwrap();
        fs::write(root.join("src/b.txt"), "new\n").unwrap();
        let sha = commit("a turn");

        let status = git(&["show", "--name-status", "--format=", &sha]).stdout;
        assert!(status.contains("M\tsrc/a.txt"), "{status}");
        assert!(status.contains("A\tsrc/b.txt"), "{status}");

        // Both sides of a card's diff. A file the commit added has no "before",
        // and git reports that with an exit code rather than empty output —
        // which is the distinction `fileVersions` leans on.
        assert_eq!(git(&["show", &format!("{sha}~:src/a.txt")]).stdout, "before\n");
        assert_eq!(git(&["show", &format!("{sha}:src/a.txt")]).stdout, "after\n");
        assert_ne!(git(&["show", &format!("{sha}~:src/b.txt")]).code, 0);

        assert_eq!(git(&["reset", "--hard", &baseline]).code, 0);
        assert_eq!(fs::read_to_string(root.join("src/a.txt")).unwrap(), "before\n");
        assert!(!root.join("src/b.txt").exists());
        // Untracked files are the user's dependencies and build output. A
        // rollback that deleted node_modules would cost a reinstall.
        assert!(root.join("node_modules/x.js").exists());

        // A turn that changed nothing shows up as empty porcelain. `commit`
        // itself returns non-zero for that *and* for real failures, which is
        // why `commitAll` asks first.
        git(&["add", "-A"]);
        assert!(git(&["status", "--porcelain"]).stdout.trim().is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn pty_output_survives_a_split_multibyte_char() {
        // A PTY stream has no newlines to resync on, so a byte-at-a-time feed
        // is the honest worst case: every multi-byte character arrives split.
        let payload = "ls\r\n📁 café\r\n";
        let mut buf = Vec::new();
        let mut got = String::new();
        for byte in payload.as_bytes() {
            buf.push(*byte);
            if let Some(text) = take_utf8(&mut buf) {
                got.push_str(&text);
            }
        }
        assert_eq!(got, payload);
        assert!(buf.is_empty());
    }

    #[test]
    fn invalid_bytes_do_not_stall_the_stream() {
        // 0xFF is never valid UTF-8 and never will be, however much follows it.
        // Waiting for it to complete would freeze the terminal permanently.
        let mut buf = vec![b'a', 0xFF, b'b'];
        let out = take_utf8(&mut buf).unwrap();
        assert_eq!(out, "a\u{FFFD}");
        assert_eq!(take_utf8(&mut buf).unwrap(), "b");
    }

    /// End-to-end through the real PTY layer: detect a shell, spawn it in a
    /// given cwd, type at it, and read back what it printed. Everything
    /// `pty_open` does apart from the Channel wrapper, which needs a Tauri
    /// runtime to construct — and this is the half where "it compiles" is
    /// furthest from "it works".
    #[test]
    fn a_shell_spawns_and_answers() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        use std::time::{Duration, Instant};

        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");

        let mut cmd = CommandBuilder::new(super::default_shell());
        cmd.cwd(std::env::temp_dir());
        let mut child = pair.slave.spawn_command(cmd).expect("spawn shell");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut writer = pair.master.take_writer().expect("writer");
        writer.write_all(b"echo hearth-pty-ok\r\n").expect("write");
        writer.flush().expect("flush");

        // Read on a thread so a shell that never answers fails the test instead
        // of hanging it.
        let (tx, rx) = std::sync::mpsc::channel();
        let started = Instant::now();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            let mut seen = String::new();
            while let Ok(n) = reader.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                seen.push_str(&String::from_utf8_lossy(&chunk[..n]));

                // PSReadLine opens by asking the terminal where the cursor is
                // (`ESC [ 6 n`) and blocks until something answers. xterm.js
                // replies on its own, which is why this only bites here — but
                // it's also the failure mode if the frontend ever stops
                // answering: pwsh hangs and the pane stays blank forever.
                if let Some(at) = seen.find("\u{1b}[6n") {
                    seen.replace_range(at..at + 4, "");
                    let _ = writer.write_all(b"\x1b[1;1R");
                    let _ = writer.flush();
                }

                // The typed command is echoed back too, so the *second*
                // occurrence is the one the shell actually produced.
                if seen.matches("hearth-pty-ok").count() >= 2 {
                    let _ = tx.send(seen);
                    return;
                }
            }
            let _ = tx.send(seen);
        });

        let got = rx.recv_timeout(Duration::from_secs(20)).unwrap_or_default();
        let elapsed = started.elapsed();
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            got.matches("hearth-pty-ok").count() >= 2,
            "shell never ran the command; got {:?} after {:?}",
            got,
            elapsed
        );
    }

    #[test]
    fn the_package_manager_comes_from_the_lockfile() {
        use std::fs;

        let root = std::env::temp_dir().join(format!("hearth-pm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("mkdir");
        let root_s = root.to_string_lossy().to_string();

        // Nothing to go on: npm, which every Node install has.
        assert_eq!(super::detect_pm(&root_s), "npm");

        for (lock, expected) in [("package-lock.json", "npm"), ("bun.lockb", "bun"), ("yarn.lock", "yarn"), ("pnpm-lock.yaml", "pnpm")] {
            fs::write(root.join(lock), "").unwrap();
            assert_eq!(super::detect_pm(&root_s), expected, "after adding {lock}");
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn only_npm_and_pnpm_get_the_double_dash() {
        // yarn 1 warns about it and bun refuses it, so a `--` sprayed at every
        // manager breaks the two that aren't npm.
        let extra = ["--port", "5173"];
        assert_eq!(super::script_args("npm", "dev", &extra), ["run", "dev", "--", "--port", "5173"]);
        assert_eq!(super::script_args("pnpm", "dev", &extra), ["run", "dev", "--", "--port", "5173"]);
        assert_eq!(super::script_args("yarn", "dev", &extra), ["run", "dev", "--port", "5173"]);
        assert_eq!(super::script_args("bun", "dev", &extra), ["run", "dev", "--port", "5173"]);
        // A script with no arguments never needs the separator.
        assert_eq!(super::script_args("npm", "build", &[]), ["run", "build"]);
    }

    #[test]
    fn search_finds_matches_and_skips_what_it_should() {
        use std::fs;

        let root = std::env::temp_dir().join(format!("hearth-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).expect("mkdir");
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("src/a.js"), "const total = 1;\nexport { total };\n").unwrap();
        fs::write(root.join("src/b.js"), "// nothing here\n").unwrap();
        fs::write(root.join(".env"), "TOTAL_KEY=1\n").unwrap();
        // The two things a search must never drown in.
        fs::write(root.join("node_modules/dep.js"), "total\n").unwrap();
        fs::write(root.join(".git/config"), "total\n").unwrap();

        let root_s = root.to_string_lossy().to_string();
        let hits = super::search_files(root_s.clone(), "TOTAL".into(), 100).expect("search ran");
        let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();

        // Case-insensitive, and a dotfile is project config someone may well be
        // looking for — unlike a dot-directory, which is tooling state.
        assert!(paths.contains(&".env"), "{paths:?}");
        assert_eq!(paths.iter().filter(|p| **p == "src/a.js").count(), 2, "{paths:?}");
        assert!(!paths.iter().any(|p| p.contains("node_modules")), "{paths:?}");
        assert!(!paths.iter().any(|p| p.contains(".git/")), "{paths:?}");

        let first = hits.iter().find(|h| h.path == "src/a.js").unwrap();
        assert_eq!(first.line, 1, "lines are 1-based, like every editor jump");

        // The cap is what stops a common word costing the whole tree.
        assert_eq!(super::search_files(root_s.clone(), "total".into(), 1).unwrap().len(), 1);
        assert!(super::search_files(root_s, "   ".into(), 10).is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn command_check_allows_the_project_toolchain() {
        for ok in ["npm test", "npm run build", "npx tsc --noEmit", "cargo test", "git status", "git diff HEAD"] {
            assert!(super::check_command(ok).is_ok(), "{} should be allowed", ok);
        }
    }

    #[test]
    fn install_on_demand_is_allowed_for_every_package_manager() {
        // The exact string the runner's install chip builds. `add` is the only
        // spelling all four share, and a scoped name has to survive the
        // metacharacter check.
        for manager in ["npm", "pnpm", "yarn", "bun"] {
            assert!(super::check_command(&format!("{manager} add lodash")).is_ok());
            assert!(super::check_command(&format!("{manager} add @tanstack/react-query")).is_ok());
        }
    }

    #[test]
    fn command_check_refuses_chaining_past_an_allowed_program() {
        // The whole reason the allowlist can't just read the first word: every
        // one of these starts with something allowed.
        for bad in [
            "npm test && rm -rf .",
            "npm test; rm -rf .",
            "npm test | sh",
            "npm test > /etc/passwd",
            "npm run $(whoami)",
            "npm test `id`",
        ] {
            assert!(super::check_command(bad).is_err(), "{} should be refused", bad);
        }
    }

    #[test]
    fn command_check_refuses_unlisted_programs_and_paths() {
        assert!(super::check_command("rm -rf .").is_err());
        assert!(super::check_command("curl http://x").is_err());
        assert!(super::check_command("").is_err());
        // A path defeats a name-only check — `./npm` is not the npm we allowed.
        assert!(super::check_command("./npm test").is_err());
        assert!(super::check_command("C:\\evil\\npm.exe test").is_err());
    }

    #[test]
    fn command_check_refuses_git_verbs_that_destroy_work() {
        for bad in ["git push", "git reset --hard", "git clean -fd", "git checkout .", "git"] {
            assert!(super::check_command(bad).is_err(), "{} should be refused", bad);
        }
    }

    #[test]
    fn a_command_runs_and_reports_its_exit_code() {
        let tmp = std::env::temp_dir();
        let tmp = tmp.to_string_lossy();

        let ok = super::run_blocking(&tmp, "node --version", 60).expect("node --version");
        assert_eq!(ok.exit_code, 0);
        assert!(!ok.timed_out);
        assert!(ok.output.trim_start().starts_with('v'), "got {:?}", ok.output);

        // A non-zero exit is the normal case for the thing this tool exists for
        // — a failing test run — so it must come back as output, not an Err.
        let bad = super::run_blocking(&tmp, "node --definitely-not-a-flag", 60).expect("should still return");
        assert_ne!(bad.exit_code, 0);
        assert!(!bad.output.is_empty(), "a failure with no output tells the model nothing");
    }

    #[test]
    fn a_hung_command_is_killed_at_the_timeout() {
        // Without this the whole agent turn hangs on one command. Uses a sleep
        // that needs no quoting, since argv is split on whitespace.
        let tmp = std::env::temp_dir();
        let sleep = if cfg!(windows) { "ping -n 30 127.0.0.1" } else { "sleep 30" };

        let started = std::time::Instant::now();
        let out = super::run_blocking(&tmp.to_string_lossy(), sleep, 2).expect("should return");
        assert!(out.timed_out, "expected a timeout, got exit {}", out.exit_code);
        assert!(started.elapsed() < std::time::Duration::from_secs(20), "kill didn't take effect");
    }

    #[test]
    fn a_lone_truncated_char_waits_for_the_rest() {
        let mut buf = vec![0xF0, 0x9F]; // first half of 📁
        assert_eq!(take_utf8(&mut buf), None);
        buf.extend_from_slice(&[0x93, 0x81]);
        assert_eq!(take_utf8(&mut buf).unwrap(), "📁");
    }

    #[test]
    fn framing_survives_arbitrary_chunk_boundaries() {
        // "café" split mid-UTF-8: naive per-chunk String::from_utf8_lossy
        // would corrupt the é.
        let payload = "{\"a\":1}\n{\"b\":\"café\"}\n{\"c\":3}";
        let bytes = payload.as_bytes();
        let mut buf = Vec::new();
        let mut got = Vec::new();
        for byte in bytes {
            buf.push(*byte);
            got.extend(take_lines(&mut buf));
        }
        assert_eq!(got, vec!["{\"a\":1}", "{\"b\":\"café\"}"]);
        // the unterminated final line stays buffered for the caller's tail flush
        assert_eq!(String::from_utf8_lossy(&buf), "{\"c\":3}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // No migration list: the schema is `CREATE TABLE IF NOT EXISTS` run from
        // the frontend on every open, so it lives in chatsql.ts where the tests
        // can execute the same strings against a real SQLite.
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_text_file,
            write_text_file,
            path_exists,
            ollama_models,
            ollama_ps,
            ollama_unload,
            gpu_total_vram_gb,
            gpu_utilization_pct,
            ollama_chat,
            ollama_cancel,
            ollama_pull,
            run_dev,
            stop_dev,
            package_manager,
            search_files,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            run_command,
            stop_command,
            git,
            ts_start,
            ts_send,
            ts_stop
        ])
        // Closing the window doesn't reap child process trees, and a stray vite
        // holding the port — or a build still running under a dead terminal —
        // survives to break the next run.
        .on_window_event(|_window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let _ = stop_dev();
                let _ = stop_command();
                close_all_ptys();
                let _ = ts_stop();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
