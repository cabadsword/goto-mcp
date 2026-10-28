# GoTo Call History MCP

A local, read-only MCP server for GoTo Connect call history. It lets an MCP
client read the connected account's identity and one local day of call records.
It is an independent project, not an official GoTo product.

## Download without a GitHub account

[Download the latest ZIP](https://github.com/cabadsword/goto-mcp/releases/latest/download/goto-mcp.zip).
No GitHub account, invitation or Git installation is required. Extract the ZIP
to a local folder. Install Node.js 22, then run `npm ci --ignore-scripts` in the
extracted folder to install the dependencies pinned in `package-lock.json`.
The ZIP does not include Node.js, dependencies, credentials or user records.

For package-manager installation, each release also includes an npm `.tgz`.
It can be installed from its public download URL; no npm account is needed.
Neither download includes an account authorization or a hosted service.

The current source is on the [GitHub main branch](https://github.com/cabadsword/goto-mcp/tree/main).
Developers may clone that repository and use the same `npm ci` command.

## Connect to your MCP client

Register the extracted folder's server with your MCP client. For Codex:

```sh
codex mcp add goto -- node "/absolute/path/to/goto-mcp/src/server.mjs"
```

Replace the example path with the actual server path. Use an absolute Node
executable path if the desktop app does not inherit the terminal's PATH.
Restart/reload the client to load the new tool catalog.

For an npm-installed package, the server is in
`node_modules/goto-call-review-mcp/src/server.mjs`, or use the `goto-mcp` binary
if it is on your PATH. The corresponding authorization binary is `goto-auth`.

## Authorize GoTo on this computer

A GoTo developer OAuth client and the user's own GoTo login are still required.
Public source code does not grant access to anyone's phone account.

Create a private `client.json` in the current user's `.config/goto-mcp` directory.
On macOS/Linux this is `~/.config/goto-mcp/client.json`; on Windows it is
`%USERPROFILE%\.config\goto-mcp\client.json`.

```json
{"client_id":"YOUR_CLIENT_ID","client_secret":"YOUR_CLIENT_SECRET","redirect_uri":"http://127.0.0.1:12021/app/redirect"}
```

The redirect must match the GoTo application's registered redirect exactly.
Keep the secret out of chat, Git, shared folders and screenshots. Restrict the
directory to the local user. Do not copy another person's access/refresh tokens.

In the extracted source folder, run:

```sh
npm run auth
```

Open the printed authorization link, sign in to GoTo and click **Allow**. The
local loopback callback receives the code and saves the tokens automatically.
Do not manually copy or share callback URLs, codes or tokens. If GoTo requires
an administrator's consent, stop that authorization step rather than bypassing it.

The authorization helper requests `cr.v1.read`, `users.v1.read` and
`users.v1.lines.read`. Existing authorization is retained unless you explicitly
use `--reauthorize`; failed login does not delete the old tokens.

The connector renews tokens when needed, serializes concurrent renewals and
saves credentials atomically. POSIX files/directories use 0600/0700; Windows
installations should use a private user-profile folder with appropriate ACLs.
For an existing private configuration directory, set `GOTO_CONFIG_DIR` to its
absolute path in the MCP registration environment. This avoids moving tokens.

## Available tools

- `goto_auth_status`: local authorization status, without exposing credentials.
- `goto_get_identity`: the connected principal, accessible accounts and own lines.
- `goto_get_call_day`: one workday of call history, with source IDs, raw direction,
  call-leg duration and pagination/completeness metadata.

Pacific time is the default; IANA timezones are supported with DST-aware day
boundaries. Failed, limited or partially read results remain unknown, not zero.
Duplicate leg IDs are detected; different legs are not assumed to be distinct
billable activities. Call duration is not evidence of actual work or billability.

Own-user reads are the default. An explicit `user_key` can request another
user's records only when GoTo permits that read. Provider permissions govern
access; this connector does not grant administrator privileges. Cross-user
authorization has not been live-qualified by this project.

There are no outbound-call, SMS, voicemail mutation, audio download, transcription,
notification-subscription, email-delivery or other business-record write tools.
The only POST requests are GoTo OAuth token exchange/renewal. Broader scopes on
an existing token do not add tools to this release. There is no cloud deployment,
transcription model or additional AI API key required.

## Ask Codex to install it

> Install GoTo MCP from https://github.com/cabadsword/goto-mcp/tree/main.
> Use the public release ZIP if Git is unavailable; do not ask me to create or
> sign in to a GitHub account. Read the README, install missing dependencies and
> register the server without changing my other MCP connections. Reuse valid
> existing GoTo authorization when configured. If credentials are missing, ask
> me to enter the OAuth client ID and secret securely on this computer, not in
> chat. Start the authorization helper and open its link; pause for my GoTo login
> and Allow click, then receive the callback automatically. After any required
> client restart, verify my identity and perform a read-only own-account test.
> Do not change provider permissions, transcribe, send messages, or write records.

## Tests and local development

`npm test` runs synthetic tests without using live credentials. The initial
public version passed 18 tests on macOS, including pagination, DST, token renewal,
permission failures, protocol validation and a clean-profile symlink launch.
These tests do not qualify every Windows configuration or cross-user access.

For an explicitly authorized live own-account read:

```sh
node scripts/smoke.mjs YYYY-MM-DD /absolute/private/result.json
```

The result can contain personal call information. Save it outside the source
checkout, in a private directory, and never upload it as a test fixture or issue
attachment. No live responses, phone records, credentials, private integration
links or client-specific rules are included in this public project.

`npm pack` builds the installable package from the allowlisted source files.

References: [GoTo API](https://developer.goto.com/GoToConnect/),
[GoTo OAuth clients](https://developer.goto.com/guides/Get%20Started/02_HOW_createClient/),
[GoTo token renewal](https://developer.goto.com/guides/Authentication/05_HOW_refreshToken/),
[Codex MCP setup](https://learn.chatgpt.com/docs/extend/mcp).
