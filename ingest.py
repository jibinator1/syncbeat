"""
Ingest facade for backward compatibility.
Delegates ingestion features to the modular `ingestion` package.
"""

from ingestion.providers import (
    sanitize_filename as _sanitize,
    detect_url_type as _detect_url_type,
    extract_playlist_urls,
    extract_spotify_tracks,
)
from ingestion.service import ingest_service

# Preserve function aliases expected by legacy calls
async def process_track(track_id: int):
    await ingest_service.process_track(track_id)


async def process_playlist(url: str) -> list[int]:
    return await ingest_service.process_playlist(url)
