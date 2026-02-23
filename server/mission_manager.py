"""
MissionManager — in-memory mission storage with JSON persistence.

Mission format (in-memory and on disk):
{
    "missions": [
        {
            "id": "mission-1",
            "name": "Survey Route A",
            "waypoints": [
                {"lat": 56.123, "lng": 24.456},
                ...
            ]
        }
    ]
}

The server is the single source of truth. The browser receives the full
mission list on connect and re-renders whenever the list changes.
"""

import json
import os
import threading

from .log import info as _log_info, warn as _log_warn, error as _log_error


class MissionManager:
    def __init__(self, json_path=None):
        """
        Args:
            json_path: path to missions.json. If None, uses 'missions.json'
                       in the project root (one directory above server/).
        """
        if json_path is None:
            json_path = os.path.join(
                os.path.dirname(os.path.realpath(__file__)), '..', 'missions.json'
            )
        self._json_path = os.path.abspath(json_path)
        self._lock = threading.Lock()
        self._missions = []
        self.load()

    def load(self):
        """Load missions from json_path. Creates empty structure if missing or malformed."""
        with self._lock:
            if not os.path.isfile(self._json_path):
                _log_info("MissionManager",
                          "missions.json not found at %s — starting empty" % self._json_path)
                self._missions = []
                return
            try:
                with open(self._json_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                self._missions = data.get('missions', [])
                _log_info("MissionManager",
                          "Loaded %d mission(s) from %s" % (len(self._missions), self._json_path))
            except Exception as e:
                _log_error("MissionManager",
                           "Failed to load %s: %s — starting empty" % (self._json_path, e))
                self._missions = []

    def save(self):
        """Write current state to json_path. Thread-safe."""
        with self._lock:
            try:
                with open(self._json_path, 'w', encoding='utf-8') as f:
                    json.dump({'missions': self._missions}, f, indent=2)
            except Exception as e:
                _log_error("MissionManager", "Failed to save to %s: %s" % (self._json_path, e))

    def get_missions(self):
        """Return a copy of the mission list. Thread-safe."""
        with self._lock:
            return list(self._missions)

    def get_mission_list_payload(self):
        """Ready-to-broadcast payload for MSG_MISSIONS ('w') message."""
        return {'missions': self.get_missions()}
