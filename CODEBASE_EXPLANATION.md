# 🎵 SyncBeats - Codebase Architecture & Technical Reference Guide

Welcome! This document provides a complete, line-by-line and component-by-component breakdown of the entire **SyncBeats** music server codebase. It is designed so that anyone with zero prior knowledge of the project can read it and thoroughly understand how every file, class, data structure, function, and background task operates.

---

## 📐 1. System Architecture Overview

**SyncBeats** is a self-hosted, multi-user web application and music server that ingests audio from YouTube and Spotify, stores tracks locally in high-quality MP3 format, maintains user profiles and custom playlists, and allows real-time synchronized group listening ("Jam Mode") via WebSockets.

### High-Level Tech Stack
* **Backend Framework:** FastAPI (Python 3.10+) with `uvicorn` as the ASGI web server.
* **Database & ORM:** SQLite (`music.db`) accessed asynchronously via SQLAlchemy AsyncIO (`sqlite+aiosqlite`).
* **Media Processing & Ingestion:** `yt-dlp` (YouTube metadata & audio extraction) and `ffmpeg` (audio conversion, clipping, MP3 metadata tagging).
* **Realtime Synchronization:** FastAPI WebSockets (`/ws/{room_id}`) managed by an in-memory client connection router (`RoomManager`).
* **Frontend UI:** Single Page Application (SPA) built with vanilla HTML5, CSS3, and ES6+ JavaScript.

---

## 📁 2. File & Folder Breakdown

Below is the directory layout of the repository:

```
music/
├── config.py                   # Centralized configuration & environment setup
├── database.py                 # SQLite ORM models & database initialization
├── main.py                     # FastAPI web application routes & WebSocket endpoints
├── rooms.py                    # Real-time WebSocket room manager for Jam Mode playback sync
├── dedupe.py                   # Database deduplication utility script
├── reingest_all.py             # Bulk track audio/metadata re-download script
├── repair_metadata.py          # Non-destructive metadata repair tool for unknown artists
├── delete_tracks_through_450.py# Database cleanup script for IDs 1–450
├── delete_unknown_artists.py   # Database cleanup script for placeholder artists
├── ingestion/
│   ├── __init__.py             # Module exporter for IngestService
│   ├── downloader.py           # yt-dlp & ffmpeg execution wrappers with cookie fallbacks
│   ├── providers.py            # Metadata extraction, Spotify embed parsing & title cleaning
│   └── service.py              # Ingestion workflow manager & background task queue
└── static/
    ├── index.html              # HTML layout for Spotify-style web player interface
    ├── style.css               # Styling rules (dark theme, glassmorphism, responsive UI)
    └── app.js                  # Client-side JavaScript (state management, playback engine, UI interactions)
```

---

## 🐍 3. Backend Implementation Detail (Python)

---

### 3.1 `config.py` — Application Configuration

This file handles environment configuration and sets up global paths.

#### Global Variables:
* `BASE_DIR`: Absolute `Path` pointing to the directory containing `config.py`.
* `HOST`: Server bind address (default: `"0.0.0.0"`).
* `PORT`: Server port (default: `8000`).
* `MEDIA_DIR`: `Path` pointing to the folder where MP3 files are stored (`music/media`). Automatically created on startup if it doesn't exist.
* `DATABASE_URL`: Async SQLAlchemy connection string (`"sqlite+aiosqlite:///./music.db"`).
* `ACCESS_KEY`: Security access key required for login authentication (default: `"Bills Mafia"`).

---

### 3.2 `database.py` — ORM Models & Migrations

Defines the database schema using SQLAlchemy's async declarative base.

#### Database Models (Classes):

1. **`Track(Base)`** — Table name: `tracks`
   * `id` (`Integer`, PK): Unique track ID.
   * `title` (`String(300)`): Song title.
   * `artist` (`String(300)`): Artist name.
   * `duration` (`Float`): Song duration in seconds.
   * `filename` (`String(500)`): Name of the saved `.mp3` file on disk inside `media/`.
   * `youtube_url` (`Text`): Source YouTube URL or search query string (`ytsearch5:...`).
   * `status` (`String(20)`): State of ingestion (`"pending"`, `"processing"`, `"ready"`, `"error"`).
   * `progress` (`Float`): Ingestion progress percentage (0.0 to 100.0).
   * `step` (`String(100)`): Human-readable current status step (e.g. `"Downloading: 45%"`).
   * `error_msg` (`Text`): Error log details if ingestion failed.
   * `playlist_name` (`String(300)`): Associated origin playlist label (default: `"My Library"`).
   * `profile_id` (`Integer`): ID of the `UserProfile` that triggered the download.
   * `created_at` (`DateTime`): UTC timestamp when the record was created.

2. **`UserProfile(Base)`** — Table name: `user_profiles`
   * `id` (`Integer`, PK): Profile identifier.
   * `name` (`String(100)`): Profile name (unique).
   * `avatar` (`String(10)`): Display avatar (emoji).
   * `created_at` (`DateTime`): Creation timestamp.

3. **`CustomPlaylist(Base)`** — Table name: `custom_playlists`
   * `id` (`Integer`, PK): Playlist identifier.
   * `name` (`String(200)`): Playlist title.
   * `profile_id` (`Integer`): Owner profile ID.
   * `created_at` (`DateTime`): Creation timestamp.

4. **`PlaylistTrack(Base)`** — Table name: `playlist_tracks`
   * `id` (`Integer`, PK): Link table record ID.
   * `playlist_id` (`Integer`): Foreign key to `CustomPlaylist`.
   * `track_id` (`Integer`): Foreign key to `Track`.

#### Key Functions:
* `_run_migrations(connection)`: Schema migration helper. Checks table structure at runtime and executes `ALTER TABLE` statements to add missing columns (`playlist_name`, `profile_id`) without dropping user data.
* `init_db()`: Initializes all database tables and runs schema migration checks.

---

### 3.3 `main.py` — REST API Server & WebSockets

Serves HTML/CSS/JS frontend files, exposes REST API routes, and manages WebSocket Jam Mode sessions.

#### Data Models (Pydantic Schemas / DTOs):
* `AuthRequest`: Validates access key submission (`key`).
* `CreateProfileRequest`: Validates profile creation (`name`, optional `avatar`).
* `CreateCustomPlaylistRequest`: Validates custom playlist creation (`name`, `profile_id`).
* `AddTrackToPlaylistRequest`: Data transfer object for adding tracks to custom playlists.
* `IngestRequest`: Validates incoming download request payload (`url`, optional `profile_id`).
* `TrackResponse`: Output response schema representing track data sent to the UI.
* `UpdateTrackPayload`: Validates edits to song title, artist, or playlist name.

#### Functions & API Routes:

* **`lifespan(app: FastAPI)`**: Async application lifespan manager that invokes `init_db()` upon server startup.
* **`GET /` (`index()`)**: Serves `static/index.html` with cache-disabling headers.
* **`POST /auth/verify` (`verify_access_key(req)`)**: Validates submitted access key against `ACCESS_KEY`.
* **`GET /profiles` (`list_profiles()`)**: Fetches all user profiles. Auto-creates default profiles ("Main User", "Guest") if the table is empty.
* **`POST /profiles` (`create_profile(req)`)**: Creates a new `UserProfile`.
* **`DELETE /profiles/{profile_id}` (`delete_profile(profile_id)`)**: Deletes a user profile and all custom playlists associated with it.
* **`GET /custom-playlists/{profile_id}` (`get_custom_playlists(profile_id)`)**: Lists all custom playlists and track ID arrays owned by the given profile.
* **`POST /custom-playlists` (`create_custom_playlist(req)`)**: Creates a custom playlist.
* **`POST /custom-playlists/{playlist_id}/tracks` (`add_track_to_custom_playlist(playlist_id, payload)`)**: Adds a track ID to a custom playlist.
* **`POST /ingest` (`ingest(req)`)**: Triggers asynchronous background audio ingestion for a single YouTube URL, YouTube playlist, Spotify URL, or multiline batch input.
* **`GET /download-logs` (`get_download_logs()`)**: Returns live terminal log buffer for the UI download console.
* **`POST /download-logs/clear` (`clear_download_logs()`)**: Clears server download logs.
* **`GET /tracks` (`list_tracks()`)**: Returns all tracks stored in the global library ordered by creation date descending.
* **`GET /download/{track_id}` (`download_track(track_id)`)**: Serves audio file stream or attachment download with formatted `"Title - Artist.mp3"` filename headers.
* **`PATCH /tracks/{track_id}` (`update_track(track_id, payload)`)**: Updates track title, artist, or playlist name in the database and rewrites ID3 tags in the `.mp3` file.
* **`DELETE /tracks/{track_id}` (`delete_track(track_id)`)**: Deletes a track record from database and removes its `.mp3` file from `media/`.
* **`DELETE /tracks/pending/clear` (`clear_pending_tracks()`)**: Deletes all stuck `"pending"` or `"processing"` tracks from database.
* **`WEBSOCKET /ws/{room_id}` (`ws_jam(ws, room_id)`)**: Opens a WebSocket connection for synchronized multi-user audio playback.

---

### 3.4 `rooms.py` — Jam Mode Playback Synchronizer

Manages realtime WebSocket synchronization across room participants.

#### Class: `RoomManager`
* **Attributes:**
  * `rooms`: Dictionary mapping `room_id` to sets of active `WebSocket` connections.
  * `hosts`: Dictionary mapping `room_id` to the designated host client `WebSocket`.
  * `room_states`: Dictionary tracking playback state (`track_id`, `position`, `is_playing`, `updated_at`).

* **Methods:**
  * `_get_current_position(room_id)`: Calculates the estimated current track timestamp in seconds based on elapsed system time since last state update.
  * `connect(room_id, ws)`: Accepts WebSocket connection, assigns host privileges if first to join, sends current state to new client, and broadcasts room member updates.
  * `disconnect(room_id, ws)`: Removes client from room state; reassigns host role if host leaves.
  * `broadcast(room_id, data, exclude)`: Sends JSON message to all clients in room (optionally excluding sender) and cleans up disconnected sockets.
  * `handle_message(room_id, ws, raw)`: Processes incoming client commands (`play`, `pause`, `seek`, `track_change`, `request_sync`), updates internal state, and broadcasts updates to participants.

---

### 3.5 Ingestion Engine (`ingestion/`)

#### 3.5.1 `ingestion/providers.py` — Metadata Extraction & Parsing
* `is_unknown_artist(artist)`: Checks if artist string matches generic placeholders (`"Unknown"`, `"N/A"`, etc.).
* `clean_artist_name(artist)`: Cleans YouTube uploader names by stripping suffixes like `- Topic`, `VEVO`, `Official`.
* `clean_track_title(title, artist)`: Removes clutter from video titles like `[Official Music Video]`, `(Lyrics)`, `HD`, `4K`, `Explicit`.
* `parse_artist_from_title(title)`: Parses `"Artist - Track Title"` strings.
* `resolve_youtube_metadata(info)`: Determines canonical artist and title from yt-dlp JSON dictionary based on metadata field hierarchy.
* `select_best_youtube_candidate(entries, target_artist, target_title)`: Scores YouTube search results using a heuristic rule engine (prioritizes `- Topic` channels and official artist channels over fan uploads).
* `sanitize_filename(name)`: Replaces illegal filename characters (`\ / : * ? " < > |`) with underscores.
* `detect_url_type(url)`: Classifies input text into `"spotify"`, `"yt_playlist"`, `"yt_single"`, or `"multiline"`.
* `extract_spotify_tracks(url)`: HTML & JSON parser that extracts track entries from Spotify Web embed pages without requiring Spotify API developer credentials. Supports fallback to official Spotify Web API pagination for large playlists (100+ tracks).
* `extract_playlist_urls(url)`: Uses `yt-dlp --flat-playlist` to retrieve all videos inside a YouTube playlist.
* `extract_multiline_urls(text)`: Parses batch raw text containing multiple pasted URLs.

#### 3.5.2 `ingestion/downloader.py` — Audio Download & Tagging
* `_run_ytdlp_with_cookie_fallback(args)`: Executes `yt-dlp`. If YouTube blocks the request or requests bot authentication, it automatically retries with alternate player clients (`ios`, `android`, `mweb`) and browser cookies (`chrome`, `edge`, `firefox`, `brave`).
* `fetch_metadata(url)`: Synchronously fetches metadata dictionary for a single video.
* `write_mp3_tags(path, title, artist)`: Uses `ffmpeg` to write ID3v2 tags directly into an MP3 file without re-encoding audio.
* `download_audio_track(target_url, out_path, track_id, loop, progress_callback, log_callback)`: Main worker that executes `yt-dlp` audio download, parses progress stdout in real-time, converts audio to 192kbps MP3 via `ffmpeg`, and fires progress updates back to the database.

#### 3.5.3 `ingestion/service.py` — Task Orchestrator (`IngestService`)
* Global manager managing ingestion queue concurrency (up to 5 parallel downloads via `asyncio.Semaphore`).
* `ingest_url(url, profile_id)`: Accepts single track or playlist requests.
* `process_playlist(url, profile_id)`: Extracts playlist items, checks for duplicates against existing library items using string normalization (`dedupe.normalize_str`), and enqueues new tracks.
* `process_track(track_id)`: Worker pipeline executing candidate resolution, metadata cleaning, audio downloading, MP3 tag writing, and database state updates.

---

### 3.6 Maintenance & Utility Scripts

* `dedupe.py`: Scans database for duplicate tracks matching on normalized title and artist. Removes extra records and deletes orphaned audio files.
* `repair_metadata.py`: Inspects tracks with unknown artists, queries original YouTube metadata, and updates database records & ID3 tags without re-downloading audio files.
* `reingest_all.py`: Re-downloads audio files for all existing database tracks from official YouTube Topic channels to upgrade library audio quality.
* `delete_tracks_through_450.py`: Maintenance script that deletes tracks with ID <= 450.
* `delete_unknown_artists.py`: Maintenance script that purges tracks where artist is missing or unknown.

---

## 🎨 4. Frontend Implementation Detail (HTML / CSS / JS)

### 4.1 `static/index.html`
* Modern layout featuring:
  * **Sidebar**: Profile switcher dropdown, primary navigation (Home, Search, Library, Jam Mode, Download Terminal), and profile custom playlists list.
  * **Top Header**: Modern search input bar, active profile indicator, and action buttons.
  * **Main Content View**: Dynamic views for Track Library, Playlist Detail, Download Terminal, Search View, and Jam Mode Room setup.
  * **Bottom Sticky Player Bar**: Current track artwork info, playback control buttons (shuffle, previous, play/pause, next, loop), audio progress slider with timestamp labels, and volume control.
  * **Modals & Context Menus**: Spotify-style right-click context menu (Add to Playlist, Delete Track, Copy URL) and mobile full-screen player modal.

---

### 4.2 `static/style.css`
* Implements a dark mode aesthetic using HSL color tokens (`--bg-base: #121212`, `--accent-green: #1db954`).
* Glassmorphism effects with `backdrop-filter: blur(12px)`.
* Custom scrollbars, responsive CSS Grid and Flexbox layouts, media query breakpoints for mobile devices (< 768px), and CSS micro-animations.

---

### 4.3 `static/app.js` — Client Application Controller

#### Core Modules & Functions:

1. **State Management (`state`)**:
   * Stores `profiles`, `currentProfile`, `tracks`, `customPlaylists`, `currentPlaylist`, `queue`, `queueIndex`, `isPlaying`, `isShuffle`, `isLoop`, `websocket`, `jamRoomId`, `isJamHost`.

2. **API Layer**:
   * `apiFetch(endpoint, options)`: Wrapper around `fetch` with error handling.
   * `loadProfiles()`: Loads profiles from `/profiles`.
   * `loadTracks()`: Loads tracks from `/tracks`.
   * `loadCustomPlaylists()`: Loads playlists for active profile from `/custom-playlists/{profile_id}`.

3. **Audio Engine (`audioPlayer`)**:
   * Uses HTML5 `Audio` API.
   * `playTrack(track, queueList)`: Updates player state and begins playback.
   * `togglePlay()`: Toggles play/pause.
   * `nextTrack()` / `prevTrack()`: Controls queue navigation (supports shuffle).
   * `seek(seconds)`: Seeks to specific track timestamp.
   * Updates time display counters and progress slider percentage.

4. **UI Render Functions**:
   * `renderTrackList(tracks, container)`: Renders table rows / track cards with status badges, cover art, track titles, artists, and action buttons.
   * `renderSidebarPlaylists()`: Updates sidebar list of custom playlists.
   * `renderDownloadTerminal()`: Fetches and displays real-time backend ingestion logs.

5. **WebSocket Jam Mode**:
   * `connectJamMode(roomId)`: Establishes connection to `/ws/{roomId}`.
   * Handles incoming events (`connected`, `play`, `pause`, `seek`, `track_change`, `member_update`).
   * Broadcasts host controls to synced listeners.

6. **Context Menu & Ingestion Handlers**:
   * Right-click listener for custom track action context menu.
   * Download form submit listener forwarding input to `/ingest`.

---

## 🔁 5. Complete Data Flow Diagram

```
 [User UI: Web Browser]
       │
       │ 1. POST /ingest (URL: YouTube or Spotify)
       ▼
 [FastAPI Server: main.py]
       │
       │ 2. Delegate to IngestService (ingestion/service.py)
       ▼
 [IngestService Orchestrator]
       │
       ├─► [Providers: ingestion/providers.py] ── Extract Metadata / Parse Spotify Embed / Flat Playlist
       │
       ├─► [Database: database.py] ────────────── Create Track record (status: "pending")
       │
       └─► [Downloader: ingestion/downloader.py] ─► Run yt-dlp & FFmpeg
                                                      │
                                                      ├─► Auto fallback to browser cookies if auth fails
                                                      ├─► Write MP3 ID3 Tags
                                                      └─► Save file in /media directory
                                                              │
       ┌──────────────────────────────────────────────────────┘
       ▼
 [Track status updated to "ready"]
       │
       │ 3. UI plays audio via GET /download/{track_id}
       ▼
 [HTML5 Audio Player] ─── WebSocket Sync (rooms.py) ───► Other Jam Mode Listeners
```

---

## ❓ FAQ for New Developers

1. **Where are MP3 files stored?**
   Audio files are saved inside the `media/` folder (configured in `config.py`).
2. **How does Spotify downloading work without a Spotify API Key?**
   `ingestion/providers.py` parses public Spotify embed pages to extract canonical track names and artist metadata, then searches YouTube to download audio.
3. **What happens if YouTube blocks downloads?**
   `ingestion/downloader.py` catches authentication errors and automatically retries using browser cookies extracted from local installations of Chrome, Edge, Firefox, or Brave.
4. **How do I start the development server?**
   Run `python main.py` or `uvicorn main:app --reload`.

---
*Documentation compiled for the SyncBeats codebase.*
