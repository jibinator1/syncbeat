import asyncio
import json
import subprocess
import uuid
from pathlib import Path
from sqlalchemy import select

from config import MEDIA_DIR
from database import async_session, Track
from ingestion.providers import (
    sanitize_filename,
    clean_track_title,
    clean_artist_name,
    is_unknown_artist,
    resolve_youtube_metadata,
    detect_url_type,
    extract_playlist_urls,
    extract_spotify_tracks,
    extract_multiline_urls,
    get_ytdlp_cmd,
    select_best_youtube_candidate,
)
from ingestion.downloader import fetch_metadata, download_audio_track, _run_ytdlp_with_cookie_fallback



class IngestService:
    """Canonical service for managing track and playlist ingestion."""

    def __init__(self):
        self.background_tasks: set[asyncio.Task] = set()
        self.semaphore = asyncio.Semaphore(5)
        self.log_buffer: list[dict] = []
        self._add_log("INFO", "SyncBeats Ingestion Service initialized.")

    def _add_log(self, level: str, message: str, track_id: int = None):
        import time
        entry = {
            "timestamp": time.strftime("%H:%M:%S"),
            "level": level,
            "message": message,
            "track_id": track_id
        }
        self.log_buffer.append(entry)
        if len(self.log_buffer) > 500:
            self.log_buffer.pop(0)
        print(f"[{level}] {message}")

    def get_logs(self) -> list[dict]:
        return self.log_buffer



    def _track_task(self, task: asyncio.Task):
        self.background_tasks.add(task)
        task.add_done_callback(self.background_tasks.discard)

    async def update_track_progress(self, track_id: int, progress: float, step: str):
        """Atomic progress update helper."""
        async with async_session() as db:
            track = (await db.execute(select(Track).where(Track.id == track_id))).scalar_one_or_none()
            if track:
                track.progress = round(progress, 1)
                track.step = step
                await db.commit()

    def clear_logs(self):
        self.log_buffer = []
        self._add_log("INFO", "Terminal download logs cleared.")

    async def ingest_url(
        self,
        url: str,
        profile_id: int = None,
        create_playlist: bool = False,
        playlist_name: str = None,
    ) -> dict:
        """Entry point for /ingest requests."""
        url_type = detect_url_type(url)
        self._add_log("INFO", f"Ingest request received for URL: {url} (Type: {url_type})")

        if url_type in ("yt_playlist", "spotify", "multiline") or "spotify.com" in url:
            result = await self.process_playlist(
                url,
                profile_id=profile_id,
                create_playlist=create_playlist,
                playlist_name=playlist_name,
            )
            return {
                "status": "playlist_queued",
                "type": url_type,
                "total_extracted": result.get("total_extracted", 0),
                "skipped_duplicates": result.get("skipped_duplicates", 0),
                "queued_count": result.get("queued_count", 0),
                "track_ids": result.get("track_ids", []),
                "playlist_id": result.get("playlist_id"),
                "playlist_name": result.get("playlist_name"),
            }

        # Single track: duplicate check
        async with async_session() as db:
            existing = (await db.execute(
                select(Track).where(Track.youtube_url == url)
            )).scalar_one_or_none()

            if existing:
                self._add_log("SKIP", f"Duplicate request for URL: {url} (Track #{existing.id} - '{existing.title}')")
                return {"track_id": existing.id, "status": "duplicate", "title": existing.title}

            track = Track(
                youtube_url=url,
                filename=f"pending_{uuid.uuid4().hex[:12]}",
                status="pending",
                profile_id=profile_id,
            )
            db.add(track)
            await db.commit()
            await db.refresh(track)
            track_id = track.id

        self._add_log("INFO", f"Queued single track download as Track #{track_id}")
        task = asyncio.create_task(self.process_track(track_id))
        self._track_task(task)
        return {"track_id": track_id, "status": "pending"}

    async def process_playlist(
        self,
        url: str,
        profile_id: int = None,
        create_playlist: bool = False,
        playlist_name: str = None,
    ) -> dict:
        """Extract playlist entries, run pre-download deduplication, queue unique tracks, and optionally link into a CustomPlaylist."""
        self._add_log("INFO", f"Processing batch/playlist request...")
        url_type = detect_url_type(url)

        try:
            if url_type == "multiline":
                entries = await extract_multiline_urls(url)
            elif url_type == "spotify":
                entries = await extract_spotify_tracks(url)
            else:
                entries = await extract_playlist_urls(url)
            total_extracted = len(entries)
            self._add_log("INFO", f"Extracted {total_extracted} total track entries from batch input.")
        except Exception as e:
            self._add_log("ERROR", f"Extraction failed: {e}")
            return {"total_extracted": 0, "skipped_duplicates": 0, "queued_count": 0, "track_ids": []}

        track_ids = []
        all_playlist_track_ids = []
        skipped_duplicates = 0
        inferred_pl_name = playlist_name

        async with async_session() as db:
            from dedupe import normalize_str
            # Deduplicate across ALL tracks (global dedupe by artist+title)
            existing_tracks = (await db.execute(select(Track))).scalars().all()
            existing_list = [
                {
                    "id": t.id,
                    "url": t.youtube_url,
                    "norm_a": normalize_str(t.artist),
                    "norm_t": normalize_str(t.title)
                }
                for t in existing_tracks
            ]

            for entry in entries:
                p_name = entry.get("playlist_title") or "Imported Playlist"
                if not inferred_pl_name and p_name not in ("YouTube Playlist", "Batch Paste Import", "Spotify Single"):
                    inferred_pl_name = p_name

                if entry.get("metadata_source") == "spotify":
                    clean_t = (entry.get("title") or "").strip()
                    clean_a = (entry.get("artist") or "").strip()
                else:
                    clean_t = clean_track_title(entry.get("title", "Unknown"), entry.get("artist", ""))
                    clean_a = clean_artist_name(entry.get("artist", "Unknown"))
                entry_url = entry.get("url", "")

                if entry.get("metadata_source") == "spotify" and (is_unknown_artist(clean_a) or clean_t in {"Unknown", "Unknown Track"}):
                    self._add_log("WARNING", "Skipped Spotify item because Spotify did not provide a title and artist.")
                    continue

                norm_a = normalize_str(clean_a)
                norm_t = normalize_str(clean_t)

                matched_existing_id = None
                for ex in existing_list:
                    if entry_url and ex["url"] == entry_url:
                        matched_existing_id = ex["id"]
                        break
                    # Exact normalized match on both artist and title
                    if norm_a and norm_t and ex["norm_a"] and ex["norm_t"]:
                        if norm_a == ex["norm_a"] and norm_t == ex["norm_t"]:
                            matched_existing_id = ex["id"]
                            break

                if matched_existing_id:
                    skipped_duplicates += 1
                    all_playlist_track_ids.append(matched_existing_id)
                    self._add_log("SKIP", f"Skipped duplicate track (already in library): '{clean_a} - {clean_t}' (ID #{matched_existing_id})")
                    continue

                track = Track(
                    youtube_url=entry_url,
                    title=clean_t,
                    artist=clean_a,
                    filename=f"pending_{uuid.uuid4().hex[:12]}",
                    status="pending",
                    playlist_name=p_name,
                    profile_id=profile_id,
                )
                db.add(track)
                await db.flush()
                track_ids.append(track.id)
                all_playlist_track_ids.append(track.id)
                existing_list.append({
                    "id": track.id,
                    "url": entry_url,
                    "norm_a": norm_a,
                    "norm_t": norm_t
                })

            created_custom_pl_id = None
            if create_playlist and profile_id:
                final_pl_name = (inferred_pl_name or "New Playlist").strip()
                from database import CustomPlaylist, PlaylistTrack
                custom_pl = CustomPlaylist(name=final_pl_name, profile_id=profile_id)
                db.add(custom_pl)
                await db.flush()
                created_custom_pl_id = custom_pl.id

                # Link all tracks (existing + newly queued) to this playlist
                for tid in all_playlist_track_ids:
                    db.add(PlaylistTrack(playlist_id=custom_pl.id, track_id=tid))

                self._add_log("INFO", f"Created Custom Playlist '{final_pl_name}' with {len(all_playlist_track_ids)} tracks.")

            await db.commit()

        queued_count = len(track_ids)
        summary_msg = f"Playlist check complete: {total_extracted} total songs found. {skipped_duplicates} existing skipped from redownload. Queued {queued_count} new downloads!"
        self._add_log("INFO", summary_msg)

        for tid in track_ids:
            task = asyncio.create_task(self.process_track(tid))
            self._track_task(task)

        return {
            "total_extracted": total_extracted,
            "skipped_duplicates": skipped_duplicates,
            "queued_count": queued_count,
            "track_ids": track_ids,
            "playlist_id": created_custom_pl_id,
            "playlist_name": inferred_pl_name or "New Playlist",
        }


    async def process_track(self, track_id: int):
        """Worker task processing a single track download and metadata updates with concurrency limit."""
        async with self.semaphore:
            async with async_session() as db:
                track = (await db.execute(select(Track).where(Track.id == track_id))).scalar_one_or_none()
                if not track:
                    return

                track.status = "processing"
                track.progress = 5.0
                track.step = "Resolving metadata..."
                target_url = track.youtube_url
                track_artist = track.artist
                track_title = track.title
                await db.commit()

            self._add_log("INFO", f"Starting processing for Track #{track_id}...", track_id=track_id)

            try:
                # Step 1: Candidate search & metadata resolution
                candidates = []
                if target_url.startswith("ytsearch"):
                    self._add_log("INFO", f"Track #{track_id}: Searching YouTube for query '{target_url}'...", track_id=track_id)
                    cmd = get_ytdlp_cmd()
                    query = target_url
                    search_args = [cmd, "--flat-playlist", "--dump-json", "--no-warnings", query]
                    res = await asyncio.to_thread(_run_ytdlp_with_cookie_fallback, search_args)
                    if res.returncode == 0:
                        for line in res.stdout.strip().split("\n"):
                            if not line.strip():
                                continue
                            try:
                                info = json.loads(line)
                                v_id = info.get("id") or info.get("url", "")
                                if "v=" in v_id:
                                    v_id = v_id.split("v=")[-1].split("&")[0]
                                elif "/" in v_id:
                                    v_id = v_id.split("/")[-1]
                                v_url = f"https://www.youtube.com/watch?v={v_id}" if v_id else info.get("webpage_url")
                                candidates.append({
                                    "url": v_url,
                                    "title": info.get("title", ""),
                                    "artist": info.get("uploader") or info.get("channel") or "",
                                })
                            except json.JSONDecodeError:
                                continue
                    if not candidates:
                        raise RuntimeError(f"No valid YouTube video candidates found for query: {query}")
                else:
                    candidates.append({"url": target_url, "title": track_title, "artist": track_artist})

                # Sort candidates by suitability
                from ingestion.providers import select_best_youtube_candidate
                candidate_urls = [c["url"] for c in candidates if c.get("url")]

                safe_name = sanitize_filename(track_title if track_title and track_title != "Unknown" else "Track")
                out_path = MEDIA_DIR / f"{track_id}_{safe_name}.mp3"
                loop = asyncio.get_running_loop()
                def log_cb(level: str, msg: str, tid: int = None):
                    self._add_log(level, msg, track_id=tid or track_id)

                download_success = False
                last_download_err = None

                for cand in candidates:
                    cand_url = cand.get("url")
                    if not cand_url:
                        continue
                    try:
                        self._add_log("INFO", f"Track #{track_id}: Trying candidate '{cand.get('title')}' -> {cand_url}", track_id=track_id)
                        
                        async with async_session() as db:
                            track = (await db.execute(select(Track).where(Track.id == track_id))).scalar_one_or_none()
                            if track:
                                track.youtube_url = cand_url
                                track.progress = 20.0
                                track.step = "Downloading audio..."
                                await db.commit()

                        await asyncio.to_thread(
                            download_audio_track,
                            cand_url,
                            out_path,
                            track_id,
                            loop,
                            self.update_track_progress,
                            log_cb,
                        )
                        download_success = True
                        target_url = cand_url
                        break
                    except Exception as cand_err:
                        last_download_err = cand_err
                        self._add_log("WARNING", f"Track #{track_id}: Candidate '{cand.get('title')}' failed: {cand_err}. Trying next candidate...", track_id=track_id)

                if not download_success:
                    raise last_download_err or RuntimeError(f"All candidates failed for track #{track_id}")

                # Locate created file
                final = out_path if out_path.exists() else out_path.with_suffix(".mp3")
                if not final.exists():
                    candidates_files = list(MEDIA_DIR.glob(f"{track_id}_*"))
                    if candidates_files:
                        final = candidates_files[0]
                    else:
                        raise RuntimeError("Audio file missing after download completion")

                # Resolve metadata for YouTube link if title or artist was Unknown
                resolved_title = track_title
                resolved_artist = track_artist
                track_duration = None
                try:
                    meta_info = await asyncio.to_thread(fetch_metadata, target_url)
                    c_art, c_tit, _ = resolve_youtube_metadata(meta_info)
                    track_duration = meta_info.get("duration")
                    if not resolved_title or resolved_title in ("Unknown", "Unknown Track", "Track"):
                        resolved_title = c_tit
                    if is_unknown_artist(resolved_artist):
                        resolved_artist = c_art
                except Exception as meta_err:
                    self._add_log("WARNING", f"Track #{track_id}: Metadata fetch warning: {meta_err}", track_id=track_id)

                async with async_session() as db:
                    track = (await db.execute(select(Track).where(Track.id == track_id))).scalar_one_or_none()
                    if track:
                        track.filename = final.name
                        track.status = "ready"
                        track.progress = 100.0
                        track.step = "Complete"
                        if resolved_title and resolved_title not in ("Unknown", "Unknown Track"):
                            track.title = resolved_title
                        if resolved_artist and not is_unknown_artist(resolved_artist):
                            track.artist = resolved_artist
                        if track_duration:
                            track.duration = track_duration
                        await db.commit()

                self._add_log("INFO", f"Track #{track_id} ready: Saved as '{final.name}'", track_id=track_id)

            except Exception as exc:
                self._add_log("ERROR", f"Track #{track_id} failed: {exc}", track_id=track_id)
                async with async_session() as db:
                    track = (await db.execute(select(Track).where(Track.id == track_id))).scalar_one_or_none()
                    if track:
                        track.status = "error"
                        track.error_msg = str(exc)[:1000]
                        track.step = "Failed"
                        await db.commit()




# Global singleton instance
ingest_service = IngestService()
