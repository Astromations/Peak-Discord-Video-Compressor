use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Instant;
use tauri::{AppHandle, Manager, State};

// ─── App State ───────────────────────────────────────────────────────────────

struct AppState {
    /// Set to true to request cancellation of the running compression.
    cancel_flag: Arc<AtomicBool>,
    /// Holds the currently running FFmpeg child process so it can be killed.
    active_proc: Arc<Mutex<Option<Child>>>,
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

fn null_device() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

fn check_ffmpeg_available() -> bool {
    which::which("ffmpeg").is_ok() && which::which("ffprobe").is_ok()
}

fn get_media_info(filepath: &str) -> Result<Value, String> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            filepath,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("ffprobe failed to launch: {}", e))?;

    serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("ffprobe output parse error: {}", e))
}

fn parse_time(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        3 => {
            let h: f64 = parts[0].parse().ok()?;
            let m: f64 = parts[1].parse().ok()?;
            let sec: f64 = parts[2].parse().ok()?;
            Some(h * 3600.0 + m * 60.0 + sec)
        }
        2 => {
            let m: f64 = parts[0].parse().ok()?;
            let sec: f64 = parts[1].parse().ok()?;
            Some(m * 60.0 + sec)
        }
        1 => s.parse().ok(),
        _ => None,
    }
}

fn settings_file_path() -> PathBuf {
    let base: PathBuf = if cfg!(windows) {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default())
    } else {
        dirs::home_dir().unwrap_or_default()
    };
    let dir = base.join("Peak");
    fs::create_dir_all(&dir).ok();
    dir.join("settings.json")
}

/// Evaluate JS in the main window — mirrors Python's `window.evaluate_js()`.
/// Used to fire the existing `onItemDone / onItemCancelled / onItemError` callbacks
/// without requiring any frontend changes.
fn eval_js(app: &AppHandle, js: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(js);
    }
}

fn emit_progress(app: &AppHandle, item_id: &str, progress: f64, eta: Option<f64>) {
    let id_json = serde_json::to_string(item_id).unwrap_or_default();
    let eta_json = serde_json::to_string(&eta).unwrap_or("null".into());
    eval_js(
        app,
        &format!("onItemProgress({}, {:.4}, {})", id_json, progress, eta_json),
    );
}

// ─── FFmpeg Pass Runner ───────────────────────────────────────────────────────

/// Runs a single FFmpeg command, streaming progress via `progress_cb`.
/// Returns `Err("CANCELLED")` if the cancel flag was raised.
fn run_pass(
    cmd: &[String],
    duration: f64,
    cancel_flag: Arc<AtomicBool>,
    active_proc: Arc<Mutex<Option<Child>>>,
    mut progress_cb: impl FnMut(f64),
) -> Result<(), String> {
    let mut child = Command::new(&cmd[0])
        .args(&cmd[1..])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn ffmpeg: {}", e))?;

    // Pull stdout out of the child so we can read it while also keeping
    // the child alive in the mutex for cancellation.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not capture ffmpeg stdout".to_string())?;

    {
        let mut guard = active_proc.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }

    let reader = BufReader::new(stdout);
    let prefix = "out_time_us=";

    for line in reader.lines() {
        // Check cancel on every line
        if cancel_flag.load(Ordering::SeqCst) {
            if let Ok(mut guard) = active_proc.lock() {
                if let Some(mut proc) = guard.take() {
                    let _ = proc.kill();
                    let _ = proc.wait();
                }
            }
            return Err("CANCELLED".to_string());
        }

        if let Ok(line) = line {
            let line = line.trim().to_string();
            if line.starts_with(prefix) {
                if let Ok(us) = line[prefix.len()..].parse::<u64>() {
                    let secs = us as f64 / 1_000_000.0;
                    progress_cb((secs / duration).min(1.0));
                }
            }
        }
    }

    // Wait for the process to finish and collect it from the mutex
    let exit_status = {
        let mut guard = active_proc.lock().map_err(|e| e.to_string())?;
        if let Some(mut proc) = guard.take() {
            proc.wait().map_err(|e| e.to_string())?
        } else {
            // Already cleaned up (cancelled mid-flight by another thread)
            return Err("CANCELLED".to_string());
        }
    };

    if cancel_flag.load(Ordering::SeqCst) {
        return Err("CANCELLED".to_string());
    }

    if !exit_status.success() {
        return Err(format!(
            "FFmpeg exited with code {:?}",
            exit_status.code()
        ));
    }

    Ok(())
}

// ─── Commands: Misc ──────────────────────────────────────────────────────────

#[tauri::command]
fn check_ffmpeg() -> bool {
    check_ffmpeg_available()
}

#[tauri::command]
fn save_settings(settings: Value) -> bool {
    match serde_json::to_string(&settings) {
        Ok(s) => fs::write(settings_file_path(), s).is_ok(),
        Err(_) => false,
    }
}

#[tauri::command]
fn load_settings() -> Value {
    fs::read_to_string(settings_file_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Value::Object(Default::default()))
}

#[tauri::command]
fn cancel_compression(state: State<AppState>) -> bool {
    state.cancel_flag.store(true, Ordering::SeqCst);
    if let Ok(mut guard) = state.active_proc.lock() {
        if let Some(proc) = guard.as_mut() {
            let _ = proc.kill();
        }
    }
    true
}

// ─── Commands: Media Info ─────────────────────────────────────────────────────

#[tauri::command]
fn get_thumbnail(filepath: String) -> Option<String> {
    if !check_ffmpeg_available() {
        return None;
    }

    let tmp_path = std::env::temp_dir().join(format!(
        "peak_thumb_{}.jpg",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    ));

    for seek in ["00:00:01", "00:00:00"] {
        let _ = fs::remove_file(&tmp_path); // clean any leftover

        let status = Command::new("ffmpeg")
            .args([
                "-y",
                "-ss",
                seek,
                "-i",
                &filepath,
                "-vframes",
                "1",
                "-vf",
                "scale=320:-1",
                "-q:v",
                "4",
                tmp_path.to_str().unwrap_or(""),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        if status.map(|s| s.success()).unwrap_or(false) {
            if let Ok(data) = fs::read(&tmp_path) {
                if !data.is_empty() {
                    let b64 = BASE64.encode(&data);
                    let _ = fs::remove_file(&tmp_path);
                    return Some(format!("data:image/jpeg;base64,{}", b64));
                }
            }
        }
        let _ = fs::remove_file(&tmp_path);
    }
    None
}

#[derive(Serialize, Deserialize)]
struct AudioTrack {
    index: usize,
    codec: String,
    channels: String,
    language: String,
    title: String,
}

#[tauri::command]
fn get_audio_tracks(filepath: String) -> Vec<AudioTrack> {
    let info = match get_media_info(&filepath) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let empty = vec![];
    let streams = info["streams"].as_array().unwrap_or(&empty);
    let mut tracks = vec![];
    let mut audio_idx = 0usize;

    for stream in streams {
        if stream["codec_type"].as_str() != Some("audio") {
            continue;
        }
        let channels = stream["channels"].as_u64().unwrap_or(0) as u32;
        let ch_label = match channels {
            1 => "Mono".to_string(),
            2 => "Stereo".to_string(),
            6 => "5.1".to_string(),
            8 => "7.1".to_string(),
            n => format!("{}ch", n),
        };
        let tags = &stream["tags"];
        tracks.push(AudioTrack {
            index: audio_idx,
            codec: stream["codec_name"]
                .as_str()
                .unwrap_or("?")
                .to_uppercase(),
            channels: ch_label,
            language: tags["language"].as_str().unwrap_or("").to_string(),
            title: tags["title"].as_str().unwrap_or("").to_string(),
        });
        audio_idx += 1;
    }
    tracks
}

// ─── Commands: Video Serving ─────────────────────────────────────────────────
//
// In pywebview, Peak served videos via a local HTTP server. In Tauri, the
// `asset://` protocol (via `convertFileSrc` on the JS side) handles this
// natively with range-request support. These commands return raw paths; the
// frontend calls `window.__TAURI__.core.convertFileSrc(path)` before using
// them as video `src` values. See COPILOT_PROMPT.md for the JS changes.

#[tauri::command]
fn get_file_url(filepath: String) -> String {
    // Return the raw path — JS wraps it with convertFileSrc()
    filepath
}

#[derive(Serialize)]
struct MixedPreviewResult {
    url: String,
    tmp: Option<String>,
}

#[tauri::command]
fn get_mixed_preview_url(filepath: String) -> MixedPreviewResult {
    let fallback = MixedPreviewResult {
        url: filepath.clone(),
        tmp: None,
    };

    let info = match get_media_info(&filepath) {
        Ok(v) => v,
        Err(_) => return fallback,
    };
    let empty = vec![];
    let streams = info["streams"].as_array().unwrap_or(&empty);
    let n = streams
        .iter()
        .filter(|s| s["codec_type"].as_str() == Some("audio"))
        .count();

    if n <= 1 {
        return MixedPreviewResult {
            url: filepath,
            tmp: None,
        };
    }

    let src_ext = Path::new(&filepath)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");

    let tmp_path = std::env::temp_dir().join(format!(
        "peak_preview_{}.{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0),
        src_ext
    ));

    let filter_in: String = (0..n).map(|i| format!("[0:a:{}]", i)).collect();
    let amix = format!("{}amix=inputs={}:normalize=0[aout]", filter_in, n);

    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-i",
            &filepath,
            "-filter_complex",
            &amix,
            "-map",
            "0:v",
            "-map",
            "[aout]",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            tmp_path.to_str().unwrap_or(""),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    let tmp_str = tmp_path.to_string_lossy().to_string();

    if status.map(|s| s.success()).unwrap_or(false)
        && tmp_path.metadata().map(|m| m.len() > 0).unwrap_or(false)
    {
        MixedPreviewResult {
            url: tmp_str.clone(),
            tmp: Some(tmp_str),
        }
    } else {
        let _ = fs::remove_file(&tmp_path);
        MixedPreviewResult {
            url: filepath,
            tmp: None,
        }
    }
}

#[tauri::command]
fn delete_temp_file(tmp_path: String) {
    if !tmp_path.is_empty() {
        let _ = fs::remove_file(&tmp_path);
    }
}

// ─── Commands: File / System Operations ──────────────────────────────────────

#[tauri::command]
fn open_file(filepath: String) {
    #[cfg(target_os = "windows")]
    {
        let norm = filepath.replace('/', "\\");
        let _ = Command::new("explorer")
            .args(["/select,", &norm])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").args(["-R", &filepath]).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let dir = Path::new(&filepath)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or(filepath);
        let _ = Command::new("xdg-open").arg(&dir).spawn();
    }
}

#[tauri::command]
fn open_in_media_player(filepath: String) -> bool {
    if !Path::new(&filepath).is_file() {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/c", "start", "", &filepath])
            .spawn()
            .is_ok()
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(&filepath).spawn().is_ok()
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open").arg(&filepath).spawn().is_ok()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    false
}

#[tauri::command]
fn open_url(url: String) {
    #[cfg(target_os = "windows")]
    let _ = Command::new("cmd").args(["/c", "start", "", &url]).spawn();
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "linux")]
    let _ = Command::new("xdg-open").arg(&url).spawn();
}

#[tauri::command]
fn rename_file(old_path: String, new_name: String) -> Option<String> {
    let old = Path::new(&old_path);
    if !old.is_file() {
        return None;
    }
    let new_path = old.parent()?.join(&new_name);
    if new_path.exists() {
        return None; // don't overwrite existing files
    }
    fs::rename(old, &new_path).ok()?;
    Some(new_path.to_string_lossy().to_string())
}

#[tauri::command]
fn resolve_dropped_path(filename: String) -> Option<String> {
    let path = Path::new(&filename);
    if path.is_absolute() && path.is_file() {
        return Some(filename);
    }

    let basename = path.file_name()?.to_string_lossy().to_string();
    let home = dirs::home_dir()?;
    let search_dirs = vec![
        home.clone(),
        home.join("Desktop"),
        home.join("Downloads"),
        home.join("Videos"),
        home.join("Movies"),
        home.join("Documents"),
    ];

    // First pass: top-level of each search dir
    for dir in &search_dirs {
        let candidate = dir.join(&basename);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }

    // Second pass: one level of sub-directories
    for dir in &search_dirs {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                if entry
                    .file_type()
                    .map(|t| t.is_dir())
                    .unwrap_or(false)
                {
                    let candidate = entry.path().join(&basename);
                    if candidate.is_file() {
                        return Some(candidate.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    None
}

// ─── Commands: Window Controls ───────────────────────────────────────────────

#[tauri::command]
fn window_minimize(app: AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.minimize().is_ok())
        .unwrap_or(false)
}

#[tauri::command]
fn window_toggle_maximize(app: AppHandle) -> bool {
    if let Some(w) = app.get_webview_window("main") {
        let is_max = w.is_maximized().unwrap_or(false);
        if is_max {
            w.unmaximize().is_ok()
        } else {
            w.maximize().is_ok()
        }
    } else {
        false
    }
}

#[tauri::command]
fn window_close(app: AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.close().is_ok())
        .unwrap_or(false)
}

#[tauri::command]
fn set_window_fullscreen(app: AppHandle, enabled: bool) -> bool {
    app.get_webview_window("main")
        .map(|w| w.set_fullscreen(enabled).is_ok())
        .unwrap_or(false)
}

// ─── Commands: File Dialogs ───────────────────────────────────────────────────

#[tauri::command]
async fn open_file_dialog(app: AppHandle) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(
            "Video Files",
            &["mp4", "mkv", "mov", "avi", "webm"],
        )
        .pick_files(move |result| {
            let _ = tx.send(result);
        });

    rx.await
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
async fn pick_directory(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |result| {
        let _ = tx.send(result);
    });

    rx.await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

// ─── Commands: Compression ────────────────────────────────────────────────────

#[tauri::command]
fn compress(
    app: AppHandle,
    state: State<AppState>,
    item_id: String,
    filepath: String,
    target_size_mb: f64,
    audio_kbps: u32,
    use_gpu: bool,
    combine_audio: bool,
    two_pass: bool,
    output_dir: Option<String>,
    format_ext: String,
    trim_start: Option<String>,
    trim_end: Option<String>,
    enabled_tracks: Option<Vec<usize>>,
) {
    // Reset cancel flag before starting
    state.cancel_flag.store(false, Ordering::SeqCst);

    let cancel_flag = state.cancel_flag.clone();
    let active_proc = state.active_proc.clone();

    std::thread::spawn(move || {
        match do_compress(
            &app,
            &item_id,
            &filepath,
            target_size_mb,
            audio_kbps,
            use_gpu,
            combine_audio,
            two_pass,
            output_dir.as_deref(),
            &format_ext,
            trim_start.as_deref(),
            trim_end.as_deref(),
            enabled_tracks.as_deref(),
            cancel_flag,
            active_proc,
        ) {
            Ok(output_file) => {
                let id_json = serde_json::to_string(&item_id).unwrap_or_default();
                let path_json = serde_json::to_string(&output_file).unwrap_or_default();
                eval_js(&app, &format!("onItemDone({}, {})", id_json, path_json));
            }
            Err(e) if e == "CANCELLED" => {
                let id_json = serde_json::to_string(&item_id).unwrap_or_default();
                eval_js(
                    &app,
                    &format!("onItemCancelled({}, \"Compression cancelled\")", id_json),
                );
            }
            Err(e) => {
                let id_json = serde_json::to_string(&item_id).unwrap_or_default();
                let err_json = serde_json::to_string(&e).unwrap_or_default();
                eval_js(&app, &format!("onItemError({}, {})", id_json, err_json));
            }
        }
    });
}

#[allow(clippy::too_many_arguments)]
fn do_compress(
    app: &AppHandle,
    item_id: &str,
    input_file: &str,
    target_size_mb: f64,
    audio_kbps: u32,
    use_gpu: bool,
    combine_audio: bool,
    two_pass: bool,
    output_dir: Option<&str>,
    format_ext: &str,
    trim_start: Option<&str>,
    trim_end: Option<&str>,
    enabled_tracks: Option<&[usize]>,
    cancel_flag: Arc<AtomicBool>,
    active_proc: Arc<Mutex<Option<Child>>>,
) -> Result<String, String> {
    if !Path::new(input_file).is_file() {
        return Err(format!("File not found: {}", input_file));
    }

    let info = get_media_info(input_file)?;
    let duration: f64 = info["format"]["duration"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "Could not read video duration".to_string())?;

    let t_start = trim_start.and_then(parse_time);
    let t_end = trim_end.and_then(parse_time);

    let eff_start = t_start.unwrap_or(0.0);
    let eff_end = t_end.map(|e| e.min(duration)).unwrap_or(duration);
    let eff_duration = (eff_end - eff_start).max(0.1);

    // ── Output format ────────────────────────────────────────────────────────
    let src_ext = Path::new(input_file)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");
    let out_ext = if format_ext == "original" {
        format!(".{}", src_ext)
    } else {
        format!(".{}", format_ext)
    };
    let use_webm = out_ext == ".webm";

    // ── Bitrate budget ───────────────────────────────────────────────────────
    let target_bits = target_size_mb * 8.0 * 1024.0 * 1024.0 * 0.96; // 4% safety margin

    let empty = vec![];
    let all_streams = info["streams"].as_array().unwrap_or(&empty);
    let n_audio = all_streams
        .iter()
        .filter(|s| s["codec_type"].as_str() == Some("audio"))
        .count();

    let active: Vec<usize> = match enabled_tracks {
        Some(tracks) if !tracks.is_empty() => {
            tracks.iter().filter(|&&i| i < n_audio).copied().collect()
        }
        _ => (0..n_audio).collect(),
    };
    let n_active = active.len();

    let audio_stream_count: usize = if n_active == 0 {
        0
    } else if combine_audio && n_active > 1 {
        1
    } else {
        n_active
    };

    let audio_bits = audio_kbps as f64 * 1000.0 * eff_duration * audio_stream_count as f64;
    let mut video_bitrate =
        ((target_bits - audio_bits) / eff_duration).max(50_000.0) as u64;

    // Safety valve: overshoot protection for short clips
    let estimated_overhead_bits = if eff_duration < 10.0 {
        (2_000_000.0_f64).max(500_000.0 + 100_000.0 * eff_duration) * 8.0
    } else {
        (500_000.0 + 50_000.0 * eff_duration) * 8.0
    };
    let estimated_output_bits =
        video_bitrate as f64 * eff_duration + audio_bits + estimated_overhead_bits;

    if estimated_output_bits > target_bits {
        let safety_buffer = target_bits * 0.03;
        let available = target_bits - audio_bits - safety_buffer;
        video_bitrate = (available / eff_duration).max(50_000.0) as u64;
    }

    // ── Output path ──────────────────────────────────────────────────────────
    let stem = Path::new(input_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let base_name = format!("{}_compressed{}", stem, out_ext);
    let out_dir = output_dir
        .filter(|d| Path::new(d).is_dir())
        .map(|d| d.to_string())
        .unwrap_or_else(|| {
            Path::new(input_file)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        });
    let output_file = Path::new(&out_dir)
        .join(&base_name)
        .to_string_lossy()
        .to_string();

    // ── FFmpeg argument blocks ────────────────────────────────────────────────
    let mut seek_args: Vec<String> = vec![];
    if let Some(ts) = t_start {
        seek_args.extend(["-ss".into(), ts.to_string()]);
    }

    let mut dur_args: Vec<String> = vec![];
    if t_start.is_some() || t_end.is_some() {
        dur_args.extend(["-t".into(), eff_duration.to_string()]);
    }

    let audio_map: Vec<String> = if combine_audio && n_active > 1 {
        let filter_in: String = active.iter().map(|i| format!("[0:a:{}]", i)).collect();
        vec![
            "-filter_complex".into(),
            format!(
                "{}amix=inputs={}:dropout_transition=0[aout]",
                filter_in, n_active
            ),
            "-map".into(),
            "0:v".into(),
            "-map".into(),
            "[aout]".into(),
        ]
    } else if n_active > 0 {
        let mut m = vec!["-map".into(), "0:v".into()];
        for i in &active {
            m.extend(["-map".into(), format!("0:a:{}", i)]);
        }
        m
    } else {
        vec!["-map".into(), "0:v".into()]
    };

    let audio_encode: Vec<String> = if n_active > 0 {
        if use_webm {
            vec![
                "-c:a".into(),
                "libopus".into(),
                "-b:a".into(),
                format!("{}k", audio_kbps),
            ]
        } else {
            vec![
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                format!("{}k", audio_kbps),
            ]
        }
    } else {
        vec![]
    };

    let bv = video_bitrate.to_string();
    let bv_flags: Vec<String> = vec![
        "-b:v".into(),
        bv.clone(),
        "-maxrate".into(),
        bv.clone(),
        "-bufsize".into(),
        (video_bitrate * 2).to_string(),
    ];

    let faststart: Vec<String> = if !use_webm {
        vec!["-movflags".into(), "+faststart".into()]
    } else {
        vec![]
    };

    let passlog = std::env::temp_dir()
        .join(format!("peak_pass_{}", item_id))
        .to_string_lossy()
        .to_string();

    let (p1_codec, p2_codec, s_codec): (Vec<String>, Vec<String>, Vec<String>) = if use_webm {
        (
            vec![
                "-c:v".into(), "libvpx-vp9".into(),
                "-pass".into(), "1".into(),
                "-passlogfile".into(), passlog.clone(),
            ],
            vec![
                "-c:v".into(), "libvpx-vp9".into(),
                "-pass".into(), "2".into(),
                "-passlogfile".into(), passlog.clone(),
            ],
            vec!["-c:v".into(), "libvpx-vp9".into()],
        )
    } else if use_gpu {
        (
            vec!["-c:v".into(), "h264_nvenc".into(), "-rc".into(), "vbr".into(), "-2pass".into(), "1".into()],
            vec!["-c:v".into(), "h264_nvenc".into(), "-rc".into(), "vbr".into(), "-2pass".into(), "1".into()],
            vec!["-c:v".into(), "h264_nvenc".into()],
        )
    } else {
        (
            vec![
                "-c:v".into(), "libx264".into(),
                "-pass".into(), "1".into(),
                "-passlogfile".into(), passlog.clone(),
            ],
            vec![
                "-c:v".into(), "libx264".into(),
                "-pass".into(), "2".into(),
                "-passlogfile".into(), passlog.clone(),
            ],
            vec!["-c:v".into(), "libx264".into()],
        )
    };

    let base_args: Vec<String> = vec![
        "ffmpeg".into(), "-y".into(),
        "-progress".into(), "pipe:1".into(),
        "-nostats".into(),
    ];

    // ── Run passes ───────────────────────────────────────────────────────────
    if two_pass {
        // ── Pass 1 ──────────────────────────────────────────────────────────
        let p1: Vec<String> = [
            base_args.clone(),
            seek_args.clone(),
            vec!["-i".into(), input_file.to_string()],
            dur_args.clone(),
            p1_codec,
            bv_flags.clone(),
            vec![
                "-map".into(), "0:v".into(),
                "-an".into(),
                "-f".into(), "null".into(),
                null_device().to_string(),
            ],
        ]
        .concat();

        {
            let app_c = app.clone();
            let id = item_id.to_string();
            run_pass(&p1, eff_duration, cancel_flag.clone(), active_proc.clone(), move |f| {
                emit_progress(&app_c, &id, f * 0.5, None);
            })?;
        }

        // ── Pass 2 ──────────────────────────────────────────────────────────
        let p2: Vec<String> = [
            base_args,
            seek_args,
            vec!["-i".into(), input_file.to_string()],
            dur_args,
            p2_codec,
            bv_flags,
            audio_map,
            audio_encode,
            faststart,
            vec![output_file.clone()],
        ]
        .concat();

        let start_time = Instant::now();
        {
            let app_c = app.clone();
            let id = item_id.to_string();
            run_pass(&p2, eff_duration, cancel_flag, active_proc, move |f| {
                let remaining = if f > 0.02 {
                    let elapsed = start_time.elapsed().as_secs_f64();
                    Some(elapsed / f * (1.0 - f))
                } else {
                    None
                };
                emit_progress(&app_c, &id, 0.5 + f * 0.5, remaining);
            })?;
        }

        // Clean up passlog files
        for suffix in ["-0.log", "-0.log.mbtree"] {
            let _ = fs::remove_file(format!("{}{}", passlog, suffix));
        }
    } else {
        // ── Single pass ──────────────────────────────────────────────────────
        let sc: Vec<String> = [
            base_args,
            seek_args,
            vec!["-i".into(), input_file.to_string()],
            dur_args,
            s_codec,
            bv_flags,
            audio_map,
            audio_encode,
            faststart,
            vec![output_file.clone()],
        ]
        .concat();

        let start_time = Instant::now();
        {
            let app_c = app.clone();
            let id = item_id.to_string();
            run_pass(&sc, eff_duration, cancel_flag, active_proc, move |f| {
                let remaining = if f > 0.02 {
                    let elapsed = start_time.elapsed().as_secs_f64();
                    Some(elapsed / f * (1.0 - f))
                } else {
                    None
                };
                emit_progress(&app_c, &id, f, remaining);
            })?;
        }
    }

    Ok(output_file)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            cancel_flag: Arc::new(AtomicBool::new(false)),
            active_proc: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            // FFmpeg
            check_ffmpeg,
            get_thumbnail,
            get_audio_tracks,
            // Video serving
            get_file_url,
            get_mixed_preview_url,
            delete_temp_file,
            // Settings
            save_settings,
            load_settings,
            // Compression
            compress,
            cancel_compression,
            // File & system ops
            open_file,
            open_in_media_player,
            open_url,
            rename_file,
            resolve_dropped_path,
            // Dialogs
            open_file_dialog,
            pick_directory,
            // Window controls
            window_minimize,
            window_toggle_maximize,
            window_close,
            set_window_fullscreen,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Peak");
}
