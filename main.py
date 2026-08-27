from __future__ import annotations
import asyncio
import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Body
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import select

from config import HOST, PORT, MEDIA_DIR, ACCESS_KEY
from database import init_db, async_session, Track, UserProfile, CustomPlaylist, PlaylistTrack
from ingestion import ingest_service
from ingestion.downloader import write_mp3_tags
from rooms import manager



@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle context manager."""
    await init_db()
    yield


app = FastAPI(title="SyncBeats Music Server", lifespan=lifespan)

# Static file routing
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/syncbeats.apk")
async def download_apk():
    apk_path = "SyncBeats.apk"
    if os.path.exists(apk_path):
        return FileResponse(apk_path, media_type="application/vnd.android.package-archive", filename="SyncBeats.apk")
    raise HTTPException(status_code=404, detail="APK not found")


# Pydantic Schemas / DTOs
class AuthRequest(BaseModel):
    key: str


class CreateProfileRequest(BaseModel):
    name: str
    avatar: Optional[str] = "🎧"


class CreateCustomPlaylistRequest(BaseModel):
    name: str
    profile_id: int


class AddTrackToPlaylistRequest(BaseModel):
    playlist_id: int
    track_id: int


class IngestRequest(BaseModel):
    url: str
    profile_id: Optional[int] = None
    create_playlist: Optional[bool] = False
    playlist_name: Optional[str] = None


class TrackResponse(BaseModel):
    id: int
    title: str
    artist: str
    duration: Optional[float] = None
    status: str
    progress: float = 0.0
    step: str = "Queued"
    playlist: Optional[str] = "My Library"
    error: Optional[str] = None
    profile_id: Optional[int] = None

    class Config:
        from_attributes = True


class UpdateTrackPayload(BaseModel):
    playlist: Optional[str] = None
    title: Optional[str] = None
    artist: Optional[str] = None


# Routes
@app.get("/")
async def index():
    return FileResponse(
        "static/index.html",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


@app.post("/auth/verify")
async def verify_access_key(req: AuthRequest):
    """Verify access key ('Bills Mafia')."""
    if req.key.strip().lower() == ACCESS_KEY.strip().lower():
        return {"status": "authenticated", "valid": True}
    raise HTTPException(status_code=401, detail="Invalid Access Key")


@app.get("/profiles")
async def list_profiles():
    """Retrieve all user profiles."""
    async with async_session() as db:
        res = await db.execute(select(UserProfile).order_by(UserProfile.created_at.asc()))
        profiles = res.scalars().all()
        if not profiles:
            # Create default profiles if none exist
            p1 = UserProfile(name="Main User", avatar="🎧")
            p2 = UserProfile(name="Guest", avatar="🎵")
            db.add_all([p1, p2])
            await db.commit()
            res = await db.execute(select(UserProfile).order_by(UserProfile.created_at.asc()))
            profiles = res.scalars().all()

        return [{"id": p.id, "name": p.name, "avatar": p.avatar} for p in profiles]


@app.post("/profiles")
async def create_profile(req: CreateProfileRequest):
    """Create a new user profile."""
    async with async_session() as db:
        existing = (await db.execute(select(UserProfile).where(UserProfile.name == req.name))).scalar_one_or_none()
        if existing:
            raise HTTPException(400, "Profile name already exists")
        profile = UserProfile(name=req.name, avatar=req.avatar or "🎧")
        db.add(profile)
        await db.commit()
        await db.refresh(profile)
        return {"id": profile.id, "name": profile.name, "avatar": profile.avatar}


@app.get("/custom-playlists/{profile_id}")
async def get_custom_playlists(profile_id: int):
    """Get custom playlists for a profile."""
    async with async_session() as db:
        res = await db.execute(select(CustomPlaylist).where(CustomPlaylist.profile_id == profile_id))
        playlists = res.scalars().all()
        out = []
        for pl in playlists:
            ptracks = (await db.execute(select(PlaylistTrack.track_id).where(PlaylistTrack.playlist_id == pl.id))).scalars().all()
            out.append({
                "id": pl.id,
                "name": pl.name,
                "profile_id": pl.profile_id,
                "track_ids": ptracks,
                "count": len(ptracks)
            })
        return out


@app.post("/custom-playlists")
async def create_custom_playlist(req: CreateCustomPlaylistRequest):
    """Create a custom user playlist."""
    async with async_session() as db:
        playlist = CustomPlaylist(name=req.name, profile_id=req.profile_id)
        db.add(playlist)
        await db.commit()
        await db.refresh(playlist)
        return {"id": playlist.id, "name": playlist.name, "profile_id": playlist.profile_id, "track_ids": [], "count": 0}


class TrackIdPayload(BaseModel):
    track_id: int


@app.post("/custom-playlists/add-track")
async def add_track_legacy(req: AddTrackToPlaylistRequest):
    """Legacy endpoint for adding track to playlist."""
    async with async_session() as db:
        existing = (await db.execute(
            select(PlaylistTrack).where(
                PlaylistTrack.playlist_id == req.playlist_id,
                PlaylistTrack.track_id == req.track_id
            )
        )).scalar_one_or_none()
        if not existing:
            pt = PlaylistTrack(playlist_id=req.playlist_id, track_id=req.track_id)
            db.add(pt)
            await db.commit()
        return {"status": "added"}


@app.post("/custom-playlists/{playlist_id}/tracks")
async def add_track_to_custom_playlist(playlist_id: int, payload: TrackIdPayload):
    """Add a track to a custom playlist."""
    async with async_session() as db:
        existing = (await db.execute(
            select(PlaylistTrack).where(
                PlaylistTrack.playlist_id == playlist_id,
                PlaylistTrack.track_id == payload.track_id
            )
        )).scalar_one_or_none()
        if not existing:
            pt = PlaylistTrack(playlist_id=playlist_id, track_id=payload.track_id)
            db.add(pt)
            await db.commit()
        return {"status": "added"}


@app.delete("/profiles/{profile_id}")
async def delete_profile(profile_id: int):
    """Delete user profile and its custom playlists."""
    from sqlalchemy import delete
    async with async_session() as db:
        profile = (await db.execute(select(UserProfile).where(UserProfile.id == profile_id))).scalar_one_or_none()
        if not profile:
            raise HTTPException(404, "Profile not found")
        
        # Delete custom playlists for this profile
        pls = (await db.execute(select(CustomPlaylist).where(CustomPlaylist.profile_id == profile_id))).scalars().all()
        for pl in pls:
            await db.execute(delete(PlaylistTrack).where(PlaylistTrack.playlist_id == pl.id))
            await db.delete(pl)
            
        await db.delete(profile)
        await db.commit()
    return {"ok": True}


@app.post("/ingest")
async def ingest(req: IngestRequest):
    """Trigger background ingestion for single YouTube tracks or Spotify playlists."""
    return await ingest_service.ingest_url(
        req.url,
        profile_id=req.profile_id,
        create_playlist=req.create_playlist,
        playlist_name=req.playlist_name,
    )


@app.get("/download-logs")
async def get_download_logs():
    """Retrieve real-time ingestion log buffer for Download Terminal console."""
    return ingest_service.get_logs()


@app.post("/download-logs/clear")
async def clear_download_logs():
    """Clear server download log buffer."""
    ingest_service.clear_logs()
    return {"ok": True}



@app.get("/tracks", response_model=list[TrackResponse])
async def list_tracks():
    """Retrieve all tracks in global server library."""
    async with async_session() as db:
        result = await db.execute(select(Track).order_by(Track.created_at.desc()))
        tracks = result.scalars().all()
        return [
            TrackResponse(
                id=t.id,
                title=t.title,
                artist=t.artist,
                duration=t.duration,
                status=t.status,
                progress=t.progress or 0.0,
                step=t.step or "Queued",
                playlist=t.playlist_name or "My Library",
                error=t.error_msg,
                profile_id=t.profile_id,
            )
            for t in tracks
        ]



@app.get("/download/{track_id}")
async def download_track(track_id: int):
    """Download or stream audio file for ready track."""
    async with async_session() as db:
        track = (await db.execute(select(Track).where(Track.id == track_id))).scalar_one_or_none()
        if not track or track.status != "ready":
            raise HTTPException(404, "Track not ready")

        path = MEDIA_DIR / track.filename
        if not path.exists():
            raise HTTPException(404, "File missing")

        # Format filename as "title - artist.mp3"
        clean_title = "".join(c if (c.isalnum() or c in " -_().,") and 32 <= ord(c) < 127 else " " for c in (track.title or "")).strip()
        clean_artist = "".join(c if (c.isalnum() or c in " -_().,") and 32 <= ord(c) < 127 else " " for c in (track.artist or "")).strip()

        if clean_title and clean_artist:
            safe_name = f"{clean_title} - {clean_artist}"
        else:
            safe_name = clean_title or clean_artist or "track"

        safe_name = " ".join(safe_name.split())
        download_filename = f"{safe_name}.mp3"

        response = FileResponse(path, media_type="audio/mpeg")
        response.headers["Content-Disposition"] = f'attachment; filename="{download_filename}"'
        return response


@app.patch("/tracks/{track_id}")
async def update_track(track_id: int, payload: UpdateTrackPayload):
    """Update user-managed track metadata and playlist assignment."""
    async with async_session() as db:
        track = (await db.execute(select(Track).where(Track.id == track_id))).scalar_one_or_none()
        if not track:
            raise HTTPException(404, "Track not found")

        if payload.playlist is not None:
            track.playlist_name = payload.playlist
        if payload.title is not None:
            title = payload.title.strip()
            if not title:
                raise HTTPException(400, "Title cannot be empty")
            track.title = title[:300]
        if payload.artist is not None:
            artist = payload.artist.strip()
            if not artist:
                raise HTTPException(400, "Artist cannot be empty")
            track.artist = artist[:300]
        await db.commit()

        if payload.title is not None or payload.artist is not None:
            await asyncio.to_thread(
                write_mp3_tags, MEDIA_DIR / track.filename, track.title, track.artist
            )

    return {"ok": True}


@app.delete("/tracks/{track_id}")
async def delete_track(track_id: int):
    """Delete track record and audio file from storage."""
    async with async_session() as db:
        track = (await db.execute(select(Track).where(Track.id == track_id))).scalar_one_or_none()
        if not track:
            raise HTTPException(404, "Track not found")

        path = MEDIA_DIR / track.filename
        if path.exists():
            try:
                os.remove(path)
            except OSError:
                pass

        await db.delete(track)
        await db.commit()

    return {"ok": True}


@app.delete("/tracks/pending/clear")
async def clear_pending_tracks():
    """Clear all stuck pending and processing tracks from queue."""
    from sqlalchemy import delete
    async with async_session() as db:
        res = await db.execute(delete(Track).where(Track.status.in_(["pending", "processing"])))
        await db.commit()
    return {"ok": True, "cleared": res.rowcount}



# WebSocket Jam Mode
@app.websocket("/ws/{room_id}")
async def ws_jam(ws: WebSocket, room_id: str):
    """Synchronized playback WebSocket room connection."""
    await manager.connect(room_id, ws)
    try:
        while True:
            data = await ws.receive_text()
            await manager.handle_message(room_id, ws, data)
    except WebSocketDisconnect:
        manager.disconnect(room_id, ws)
        await manager.broadcast(
            room_id,
            {
                "type": "member_update",
                "members": len(manager.rooms.get(room_id, set())),
            },
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=HOST, port=PORT, reload=True)
