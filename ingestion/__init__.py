"""
Ingestion domain package for SyncBeats Music Server.
Handles metadata extraction, URL detection, audio downloading, and track processing orchestration.
"""

from ingestion.providers import (
    sanitize_filename,
    detect_url_type,
    extract_playlist_urls,
    extract_spotify_tracks,
)
from ingestion.downloader import fetch_metadata, download_audio_track
from ingestion.service import IngestService, ingest_service

__all__ = [
    "sanitize_filename",
    "detect_url_type",
    "extract_playlist_urls",
    "extract_spotify_tracks",
    "fetch_metadata",
    "download_audio_track",
    "IngestService",
    "ingest_service",
]
