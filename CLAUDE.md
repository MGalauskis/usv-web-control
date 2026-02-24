# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Commits

Never add `Co-Authored-By: Claude` or any Claude attribution to commit messages.

## Project Overview

USV Web Control is a browser-based interface for controlling an Unmanned Surface Vehicle (USV) through ROS2. It bridges a web UI to ROS2 via WebSockets, allowing operators to send joystick commands and monitor ROS2 topics remotely.

The networking architecture is inspired by [rosboard](https://github.com/dheera/rosboard). The system is designed to operate over a WireGuard VPN — the browser connects to the USV's Tornado server through the VPN tunnel.

**Current state**: USB joystick input is read in the browser (Gamepad API), sent over WebSocket to the server, and published as `sensor_msgs/Joy` on ROS2. Dynamic topic subscription and visualization is working — any ROS2 topic can be viewed via `GenericViewer`, and `sensor_msgs/Image` topics get live H.264 video streaming via FFmpeg + JMuxer. Direct camera streaming via GStreamer (bypassing ROS2) is implemented — cameras are auto-discovered or configured via `cameras.yaml`. System resource metrics (CPU/GPU) are displayed in the header. Future work includes mission control panels, more specialized viewers, and per-tile video settings.

## Running

Requires a ROS2 environment with `rclpy`, `tornado`, `sensor_msgs`, and `rosgraph_msgs` available.

```bash
pip install -r requirements.txt   # installs tornado

# Option 1: Run directly (from project root)
python -m server

# Option 2: Run via ROS2 launch
ros2 launch launch/usv_web_control.launch.py
ros2 launch launch/usv_web_control.launch.py port:=9090 joy_topic:=/cmd_joy

# ROS2 parameters:
#   port  (int, default 8888)   - HTTP/WS server port
#   title (str, default hostname) - display name sent to browser
#   joy_topic (str, default "/joy") - ROS2 topic for joystick output
```

No build step for the frontend — it's vanilla HTML/CSS/JS served statically by Tornado.

## Architecture

**Server (Python/Tornado + ROS2):**
- `server/usv_node.py` — `USVWebNode(rclpy.Node)`: the main ROS2 node. Runs a Tornado HTTP server in a daemon thread. Manages dynamic ROS2 subscriptions based on what browser clients request. Publishes `sensor_msgs/Joy` from browser joystick input. Converts ROS2 messages to dicts via `ros2dict()`. Routes image topics to the H.264 encoding pipeline.
- `server/handlers.py` — `USVSocketHandler`: Tornado WebSocket handler. Manages per-client subscription state, per-topic throttle rates, and ping/pong latency tracking. Broadcasts ROS2 data (JSON text) and H.264 video (binary) to subscribed clients.
- `server/video_stream.py` — `H264Stream`: manages a persistent FFmpeg subprocess per image topic. Accepts raw pixel frames, outputs H.264 NAL units. Auto-detects best encoder at import time (NVENC → QSV → libx264 software). Supports CUDA-accelerated colorspace conversion on FFmpeg 5.x+.
- `server/camera_stream.py` — `GStreamerStream`: manages GStreamer subprocesses that capture directly from cameras (V4L2, RTSP, test patterns) and encode to H.264, bypassing ROS2 entirely. Auto-detects best GStreamer encoder at import time (nvh264enc → nvv4l2h264enc → vaapih264enc → qsvh264enc → x264enc). Includes V4L2 camera auto-discovery and YAML config loading.
- `server/system_metrics.py` — `SystemMetricsCollector`: daemon thread that samples CPU usage (via `psutil`) and GPU usage (via `nvidia-smi`) every 2 seconds. Broadcasts to all connected WebSocket clients.

**Frontend (vanilla JS, no framework):**
- `frontend/js/connection.js` — `USVConnection` class: WebSocket client with auto-reconnect, message routing, and subscribe/unsubscribe/sendJoy API. Handles both JSON text frames and binary H.264 frames.
- `frontend/js/joystick.js` — `JoystickCapture` class: polls browser Gamepad API at 50Hz, applies deadzone filtering, only sends on change.
- `frontend/js/app.js` — glue: wires connection + joystick to DOM, updates stick visuals, axes grid, buttons grid, log panel. Routes binary video data to ImageViewer instances. Displays CPU/GPU metrics.
- `frontend/js/viewers/Viewer.js` — base class for topic viewers. Viewer registry maps ROS2 message types to viewer classes.
- `frontend/js/viewers/GenericViewer.js` — fallback viewer that renders any ROS2 message as a key-value table.
- `frontend/js/viewers/ImageViewer.js` — H.264 video viewer using JMuxer (MSE + fMP4). Receives binary H.264 NAL units and renders to `<video>` element. JMuxer is created lazily on first `"v"` metadata message so FPS is always correct from frame 1. Includes per-tile settings toolbar (FPS override, quality).
- `frontend/js/lib/jmuxer.min.js` — vendored JMuxer library (no CDN — USV may not have internet).

## WebSocket Protocol

Text messages are JSON arrays: `[type_char, payload_dict]`

| Direction | Type | Meaning |
|-----------|------|---------|
| S→B | `"p"` | PING (latency measurement) |
| B→S | `"q"` | PONG response |
| S→B | `"y"` | System info on connect (hostname, version) |
| S→B | `"t"` | Topic list (all ROS2 topics) |
| S→B | `"m"` | ROS2 message data for subscribed topic |
| S→B | `"r"` | System resource metrics (CPU/GPU usage) |
| S→B | `"v"` | Video stream metadata (fps, resolution, encoder) |
| S→B | `"c"` | Camera list (direct GStreamer cameras) |
| S→B | `"w"` | Mission list (all missions from missions.json) |
| S→B | `"g"` | USV GPS position update `{lat, lng, heading?, topic}` |
| S→B | `"l"` | Offline map layer list `{layer_name: {label}, ...}` |
| B→S | `"s"` | Subscribe to ROS2 topic (with maxUpdateRate) |
| B→S | `"u"` | Unsubscribe from ROS2 topic |
| B→S | `"j"` | Joystick data (axes + buttons arrays) |
| B→S | `"d"` | Subscribe to direct camera stream |
| B→S | `"e"` | Unsubscribe from direct camera stream |
| B→S | `"f"` | Per-stream video settings override (fps, quality) |

Binary messages (WebSocket binary frames) are used for H.264 video data:
```
[1 byte: topic name length N] [N bytes: topic name UTF-8] [H.264 NAL units]
```

## Key Design Patterns

- **Dynamic ROS2 subscriptions**: the server only subscribes to ROS2 topics that at least one browser client has requested. Subscriptions are cleaned up when no clients need them (`sync_subs()`).
- **Per-client throttling**: each WebSocket client can set a `maxUpdateRate` per topic. The server skips messages that arrive faster than the client's requested rate.
- **QoS matching**: when subscribing to a ROS2 topic, the server inspects existing publishers' QoS profiles and matches them.
- **Threading model**: ROS2 spin runs on the main thread. Tornado event loop, subscription sync, and ping/pong each run on separate daemon threads. Cross-thread communication uses `event_loop.add_callback()`.

## Planned: Virtual Joystick (not yet implemented)

A touch-friendly virtual joystick for devices without a USB gamepad (tablets, phones). It should send the same `["j", {...}]` WebSocket message as `JoystickCapture`, so the server side needs no changes.

**Controls:**
- **Throttle slider** (axis 0): vertical slider, does NOT return to center — stays where the user leaves it.
- **Direction slider** (axis 1): horizontal left/right slider, DOES return to center on release.
- **4 buttons** (buttons 0–3): unmapped/unnamed for now — final function TBD.

**Notes:**
- Should auto-detect touch capability and show virtual controls when no USB gamepad is connected.
- Final axis/button mapping and naming will be defined later.
- The virtual joystick and USB gamepad should be mutually exclusive — USB gamepad takes priority if connected.

## Networking & Transport

The system supports two connectivity modes:

1. **Direct / wired connection** — browser and USV on the same local network. TCP WebSocket connects directly to the Tornado server.
2. **Remote via WireGuard VPN** — WireGuard creates a virtual LAN between the browser's machine and the USV. The actual internet transport is UDP (WireGuard encapsulates everything in UDP), while TCP is only used locally on each end (browser↔local WG interface, WG interface↔Tornado).

**Key insight**: since WireGuard already handles TCP→UDP→TCP translation, there is no need for WebRTC, WebTransport, or custom UDP channels. The existing TCP WebSocket architecture works well for both local and remote scenarios. Head-of-line blocking is negligible on local networks and handled adequately by WireGuard over the internet.

The main concerns for high-bandwidth topics (like camera images) are:
- **Server-side compression** — encode raw `sensor_msgs/Image` to H.264 video via FFmpeg before sending over WebSocket (not raw image data).
- **Payload size** — keep messages reasonable to avoid excessive WireGuard fragmentation.
- **Throttling** — the existing per-client `maxUpdateRate` mechanism already handles rate limiting.

## H.264 Video Streaming for Image Topics

Instead of sending JPEG-per-frame, image topics use H.264 encoding via FFmpeg for much better compression (exploits temporal redundancy between frames).

**Server-side pipeline:**

1. ROS2 `sensor_msgs/Image` callback receives raw frames (e.g. 640x480 RGB8 = ~921 KB/frame).
2. A persistent FFmpeg subprocess accepts raw pixels on stdin and outputs H.264 NAL units on stdout.
3. Server reads encoded H.264 chunks from FFmpeg stdout.
4. Chunks are sent to the browser as WebSocket binary frames.

One FFmpeg subprocess is spawned per image topic when a client subscribes, and killed when no clients remain.

**FFmpeg command:**
```
ffmpeg -f rawvideo -pix_fmt bgr24 -s {width}x{height} -r {fps}
  -i pipe:0
  -c:v libx264 -preset ultrafast -tune zerolatency
  -profile:v baseline -level 3.1
  -g {fps} -keyint_min {fps}
  -bsf:v dump_extra
  -f h264
  pipe:1
```

Key flags:
- `-preset ultrafast -tune zerolatency` — minimal encoding latency.
- `-profile:v baseline` — widest decoder compatibility.
- `-g {fps}` — keyframe every N frames (1 second). Needed so the browser can start decoding mid-stream.
- `-bsf:v dump_extra` — prepends SPS/PPS headers to every keyframe so the decoder can initialize at any point.
- `-f h264` — raw H.264 byte stream (no container).
- `pipe:0` / `pipe:1` — stdin/stdout for zero-copy streaming.

**Bandwidth comparison** (640x480 @ 15fps):
- Raw: ~14 MB/s
- JPEG quality 50: ~450 KB/s
- H.264 ultrafast: ~50–150 KB/s

**Browser-side decoding:**

The challenge is cross-browser H.264 decoding. Options ranked by preference:

1. **MSE (Media Source Extensions) + fMP4** — The server (or a thin client-side JS layer) wraps raw H.264 NAL units into fragmented MP4 (fMP4) segments. These are fed to a `MediaSource` object driving a `<video>` element. The browser's built-in hardware-accelerated decoder handles the rest. **Works in all major browsers** (Chrome, Firefox, Safari, Edge). This is the preferred approach.

2. **JMuxer** — A JS library that simplifies the MSE + fMP4 wrapping. Accepts raw H.264 data and handles muxing internally. Reduces boilerplate. Cross-browser.

3. **Broadway.js** — A pure JS/WASM port of an H.264 decoder. Decodes entirely in software, no browser API dependencies. Works everywhere as a fallback, but higher CPU usage since it can't use hardware decoding.

4. **WebCodecs API** — Native low-level `VideoDecoder` in Chrome/Edge. Lowest latency, direct access to decoded `VideoFrame` objects rendered to canvas. **Not supported in Firefox** — so it cannot be the only solution. Could be used opportunistically when available.

**Recommended approach**: Use JMuxer (or manual MSE + fMP4) as the primary decoder for cross-browser support. Optionally detect WebCodecs and use it in Chrome/Edge for lower latency.

**FPS auto-detection:**

The server automatically detects the framerate of each image topic by measuring message arrival rate. It uses a lightweight counter + checkpoint approach: counts frames between periodic timestamps (minimum 1 second apart) and computes `(count - 1) / elapsed`. The raw FPS is snapped to the nearest common value (10, 15, 20, 24, 25, 30, 50, 60, 90, 120) for stability, with 20% hysteresis to prevent bouncing between adjacent values (e.g. 20↔24 at 22fps). FFmpeg is started with the initial default (30fps) and restarted if the detected FPS changes. This means the H.264 encoder always matches the actual publisher rate — no manual configuration needed.

**Hardware encoder auto-detection:**

At import time, `video_stream.py` probes available H.264 encoders by running a real 1-frame encode test:
1. **NVENC** (`h264_nvenc`) — NVIDIA GPU hardware encoding. If available, also probes for CUDA-accelerated colorspace conversion (`hwupload_cuda,scale_cuda=format=nv12`) which avoids CPU-heavy swscale. Requires FFmpeg 5.x+ for the `format=` option; falls back to CPU swscale on older FFmpeg (e.g. 4.4 on Ubuntu 22.04).
2. **QSV** (`h264_qsv`) — Intel Quick Sync Video.
3. **Software** (`libx264`) — CPU fallback, capped at 10fps to avoid overload.

**Throttle-before-copy optimization:**

The `on_image_msg()` callback checks the throttle interval BEFORE calling `bytes(msg.data)`. At 60fps with 640x480 BGR8, the copy is 921KB per frame = 55 MB/s. Without this optimization, frames that would be dropped anyway still incur the full copy cost.

**Requirements:**
- FFmpeg must be installed on the USV (`apt install ffmpeg`).
- Resolution/encoding changes from the ROS2 camera require restarting the FFmpeg subprocess.
- First decoded frame must wait for a keyframe (up to 1 second delay on stream start).

## Planned: Server→Browser Stream Metadata (not yet implemented)

The server should communicate per-topic stream metadata to the browser, so the ImageViewer can configure JMuxer with the correct parameters:

- **Detected FPS** — the auto-detected source framerate. JMuxer uses FPS for fMP4 segment timestamp calculation; currently hardcoded to 30. A mismatch causes timing drift and choppy playback.
- **Resolution** — width × height of the stream, useful for display and aspect ratio.
- **Encoder** — which encoder is in use (nvenc/qsv/sw), for informational display.

This could be sent as a new message type (e.g. `["v", {"topic": "/camera/image_raw", "fps": 30, "width": 640, "height": 480, "encoder": "nvenc"}]`) when a video stream starts or its parameters change. The ImageViewer would then reconfigure or recreate JMuxer with the correct FPS.

## Planned: Per-Tile Video Settings (not yet implemented)

Each ImageViewer tile should expose UI controls for the user to adjust:

- **Target framerate** — override the auto-detected FPS with a user-selected value (e.g., drop from 60fps to 15fps to save bandwidth). The browser sends the desired FPS to the server, which restarts FFmpeg with the new `-r` value.
- **Encoding quality / bandwidth cap** — adjust the H.264 CRF or bitrate parameter. Lower quality = less bandwidth. Could expose a simple "quality" slider (low / medium / high) that maps to FFmpeg `-crf` values.
- **Pause / resume** — stop receiving frames entirely without unsubscribing (already partially implemented via `paused` flag in ImageViewer).

These settings should be per-tile (each video viewer can have different settings) and communicated to the server via a new WebSocket message type. The server would then adjust the FFmpeg pipeline for that specific topic accordingly.

## Type-Specific Viewers

The viewer system uses a registry pattern: each viewer class declares `static get supportedTypes()` and registers itself via `Viewer.registerViewer()`. When a topic is subscribed, the best viewer is selected based on message type. `GenericViewer` is the fallback for unrecognized types.

**Implemented:**
- `sensor_msgs/Image` — `ImageViewer`: live H.264 video via JMuxer (MSE + fMP4). Receives binary WebSocket frames, decodes to `<video>` element.

**Planned:**
- `sensor_msgs/NavSatFix` — GPS position on a map
- `sensor_msgs/Imu` — orientation/attitude visualization
- `sensor_msgs/BatteryState` — battery gauge widget
- `geometry_msgs/Twist` — velocity arrows
- `nav_msgs/Path` — path overlay on map

## GStreamer Direct Camera Streams (bypassing ROS2)

The GStreamer camera system provides a high-performance alternative to the ROS2 image pipeline for direct camera access. Instead of going through DDS serialization/deserialization, GStreamer captures from the camera and encodes to H.264 in a single subprocess, piping the byte stream to stdout.

**Why bypass ROS2 for cameras:** DDS serializes `sensor_msgs/Image` into RTPS packets, fragments, reassembles, and deserializes — all wasted work for data that's immediately re-encoded and discarded. At 1080p60 BGR8 that's ~370 MB/s of unnecessary overhead. The Python GIL + `bytes(msg.data)` copy adds another bottleneck (6.2 MB per frame at 1080p).

**Architecture:**

```
GStreamer subprocess (per camera)             Existing FFmpeg pipeline (fallback)
  v4l2src/rtspsrc/videotestsrc                  ROS2 Image topic → Python callback
  → videoconvert → h264 encoder                 → bytes(msg.data) → FFmpeg stdin
  → h264parse → fdsink fd=1                     → H.264 stdout
       ↓                                              ↓
       └──────────── both produce ──────────────────┘
                          ↓
              Python reads stdout (same read loop)
                          ↓
              [1 byte len][camera_id][H.264 data]  ← same binary frame format
                          ↓
              WebSocket broadcast_binary()
                          ↓
              Browser ImageViewer + JMuxer  ← completely unchanged
```

**Key files:**
- `server/camera_stream.py` — `GStreamerStream` class, encoder detection, pipeline builder, V4L2 auto-discovery, YAML config loader.
- `cameras.yaml` — optional camera configuration. If absent, V4L2 cameras are auto-discovered.

**Camera IDs** use the prefix `camera:` (e.g. `camera:Forward Camera`) to avoid collision with ROS2 topic names (which start with `/`).

**Coexistence:** The ROS2 image pipeline (FFmpeg-based in `video_stream.py`) remains as a fallback for bag playback, development with `test_camera.py`, and third-party camera drivers. Both systems use the same WebSocket binary frame format and browser-side decoder (ImageViewer + JMuxer).

### Camera Configuration

Cameras are configured via `cameras.yaml` in the project root. If the file is absent, the server auto-discovers V4L2 devices.

**Supported source types:**

| source | Description | GStreamer source element |
|--------|-------------|------------------------|
| `v4l2` | USB/UVC cameras | `v4l2src` |
| `rtsp` | IP cameras (passthrough or re-encode) | `rtspsrc` |
| `test` | GStreamer test pattern | `videotestsrc` |
| `libcamera` | CSI cameras via libcamera | `libcamerasrc` |
| `nvargus` | NVIDIA Jetson CSI cameras | `nvarguscamerasrc` |

**Example `cameras.yaml`:**

```yaml
cameras:
  - name: "Forward Camera"
    source: v4l2
    device: /dev/video0
    width: 1920
    height: 1080
    fps: 30

  - name: "Aft Camera"
    source: rtsp
    url: rtsp://192.168.1.100:554/stream
    passthrough: true       # H.264 already encoded, skip re-encoding

  - name: "Debug Pattern"
    source: test
    pattern: ball
    width: 640
    height: 480
    fps: 30
```

**RTSP passthrough:** IP cameras that already output H.264 can be passed through without re-encoding. The GStreamer pipeline just depayloads the RTP and pipes raw H.264 to stdout — dramatically cheaper than decode + re-encode.

### GStreamer Encoder Auto-Detection

At import time, `camera_stream.py` probes available encoders by running a real 1-frame encode test through `gst-launch-1.0`:

1. `nvh264enc` — NVIDIA desktop GPU
2. `nvv4l2h264enc` — NVIDIA Jetson
3. `vaapih264enc` — VA-API (Intel/AMD)
4. `qsvh264enc` — Intel Quick Sync
5. `x264enc` — Software fallback

**NVMM memory (Jetson):** `nvarguscamerasrc` outputs frames in GPU memory (`memory:NVMM`). The pipeline builder automatically uses `nvv4l2h264enc` for nvargus sources (accepts NVMM buffers directly, no CPU copy).

### V4L2 Auto-Discovery

When no `cameras.yaml` exists:
1. Enumerates `/dev/video*` devices.
2. Probes each with GStreamer to verify it's a usable video source.
3. Gets human-readable name via `v4l2-ctl --info` (Card type field).
4. Returns default config: 640x480 @ 30fps.

Gracefully returns nothing on non-Linux systems.

### Camera WebSocket Protocol

| Direction | Type | Payload |
|-----------|------|---------|
| S→B | `"c"` | `{camera_id: {name, source, width, height, fps, passthrough}}` — camera list |
| B→S | `"d"` | `{cameraId: "camera:..."}` — subscribe to camera |
| B→S | `"e"` | `{cameraId: "camera:..."}` — unsubscribe from camera |
| S→B | binary | `[len][camera_id][H.264 data]` — same format as ROS2 image topics |
| S→B | `"v"` | `{topic: camera_id, fps, width, height, encoder}` — video metadata |

**Camera lifecycle:** GStreamer subprocess starts when the first client subscribes and stops when no clients remain (same pattern as ROS2 topic subscriptions). Camera list is sent on WebSocket connect and refreshed periodically.

### Requirements

- GStreamer must be installed: `apt install gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly`
- For NVIDIA hardware encoding: `gstreamer1.0-plugins-bad` (contains `nvh264enc`)
- For V4L2 auto-discovery names: `v4l2-utils` (optional, falls back to device path)
- PyYAML for `cameras.yaml` parsing (already available in ROS2 environments)

## Planned: Mission Planning Map Viewer (not yet implemented)

A dedicated map-based viewer for creating, editing, and managing USV missions. This is a core operational tool — the primary way operators will define where the USV goes.

### Missions and Waypoints

- A **mission** is an ordered list of waypoints, each defined by real-world coordinates (latitude/longitude).
- The system supports **multiple missions** — the user selects which mission to view/edit from a mission selector (dropdown or list).
- **All waypoint and mission logic lives on the server.** The browser is purely a visual editor and display layer. Every mutation (add, delete, reorder, edit waypoint) is sent to the server via WebSocket, and the server is the source of truth. The browser re-renders based on server state.

### Waypoint Ordering and Editing

Waypoint order matters — it defines the traversal sequence. Two mechanisms for reordering:

1. **Side panel list** — a scrollable ordered list of waypoints alongside the map. Supports drag-and-drop reordering within the list. Each entry shows the waypoint index, coordinates, and optionally a name/label. Selecting a waypoint in the list highlights it on the map and vice versa.
2. **Map drag-and-drop swap** — dragging a waypoint marker onto another waypoint on the map swaps their positions in the order. This is a quick way to fix ordering mistakes without leaving the map view.

Additional waypoint operations:
- Click on the map to add a new waypoint at the end of the mission.
- Click an existing waypoint to select it — show edit controls (delete, move, insert before/after).
- Drag a waypoint marker on the map to reposition it geographically (updates coordinates on the server).

### Map Layers

Two categories of layers are implemented:

**Basemaps** (mutually exclusive — one active at a time, dropdown selector):
- `osm` — OpenStreetMap (online, always available)
- `satellite` — ESRI World Imagery (online, always available)
- Offline MBTiles layers — discovered automatically from the `maps/` directory, sent to browser via `"l"` WebSocket message on connect

**Overlays** (additive — checkbox toggles, stacked on top of basemap):
- `openseamap` — OpenSeaMap nautical marks (online)
- More overlays can be added by extending `ONLINE_OVERLAYS` in `mapPanel.js`

**Offline layer discovery:** The server scans `maps/` in the project root at startup. Each `.mbtiles` file becomes a layer. The filename (without extension) is the layer name; it's title-cased for the label (e.g. `nautical_chart.mbtiles` → "Nautical Chart"). A legacy `map.mbtiles` in the project root is also accepted as layer name `"map"`.

**Tile URL:** `/tiles/{layer_name}/{z}/{x}/{y}.png` — served by `MBTilesHandler` with TMS y-flip and persistent SQLite connection pool.

**Server parameter:** `maps_dir` (ROS2 launch param, default `maps/` in project root).

**Layer persistence:** Selected basemap and active overlays are saved to `localStorage` and restored on page reload.

**Adding more online layers:** add entries to `ONLINE_BASEMAPS` or `ONLINE_OVERLAYS` in `mapPanel.js` — no server changes needed.

### USV Position and Quick Navigation

The map always shows the **current real-time position of the USV** as a distinct marker (sourced from a ROS2 topic like `sensor_msgs/NavSatFix`). The marker indicates heading/orientation from the GPS heading field.

**Future: USV marker shape and colour** — the current marker is a plain `▲` Unicode arrow in red (`#e94560`). In the future this should be replaced with an SVG silhouette matching the actual USV hull shape, coloured to match the physical boat. The CSS class is `.map-usv-arrow` in `style.css` and the icon is built in `MapPanel._usvIcon()` in `mapPanel.js`.

**Quick-zoom buttons** for common navigation actions:
- **Go to USV** — center and zoom the map on the USV's current position.
- **Go to Mission** — fit the entire active mission (all waypoints) into the viewport.
- **Go to My Location** — center on the operator's browser/device location (via browser Geolocation API). Useful when the operator is near the USV and wants spatial context.

### Planned: Auto-Route / Fill Gaps (future)

A future server-side feature that automatically optimizes a mission path:

- **Uniform waypoint fill** — given sparse user-defined waypoints, insert intermediate waypoints at uniform spacing along the path. Useful for ensuring consistent coverage (e.g., survey patterns).
- **Traversability-aware routing** — the auto-router should consider where the USV can actually navigate, avoiding land, shallow water, and other obstacles. This requires the water/land and depth map data to be available server-side, not just as visual tile layers.
- **Path optimization** — reorder or adjust waypoints to minimize total distance, avoid unnecessary crossings, or follow efficient survey patterns (e.g., lawnmower/boustrophedon).

This is a complex feature that depends on having good map data on the server. The initial mission planner should be designed with this in mind but does not need to implement it — manual waypoint placement is sufficient for v1.

### UI Design Principles

- **Touch-first** — all interactions (waypoint placement, drag-and-drop reordering, layer toggles, zoom buttons) must work well on tablets and touchscreens. Hit targets should be large enough for finger input.
- **Functional elegance** — clean, uncluttered interface. No gratuitous animations or transitions. UI state changes should be immediate and responsive.
- **Map dominates** — the map should take up maximum screen real estate. The waypoint list panel should be collapsible/hideable. Layer controls and zoom buttons should be compact overlays, not heavy sidebars.
- **Consistent with existing UI** — follow the same vanilla HTML/CSS/JS approach as the rest of the frontend. No framework dependencies.

## Testing

### Camera Sources — Test Status

| Source | Status | Notes |
|--------|--------|-------|
| `test` (GStreamer `videotestsrc`) | ✅ Tested | Works. Requires `gstreamer1.0-plugins-bad` for `h264parse` and `gstreamer1.0-plugins-ugly` for `x264enc`. Must force `profile=baseline` in caps filter after encoder or browser rejects codec (`avc1.f4001e`). |
| `v4l2` (USB/UVC cameras) | ❌ Not tested | Requires physical USB camera. Can emulate with `v4l2loopback` kernel module: `sudo modprobe v4l2loopback` creates a virtual `/dev/videoN`; feed it with `gst-launch-1.0 videotestsrc ! v4l2sink device=/dev/videoN`. |
| `rtsp` (re-encode) | ❌ Not tested | Requires an RTSP source. Can emulate with [mediamtx](https://github.com/bluenviron/mediamtx): run `mediamtx`, then publish a test stream to it via GStreamer (`gst-launch-1.0 videotestsrc ! x264enc ! rtspclientsink location=rtsp://localhost:8554/test`). |
| `rtsp` (passthrough) | ❌ Not tested | Same setup as rtsp re-encode but source must already be H.264. mediamtx handles this naturally — connect with `passthrough: true` in `cameras.yaml`. |
| `libcamera` (CSI via libcamera) | ❌ Not tested | Requires real CSI hardware (e.g. Raspberry Pi camera). No practical emulation available. |
| `nvargus` (Jetson CSI via Argus) | ❌ Not tested | Requires physical NVIDIA Jetson with CSI camera. No emulation possible. |

### Known Issues / Gotchas

- **`x264enc` profile**: must add `! video/x-h264,profile=baseline` after the encoder in the GStreamer pipeline, otherwise the browser rejects the stream (`avc1.f4001e` = High 4:4:4 profile, unsupported by MSE decoders).
- **Missing GStreamer packages**: `h264parse` is in `gstreamer1.0-plugins-bad`; `x264enc` is in `gstreamer1.0-plugins-ugly`. Both must be installed or the pipeline fails silently with stdout EOF.
- **Encoder probe at import time**: `_BEST_GST_ENCODER` is detected once when `camera_stream.py` is imported. Restart the server after installing new GStreamer packages.
- **RTSP passthrough — quality/FPS settings have no effect**: when `passthrough: true` is set for an RTSP camera, the GStreamer pipeline is `rtspsrc → rtph264depay → h264parse → fdsink` with no encoder. The `["f", ...]` video settings message is silently ignored for passthrough streams — the quality and FPS are whatever the IP camera itself outputs. To change quality or frame rate, configure the camera directly (via its own web UI or ONVIF). Only re-encoding RTSP sources (without `passthrough: true`) respond to video settings.
