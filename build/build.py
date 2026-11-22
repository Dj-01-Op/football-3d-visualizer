"""Build the offline football 3D visualizer.

Usage:
    .venv/bin/python build/build.py --stub data.parquest --out dist/football-3d.html

Steps: extract the pre-signed URL from the stub (never printed), download
data.parquet to a temp dir, verify PAR1, encode + compress + verify, then
inline three.js, viewer code and the data blob into one HTML file.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import mimetypes
import os
import re
import shutil
import socket
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import codec  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
THREE_VERSION = "0.160.1"
THREE_PATH = ROOT / "vendor" / f"three-{THREE_VERSION}.cjs"
THREE_SHA_PATH = ROOT / "vendor" / f"three-{THREE_VERSION}.cjs.sha256"
TEMPLATE_PATH = ROOT / "viewer" / "template.html"
CORE_PATH = ROOT / "viewer" / "core.js"
APP_PATH = ROOT / "viewer" / "app.js"
ROSTER_PATH = ROOT / "viewer" / "roster.json"
MAX_HTML_BYTES = 26_214_400
EXPECTED_ROWS = 74_610
EXPECTED_FRAMES = 3_000
EXPECTED_NULL_BALL_ROWS = 234
DOWNLOAD_TIMEOUT_S = 60
URL_RE = re.compile(r"url='([^']*)'")


class BuildError(Exception):
    """Fatal build error. Messages must never contain the URL or stub contents."""


def fail(msg: str) -> None:
    raise BuildError(msg)


# --------------------------------------------------------------------------- stub + download
def extract_url(stub_text: str) -> str:
    matches = URL_RE.findall(stub_text)
    if len(matches) != 1:
        fail("Stub_File invalid: expected exactly one redirect URL")
    url = html.unescape(matches[0]).strip()
    if not url.startswith("https://"):
        fail("Stub_File invalid: redirect URL is not https")
    return url


def read_stub(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        fail("Stub_File invalid: missing or unreadable")
    return ""  # unreachable


def is_parquet(head: bytes) -> bool:
    return head[:4] == b"PAR1"


def download(url: str, dest: Path, timeout: float = DOWNLOAD_TIMEOUT_S) -> None:
    deadline = time.monotonic() + timeout
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp, open(dest, "wb") as out:
            while True:
                if time.monotonic() > deadline:
                    fail("download failed: timeout")
                chunk = resp.read(1 << 16)
                if not chunk:
                    break
                out.write(chunk)
    except BuildError:
        raise
    except urllib.error.HTTPError as e:
        fail(f"download failed: HTTP {e.code}" + (" (link may have expired)" if e.code in (400, 403) else ""))
    except (socket.timeout, TimeoutError):
        fail("download failed: timeout")
    except urllib.error.URLError as e:
        fail("download failed: timeout" if isinstance(e.reason, (socket.timeout, TimeoutError))
             else "download failed: network error")
    except OSError:
        fail("download failed: network error")


# --------------------------------------------------------------------------- data
def load_dataframe(path: Path):
    import pyarrow.parquet as pq
    try:
        table = pq.read_table(path, columns=codec.REQUIRED_COLUMNS)
    except Exception as e:  # noqa: BLE001 - report type only
        fail(f"could not read parquet: {type(e).__name__}")
    df = table.to_pandas()
    df["team_id"] = df["team_id"].astype(str)
    return df


def check_counts(df) -> None:
    rows, frames = len(df), df["frame_number"].nunique()
    if rows != EXPECTED_ROWS:
        print(f"WARNING: expected {EXPECTED_ROWS} rows, actual {rows}", file=sys.stderr)
    if frames != EXPECTED_FRAMES:
        print(f"WARNING: expected {EXPECTED_FRAMES} unique frames, actual {frames}", file=sys.stderr)


# --------------------------------------------------------------------------- html
def read_input(path: Path, name: str) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        fail(f"missing input: {name} ({path.relative_to(ROOT) if path.is_relative_to(ROOT) else path})")
    return ""


def load_three() -> str:
    src = read_input(THREE_PATH, "three.js build")
    expected = read_input(THREE_SHA_PATH, "three.js checksum").split()[0]
    actual = hashlib.sha256(src.encode("utf-8")).hexdigest()
    if actual != expected:
        fail("three.js checksum mismatch")
    return src


def load_roster() -> str:
    """Load editable roster metadata and inline local portraits as data URIs."""
    raw = read_input(ROSTER_PATH, "player roster")
    try:
        roster = json.loads(raw)
    except json.JSONDecodeError:
        fail("player roster is invalid JSON")
    if not isinstance(roster, dict):
        fail("player roster must be a JSON object")
    clean = {}
    for key, value in roster.items():
        if not isinstance(key, str) or not isinstance(value, dict):
            fail("player roster entries must be objects")
        name = str(value.get("name") or "").strip()
        image = str(value.get("image") or "").strip()
        if image and not image.startswith("data:image/"):
            if image.startswith(("http://", "https://")):
                fail(f"roster portrait for {key} must be a local file")
            image_path = (ROSTER_PATH.parent / image).resolve()
            try:
                image_bytes = image_path.read_bytes()
            except OSError:
                fail(f"missing roster portrait for {key}")
            mime = mimetypes.guess_type(image_path.name)[0]
            if not mime or not mime.startswith("image/"):
                fail(f"unsupported roster portrait type for {key}")
            image = f"data:{mime};base64," + base64.b64encode(image_bytes).decode("ascii")
        entry = {"name": name, "image": image}
        for field in ("credit", "license", "source"):
            entry[field] = str(value.get(field) or "").strip()
        clean[key] = entry
    # Escaping '<' prevents names from closing the application/json script element.
    return json.dumps(clean, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")


def safe_script(js: str) -> str:
    # Prevent an inline script from terminating its own <script> element.
    return re.sub(r"</(script)", r"<\\/\1", js, flags=re.IGNORECASE)


def render_html(template: str, three_js: str, core_js: str, app_js: str, blob_b64: str, roster_json: str) -> str:
    values = {
        "THREE_VERSION": THREE_VERSION,
        "THREE_JS": safe_script(three_js),
        "CORE_JS": safe_script(core_js),
        "APP_JS": safe_script(app_js),
        "BLOB_B64": blob_b64,
        "ROSTER_JSON": roster_json,
    }
    seen = set()

    def sub(m):
        seen.add(m.group(1))
        return values[m.group(1)]

    out = re.sub(r"\{\{(THREE_VERSION|THREE_JS|CORE_JS|APP_JS|BLOB_B64|ROSTER_JSON)\}\}", sub, template)
    missing = set(values) - seen
    if missing:
        fail("template is missing placeholders: " + ", ".join(sorted(missing)))
    return out


def write_atomic(out_path: Path, content: str) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    data = content.encode("utf-8")
    fd, tmp = tempfile.mkstemp(prefix=".football-3d-", suffix=".tmp", dir=out_path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, out_path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return len(data)


# --------------------------------------------------------------------------- pipeline
def build_from_dataframe(df, out_path: Path, expected_null_rows: int | None) -> dict:
    # Read every static input before doing expensive work so missing files abort early.
    template = read_input(TEMPLATE_PATH, "HTML template")
    core_js = read_input(CORE_PATH, "viewer core.js")
    app_js = read_input(APP_PATH, "viewer app.js")
    three_js = load_three()
    roster_json = load_roster()

    try:
        src = codec.source_dense(df)
        payload = codec.encode_dense(src)
        blob = codec.to_blob(payload)
        stats = codec.verify(src, codec.from_blob(blob), expected_null_rows=expected_null_rows)
    except codec.CodecError as e:
        fail(str(e))

    page = render_html(template, three_js, core_js, app_js, blob, roster_json)
    size = len(page.encode("utf-8"))
    if size > MAX_HTML_BYTES:
        fail(f"output HTML is {size} bytes, above the {MAX_HTML_BYTES} byte limit")
    if out_path.exists():
        out_path.unlink()  # never leave a stale file that looks like this run's output
    size = write_atomic(out_path, page)
    stats.update(blob_bytes=len(blob), html_bytes=size, payload_bytes=len(payload))
    return stats


def run(stub: Path, out: Path, expected_null_rows: int | None = EXPECTED_NULL_BALL_ROWS) -> dict:
    url = extract_url(read_stub(stub))
    tmp_dir = Path(tempfile.mkdtemp(prefix="fb3d-"))
    try:
        parquet = tmp_dir / "data.parquet"
        download(url, parquet)
        del url
        with open(parquet, "rb") as f:
            if not is_parquet(f.read(4)):
                fail("downloaded file is not a Parquet file (missing PAR1 magic bytes)")
        df = load_dataframe(parquet)
        check_counts(df)
        return build_from_dataframe(df, out, expected_null_rows)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def print_summary(stats: dict, out: Path) -> None:
    print(f"Embedded_Blob size: {stats['blob_bytes']} bytes")
    print(f"Output HTML size:   {stats['html_bytes']} bytes -> {out}")
    print(f"Frames: {stats['frames']}  Persons (rows): {stats['persons']}  Entity_Keys: {stats['entities']}")
    print(f"Max position error: {stats['max_position_error_m']:.6f} m")
    print(f"Verified: {stats['frames']} frames, {stats['null_ball_frames']} Null_Ball_Frames "
          f"({stats['null_ball_rows']} null-ball rows)")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--stub", type=Path, default=ROOT / "data.parquest")
    ap.add_argument("--out", type=Path, default=ROOT / "dist" / "football-3d.html")
    args = ap.parse_args(argv)
    try:
        stats = run(args.stub, args.out)
    except BuildError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    except Exception as e:  # noqa: BLE001 - never echo messages that might hold the URL
        print(f"ERROR: unexpected {type(e).__name__}", file=sys.stderr)
        return 1
    print_summary(stats, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
