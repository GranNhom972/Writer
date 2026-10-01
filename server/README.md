# Writer server

The Rust back end of Writer (Axum + Yrs). It lets several people edit the same document at the same time.

It does three jobs:

1. **Relay** – it passes live edits between everyone who has the document open.
2. **Durable log** – it writes every edit to disk before passing it on, so nothing a user typed is lost.
3. **Image store** – it keeps the pictures that are inserted into documents.

The server does not understand what is *inside* a document while people are editing. It only moves opaque CRDT updates around (Yjs), which is why two people can type in the same paragraph without overwriting each other.

```bash
cargo run     # starts the server on 127.0.0.1:8081
cargo test    # runs the unit and integration tests
```

---

## Contents

- [Configuration](#configuration)
- [Authentication](#authentication)
- [Inbound API](#inbound-api-what-clients-call-this-server) – requests this server receives
  - [Health](#health)
  - [Documents](#documents)
  - [Images](#images)
  - [Sharing (sessions)](#sharing-sessions)
  - [Live editing (WebSocket)](#live-editing-websocket)
  - [Live save feed (WebSocket)](#live-save-feed-websocket)
  - [Editor web page](#editor-web-page)
- [Outbound API](#outbound-api-what-this-server-calls) – requests this server sends
- [Errors](#errors)
- [Limits](#limits)

---

## Configuration

Everything is set with environment variables. All of them are optional.

| Variable | Default | What it does |
| :--- | :--- | :--- |
| `WRITER_BIND` | `127.0.0.1:8081` | Address and port the server listens on. |
| `WRITER_DATA_DIR` | `./data` | Folder where documents, sessions and images are stored. |
| `WRITER_AUTH_MODE` | `jwt` | `jwt` (real tokens) or `dev` (simple test tokens). `dev` is refused when `WRITER_ENV=production`. |
| `WRITER_ENV` | – | Set to `production` to forbid the `dev` mode. |
| `WRITER_JWT_SECRET` | – | Secret used to check tokens **and** to sign outbound calls. Required in `jwt` mode: the server refuses to start without it. |
| `WRITER_ALLOWED_ORIGINS` | `localhost` and `127.0.0.1` on ports `5174` and `4173` | Comma-separated list of web page origins allowed to open a WebSocket or upload an image. |
| `WRITER_CLOUDSERV_URL` | – | Base address of CloudServ (plain `http://` only). When it is not set, the server runs alone and never calls anybody. |
| `WRITER_CLOSE_GRACE_SECS` | `30` | How long to wait after the last person leaves before saving and cleaning up. |
| `WRITER_CHECKPOINT_QUIET_SECS` | `10` | Pause in typing after which the document is sent to CloudServ. |
| `WRITER_CHECKPOINT_MAX_SECS` | `120` | Longest time between two sends to CloudServ, even if typing never stops. |
| `WRITER_WEB_ROOT` | – | Folder containing the built editor. When set, this server also serves the web page. |

---

## Authentication

Every request that changes or reads a document must say **who you are**. The identity always comes from a token, never from the request body or the URL.

**Where to put the token**

| Kind of request | How to send the token |
| :--- | :--- |
| Normal HTTP request | Header `Authorization: Bearer <token>` |
| WebSocket from a browser | Header `Sec-WebSocket-Protocol: bearer.<token>` (browsers cannot set `Authorization` on a WebSocket). The token is never accepted in the URL. |

**Two token types**

- **`jwt` mode (production)** – a signed JWT (HS256) using the secret `WRITER_JWT_SECRET`. The claims are:

  | Claim | Required | Meaning |
  | :--- | :--- | :--- |
  | `sub` | yes | The user's identifier. |
  | `exp` | yes | Expiry time. It must be in the future and at most **2 hours** away. |
  | `scope` | no | `read`, `comment` or `write`. Missing or unreadable means `read`. |
  | `name` | no | Display name (up to 128 characters). |
  | `doc` | no | If present, the token only works for **that one document**. |

- **`dev` mode (local testing only)** – a plain text token `dev.<user>.<scope>`, for example `dev.alice.write`. Switch it on with `WRITER_AUTH_MODE=dev`.

**What each scope allows**

| Scope | Can read | Can comment | Can edit, rename, delete, upload images |
| :--- | :---: | :---: | :---: |
| `read` | yes | no | no |
| `comment` | yes | yes | no |
| `write` | yes | yes | yes |

For a **shared** document (see [Sharing](#sharing-sessions)), the permission written in the share's participant list always wins. A token can lower it but never raise it.

---

## Inbound API (what clients call this server)

All paths start with `/api/v1`, except the health checks. Bodies and answers are JSON unless stated otherwise.

| Method | Path | Token needed? | Purpose |
| :--- | :--- | :---: | :--- |
| `GET` | `/healthz` | no | Is the process alive? |
| `GET` | `/readyz` | no | Is storage working? |
| `POST` | `/api/v1/documents` | `write` | Create a document. |
| `GET` | `/api/v1/documents` | yes | List all documents. |
| `GET` | `/api/v1/documents/{doc_id}` | yes | Get a document's details. |
| `PATCH` | `/api/v1/documents/{doc_id}` | `write` | Rename a document. |
| `DELETE` | `/api/v1/documents/{doc_id}` | `write` | Delete a document and its data. |
| `GET` | `/api/v1/documents/{doc_id}/snapshot` | yes | Get the whole document as JSON. |
| `GET` | `/api/v1/documents/{doc_id}/restore-points` | yes | List saved older versions. |
| `POST` | `/api/v1/documents/{doc_id}/restore` | `write` | Bring an older version back as a new document. |
| `POST` | `/api/v1/documents/{doc_id}/assets` | `write` | Upload an image. |
| `GET` | `/api/v1/documents/{doc_id}/assets/{name}` | no | Download an image. |
| `POST` | `/api/v1/sessions` | no | Share a document (create a session). |
| `GET` | `/api/v1/sessions` | no | List all shares. |
| `GET` | `/api/v1/sessions/{token_session}` | no | Does this share exist? |
| `POST` | `/api/v1/sessions/{token_session}/join` | depends | Join a share. |
| `POST` | `/api/v1/sessions/{token_session}/participants` | `write` participant | Invite someone to a share. |
| `WS` | `/api/v1/sync/{doc_id}` | yes | Edit a document live. |
| `WS` | `/api/v1/sessions/{token_session}/events` | participant | Watch saves live (read only). |
| `GET` | anything else | no | The editor web page (see [below](#editor-web-page)). |

> **Note on "Token needed?":** a bare "yes" means any valid token. `write` means the token must have the `write` scope. For a shared document you must also be on the participant list. A token tied to one document (`doc` claim) only works on that document, and cannot create documents or list them.

### Health

- `GET /healthz` → `200 {"status": "ok"}`. The server is running.
- `GET /readyz` → `200 {"status": "ready", "documents_loaded": 3}` when storage answers, otherwise `503 {"status": "unavailable"}`.

### Documents

A document is identified by a `doc_id`. The **server** always generates it (UUIDv7). A client can never choose one.

**Create a document** – `POST /api/v1/documents`

Send an optional title and an optional starting content. With no body at all you get an empty "Document sans titre".

```json
{ "title": "Meeting notes", "document": { "blocks": [] } }
```

- `title`: up to 200 characters.
- `document`: a full Writer document (`{"blocks": [...]}`). It is checked before anything is written, so a refused document leaves nothing behind.

Answer `201 Created`:

```json
{
  "doc_id": "0199…",
  "kind": "writer",
  "title": "Meeting notes",
  "owner": "alice",
  "created_at": "2026-10-01T10:00:00+00:00",
  "sync_path": "/api/v1/sync/0199…"
}
```

`sync_path` is where to connect the WebSocket to edit this document. A token tied to a single document cannot create documents (`403`).

**List documents** – `GET /api/v1/documents`

Answer: `{"documents": [{doc_id, kind, title, owner_id, created_at}, ...]}`. It lists **every** document stored on this server. Tokens tied to one document are refused (`403`).

**Get one document** – `GET /api/v1/documents/{doc_id}`

Answer: `doc_id`, `kind`, `title`, `owner`, `created_at`, plus live figures: `revision` (a counter that grows with each edit), `blocks` (number of paragraphs, tables, etc.) and `active_clients` (people connected right now). If the document is shared, you must be on its participant list (`403` otherwise).

**Rename** – `PATCH /api/v1/documents/{doc_id}`

```json
{ "title": "New title" }
```

The title must not be empty and has at most 200 characters. Answer `200` with the updated details.

**Delete** – `DELETE /api/v1/documents/{doc_id}` → `204 No Content`

Removes the document, its history and its images. CloudServ uses this to make sure nothing stays here after it has saved its own copy. It fails with `409 Conflict` while someone is still connected, because deleting under a person who is typing would lose their work. Unknown document: `404`.

**Snapshot** – `GET /api/v1/documents/{doc_id}/snapshot`

Answer: `{"doc_id": "...", "revision": 42, "document": { ...whole document as JSON... }}`. A client loads this when it opens, so the page can show the text before the WebSocket is ready.

**Restore points** – `GET /api/v1/documents/{doc_id}/restore-points`

Each time the edit log is compacted, the server keeps a dated copy of the document (the 20 most recent ones). Answer:

```json
{ "restore_points": [ { "id": "20260825T151530.123456", "size_bytes": 4096 } ] }
```

They are sorted from oldest to newest. They exist so that a mass deletion can still be undone after the log has been shortened.

**Restore** – `POST /api/v1/documents/{doc_id}/restore`

```json
{ "restore_point": "20260825T151530.123456", "title": "Before the cleanup" }
```

`title` is optional. The old version is put into a **brand new document** and the current one is not touched (writing the old state back into a live document would be overwritten at once by anyone still connected). Answer `201 Created`:

```json
{
  "doc_id": "<new id>",
  "title": "Before the cleanup",
  "restored_from": { "doc_id": "<old id>", "restore_point": "20260825T151530.123456" },
  "sync_path": "/api/v1/sync/<new id>"
}
```

### Images

Images are stored on the server and only their short address is placed in the document. This keeps edits small: a 2 MB photo does not travel again every time someone types next to it.

**Upload** – `POST /api/v1/documents/{doc_id}/assets`

Send the **raw bytes** of the image as the body (no JSON, no multipart). Requirements:

- `write` scope, and the web page origin must be allowed (`WRITER_ALLOWED_ORIGINS`).
- At most **4 MiB**. A bigger body is cut off while it is being read (`413`).
- PNG, JPEG, GIF or WebP only. The server recognizes the type from the file's first bytes and **ignores** the `Content-Type` header. SVG is refused because it can carry scripts. An empty or unrecognized body gets `400`.

Answer `201 Created`:

```json
{
  "url": "/api/v1/documents/<doc_id>/assets/<random-uuid>.png",
  "name": "<random-uuid>.png",
  "content_type": "image/png",
  "size_bytes": 20480
}
```

Put `url` into the image run (`imageSrc`) of the paragraph. The file name is made up by the server and is never taken from the request.

**Download** – `GET /api/v1/documents/{doc_id}/assets/{name}`

No token is needed: a browser `<img>` tag cannot send one, and the random name acts as the key. The answer is the image itself with `X-Content-Type-Options: nosniff` and a one-year immutable cache. A name that is not exactly `<uuid>.<png|jpg|gif|webp>` gets `404`.

### Sharing (sessions)

A **session** is a share. It links a name you pick (`token_session`) to a document and to a list of people with their e-mail address and permission.

Two ideas to keep in mind:

- `token_session` only **names** the share. Knowing it gives no access. Being on the participant list does.
- `doc_id` is still generated by the server.

**Create a share** – `POST /api/v1/sessions`

```json
{
  "token_session": "team-notes-2026-q4",
  "title": "Team notes",
  "participants": [
    { "email": "alice@example.org", "permission": "write" },
    { "email": "bob@example.org", "permission": "read" }
  ],
  "document": { "blocks": [] }
}
```

- `token_session`: 12 to 128 characters, only letters, digits, `-` and `_`. It must be hard to guess, and it must be new (`409` if it is already taken).
- `participants`: up to 200. Each one has an `email`, an optional `user_id` (taken from the e-mail when missing) and a `permission` among `read`, `comment`, `write` (default: `read`).
- `title` and `document` are optional.

Answer `201 Created`: the share with the **full** e-mail addresses.

```json
{
  "token_session": "team-notes-2026-q4",
  "doc_id": "0199…",
  "title": "Team notes",
  "created_at": "…",
  "created_by": "alice",
  "participants": [ { "user_id": "alice", "email": "alice@example.org", "permission": "write" } ],
  "sync_path": "/api/v1/sync/0199…",
  "events_path": "/api/v1/sessions/team-notes-2026-q4/events"
}
```

**Check that a share exists** – `GET /api/v1/sessions/{token_session}`

Same shape as above, but e-mail addresses are **hidden** (`alice@example.org` becomes `a****@example.org`). Unknown token: `404`.

**List shares** – `GET /api/v1/sessions`

Answer: `{"sessions": [{token_session, doc_id, title, created_at, participants: <count>}, ...]}`, oldest first.

**Join a share** – `POST /api/v1/sessions/{token_session}/join`

```json
{ "email": "bob@example.org" }
```

The e-mail must be on the participant list, otherwise `403`. In `jwt` mode you must also send a token whose `sub` matches that participant. In `dev` mode the list alone is enough and the server hands out a test token. Answer:

```json
{
  "token_session": "team-notes-2026-q4",
  "doc_id": "0199…",
  "title": "Team notes",
  "user_id": "bob",
  "email": "bob@example.org",
  "permission": "read",
  "access_token": "dev.bob.read",
  "auth_mode": "dev",
  "sync_path": "/api/v1/sync/0199…",
  "events_path": "/api/v1/sessions/team-notes-2026-q4/events",
  "editor_path": "/?session=team-notes-2026-q4&email=bob%40example.org"
}
```

`permission` is always the one written in the share, never the one the caller asks for. `access_token` is `null` in `jwt` mode (you already have your own token).

**Invite someone** – `POST /api/v1/sessions/{token_session}/participants`

```json
{ "email": "carol@example.org", "permission": "comment" }
```

Only a participant with `write` permission may invite (`403` otherwise), because inviting gives access to the document. Errors: `400` for a bad e-mail or a full list, `409` if the person is already in. Answer: `{"session": {...}, "editor_path": "/?session=...&email=..."}`.

### Live editing (WebSocket)

`GET /api/v1/sync/{doc_id}` upgrades to a WebSocket. This is the connection used while typing.

**Opening the connection**

1. The browser's `Origin` must be in `WRITER_ALLOWED_ORIGINS` (clients that send no `Origin`, such as scripts, are allowed because a token is required anyway).
2. A valid token is required (see [Authentication](#authentication)), and a token tied to another document is refused.
3. If the document is shared, you must be on the participant list.
4. The document must exist (`404`) and at most 200 people may be connected to it (`403` beyond that).

These checks happen before the upgrade, so a failure is a normal HTTP error and not a WebSocket close.

**What is sent** – only **binary** frames, following the standard `y-protocols` (the same as `y-websocket`). Text frames are ignored. The first number of each frame tells the type:

| Type | Name | Meaning |
| :---: | :--- | :--- |
| `0` / sub `0` | SyncStep1 | "Here is what I already have, send me what I miss." |
| `0` / sub `1` | SyncStep2 | The answer to a SyncStep1: everything the other side misses. |
| `0` / sub `2` | Update | A new edit. |
| `1` | Awareness | Who is here and where their cursor is. Passed on, never stored. |
| `3` | QueryAwareness | "Who is here?" |

**A typical conversation**

1. The server immediately sends its own `SyncStep1`, then tells the newcomer who is already present.
2. The client answers with its own `SyncStep1` and `SyncStep2`, and from then on sends `Update` frames for each edit.
3. For each edit the server checks it, **writes it to disk**, and only then sends it to the other people. Passing it on first could show people text that would be lost after a crash.
4. If a client is too slow and misses frames, the server sends a fresh `SyncStep1` so it can catch up.

People with `read` or `comment` scope can stay connected and receive everything, but their edits are ignored.

**Why the server may close the connection**

| Close code | Reason |
| :---: | :--- |
| `4408` | Nothing received for 90 seconds (clients normally announce themselves about every 15 s). |
| `4413` | A frame bigger than 1 MiB. |
| `4429` | Too many messages (more than 100 per second on average, bursts up to 300). |

### Live save feed (WebSocket)

`GET /api/v1/sessions/{token_session}/events` upgrades to a **read-only** WebSocket for scripts and tools that only want to know "how is the document doing?" without implementing the editing protocol. You must be a participant of the share, and the same origin and token rules as above apply.

The server sends **JSON text** frames. Anything the client sends is ignored.

| `type` | When | Content |
| :--- | :--- | :--- |
| `snapshot` | Right after connecting | The full current document. |
| `save` | After edits were written to disk, grouped over at most 250 ms | `operations` = how many edits were saved, and the full document. |
| `heartbeat` | Every 20 s of silence | Just `revision`, `active_clients` and the time, to keep the connection alive. |

`snapshot` and `save` frames carry: `type`, `token_session`, `doc_id`, `title`, `durable` (always `true`), `revision`, `operations`, `active_clients`, `at` (time) and `document`.

### Editor web page

If `WRITER_WEB_ROOT` is set, the server also serves the built editor. Any address that is not an API route (for example `/doc/<id>`) returns `index.html`, and the web page's own router takes over. This keeps the page and the API on the same origin, which the relative `fetch` calls and the WebSocket need.

An unknown address under `/api` always returns a clear `404`, never the web page. If `WRITER_WEB_ROOT` is not set, other addresses return `404`.

---

## Outbound API (what this server calls)

The only requests this server **sends** go to **CloudServ**, and only when `WRITER_CLOUDSERV_URL` is set. In that setup Writer is just a temporary editor: the document belongs to CloudServ, and nothing should stay here once the editing is over. Without `WRITER_CLOUDSERV_URL` the server never calls anybody and never deletes anything on its own.

**How the calls are made**

- Method and body: `POST` with a JSON body.
- Headers: `Content-Type: application/json` and `X-Writer-Signature: <hex>`, where `<hex>` is the HMAC-SHA256 of the exact body, using `WRITER_JWT_SECRET`. CloudServ must check it, so that nobody can pretend a session ended and make CloudServ write a document of their choice.
- Only plain `http://` addresses are supported (CloudServ is reached over the internal network). An `https://` address is refused rather than half-handled.
- Timeout: 20 seconds per call.

**Both calls send the same body**

```json
{
  "doc_id": "0199…",
  "revision": 42,
  "title": "Team notes",
  "document": { "blocks": [ … ] }
}
```

`document` is the whole document as JSON. Images that were uploaded to this server are **embedded** in it (as `data:image/...;base64,...` addresses), so the copy is complete and has no broken links once the server cleans up.

### `POST {WRITER_CLOUDSERV_URL}/api/cloud/writer/session-checkpoint`

*"Here is the current state, keep a copy."* Sent while people are still editing.

- **When:** after each edit the server waits for a pause in typing (`WRITER_CHECKPOINT_QUIET_SECS`, 10 s), but never longer than `WRITER_CHECKPOINT_MAX_SECS` (120 s) since the first unsent edit. In the worst case a crash loses about two minutes of work.
- **Answers:** `2xx` means it was stored. `404` means CloudServ does not know this document (Writer hosts it for itself), which is normal and not an error. Anything else is logged and **not retried**: the next checkpoint carries a more recent state anyway.

### `POST {WRITER_CLOUDSERV_URL}/api/cloud/writer/session-closed`

*"Everybody has left. Save the final version."* This is the call that lets Writer forget the document.

- **When:** after the last person has left **and** `WRITER_CLOSE_GRACE_SECS` (30 s) have passed. The delay exists because reloading a page closes the WebSocket and opens another straight away, and that must not count as leaving. If someone comes back during the delay, nothing is sent.
- **Answers:**
  - `2xx` – CloudServ saved it, so the server **deletes** its own copy (log, snapshots, restore points, images).
  - `404` – CloudServ does not know the document. It is kept as it is, because deleting it could destroy somebody else's work.
  - anything else, or no answer – the call is tried up to **3 times** (waiting 2 s, then 4 s). If every try fails, **all data is kept** and the document is saved again the next time it is opened. Data is never deleted before CloudServ has confirmed.

### CloudServ calling Writer

The same integration also relies on two things CloudServ does towards this server, both described above:

- It signs access tickets (JWT, same `WRITER_JWT_SECRET`) with a `doc` claim, so a ticket only opens the document it was issued for.
- It may call `DELETE /api/v1/documents/{doc_id}` to force a clean-up, without waiting for the automatic `session-closed` call (which may have failed, or never happened if the server restarted).

---

## Errors

Errors follow RFC 9457 ("problem details"). The body always looks like this:

```json
{
  "type": "https://errors.cloudantille.local/insufficient-scope",
  "title": "insufficient-scope",
  "status": 403,
  "detail": "portée insuffisante"
}
```

| Status | `title` | Typical cause |
| :---: | :--- | :--- |
| `400` | `invalid-request` | A field is missing, too long or badly formed. |
| `400` | `invalid-crdt-update` / `invalid-operation` | An unreadable edit. |
| `401` | `unauthenticated` | No token, a wrong signature, an expired token or one that is valid for too long. |
| `403` | `insufficient-scope` | Not enough permission, not on the participant list, wrong document, or origin not allowed. |
| `404` | `document-not-found` / `session-not-found` | The document or the share does not exist. |
| `409` | `session-already-exists` | The share name is taken, the person is already invited, or the document still has people connected (the `title` is the same for all `409` errors). |
| `413` | `payload-too-large` | The image is bigger than 4 MiB. |
| `500` | `internal` | A server problem. The technical detail is only written to the server log and never sent back. |

---

## Limits

| What | Limit |
| :--- | :--- |
| Document title | 200 characters |
| Image size | 4 MiB (PNG, JPEG, GIF, WebP) |
| WebSocket frame | 1 MiB |
| Messages per connection | 100 per second on average, bursts up to 300 |
| People connected to one document | 200 |
| Silence before a connection is closed | 90 seconds |
| Participants in one share | 200 |
| `token_session` length | 12 to 128 characters |
| Restore points kept per document | 20 |
| Token lifetime (`jwt` mode) | 2 hours at most |
