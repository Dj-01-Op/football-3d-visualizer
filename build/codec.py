"""Binary codec for the football tracking dataset.

Encodes the per-person-per-frame Parquet table into a compact, quantized
little-endian payload that the browser viewer decodes (see viewer/core.js).

Layout (all little-endian):
  0  header        "FB3D", u16 version, u32 F, u16 K, u32 R, u8 M
  1  entity table  K x (u8 team, u8 pad, i16 jersey)       index = position
  2  frame_number  i32[F]
  3  possession    i8[F]   (-128 = null)
  4  status        i8[F]   (-128 = null)
  5  ball_missing  u8[F]   (1 = Null_Ball_Frame, authoritative)
  6  ball xyz      i16[3][F] channel-major, wrapping delta over frames, 0 when missing
  7  presence      u8[F][M] bit k of frame f = entity k present
  8  joints        for each entity k (index order): i16[63][R_k] channel-major,
                   rows = frames where k is present (frame order), wrapping delta
                   per channel, reset at the start of each entity run.
Positions are centimeters (int16). -32768 marks a missing joint coordinate.
"""
from __future__ import annotations

import base64
import struct
import zlib
from dataclasses import dataclass

import numpy as np

MAGIC = b"FB3D"
VERSION = 1
SENTINEL = -32768
NULL8 = -128
HEADER = struct.Struct("<4sHIHIB")
ENTITY = struct.Struct("<BBh")

TEAM_CODE = {"Home": 0, "Away": 1, "Referees": 2}
TEAM_NAME = {v: k for k, v in TEAM_CODE.items()}

# 21 joints in dataset column order (63 coordinate columns).
JOINTS = [
    "neck", "pelvis",
    "r_shoulder", "r_elbow", "r_wrist",
    "l_shoulder", "l_elbow", "l_wrist",
    "r_hip", "r_knee", "r_ankle", "r_heel", "r_toe",
    "l_hip", "l_knee", "l_ankle", "l_heel", "l_toe",
    "r_ear", "l_ear", "nose",
]
JOINT_COLUMNS = [f"{j}_{a}" for j in JOINTS for a in "xyz"]
NCH = len(JOINT_COLUMNS)  # 63
BALL_COLUMNS = ["ball_x", "ball_y", "ball_z"]
REQUIRED_COLUMNS = (
    ["frame_number", "team_id", "jersey_number"]
    + JOINT_COLUMNS + BALL_COLUMNS + ["ball_possession", "ball_status"]
)


class CodecError(Exception):
    """Raised for encoding or verification failures. Messages never contain URLs."""


# --------------------------------------------------------------------------- quantization
def quantize(values) -> np.ndarray:
    """Meters -> int16 centimeters, round half away from zero, NaN -> SENTINEL."""
    v = np.asarray(values, dtype=np.float32).astype(np.float64)
    nan = np.isnan(v)
    x = np.where(nan, 0.0, v) * 100.0
    q = np.sign(x) * np.floor(np.abs(x) + 0.5)
    if np.any(np.abs(q[~nan]) > 32767):
        raise CodecError("position outside int16 centimeter range")
    out = q.astype(np.int16)
    out[nan] = SENTINEL
    return out


def dequantize(q) -> np.ndarray:
    """int16 centimeters -> float64 meters, SENTINEL -> NaN."""
    q = np.asarray(q, dtype=np.int16)
    out = q.astype(np.float64) / 100.0
    out[q == SENTINEL] = np.nan
    return out


# --------------------------------------------------------------------------- deltas
def delta_encode(a: np.ndarray, axis: int = -1) -> np.ndarray:
    a = np.asarray(a, dtype=np.int16)
    d = a.copy()
    if a.shape[axis] > 1:
        sl_hi = [slice(None)] * a.ndim
        sl_lo = [slice(None)] * a.ndim
        sl_hi[axis] = slice(1, None)
        sl_lo[axis] = slice(None, -1)
        with np.errstate(over="ignore"):
            d[tuple(sl_hi)] = a[tuple(sl_hi)] - a[tuple(sl_lo)]  # wraps mod 2^16
    return d


def delta_decode(d: np.ndarray, axis: int = -1) -> np.ndarray:
    return np.cumsum(np.asarray(d, dtype=np.int16), axis=axis, dtype=np.int16)


# --------------------------------------------------------------------------- masks
def encode_mask(present_indices, k: int) -> bytes:
    m = (k + 7) // 8
    out = bytearray(m)
    for idx in present_indices:
        if not 0 <= idx < k:
            raise CodecError(f"entity index {idx} outside 0..{k - 1}")
        out[idx >> 3] |= 1 << (idx & 7)
    return bytes(out)


def decode_mask(mask: bytes, k: int) -> set[int]:
    return {i for i in range(k) if mask[i >> 3] >> (i & 7) & 1}


# --------------------------------------------------------------------------- entities
def team_code(team) -> int:
    t = str(team)
    if t not in TEAM_CODE:
        raise CodecError(f"unknown team_id value {t!r}")
    return TEAM_CODE[t]


def build_entity_index(df) -> list[tuple[int, int]]:
    """Sorted unique (team_code, jersey) pairs; position in the list is the index."""
    teams = [team_code(t) for t in df["team_id"].astype(str)]
    jerseys = df["jersey_number"].astype(np.int64).tolist()
    return sorted(set(zip(teams, jerseys)))


# --------------------------------------------------------------------------- source view
@dataclass
class Dense:
    """Dense, index-aligned view of a dataset (source or decoded)."""
    entities: list[tuple[int, int]]
    frame_number: np.ndarray        # int64[F]
    possession: list                # int or None, len F
    status: list                    # int or None, len F
    ball_missing: np.ndarray        # bool[F]
    ball: np.ndarray                # float64[F, 3] meters, NaN when missing
    present: np.ndarray             # bool[F, K]
    pos: np.ndarray                 # float64[F, K, 63] meters, NaN when absent/missing
    null_ball_rows: int = 0
    rows_per_frame: np.ndarray | None = None


def _nullable_int(v):
    if v is None:
        return None
    try:
        if np.isnan(v):
            return None
    except TypeError:
        pass
    return int(v)


def source_dense(df) -> Dense:
    """Build the dense source view and enforce per-frame ball consistency."""
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise CodecError("missing columns: " + ", ".join(missing))
    entities = build_entity_index(df)
    ent_idx = {e: i for i, e in enumerate(entities)}

    fn = df["frame_number"].to_numpy(dtype=np.int64)
    frames, first = np.unique(fn, return_index=True)
    frames = frames[np.argsort(first)]            # first-appearance order
    f_idx = {int(f): i for i, f in enumerate(frames)}
    F, K = len(frames), len(entities)

    rows_f = np.array([f_idx[int(f)] for f in fn], dtype=np.int64)
    rows_k = np.array(
        [ent_idx[(team_code(t), int(j))] for t, j in
         zip(df["team_id"].astype(str), df["jersey_number"].astype(np.int64))],
        dtype=np.int64,
    )
    present = np.zeros((F, K), dtype=bool)
    key = rows_f * max(K, 1) + rows_k
    if len(np.unique(key)) != len(key):
        raise CodecError("duplicate (frame_number, team_id, jersey_number) rows")
    present[rows_f, rows_k] = True

    pos = np.full((F, K, NCH), np.nan, dtype=np.float64)
    pos[rows_f, rows_k, :] = df[JOINT_COLUMNS].to_numpy(dtype=np.float32).astype(np.float64)

    ball_rows = df[BALL_COLUMNS].to_numpy(dtype=np.float32).astype(np.float64)
    poss_rows = df["ball_possession"].to_numpy(dtype=np.float64, na_value=np.nan)
    stat_rows = df["ball_status"].to_numpy(dtype=np.float64, na_value=np.nan)
    row_null = np.isnan(ball_rows).any(axis=1)

    ball = np.full((F, 3), np.nan)
    ball_missing = np.zeros(F, dtype=bool)
    possession: list = [None] * F
    status: list = [None] * F
    seen = np.zeros(F, dtype=bool)
    for r in range(len(df)):
        f = rows_f[r]
        b, p, s = ball_rows[r], poss_rows[r], stat_rows[r]
        if not seen[f]:
            seen[f] = True
            ball[f] = b
            ball_missing[f] = bool(row_null[r])
            possession[f] = _nullable_int(p)
            status[f] = _nullable_int(s)
            continue
        same_ball = np.array_equal(np.isnan(b), np.isnan(ball[f])) and np.allclose(
            np.nan_to_num(b), np.nan_to_num(ball[f]), atol=0, rtol=0)
        if not same_ball or _nullable_int(p) != possession[f] or _nullable_int(s) != status[f]:
            raise CodecError(f"ball values differ within frame {int(frames[f])}")
    ball[ball_missing] = np.nan
    return Dense(entities, frames, possession, status, ball_missing, ball, present, pos,
                 null_ball_rows=int(row_null.sum()),
                 rows_per_frame=np.bincount(rows_f, minlength=F))


# --------------------------------------------------------------------------- encode
def encode(df) -> bytes:
    src = source_dense(df)
    return encode_dense(src)


def _i8(v) -> int:
    if v is None:
        return NULL8
    if not -127 <= v <= 127:
        raise CodecError(f"int8 value out of range: {v}")
    return int(v)


def encode_dense(src: Dense) -> bytes:
    F, K = src.present.shape
    M = (K + 7) // 8
    R = int(src.present.sum())
    parts = [HEADER.pack(MAGIC, VERSION, F, K, R, M)]
    for team, jersey in src.entities:
        parts.append(ENTITY.pack(team, 0, jersey))
    parts.append(np.asarray(src.frame_number, dtype="<i4").tobytes())
    parts.append(np.array([_i8(v) for v in src.possession], dtype=np.int8).tobytes())
    parts.append(np.array([_i8(v) for v in src.status], dtype=np.int8).tobytes())
    parts.append(src.ball_missing.astype(np.uint8).tobytes())

    ballq = quantize(np.where(np.isnan(src.ball), 0.0, src.ball)).reshape(F, 3)
    ballq[src.ball_missing] = 0
    parts.append(delta_encode(ballq.T.copy(), axis=1).astype("<i2").tobytes())

    for f in range(F):
        parts.append(encode_mask(np.flatnonzero(src.present[f]).tolist(), K))

    for k in range(K):
        rows = np.flatnonzero(src.present[:, k])
        if len(rows) == 0:
            continue
        block = quantize(src.pos[rows, k, :]).T.copy()   # (63, R_k)
        parts.append(delta_encode(block, axis=1).astype("<i2").tobytes())
    return b"".join(parts)


# --------------------------------------------------------------------------- decode
def decode(buf: bytes) -> Dense:
    mv = memoryview(buf)
    if len(buf) < HEADER.size:
        raise CodecError("payload too short")
    magic, version, F, K, R, M = HEADER.unpack_from(mv, 0)
    if magic != MAGIC or version != VERSION:
        raise CodecError("bad payload header")
    off = HEADER.size
    entities = []
    for _ in range(K):
        team, _pad, jersey = ENTITY.unpack_from(mv, off)
        entities.append((team, jersey))
        off += ENTITY.size

    def take(dtype, n):
        nonlocal off
        size = np.dtype(dtype).itemsize * n
        if off + size > len(buf):
            raise CodecError("payload truncated")
        a = np.frombuffer(buf, dtype=dtype, count=n, offset=off).copy()
        off += size
        return a

    frame_number = take("<i4", F).astype(np.int64)
    poss = take(np.int8, F)
    stat = take(np.int8, F)
    ball_missing = take(np.uint8, F).astype(bool)
    ballq = delta_decode(take("<i2", 3 * F).reshape(3, F), axis=1).T
    ball = dequantize(ballq)
    ball[ball_missing] = np.nan
    masks = take(np.uint8, F * M).reshape(F, M)
    present = np.zeros((F, K), dtype=bool)
    for k in range(K):
        present[:, k] = (masks[:, k >> 3] >> (k & 7)) & 1 == 1
    if int(present.sum()) != R:
        raise CodecError("presence mask does not match row count")
    pos = np.full((F, K, NCH), np.nan)
    for k in range(K):
        rows = np.flatnonzero(present[:, k])
        if len(rows) == 0:
            continue
        block = delta_decode(take("<i2", NCH * len(rows)).reshape(NCH, len(rows)), axis=1)
        pos[rows, k, :] = dequantize(block.T)
    if off != len(buf):
        raise CodecError("trailing bytes in payload")
    to_opt = lambda a: [None if v == NULL8 else int(v) for v in a]  # noqa: E731
    return Dense(entities, frame_number, to_opt(poss), to_opt(stat), ball_missing, ball,
                 present, pos, rows_per_frame=present.sum(axis=1))


# --------------------------------------------------------------------------- compression
def deflate_raw(data: bytes) -> bytes:
    c = zlib.compressobj(9, zlib.DEFLATED, -15, 9)
    return c.compress(data) + c.flush()


def inflate_raw(data: bytes) -> bytes:
    return zlib.decompress(data, -15)


def to_blob(payload: bytes) -> str:
    return base64.b64encode(deflate_raw(payload)).decode("ascii")


def from_blob(b64: str) -> Dense:
    return decode(inflate_raw(base64.b64decode(b64)))


# --------------------------------------------------------------------------- verification
def _tolerance(v: np.ndarray) -> np.ndarray:
    # 0.005 m quantization bound plus float32 representation error of the source value.
    return 0.005 + 4 * np.spacing(np.abs(v).astype(np.float32)).astype(np.float64) + 1e-12


def verify(src: Dense, dec: Dense, expected_null_rows: int | None = None) -> dict:
    """Compare decoded data with the source. Raise CodecError listing failing checks."""
    failures: list[str] = []

    def report(name, bad_idx, expected, actual):
        bad_idx = list(bad_idx)
        if bad_idx:
            sample = ", ".join(
                f"frame {i}: expected {expected(i)}, actual {actual(i)}" for i in bad_idx[:10])
            failures.append(f"{name} failed for {len(bad_idx)} frame(s); first: {sample}")

    F = len(src.frame_number)
    if len(dec.frame_number) != F:
        raise CodecError(f"frame count check failed: expected {F}, actual {len(dec.frame_number)}")
    if dec.entities != src.entities:
        failures.append("entity table check failed")

    report("frame_number check", np.flatnonzero(dec.frame_number != src.frame_number),
           lambda i: src.frame_number[i], lambda i: dec.frame_number[i])
    report("possession check", [i for i in range(F) if src.possession[i] != dec.possession[i]],
           lambda i: src.possession[i], lambda i: dec.possession[i])
    report("ball_status check", [i for i in range(F) if src.status[i] != dec.status[i]],
           lambda i: src.status[i], lambda i: dec.status[i])

    src_counts = src.present.sum(axis=1)
    dec_counts = dec.present.sum(axis=1)
    report("per-frame Person count check", np.flatnonzero(src_counts != dec_counts),
           lambda i: int(src_counts[i]), lambda i: int(dec_counts[i]))
    report("Person set check", np.flatnonzero((src.present != dec.present).any(axis=1)),
           lambda i: sorted(np.flatnonzero(src.present[i]).tolist()),
           lambda i: sorted(np.flatnonzero(dec.present[i]).tolist()))

    report("ball_missing check", np.flatnonzero(src.ball_missing != dec.ball_missing),
           lambda i: bool(src.ball_missing[i]), lambda i: bool(dec.ball_missing[i]))
    src_nb, dec_nb = int(src.ball_missing.sum()), int(dec.ball_missing.sum())
    if src_nb != dec_nb:
        failures.append(f"Null_Ball_Frame count check failed: expected {src_nb}, actual {dec_nb}")
    if expected_null_rows is not None and src.null_ball_rows != expected_null_rows:
        failures.append(
            f"null-ball row check failed: expected {expected_null_rows}, actual {src.null_ball_rows}")

    both = ~src.ball_missing & ~dec.ball_missing
    berr = np.abs(src.ball - dec.ball) > _tolerance(src.ball)
    report("ball position check", np.flatnonzero((berr & both[:, None]).any(axis=1)),
           lambda i: src.ball[i].tolist(), lambda i: dec.ball[i].tolist())

    mask = src.present & dec.present
    s, d = src.pos[mask], dec.pos[mask]
    nan_mismatch = np.isnan(s) != np.isnan(d)
    with np.errstate(invalid="ignore"):
        err = (np.abs(s - d) > _tolerance(np.nan_to_num(s))) & ~np.isnan(s) & ~np.isnan(d)
    bad_rows = (nan_mismatch | err).any(axis=1)
    if bad_rows.any():
        frames_of_rows = np.nonzero(mask)[0][bad_rows]
        report("joint position check", np.unique(frames_of_rows),
               lambda i: "error <= 0.005 m", lambda i: "larger error or missing mismatch")
    max_err = float(np.nanmax(np.abs(s - d))) if s.size and not np.all(np.isnan(s)) else 0.0

    if failures:
        raise CodecError("verification failed:\n  " + "\n  ".join(failures))
    return {"frames": F, "null_ball_frames": src_nb, "null_ball_rows": src.null_ball_rows,
            "persons": int(src.present.sum()), "entities": len(src.entities),
            "max_position_error_m": max_err}
