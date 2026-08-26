"""Repair placeholder artist metadata without re-downloading audio files.

Run a preview first:
    python repair_metadata.py

Apply only verified artist updates and refresh MP3 tags:
    python repair_metadata.py --apply
"""

import argparse
import asyncio
import re
from dataclasses import dataclass

from sqlalchemy import select

from config import MEDIA_DIR
from database import Track, async_session, init_db
from ingestion.downloader import fetch_metadata, write_mp3_tags
from ingestion.providers import is_unknown_artist, resolve_youtube_metadata


@dataclass
class RepairResult:
    track_id: int
    status: str
    title: str
    artist: str = ""
    source: str = ""
    detail: str = ""


def _normalise_text(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").casefold())


async def repair_one(track_data: dict, apply: bool, semaphore: asyncio.Semaphore) -> RepairResult:
    async with semaphore:
        try:
            info = await asyncio.to_thread(fetch_metadata, track_data["youtube_url"])
            artist, resolved_title, source = resolve_youtube_metadata(info)
        except Exception as exc:
            return RepairResult(track_data["id"], "failed", track_data["title"], detail=str(exc)[:180])

        if is_unknown_artist(artist):
            return RepairResult(track_data["id"], "unresolved", track_data["title"], source=source)

        title = track_data["title"]
        # Title parsing is only safe when it corroborates the title already in
        # the library. Do not invent an artist from an unrelated video title.
        if source == "title" and (
            not title or title.strip().casefold() in {"unknown", "unknown track"}
            or _normalise_text(title) != _normalise_text(resolved_title)
        ):
            return RepairResult(track_data["id"], "unresolved", title, source=source, detail="video title does not corroborate library title")
        if not title or title.strip().casefold() in {"unknown", "unknown track"}:
            title = resolved_title

        if not apply:
            return RepairResult(track_data["id"], "would_fix", title, artist, source)

        async with async_session() as db:
            track = (await db.execute(select(Track).where(Track.id == track_data["id"]))).scalar_one_or_none()
            if not track:
                return RepairResult(track_data["id"], "skipped", title, artist, source, "track no longer exists")
            if not is_unknown_artist(track.artist):
                return RepairResult(track.id, "skipped", track.title, track.artist, detail="already edited")
            track.artist = artist
            track.title = title
            await db.commit()

        tag_status = "database updated"
        media_path = MEDIA_DIR / track_data["filename"]
        if media_path.exists():
            tag_status = "database + MP3 tags updated" if await asyncio.to_thread(write_mp3_tags, media_path, title, artist) else "database updated; MP3 tags unchanged"
        return RepairResult(track_data["id"], "fixed", title, artist, source, tag_status)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Repair unknown artist metadata from the original media source.")
    parser.add_argument("--apply", action="store_true", help="save updates; without this flag the command is a dry run")
    parser.add_argument("--limit", type=int, default=0, help="maximum tracks to inspect (0 means all)")
    parser.add_argument("--concurrency", type=int, default=3, help="simultaneous metadata lookups")
    args = parser.parse_args()

    await init_db()
    async with async_session() as db:
        tracks = (await db.execute(select(Track).where(Track.status == "ready").order_by(Track.id))).scalars().all()
        candidates = [
            {"id": t.id, "title": t.title, "artist": t.artist, "youtube_url": t.youtube_url, "filename": t.filename}
            for t in tracks if is_unknown_artist(t.artist)
        ]

    if args.limit:
        candidates = candidates[:args.limit]
    mode = "APPLY" if args.apply else "DRY RUN"
    print(f"{mode}: checking {len(candidates)} ready tracks with a placeholder artist.")

    semaphore = asyncio.Semaphore(max(1, args.concurrency))
    results = await asyncio.gather(*(repair_one(track, args.apply, semaphore) for track in candidates))
    counts: dict[str, int] = {}
    for result in results:
        counts[result.status] = counts.get(result.status, 0) + 1
        if result.status in {"would_fix", "fixed", "failed", "unresolved"}:
            suffix = f" [{result.source}]" if result.source else ""
            detail = f" — {result.detail}" if result.detail else ""
            print(f"#{result.track_id}: {result.status}: {result.artist or result.title}{suffix}{detail}")

    print("Summary: " + ", ".join(f"{name}={count}" for name, count in sorted(counts.items())))
    if not args.apply:
        print("Preview only. Re-run with --apply to save verified updates.")


if __name__ == "__main__":
    asyncio.run(main())
