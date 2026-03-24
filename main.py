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


def run_pass(cmd, duration, progress_cb):
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             text=True, creationflags=cf())
    pattern = re.compile(r"^out_time_us=(\d+)$")
    for line in proc.stdout:
        m = pattern.match(line.strip())
        if m:
            try:
                secs = int(m.group(1)) / 1_000_000
                progress_cb(min(secs / duration, 1.0))
            except (ValueError, ZeroDivisionError):
                pass
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg exited with code {proc.returncode}")


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

    def check_ffmpeg(self):
        return check_ffmpeg()

    def open_file_dialog(self):
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG, allow_multiple=True,
            file_types=("Video Files (*.mp4;*.mkv;*.mov;*.avi;*.webm)",))
        return list(result) if result else []

    def pick_directory(self):
        result = self._window.create_file_dialog(webview.FOLDER_DIALOG)
        return result[0] if result else None

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

    def compress(self, item_id, filepath, target_size_mb, audio_kbps,
                 use_gpu, combine_audio, two_pass, output_dir,
                 format_ext, trim_start, trim_end, enabled_tracks):
        def _run():
            try:
                self._do_compress(item_id, filepath, target_size_mb, audio_kbps,
                                  use_gpu, combine_audio, two_pass, output_dir,
                                  format_ext, trim_start, trim_end, enabled_tracks)
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

        audio_bits    = audio_kbps * 1000 * eff_duration
        video_bitrate = max(int((target_bits - audio_bits) / eff_duration), 50_000)

        base_name   = os.path.splitext(os.path.basename(input_file))[0] + "_compressed" + out_ext
        out_dir     = output_dir if (output_dir and os.path.isdir(output_dir)) \
                      else os.path.dirname(input_file)
        output_file = os.path.join(out_dir, base_name)

        seek_args = ["-ss", str(t_start)] if t_start is not None else []
        to_args   = ["-to", str(t_end)]   if t_end   is not None else []

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
            p1 = base_args + seek_args + ["-i", input_file] + to_args + p1_codec + bv_flags + \
                 ["-map", "0:v", "-an", "-f", "null", null_device()]
            p2 = base_args + seek_args + ["-i", input_file] + to_args + p2_codec + bv_flags + \
                 audio_map + audio_encode + faststart + [output_file]

            run_pass(p1, eff_duration, lambda f: progress_cb(0, f))
            start_time[0] = time.time()
            run_pass(p2, eff_duration, lambda f: progress_cb(1, f))

            for ext in ("-0.log", "-0.log.mbtree"):
                try:
                    os.unlink(passlog + ext)
                except OSError:
                    pass
        else:
            sc = base_args + seek_args + ["-i", input_file] + to_args + s_codec + bv_flags + \
                 audio_map + audio_encode + faststart + [output_file]
            start_time[0] = time.time()
            run_pass(sc, eff_duration, single_progress_cb)

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
        title="Peak — Video Compressor",
        url=resource_path("index.html"),
        js_api=api,
        width=500, height=660,
        min_size=(420, 500),
        resizable=True,
        background_color="#313338",
        frameless=False
    )
    api._window = window
    webview.start(debug=False, func=lambda: window.maximize())
