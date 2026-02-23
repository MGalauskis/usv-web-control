"""
Colored console logging for USV Web Control.

Colors:
  INFO  = white/default
  WARN  = yellow
  ERROR = red

Uses ANSI escape codes. Automatically disables color when output
is not a terminal (e.g., piped to a file or journald).
"""

import sys

# ANSI color codes
_RESET = "\033[0m"
_WHITE = "\033[97m"
_YELLOW = "\033[93m"
_RED = "\033[91m"
_DIM = "\033[90m"

# Disable color if not a real terminal
_USE_COLOR = hasattr(sys.stderr, "isatty") and sys.stderr.isatty()


def _c(code, text):
    """Wrap text in ANSI color if output is a terminal."""
    if _USE_COLOR:
        return code + text + _RESET
    return text


def info(tag, msg):
    """Info level — white."""
    print(_c(_WHITE, "[%s] %s" % (tag, msg)), file=sys.stderr, flush=True)


def warn(tag, msg):
    """Warning level — yellow."""
    print(_c(_YELLOW, "[%s] ⚠ %s" % (tag, msg)), file=sys.stderr, flush=True)


def error(tag, msg):
    """Error level — red."""
    print(_c(_RED, "[%s] ✖ %s" % (tag, msg)), file=sys.stderr, flush=True)
