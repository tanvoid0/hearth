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

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("{}: {}", path, e))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{}: {}", parent.display(), e))?;
    }
    fs::write(&path, contents).map_err(|e| format!("{}: {}", path, e))
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

/// Total VRAM in GB, or `None` when we can't tell — no NVIDIA GPU, no driver,
/// or a machine where this shells out to nothing.
///
/// Deliberately shells out to `nvidia-smi` rather than taking an NVML crate:
/// the binary ships with the driver, and the one number wanted here doesn't
/// justify a dependency that would still only cover one vendor.
///
/// This reports *capacity*, never a prediction. Disk size doesn't predict a
/// model's VRAM footprint — measured on this machine it ranges from 0.35× to
/// 1.21× — so anything that multiplied a `/api/tags` size by a guess would
/// steer users away from models that fit fine.
#[tauri::command]
fn gpu_total_vram_gb() -> Option<f64> {
    let mut cmd = Command::new("nvidia-smi");
    cmd.args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"]);
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
    let mib: f64 = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().parse().ok()?;
    Some(mib * 1024.0 * 1024.0 / 1e9)
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

#[tauri::command]
async fn ollama_chat(body: serde_json::Value, on_chunk: Channel<String>) -> Result<(), String> {
    ollama_stream("api/chat", body, on_chunk).await
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

fn npm(root: &str, args: &[&str]) -> Command {
    // npm is a .cmd shim on Windows, which CreateProcess won't launch
    // directly. Going through cmd also gives `taskkill /T` a parent to walk
    // when stopping, since vite ends up a grandchild.
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.arg("/C").arg("npm").args(args);
        c.creation_flags(CREATE_NO_WINDOW); // no console flash on every spawn
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("npm");
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

/// Start (installing first if needed) the project's dev server and return the
/// port it was told to listen on. Returns as soon as the process is spawned —
/// `npm install` on a cold project runs for minutes, so readiness is reported
/// through the event channel, not by making the caller wait here.
#[tauri::command]
fn run_dev(root: String, on_event: Channel<String>) -> Result<u16, String> {
    stop_dev()?;
    let port = free_port()?;

    std::thread::spawn(move || {
        let fail = |msg: String| {
            let _ = on_event.send(format!("{} {}", MARK, msg));
        };

        if !Path::new(&root).join("node_modules").exists() {
            let _ = on_event.send("$ npm install".into());
            match run_to_end(npm(&root, &["install"]), &on_event) {
                Ok(0) => {}
                Ok(code) => return fail(format!("npm install failed (exit {})", code)),
                Err(e) => return fail(format!("npm install could not start: {}", e)),
            }
        }

        let port = port.to_string();
        let args = ["run", "dev", "--", "--port", &port, "--strictPort"];
        let _ = on_event.send(format!("$ npm {}", args.join(" ")));
        match run_to_end(npm(&root, &args), &on_event) {
            Ok(code) => fail(format!("dev server exited (code {})", code)),
            Err(e) => fail(format!("dev server could not start: {}", e)),
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

        // Read on threads: waiting on a child while its pipes fill deadlocks.
        let out = child.stdout.take().map(drain);
        let err = child.stderr.take().map(drain);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
        let mut timed_out = false;
        let exit_code = loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => break status.code().unwrap_or(-1),
                None if std::time::Instant::now() >= deadline => {
                    // Kill the tree: `npm test` is a shim around the runner, and
                    // killing the shim leaves the runner holding the pipes open,
                    // so the drain threads would never finish.
                    let _ = kill_tree(pid);
                    let _ = child.wait();
                    timed_out = true;
                    break -1;
                }
                None => std::thread::sleep(std::time::Duration::from_millis(50)),
            }
        };

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
    use super::{take_lines, take_utf8};
    use std::io::Write;

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
    fn command_check_allows_the_project_toolchain() {
        for ok in ["npm test", "npm run build", "npx tsc --noEmit", "cargo test", "git status", "git diff HEAD"] {
            assert!(super::check_command(ok).is_ok(), "{} should be allowed", ok);
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
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_text_file,
            write_text_file,
            ollama_models,
            ollama_ps,
            ollama_unload,
            gpu_total_vram_gb,
            ollama_chat,
            ollama_pull,
            run_dev,
            stop_dev,
            pty_open,
            pty_write,
            pty_resize,
            pty_close,
            run_command,
            git
        ])
        // Closing the window doesn't reap child process trees, and a stray vite
        // holding the port — or a build still running under a dead terminal —
        // survives to break the next run.
        .on_window_event(|_window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let _ = stop_dev();
                close_all_ptys();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
