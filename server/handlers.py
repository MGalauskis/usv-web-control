import copy
import gzip
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


class CORSStaticFileHandler(tornado.web.StaticFileHandler):
    """StaticFileHandler that adds Access-Control-Allow-Origin: * for MapLibre assets."""
    def set_extra_headers(self, path):
        self.set_header('Access-Control-Allow-Origin', '*')


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
    MSG_MISSIONS  = "w"   # mission list (server -> browser)
    MSG_GPS_POS   = "g"   # USV GPS position update (server -> browser)
    MSG_MAP_LAYERS = "l"  # offline map layer list (server -> browser)

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

        # Send offline map layer list immediately on connect
        # Strip server-internal 'path' field — browser only needs 'label' and 'format'
        map_layers_public = {
            name: {
                'label': info['label'],
                'format': MBTilesHandler._meta.get(name, {}).get('format', 'png'),
            }
            for name, info in self.node.map_layers.items()
        }
        self.write_message(json.dumps(
            [self.MSG_MAP_LAYERS, map_layers_public],
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
    Serves map tiles from MBTiles SQLite files.

    URL pattern: /tiles/{layer_name}/{z}/{x}/{y}.png
    MBTiles uses TMS y-axis (y=0 at south), so y is flipped:
        tms_y = (2^z - 1) - y
    Returns:
        200 + PNG bytes  — tile found
        204              — tile not in database (Leaflet shows blank tile)
        404              — layer name unknown

    SQLite connections are opened once per layer at startup and reused
    (check_same_thread=False is safe — Tornado runs on a single event-loop thread).
    """

    # Class-level connection cache: layer_name -> sqlite3.Connection
    _conns = {}

    # Per-layer metadata cache: layer_name -> {format, normalised}
    _meta = {}

    @classmethod
    def open_layers(cls, layers):
        """
        Open SQLite connections for all offline map layers.
        Detects tile format (png/jpg/pbf) and schema (simple tiles table vs
        normalised images+map tables) from the MBTiles metadata table.
        layers: dict of layer_name -> {path, label, ...} (from usv_node.map_layers)
        Call once at server startup.
        """
        for name, info in layers.items():
            path = info.get('path', '')
            if not path or not os.path.isfile(path):
                continue
            if name in cls._conns:
                continue
            try:
                conn = sqlite3.connect(path, check_same_thread=False)
                conn.row_factory = None  # raw tuples, faster
                cls._conns[name] = conn

                # Read format from metadata table
                meta = dict(conn.execute(
                    "SELECT name, value FROM metadata WHERE name IN ('format','scheme')"
                ).fetchall())
                tile_format = meta.get('format', 'png').lower()

                # Detect whether the file uses the normalised schema (images+map)
                tables = {r[0] for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()}
                normalised = ('images' in tables and 'map' in tables and 'tiles' not in tables)

                cls._meta[name] = {'format': tile_format, 'normalised': normalised}
                _log("MBTiles", "Opened layer '%s': format=%s schema=%s path=%s"
                     % (name, tile_format, 'normalised' if normalised else 'simple', path))

                if tile_format == 'pbf':
                    _log("MBTiles", "Layer '%s' is vector PBF — will be served via MapLibre GL." % name)

            except Exception as e:
                _log_e("MBTiles", "Failed to open layer '%s' (%s): %s" % (name, path, e))

    def initialize(self, node):
        self._node = node

    def set_default_headers(self):
        self.set_header('Access-Control-Allow-Origin', '*')

    def get(self, layer_name, z, x, y):
        conn = MBTilesHandler._conns.get(layer_name)
        if conn is None:
            self.set_status(404)
            self.finish()
            return

        meta = MBTilesHandler._meta.get(layer_name, {})
        tile_format = meta.get('format', 'png')

        # Vector PBF layers are served by VectorTileHandler — redirect client
        if tile_format == 'pbf':
            self.set_status(404)
            self.finish()
            return

        try:
            z, x, y = int(z), int(x), int(y)
            tms_y = (2 ** z - 1) - y  # flip TMS y-axis

            if meta.get('normalised'):
                # Normalised schema: tile_data lives in 'images', keyed via 'map'
                cursor = conn.execute(
                    "SELECT images.tile_data FROM images "
                    "JOIN map ON images.tile_id = map.tile_id "
                    "WHERE map.zoom_level=? AND map.tile_column=? AND map.tile_row=?",
                    (z, x, tms_y)
                )
            else:
                # Simple schema: tile_data directly in 'tiles'
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

            content_type = 'image/jpeg' if tile_format in ('jpg', 'jpeg') else 'image/png'
            self.set_header('Content-Type', content_type)
            self.set_header('Cache-Control', 'public, max-age=86400')
            self.write(row[0])

        except Exception as e:
            _log_e("MBTiles", "Error serving tile %s/%s/%s/%s: %s" % (layer_name, z, x, y, e))
            self.set_status(500)
            self.finish()


class VectorTileHandler(tornado.web.RequestHandler):
    """
    Serves vector PBF tiles from MBTiles SQLite files.

    URL pattern: /tiles/{layer_name}/{z}/{x}/{y}.pbf
    MBTiles stores rows in TMS order (y=0 at south); MapLibre uses XYZ (y=0 at north),
    so y is flipped: tms_y = (2^z - 1) - y.
    Tiles in MBTiles are stored gzip-compressed; we return them as-is
    with Content-Encoding: gzip so the browser decompresses.

    Returns:
        200 + PBF bytes  — tile found
        204              — tile not in database (MapLibre shows empty tile)
        404              — layer name unknown or not a vector layer
    """

    def initialize(self, node):
        self._node = node

    def set_default_headers(self):
        self.set_header('Access-Control-Allow-Origin', '*')

    def get(self, layer_name, z, x, y):
        conn = MBTilesHandler._conns.get(layer_name)
        if conn is None:
            self.set_status(404)
            self.finish()
            return

        meta = MBTilesHandler._meta.get(layer_name, {})
        if meta.get('format', '') != 'pbf':
            self.set_status(404)
            self.finish()
            return

        try:
            z, x, y = int(z), int(x), int(y)
            # MBTiles always uses TMS row order (y=0 at south).
            # MapLibre requests XYZ (y=0 at north), so flip y.
            tms_y = (2 ** z - 1) - y

            if meta.get('normalised'):
                cursor = conn.execute(
                    "SELECT images.tile_data FROM images "
                    "JOIN map ON images.tile_id = map.tile_id "
                    "WHERE map.zoom_level=? AND map.tile_column=? AND map.tile_row=?",
                    (z, x, tms_y)
                )
            else:
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

            tile_data = bytes(row[0])

            # MBTiles PBF tiles are stored gzip-compressed.
            # Detect by magic bytes [1f 8b]; if already gzip, send as-is.
            # MapLibre GL decompresses them automatically.
            if tile_data[:2] == b'\x1f\x8b':
                # Already gzip-compressed
                self.set_header('Content-Encoding', 'gzip')
            else:
                # Compress on the fly (rare, but handle it)
                tile_data = gzip.compress(tile_data)
                self.set_header('Content-Encoding', 'gzip')

            self.set_header('Content-Type', 'application/x-protobuf')
            self.set_header('Cache-Control', 'public, max-age=86400')
            self.write(tile_data)

        except Exception as e:
            _log_e("VectorTile", "Error serving tile %s/%s/%s/%s: %s" % (layer_name, z, x, y, e))
            self.set_status(500)
            self.finish()


class MapStyleHandler(tornado.web.RequestHandler):
    """
    Serves a per-layer MapLibre GL Style JSON for vector PBF layers.

    URL pattern: /style/{layer_name}.json
    Loads positron-base.json from frontend/style/, patches:
      - sources.openmaptiles  → local /tiles/{layer_name}/{z}/{x}/{y}.pbf
      - glyphs                → /fonts/{fontstack}/{range}.pbf
      - sprite                → /sprites/positron
    Returns patched JSON with no-cache headers.
    """

    # Cached base style — loaded once, patched per-request
    _base_style = None
    _base_style_path = None

    @classmethod
    def set_style_path(cls, path):
        cls._base_style_path = path

    def initialize(self, node):
        self._node = node

    def set_default_headers(self):
        self.set_header('Access-Control-Allow-Origin', '*')

    def get(self, layer_name):
        _log("MapStyle", "Request for layer '%s' (path=%s)" % (layer_name, MapStyleHandler._base_style_path))

        conn = MBTilesHandler._conns.get(layer_name)
        if conn is None:
            _log_w("MapStyle", "Layer '%s' not found in _conns (keys: %s)" % (layer_name, list(MBTilesHandler._conns.keys())))
            self.set_status(404)
            self.finish()
            return

        meta = MBTilesHandler._meta.get(layer_name, {})
        if meta.get('format', '') != 'pbf':
            _log_w("MapStyle", "Layer '%s' is not pbf (format=%s)" % (layer_name, meta.get('format')))
            self.set_status(404)
            self.finish()
            return

        if MapStyleHandler._base_style is None:
            try:
                with open(MapStyleHandler._base_style_path, 'r', encoding='utf-8') as f:
                    MapStyleHandler._base_style = json.load(f)
                _log("MapStyle", "Loaded base style from %s" % MapStyleHandler._base_style_path)
            except Exception as e:
                _log_e("MapStyle", "Failed to load base style from '%s': %s" % (MapStyleHandler._base_style_path, e))
                self.set_status(500)
                self.finish()
                return

        style = copy.deepcopy(MapStyleHandler._base_style)

        # MapLibre GL requires absolute URLs in tiles[], glyphs, and sprite.
        # Build them from the Host header so they work on any port / WireGuard IP.
        host = self.request.host  # e.g. "localhost:8888" or "10.0.0.1:8888"
        origin = 'http://%s' % host

        # Patch sources: replace remote MapTiler URL with our local tile server
        style['sources'] = {
            'openmaptiles': {
                'type': 'vector',
                'tiles': ['%s/tiles/%s/{z}/{x}/{y}.pbf' % (origin, layer_name)],
                'minzoom': 0,
                'maxzoom': 14,
            }
        }

        # Patch glyphs: absolute URL — MapLibre substitutes {fontstack} and {range}
        style['glyphs'] = '%s/fonts/{fontstack}/{range}.pbf' % origin

        # Patch sprite: absolute URL (MapLibre appends .json / .png / @2x.png)
        style['sprite'] = '%s/sprites/positron' % origin

        # Remap all text-font references to fonts we actually serve locally.
        # positron-base.json uses "Metropolis *" and "Noto Sans *" which we don't have.
        # We only bundle "Open Sans Regular", so substitute that for every layer.
        for layer in style.get('layers', []):
            layout = layer.get('layout', {})
            if 'text-font' in layout:
                layout['text-font'] = ['Open Sans Regular']

        style_json = json.dumps(style, separators=(',', ':'))
        _log("MapStyle", "Serving style for '%s' (%d bytes, origin=%s)" % (layer_name, len(style_json), origin))
        self.set_header('Content-Type', 'application/json')
        self.set_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.write(style_json)
        self.finish()
