import asyncio
import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Callable, Coroutine, Any

from ingestion.providers import get_ytdlp_cmd


def _run_ytdlp_with_cookie_fallback(args: list[str]) -> subprocess.CompletedProcess:
    """Run yt-dlp command, falling back to alternative player clients and browser cookies if YouTube requests authentication."""
    full_args = list(args)
    if "--extractor-args" not in full_args:
        full_args = full_args[:1] + ["--extractor-args", "youtube:player_client=ios,android,mweb,web"] + full_args[1:]

    res = subprocess.run(full_args, capture_output=True, text=True)
    if res.returncode == 0:
        return res

    # Try alternate player clients
    clients = ["mweb,web", "android,ios", "web_embedded,mweb", "tv,mweb"]
    for client in clients:
        alt_args = list(args)
        alt_args = alt_args[:1] + ["--extractor-args", f"youtube:player_client={client}"] + alt_args[1:]
        res_alt = subprocess.run(alt_args, capture_output=True, text=True)
        if res_alt.returncode == 0:
            return res_alt

    # Fallback to browser cookies
    browsers = ["chrome", "edge", "firefox", "brave", "vivaldi", "opera"]
    for browser in browsers:
        try:
            cookie_args = list(full_args) + ["--cookies-from-browser", browser]
            fallback_res = subprocess.run(cookie_args, capture_output=True, text=True)
            if fallback_res.returncode == 0:
                return fallback_res
        except Exception:
            continue

    return res


def fetch_metadata(url: str) -> dict:
    """Fetch track metadata (title, uploader, duration) synchronously via yt-dlp."""
    cmd = get_ytdlp_cmd()
    args = [cmd, "--dump-json", "--no-playlist", url]
    res = _run_ytdlp_with_cookie_fallback(args)
    if res.returncode != 0:
        raise RuntimeError(f"Metadata extraction failed: {res.stderr[:400]}")
    return json.loads(res.stdout)


def write_mp3_tags(path: Path, title: str, artist: str) -> bool:
    """Atomically update title/artist tags without re-encoding audio."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or not path.exists() or path.suffix.lower() != ".mp3":
        return False

    temp_path = path.with_name(f"{path.stem}.metadata-tmp.mp3")
    try:
        result = subprocess.run(
            [
                ffmpeg, "-y", "-i", str(path), "-map", "0", "-codec", "copy",
                "-metadata", f"title={title}", "-metadata", f"artist={artist}",
                "-id3v2_version", "3", str(temp_path),
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0 or not temp_path.exists():
            return False
        temp_path.replace(path)
        return True
    finally:
        if temp_path.exists():
            try:
                temp_path.unlink()
            except OSError:
                pass


def download_audio_track(
    target_url: str,
    out_path: Path,
    track_id: int,
    loop: asyncio.AbstractEventLoop,
    progress_callback: Callable[[int, float, str], Coroutine[Any, Any, None]],
    log_callback: Callable[[str, str, int], None] = None,
):
    """Download audio track via yt-dlp, convert to MP3, and stream real-time progress events."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        if log_callback:
            log_callback("ERROR", "FFmpeg executable not found on system PATH.", track_id)
        raise RuntimeError("FFmpeg executable not found on system PATH.")

    cmd = get_ytdlp_cmd()
    ffmpeg_dir = str(Path(ffmpeg).parent)

    base_cmd = [
        cmd,
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "192K",
        "--embed-metadata",
        "--sponsorblock-remove",
        "intro,outro",
        "--ffmpeg-location",
        ffmpeg_dir,
        "-o",
        str(out_path.with_suffix(".%(ext)s")),
        "--newline",
        "--no-playlist",
        target_url,
    ]

    def execute_popen(command_args):
        return subprocess.Popen(
            command_args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    if log_callback:
        log_callback("INFO", f"Executing download for track #{track_id}...", track_id)

    process = execute_popen(base_cmd)
    progress_regex = re.compile(r"\[download\]\s+(\d+(?:\.\d+)?)%")
    last_logged_pct = -10

    while True:
        line = process.stdout.readline()
        if not line:
            break
        line_str = line.strip()
        match = progress_regex.search(line_str)
        if match:
            pct = float(match.group(1))
            total_pct = 25.0 + (pct * 0.6)
            asyncio.run_coroutine_threadsafe(
                progress_callback(track_id, total_pct, f"Downloading: {pct:.0f}%"),
                loop,
            )
            if log_callback and int(pct) >= last_logged_pct + 25:
                last_logged_pct = int(pct)
                log_callback("INFO", f"Track #{track_id} download progress: {pct:.0f}%", track_id)
        elif "Extracting audio" in line_str or "ffmpeg" in line_str.lower():
            if log_callback:
                log_callback("INFO", f"Track #{track_id}: Converting audio to MP3...", track_id)
            asyncio.run_coroutine_threadsafe(
                progress_callback(track_id, 90.0, "Converting to MP3..."),
                loop,
            )
        elif line_str and not line_str.startswith("[download]"):
            if log_callback and ("ERROR" in line_str or "WARNING" in line_str):
                log_level = "ERROR" if "ERROR" in line_str else "WARNING"
                log_callback(log_level, f"Track #{track_id}: {line_str}", track_id)

    process.wait()
    if process.returncode != 0:
        err_text = process.stderr.read()
        
        # Check if error requires YouTube sign-in / cookies
        if "Sign in to confirm" in err_text or "bot" in err_text.lower() or "cookies" in err_text.lower():
            browsers = ["chrome", "edge", "firefox", "brave", "vivaldi"]
            for browser in browsers:
                if log_callback:
                    log_callback("WARNING", f"Track #{track_id}: YouTube auth required. Trying browser cookies ({browser})...", track_id)
                asyncio.run_coroutine_threadsafe(
                    progress_callback(track_id, 30.0, f"Authenticating via {browser.capitalize()}..."),
                    loop,
                )
                cookie_cmd = list(base_cmd) + ["--cookies-from-browser", browser]
                cb_proc = execute_popen(cookie_cmd)
                while True:
                    cb_line = cb_proc.stdout.readline()
                    if not cb_line:
                        break
                    cb_match = progress_regex.search(cb_line.strip())
                    if cb_match:
                        pct = float(cb_match.group(1))
                        asyncio.run_coroutine_threadsafe(
                            progress_callback(track_id, 25.0 + (pct * 0.6), f"Downloading ({browser}): {pct:.0f}%"),
                            loop,
                        )
                cb_proc.wait()
                if cb_proc.returncode == 0:
                    if log_callback:
                        log_callback("INFO", f"Track #{track_id}: Download succeeded using {browser} cookies!", track_id)
                    return
            err_msg = f"Download requires YouTube sign in. Please sign into YouTube in Chrome/Edge/Firefox: {err_text[:250]}"
            if log_callback:
                log_callback("ERROR", f"Track #{track_id}: {err_msg}", track_id)
            raise RuntimeError(err_msg)
        err_msg = f"Download failed: {err_text[:400]}"
        if log_callback:
            log_callback("ERROR", f"Track #{track_id}: {err_msg}", track_id)
        raise RuntimeError(err_msg)
    
    if log_callback:
        log_callback("INFO", f"Track #{track_id} audio download & conversion completed.", track_id)
