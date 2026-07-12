import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse, urlunparse
from typing import Dict, List, Optional

from argon2 import PasswordHasher
import httpx
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles
from jose import JWTError, jwt
from pydantic import BaseModel, Field


router = APIRouter(tags=["Wildlife Protection"])
app = FastAPI(title="Zero-Trust Multi-Role Wildlife Protection Core")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SECRET_KEY = "TACTICAL_WILDLIFE_DEFENSE_SECRET_KEY_SECURE"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60

ph = PasswordHasher()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

BASE_DIR = Path(__file__).parent
DB_PATH = BASE_DIR / "wildlife.db"
RATE_LIMIT_TRACKER: Dict[str, List[datetime]] = {}


@contextmanager
def db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_db_datetime(value: str) -> datetime:
    return datetime.fromisoformat(value)


def init_db():
    with db_connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS invite_tokens (
                token_string TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                expires_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                username TEXT NOT NULL,
                action TEXT NOT NULL,
                resource TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS alerts (
                alert_id INTEGER PRIMARY KEY AUTOINCREMENT,
                sensor_id INTEGER NOT NULL,
                detected_type TEXT NOT NULL,
                detected_name TEXT NOT NULL,
                confidence REAL NOT NULL,
                alert_level TEXT NOT NULL,
                detected_time TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS devices (
                device_id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_type TEXT NOT NULL,
                name TEXT NOT NULL,
                location TEXT NOT NULL,
                endpoint TEXT,
                latitude REAL,
                longitude REAL,
                status TEXT NOT NULL DEFAULT 'ACTIVE',
                registered_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ai_events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                signature TEXT NOT NULL UNIQUE,
                device_id INTEGER,
                device_type TEXT NOT NULL,
                object_name TEXT NOT NULL,
                event_type TEXT NOT NULL,
                confidence REAL NOT NULL,
                alert_level TEXT NOT NULL,
                reason TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )
        existing_admin = conn.execute(
            "SELECT id FROM users WHERE username = ?",
            ("PREM_COMMAND",),
        ).fetchone()
        if not existing_admin:
            conn.execute(
                "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
                ("PREM_COMMAND", ph.hash("admin123"), "INTERCEPTOR"),
            )


def get_user(username: str) -> Optional[sqlite3.Row]:
    with db_connection() as conn:
        return conn.execute(
            "SELECT id, username, password_hash, role FROM users WHERE username = ?",
            (username,),
        ).fetchone()


def add_audit_log(username: str, action: str, resource: str):
    with db_connection() as conn:
        conn.execute(
            "INSERT INTO audit_logs (timestamp, username, action, resource) VALUES (?, ?, ?, ?)",
            (utc_now().isoformat(), username, action, resource),
        )


init_db()


class UserCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=6)
    role: str = Field(..., description="Must be exactly: PUBLIC, POST_GUARD, or INTERCEPTOR")
    invite_token: Optional[str] = None


class UserResponse(BaseModel):
    id: int
    username: str
    role: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str
    role: str


class InviteTokenCreate(BaseModel):
    role: str
    expires_in_hours: int = 24


class InviteTokenResponse(BaseModel):
    token_string: str
    role: str
    expires_at: datetime


class SecurityService:
    @staticmethod
    def verify_password(plain_password: str, hashed_password: str) -> bool:
        try:
            return ph.verify(hashed_password, plain_password)
        except Exception:
            return False

    @staticmethod
    def hash_password(password: str) -> str:
        return ph.hash(password)

    @staticmethod
    def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
        to_encode = data.copy()
        expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
        to_encode.update({"exp": expire})
        return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

    @staticmethod
    def verify_token(token: str) -> dict:
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            username: str = payload.get("sub")
            role: str = payload.get("role")
            if username is None or role is None:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid session parameters.")
            return {"username": username, "role": role}
        except JWTError:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid/expired token session.")


class RateLimiter:
    @staticmethod
    def check_rate_limit(identity: str, max_requests: int = 5, window_seconds: int = 60):
        now = datetime.now(timezone.utc)
        if identity not in RATE_LIMIT_TRACKER:
            RATE_LIMIT_TRACKER[identity] = []
        valid_timestamps = [ts for ts in RATE_LIMIT_TRACKER[identity] if now - ts < timedelta(seconds=window_seconds)]
        RATE_LIMIT_TRACKER[identity] = valid_timestamps
        if len(valid_timestamps) >= max_requests:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Rate limit exceeded.")
        RATE_LIMIT_TRACKER[identity].append(now)


class SecurityGuard:
    def __init__(self, allowed_roles: List[str]):
        self.allowed_roles = allowed_roles

    def __call__(self, token: str = Depends(oauth2_scheme)) -> dict:
        payload = SecurityService.verify_token(token)
        if payload["role"] not in self.allowed_roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied: missing clearance.")
        return payload


@router.post("/auth/register", response_model=UserResponse)
def register_user(user: UserCreate):
    if get_user(user.username):
        raise HTTPException(status_code=400, detail="Identity mapping already exists.")
    normalized_role = user.role.upper()
    if normalized_role not in ["PUBLIC", "POST_GUARD", "INTERCEPTOR"]:
        raise HTTPException(status_code=400, detail="Invalid role.")
    if normalized_role in ["POST_GUARD", "INTERCEPTOR"]:
        if not user.invite_token:
            raise HTTPException(status_code=403, detail="Invalid/missing registration invite token.")
        with db_connection() as conn:
            token_cfg = conn.execute(
                "SELECT token_string, role, expires_at FROM invite_tokens WHERE token_string = ?",
                (user.invite_token,),
            ).fetchone()
            if not token_cfg:
                raise HTTPException(status_code=403, detail="Invalid/missing registration invite token.")
            if parse_db_datetime(token_cfg["expires_at"]) < utc_now():
                conn.execute("DELETE FROM invite_tokens WHERE token_string = ?", (user.invite_token,))
                raise HTTPException(status_code=403, detail="Registration invite token expired.")
            if token_cfg["role"] != normalized_role:
                raise HTTPException(status_code=403, detail="Invite token is not valid for that role.")
            conn.execute("DELETE FROM invite_tokens WHERE token_string = ?", (user.invite_token,))
    with db_connection() as conn:
        cursor = conn.execute(
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
            (user.username, SecurityService.hash_password(user.password), normalized_role),
        )
        new_id = cursor.lastrowid
    return UserResponse(id=new_id, username=user.username, role=normalized_role)


@router.post("/auth/login", response_model=TokenResponse)
def login(form_data: OAuth2PasswordRequestForm = Depends()):
    RateLimiter.check_rate_limit(identity=form_data.username)
    user = get_user(form_data.username)
    if not user or not SecurityService.verify_password(form_data.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials.")
    access_token = SecurityService.create_access_token(data={"sub": user["username"], "role": user["role"]})
    add_audit_log(user["username"], "LOGIN_SUCCESS", f"Role: {user['role']}")
    return {"access_token": access_token, "token_type": "bearer", "role": user["role"]}


@router.post("/api/v1/security/generate-invite", response_model=InviteTokenResponse)
def generate_invite_token(invite_cfg: InviteTokenCreate, current_user: dict = Depends(SecurityGuard(["INTERCEPTOR"]))):
    normalized_role = invite_cfg.role.upper()
    if normalized_role not in ["POST_GUARD", "INTERCEPTOR"]:
        raise HTTPException(status_code=400, detail="Invite role must be POST_GUARD or INTERCEPTOR.")
    token_str = f"WILD-INVITE-{secrets.token_hex(6).upper()}"
    expires_at = utc_now() + timedelta(hours=invite_cfg.expires_in_hours)
    with db_connection() as conn:
        conn.execute(
            "INSERT INTO invite_tokens (token_string, role, expires_at) VALUES (?, ?, ?)",
            (token_str, normalized_role, expires_at.isoformat()),
        )
    return InviteTokenResponse(token_string=token_str, role=normalized_role, expires_at=expires_at)


@router.get("/api/v1/security/logs")
def get_security_audit_logs(current_user: dict = Depends(SecurityGuard(["INTERCEPTOR"]))):
    with db_connection() as conn:
        logs = conn.execute(
            "SELECT timestamp, username, action, resource FROM audit_logs ORDER BY id DESC LIMIT 100"
        ).fetchall()
    return [dict(log) for log in logs]


MOCK_ANIMALS_DB = [
    {"animal_id": 1, "common_name": "Indian Rhinoceros", "scientific_name": "Rhinoceros unicornis", "category": "Mammal", "estimated_population": 2613, "latitude": 27.1751, "longitude": 85.0123},
    {"animal_id": 2, "common_name": "Bengal Tiger", "scientific_name": "Panthera tigris tigris", "category": "Mammal", "estimated_population": 121, "latitude": 26.1584, "longitude": 84.2415},
    {"animal_id": 3, "common_name": "Asian Elephant", "scientific_name": "Elephas maximus", "category": "Mammal", "estimated_population": 1900, "latitude": 28.6139, "longitude": 85.3214},
    {"animal_id": 4, "common_name": "Wild Water Buffalo", "scientific_name": "Bubalus arnee", "category": "Mammal", "estimated_population": 1700, "latitude": 27.5210, "longitude": 84.8512},
    {"animal_id": 5, "common_name": "Eastern Swamp Deer", "scientific_name": "Rucervus duvaucelii ranjitsinhi", "category": "Mammal", "estimated_population": 1100, "latitude": 26.9124, "longitude": 83.9456},
    {"animal_id": 10, "common_name": "Leopard", "scientific_name": "Panthera pardus", "category": "Mammal", "estimated_population": 45, "latitude": 28.1045, "longitude": 85.7123},
]

MOCK_ANIMAL_SOUNDS = [
    {"sound_id": 1, "animal_name": "Indian Rhinoceros", "sound_type": "Snort", "frequency_range": "150-800 Hz", "active_time": "Day"},
    {"sound_id": 2, "animal_name": "Bengal Tiger", "sound_type": "Roar", "frequency_range": "20-500 Hz", "active_time": "Night"},
    {"sound_id": 3, "animal_name": "Asian Elephant", "sound_type": "Trumpet", "frequency_range": "14-300 Hz", "active_time": "Day/Night"},
    {"sound_id": 10, "animal_name": "Leopard", "sound_type": "Growl", "frequency_range": "100-600 Hz", "active_time": "Night"},
]

MOCK_SUSPICIOUS_SOUNDS = [
    {"sound_id": 1, "sound_name": "Gunshot", "category": "Weapon", "threat_level": "High"},
    {"sound_id": 2, "sound_name": "Chainsaw", "category": "Logging", "threat_level": "High"},
    {"sound_id": 3, "sound_name": "Vehicle Engine", "category": "Vehicle", "threat_level": "Medium"},
    {"sound_id": 4, "sound_name": "Human Shouting", "category": "Human Activity", "threat_level": "Medium"},
]

MOCK_SENSORS_DB = [
    {"sensor_id": 101, "sensor_type": "Acoustic Node", "location": "Sector Alpha", "latitude": 27.1750, "longitude": 85.0120, "status": "ACTIVE"},
    {"sensor_id": 102, "sensor_type": "Thermal Camera", "location": "Sector Echo", "latitude": 26.1580, "longitude": 84.2410, "status": "ACTIVE"},
]


class WildlifeTelemetryOut(BaseModel):
    animal_id: int
    common_name: str
    scientific_name: Optional[str]
    category: str
    latitude: float
    longitude: float
    data_integrity: str


class AlertReportInput(BaseModel):
    sensor_id: int
    detected_type: str
    detected_name: str
    confidence: float = Field(..., ge=0, le=1)
    alert_level: str


class DeviceCreate(BaseModel):
    device_type: str = Field(..., description="CAMERA, SENSOR, or MICROPHONE")
    name: str = Field(..., min_length=2, max_length=80)
    location: str = Field(..., min_length=2, max_length=120)
    endpoint: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    status: str = "ACTIVE"


class ObjectSearchInput(BaseModel):
    query: str = Field(..., min_length=1, max_length=80)


AI_OBJECT_PATTERNS = [
    {
        "object_name": "Weapon",
        "aliases": ["weapon", "gun", "glock", "rifle", "pistol", "firearm"],
        "event_type": "Weapon",
        "alert_level": "High",
        "confidence": 0.94,
    },
    {
        "object_name": "Chainsaw",
        "aliases": ["chainsaw", "saw", "logging", "woodcutting"],
        "event_type": "Logging",
        "alert_level": "High",
        "confidence": 0.91,
    },
    {
        "object_name": "Human Activity",
        "aliases": ["human", "person", "people", "intruder", "shouting", "voice"],
        "event_type": "Human Activity",
        "alert_level": "Medium",
        "confidence": 0.87,
    },
    {
        "object_name": "Vehicle",
        "aliases": ["vehicle", "truck", "bike", "jeep", "engine"],
        "event_type": "Vehicle",
        "alert_level": "Medium",
        "confidence": 0.84,
    },
    {
        "object_name": "Fire",
        "aliases": ["fire", "smoke", "flame", "heat"],
        "event_type": "Environmental Threat",
        "alert_level": "High",
        "confidence": 0.89,
    },
    {
        "object_name": "Animal Distress",
        "aliases": ["distress", "panic", "stampede", "injured"],
        "event_type": "Biological Signal",
        "alert_level": "Medium",
        "confidence": 0.82,
    },
]


def get_registered_device(device_id: int) -> Optional[sqlite3.Row]:
    with db_connection() as conn:
        return conn.execute(
            """
            SELECT device_id, device_type, name, location, endpoint, latitude, longitude, status, registered_at
            FROM devices
            WHERE device_id = ?
            """,
            (device_id,),
        ).fetchone()


def require_stream_token(token: str) -> dict:
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing stream token.")
    return SecurityService.verify_token(token)


def normalize_camera_endpoint(endpoint: str) -> str:
    cleaned = endpoint.strip().split()[0]
    if cleaned.startswith(("http://", "https://", "rtsp://")):
        return cleaned
    if cleaned.count(":") > 1 and not cleaned.startswith("["):
        return f"http://[{cleaned}]"
    return f"http://{cleaned}"


def camera_stream_candidates(endpoint: str) -> List[str]:
    base = normalize_camera_endpoint(endpoint)
    parsed = urlparse(base)
    if parsed.scheme == "rtsp":
        return [base]

    paths = [
        parsed.path or "/",
        "/video",
        "/videofeed",
        "/mjpeg",
        "/mjpg/video.mjpg",
        "/stream",
        "/stream.mjpg",
        "/shot.jpg",
    ]
    unique_paths = []
    for path in paths:
        if path not in unique_paths:
            unique_paths.append(path)

    candidates = []
    netlocs = [parsed.netloc]
    if parsed.scheme == "http" and ":" not in parsed.netloc and parsed.hostname:
        netlocs.append(f"{parsed.hostname}:8080")
    for netloc in dict.fromkeys(netlocs):
        for path in unique_paths:
            candidates.append(urlunparse((parsed.scheme, netloc, path, "", parsed.query, "")))
    return candidates


def device_text(device: sqlite3.Row) -> str:
    return " ".join(
        str(device[key] or "")
        for key in ["device_type", "name", "location", "endpoint", "status"]
    ).lower()


def detect_device_events(device: sqlite3.Row) -> List[dict]:
    text = device_text(device)
    events = []
    for pattern in AI_OBJECT_PATTERNS:
        if any(alias in text for alias in pattern["aliases"]):
            reason = f"{pattern['object_name']} indicator matched in {device['device_type']} telemetry."
            events.append(
                {
                    "device_id": device["device_id"],
                    "device_type": device["device_type"],
                    "object_name": pattern["object_name"],
                    "event_type": pattern["event_type"],
                    "confidence": pattern["confidence"],
                    "alert_level": pattern["alert_level"],
                    "reason": reason,
                }
            )
    if device["status"] == "OFFLINE":
        events.append(
            {
                "device_id": device["device_id"],
                "device_type": device["device_type"],
                "object_name": "Device Offline",
                "event_type": "Device Health",
                "confidence": 0.9,
                "alert_level": "High",
                "reason": f"{device['name']} is offline and cannot report field activity.",
            }
        )
    if device["status"] == "MAINTENANCE":
        events.append(
            {
                "device_id": device["device_id"],
                "device_type": device["device_type"],
                "object_name": "Maintenance Blind Spot",
                "event_type": "Device Health",
                "confidence": 0.76,
                "alert_level": "Medium",
                "reason": f"{device['name']} is in maintenance mode.",
            }
        )
    if device["device_type"] == "CAMERA" and device["status"] == "ACTIVE" and not device["endpoint"]:
        events.append(
            {
                "device_id": device["device_id"],
                "device_type": "CAMERA",
                "object_name": "Camera Without Stream",
                "event_type": "Camera Health",
                "confidence": 0.8,
                "alert_level": "Medium",
                "reason": f"{device['name']} is active but has no stream endpoint.",
            }
        )
    return events


def event_signature(event: dict) -> str:
    return f"{event['device_id']}:{event['object_name']}:{event['event_type']}"


def save_ai_event(event: dict) -> Optional[dict]:
    signature = event_signature(event)
    created_at = utc_now().isoformat()
    with db_connection() as conn:
        try:
            cursor = conn.execute(
                """
                INSERT INTO ai_events (
                    signature, device_id, device_type, object_name, event_type,
                    confidence, alert_level, reason, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    signature,
                    event["device_id"],
                    event["device_type"],
                    event["object_name"],
                    event["event_type"],
                    event["confidence"],
                    event["alert_level"],
                    event["reason"],
                    created_at,
                ),
            )
        except sqlite3.IntegrityError:
            return None
        event_id = cursor.lastrowid
        if event["alert_level"] in ["High", "Medium"]:
            conn.execute(
                """
                INSERT INTO alerts (sensor_id, detected_type, detected_name, confidence, alert_level, detected_time)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    event["device_id"] or 0,
                    event["event_type"],
                    f"GLOCK AI: {event['object_name']}",
                    event["confidence"],
                    event["alert_level"],
                    created_at,
                ),
            )
    return {**event, "event_id": event_id, "signature": signature, "created_at": created_at}


def list_ai_events(limit: int = 50) -> List[dict]:
    with db_connection() as conn:
        rows = conn.execute(
            """
            SELECT event_id, signature, device_id, device_type, object_name, event_type,
                   confidence, alert_level, reason, created_at
            FROM ai_events
            ORDER BY event_id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


@router.get("/api/v1/wildlife/map", response_model=List[WildlifeTelemetryOut])
def get_wildlife_map(current_user: dict = Depends(SecurityGuard(["PUBLIC", "POST_GUARD", "INTERCEPTOR"]))):
    user_role = current_user["role"]
    processed = []
    for animal in MOCK_ANIMALS_DB:
        record = animal.copy()
        if user_role == "PUBLIC":
            record["latitude"] = round(record["latitude"], 1)
            record["longitude"] = round(record["longitude"], 1)
            record["data_integrity"] = "MASKED_OBFUSCATION"
        else:
            record["data_integrity"] = "RAW_PRECISION"
        processed.append(record)
    return processed


@router.get("/api/v1/wildlife/signatures")
def get_acoustic_catalog(current_user: dict = Depends(SecurityGuard(["POST_GUARD", "INTERCEPTOR"]))):
    return {"biological_signals": MOCK_ANIMAL_SOUNDS, "threat_signals": MOCK_SUSPICIOUS_SOUNDS}


@router.post("/api/v1/guard/raise-alert")
def field_guard_report_incident(payload: AlertReportInput, current_user: dict = Depends(SecurityGuard(["POST_GUARD", "INTERCEPTOR"]))):
    detected_time = utc_now().isoformat()
    with db_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO alerts (sensor_id, detected_type, detected_name, confidence, alert_level, detected_time)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                payload.sensor_id,
                payload.detected_type,
                payload.detected_name,
                payload.confidence,
                payload.alert_level,
                detected_time,
            ),
        )
        alert_id = cursor.lastrowid
    new_alert = {
        "alert_id": alert_id,
        "sensor_id": payload.sensor_id,
        "detected_type": payload.detected_type,
        "detected_name": payload.detected_name,
        "confidence": payload.confidence,
        "alert_level": payload.alert_level,
        "detected_time": detected_time,
    }
    add_audit_log(current_user["username"], "ALERT_MANUALLY_TRIGGERED", f"ID: {alert_id}")
    return {"status": "success", "incident_logged": new_alert}


@router.get("/api/v1/registry/devices")
def list_registered_devices(current_user: dict = Depends(SecurityGuard(["POST_GUARD", "INTERCEPTOR"]))):
    with db_connection() as conn:
        devices = conn.execute(
            """
            SELECT device_id, device_type, name, location, endpoint, latitude, longitude, status, registered_at
            FROM devices
            ORDER BY device_type, device_id DESC
            """
        ).fetchall()
    grouped = {"CAMERA": [], "SENSOR": [], "MICROPHONE": []}
    for device in devices:
        record = dict(device)
        grouped.setdefault(record["device_type"], []).append(record)
    return grouped


@router.get("/api/v1/registry/cameras")
def list_registered_cameras(current_user: dict = Depends(SecurityGuard(["POST_GUARD", "INTERCEPTOR"]))):
    with db_connection() as conn:
        cameras = conn.execute(
            """
            SELECT device_id, device_type, name, location, endpoint, latitude, longitude, status, registered_at
            FROM devices
            WHERE device_type = 'CAMERA'
            ORDER BY device_id DESC
            """
        ).fetchall()
    return [dict(camera) for camera in cameras]


@router.get("/api/v1/registry/devices/{device_id}/stream")
async def stream_registered_camera(device_id: int, token: str = Query("")):
    current_user = require_stream_token(token)
    if current_user["role"] not in ["POST_GUARD", "INTERCEPTOR"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied: missing clearance.")

    device = get_registered_device(device_id)
    if not device or device["device_type"] != "CAMERA":
        raise HTTPException(status_code=404, detail="Registered camera was not found.")
    if device["status"] != "ACTIVE":
        raise HTTPException(status_code=409, detail=f"Camera is {device['status']}.")
    if not device["endpoint"]:
        raise HTTPException(status_code=400, detail="Camera has no stream endpoint saved.")

    endpoint = normalize_camera_endpoint(device["endpoint"])
    if endpoint.startswith("rtsp://"):
        raise HTTPException(
            status_code=400,
            detail="RTSP camera endpoints need an HTTP/MJPEG/HLS gateway before a browser can play them.",
        )
    if not endpoint.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Camera endpoint must start with http:// or https://.")

    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=5.0, read=None, write=5.0, pool=5.0),
        follow_redirects=True,
    )
    upstream = None
    errors = []
    for candidate in camera_stream_candidates(device["endpoint"]):
        request = client.build_request("GET", candidate)
        try:
            upstream = await client.send(request, stream=True)
            upstream.raise_for_status()
            break
        except httpx.HTTPError as exc:
            if upstream:
                await upstream.aclose()
            upstream = None
            errors.append(f"{candidate} -> {str(exc) or exc.__class__.__name__}")
    if upstream is None:
        await client.aclose()
        detail = "; ".join(errors[-3:]) or "No compatible mobile camera stream path responded."
        raise HTTPException(status_code=502, detail=f"Camera stream could not be opened. Tried common mobile camera paths. {detail}")

    async def stream_endpoint():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    content_type = upstream.headers.get("content-type", "multipart/x-mixed-replace; boundary=frame")
    return StreamingResponse(stream_endpoint(), media_type=content_type)


@router.post("/api/v1/registry/devices")
def register_device(payload: DeviceCreate, current_user: dict = Depends(SecurityGuard(["INTERCEPTOR"]))):
    device_type = payload.device_type.upper()
    if device_type not in ["CAMERA", "SENSOR", "MICROPHONE"]:
        raise HTTPException(status_code=400, detail="Device type must be CAMERA, SENSOR, or MICROPHONE.")
    status_value = payload.status.upper()
    if status_value not in ["ACTIVE", "MAINTENANCE", "OFFLINE"]:
        raise HTTPException(status_code=400, detail="Status must be ACTIVE, MAINTENANCE, or OFFLINE.")
    registered_at = utc_now().isoformat()
    with db_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO devices (device_type, name, location, endpoint, latitude, longitude, status, registered_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                device_type,
                payload.name,
                payload.location,
                payload.endpoint,
                payload.latitude,
                payload.longitude,
                status_value,
                registered_at,
            ),
        )
        device_id = cursor.lastrowid
    add_audit_log(current_user["username"], "DEVICE_REGISTERED", f"{device_type} ID: {device_id}")
    return {
        "device_id": device_id,
        "device_type": device_type,
        "name": payload.name,
        "location": payload.location,
        "endpoint": payload.endpoint,
        "latitude": payload.latitude,
        "longitude": payload.longitude,
        "status": status_value,
        "registered_at": registered_at,
    }


@router.post("/api/v1/ai/glock/scan")
def run_glock_ai_scan(current_user: dict = Depends(SecurityGuard(["POST_GUARD", "INTERCEPTOR"]))):
    with db_connection() as conn:
        devices = conn.execute(
            """
            SELECT device_id, device_type, name, location, endpoint, latitude, longitude, status, registered_at
            FROM devices
            ORDER BY device_id DESC
            """
        ).fetchall()
    detections = []
    new_events = []
    for device in devices:
        for event in detect_device_events(device):
            detections.append(event)
            saved = save_ai_event(event)
            if saved:
                new_events.append(saved)
    if new_events:
        add_audit_log(current_user["username"], "GLOCK_AI_ALARM", f"{len(new_events)} new event(s)")
    events = list_ai_events()
    return {
        "engine": "GLOCK AI",
        "scanned_devices": len(devices),
        "detections": detections,
        "new_events": new_events,
        "events": events,
        "active_alarm_count": len([event for event in events if event["alert_level"] in ["High", "Medium"]]),
        "scanned_at": utc_now().isoformat(),
    }


@router.get("/api/v1/ai/glock/events")
def get_glock_ai_events(current_user: dict = Depends(SecurityGuard(["POST_GUARD", "INTERCEPTOR"]))):
    events = list_ai_events()
    return {
        "engine": "GLOCK AI",
        "events": events,
        "active_alarm_count": len([event for event in events if event["alert_level"] in ["High", "Medium"]]),
    }


@router.post("/api/v1/ai/object-search")
def search_objects(payload: ObjectSearchInput, current_user: dict = Depends(SecurityGuard(["POST_GUARD", "INTERCEPTOR"]))):
    query = payload.query.strip().lower()
    results = []
    with db_connection() as conn:
        devices = conn.execute(
            """
            SELECT device_id, device_type, name, location, endpoint, latitude, longitude, status, registered_at
            FROM devices
            ORDER BY device_id DESC
            """
        ).fetchall()
        ai_events = conn.execute(
            """
            SELECT event_id, device_id, device_type, object_name, event_type, confidence, alert_level, reason, created_at
            FROM ai_events
            ORDER BY event_id DESC
            LIMIT 100
            """
        ).fetchall()
        alerts = conn.execute(
            """
            SELECT alert_id, sensor_id, detected_type, detected_name, confidence, alert_level, detected_time
            FROM alerts
            ORDER BY alert_id DESC
            LIMIT 100
            """
        ).fetchall()

    for pattern in AI_OBJECT_PATTERNS:
        searchable = " ".join([pattern["object_name"], *pattern["aliases"]]).lower()
        if query in searchable or any(alias in query for alias in pattern["aliases"]):
            results.append(
                {
                    "source": "GLOCK AI catalog",
                    "label": pattern["object_name"],
                    "detail": f"{pattern['event_type']} | {pattern['alert_level']} priority",
                    "confidence": pattern["confidence"],
                }
            )
    for event in ai_events:
        text = f"{event['object_name']} {event['event_type']} {event['reason']} {event['device_type']}".lower()
        if query in text:
            results.append(
                {
                    "source": "AI alarm history",
                    "label": event["object_name"],
                    "detail": f"{event['event_type']} | Device {event['device_id']} | {event['alert_level']}",
                    "confidence": event["confidence"],
                }
            )
    for device in devices:
        text = device_text(device)
        if query in text:
            results.append(
                {
                    "source": f"{device['device_type']} registry",
                    "label": device["name"],
                    "detail": f"{device['location']} | {device['status']}",
                    "confidence": 0.72,
                }
            )
    for alert in alerts:
        text = f"{alert['detected_type']} {alert['detected_name']} {alert['alert_level']}".lower()
        if query in text:
            results.append(
                {
                    "source": "Alert queue",
                    "label": alert["detected_name"],
                    "detail": f"{alert['detected_type']} | Sensor {alert['sensor_id']} | {alert['alert_level']}",
                    "confidence": alert["confidence"],
                }
            )
    for animal in MOCK_ANIMALS_DB:
        text = f"{animal['common_name']} {animal['scientific_name']} {animal['category']}".lower()
        if query in text:
            results.append(
                {
                    "source": "Wildlife telemetry",
                    "label": animal["common_name"],
                    "detail": f"{animal['category']} | Grid {animal['latitude']}, {animal['longitude']}",
                    "confidence": 0.78,
                }
            )
    for sound in MOCK_SUSPICIOUS_SOUNDS:
        text = f"{sound['sound_name']} {sound['category']} {sound['threat_level']}".lower()
        if query in text:
            results.append(
                {
                    "source": "Acoustic threat catalog",
                    "label": sound["sound_name"],
                    "detail": f"{sound['category']} | {sound['threat_level']}",
                    "confidence": 0.8,
                }
            )
    return {"query": payload.query, "results": results[:30], "searched_at": utc_now().isoformat()}


@router.get("/api/v1/interceptor/alerts")
def view_active_alerts(current_user: dict = Depends(SecurityGuard(["INTERCEPTOR"]))):
    with db_connection() as conn:
        alerts = conn.execute(
            """
            SELECT alert_id, sensor_id, detected_type, detected_name, confidence, alert_level, detected_time
            FROM alerts
            ORDER BY alert_id DESC
            """
        ).fetchall()
    with db_connection() as conn:
        registered_sensors = conn.execute(
            """
            SELECT device_id AS sensor_id, 'Registered Sensor' AS sensor_type, location, latitude, longitude, status
            FROM devices
            WHERE device_type IN ('SENSOR', 'MICROPHONE')
            ORDER BY device_id DESC
            """
        ).fetchall()
    grid_nodes = MOCK_SENSORS_DB + [dict(sensor) for sensor in registered_sensors]
    return {"active_alerts": [dict(alert) for alert in alerts], "grid_nodes": grid_nodes}


app.include_router(router)

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="0.0.0.0", port=8000)
