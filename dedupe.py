import asyncio
import os
import re
from sqlalchemy import select, delete
from database import async_session, Track, init_db

def normalize_str(s: str) -> str:
    """Normalize string by removing special characters, bracketed text, and lowercasing."""
    if not s:
        return ""
    # remove bracketed content e.g. (feat. X) or [Official Video]
    s = re.sub(r"[\(\[\{].*?[\)\]\}]", "", s)
    # remove non-alphanumeric chars
    s = re.sub(r"[^a-zA-Z0-9\s]", "", s)
    return s.strip().lower()

async def deduplicate_db():
    print("=== Starting SyncBeats Database Deduplication ===")
    await init_db()

    async with async_session() as db:
        res = await db.execute(select(Track))
        tracks = res.scalars().all()
        print(f"Total tracks in database before clean-up: {len(tracks)}")

        kept_tracks = []
        removed_ids = []

        for track in tracks:
            norm_title = normalize_str(track.title)
            norm_artist = normalize_str(track.artist)

            is_duplicate = False
            for existing in kept_tracks:
                ex_title = normalize_str(existing.title)
                ex_artist = normalize_str(existing.artist)

                # Check if artists match or one artist name is contained ('isin') in another
                artist_match = (
                    norm_artist == ex_artist or
                    (len(norm_artist) > 2 and norm_artist in ex_artist) or
                    (len(ex_artist) > 2 and ex_artist in norm_artist)
                )

                # Check if titles match or one title is contained in another
                title_match = (
                    norm_title == ex_title or
                    (len(norm_title) > 3 and norm_title in ex_title) or
                    (len(ex_title) > 3 and ex_title in norm_title)
                )

                if artist_match and title_match:
                    print(f" -> Found duplicate: ID {track.id} ('{track.artist} - {track.title}') matches ID {existing.id} ('{existing.artist} - {existing.title}')")
                    is_duplicate = True
                    removed_ids.append(track.id)

                    # Remove local file if exists
                    if track.filename:
                        mp3_path = os.path.join("static", "music", f"{track.filename}.mp3")
                        if os.path.exists(mp3_path):
                            try:
                                os.remove(mp3_path)
                                print(f"    Removed duplicate audio file: {mp3_path}")
                            except Exception as err:
                                print(f"    Error deleting file {mp3_path}: {err}")
                    break

            if not is_duplicate:
                kept_tracks.append(track)

        if removed_ids:
            for rid in removed_ids:
                await db.execute(delete(Track).where(Track.id == rid))
            await db.commit()
            print(f"✅ Successfully deleted {len(removed_ids)} duplicate track entries from database!")
        else:
            print("✨ No duplicates found! Database is clean.")

        print(f"Total tracks remaining: {len(kept_tracks)}")

if __name__ == "__main__":
    asyncio.run(deduplicate_db())
