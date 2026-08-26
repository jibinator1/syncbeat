# 🎵 SyncBeats Music Server

A high-performance, Spotify-inspired web music server and real-time playback synchronization engine. Built with **FastAPI**, **SQLAlchemy (Async)**, **SQLite**, **yt-dlp**, and **WebSockets**.

---

## 🚀 Quick Start (How to Run)

### 1. Prerequisites

Make sure you have the following installed on your system:
- **Python 3.10+**
- **FFmpeg** (Required for audio extraction and conversion to MP3)
  - Windows: Install via `winget install Gyan.FFmpeg` or download from [ffmpeg.org](https://ffmpeg.org/) and add `ffmpeg/bin` to your system `PATH`.
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg`

### 2. Environment Setup

1. Open your terminal in the project directory:
   ```bash
   cd "f:\learning to code\music"
   ```

2. Create and activate a Python virtual environment:
   ```bash
   python -m venv venv
   # On Windows (PowerShell):
   .\venv\Scripts\Activate.ps1
   # On macOS/Linux:
   source venv/bin/activate
   ```

3. Install required Python packages:
   ```bash
   pip install -r requirements.txt
   ```

4. Configure environment variables (optional):
   Create a `.env` file or copy from `.env.example`:
   ```env
   HOST=127.0.0.1
   PORT=8000
   DATABASE_URL=sqlite+aiosqlite:///music.db
   ```

---

### 3. Launching the Server

You can launch the server using **any** of the following commands:

#### Option A: Direct Entrypoint (Recommended)
```bash
python app.py
```

#### Option B: Main Entrypoint
```bash
python main.py
```

#### Option C: Uvicorn Directly
```bash
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

Once running, access the application in your browser:
👉 **`http://127.0.0.1:8000`**

---

### 4. Public Access (Tunneling)

To share your local music server online without port forwarding, run:

```bash
npx localtunnel --port 8000
```

This will generate a temporary public URL (e.g. `https://xxxx.loca.lt`) to access your server anywhere.

## ✨ Features

- **Spotify & YouTube Ingestion**:
  - Ingest single YouTube tracks by URL (`https://youtube.com/watch?v=...`).
  - Ingest entire YouTube playlists automatically in background tasks.
  - Ingest Spotify playlists & albums (`https://open.spotify.com/playlist/...`) with instant embed metadata parsing (< 0.5s).
- **Playback & Library Management**:
  - Spotify-inspired UI with dark mode, side navigation, track search, and custom audio player controls.
  - Right-click context menus for track deletion, queuing, and playlist organization.
  - Real-time download progress indicators with step status updates.
- **WebSocket Jam Mode**:
  - Create or join sync rooms (`/ws/{room_id}`) to synchronize play, pause, seek, and track switches across multiple connected clients in real-time.

### Repair missing artists

Preview the available repairs first; this does not change your library:

```bash
python repair_metadata.py
```

Apply verified artist updates and refresh MP3 title/artist tags:

```bash
python repair_metadata.py --apply
```

Use `--limit 10` for a small first batch. Tracks that cannot be resolved stay under **Needs Artist Review** in the library, where you can right-click a track to correct it manually.

---

## 📁 Project Architecture

```
music/
├── app.py                # Primary CLI wrapper entrypoint (python app.py)
├── main.py               # FastAPI application, routing, & WebSocket endpoints
├── database.py           # SQLite async session, ORM Track model, & migrations
├── config.py             # Server host, port, database, and media folder settings
├── ingest.py             # Backwards-compatible facade importing from ingestion/
├── ingestion/            # Modular Ingestion Architecture
│   ├── __init__.py       # Ingestion package exports
│   ├── providers.py      # Spotify & YouTube metadata extraction parsers
│   ├── downloader.py     # yt-dlp audio downloader worker & progress listener
│   └── service.py        # IngestService background task & DB state manager
├── rooms.py              # WebSocket room connection & message manager
├── static/               # Frontend assets
│   ├── index.html        # Spotify web interface UI
│   ├── app.js            # Audio player, WebSocket sync, context menu logic
│   └── style.css         # Dark theme styling & animations
├── media/                # Audio storage directory for downloaded MP3 files
├── music.db              # SQLite database file
├── requirements.txt      # Python dependencies
└── README.md             # Project documentation
```

---

## 📡 API Endpoints Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Serves main Web UI (`index.html`) |
| `POST` | `/ingest` | Enqueues YouTube or Spotify URL for ingestion |
| `GET` | `/tracks` | Returns JSON list of all tracks in library |
| `GET` | `/download/{id}` | Streams audio file (`.mp3`) for ready track |
| `PATCH` | `/tracks/{id}` | Updates track playlist assignment |
| `DELETE` | `/tracks/{id}` | Deletes track record and removes local MP3 file |
| `WS` | `/ws/{room_id}` | Realtime WebSocket jam session |

---

## 🛠️ Verification & Troubleshooting

- **File Not Found / Command Error**:
  If running `python app.py` returns an error, verify you are inside the `f:\learning to code\music` directory and your virtual environment is active.
- **FFmpeg Missing Error**:
  If track ingestion fails with `FFmpeg not found on PATH`, ensure `ffmpeg` is installed and accessible from your terminal command line (`ffmpeg -version`).
