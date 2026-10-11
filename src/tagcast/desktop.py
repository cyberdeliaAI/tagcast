"""Small desktop launcher; the Tagcast interface remains in the browser."""

import argparse
import json
import logging
import os
import sys
import tempfile
import threading
import webbrowser

from . import __version__, app


def automatic_browser(path):
    """Launcher preferences are separate from server settings and credentials."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        enabled = data.get("open_browser") if isinstance(data, dict) else None
        return enabled if isinstance(enabled, bool) else True
    except (OSError, ValueError):
        return True


class Desktop:
    """Own only the server started here; never stop an existing instance."""

    def __init__(self, root, port=8912, open_browser=None):
        import tkinter as tk
        from tkinter import ttk

        self.root, self.port = root, port
        self.server = self.worker = None
        self.url = f"http://127.0.0.1:{port}"
        self.ready = False
        self.preferences_path = app.Studio.default_home() / "launcher.json"
        self.auto_open = tk.BooleanVar(master=root, value=automatic_browser(self.preferences_path))
        root.title(f"Tagcast {__version__}")
        root.resizable(False, False)
        frame = ttk.Frame(root, padding=24)
        frame.pack(fill="both", expand=True)
        title = ttk.Label(frame, text="Tagcast", font=("TkDefaultFont", 22, "bold"))
        title.pack(anchor="w")
        ttk.Label(frame, text=f"For iBroadcast · {__version__}").pack(anchor="w", pady=(0, 16))
        self.status = tk.StringVar(value="Starting Tagcast…")
        ttk.Label(frame, textvariable=self.status, wraplength=370).pack(anchor="w")
        self.address = tk.StringVar(value=self.url)
        ttk.Label(frame, textvariable=self.address).pack(anchor="w", pady=(8, 16))
        self.open_button = ttk.Button(frame, text="Open Tagcast in browser", command=self.open)
        self.open_button.pack(fill="x")
        self.auto_open_button = ttk.Checkbutton(frame, text="Open browser automatically",
                                                variable=self.auto_open,
                                                command=self.save_browser_preference)
        self.auto_open_button.pack(anchor="w", pady=(8, 0))
        self.close_button = ttk.Button(frame, text="Stop Tagcast and close", command=self.close)
        self.close_button.pack(fill="x", pady=(8, 0))
        icon = app.STATIC / "tagcast-icon.png"
        if icon.is_file():
            self.icon = tk.PhotoImage(file=str(icon))
            root.iconphoto(True, self.icon)
            self.header_icon = self.icon.subsample(8)
            title.configure(image=self.header_icon, compound="left")
        root.protocol("WM_DELETE_WINDOW", self.close)
        if sys.platform == "darwin":
            root.createcommand("tk::mac::Quit", self.close)
        try:
            self.server = app.open_server(port)
        except OSError:
            self.close_button.configure(text="Close")
            if app._already_running(port):
                self.ready = True
                self.status.set("Tagcast is already running. Closing this window leaves that server running.")
            else:
                self.open_button.configure(state="disabled")
                self.status.set("This port is in use by another program. Start Tagcast with --port 8913, for example.")
        else:
            self.port = self.server.server_port
            self.url = f"http://127.0.0.1:{self.port}"
            self.address.set(self.url)
            self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
            self.worker.start()
            self.ready = True
            self.status.set("Tagcast runs locally. Keep this window open while using it in your browser.")
        if self.ready and (self.auto_open.get() if open_browser is None else open_browser):
            self.open()

    def save_browser_preference(self):
        """Remember the next launch without changing the running server's config."""
        temporary = None
        warning = " Could not remember the browser setting. Try again; your next start may open it."
        try:
            self.preferences_path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8",
                                             dir=self.preferences_path.parent,
                                             prefix="launcher-", suffix=".tmp", delete=False) as handle:
                temporary = handle.name
                json.dump({"open_browser": self.auto_open.get()}, handle)
            os.replace(temporary, self.preferences_path)
        except OSError:
            logging.exception("Could not save the launcher browser setting")
            self.status.set(self.status.get().removesuffix(warning) + warning)
        else:
            self.status.set(self.status.get().removesuffix(warning))
        finally:
            if temporary:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass
                except OSError:
                    logging.warning("Could not remove temporary launcher preferences")

    def open(self):
        if self.ready:
            webbrowser.open(self.url)

    def close(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.worker.join(timeout=5)
            self.server = None
        self.root.destroy()


def main(argv=None):
    parser = argparse.ArgumentParser(prog="Tagcast", description="Tagcast desktop launcher")
    parser.add_argument("--version", action="version", version=f"Tagcast {__version__}")
    parser.add_argument("--port", type=int, default=int(os.environ.get("TAGCAST_PORT", 8912)))
    args = parser.parse_args(argv)
    import tkinter as tk
    from tkinter import messagebox

    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    root = tk.Tk()
    try:
        Desktop(root, args.port)
    except Exception:
        logging.exception("Could not start the desktop launcher")
        messagebox.showerror("Tagcast", "Tagcast could not start. See tagcast.log in your settings folder.", parent=root)
        root.destroy()
        return 1
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
