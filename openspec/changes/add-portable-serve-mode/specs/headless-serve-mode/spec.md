## ADDED Requirements

### Requirement: Serve mode launch parameter

The portable executable SHALL start the read-only web sidecar instead of the desktop GUI when launched with the `--serve` flag, and SHALL accept `--port <n>` to override the default listening port of 8666. When `--serve` is absent, the executable SHALL launch the desktop GUI exactly as before.

#### Scenario: Launching with the serve flag

- **WHEN** the portable executable is launched as `OneFolder-<version>-x64.exe --serve`
- **THEN** no application window and no preview window are created
- **AND** an HTTP server begins listening on port 8666
- **AND** the process remains running until it is terminated

#### Scenario: Overriding the port

- **WHEN** the portable executable is launched as `OneFolder-<version>-x64.exe --serve --port 9000`
- **THEN** the HTTP server listens on port 9000 instead of 8666

#### Scenario: Launching without the flag

- **WHEN** the portable executable is launched with no arguments
- **THEN** the desktop GUI opens with its main and preview windows
- **AND** no HTTP listener is opened

### Requirement: Serve mode binds the portable context

Serve mode SHALL operate on the same portable context the desktop application uses: the `data\` directory next to the executable, the active library recorded in that directory's library registry, that library's SQLite database, that library's thumbnail cache, and the exiftool binary shipped with the application. Serve mode SHALL NOT re-derive these paths independently of the desktop launch path.

#### Scenario: Serving the active library

- **WHEN** serve mode starts and the library registry records an active library
- **THEN** the served gallery lists the files of that same library
- **AND** thumbnails are read from and written to that library's existing thumbnail cache

#### Scenario: No active library

- **WHEN** serve mode starts and no active library exists in the registry
- **THEN** the process reports that no library was found and exits without starting a listener

### Requirement: Authentication is optional

The server SHALL require authentication only when a credential is configured. When no credential is configured, the server SHALL serve every request without an authentication gate rather than rejecting requests.

#### Scenario: No credential configured

- **WHEN** the server starts with no credential configured
- **THEN** requests to the SPA and to every `/api` route are served normally
- **AND** no `401` response and no `WWW-Authenticate` challenge is produced on account of missing credentials

#### Scenario: Credential configured

- **WHEN** the server starts with a credential configured
- **AND** a request arrives with no valid `Authorization` header and no valid session cookie
- **THEN** the server responds `401` with a `WWW-Authenticate: Basic` challenge

#### Scenario: Login endpoint with no credential configured

- **WHEN** no credential is configured
- **AND** a client posts to the login endpoint
- **THEN** the server responds successfully without error
- **AND** no session cookie is required for subsequent requests

### Requirement: Network exposure is disclosed at startup

The server SHALL bind all network interfaces so the library is reachable from other devices on the local network. On startup it SHALL disclose, in both the log and standard output, every URL on which it is reachable and whether authentication is active.

#### Scenario: Startup disclosure with authentication disabled

- **WHEN** the server starts with no credential configured on a machine with LAN address `192.168.1.42`
- **THEN** the startup banner records the listening port, the loopback URL, and `http://192.168.1.42:8666`
- **AND** the banner states that authentication is disabled

#### Scenario: Startup disclosure with authentication enabled

- **WHEN** the server starts with an explicit user and password configured
- **THEN** the startup banner states that authentication is enabled and names the user
- **AND** the banner does not contain the password

#### Scenario: Startup disclosure with a shared secret

- **WHEN** the server starts with a shared secret configured, where the user name and the password are the same string
- **THEN** the startup banner states that authentication is enabled without naming the user
- **AND** the banner does not contain the secret

### Requirement: Serve mode logging survives the absent console

Serve mode SHALL write its startup banner, request-handling errors, and shutdown messages to a log file inside the portable `data\` directory. Correct operation SHALL NOT depend on console output being visible, because the executable is a Windows GUI-subsystem binary whose standard output does not reliably attach to a parent console.

#### Scenario: Log file is written

- **WHEN** serve mode starts
- **THEN** a log file exists in the portable `data\` directory containing the startup banner
- **AND** the banner content is present in the file whether or not any console received it

#### Scenario: Startup failure is recorded

- **WHEN** serve mode cannot start because the port is already in use
- **THEN** the failure and its cause are written to the log file before the process exits

### Requirement: Serve mode coexists with the desktop application

Serve mode SHALL NOT be blocked by, and SHALL NOT block, a running desktop instance of the application. A second serve-mode process on the same port SHALL fail with a port-in-use error rather than silently exiting or terminating the first. A serve-mode process that fails to start SHALL release the database handle and the exiftool child process it had already opened, so that a failed launch leaves nothing running behind it.

#### Scenario: Desktop already running

- **WHEN** the desktop GUI is already running
- **AND** the executable is launched with `--serve`
- **THEN** the server starts normally and serves the library
- **AND** the running desktop instance is neither closed nor focused

#### Scenario: Serve mode already running

- **WHEN** a serve-mode process is already listening on the configured port
- **AND** a second serve-mode process is launched on the same port
- **THEN** the second process reports a port-in-use error and exits
- **AND** the first process continues serving

#### Scenario: A failed start leaves no orphaned processes

- **WHEN** serve mode opens the library database and the exiftool child process
- **AND** the listener then fails to bind
- **THEN** both are closed before the failure is reported
- **AND** no exiftool process outlives the exited serve-mode process

### Requirement: Serve mode preserves the read-only boundary

Serve mode SHALL open the library database read-only and SHALL expose no endpoint that writes to the library, matching the existing sidecar contract. Write attempts reaching the web client SHALL continue to fail loudly rather than silently no-op.

#### Scenario: Database is opened read-only

- **WHEN** serve mode starts
- **THEN** the library database connection is read-only
- **AND** no HTTP route can modify files, tags, or database rows

### Requirement: A single sidecar implementation

The application SHALL provide exactly one way to run the web sidecar. The served web experience — gallery, search, thumbnails, previews for non-web formats, and metadata reads — SHALL be identical to what the previously separate standalone server delivered, because the same server implementation runs in both cases.

#### Scenario: Removed build targets

- **WHEN** a developer invokes the removed `package:headless`, `build:server`, or `dev:server` scripts
- **THEN** the script does not exist

#### Scenario: Parity of the served experience

- **WHEN** a browser loads the served SPA in serve mode
- **THEN** the gallery lists files, search and filtering work, thumbnails render, non-web formats such as HEIC and PSD render server-decoded previews, and metadata reads return values
- **AND** these behave the same as they did when served by the standalone server build
