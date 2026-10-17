"""Own or reuse the shared HTTP server for the optional Electron desktop shell."""

import argparse
import json
import logging
import os
import signal
import sys
import threading
import time
from urllib.request import urlopen

from . import __version__, app

PROTOCOL = 1


def compatible_server(port):
    """Only reuse a matching Tagcast; never load an arbitrary occupied port."""
    try:
        with urlopen(f"http://127.0.0.1:{port}/api/app", timeout=3) as response:
            data = json.loads(response.read(4097))
        return (data.get("application") == "Tagcast" and data.get("version") == __version__
                and data.get("desktop_protocol") == PROTOCOL)
    except (OSError, ValueError, AttributeError):
        return False


def finish_server(server):
    """Stop between batches and finish accepted requests/read-backs before exit."""
    studio = server.RequestHandlerClass.func.studio
    studio.cleanup.stop.set()
    studio.duplicate_cleanup.stop.set()
    server.shutdown()
    server.server_close()
    with studio.save_lock:
        pass
    while True:
        with studio.lock:
            checking = any(job.get("state") == "checking" for job in studio.jobs.values())
        if not checking:
            break
        time.sleep(.1)
    with studio.cache_lock:
        pass


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
    stopping = threading.Event()

    def read_parent():
        try:
            for line in sys.stdin:
                if line.strip() == "stop":
                    break
        finally:
            stopping.set()  # EOF also stops our child after an unexpected parent exit.

    def stop_signal(_signum, _frame):
        stopping.set()

    for name in ("SIGTERM", "SIGINT"):
        signal.signal(getattr(signal, name), stop_signal)
    threading.Thread(target=read_parent, daemon=True).start()
    try:
        print(json.dumps({"event": "ready", "protocol": PROTOCOL, "version": __version__,
                          "url": f"http://127.0.0.1:{port}", "owned": server is not None}), flush=True)
        stopping.wait()
    finally:
        if server:
            finish_server(server)
            worker.join()
        logging.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
