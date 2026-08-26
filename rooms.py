import time
import json
from collections import defaultdict
from fastapi import WebSocket


class RoomManager:
    """Manager handling WebSocket client connections and realtime playback synchronization."""

    def __init__(self):
        self.rooms: dict[str, set[WebSocket]] = defaultdict(set)
        self.hosts: dict[str, WebSocket] = {}
        self.room_states: dict[str, dict] = {}

    def _get_current_position(self, room_id: str) -> float:
        state = self.room_states.get(room_id)
        if not state:
            return 0.0
        pos = state.get("position", 0.0)
        if state.get("is_playing"):
            elapsed = time.time() - state.get("updated_at", time.time())
            pos += max(0.0, elapsed)
        return round(pos, 2)

    async def connect(self, room_id: str, ws: WebSocket):
        await ws.accept()
        is_first = len(self.rooms[room_id]) == 0
        self.rooms[room_id].add(ws)

        if room_id not in self.room_states:
            self.room_states[room_id] = {
                "track_id": None,
                "position": 0.0,
                "is_playing": False,
                "updated_at": time.time(),
            }

        if is_first or room_id not in self.hosts or self.hosts[room_id] not in self.rooms[room_id]:
            self.hosts[room_id] = ws
            is_first = True

        state = self.room_states[room_id]
        curr_pos = self._get_current_position(room_id)

        await ws.send_json({
            "type": "connected",
            "room": room_id,
            "is_host": (ws is self.hosts[room_id]),
            "members": len(self.rooms[room_id]),
            "state": {
                "track_id": state.get("track_id"),
                "position": curr_pos,
                "is_playing": state.get("is_playing", False),
            }
        })

        await self.broadcast(
            room_id,
            {
                "type": "member_update",
                "members": len(self.rooms[room_id]),
            },
            exclude=ws,
        )

    def disconnect(self, room_id: str, ws: WebSocket):
        self.rooms[room_id].discard(ws)
        if not self.rooms[room_id]:
            self.rooms.pop(room_id, None)
            self.hosts.pop(room_id, None)
            self.room_states.pop(room_id, None)
        elif self.hosts.get(room_id) is ws:
            self.hosts[room_id] = next(iter(self.rooms[room_id]))

    async def broadcast(self, room_id: str, data: dict, exclude: WebSocket | None = None):
        data["server_ts"] = time.time()
        dead = []
        for client in list(self.rooms.get(room_id, set())):
            if client is exclude:
                continue
            try:
                await client.send_json(data)
            except Exception:
                dead.append(client)

        for client in dead:
            self.rooms[room_id].discard(client)
            if self.hosts.get(room_id) is client:
                if self.rooms[room_id]:
                    self.hosts[room_id] = next(iter(self.rooms[room_id]))
                else:
                    self.hosts.pop(room_id, None)
                    self.rooms.pop(room_id, None)
                    self.room_states.pop(room_id, None)

    async def handle_message(self, room_id: str, ws: WebSocket, raw: str):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return

        event_type = data.get("type")
        if event_type not in ("play", "pause", "seek", "track_change", "request_sync"):
            return

        now = time.time()
        if room_id not in self.room_states:
            self.room_states[room_id] = {
                "track_id": None,
                "position": 0.0,
                "is_playing": False,
                "updated_at": now,
            }
        state = self.room_states[room_id]

        if event_type == "track_change":
            state["track_id"] = data.get("track_id")
            state["position"] = float(data.get("position", 0.0))
            state["is_playing"] = True
            state["updated_at"] = now
        elif event_type == "play":
            pos = float(data.get("position", self._get_current_position(room_id)))
            state["position"] = pos
            state["is_playing"] = True
            state["updated_at"] = now
            data["position"] = pos
        elif event_type == "pause":
            pos = float(data.get("position", self._get_current_position(room_id)))
            state["position"] = pos
            state["is_playing"] = False
            state["updated_at"] = now
            data["position"] = pos
        elif event_type == "seek":
            pos = float(data.get("position", 0.0))
            state["position"] = pos
            state["updated_at"] = now
            data["position"] = pos

        data["server_ts"] = now
        data["is_host"] = (ws is self.hosts.get(room_id))

        # Broadcast event to all other clients in the room
        await self.broadcast(room_id, data, exclude=ws)


manager = RoomManager()

