import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
MEDIA_DIR = BASE_DIR / os.getenv("MEDIA_DIR", "media")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./music.db")
ACCESS_KEY = os.getenv("ACCESS_KEY", "Bills Mafia")

MEDIA_DIR.mkdir(exist_ok=True)

