import os
import sys
import subprocess
import json
import shutil
import threading
import base64
import tempfile
import time
import re
import socket
import mimetypes
import urllib.parse
import webview

try:
    from http.server import BaseHTTPRequestHandler, HTTPServer
except ImportError:
    from BaseHTTPServer import BaseHTTPRequestHandler, HTTPServer


def resource_path(relative):
    if hasattr(sys, "_MEIPASS"):
        return os.path.join(sys._MEIPASS, relative)
    return os.path.join(os.path.dirname(__file__), relative)


def check_ffmpeg():
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def get_media_info(filepath):
    cmd = ["ffprobe", "-v", "error", "-print_format", "json",
           "-show_format", "-show_streams", filepath]
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        creationflags=cf()          # ← fixes CMD window flash on Windows
    )
    return json.loads(result.stdout)


def null_device():
    return "NUL" if os.name == "nt" else "/dev/null"


def cf():
    return subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


class CompressionCancelled(Exception):
    pass


def run_pass(cmd, duration, progress_cb, should_cancel=None, on_process_change=None):
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             text=True, creationflags=cf())
    if on_process_change:
        on_process_change(proc)
    pattern = re.compile(r"^out_time_us=(\d+)$")
    try:
        while True:
            if should_cancel and should_cancel():
                try:
                    proc.terminate()
                    proc.wait(timeout=2)
                except Exception:
                    try:
                        proc.kill()
                    except Exception:
                        pass
                raise CompressionCancelled("Compression cancelled")

            line = proc.stdout.readline()
            if line == "":
                if proc.poll() is not None:
                    break
                continue

            m = pattern.match(line.strip())
            if m:
                try:
                    secs = int(m.group(1)) / 1_000_000
                    progress_cb(min(secs / duration, 1.0))
                except (ValueError, ZeroDivisionError):
                    pass

        proc.wait()
        if should_cancel and should_cancel():
            raise CompressionCancelled("Compression cancelled")
        if proc.returncode != 0:
            raise RuntimeError(f"FFmpeg exited with code {proc.returncode}")
    finally:
        if on_process_change:
            on_process_change(None)


def get_settings_file_path():
    if os.name == "nt":
        base_dir = os.environ.get("APPDATA") or os.path.expanduser("~")
    else:
        base_dir = os.path.expanduser("~")
    settings_dir = os.path.join(base_dir, "Peak")
    os.makedirs(settings_dir, exist_ok=True)
    return os.path.join(settings_dir, "settings.json")


def parse_time(s):
    s = s.strip()
    if not s:
        return None
    parts = s.split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        elif len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        else:
            return float(s)
    except ValueError:
        return None


# ─── Local video HTTP server ────────────────────────────────────────────────
# pywebview's webview cannot load file:// URIs for <video> reliably on all
# backends.  We spin up a tiny localhost server that serves local files with
# proper byte-range support (required for video seeking).

def _find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


_VIDEO_PORT = _find_free_port()


class _VideoHandler(BaseHTTPRequestHandler):
    """Minimal HTTP server for serving local video files with range support."""

    def do_GET(self):
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        filepath = urllib.parse.unquote(qs.get("f", [""])[0])

        if not os.path.isfile(filepath):
            self.send_response(404)
            self.end_headers()
            return

        size = os.path.getsize(filepath)
        mime = mimetypes.guess_type(filepath)[0] or "video/mp4"
        range_hdr = self.headers.get("Range", "")

        try:
            if range_hdr and range_hdr.startswith("bytes="):
                parts = range_hdr[6:].split("-")
                start = int(parts[0])
                end   = int(parts[1]) if parts[1] else size - 1
                end   = min(end, size - 1)
                length = end - start + 1

                self.send_response(206)
                self.send_header("Content-Type",  mime)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Content-Length", str(length))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()

                with open(filepath, "rb") as fh:
                    fh.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = fh.read(min(65536, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            else:
                self.send_response(200)
                self.send_header("Content-Type",   mime)
                self.send_header("Content-Length",  str(size))
                self.send_header("Accept-Ranges",  "bytes")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                with open(filepath, "rb") as fh:
                    while True:
                        chunk = fh.read(65536)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass   # client disconnected — normal for video seeking

    def log_message(self, *args):
        pass  # suppress console output


def _start_video_server():
    server = HTTPServer(("127.0.0.1", _VIDEO_PORT), _VideoHandler)
    server.serve_forever()


threading.Thread(target=_start_video_server, daemon=True).start()
# ────────────────────────────────────────────────────────────────────────────


class Api:

    def __init__(self):
        self._window = None
        self._settings_file = get_settings_file_path()
        self._active_proc = None
        self._active_proc_lock = threading.Lock()
        self._cancel_flag = threading.Event()

    def _set_active_proc(self, proc):
        with self._active_proc_lock:
            self._active_proc = proc

    def save_settings(self, settings):
        try:
            if not isinstance(settings, dict):
                return False
            with open(self._settings_file, "w", encoding="utf-8") as f:
                json.dump(settings, f)
            return True
        except Exception:
            return False

    def load_settings(self):
        try:
            if not os.path.isfile(self._settings_file):
                return {}
            with open(self._settings_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def cancel_compression(self):
        self._cancel_flag.set()
        with self._active_proc_lock:
            proc = self._active_proc
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
        return True

    def check_ffmpeg(self):
        return check_ffmpeg()

    def open_file_dialog(self):
        try:
            result = self._window.create_file_dialog(
                webview.OPEN_DIALOG, allow_multiple=True,
                file_types=("Video Files (*.mp4;*.mkv;*.mov;*.avi;*.webm)",))
            # pywebview may return None (cancelled), a tuple, or a list depending
            # on the backend — normalise everything to a plain list so JS always
            # receives an array and the promise never hangs.
            if not result:
                return []
            return [p for p in result if p]
        except Exception:
            return []

    def pick_directory(self):
        # Use OPEN_DIALOG so the user gets the same modern explorer UI as
        # the Add Videos action, then derive the target directory.
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=("All Files (*.*)",),
        )
        if not result:
            return None
        picked = result[0] if isinstance(result, (list, tuple)) else result
        if not picked:
            return None
        if os.path.isdir(picked):
            return picked
        return os.path.dirname(picked)

    def open_file(self, filepath):
        try:
            if os.name == "nt":
                subprocess.Popen(["explorer", "/select,", os.path.normpath(filepath)],
                                 creationflags=cf())
            elif sys.platform == "darwin":
                subprocess.Popen(["open", "-R", filepath])
            else:
                subprocess.Popen(["xdg-open", os.path.dirname(filepath)])
        except Exception:
            pass

    def get_thumbnail(self, filepath):
        if not check_ffmpeg():
            return None
        for seek in ("00:00:01", "00:00:00"):
            try:
                tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
                tmp_path = tmp.name
                tmp.close()
                subprocess.run(
                    ["ffmpeg", "-y", "-ss", seek, "-i", filepath,
                     "-vframes", "1", "-vf", "scale=320:-1", "-q:v", "4", tmp_path],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=cf())
                if os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 0:
                    with open(tmp_path, "rb") as f:
                        data = base64.b64encode(f.read()).decode()
                    os.unlink(tmp_path)
                    return f"data:image/jpeg;base64,{data}"
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass
            except Exception:
                pass
        return None

    def get_audio_tracks(self, filepath):
        """Return list of audio stream info for the trim modal."""
        try:
            info = get_media_info(filepath)
            tracks = []
            audio_idx = 0
            for stream in info.get("streams", []):
                if stream.get("codec_type") == "audio":
                    tags = stream.get("tags", {})
                    channels = stream.get("channels", 0)
                    ch_label = {1: "Mono", 2: "Stereo", 6: "5.1", 8: "7.1"}.get(channels, f"{channels}ch")
                    tracks.append({
                        "index":    audio_idx,
                        "codec":    stream.get("codec_name", "?").upper(),
                        "channels": ch_label,
                        "language": tags.get("language", ""),
                        "title":    tags.get("title", ""),
                    })
                    audio_idx += 1
            return tracks
        except Exception:
            return []

    def get_file_url(self, filepath):
        """Return a localhost URL for the video element — works on all pywebview backends."""
        encoded = urllib.parse.quote(filepath, safe="")
        return f"http://127.0.0.1:{_VIDEO_PORT}/?f={encoded}"

    def get_mixed_preview_url(self, filepath):
        """Remux the file with all audio tracks mixed to one stream for preview.
        Video is stream-copied (no re-encode) so this is fast.
        Returns (url, tmp_path) — caller is responsible for deleting tmp_path on close."""
        try:
            info    = get_media_info(filepath)
            streams = [s for s in info["streams"] if s["codec_type"] == "audio"]
            n       = len(streams)

            if n <= 1:
                # Single track — serve directly, no temp file needed
                encoded = urllib.parse.quote(filepath, safe="")
                return {"url": f"http://127.0.0.1:{_VIDEO_PORT}/?f={encoded}", "tmp": None}

            src_ext = os.path.splitext(filepath)[1].lower() or ".mp4"
            tmp     = tempfile.NamedTemporaryFile(suffix=src_ext, delete=False)
            tmp_path = tmp.name
            tmp.close()

            filter_in  = "".join(f"[0:a:{i}]" for i in range(n))
            amix_filter = f"{filter_in}amix=inputs={n}:normalize=0[aout]"

            cmd = [
                "ffmpeg", "-y",
                "-i", filepath,
                "-filter_complex", amix_filter,
                "-map", "0:v", "-map", "[aout]",
                "-c:v", "copy",
                "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart",
                tmp_path
            ]
            subprocess.run(cmd,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=cf())

            if not os.path.exists(tmp_path) or os.path.getsize(tmp_path) == 0:
                # ffmpeg failed — fall back to direct serve
                encoded = urllib.parse.quote(filepath, safe="")
                return {"url": f"http://127.0.0.1:{_VIDEO_PORT}/?f={encoded}", "tmp": None}

            encoded = urllib.parse.quote(tmp_path, safe="")
            return {"url": f"http://127.0.0.1:{_VIDEO_PORT}/?f={encoded}", "tmp": tmp_path}
        except Exception:
            encoded = urllib.parse.quote(filepath, safe="")
            return {"url": f"http://127.0.0.1:{_VIDEO_PORT}/?f={encoded}", "tmp": None}

    def delete_temp_file(self, tmp_path):
        """Remove a temp preview file created by get_mixed_preview_url."""
        try:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)
        except Exception:
            pass

    def open_url(self, url):
        """Open a URL in the system default browser."""
        try:
            if os.name == "nt":
                subprocess.Popen(["cmd", "/c", "start", "", url],
                                 creationflags=cf())
            elif sys.platform == "darwin":
                subprocess.Popen(["open", url])
            else:
                subprocess.Popen(["xdg-open", url])
        except Exception:
            pass

    def rename_file(self, old_path, new_name):
        """Rename a compressed output file. Returns the new full path, or None on failure."""
        try:
            if not os.path.isfile(old_path):
                return None
            directory = os.path.dirname(old_path)
            new_path = os.path.join(directory, new_name)
            if os.path.exists(new_path):
                return None  # don't overwrite existing files
            os.rename(old_path, new_path)
            return new_path
        except Exception:
            return None

    def resolve_dropped_path(self, filename):
        """Attempt to resolve a dropped filename to a full path.

        Some pywebview backends pass the full absolute path in the drag event;
        others pass only the bare filename.  We handle both cases:
          1. If 'filename' is already an absolute path that exists, return it.
          2. Otherwise, search common user directories (non-recursively first,
             then one level of sub-directories) for a matching basename.
        """
        # Case 1 — backend already gave us the full path
        if os.path.isabs(filename) and os.path.isfile(filename):
            return filename

        # Case 2 — only the bare name was passed; search common locations
        basename = os.path.basename(filename)  # safe even if it already is a basename
        home = os.path.expanduser("~")
        search_dirs = [
            home,
            os.path.join(home, "Desktop"),
            os.path.join(home, "Downloads"),
            os.path.join(home, "Videos"),
            os.path.join(home, "Movies"),
            os.path.join(home, "Documents"),
        ]

        # First pass: check top-level of each directory
        for d in search_dirs:
            candidate = os.path.join(d, basename)
            if os.path.isfile(candidate):
                return candidate

        # Second pass: one level of sub-directories (catches nested folders)
        for d in search_dirs:
            try:
                for entry in os.scandir(d):
                    if entry.is_dir(follow_symlinks=False):
                        candidate = os.path.join(entry.path, basename)
                        if os.path.isfile(candidate):
                            return candidate
            except PermissionError:
                pass

        return None

    def compress(self, item_id, filepath, target_size_mb, audio_kbps,
                 use_gpu, combine_audio, two_pass, output_dir,
                 format_ext, trim_start, trim_end, enabled_tracks):
        def _run():
            try:
                self._cancel_flag.clear()
                self._do_compress(item_id, filepath, target_size_mb, audio_kbps,
                                  use_gpu, combine_audio, two_pass, output_dir,
                                  format_ext, trim_start, trim_end, enabled_tracks)
            except CompressionCancelled:
                self._emit("onItemCancelled", item_id, "Compression cancelled")
            except Exception as e:
                self._emit("onItemError", item_id, str(e))
        threading.Thread(target=_run, daemon=True).start()

    def _do_compress(self, item_id, input_file, target_size_mb, audio_kbps,
                     use_gpu, combine_audio, two_pass, output_dir,
                     format_ext, trim_start, trim_end, enabled_tracks):

        if not os.path.isfile(input_file):
            raise FileNotFoundError(f"File not found: {input_file}")

        info     = get_media_info(input_file)
        duration = float(info["format"]["duration"])

        t_start = parse_time(trim_start) if trim_start else None
        t_end   = parse_time(trim_end)   if trim_end   else None

        eff_start    = t_start or 0.0
        eff_end      = min(t_end, duration) if t_end else duration
        eff_duration = max(eff_end - eff_start, 0.1)
        
        print(f"[COMPRESS {item_id}] Target={target_size_mb}MB, Full duration={duration:.2f}s, trim_start={trim_start}, trim_end={trim_end}, eff_duration={eff_duration:.2f}s")

        src_ext = os.path.splitext(input_file)[1].lower()
        out_ext = src_ext if format_ext == "original" else f".{format_ext}"
        use_webm = out_ext == ".webm"

        target_bits   = target_size_mb * 8 * 1024 * 1024 * 0.96  # 4% safety margin — container/muxer overhead eats ~1-2%, leave extra headroom for Discord's strict limit
        audio_streams = [s for s in info["streams"] if s["codec_type"] == "audio"]
        n_audio       = len(audio_streams)

        if enabled_tracks is not None and len(enabled_tracks) > 0:
            active = [i for i in enabled_tracks if i < n_audio]
        else:
            active = list(range(n_audio))

        n_active = len(active)

        # Audio budget must reflect how many tracks are encoded:
        # - combined tracks => 1 output audio stream
        # - separate tracks => one stream per active track
        if n_active == 0:
            audio_stream_count = 0
        elif combine_audio and n_active > 1:
            audio_stream_count = 1
        else:
            audio_stream_count = n_active

        audio_bits    = audio_kbps * 1000 * eff_duration * audio_stream_count
        video_bitrate = max(int((target_bits - audio_bits) / eff_duration), 50_000)

        # Safety valve: for short clips, codec overhead dominates and can cause overshoot.
        # Estimate output size and reduce bitrate if needed to stay under target.
        # Overhead estimate: much higher for very short clips (container overhead + keyframes)
        # For short clips (<10s), overhead can be 1-2MB+ due to container structure & initial keyframes
        if eff_duration < 10:
            # For very short clips, use aggressive overhead estimate
            estimated_overhead_bits = max(2_000_000, 500_000 + (100_000 * eff_duration)) * 8
        else:
            estimated_overhead_bits = (500_000 + (50_000 * eff_duration)) * 8
        
        estimated_output_bits = (video_bitrate * eff_duration) + audio_bits + estimated_overhead_bits
        print(f"[BITRATE] Initial: target={target_bits / 8 / 1e6:.2f}MB, audio={audio_bits / 8 / 1e6:.2f}MB ({audio_stream_count} stream(s)), overhead_est={estimated_overhead_bits / 8 / 1e6:.2f}MB")
        print(f"[BITRATE] Initial video_bitrate={video_bitrate/1e6:.2f}Mbps, estimated_output={estimated_output_bits / 8 / 1e6:.2f}MB")
        
        if estimated_output_bits > target_bits:
            # Scale down video bitrate to fit within target, leaving room for audio & overhead
            safety_buffer = int(target_bits * 0.08)  # Reserve 8% for overhead (was 5%)
            available_for_video = target_bits - audio_bits - safety_buffer
            video_bitrate = max(int(available_for_video / eff_duration), 50_000)
            print(f"[BITRATE] OVERSHOOT DETECTED! Scaling down: video_bitrate={video_bitrate/1e6:.2f}Mbps")

        base_name   = os.path.splitext(os.path.basename(input_file))[0] + "_compressed" + out_ext
        out_dir     = output_dir if (output_dir and os.path.isdir(output_dir)) \
                      else os.path.dirname(input_file)
        output_file = os.path.join(out_dir, base_name)

        seek_args = ["-ss", str(t_start)] if t_start is not None else []
        # Use explicit clip duration instead of "-to" to avoid ambiguity when
        # a start offset is present. This guarantees a true (end-start) segment.
        dur_args  = ["-t", str(eff_duration)] if (t_start is not None or t_end is not None) else []

        if combine_audio and n_active > 1:
            filter_in = "".join(f"[0:a:{i}]" for i in active)
            audio_map = [
                "-filter_complex",
                f"{filter_in}amix=inputs={n_active}:dropout_transition=0[aout]",
                "-map", "0:v", "-map", "[aout]",
            ]
        elif n_active > 0:
            audio_map = ["-map", "0:v"] + [x for i in active for x in ["-map", f"0:a:{i}"]]
        else:
            audio_map = ["-map", "0:v"]

        if use_webm:
            audio_encode = ["-c:a", "libopus", "-b:a", f"{audio_kbps}k"] if n_active > 0 else []
        else:
            audio_encode = ["-c:a", "aac", "-b:a", f"{audio_kbps}k"] if n_active > 0 else []

        bv       = str(video_bitrate)
        bv_flags = ["-b:v", bv, "-maxrate", bv, "-bufsize", str(video_bitrate * 2)]
        faststart = ["-movflags", "+faststart"] if not use_webm else []

        passlog    = os.path.join(tempfile.gettempdir(), f"peak_pass_{item_id}")
        start_time = [0.0]

        if use_webm:
            p1_codec = ["-c:v", "libvpx-vp9", "-pass", "1", "-passlogfile", passlog]
            p2_codec = ["-c:v", "libvpx-vp9", "-pass", "2", "-passlogfile", passlog]
            s_codec  = ["-c:v", "libvpx-vp9"]
        elif use_gpu:
            p1_codec = ["-c:v", "h264_nvenc", "-rc", "vbr", "-2pass", "1"]
            p2_codec = ["-c:v", "h264_nvenc", "-rc", "vbr", "-2pass", "1"]
            s_codec  = ["-c:v", "h264_nvenc"]
        else:
            p1_codec = ["-c:v", "libx264", "-pass", "1", "-passlogfile", passlog]
            p2_codec = ["-c:v", "libx264", "-pass", "2", "-passlogfile", passlog]
            s_codec  = ["-c:v", "libx264"]

        def progress_cb(half, raw_frac):
            overall = half * 0.5 + raw_frac * 0.5
            remaining = None
            if half == 1 and raw_frac > 0.02:
                elapsed   = time.time() - start_time[0]
                remaining = (elapsed / raw_frac) * (1.0 - raw_frac)
            self._emit_progress(item_id, overall, remaining)

        def single_progress_cb(raw_frac):
            remaining = None
            if raw_frac > 0.02:
                elapsed   = time.time() - start_time[0]
                remaining = (elapsed / raw_frac) * (1.0 - raw_frac)
            self._emit_progress(item_id, raw_frac, remaining)

        base_args = ["ffmpeg", "-y", "-progress", "pipe:1", "-nostats"]

        if two_pass:
            p1 = base_args + seek_args + ["-i", input_file] + dur_args + p1_codec + bv_flags + \
                 ["-map", "0:v", "-an", "-f", "null", null_device()]
            p2 = base_args + seek_args + ["-i", input_file] + dur_args + p2_codec + bv_flags + \
                 audio_map + audio_encode + faststart + [output_file]

            print(f"[FFMPEG P1] {' '.join(p1)}")
            print(f"[FFMPEG P2] {' '.join(p2)}")

            run_pass(
                p1,
                eff_duration,
                lambda f: progress_cb(0, f),
                should_cancel=self._cancel_flag.is_set,
                on_process_change=self._set_active_proc,
            )
            start_time[0] = time.time()
            run_pass(
                p2,
                eff_duration,
                lambda f: progress_cb(1, f),
                should_cancel=self._cancel_flag.is_set,
                on_process_change=self._set_active_proc,
            )

            for ext in ("-0.log", "-0.log.mbtree"):
                try:
                    os.unlink(passlog + ext)
                except OSError:
                    pass
        else:
            sc = base_args + seek_args + ["-i", input_file] + dur_args + s_codec + bv_flags + \
                 audio_map + audio_encode + faststart + [output_file]
            print(f"[FFMPEG SINGLE] {' '.join(sc)}")
            start_time[0] = time.time()
            run_pass(
                sc,
                eff_duration,
                single_progress_cb,
                should_cancel=self._cancel_flag.is_set,
                on_process_change=self._set_active_proc,
            )

        self._emit("onItemDone", item_id, output_file)

    def _emit(self, fn, *args):
        payload = ", ".join(json.dumps(a) for a in args)
        self._window.evaluate_js(f"{fn}({payload})")

    def _emit_progress(self, item_id, progress, eta):
        self._window.evaluate_js(
            f"onItemProgress({json.dumps(item_id)}, {progress:.4f}, {json.dumps(eta)})")


if __name__ == "__main__":
    api = Api()
    window = webview.create_window(
        title="Peak - Discord Video Compressor",
        url=resource_path("index.html"),
        js_api=api,
        width=900, height=720,
        min_size=(600, 550),
        resizable=True,
        background_color="#313338",
        frameless=False,
        draggable=True,          # enables pywebviewdragdrop events for file drop
    )
    api._window = window
    webview.start(debug=False, func=lambda: window.maximize())
