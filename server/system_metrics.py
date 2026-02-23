"""
System Metrics Collector

Periodically samples CPU and GPU usage and delivers them via a callback.
Designed to run in its own daemon thread with minimal overhead.

CPU: uses psutil (cross-platform, accurate per-interval measurement).
GPU: uses nvidia-smi CLI (no pynvml dependency, works on Jetson + desktop).
"""

import shutil
import subprocess
import sys
import threading
import time

try:
    import psutil
    _HAS_PSUTIL = True
except ImportError:
    _HAS_PSUTIL = False

_HAS_NVIDIA_SMI = shutil.which("nvidia-smi") is not None


from .log import info as _log_info, warn as _log_warn

def _log(msg):
    _log_info("SystemMetrics", msg)


def _read_gpu_usage():
    """
    Query GPU utilization via nvidia-smi.
    Returns dict with 'gpu_percent' and 'mem_percent', or None on failure.
    """
    try:
        result = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=utilization.gpu,utilization.memory,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=2,
        )
        if result.returncode != 0:
            return None

        # Parse first GPU line: "42, 31, 1024, 8192"
        line = result.stdout.strip().split('\n')[0]
        parts = [p.strip() for p in line.split(',')]
        if len(parts) >= 4:
            return {
                'gpu_percent': float(parts[0]),
                'mem_percent': float(parts[1]),
                'mem_used_mb': float(parts[2]),
                'mem_total_mb': float(parts[3]),
            }
    except Exception:
        pass
    return None


class SystemMetricsCollector:
    """
    Collects CPU and GPU metrics at a configurable interval.
    Calls on_metrics(data_dict) with the latest readings.
    """

    def __init__(self, interval=2.0):
        self.interval = interval
        self.on_metrics = None  # callback(dict)
        self._stopped = False
        self._thread = None

        if not _HAS_PSUTIL:
            _log_warn("SystemMetrics", "psutil not installed — CPU metrics unavailable. "
                      "Install with: pip install psutil")
        if not _HAS_NVIDIA_SMI:
            _log("nvidia-smi not found — GPU metrics unavailable")
        else:
            _log("nvidia-smi found — GPU metrics enabled")

        if _HAS_PSUTIL:
            _log("psutil available — CPU metrics enabled")

    def start(self):
        """Start the collection thread."""
        self._stopped = False
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        """Stop the collection thread."""
        self._stopped = True

    def _loop(self):
        # Prime psutil's cpu_percent (first call always returns 0)
        if _HAS_PSUTIL:
            psutil.cpu_percent(interval=None)

        while not self._stopped:
            time.sleep(self.interval)
            if self._stopped:
                break

            data = self._collect()
            if self.on_metrics and data:
                try:
                    self.on_metrics(data)
                except Exception:
                    pass

    def _collect(self):
        """Collect a single metrics snapshot."""
        data = {}

        if _HAS_PSUTIL:
            # Only call cpu_percent once per cycle — calling it twice
            # resets the internal counter and corrupts the second reading.
            per_cpu = psutil.cpu_percent(interval=None, percpu=True)
            if per_cpu:
                data['cpu_per_core'] = per_cpu
                data['cpu_percent'] = sum(per_cpu) / len(per_cpu)
            else:
                data['cpu_percent'] = psutil.cpu_percent(interval=None)
            data['cpu_count'] = psutil.cpu_count()

        if _HAS_NVIDIA_SMI:
            gpu = _read_gpu_usage()
            if gpu:
                data.update(gpu)

        return data if data else None
