#!/usr/bin/env python3
"""
Test camera publisher — publishes sensor_msgs/Image frames to ROS2.

Two modes:
  1. Pattern mode (default): generates simple moving bars.
  2. Video file mode (--file): decodes a video file with FFmpeg and publishes
     the raw frames. This is the best way to test the H.264 pipeline at real
     framerates with real video content.

Usage:
    python3 test_camera.py                          # pattern at 15fps
    python3 test_camera.py --fps 60                 # pattern at 60fps
    python3 test_camera.py --file video.mp4         # video file at native fps
    python3 test_camera.py --file video.mp4 --fps 30  # video file forced to 30fps
    python3 test_camera.py --file video.mp4 --loop  # loop the video forever
"""

import argparse
import json
import os
import platform
import subprocess
import sys
import threading
import time

import numpy as np

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import Image


def _wsl_path(path):
    """Convert Windows paths to WSL mount paths if running under WSL2.

    E.g. 'D:\\Videos\\foo.mp4' -> '/mnt/d/Videos/foo.mp4'
    Already-valid Linux paths are returned unchanged.
    """
    # Detect WSL: Linux kernel with "microsoft" or "WSL" in release string
    if platform.system() != 'Linux':
        return path
    try:
        release = platform.release().lower()
    except Exception:
        release = ''
    if 'microsoft' not in release and 'wsl' not in release:
        return path

    # Check for Windows-style drive letter (e.g. D:\ or D:/)
    if len(path) >= 3 and path[1] == ':' and path[2] in ('\\', '/'):
        drive = path[0].lower()
        rest = path[3:].replace('\\', '/')
        converted = '/mnt/%s/%s' % (drive, rest)
        print("WSL detected: converted path '%s' -> '%s'" % (path, converted),
              file=sys.stderr)
        return converted

    return path


def _probe_video(path):
    """Use ffprobe to get video width, height, fps."""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_streams",
        "-select_streams", "v:0",
        path,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            return None
        info = json.loads(result.stdout)
        stream = info["streams"][0]
        w = int(stream["width"])
        h = int(stream["height"])
        # Parse fps from r_frame_rate (e.g. "30/1", "30000/1001")
        num, den = stream.get("r_frame_rate", "30/1").split("/")
        fps = int(num) / int(den)
        return w, h, fps
    except Exception as e:
        print("ffprobe failed: %s" % e, file=sys.stderr)
        return None


class TestCamera(Node):
    def __init__(self, topic, width=640, height=480, fps=15,
                 video_file=None, loop=False):
        super().__init__('test_camera')
        self.pub = self.create_publisher(Image, topic, 10)
        self.width = width
        self.height = height
        self.fps = fps
        self.frame_num = 0
        self._stopped = False
        self._video_file = video_file
        self._loop = loop

        # Pre-build the Image message template
        self._msg = Image()
        self._msg.header.frame_id = 'test_camera'
        self._msg.height = height
        self._msg.width = width
        self._msg.encoding = 'bgr8'
        self._msg.is_bigendian = 0
        self._msg.step = width * 3

        # FPS measurement
        self._fps_time = time.monotonic()
        self._fps_count = 0

        self._frame_size = width * height * 3  # bgr8

        if video_file:
            self.get_logger().info(
                'Publishing %dx%d BGR frames from %s to %s at %d fps%s'
                % (width, height, video_file, topic, fps,
                   ' (looping)' if loop else '')
            )
            self._pub_thread = threading.Thread(
                target=self._video_file_loop, daemon=True)
        else:
            # Pre-generate pattern frames
            self._num_prebuilt = min(fps, 60)
            self._prebuilt_frames = []
            self._prebuild_frames()
            self.get_logger().info(
                'Publishing %dx%d BGR pattern to %s at %d fps (%d pre-built)'
                % (width, height, topic, fps, self._num_prebuilt)
            )
            self._pub_thread = threading.Thread(
                target=self._pattern_loop, daemon=True)

        self._pub_thread.start()

    # --- Pattern mode ---

    def _prebuild_frames(self):
        """Pre-generate frames as bytes so publish loop does zero numpy work."""
        w, h = self.width, self.height
        frame = np.zeros((h, w, 3), dtype=np.uint8)
        for i in range(self._num_prebuilt):
            frame[:] = 30
            bar_x = (i * 4) % w
            frame[:, bar_x:min(bar_x + 4, w), :] = 255
            bar_y = (i * 2) % h
            frame[bar_y:min(bar_y + 4, h), :, :] = 200
            self._prebuilt_frames.append(frame.tobytes())

    def _pattern_loop(self):
        """Publish pre-built pattern frames with precise timing."""
        interval = 1.0 / self.fps
        next_time = time.monotonic()
        while not self._stopped and rclpy.ok():
            next_time += interval
            idx = self.frame_num % self._num_prebuilt
            self._msg.header.stamp = self.get_clock().now().to_msg()
            self._msg.data = self._prebuilt_frames[idx]
            self.pub.publish(self._msg)
            self._count_frame()
            # Precise sleep
            now = time.monotonic()
            sleep_time = next_time - now
            if sleep_time > 0.002:
                time.sleep(sleep_time - 0.001)
            while time.monotonic() < next_time:
                pass
            if time.monotonic() - next_time > interval:
                next_time = time.monotonic()

    # --- Video file mode ---

    def _spawn_ffmpeg(self):
        """Spawn FFmpeg to decode video file into raw BGR frames on stdout."""
        cmd = [
            "ffmpeg",
            "-re",  # read at native framerate (real-time pacing)
            "-i", self._video_file,
            "-f", "rawvideo",
            "-pix_fmt", "bgr24",
            "-s", "%dx%d" % (self.width, self.height),
            "-r", str(self.fps),
            "-v", "warning",
            "pipe:1",
        ]
        self.get_logger().info("FFmpeg decode: %s" % " ".join(cmd))
        # stderr=DEVNULL: FFmpeg writes progress/warnings to stderr.
        # If we capture it (PIPE) but don't read it, the pipe buffer fills
        # and FFmpeg blocks forever. DEVNULL avoids this.
        return subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def _video_file_loop(self):
        """Read decoded frames from FFmpeg and publish them.

        Uses the same pattern as _pattern_loop: reuse self._msg and assign
        bytes directly to msg.data (same approach that works in pattern mode).
        """
        while not self._stopped and rclpy.ok():
            proc = self._spawn_ffmpeg()
            self.get_logger().info(
                "FFmpeg started, reading %d-byte frames..." % self._frame_size)
            try:
                while not self._stopped and rclpy.ok():
                    raw = proc.stdout.read(self._frame_size)
                    if not raw:
                        self.get_logger().warn("FFmpeg EOF (0 bytes)")
                        break
                    if len(raw) < self._frame_size:
                        self.get_logger().warn(
                            "FFmpeg short read: %d / %d bytes"
                            % (len(raw), self._frame_size))
                        break

                    # Same approach as pattern mode: reuse self._msg, assign bytes
                    self._msg.header.stamp = self.get_clock().now().to_msg()
                    self._msg.data = raw
                    self.pub.publish(self._msg)
                    self._count_frame()
            except Exception as e:
                self.get_logger().error("Video file loop error: %s" % e)
                import traceback
                traceback.print_exc()
            finally:
                try:
                    proc.terminate()
                    proc.wait(timeout=2)
                except Exception:
                    proc.kill()
                    proc.wait()

            if not self._loop or self._stopped:
                self.get_logger().info(
                    "Video file ended after %d frames" % self.frame_num)
                break
            self.get_logger().info(
                "Looping video (published %d frames so far)" % self.frame_num)

    # --- Common ---

    def _count_frame(self):
        self.frame_num += 1
        self._fps_count += 1
        now = time.monotonic()
        elapsed = now - self._fps_time
        if elapsed >= 5.0:
            actual_fps = self._fps_count / elapsed
            self.get_logger().info(
                'Published %d frames (actual: %.1f fps, target: %d fps)'
                % (self.frame_num, actual_fps, self.fps)
            )
            self._fps_time = now
            self._fps_count = 0
        elif self.frame_num == 1:
            self.get_logger().info(
                'First frame published (%d bytes)' % self._frame_size)

    def destroy_node(self):
        self._stopped = True
        super().destroy_node()


def main():
    parser = argparse.ArgumentParser(description='Test camera publisher')
    parser.add_argument('--topic', default='/camera/image_raw',
                        help='ROS2 topic name')
    parser.add_argument('--file', default=None,
                        help='Video file to decode and publish (mp4, avi, etc.)')
    parser.add_argument('--loop', action='store_true',
                        help='Loop the video file forever')
    parser.add_argument('--width', type=int, default=None,
                        help='Frame width (auto-detected from file)')
    parser.add_argument('--height', type=int, default=None,
                        help='Frame height (auto-detected from file)')
    parser.add_argument('--fps', type=int, default=None,
                        help='Target FPS (auto-detected from file)')
    args = parser.parse_args()

    # Convert Windows paths if running under WSL2
    if args.file:
        args.file = _wsl_path(args.file)

    # Auto-detect from video file
    if args.file:
        probe = _probe_video(args.file)
        if probe:
            file_w, file_h, file_fps = probe
            print("Probed %s: %dx%d @ %.1f fps" % (
                args.file, file_w, file_h, file_fps), file=sys.stderr)
            if args.width is None:
                args.width = file_w
            if args.height is None:
                args.height = file_h
            if args.fps is None:
                args.fps = round(file_fps)
        else:
            print("WARNING: could not probe %s, using defaults" % args.file,
                  file=sys.stderr)

    # Defaults for pattern mode — small resolution so ROS2 DDS can sustain 60fps
    # (640x480 bgr8 = 921KB/frame = 55MB/s at 60fps, too heavy for DDS)
    if args.width is None:
        args.width = 320
    if args.height is None:
        args.height = 240
    if args.fps is None:
        args.fps = 60

    rclpy.init()
    node = TestCamera(
        args.topic, args.width, args.height, args.fps,
        video_file=args.file, loop=args.loop,
    )
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
