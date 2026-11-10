"""Own or reuse the shared HTTP server for the optional Electron desktop shell."""

import argparse
import json
import logging
import os
import queue
import signal
import sys
import threading
from urllib.request import urlopen

from . import __version__, app
from .server_lifecycle import drain_server

PROTOCOL = 1


def emit(data):
    try:
        print(json.dumps(data), flush=True)
        return True
    except (OSError, ValueError):
        return False


def compatible_server(port):
    """Only reuse a matching Tagcast; never load an arbitrary occupied port."""
    try:
        with urlopen(f"http://127.0.0.1:{port}/api/app", timeout=3) as response:
            data = json.loads(response.read(4097))
        return (data.get("application") == "Tagcast" and data.get("version") == __version__
                and data.get("desktop_protocol") == PROTOCOL and not data.get("closing"))
    except (OSError, ValueError, AttributeError):
        return False


def finish_server(server, progress=lambda _state: None, commands=None):
    """Keep the owned listener until all admitted work is safely drained."""
    if not drain_server(server, progress, commands):
        return False
    server.server_close()
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=f"Tagcast {__version__}")
    parser.add_argument("--port", type=int, default=int(os.environ.get("TAGCAST_PORT", 8912)))
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("Choose a port between 0 and 65535.")
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    server = None
    try:
        server = app.open_server(args.port)
    except OSError:
        if not compatible_server(args.port):
            print(json.dumps({"event": "error", "message":
                              "The port is occupied or another Tagcast version is running. "
                              "Close that instance and try again."}), flush=True)
            return 1
    if server:
        # Accepted requests finish on shutdown, including reviewed writes.
        server.daemon_threads = False
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
    port = server.server_port if server else args.port
    commands = queue.Queue()

    def read_parent():
        try:
            for line in sys.stdin:
                command = line.strip()
                if command in ("stop", "drain", "resume", "finish"):
                    commands.put(command)
        finally:
            commands.put("eof")  # An absent parent still waits for accepted work.

    def stop_signal(_signum, _frame):
        commands.put("eof")

    for name in ("SIGTERM", "SIGINT"):
        signal.signal(getattr(signal, name), stop_signal)
    threading.Thread(target=read_parent, daemon=True).start()
    try:
        if not emit({"event": "ready", "protocol": PROTOCOL, "version": __version__,
                     "url": f"http://127.0.0.1:{port}", "owned": server is not None, "shutdown_control": 1}):
            commands.put("eof")
        while True:
            command = commands.get()
            if command not in ("stop", "drain", "finish", "eof"):
                continue
            if not server:
                break
            if command in ("stop", "finish", "eof"):
                commands.put("eof")
            def progress(state):
                if not emit({"event": "shutdown", **state}):
                    commands.put("eof")
            if finish_server(server, progress, commands):
                worker.join()
                break
            if not emit({"event": "resumed"}):
                commands.put("eof")
    finally:
        logging.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
