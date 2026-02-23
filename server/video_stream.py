"""
H.264 Video Stream Manager

Manages a persistent FFmpeg subprocess per image topic.
Accepts raw pixel frames on stdin, reads H.264 encoded output from stdout,
and delivers binary frames (with topic-name header) via a callback.
"""

import subprocess
import sys
import threading
import time

from .log import info as _log_info, warn as _log_warn, error as _log_error

def _log(msg):
    _log_info("H264Stream", msg)

def _log_w(msg):
    _log_warn("H264Stream", msg)

def _log_e(msg):
    _log_error("H264Stream", msg)

# Map ROS2 image encodings to FFmpeg pixel formats
ROS_TO_FFMPEG_PIXFMT = {
    "bgr8": "bgr24",
    "rgb8": "rgb24",
    "mono8": "gray",
    "bgra8": "bgra",
    "rgba8": "rgba",
    "8UC1": "gray",
    "8UC3": "bgr24",
    "8UC4": "bgra",
}


def _run_probe(cmd, test_frame, label, timeout=5):
    """Run a single FFmpeg probe command. Returns (success, stderr_text)."""
    try:
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        _, stderr = proc.communicate(input=test_frame, timeout=timeout)
        stderr_text = stderr.decode('utf-8', errors='replace').strip()[:200]
        if proc.returncode == 0:
            return True, stderr_text
        else:
            _log_w("Probe %s failed (rc=%d): %s" % (label, proc.returncode, stderr_text))
            return False, stderr_text
    except FileNotFoundError:
        _log_e("Probe %s: FFmpeg not found!" % label)
        return False, "not found"
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        _log_w("Probe %s timed out" % label)
        return False, "timeout"
    except Exception as e:
        _log_e("Probe %s error: %s" % (label, e))
        return False, str(e)


def _detect_best_encoder():
    """
    Probe available H.264 encoders at module load time.
    Tests each encoder with a real 1-frame encode at 256x256.
    Returns 'nvenc', 'qsv', or 'sw'.
    """
    test_w, test_h = 256, 256
    test_frame = b'\x80' * int(test_w * test_h * 1.5)

    test_encoders = [
        ("nvenc", [
            "ffmpeg", "-f", "rawvideo", "-pix_fmt", "yuv420p",
            "-s", "%dx%d" % (test_w, test_h), "-r", "1",
            "-i", "pipe:0", "-frames:v", "1",
            "-c:v", "h264_nvenc", "-preset", "p1",
            "-f", "null", "-loglevel", "error", "-"
        ]),
        ("qsv", [
            "ffmpeg", "-f", "rawvideo", "-pix_fmt", "yuv420p",
            "-s", "%dx%d" % (test_w, test_h), "-r", "1",
            "-i", "pipe:0", "-frames:v", "1",
            "-c:v", "h264_qsv", "-preset", "veryfast",
            "-f", "null", "-loglevel", "error", "-"
        ]),
    ]

    for name, cmd in test_encoders:
        ok, _ = _run_probe(cmd, test_frame, name)
        if ok:
            _log("Encoder probe: %s is available" % name)
            return name

    _log("Encoder probe: falling back to software (libx264)")
    return "sw"


def _detect_cuda_colorspace():
    """
    Test whether FFmpeg can do GPU-side colorspace conversion with NVENC.
    Uses hwupload_cuda + scale_cuda=format=nv12 (requires FFmpeg 5.x+).

    On older FFmpeg (e.g. 4.4 on Ubuntu 22.04), scale_cuda lacks the 'format'
    option, so we fall back to CPU swscale. On Jetson/JetPack or modern FFmpeg
    builds, this should work and eliminates all CPU colorspace conversion.

    Returns the -vf filter string to use, or None if CPU swscale is needed.
    """
    test_w, test_h = 256, 256
    test_frame = b'\x80' * (test_w * test_h * 3)  # bgr24

    cmd = [
        "ffmpeg", "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-s", "%dx%d" % (test_w, test_h), "-r", "1",
        "-i", "pipe:0", "-frames:v", "1",
        "-vf", "hwupload_cuda,scale_cuda=format=nv12",
        "-c:v", "h264_nvenc", "-preset", "p1",
        "-f", "null", "-loglevel", "error", "-"
    ]

    ok, _ = _run_probe(cmd, test_frame, "cuda_colorspace")
    if ok:
        _log("CUDA colorspace: hwupload_cuda + scale_cuda available (GPU colorspace conversion)")
        return "hwupload_cuda,scale_cuda=format=nv12"

    _log("CUDA colorspace: not available (FFmpeg too old?), using CPU swscale")
    return None


# Detect best encoder once at import time
_BEST_ENCODER = _detect_best_encoder()

# If NVENC available, detect best colorspace conversion strategy
_CUDA_COLORSPACE = _detect_cuda_colorspace() if _BEST_ENCODER == "nvenc" else None

# Software encoding is CPU-bound — cap FPS to avoid overloading.
_SW_MAX_FPS = 10


def get_encoder():
    """Return the detected encoder name."""
    return _BEST_ENCODER

def get_max_fps():
    """Return the max FPS for the current encoder."""
    if _BEST_ENCODER == "sw":
        return _SW_MAX_FPS
    return 60  # hardware encoders can handle this easily


class H264Stream:
    """
    Wraps a persistent FFmpeg subprocess that encodes raw video frames
    to an H.264 byte stream.

    Binary frame format sent via on_data callback:
        [1 byte: topic name length N] [N bytes: topic name UTF-8] [H.264 data]
    """

    # Quality → CRF / QP value mapping for software / hardware encoders
    QUALITY_CRF = {"low": 35, "medium": 26, "high": 18}
    QUALITY_QP  = {"low": 32, "medium": 23, "high": 15}

    def __init__(self, topic_name, width, height, fps, encoding, quality="medium"):
        self.topic_name = topic_name
        self.width = width
        self.height = height
        self.fps = fps
        self.encoding = encoding
        self.quality = quality
        self.on_data = None  # callback(binary_frame) — set by usv_node

        self._process = None
        self._reader_thread = None
        self._stderr_thread = None
        self._writer_thread = None
        self._stopped = False
        self._frame_count = 0
        self._frames_written = 0
        self._pending_frame = None  # latest frame waiting to be written
        self._frame_lock = threading.Lock()
        self._frame_event = threading.Event()

        # Pre-build the topic name header (reused for every frame)
        topic_bytes = self.topic_name.encode('utf-8')
        if len(topic_bytes) > 255:
            topic_bytes = topic_bytes[:255]
        self._topic_header = bytes([len(topic_bytes)]) + topic_bytes

        self._start_ffmpeg()

    def _build_ffmpeg_cmd(self, pix_fmt):
        """Build FFmpeg command using the pre-detected best encoder."""
        encoder = _BEST_ENCODER
        qp  = self.QUALITY_QP.get(self.quality, 23)
        crf = self.QUALITY_CRF.get(self.quality, 26)

        cmd = [
            "ffmpeg",
            "-f", "rawvideo",
            "-pix_fmt", pix_fmt,
            "-s", "%dx%d" % (self.width, self.height),
            "-r", str(self.fps),
            "-i", "pipe:0",
        ]

        if encoder == "nvenc":
            if _CUDA_COLORSPACE:
                # GPU colorspace conversion: upload raw frame to CUDA, convert
                # to NV12 on GPU, then encode — avoids CPU-heavy swscale.
                # At 1080p60 this saves ~600 MB/s of CPU memory bandwidth.
                # Requires FFmpeg 5.x+ (scale_cuda format= option).
                cmd += ["-vf", _CUDA_COLORSPACE]
            else:
                # Old FFmpeg — fall back to CPU swscale for colorspace conversion.
                # Encoding still happens on GPU, just the bgr24→yuv420p is on CPU.
                cmd += ["-pix_fmt", "yuv420p"]
            cmd += [
                "-c:v", "h264_nvenc",
                "-preset", "p1",          # fastest NVENC preset
                "-tune", "ull",            # ultra low latency
                "-profile:v", "baseline",
                "-level", "auto",
                "-rc", "constqp",
                "-qp", str(qp),
                "-g", str(self.fps),
            ]
        elif encoder == "qsv":
            cmd += [
                "-pix_fmt", "yuv420p",
                "-c:v", "h264_qsv",
                "-preset", "veryfast",
                "-profile:v", "baseline",
                "-g", str(self.fps),
                "-global_quality", str(qp),
            ]
        else:  # software fallback
            cmd += [
                "-pix_fmt", "yuv420p",
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-tune", "zerolatency",
                "-profile:v", "baseline",
                "-crf", str(crf),
                "-g", str(self.fps),
                "-keyint_min", str(self.fps),
            ]

        cmd += [
            "-bsf:v", "dump_extra",
            "-f", "h264",
            "-loglevel", "info",
            "pipe:1",
        ]
        return cmd

    def _start_ffmpeg(self):
        """Spawn the FFmpeg subprocess using the pre-detected best encoder."""
        pix_fmt = ROS_TO_FFMPEG_PIXFMT.get(self.encoding)
        if pix_fmt is None:
            _log_e("Unsupported encoding '%s' for %s. Supported: %s"
                   % (self.encoding, self.topic_name, list(ROS_TO_FFMPEG_PIXFMT.keys())))
            return

        cmd = self._build_ffmpeg_cmd(pix_fmt)
        _log("Starting FFmpeg (%s): %s" % (_BEST_ENCODER, " ".join(cmd)))

        try:
            self._process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError:
            _log_e("FFmpeg not found. Install with: apt install ffmpeg")
            self._process = None
            return

        self._stopped = False
        self._frame_count = 0
        self._frames_written = 0
        self._pending_frame = None
        self._frame_event.clear()

        _log("Started for %s (%dx%d @ %dfps, encoding=%s, encoder=%s)"
             % (self.topic_name, self.width, self.height, self.fps,
                self.encoding, _BEST_ENCODER))

        self._reader_thread = threading.Thread(
            target=self._read_loop, daemon=True
        )
        self._reader_thread.start()

        self._writer_thread = threading.Thread(
            target=self._write_loop, daemon=True
        )
        self._writer_thread.start()

        self._stderr_thread = threading.Thread(
            target=self._stderr_loop, daemon=True
        )
        self._stderr_thread.start()

    def _stderr_loop(self):
        """Read and print FFmpeg stderr output for debugging."""
        try:
            while self._process and self._process.stderr:
                line = self._process.stderr.readline()
                if not line:
                    break
                _log_w("FFmpeg stderr: %s" % line.decode('utf-8', errors='replace').rstrip())
        except Exception:
            pass

    def _read_loop(self):
        """Read H.264 encoded chunks from FFmpeg stdout and deliver via callback."""
        chunks_sent = 0
        total_bytes = 0
        try:
            stdout = self._process.stdout
            while not self._stopped and self._process and stdout:
                chunk = stdout.read1(65536)
                if not chunk:
                    _log("FFmpeg stdout EOF for %s (sent %d chunks, %d bytes total)"
                         % (self.topic_name, chunks_sent, total_bytes))
                    break
                chunks_sent += 1
                total_bytes += len(chunk)
                if chunks_sent == 1:
                    _log("First H.264 chunk received for %s (%d bytes)" % (self.topic_name, len(chunk)))
                if self.on_data:
                    binary_frame = self._topic_header + chunk
                    self.on_data(binary_frame)
        except Exception as e:
            if not self._stopped:
                _log_e("Reader error for %s: %s" % (self.topic_name, e))
        finally:
            if not self._stopped:
                _log("FFmpeg process exited for %s" % self.topic_name)

    def feed_frame(self, raw_bytes):
        """
        Queue a raw pixel frame for the writer thread.
        Called from the ROS2 image callback — returns immediately (non-blocking).
        Only keeps the latest frame; older unwritten frames are discarded.

        NOTE: Caller is responsible for rate-limiting. This method does NOT
        do any throttling — it accepts every frame it receives.
        """
        if self._process is None or self._process.stdin is None:
            return

        self._frame_count += 1

        # Store latest frame and signal writer thread
        with self._frame_lock:
            self._pending_frame = raw_bytes
        self._frame_event.set()

        if self._frame_count == 1:
            _log("First frame queued for %s (%d bytes)"
                 % (self.topic_name, len(raw_bytes)))

    def _write_loop(self):
        """Writer thread: takes the latest pending frame and writes to FFmpeg stdin."""
        try:
            while not self._stopped and self._process:
                self._frame_event.wait(timeout=1.0)
                if self._stopped:
                    break
                self._frame_event.clear()

                with self._frame_lock:
                    frame = self._pending_frame
                    self._pending_frame = None

                if frame is None:
                    continue

                try:
                    self._process.stdin.write(frame)
                    self._process.stdin.flush()
                    self._frames_written += 1
                    if self._frames_written % 100 == 0:
                        _log("Written %d frames to FFmpeg for %s (received %d)"
                             % (self._frames_written, self.topic_name, self._frame_count))
                except (BrokenPipeError, OSError) as e:
                    if not self._stopped:
                        _log_e("FFmpeg stdin broken for %s: %s" % (self.topic_name, e))
                        self._cleanup_process()
                    break
        except Exception as e:
            if not self._stopped:
                _log_e("Writer error for %s: %s" % (self.topic_name, e))

    def stop(self):
        """Stop the FFmpeg subprocess and all threads."""
        self._stopped = True
        self._frame_event.set()
        self._cleanup_process()
        _log("Stopped for %s" % self.topic_name)

    def _cleanup_process(self):
        """Terminate and clean up the FFmpeg process."""
        if self._process is None:
            return
        try:
            if self._process.stdin:
                self._process.stdin.close()
        except Exception:
            pass
        try:
            self._process.terminate()
            self._process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self._process.kill()
            self._process.wait(timeout=1)
        except Exception:
            pass
        self._process = None

    def restart(self, width, height, fps, encoding, quality=None):
        """Restart FFmpeg with new parameters."""
        _log("Restarting for %s: %dx%d %s -> %dx%d %s"
             % (self.topic_name, self.width, self.height, self.encoding,
                width, height, encoding))
        self.stop()
        self.width = width
        self.height = height
        self.fps = fps
        self.encoding = encoding
        if quality is not None:
            self.quality = quality
        self._start_ffmpeg()

    @property
    def alive(self):
        """Check if the FFmpeg process is still running."""
        return self._process is not None and self._process.poll() is None
