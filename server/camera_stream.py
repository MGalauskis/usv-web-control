"""
GStreamer Direct Camera Stream Manager

Bypasses ROS2 entirely for camera video. Manages GStreamer subprocesses
that capture from cameras (V4L2, RTSP, test patterns, etc.) and encode
to H.264, piping the byte stream to stdout. The Python server reads
stdout and sends H.264 chunks over the existing WebSocket binary protocol.

Architecture:
  Camera device → GStreamer subprocess (capture + encode) → stdout
  → Python _read_loop → [topic_header + H.264] → WebSocket broadcast
"""

import glob
import os
import shlex
import shutil
import subprocess
import threading
import time

from .log import info as _log_info, warn as _log_warn, error as _log_error


def _log(msg):
    _log_info("CameraStream", msg)

def _log_w(msg):
    _log_warn("CameraStream", msg)

def _log_e(msg):
    _log_error("CameraStream", msg)


# ---------------------------------------------------------------------------
# GStreamer availability check
# ---------------------------------------------------------------------------

_GST_LAUNCH = shutil.which("gst-launch-1.0")


def has_gstreamer():
    """Return True if gst-launch-1.0 is found on PATH."""
    return _GST_LAUNCH is not None


# ---------------------------------------------------------------------------
# GStreamer H.264 encoder detection (runs once at import time)
# ---------------------------------------------------------------------------

def _probe_gst_encoder(encoder_element, extra_props="", timeout=5):
    """
    Test whether a GStreamer H.264 encoder element works by encoding a
    single test frame from videotestsrc. Returns True if successful.
    """
    if not _GST_LAUNCH:
        return False

    pipeline = (
        "videotestsrc num-buffers=1 ! "
        "video/x-raw,width=256,height=256,framerate=1/1 ! "
        "videoconvert ! "
        "%s %s ! "
        "fakesink" % (encoder_element, extra_props)
    )

    cmd = [_GST_LAUNCH, "-q"] + shlex.split(pipeline)
    try:
        result = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
        if result.returncode == 0:
            return True
        stderr = result.stderr.decode("utf-8", errors="replace").strip()[:200]
        _log_w("Probe %s failed (rc=%d): %s" % (encoder_element, result.returncode, stderr))
        return False
    except FileNotFoundError:
        return False
    except subprocess.TimeoutExpired:
        _log_w("Probe %s timed out" % encoder_element)
        return False
    except Exception as e:
        _log_e("Probe %s error: %s" % (encoder_element, e))
        return False


def _detect_gst_encoder():
    """
    Probe available GStreamer H.264 encoders at module load time.
    Returns the encoder element name or 'x264enc' as software fallback.
    """
    if not _GST_LAUNCH:
        _log_w("gst-launch-1.0 not found — GStreamer cameras disabled")
        return None

    encoders = [
        ("nvh264enc",       "preset=low-latency-hq"),
        ("nvv4l2h264enc",   ""),
        ("vaapih264enc",    ""),
        ("qsvh264enc",      ""),
        ("x264enc",         "tune=zerolatency speed-preset=ultrafast"),
    ]

    for element, props in encoders:
        if _probe_gst_encoder(element, props):
            _log("Encoder probe: %s is available" % element)
            return element

    _log_e("No working GStreamer H.264 encoder found")
    return None


# Detect once at import time
_BEST_GST_ENCODER = _detect_gst_encoder() if _GST_LAUNCH else None


def get_gst_encoder():
    """Return the detected GStreamer encoder element name, or None."""
    return _BEST_GST_ENCODER


# ---------------------------------------------------------------------------
# GStreamer pipeline builder
# ---------------------------------------------------------------------------

def _encoder_params(encoder, fps):
    """Return encoder-specific GStreamer properties as a string."""
    if encoder == "nvh264enc":
        return "nvh264enc preset=low-latency-hq rc-mode=constqp qp-const=23 gop-size=%d" % fps
    elif encoder == "nvv4l2h264enc":
        return "nvv4l2h264enc preset-level=1 iframeinterval=%d bitrate=4000000" % fps
    elif encoder == "vaapih264enc":
        return "vaapih264enc rate-control=cqp init-qp=23 keyframe-period=%d" % fps
    elif encoder == "qsvh264enc":
        return "qsvh264enc target-usage=7 gop-size=%d" % fps
    elif encoder == "x264enc":
        return "x264enc tune=zerolatency speed-preset=ultrafast key-int-max=%d bitrate=2000 ! video/x-h264,profile=baseline" % fps
    else:
        return "x264enc tune=zerolatency speed-preset=ultrafast key-int-max=%d ! video/x-h264,profile=baseline" % fps


def build_gst_pipeline(config, encoder):
    """
    Build a gst-launch-1.0 pipeline string from a camera config dict.

    Args:
        config: dict with keys like source, device, url, width, height, fps, etc.
        encoder: GStreamer encoder element name (e.g. 'x264enc', 'nvh264enc')

    Returns:
        Pipeline string suitable for: gst-launch-1.0 -q -e <pipeline>
    """
    source = config.get("source", "test")
    w = config.get("width", 640)
    h = config.get("height", 480)
    fps = config.get("fps", 30)
    passthrough = config.get("passthrough", False)

    # --- Source segment ---
    if source == "v4l2":
        device = config.get("device", "/dev/video0")
        src = "v4l2src device=%s ! video/x-raw,width=%d,height=%d,framerate=%d/1" % (device, w, h, fps)

    elif source == "rtsp":
        url = config.get("url", "")
        if passthrough:
            # RTSP passthrough: already H.264, skip encoding entirely
            src = "rtspsrc location=%s latency=200 ! rtph264depay" % url
            tail = "! h264parse config-interval=-1 ! video/x-h264,stream-format=byte-stream ! fdsink fd=1"
            return "%s %s" % (src, tail)
        else:
            # RTSP re-encode: decode then re-encode
            src = (
                "rtspsrc location=%s latency=200 ! rtph264depay ! avdec_h264 ! "
                "video/x-raw,width=%d,height=%d" % (url, w, h)
            )

    elif source == "libcamera":
        src = "libcamerasrc ! video/x-raw,width=%d,height=%d,framerate=%d/1" % (w, h, fps)

    elif source == "nvargus":
        sensor_id = config.get("sensor_id", 0)
        src = (
            "nvarguscamerasrc sensor-id=%d ! "
            "video/x-raw(memory:NVMM),width=%d,height=%d,framerate=%d/1" % (sensor_id, w, h, fps)
        )

    else:  # test
        pattern = config.get("pattern", "ball")
        src = "videotestsrc pattern=%s is-live=true ! video/x-raw,width=%d,height=%d,framerate=%d/1" % (
            pattern, w, h, fps
        )

    # --- Encode + output segment ---
    # nvargus produces NVMM buffers — use nvv4l2h264enc directly, skip videoconvert
    if source == "nvargus":
        enc = "nvv4l2h264enc preset-level=1 iframeinterval=%d bitrate=4000000" % fps
        convert = ""
    else:
        enc = _encoder_params(encoder, fps)
        convert = "videoconvert ! "

    tail = (
        "%s%s ! "
        "h264parse config-interval=-1 ! "
        "video/x-h264,stream-format=byte-stream ! "
        "fdsink fd=1" % (convert, enc)
    )

    return "%s ! %s" % (src, tail)


# ---------------------------------------------------------------------------
# GStreamerStream class
# ---------------------------------------------------------------------------

class GStreamerStream:
    """
    Wraps a persistent GStreamer subprocess that captures from a camera
    and outputs H.264 byte-stream to stdout.

    Simpler than H264Stream — no stdin writer thread. GStreamer handles
    capture + encode internally. We just read stdout.

    Binary frame format (via on_data callback):
        [1 byte: topic name length N] [N bytes: camera_id UTF-8] [H.264 data]
    """

    def __init__(self, camera_id, camera_config):
        self.camera_id = camera_id
        self.camera_config = camera_config
        self.on_data = None  # callback(binary_frame) — set by usv_node

        self._process = None
        self._reader_thread = None
        self._stderr_thread = None
        self._stopped = False
        self._chunks_sent = 0
        self._total_bytes = 0

        # Pre-build the camera ID header (reused for every chunk)
        id_bytes = self.camera_id.encode("utf-8")
        if len(id_bytes) > 255:
            id_bytes = id_bytes[:255]
        self._topic_header = bytes([len(id_bytes)]) + id_bytes

        self._start_gstreamer()

    def _start_gstreamer(self):
        """Spawn the GStreamer subprocess."""
        encoder = _BEST_GST_ENCODER
        if encoder is None and not self.camera_config.get("passthrough", False):
            _log_e("No GStreamer encoder available, cannot start %s" % self.camera_id)
            return

        # For passthrough, encoder is not used but we still need a non-None
        # value for build_gst_pipeline to work (it returns early for passthrough)
        pipeline = build_gst_pipeline(
            self.camera_config,
            encoder or "x264enc",
        )
        _log("Starting GStreamer for %s: gst-launch-1.0 %s" % (self.camera_id, pipeline))

        cmd = [_GST_LAUNCH, "-q", "-e"] + shlex.split(pipeline)
        try:
            self._process = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError:
            _log_e("gst-launch-1.0 not found")
            self._process = None
            return
        except Exception as e:
            _log_e("Failed to start GStreamer for %s: %s" % (self.camera_id, e))
            self._process = None
            return

        self._stopped = False
        self._chunks_sent = 0
        self._total_bytes = 0

        name = self.camera_config.get("name", self.camera_id)
        _log("Started for %s (%s)" % (self.camera_id, name))

        self._reader_thread = threading.Thread(
            target=self._read_loop, daemon=True
        )
        self._reader_thread.start()

        self._stderr_thread = threading.Thread(
            target=self._stderr_loop, daemon=True
        )
        self._stderr_thread.start()

    def _read_loop(self):
        """Read H.264 encoded chunks from GStreamer stdout and deliver via callback."""
        try:
            stdout = self._process.stdout
            while not self._stopped and self._process and stdout:
                chunk = stdout.read1(65536)
                if not chunk:
                    _log("GStreamer stdout EOF for %s (sent %d chunks, %d bytes)"
                         % (self.camera_id, self._chunks_sent, self._total_bytes))
                    break
                self._chunks_sent += 1
                self._total_bytes += len(chunk)
                if self._chunks_sent == 1:
                    _log("First H.264 chunk from %s (%d bytes)" % (self.camera_id, len(chunk)))
                if self.on_data:
                    binary_frame = self._topic_header + chunk
                    self.on_data(binary_frame)
        except Exception as e:
            if not self._stopped:
                _log_e("Reader error for %s: %s" % (self.camera_id, e))
        finally:
            if not self._stopped:
                _log("GStreamer process exited for %s" % self.camera_id)

    def _stderr_loop(self):
        """Read and log GStreamer stderr output."""
        try:
            while self._process and self._process.stderr:
                line = self._process.stderr.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").rstrip()
                if text:
                    _log_w("GStreamer stderr [%s]: %s" % (self.camera_id, text))
        except Exception:
            pass

    def stop(self):
        """Stop the GStreamer subprocess and all threads."""
        self._stopped = True
        self._cleanup_process()
        _log("Stopped %s" % self.camera_id)

    def _cleanup_process(self):
        """Terminate and clean up the GStreamer process."""
        if self._process is None:
            return
        try:
            # GStreamer with -e flag handles SIGINT gracefully (EOS)
            self._process.terminate()
            self._process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self._process.kill()
            try:
                self._process.wait(timeout=1)
            except Exception:
                pass
        except Exception:
            pass
        self._process = None

    def restart(self, camera_config=None):
        """Restart GStreamer, optionally with new config."""
        if camera_config:
            self.camera_config = camera_config
        _log("Restarting GStreamer for %s" % self.camera_id)
        self.stop()
        self._start_gstreamer()

    @property
    def alive(self):
        """Check if the GStreamer process is still running."""
        return self._process is not None and self._process.poll() is None


# ---------------------------------------------------------------------------
# V4L2 camera auto-discovery
# ---------------------------------------------------------------------------

def _get_v4l2_device_name(device_path):
    """
    Get the human-readable name of a V4L2 device via v4l2-ctl.
    Returns the card name or the device path as fallback.
    """
    v4l2_ctl = shutil.which("v4l2-ctl")
    if not v4l2_ctl:
        return os.path.basename(device_path)

    try:
        result = subprocess.run(
            [v4l2_ctl, "-d", device_path, "--info"],
            capture_output=True, timeout=3,
        )
        if result.returncode == 0:
            for line in result.stdout.decode("utf-8", errors="replace").splitlines():
                line = line.strip()
                if line.startswith("Card type"):
                    # "Card type      : USB Camera"
                    name = line.split(":", 1)[1].strip()
                    if name:
                        return name
    except Exception:
        pass

    return os.path.basename(device_path)


def _probe_v4l2_device(device_path):
    """Test whether a V4L2 device is usable as a video source via GStreamer."""
    if not _GST_LAUNCH:
        return False

    pipeline = "v4l2src device=%s num-buffers=1 ! fakesink" % device_path
    cmd = [_GST_LAUNCH, "-q"] + shlex.split(pipeline)
    try:
        result = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        return result.returncode == 0
    except Exception:
        return False


def discover_v4l2_cameras():
    """
    Auto-discover V4L2 camera devices on the system.
    Returns a list of camera config dicts.
    Only works on Linux; returns [] on other platforms.
    """
    if not os.path.exists("/dev"):
        return []

    devices = sorted(glob.glob("/dev/video*"))
    if not devices:
        return []

    cameras = []
    for device_path in devices:
        if not _probe_v4l2_device(device_path):
            continue

        name = _get_v4l2_device_name(device_path)
        cameras.append({
            "name": name,
            "source": "v4l2",
            "device": device_path,
            "width": 640,
            "height": 480,
            "fps": 30,
        })
        _log("Discovered V4L2 camera: %s (%s)" % (name, device_path))

    if not cameras:
        _log("No usable V4L2 cameras found")

    return cameras


# ---------------------------------------------------------------------------
# Camera config loader
# ---------------------------------------------------------------------------

def load_camera_config(config_path=None):
    """
    Load camera configuration from a YAML file.
    If the file does not exist, falls back to V4L2 auto-discovery.

    Args:
        config_path: path to cameras.yaml (or None for auto-discovery only)

    Returns:
        list of camera config dicts
    """
    if config_path and os.path.isfile(config_path):
        try:
            import yaml
            with open(config_path, "r") as f:
                data = yaml.safe_load(f)
            cameras = data.get("cameras", []) if isinstance(data, dict) else []
            _log("Loaded %d camera(s) from %s" % (len(cameras), config_path))
            return cameras
        except ImportError:
            _log_e("PyYAML not installed — cannot load %s. Falling back to auto-discovery." % config_path)
        except Exception as e:
            _log_e("Error loading %s: %s. Falling back to auto-discovery." % (config_path, e))

    # No config file or failed to load — auto-discover
    return discover_v4l2_cameras()


def build_cameras_available(camera_configs):
    """
    Build the cameras_available dict (camera_id -> info) sent to browser clients.

    Args:
        camera_configs: list of camera config dicts

    Returns:
        dict mapping camera_id to info dict
    """
    available = {}
    for config in camera_configs:
        name = config.get("name", "Unknown")
        source = config.get("source", "test")

        # Build camera ID from name
        camera_id = "camera:%s" % name

        # Avoid duplicate IDs by appending device path or index
        if camera_id in available:
            device = config.get("device", config.get("url", ""))
            camera_id = "camera:%s (%s)" % (name, device)

        available[camera_id] = {
            "name": name,
            "source": source,
            "width": config.get("width", 0),
            "height": config.get("height", 0),
            "fps": config.get("fps", 0),
            "passthrough": config.get("passthrough", False),
        }

    return available
