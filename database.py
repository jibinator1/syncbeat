from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, Float, DateTime, Text, inspect, text
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from config import DATABASE_URL

engine = create_async_engine(DATABASE_URL, echo=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Track(Base):
    __tablename__ = "tracks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    title = Column(String(300), nullable=False, default="Unknown")
    artist = Column(String(300), nullable=False, default="Unknown")
    duration = Column(Float, nullable=True)
    filename = Column(String(500), nullable=False, unique=True)
    youtube_url = Column(Text, nullable=False)
    status = Column(String(20), nullable=False, default="pending")
    progress = Column(Float, nullable=False, default=0.0)
    step = Column(String(100), nullable=False, default="Queued")
    error_msg = Column(Text, nullable=True)
    playlist_name = Column(String(300), nullable=True, default="My Library")
    profile_id = Column(Integer, nullable=True, default=None)  # which profile downloaded this
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))




class UserProfile(Base):
    __tablename__ = "user_profiles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False, unique=True)
    avatar = Column(String(10), nullable=False, default="🎧")  # emoji avatar
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class CustomPlaylist(Base):
    __tablename__ = "custom_playlists"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(200), nullable=False)
    profile_id = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class PlaylistTrack(Base):
    __tablename__ = "playlist_tracks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    playlist_id = Column(Integer, nullable=False)
    track_id = Column(Integer, nullable=False)


def _run_migrations(connection):
    """Ensure database schema migration updates are safely applied."""
    inspector = inspect(connection)
    columns = [c["name"] for c in inspector.get_columns("tracks")]
    if "playlist_name" not in columns:
        connection.execute(
            text("ALTER TABLE tracks ADD COLUMN playlist_name VARCHAR(300) DEFAULT 'My Library'")
        )
    if "profile_id" not in columns:
        connection.execute(
            text("ALTER TABLE tracks ADD COLUMN profile_id INTEGER DEFAULT NULL")
        )


async def init_db():
    """Initialize database tables and run schema migrations."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_run_migrations)

