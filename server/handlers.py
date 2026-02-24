import json
import os
import sqlite3
import time
import types
import uuid
import traceback

import tornado.web
import tornado.websocket

from .log import info as _log, warn as _log_w, error as _log_e


class NoCacheStaticFileHandler(tornado.web.StaticFileHandler):
    def set_extra_headers(self, path):
        self.set_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')


class USVSocketHandler(tornado.websocket.WebSocketHandler):
    """
    WebSocket handler for USV web control.

    Protocol (JSON arrays over WebSocket):
      Browser -> Server:
        ["q", {"s": <seq>}]                          - PONG (latency response)
        ["s", {"topicName": ..., "maxUpdateRate": N}] - SUBSCRIBE to ROS topic
        ["u", {"topicName": ...}]                     - UNSUBSCRIBE from ROS topic
        ["j", {"axes": [...], "buttons": [...]}]      - JOYSTICK data (publish to /joy)

      Server -> Browser:
        ["p", {"s": <seq>}]   - PING
        ["m", {ros msg dict}] - ROS MESSAGE data
        ["t", {topic_map}]    - TOPIC LIST
        ["y", {system_info}]  - SYSTEM info on connect
    """

    # Message type constants
    MSG_PING = "p"
    MSG_PONG = "q"
    MSG_MSG = "m"
    MSG_TOPICS = "t"
    MSG_SUB = "s"
    MSG_UNSUB = "u"
    MSG_SYSTEM = "y"
    MSG_JOY = "j"  # joystick publish (browser -> server)
    MSG_RESOURCES = "r"  # system metrics (CPU/GPU usage)
    MSG_VIDEO_META = "v"  # video stream metadata (fps, resolution, encoder)
    MSG_CAMERAS = "c"     # camera list (server -> browser)
    MSG_CAM_SUB = "d"     # camera subscribe (browser -> server)
    MSG_CAM_UNSUB = "e"   # camera unsubscribe (browser -> server)
    MSG_VIDEO_SETTINGS = "f"  # per-stream settings override (browser -> server)
    MSG_MISSIONS = "w"    # mission list (server -> browser)
    MSG_GPS_POS  = "g"    # USV GPS position update (server -> browser)

    PING_SEQ = "s"
    PONG_SEQ = "s"

    sockets = set()

    def initialize(self, node):
        self.node = node

    def get_compression_options(self):
        return {}

    def check_origin(self, origin):
        # Allow connections from any origin (needed for WireGuard access)
        return True

    def open(self):
        self.id = uuid.uuid4()
        self.latency = 0
        self.last_ping_times = [0] * 1024
        self.ping_seq = 0
        self.set_nodelay(True)

        # Polyfill for older tornado
        if not hasattr(self.ws_connection, "is_closing"):
            self.ws_connection.is_closing = types.MethodType(
                lambda self_: self_.stream.closed() or self_.client_terminated or self_.server_terminated,
                self.ws_connection
            )

        self.update_intervals_by_topic = {}
        self.last_data_times_by_topic = {}

        USVSocketHandler.sockets.add(self)
        self.node.loginfo("WebSocket client connected: %s" % str(self.id))

        self.write_message(json.dumps([self.MSG_SYSTEM, {
            "hostname": self.node.title,
            "version": self.node.version,
        }], separators=(',', ':')))

        # Send camera list immediately so client doesn't wait for sync cycle
        if self.node.cameras_available:
            self.write_message(json.dumps([self.MSG_CAMERAS,
                self.node.cameras_available], separators=(',', ':')))

        # Send mission list immediately on connect
        if self.node.mission_manager:
            self.write_message(json.dumps(
                [self.MSG_MISSIONS, self.node.mission_manager.get_mission_list_payload()],
                separators=(',', ':')
            ))

    def on_close(self):
        USVSocketHandler.sockets.discard(self)
        for topic_name in self.node.remote_subs:
            self.node.remote_subs[topic_name].discard(self.id)
        # Clean up camera subscriptions
        for camera_id in list(self.node.camera_remote_subs.keys()):
            self.node.camera_remote_subs[camera_id].discard(self.id)
        # Stop camera streams that have no remaining subscribers
        self.node.sync_camera_streams()
        self.node.loginfo("WebSocket client disconnected: %s" % str(self.id))

    @classmethod
    def send_pings(cls):
        for sock in cls.sockets:
            try:
                sock.last_ping_times[sock.ping_seq % 1024] = time.time() * 1000
                if sock.ws_connection and not sock.ws_connection.is_closing():
                    sock.write_message(json.dumps([cls.MSG_PING, {
                        cls.PING_SEQ: sock.ping_seq,
                        "l": round(sock.latency, 1),
                    }], separators=(',', ':')))
                sock.ping_seq += 1
            except Exception as e:
                _log_e("WebSocket", "Error sending ping: %s" % str(e))

    @classmethod
    def broadcast_binary(cls, binary_frame):
        """Send binary H.264 video frame to subscribed clients.

        Binary frame format:
            [1 byte: topic name length N] [N bytes: topic name UTF-8] [H.264 data]

        No per-client throttle — FFmpeg controls the output rate, and
        throttling mid-stream H.264 would corrupt the decoder state.
        """
        try:
            topic_name_len = binary_frame[0]
            topic_name = binary_frame[1:1 + topic_name_len].decode('utf-8')

            for sock in cls.sockets:
                # Check both ROS2 topic subs and camera subs
                subscribed = False
                if topic_name in sock.node.remote_subs and sock.id in sock.node.remote_subs[topic_name]:
                    subscribed = True
                elif topic_name in sock.node.camera_remote_subs and sock.id in sock.node.camera_remote_subs[topic_name]:
                    subscribed = True
                if not subscribed:
                    continue
                if sock.ws_connection and not sock.ws_connection.is_closing():
                    try:
                        sock.write_message(binary_frame, binary=True)
                    except Exception:
                        pass
        except Exception as e:
            _log_e("WebSocket", "Error broadcasting binary: %s" % str(e))

    @classmethod
    def broadcast(cls, message):
        try:
            if message[0] == cls.MSG_TOPICS:
                json_msg = json.dumps(message, separators=(',', ':'))
                for sock in cls.sockets:
                    if sock.ws_connection and not sock.ws_connection.is_closing():
                        sock.write_message(json_msg)

            elif message[0] in (cls.MSG_RESOURCES, cls.MSG_VIDEO_META, cls.MSG_CAMERAS,
                               cls.MSG_MISSIONS, cls.MSG_GPS_POS):
                json_msg = json.dumps(message, separators=(',', ':'))
                for sock in cls.sockets:
                    if sock.ws_connection and not sock.ws_connection.is_closing():
                        sock.write_message(json_msg)

            elif message[0] == cls.MSG_MSG:
                topic_name = message[1]["_topic_name"]
                json_msg = None
                for sock in cls.sockets:
                    if topic_name not in sock.node.remote_subs:
                        continue
                    if sock.id not in sock.node.remote_subs[topic_name]:
                        continue
                    t = time.time()
                    if t - sock.last_data_times_by_topic.get(topic_name, 0.0) < \
                            sock.update_intervals_by_topic.get(topic_name, 0.0) - 2e-4:
                        continue
                    if sock.ws_connection and not sock.ws_connection.is_closing():
                        if json_msg is None:
                            json_msg = json.dumps(message, separators=(',', ':'))
                        sock.write_message(json_msg)
                    sock.last_data_times_by_topic[topic_name] = t
        except Exception as e:
            _log_e("WebSocket", "Error broadcasting: %s" % str(e))
            traceback.print_exc()

    def on_message(self, message):
        if self.ws_connection.is_closing():
            return

        try:
            argv = json.loads(message)
        except (ValueError, TypeError):
            _log_w("WebSocket", "Bad JSON: %s" % message[:200])
            return

        if type(argv) is not list or len(argv) < 1 or type(argv[0]) is not str:
            _log_w("WebSocket", "Bad message format: %s" % message[:200])
            return

        msg_type = argv[0]

        if msg_type == self.MSG_PONG:
            if len(argv) != 2 or type(argv[1]) is not dict:
                return
            received_time = time.time() * 1000
            seq = argv[1].get(self.PONG_SEQ, 0) % 1024
            self.latency = (received_time - self.last_ping_times[seq]) / 2

        elif msg_type == self.MSG_SUB:
            if len(argv) != 2 or type(argv[1]) is not dict:
                return
            topic_name = argv[1].get("topicName")
            if topic_name is None:
                return
            max_update_rate = float(argv[1].get("maxUpdateRate", 24.0))
            self.update_intervals_by_topic[topic_name] = 1.0 / max_update_rate
            self.node.update_intervals_by_topic[topic_name] = min(
                self.node.update_intervals_by_topic.get(topic_name, 1.0),
                self.update_intervals_by_topic[topic_name]
            )
            if topic_name not in self.node.remote_subs:
                self.node.remote_subs[topic_name] = set()
            self.node.remote_subs[topic_name].add(self.id)
            self.node.sync_subs()

        elif msg_type == self.MSG_UNSUB:
            if len(argv) != 2 or type(argv[1]) is not dict:
                return
            topic_name = argv[1].get("topicName")
            if topic_name in self.node.remote_subs:
                self.node.remote_subs[topic_name].discard(self.id)

        elif msg_type == self.MSG_JOY:
            if len(argv) != 2 or type(argv[1]) is not dict:
                return
            self.node.on_joy_input(argv[1])

        elif msg_type == self.MSG_CAM_SUB:
            if len(argv) != 2 or type(argv[1]) is not dict:
                return
            camera_id = argv[1].get("cameraId")
            if camera_id is None:
                return
            self.node.on_camera_subscribe(camera_id, self.id)

        elif msg_type == self.MSG_CAM_UNSUB:
            if len(argv) != 2 or type(argv[1]) is not dict:
                return
            camera_id = argv[1].get("cameraId")
            if camera_id is None:
                return
            self.node.on_camera_unsubscribe(camera_id, self.id)

        elif msg_type == self.MSG_VIDEO_SETTINGS:
            if len(argv) != 2 or type(argv[1]) is not dict:
                return
            topic = argv[1].get("topic")
            fps = argv[1].get("fps")       # int or 0 (auto)
            quality = argv[1].get("quality")  # "low" / "medium" / "high"
            if topic is not None:
                self.node.on_video_settings(topic, fps, quality)


class MBTilesHandler(tornado.web.RequestHandler):
    """
    Serves map tiles from an MBTiles SQLite file.

    URL pattern: /tiles/{z}/{x}/{y}.png
    MBTiles uses TMS y-axis (y=0 at south), so y is flipped:
        tms_y = (2^z - 1) - y
    Returns:
        200 + PNG bytes  — tile found
        204              — tile not in database (Leaflet shows blank tile)
        404              — mbtiles file not configured or missing

    SQLite connection is opened once and reused for all requests (check_same_thread=False
    is safe because Tornado runs handlers on a single event-loop thread).
    """

    # Class-level connection cache: path -> sqlite3.Connection
    _conns = {}

    def initialize(self, mbtiles_path):
        """
        Args:
            mbtiles_path: absolute path to .mbtiles file, or None if not configured.
        """
        self._mbtiles_path = mbtiles_path
        # Open connection once and cache it — avoids per-request open/close overhead.
        if mbtiles_path and mbtiles_path not in MBTilesHandler._conns:
            if os.path.isfile(mbtiles_path):
                try:
                    conn = sqlite3.connect(mbtiles_path, check_same_thread=False)
                    conn.row_factory = None  # raw tuples, faster
                    MBTilesHandler._conns[mbtiles_path] = conn
                    _log("MBTiles", "Opened database: %s" % mbtiles_path)
                except Exception as e:
                    _log_e("MBTiles", "Failed to open database %s: %s" % (mbtiles_path, e))

    def get(self, z, x, y):
        conn = MBTilesHandler._conns.get(self._mbtiles_path)
        if conn is None:
            self.set_status(404)
            self.finish()
            return

        try:
            z, x, y = int(z), int(x), int(y)
            tms_y = (2 ** z - 1) - y  # flip TMS y-axis

            cursor = conn.execute(
                "SELECT tile_data FROM tiles "
                "WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                (z, x, tms_y)
            )
            row = cursor.fetchone()

            if row is None:
                self.set_status(204)
                self.finish()
                return

            self.set_header('Content-Type', 'image/png')
            self.set_header('Cache-Control', 'public, max-age=86400')
            self.write(row[0])

        except Exception as e:
            _log_e("MBTiles", "Error serving tile %s/%s/%s: %s" % (z, x, y, e))
            self.set_status(500)
            self.finish()
