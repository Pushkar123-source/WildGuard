# Wildlife Protection Command

A FastAPI backend with a static role-aware frontend for the wildlife protection dataset.

The app uses SQLite for persistent users, invite tokens, audit logs, and raised alerts.
The database file is created automatically as `wildlife.db` the first time the app starts.

## Run locally

```powershell
py -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>.

Default interceptor login:

- Username: `PREM_COMMAND`
- Password: `admin123`

## Deploy

Use the same start command on Python hosting:

```bash
uvicorn server:app --host 0.0.0.0 --port $PORT
```

For Render or Railway, set the build command to:

```bash
pip install -r requirements.txt
```

## Roles

- `PUBLIC`: wildlife map with masked coordinates.
- `POST_GUARD`: wildlife map, acoustic signatures, and manual alert reporting.
- `INTERCEPTOR`: full access, invite generation, active alerts, sensors, and audit logs.

## Register Devices

Login as an `INTERCEPTOR`, open the Registry tab, and add cameras, sensors, or
microphones with their name, location, endpoint, coordinates, and status.

For live camera viewing, register camera endpoints as browser-playable HTTP
streams such as `http://camera-ip/video`, an MJPEG URL, or an HLS gateway URL.
Plain IP addresses are treated as `http://IP`. Direct `rtsp://` feeds need an
HTTP/MJPEG/HLS gateway before the browser can display them.

The Camera tab also supports the current phone/laptop camera through the browser.
On mobile, open the app in Chrome, Edge, or Safari and use "This device camera"
to choose the front or rear camera after permission is granted. Registered
cameras can be opened as MJPEG/image proxy, direct video/HLS, or a camera web
page. Browser security still applies: direct RTSP is not playable until the
camera or an NVR exposes a browser-friendly stream such as MJPEG, HLS, WebRTC,
MP4/WebM, or an embeddable viewer page.

## GLOCK AI

Login as `POST_GUARD` or `INTERCEPTOR`, open the GLOCK AI tab, and run a scan.
The local AI watch layer checks registered sensors, cameras, and microphones for
unusual activity indicators, device blind spots, and suspicious object names.
New AI alarms are also added to the normal Alerts queue. Use Object Search to
look up threats, devices, alert history, signal signatures, and wildlife records.

## Add Another Admin

Login as `PREM_COMMAND`, open Security, generate an invite with role
`INTERCEPTOR`, then use that invite token on the Register form to create the new
admin account.
