#!/usr/bin/env python3
"""
USV Web Control Node

A Tornado-based web server that bridges a browser UI to ROS2.
Inspired by rosboard's architecture but with bidirectional communication:
  - Browser can SUBSCRIBE to any ROS2 topic (telemetry, GPS, IMU, etc.)
  - Browser can PUBLISH joystick data to /joy (sensor_msgs/msg/Joy)
  - Custom REST API endpoints for mission control, system status, etc.
"""

import asyncio
import importlib
import math
import os
import socket
import threading
import time
import traceback

import tornado
import tornado.web
import tornado.websocket

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, QoSReliabilityPolicy, QoSDurabilityPolicy, HistoryPolicy

from sensor_msgs.msg import Joy

from .handlers import USVSocketHandler, NoCacheStaticFileHandler, MBTilesHandler
from .mission_manager import MissionManager
from .video_stream import H264Stream, get_max_fps, get_encoder
from .camera_stream import (
    GStreamerStream, load_camera_config, build_cameras_available,
    has_gstreamer, get_gst_encoder,
)
from .system_metrics import SystemMetricsCollector
from . import log as _clog
from . import __version__


def ros2dict(msg):
    """
    Convert a ROS2 message to a Python dict, recursively.
    Handles nested messages, arrays, and primitive types.
    """
    if hasattr(msg, 'get_fields_and_field_types'):
        result = {}
        for field_name, field_type in msg.get_fields_and_field_types().items():
            value = getattr(msg, field_name)
            result[field_name] = ros2dict(value)
        return result
    elif isinstance(msg, (list, tuple)):
        return [ros2dict(item) for item in msg]
    elif isinstance(msg, bytes):
        # uint8[] comes as bytes in ROS2
        return list(msg)
    elif isinstance(msg, (int, float, str, bool)):
        return msg
    else:
        # numpy arrays, etc.
        try:
            return msg.tolist()
        except AttributeError:
            return str(msg)


class USVWebNode(Node):
    def __init__(self):
        super().__init__('usv_web_control')

        # Parameters
        self.declare_parameter('port', 8888)
        self.declare_parameter('title', socket.gethostname())
        self.declare_parameter('joy_topic', '/joy')
        self.declare_parameter('mbtiles_path', '')

        self.port = self.get_parameter('port').value
        self.title = self.get_parameter('title').value
        self.joy_topic = self.get_parameter('joy_topic').value
        self.version = __version__

        # Resolve MBTiles path (default: map.mbtiles in project root)
        project_root = os.path.abspath(
            os.path.join(os.path.dirname(os.path.realpath(__file__)), '..')
        )
        mbtiles_param = self.get_parameter('mbtiles_path').value
        if mbtiles_param:
            mbtiles_param = mbtiles_param if os.path.isabs(mbtiles_param) \
                else os.path.join(project_root, mbtiles_param)
        else:
            mbtiles_param = os.path.join(project_root, 'map.mbtiles')
        self.mbtiles_path = os.path.abspath(mbtiles_param) \
            if os.path.isfile(mbtiles_param) else None
        if self.mbtiles_path:
            self.loginfo("MBTiles offline map: %s" % self.mbtiles_path)
        else:
            self.loginfo("No map.mbtiles found — offline map layer disabled")

        # --- Joy publisher ---
        self.joy_pub = self.create_publisher(Joy, self.joy_topic, 10)
        self.last_joy_time = 0.0
        self.joy_min_interval = 1.0 / 60.0  # max 60Hz publish rate

        # --- Topic subscription management (rosboard-style) ---
        # Remote subs: dict of topic_name -> set of socket UUIDs
        self.remote_subs = {}
        # Local ROS subscribers: dict of topic_name -> Subscription
        self.local_subs = {}
        # Throttle intervals per topic
        self.update_intervals_by_topic = {}
        # Last data time per topic
        self.last_data_times_by_topic = {}

        # All known topics
        self.all_topics = {}

        # H.264 video streams: topic_name -> H264Stream instance
        self.video_streams = {}
        self.image_topic_types = {"sensor_msgs/msg/Image"}
        self.default_video_fps = 30  # initial guess before auto-detection kicks in

        # FPS auto-detection: track frame arrival timestamps per topic
        self._frame_timestamps = {}  # topic_name -> list of recent timestamps
        self._detected_fps = {}      # topic_name -> detected FPS (int)
        self._FPS_WINDOW = 30        # number of frames to average over

        # Image frame throttling: only copy/feed frames at the target FPS
        self._last_image_feed_time = {}   # topic_name -> time.monotonic() of last fed frame
        self._image_frame_count = {}      # topic_name -> total frames received (for FPS detection sampling)

        # --- Per-stream video settings overrides (from browser) ---
        # topic_name -> {"fps": int, "quality": str}  (0 fps = auto)
        self._video_settings = {}

        # --- GStreamer direct camera streams (bypass ROS2) ---
        self.camera_streams = {}        # camera_id -> GStreamerStream instance
        self.camera_remote_subs = {}    # camera_id -> set of socket UUIDs
        self.cameras_available = {}     # camera_id -> info dict (sent to browser)
        self._camera_configs_by_id = {} # camera_id -> config dict

        # Load camera config (project_root defined earlier during parameter resolution)
        cameras_yaml = os.path.join(project_root, 'cameras.yaml')
        camera_configs = load_camera_config(cameras_yaml)
        self.cameras_available = build_cameras_available(camera_configs)
        # Map camera_id -> config for stream creation
        for config in camera_configs:
            for cam_id, info in self.cameras_available.items():
                if info["name"] == config.get("name"):
                    self._camera_configs_by_id[cam_id] = config
                    break

        if has_gstreamer():
            gst_enc = get_gst_encoder()
            self.loginfo("GStreamer available (encoder: %s), %d camera(s) configured"
                         % (gst_enc or "none", len(self.cameras_available)))
        else:
            self.loginfo("GStreamer not available — direct camera streams disabled")

        # --- Mission manager ---
        self.mission_manager = MissionManager(
            json_path=os.path.join(project_root, 'missions.json')
        )

        # --- GPS auto-subscription state ---
        self._gps_topic = None           # name of currently subscribed NavSatFix topic
        self._gps_sub = None             # rclpy Subscription
        self._last_gps_broadcast = 0.0   # monotonic time of last GPS broadcast
        self.NAV_SAT_FIX_TYPE = "sensor_msgs/msg/NavSatFix"

        self.lock = threading.Lock()

        # --- Tornado web server ---
        static_path = os.path.join(os.path.dirname(os.path.realpath(__file__)), '..', 'frontend')

        tornado_handlers = [
            (r"/ws", USVSocketHandler, {"node": self}),
            (r"/tiles/(\d+)/(\d+)/(\d+)\.png", MBTilesHandler, {
                "mbtiles_path": self.mbtiles_path,
            }),
            (r"/(.*)", NoCacheStaticFileHandler, {
                "path": os.path.abspath(static_path),
                "default_filename": "index.html",
            }),
        ]

        tornado_settings = {
            'debug': True,
            'static_path': os.path.abspath(static_path),
        }

        asyncio.set_event_loop(asyncio.new_event_loop())
        self.event_loop = tornado.ioloop.IOLoop()
        self.tornado_app = tornado.web.Application(tornado_handlers, **tornado_settings)
        self.tornado_app.listen(self.port, address="0.0.0.0")

        # --- System metrics collector ---
        self.metrics_collector = SystemMetricsCollector(interval=2.0)
        self.metrics_collector.on_metrics = self._on_system_metrics
        self.metrics_collector.start()

        # Start threads
        threading.Thread(target=self.event_loop.start, daemon=True).start()
        threading.Thread(target=self.sync_subs_loop, daemon=True).start()
        threading.Thread(target=self.pingpong_loop, daemon=True).start()
        threading.Thread(target=self._dummy_gps_loop, daemon=True).start()

        self.loginfo("USV Web Control listening on :%d" % self.port)

    # --- Logging helpers (ROS2 logger + colored stderr) ---
    def loginfo(self, msg):
        self.get_logger().info(msg)
        _clog.info("USVNode", msg)

    def logwarn(self, msg):
        self.get_logger().warn(msg)
        _clog.warn("USVNode", msg)

    def logerr(self, msg):
        self.get_logger().error(msg)
        _clog.error("USVNode", msg)

    # --- Joystick publish ---
    def on_joy_input(self, data):
        """
        Called by WebSocket handler when browser sends joystick data.
        data = {"axes": [float, ...], "buttons": [int, ...]}
        """
        t = time.time()
        if t - self.last_joy_time < self.joy_min_interval:
            return  # throttle

        axes = data.get("axes", [])
        buttons = data.get("buttons", [])

        msg = Joy()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = "web_joystick"
        msg.axes = [float(a) for a in axes]
        msg.buttons = [int(b) for b in buttons]

        self.joy_pub.publish(msg)
        self.last_joy_time = t

    # --- Topic subscription management ---
    def get_msg_class(self, msg_type):
        """Import and return a ROS2 message class from its type string."""
        try:
            msg_module, _, msg_class_name = msg_type.replace("/", ".").rpartition(".")
        except ValueError:
            self.logerr("Invalid message type: %s" % msg_type)
            return None

        try:
            if not msg_module.endswith(".msg"):
                msg_module = msg_module + ".msg"
            return getattr(importlib.import_module(msg_module), msg_class_name)
        except Exception as e:
            self.logerr("Could not import %s: %s" % (msg_type, str(e)))
            return None

    def get_topic_qos(self, topic_name):
        """Match the QoS of existing publishers on a topic."""
        topic_info = self.get_publishers_info_by_topic(topic_name)
        if topic_info:
            qos = topic_info[0].qos_profile
            if qos.history == HistoryPolicy.UNKNOWN:
                qos.history = HistoryPolicy.KEEP_LAST
            return qos
        return QoSProfile(
            depth=10,
            reliability=QoSReliabilityPolicy.BEST_EFFORT,
            durability=QoSDurabilityPolicy.VOLATILE,
        )

    def pingpong_loop(self):
        while rclpy.ok():
            time.sleep(1)
            if self.event_loop:
                try:
                    self.event_loop.add_callback(USVSocketHandler.send_pings)
                except Exception as e:
                    self.logwarn(str(e))

    def sync_subs_loop(self):
        while rclpy.ok():
            time.sleep(1)
            self.sync_subs()

    def sync_subs(self):
        self.lock.acquire()
        try:
            # Refresh topic list
            topic_list = self.get_topic_names_and_types()
            self.all_topics = {}
            for topic_name, topic_types in topic_list:
                if topic_types:
                    self.all_topics[topic_name] = topic_types[0]

            # Broadcast topic list to all clients
            if self.event_loop:
                self.event_loop.add_callback(
                    USVSocketHandler.broadcast,
                    [USVSocketHandler.MSG_TOPICS, self.all_topics]
                )

            # Broadcast camera list to all clients
            if self.event_loop and self.cameras_available:
                self.event_loop.add_callback(
                    USVSocketHandler.broadcast,
                    [USVSocketHandler.MSG_CAMERAS, self.cameras_available]
                )

            # Create subscribers for topics that clients want
            for topic_name in self.remote_subs:
                if len(self.remote_subs[topic_name]) == 0:
                    continue
                if topic_name not in self.all_topics:
                    continue
                if topic_name in self.local_subs:
                    continue

                topic_type = self.all_topics[topic_name]
                msg_class = self.get_msg_class(topic_type)
                if msg_class is None:
                    continue

                self.last_data_times_by_topic[topic_name] = 0.0
                self.loginfo("Subscribing to %s [%s]" % (topic_name, topic_type))

                qos = self.get_topic_qos(topic_name)

                if topic_type in self.image_topic_types:
                    # Image topics use FFmpeg H.264 encoding pipeline
                    self.local_subs[topic_name] = self.create_subscription(
                        msg_class,
                        topic_name,
                        lambda msg, tn=topic_name: self.on_image_msg(msg, tn),
                        qos_profile=qos,
                    )
                else:
                    # Normal topics use ros2dict + JSON broadcast
                    self.local_subs[topic_name] = self.create_subscription(
                        msg_class,
                        topic_name,
                        lambda msg, tn=topic_name, tt=topic_type: self.on_ros_msg(msg, tn, tt),
                        qos_profile=qos,
                    )

            # Clean up subs nobody wants anymore
            for topic_name in list(self.local_subs.keys()):
                if topic_name not in self.remote_subs or len(self.remote_subs[topic_name]) == 0:
                    self.loginfo("Unsubscribing from %s" % topic_name)
                    self.destroy_subscription(self.local_subs[topic_name])
                    del self.local_subs[topic_name]
                    # Stop H.264 stream if this was an image topic
                    if topic_name in self.video_streams:
                        self.video_streams[topic_name].stop()
                        del self.video_streams[topic_name]
                    # Clean up FPS tracking and throttle state
                    self._frame_timestamps.pop(topic_name, None)
                    self._detected_fps.pop(topic_name, None)
                    self._image_frame_count.pop(topic_name, None)
                    self._last_image_feed_time.pop(topic_name, None)

            # Auto-subscribe to NavSatFix for the map panel
            self._maybe_subscribe_gps()

        except Exception as e:
            self.logwarn("sync_subs error: %s" % str(e))
            traceback.print_exc()
        finally:
            self.lock.release()

    def _maybe_subscribe_gps(self):
        """
        Auto-subscribe to the first NavSatFix topic found in all_topics.
        Called from sync_subs() (already under self.lock).
        Cleans up stale subscription if the topic disappeared.
        """
        if self._gps_sub is not None:
            if self._gps_topic in self.all_topics:
                return  # already subscribed and topic still alive
            # Topic disappeared — clean up
            self.destroy_subscription(self._gps_sub)
            self._gps_sub = None
            self._gps_topic = None
            self.logwarn("NavSatFix topic disappeared, will re-subscribe when available")

        # Find the first NavSatFix topic
        for topic_name, topic_type in self.all_topics.items():
            if topic_type == self.NAV_SAT_FIX_TYPE:
                msg_class = self.get_msg_class(topic_type)
                if msg_class is None:
                    continue
                qos = self.get_topic_qos(topic_name)
                self._gps_sub = self.create_subscription(
                    msg_class,
                    topic_name,
                    lambda msg, tn=topic_name: self._on_gps_msg(msg, tn),
                    qos_profile=qos,
                )
                self._gps_topic = topic_name
                self.loginfo("Auto-subscribed to NavSatFix: %s" % topic_name)
                break

    def _on_gps_msg(self, msg, topic_name):
        """
        Handle sensor_msgs/NavSatFix. Broadcast lat/lng to all clients as a 'g' message.
        Rate-limited to 2 Hz — the map doesn't need faster updates.
        """
        now = time.monotonic()
        if now - self._last_gps_broadcast < 0.5:  # 2 Hz max
            return
        self._last_gps_broadcast = now

        payload = {
            "lat": msg.latitude,
            "lng": msg.longitude,
            "topic": topic_name,
        }
        # NavSatFix doesn't have a heading field in the standard definition,
        # but dual-GPS receivers often publish heading on a companion topic
        # (e.g. sensor_msgs/Imu or a custom msg). For now forward it if present.
        if hasattr(msg, 'heading'):
            payload["heading"] = float(msg.heading)

        if self.event_loop:
            self.event_loop.add_callback(
                USVSocketHandler.broadcast,
                [USVSocketHandler.MSG_GPS_POS, payload]
            )

    def _detect_fps(self, topic_name):
        """
        Auto-detect source FPS from message arrival rate.
        Uses a simple counter + two timestamps approach: counts frames between
        periodic checkpoints to compute FPS with minimal per-frame overhead.

        Requires at least 1 second of data before producing a result, to avoid
        wildly inaccurate readings from message bursts or callback queue backlog.

        Returns int FPS or default.
        """
        now = time.monotonic()

        # Count every frame
        count = self._image_frame_count.get(topic_name, 0) + 1
        self._image_frame_count[topic_name] = count

        # Record start timestamp on first frame
        if topic_name not in self._frame_timestamps:
            self._frame_timestamps[topic_name] = now
            return self._detected_fps.get(topic_name, self.default_video_fps)

        # Only recompute FPS after enough time has passed (at least 1 second)
        # This avoids wildly wrong readings from message bursts at startup
        start_time = self._frame_timestamps[topic_name]
        elapsed = now - start_time
        if elapsed < 1.0:
            return self._detected_fps.get(topic_name, self.default_video_fps)

        # count-1 intervals in elapsed seconds (frame 1 set the timestamp,
        # so we've seen count-1 inter-frame gaps since then)
        raw_fps = (count - 1) / elapsed

        # Reset checkpoint for next measurement
        self._frame_timestamps[topic_name] = now
        self._image_frame_count[topic_name] = 1  # this frame is the new "frame 1"

        # Round to nearest common FPS value for stability
        common_fps = [10, 15, 20, 24, 25, 30, 50, 60, 90, 120]
        nearest = min(common_fps, key=lambda f: abs(f - raw_fps))

        # Clamp to reasonable range
        nearest = max(5, min(120, nearest))

        # Hysteresis: stick with current value unless raw FPS deviates by >20%.
        # This prevents bouncing between adjacent values (e.g. 20↔24 at 22fps).
        prev = self._detected_fps.get(topic_name)
        if prev is not None and abs(raw_fps - prev) / prev < 0.20:
            detected = prev  # keep current — not enough change to switch
        else:
            detected = nearest

        if topic_name not in self._detected_fps or self._detected_fps[topic_name] != detected:
            self.loginfo("Detected source FPS for %s: %d (raw: %.1f)" % (topic_name, detected, raw_fps))

        self._detected_fps[topic_name] = detected
        return detected

    def on_image_msg(self, msg, topic_name):
        """
        Handle sensor_msgs/Image: feed raw pixels to FFmpeg H.264 pipeline.

        CRITICAL: Throttle BEFORE copying msg.data to avoid wasting CPU on
        frames that will be dropped anyway. At 60fps with 640x480 RGB8,
        bytes(msg.data) copies 921KB per frame = 55 MB/s of pointless copies
        if we don't throttle first.
        """
        now = time.monotonic()

        # --- Lightweight FPS detection (just counts + occasional timestamp) ---
        source_fps = self._detect_fps(topic_name)

        # --- Determine target FPS (capped by encoder capability) ---
        max_fps = get_max_fps()
        target_fps = min(source_fps, max_fps)
        min_interval = 1.0 / target_fps

        # --- Throttle BEFORE the expensive bytes() copy ---
        last_feed = self._last_image_feed_time.get(topic_name, 0.0)
        if now - last_feed < min_interval - 0.001:  # 1ms tolerance
            return  # skip this frame entirely — no copy, no work

        self._last_image_feed_time[topic_name] = now

        # --- Now it's worth doing the expensive work ---
        width = msg.width
        height = msg.height
        encoding = msg.encoding
        raw_data = bytes(msg.data)

        stream = self.video_streams.get(topic_name)

        # Respect FPS override from browser (0 = auto)
        settings = self._video_settings.get(topic_name, {})
        fps_override = settings.get("fps", 0)
        if fps_override > 0:
            target_fps = min(fps_override, get_max_fps())
        quality = settings.get("quality", "medium")

        if stream is None:
            # First frame — lazily spawn FFmpeg (need dimensions from message)
            self.loginfo("Starting video stream for %s: %dx%d @ %dfps (source: %dfps, encoder: %s)"
                         % (topic_name, width, height, target_fps, source_fps, get_encoder()))
            stream = H264Stream(
                topic_name, width, height, target_fps, encoding, quality=quality
            )
            stream.on_data = lambda data: self._send_video_binary(data)
            self.video_streams[topic_name] = stream
            self._send_video_meta(topic_name, target_fps, width, height)
        elif not stream.alive:
            # FFmpeg crashed — restart (with cooldown to prevent tight restart loops)
            last_restart = getattr(stream, '_last_restart_time', 0.0)
            if now - last_restart < 2.0:
                return  # wait before trying again
            stream._last_restart_time = now
            self.loginfo("FFmpeg crashed for %s, restarting..." % topic_name)
            stream.restart(width, height, target_fps, encoding, quality=quality)
            stream.on_data = lambda data: self._send_video_binary(data)
            self._send_video_meta(topic_name, target_fps, width, height)
        elif stream.width != width or stream.height != height or stream.encoding != encoding:
            # Resolution or encoding changed — restart
            self.loginfo("Image params changed for %s, restarting FFmpeg" % topic_name)
            stream.restart(width, height, target_fps, encoding, quality=quality)
            stream.on_data = lambda data: self._send_video_binary(data)
            self._send_video_meta(topic_name, target_fps, width, height)
        elif stream.fps != target_fps:
            # FPS changed (auto-detection updated or override applied) — restart
            self.loginfo("FPS changed for %s: %d -> %d, restarting FFmpeg" % (topic_name, stream.fps, target_fps))
            stream.restart(width, height, target_fps, encoding, quality=quality)
            stream.on_data = lambda data: self._send_video_binary(data)
            self._send_video_meta(topic_name, target_fps, width, height)

        stream.feed_frame(raw_data)

    def _send_video_meta(self, topic_name, fps, width, height, encoder=None, passthrough=False):
        """Send video stream metadata to all browser clients."""
        if self.event_loop:
            self.event_loop.add_callback(
                USVSocketHandler.broadcast,
                [USVSocketHandler.MSG_VIDEO_META, {
                    "topic": topic_name,
                    "fps": fps,
                    "width": width,
                    "height": height,
                    "encoder": encoder or get_encoder(),
                    "passthrough": passthrough,
                }]
            )

    def _send_video_binary(self, binary_frame):
        """Deliver H.264 binary frame to Tornado event loop for broadcasting."""
        if self.event_loop:
            self.event_loop.add_callback(
                USVSocketHandler.broadcast_binary, binary_frame
            )

    # --- GStreamer camera management ---
    def on_camera_subscribe(self, camera_id, socket_id):
        """Browser client wants to subscribe to a direct camera stream."""
        if camera_id not in self.cameras_available:
            self.logwarn("Camera subscribe: unknown camera %s" % camera_id)
            return
        if camera_id not in self.camera_remote_subs:
            self.camera_remote_subs[camera_id] = set()
        self.camera_remote_subs[camera_id].add(socket_id)
        self.loginfo("Camera subscribe: %s by %s" % (camera_id, socket_id))
        self.sync_camera_streams()

    def on_camera_unsubscribe(self, camera_id, socket_id):
        """Browser client wants to unsubscribe from a direct camera stream."""
        if camera_id in self.camera_remote_subs:
            self.camera_remote_subs[camera_id].discard(socket_id)
        self.sync_camera_streams()

    def sync_camera_streams(self):
        """Start/stop GStreamer camera streams based on client subscriptions."""
        self.lock.acquire()
        try:
            # Start streams for cameras that have subscribers
            for camera_id, subs in self.camera_remote_subs.items():
                if len(subs) == 0:
                    continue
                if camera_id in self.camera_streams and self.camera_streams[camera_id].alive:
                    continue
                # Need to start this stream
                config = self._camera_configs_by_id.get(camera_id)
                if config is None:
                    self.logwarn("No config for camera %s" % camera_id)
                    continue
                self.loginfo("Starting camera stream: %s" % camera_id)
                stream = GStreamerStream(camera_id, config)
                stream.on_data = lambda data: self._send_video_binary(data)
                self.camera_streams[camera_id] = stream
                # Send video metadata to browser
                info = self.cameras_available.get(camera_id, {})
                self._send_video_meta(
                    camera_id,
                    info.get("fps", 30),
                    info.get("width", 0),
                    info.get("height", 0),
                    encoder=get_gst_encoder() or "gstreamer",
                    passthrough=info.get("passthrough", False),
                )

            # Stop streams that nobody wants anymore
            for camera_id in list(self.camera_streams.keys()):
                subs = self.camera_remote_subs.get(camera_id, set())
                if len(subs) == 0:
                    self.loginfo("Stopping camera stream: %s" % camera_id)
                    self.camera_streams[camera_id].stop()
                    del self.camera_streams[camera_id]

        except Exception as e:
            self.logwarn("sync_camera_streams error: %s" % str(e))
            traceback.print_exc()
        finally:
            self.lock.release()

    def on_video_settings(self, topic, fps, quality):
        """
        Browser sent per-stream settings override ["f", {topic, fps, quality}].
        fps=0 means auto (use source FPS). quality one of low/medium/high.
        Restarts the relevant FFmpeg or GStreamer stream with new params.
        """
        fps = int(fps) if fps else 0
        quality = quality if quality in ("low", "medium", "high") else "medium"
        prev = self._video_settings.get(topic, {})
        if prev.get("fps") == fps and prev.get("quality") == quality:
            return  # no change
        self._video_settings[topic] = {"fps": fps, "quality": quality}
        self.loginfo("Video settings for %s: fps=%s quality=%s" % (topic, fps or "auto", quality))

        # --- ROS2 image topic (FFmpeg pipeline) ---
        if topic in self.video_streams:
            stream = self.video_streams[topic]
            target_fps = fps if fps > 0 else self._detected_fps.get(topic, self.default_video_fps)
            target_fps = min(target_fps, get_max_fps())
            stream.restart(stream.width, stream.height, target_fps, stream.encoding,
                           quality=quality)
            stream.on_data = lambda data: self._send_video_binary(data)
            self._send_video_meta(topic, target_fps, stream.width, stream.height)

        # --- Direct camera (GStreamer pipeline) ---
        elif topic in self.camera_streams:
            config = dict(self._camera_configs_by_id.get(topic, {}))
            if fps > 0:
                config["fps"] = fps
            config["quality"] = quality
            self.camera_streams[topic].restart(config)
            self.camera_streams[topic].on_data = lambda data: self._send_video_binary(data)
            info = self.cameras_available.get(topic, {})
            self._send_video_meta(
                topic,
                fps if fps > 0 else info.get("fps", 30),
                info.get("width", 0),
                info.get("height", 0),
                encoder=get_gst_encoder() or "gstreamer",
                passthrough=info.get("passthrough", False),
            )

    def _dummy_gps_loop(self):
        """
        Broadcast a fake GPS position when no real NavSatFix topic is available.
        The boat drifts slowly in a figure-8 pattern around a fixed anchor point.
        Suppressed as soon as a real GPS subscription is active.
        """
        # Anchor near the centre of the sample mission (Riga area)
        anchor_lat = 56.9530
        anchor_lng = 24.1020
        # Drift radius in degrees (~40 m at this latitude)
        radius_lat = 0.00035
        radius_lng = 0.00055
        period = 60.0   # seconds for one full loop

        t0 = time.monotonic()
        while True:
            time.sleep(1.0)  # 1 Hz is plenty for a dummy marker

            # Only emit when there is no real GPS subscription
            if self._gps_sub is not None:
                continue

            t = time.monotonic() - t0
            phase = (t / period) * 2 * math.pi

            # Lissajous figure-8: lat uses sin(2θ), lng uses sin(θ)
            lat = anchor_lat + radius_lat * math.sin(2 * phase)
            lng = anchor_lng + radius_lng * math.sin(phase)

            # Dummy heading: slow continuous rotation (one full turn per period).
            # On a real USV the dual-GPS receiver supplies heading directly in
            # the NavSatFix (or a companion topic); no movement estimation needed.
            heading_deg = (t / period * 360) % 360

            if self.event_loop:
                self.event_loop.add_callback(
                    USVSocketHandler.broadcast,
                    [USVSocketHandler.MSG_GPS_POS, {
                        "lat": lat,
                        "lng": lng,
                        "heading": heading_deg,
                        "topic": "dummy",
                    }]
                )

    def _on_system_metrics(self, data):
        """Called by SystemMetricsCollector with CPU/GPU usage data."""
        if self.event_loop:
            self.event_loop.add_callback(
                USVSocketHandler.broadcast,
                [USVSocketHandler.MSG_RESOURCES, data]
            )

    def on_ros_msg(self, msg, topic_name, topic_type):
        """ROS2 message received on a subscribed topic. Forward to WebSocket clients."""
        t = time.time()
        interval = self.update_intervals_by_topic.get(topic_name, 0.1)
        if t - self.last_data_times_by_topic.get(topic_name, 0) < interval - 1e-4:
            return

        if not self.event_loop:
            return

        ros_msg_dict = ros2dict(msg)
        ros_msg_dict["_topic_name"] = topic_name
        ros_msg_dict["_topic_type"] = topic_type
        ros_msg_dict["_time"] = time.time() * 1000

        self.last_data_times_by_topic[topic_name] = t

        self.event_loop.add_callback(
            USVSocketHandler.broadcast,
            [USVSocketHandler.MSG_MSG, ros_msg_dict]
        )


def main(args=None):
    rclpy.init(args=args)
    node = USVWebNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        # Stop all H.264 streams
        for stream in node.video_streams.values():
            stream.stop()
        node.video_streams.clear()
        # Stop all GStreamer camera streams
        for stream in node.camera_streams.values():
            stream.stop()
        node.camera_streams.clear()
        node.metrics_collector.stop()
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
