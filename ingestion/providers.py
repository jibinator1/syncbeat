import asyncio
import json
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path


UNKNOWN_ARTIST_VALUES = {"", "unknown", "unknown artist", "various artists", "n/a", "none"}


def is_unknown_artist(artist: str | None) -> bool:
    """Return whether an artist value is a placeholder rather than usable metadata."""
    return not artist or artist.strip().casefold() in UNKNOWN_ARTIST_VALUES


def clean_artist_name(artist: str) -> str:
    """Clean raw uploader name (e.g. 'Artist - Topic' -> 'Artist', 'ArtistVEVO' -> 'Artist')."""
    if is_unknown_artist(artist):
        return "Unknown Artist"
    cleaned = artist
    cleaned = re.sub(r"\s*-\s*topic$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"vevo$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*official$", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip() or artist


def spotify_track_entry(raw_title: str, raw_artist: str, playlist_title: str) -> dict | None:
    """Build a canonical Spotify entry, refusing incomplete metadata.

    Spotify is the source of truth for Spotify imports. A missing field must
    never become an anonymous download that later gets guessed from YouTube.
    """
    title = (raw_title or "").strip()
    artist = (raw_artist or "").strip()
    if not title or title.casefold() in {"unknown", "unknown track"} or is_unknown_artist(artist):
        print(f"[SPOTIFY EXTRACT] Skipping item with incomplete metadata: title={title!r}, artist={artist!r}")
        return None
    return {
        # Search several candidates; the Spotify artist/title remains canonical
        # in the database regardless of the selected YouTube uploader.
        "url": f"ytsearch5:{artist} - {title} official audio",
        "title": title,
        "artist": artist,
        "playlist_title": playlist_title,
        "metadata_source": "spotify",
    }


def _first_metadata_value(value) -> str:
    """Turn yt-dlp's string/list metadata shapes into one usable text value."""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (list, tuple)):
        values = [str(item).strip() for item in value if str(item).strip()]
        return ", ".join(values)
    return ""


def parse_artist_from_title(title: str) -> tuple[str, str]:
    """Conservatively parse common 'Artist - Track' titles as a last fallback."""
    if not title:
        return "", title
    match = re.match(r"^\s*([^\-–—|]{2,100}?)\s*[-–—|]\s*(.{2,200})\s*$", title)
    if not match:
        return "", title
    candidate_artist, candidate_title = (part.strip() for part in match.groups())
    # A generic video label is not an artist, so leave it untouched.
    if is_unknown_artist(candidate_artist) or candidate_artist.casefold() in {"official video", "lyrics", "audio", "music"}:
        return "", title
    return clean_artist_name(candidate_artist), clean_track_title(candidate_title, candidate_artist)


def resolve_youtube_metadata(info: dict) -> tuple[str, str, str]:
    """Resolve artist/title from yt-dlp fields, preserving a source label for diagnostics."""
    raw_title = (info.get("track") or info.get("title") or "Unknown Track").strip()
    # Embedded music metadata is authoritative. Generic uploader names are not:
    # a fan/repost channel is often unrelated to the artist.
    for field in ("artist", "artists", "album_artist", "creator"):
        value = _first_metadata_value(info.get(field))
        if not is_unknown_artist(value):
            artist = clean_artist_name(value)
            return artist, clean_track_title(raw_title, artist), field

    parsed_artist, parsed_title = parse_artist_from_title(raw_title)
    if parsed_artist:
        return parsed_artist, parsed_title, "title"

    # Topic and VEVO channels are official music sources. Other uploader names
    # remain review candidates instead of becoming a potentially wrong artist.
    for field in ("uploader", "channel"):
        value = _first_metadata_value(info.get(field))
        value_lower = value.casefold()
        if not is_unknown_artist(value) and ("- topic" in value_lower or value_lower.endswith("vevo")):
            artist = clean_artist_name(value)
            return artist, clean_track_title(raw_title, artist), field

    return "Unknown Artist", clean_track_title(raw_title), "unknown"


def clean_track_title(title: str, artist: str = "") -> str:
    """Clean raw video titles by removing tags like [Official Lyric Video], [Explicit], by [Artist], etc."""
    if not title:
        return "Unknown Track"

    cleaned = title

    # Remove 'by [Artist] Music', 'by [Artist]', '- [Artist] Oficial', '- [Artist]', etc.
    if artist and artist.lower() != "unknown artist":
        escaped_artist = re.escape(artist)
        cleaned = re.sub(r"[\(\[]?\s*by\s+" + escaped_artist + r"(?:\s+music)?\s*[\)\]]?", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"[\(\[]?\s*-\s*" + escaped_artist + r"(?:\s+oficial)?\s*[\)\]]?", "", cleaned, flags=re.IGNORECASE)

    patterns = [
        r"[\(\[]?\s*official\s+lyric\s+video\s*[\)\]]?",
        r"[\(\[]?\s*lyric\s+video\s*[\)\]]?",
        r"[\(\[]?\s*official\s+music\s+video\s*[\)\]]?",
        r"[\(\[]?\s*official\s+video\s*[\)\]]?",
        r"[\(\[]?\s*music\s+video\s*[\)\]]?",
        r"[\(\[]?\s*official\s+audio\s*[\)\]]?",
        r"[\(\[]?\s*\baudio\b\s*[\)\]]?",
        r"[\(\[]?\s*audio\s+oficial\s*[\)\]]?",
        r"[\(\[]?\s*oficial\s*[\)\]]?",
        r"[\(\[]?\s*full\s+version\s*[\)\]]?",
        r"[\(\[]?\s*\bexplicit\b\s*[\)\]]?",
        r"[\(\[]?\s*\bhd\b\s*[\)\]]?",
        r"[\(\[]?\s*\bhq\b\s*[\)\]]?",
        r"[\(\[]?\s*(?<!\d)4k(?!\w)\s*[\)\]]?",
        r"[\(\[]?\s*remastered(?:\s+\d{4})?\s*[\)\]]?",
    ]
    for pat in patterns:
        cleaned = re.sub(pat, "", cleaned, flags=re.IGNORECASE)

    # Balance opening and closing parentheses
    open_p = cleaned.count("(")
    close_p = cleaned.count(")")
    if open_p > close_p:
        cleaned = cleaned + ")" * (open_p - close_p)
    elif close_p > open_p:
        for _ in range(close_p - open_p):
            if cleaned.endswith(")"):
                cleaned = cleaned[:-1].rstrip()
            elif "(" not in cleaned:
                cleaned = cleaned.replace(")", "")

    open_b = cleaned.count("[")
    close_b = cleaned.count("]")
    if open_b > close_b:
        cleaned = cleaned + "]" * (open_b - close_b)
    elif close_b > open_b:
        for _ in range(close_b - open_b):
            if cleaned.endswith("]"):
                cleaned = cleaned[:-1].rstrip()
            elif "[" not in cleaned:
                cleaned = cleaned.replace("]", "")

    cleaned = re.sub(r"\s+", " ", cleaned).strip(" -_\t\n\r")
    return cleaned or title


def select_best_youtube_candidate(entries: list[dict], target_artist: str, target_title: str) -> dict:
    """Score and select the best candidate entry from ytsearch top results."""
    if not entries:
        return {}

    best_entry = None
    best_score = -999

    norm_artist = target_artist.lower().strip()
    norm_title = target_title.lower().strip()

    for entry in entries:
        score = 0
        uploader = (entry.get("artist") or entry.get("uploader") or "").strip()
        uploader_lower = uploader.lower()
        v_title = entry.get("title", "").strip()
        v_title_lower = v_title.lower()

        # 1. Topic Channel (Highest Priority - Official Studio Audio)
        if uploader_lower.endswith("- topic") or "- topic" in uploader_lower:
            score += 100
            if norm_artist in uploader_lower:
                score += 50

        # 2. Official Artist Channel / VEVO
        elif norm_artist in uploader_lower or "vevo" in uploader_lower or "official" in uploader_lower:
            score += 80

        # 3. Fan upload penalty
        else:
            score -= 50

        # 4. Title relevance
        if norm_title in v_title_lower:
            score += 30
        if norm_artist in v_title_lower:
            score += 20

        # 5. Negative filters for live / reaction / cover videos
        unwanted_terms = ["live", "concert", "performance", "cover", "reaction", "review", "short film", "teaser", "trailer"]
        for term in unwanted_terms:
            if term in v_title_lower and term not in norm_title:
                score -= 100

        # Mild lyric video penalty if official audio exists
        if "lyric" in v_title_lower and "lyric" not in norm_title:
            score -= 20

        if score > best_score:
            best_score = score
            best_entry = entry

    return best_entry or entries[0]


def sanitize_filename(name: str) -> str:
    """Sanitize track titles for safe cross-platform file saving."""
    return re.sub(r'[<>:"/\\|?*]', "_", name)[:200]


def extract_urls_from_text(text: str) -> list[str]:
    """Extract all HTTP/HTTPS links from raw text, preserving order while deduplicating."""
    if not text:
        return []
    raw_urls = re.findall(r"https?://[^\s,;\"'<>]+", text)
    seen = set()
    urls = []
    for u in raw_urls:
        u_clean = u.rstrip(").,;")
        if u_clean and u_clean not in seen:
            seen.add(u_clean)
            urls.append(u_clean)
    return urls


def detect_url_type(url: str) -> str:
    """Classify incoming URL or text input."""
    raw_stripped = url.strip()
    if "\n" in raw_stripped or "\r" in raw_stripped:
        return "multiline"
    urls = extract_urls_from_text(url)
    if len(urls) > 1:
        return "multiline"
    if "spotify.com" in url:
        return "spotify"
    if "playlist" in url or "list=" in url:
        return "yt_playlist"
    return "yt_single"


def _extract_multiline_urls_sync(text: str) -> list[dict]:
    """Process multiple track links or song search queries found in multiline input text."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    entries = []
    seen = set()

    for line in lines:
        urls = extract_urls_from_text(line)
        targets = urls if urls else [line]

        for target in targets:
            if target in seen:
                continue
            seen.add(target)

            if target.startswith("http://") or target.startswith("https://"):
                u_type = "spotify" if "spotify.com" in target else ("yt_playlist" if ("playlist" in target or "list=" in target) else "yt_single")
                try:
                    if u_type == "spotify":
                        e_list = _extract_spotify_embed_sync(target)
                        entries.extend(e_list)
                    elif u_type == "yt_playlist":
                        e_list = _extract_playlist_urls_sync(target)
                        entries.extend(e_list)
                    else:
                        entries.append({
                            "url": target,
                            "title": "Unknown Track",
                            "artist": "Unknown Artist",
                            "playlist_title": "Batch Paste Import",
                        })
                except Exception as err:
                    print(f"[MULTILINE BATCH] Failed to extract {target}: {err}")
                    entries.append({
                        "url": target,
                        "title": "Unknown Track",
                        "artist": "Unknown Artist",
                        "playlist_title": "Batch Paste Import",
                    })
            else:
                # Text query string like "Playboi Carti - Magnolia"
                query = f"ytsearch5:{target}"
                entries.append({
                    "url": query,
                    "title": target,
                    "artist": "Unknown Artist",
                    "playlist_title": "Batch Paste Import",
                })
    return entries


async def extract_multiline_urls(text: str) -> list[dict]:
    """Extract multiline URLs asynchronously."""
    return await asyncio.to_thread(_extract_multiline_urls_sync, text)



def get_ytdlp_cmd() -> str:
    """Locate yt-dlp executable in system PATH or python virtual environment."""
    ytdlp = shutil.which("yt-dlp")
    if ytdlp:
        return ytdlp
    venv_ytdlp = Path(sys.executable).parent / "yt-dlp.exe"
    if venv_ytdlp.exists():
        return str(venv_ytdlp)
    return "yt-dlp"


def _extract_playlist_urls_sync(url: str) -> list[dict]:
    cmd = get_ytdlp_cmd()
    res = subprocess.run(
        [cmd, "--flat-playlist", "--dump-json", "--no-warnings", url],
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        raise RuntimeError(f"Playlist extraction failed: {res.stderr[:500]}")

    entries = []
    for line in res.stdout.strip().split("\n"):
        if not line.strip():
            continue
        try:
            info = json.loads(line)
        except json.JSONDecodeError:
            continue

        v_id = info.get("id") or info.get("url", "")
        if "v=" in v_id:
            v_id = v_id.split("v=")[-1].split("&")[0]
        elif "/" in v_id:
            v_id = v_id.split("/")[-1]

        video_url = (
            f"https://www.youtube.com/watch?v={v_id}"
            if v_id
            else (info.get("webpage_url") or info.get("url"))
        )
        raw_title = info.get("title", "Unknown Track")
        uploader = clean_artist_name(info.get("uploader") or info.get("channel") or "Unknown Artist")
        entries.append({
            "url": video_url,
            "title": clean_track_title(raw_title, uploader),
            "artist": uploader,
            "playlist_title": info.get("playlist_title", "YouTube Playlist"),
        })
    return entries


async def extract_playlist_urls(url: str) -> list[dict]:
    """Extract YouTube playlist entries asynchronously using thread execution."""
    return await asyncio.to_thread(_extract_playlist_urls_sync, url)


def _extract_spotify_embed_sync(url: str) -> list[dict]:
    """Parse Spotify embed page HTML to extract track metadata instantly without blocking network searches."""
    match = re.search(r"(playlist|album|track)/([a-zA-Z0-9]+)", url)
    if not match:
        raise ValueError("Invalid Spotify URL format")

    item_type, item_id = match.groups()
    embed_url = f"https://open.spotify.com/embed/{item_type}/{item_id}"

    req = urllib.request.Request(
        embed_url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
    )
    html = urllib.request.urlopen(req, timeout=10).read().decode("utf-8")

    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html)
    if not m:
        raise RuntimeError("Failed to parse Spotify embed page metadata")

    data = json.loads(m.group(1))
    entity = data.get("props", {}).get("pageProps", {}).get("state", {}).get("data", {}).get("entity", {})

    entries = []

    if item_type == "track":
        title = entity.get("title") or entity.get("name")
        artists = entity.get("artists", [])
        artist = ", ".join([a.get("name") for a in artists if a.get("name")]) if artists else entity.get("subtitle")
        entry = spotify_track_entry(title, artist, "Spotify Single")
        if entry:
            entries.append(entry)
    else:
        playlist_title = entity.get("name") or entity.get("title") or "Spotify Playlist"
        track_list = entity.get("trackList", [])
        for t in track_list:
            t_title = t.get("title") or t.get("name")
            t_artists = t.get("artists", [])
            t_artist = ", ".join([a.get("name") for a in t_artists if a.get("name")]) if t_artists else t.get("subtitle")
            entry = spotify_track_entry(t_title, t_artist, playlist_title)
            if entry:
                entries.append(entry)

    if not entries:
        raise RuntimeError("No tracks found in Spotify URL")

    # If playlist has >= 90 tracks, Spotify embed view limits HTML payload to 99-100 tracks.
    # We fetch an access token via Spotify ClientCredentials or token endpoint to paginate all tracks seamlessly.
    if len(entries) >= 90 and item_type in ("playlist", "album"):

        try:
            print(f"[SPOTIFY EXTRACT] Playlist contains 100+ tracks. Obtaining Spotify Web API access token...")
            access_token = None

            # Attempt 1: Fetch client access token via Spotipy ClientCredentials (if SPOTIPY_CLIENT_ID configured or public fallback)
            import os
            client_id = os.getenv("SPOTIPY_CLIENT_ID", "d8a5ed958d274c2e87c2e7845489619f")
            client_secret = os.getenv("SPOTIPY_CLIENT_SECRET")

            if client_id and client_secret:
                try:
                    import spotipy
                    from spotipy.oauth2 import SpotifyClientCredentials
                    sp_auth = SpotifyClientCredentials(client_id=client_id, client_secret=client_secret)
                    access_token = sp_auth.get_access_token(as_dict=False)
                except Exception as sp_err:
                    print(f"[SPOTIFY EXTRACT] Spotipy Auth failed: {sp_err}")

            # Attempt 2: Fetch public web token via Spotify Embed token API
            if not access_token:
                try:
                    token_req = urllib.request.Request(
                        "https://open.spotify.com/get_access_token?reason=transport&productType=web_player",
                        headers={
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                            "App-Platform": "WebPlayer",
                            "Referer": "https://open.spotify.com/",
                        },
                    )
                    token_res = json.loads(urllib.request.urlopen(token_req, timeout=5).read().decode("utf-8"))
                    access_token = token_res.get("accessToken")
                except Exception:
                    pass

            if access_token:
                full_entries = []
                offset = 0
                limit = 100
                playlist_title = entity.get("name") or "Spotify Playlist"

                while True:
                    api_url = f"https://api.spotify.com/v1/playlists/{item_id}/tracks?offset={offset}&limit={limit}"
                    api_req = urllib.request.Request(
                        api_url,
                        headers={
                            "Authorization": f"Bearer {access_token}",
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        },
                    )
                    api_data = json.loads(urllib.request.urlopen(api_req, timeout=10).read().decode("utf-8"))
                    items = api_data.get("items", [])
                    if not items:
                        break

                    for item in items:
                        t = item.get("track")
                        if not t:
                            continue
                        raw_t = t.get("name")
                        artists = [a.get("name") for a in t.get("artists", []) if a.get("name")]
                        entry = spotify_track_entry(raw_t, ", ".join(artists), playlist_title)
                        if entry:
                            full_entries.append(entry)

                    if not api_data.get("next") or len(items) < limit:
                        break
                    offset += limit

                if len(full_entries) > len(entries):
                    print(f"[SPOTIFY EXTRACT] Successfully paginated {len(full_entries)} total tracks from Spotify Web API!")
                    return full_entries
        except Exception as err:
            print(f"[SPOTIFY EXTRACT WARNING] Web API pagination failed ({err}).")

    # Attempt 3: If still at ~100 tracks, parse full HTML page stream for additional track names
    if len(entries) >= 90 and item_type == "playlist":
        try:
            main_url = f"https://open.spotify.com/playlist/{item_id}"
            req_main = urllib.request.Request(
                main_url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"},
            )
            main_html = urllib.request.urlopen(req_main, timeout=10).read().decode("utf-8")
            raw_matches = re.findall(r'<meta property="music:song" content="https://open\.spotify\.com/track/([a-zA-Z0-9]+)"', main_html)
            if not raw_matches:
                # match track names from page metadata or JSON-LD
                script_matches = re.findall(r'\"name\":\"([^\"]+)\",\"[^\"]*artists\":\[\{\"name\":\"([^\"]+)\"', main_html)
                if script_matches and len(script_matches) > len(entries):
                    html_entries = []
                    playlist_title = entity.get("name") or "Spotify Playlist"
                    for raw_t, raw_a in script_matches:
                        entry = spotify_track_entry(raw_t, raw_a, playlist_title)
                        if entry:
                            html_entries.append(entry)
                    if len(html_entries) > len(entries):
                        print(f"[SPOTIFY EXTRACT] Extracted {len(html_entries)} tracks via main page script metadata!")
                        return html_entries
        except Exception as err:
            print(f"[SPOTIFY EXTRACT WARNING] HTML scraper fallback failed: {err}")

    return entries







async def extract_spotify_tracks(url: str) -> list[dict]:
    """Extract Spotify track & playlist metadata asynchronously."""
    return await asyncio.to_thread(_extract_spotify_embed_sync, url)
