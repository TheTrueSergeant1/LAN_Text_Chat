# LocalChat Pro: Enterprise Edition 🚀

LocalChat Pro is a professional-grade, self-hosted chat application built on Node.js, Express, MySQL, and WebSockets. It is designed for private networks, offering secure authentication, granular moderation tools, rich message formatting (Markdown), file uploads, threading, and real-time presence.

---

⚙️ Setup and Installation

Follow these steps to get the LocalChat Pro server and client running on your machine.

1. Prerequisites

You must have the following installed:

* Node.js (v18+) and **npm**
* MySQL Server (or equivalent database service like MariaDB, MAMP, XAMPP)
* Git (for cloning and version control)

2. Configure the Database

LocalChat Pro requires a database named `localchat_db`.

1.  Start your MySQL server.
2.  Execute the `schema.sql` file** to create the necessary database and tables.

    ```sql
    -- Run this in your MySQL client (Workbench, CLI, etc.)
    -- The schema will create and populate the initial structure.
    SOURCE /path/to/your/project/schema.sql;
    ```

3. Server Configuration (`.env` file)

Edit the provided `.env` file to match your environment.

| Variable | Description | Default Value | Action |
| :--- | :--- | :--- | :--- |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD` | Your local MySQL credentials (required for connection). | `127.0.0.1`, `root`, `root` | Must change if your DB credentials differ. |
| `SERVER_IP` | The network interface the server listens on (e.g., your local machine's IP). | `10.0.0.100` | MUST CHANGE to your local machine's non-10.0.0.0 private IP (e.g., `192.168.1.50`) or `0.0.0.0` to listen on all interfaces. |
| `SERVER_PORT` | The port the HTTP/WebSocket server uses. | `3000` | Typically fine, unless port 3000 is occupied. |

> ⚠️ Important Network Configuration:
> If your local network uses a different IP range (e.g., `192.168.x.x` or `172.16.x.x`), you must change three locations:
> 1.  `.env` file: Update `SERVER_IP` to your machine's correct IP (e.g., `192.168.1.50`) or `0.0.0.0`.
> 2.  `index.html`: In the `<input type="text" id="server-ip-input" ...>` field, update the `value` attribute.
> 3.  Client Login: When you first open the browser, you must enter the correct `SERVER_IP` in the login modal.

4. Install Dependencies and Run

1.  Navigate to the server directory in your terminal:

    ```bash
    cd localchat-server
    ```

2.  Install the required Node.js dependencies:

    ```bash
    npm install
    ```

3.  Start the server:

    ```bash
    node server.js
    ```

The server will display the running URL, typically `http://[Your-IP]:3000/index.html`.

---

🏗️ Architecture and How It Works

LocalChat Pro operates on a modern, event-driven architecture designed for real-time communication:

1. Frontend (`index.html`)

* Technology: Pure HTML/CSS (Tailwind CSS, custom styles) and JavaScript. It uses `marked.js` for Markdown parsing and `DOMPurify` for input sanitization (XSS protection).
* Connection: Manages user authentication via HTTP REST API calls (`/api/register`, `/api/login`) and maintains a persistent, real-time connection using a WebSocket (WS) client.
* Data Flow: Sends command/message objects to the WS server and updates the UI based on incoming events (`channel_message`, `user_presence`, etc.).

2. Backend (Node.js/Express)

* API Layer (`server.js`, `api.js`): Uses Express for traditional HTTP requests, primarily for user authentication and **file uploads** (which are more robust over HTTP).
* Database (`db.js`): Connects to MySQL using `mysql2/promise` with a connection pool for efficient, asynchronous database interactions.
* Real-Time Layer (`websocket.js`): Manages all active WS connections, handles chat messages, presence updates, moderation commands, and persists data to the MySQL database. It enforces **Role-Based Access Control (RBAC)** for commands like `/kick` and `/ban`.

### 3. Persistence (MySQL Database)

The database stores all non-volatile data:
* Users: Stores user IDs, password hashes (PBKDF2), roles, and ban status.
* Messages: Stores message content, timestamps, authorship, attachments, and crucial **threading** hierarchy (`parent_message_id`).
* Channels: Stores channel names, privacy status, and the user-set pinned message ID.

---

## ✨ Current Feature Set

The following features are fully implemented in the current application code:

| Category | Feature | Status | Implementation Details |
| :--- | :--- | :--- | :--- |
| Messaging | Markdown Support | ✅ Ready | Messages support basic Markdown for rich formatting (bold, italics, code blocks). |
| | File Uploads | ✅ Ready | Uses Express/Multer via HTTP POST to handle uploads (Max 5MB), with whitelisting for security (images, PDF, text). |
| | Threading / Replies | ✅ Ready | Users can reply to any message, linking the messages in a hierarchical structure. |
| | Message Reactions | ✅ Ready | Users can add/remove emoji reactions, which are persisted to the database. |
| User/UX | Authentication | ✅ Ready | Login/Registration using HTTP API and WebSocket handshake. |
| | Role System | ✅ Ready | Users are assigned `User`, `Moderator`, or `Admin` roles based on username prefix during registration. |
| | Real-time Status | ✅ Ready | Users can set their status (`online`, `away`, `dnd`), visible in the user list. |
| | Dark Mode | ✅ Ready | UI supports switching between light and dark themes. |
| Admin/Mod | Message Management | ✅ Ready | Authors can edit their messages (with TTL). Mods/Admins can delete any message. |
| | Pinnable Messages | ✅ Ready | Admins can use `/pin [ID]` to pin messages to the channel banner. |

---

🔮 Feature Roadmap (Based on Schema)

The following advanced features are modeled in the `schema.sql` but not yet fully implemented in the client or server logic.

| Table/Feature | Status | Required Backend Work | Required Frontend Work |
| :--- | :--- | :--- | :--- |
| `audit_logs` | 🏗️ Pending | Implement a `GET /api/logs` endpoint and a WebSocket handler to retrieve and filter log data. | Build a dedicated, Admin-only Audit Log Viewer UI to display actions. |
| `read_receipts` | 🏗️ Pending | Implement `mark_read` WebSocket handler to update/insert the latest read message ID. | Create a visual "Last Read" marker or indicator on the message list. |
| Bans (Soft) | 🏗️ Pending | Implement the `/unban [username]` command to toggle `is_banned` and clear `ban_reason` in the `users` table. | Add a visual cue to the Admin UI for banned users. |
| `channel_permissions` | 🏗️ Pending | Add logic to `websocket.js` handlers (e.g., `send_message`, `delete_message`) to check the granular role permission defined in this table *before* allowing the action. | Build a Channel Settings modal to allow Admins/Creators to set these permissions. |
| Full-Text Search | 🏗️ Pending | Implement a search command (`/search`) to leverage the `FULLTEXT INDEX` on the `messages` table for rapid, server-side content search. | Display a dedicated search results panel. |
