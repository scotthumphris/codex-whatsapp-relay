# Codex WhatsApp Relay

Put Codex in your WhatsApp.

WhatsApp Relay is a Codex plugin that links a local WhatsApp account to Codex, lets Codex read and send WhatsApp messages, and can optionally let you control Codex from an allowed direct chat.

The useful part is the mental model: scan a QR once, let the relay hold the WhatsApp session, and keep talking to Codex from your phone. Under the hood it uses `codex app-server`, so phone-controlled chats map to native Codex threads that can be resumed later in Codex and across WhatsApp messages.

## Why It Is Fun

- message yourself and treat that chat like a lightweight Codex client
- ask Codex to ping someone on WhatsApp without leaving your terminal
- keep a real Codex thread going from your phone with `/new`, `/status`, `/stop`, and `/help`
- use the same relay for chat inspection, message sending, and phone control
- resume in your terminal with `codex resume`

## Install In Codex

Paste this prompt into Codex:

```text
Install the WhatsApp Relay plugin globally for my user account.

Use this repository as the source:
https://github.com/abuiles/codex-whatsapp-relay-plugin

Do all of the following:

1. Clone the repo into ~/.codex/plugins/whatsapp-relay if it does not exist yet.
2. If it already exists, update it from origin/main without deleting unrelated user files.
3. Run npm install inside ~/.codex/plugins/whatsapp-relay.
4. Create or update ~/.agents/plugins/marketplace.json so it contains a personal marketplace entry for this plugin.
5. Keep any existing marketplace entries that are already there.
6. Make sure the plugin entry uses:
   - name: whatsapp-relay
   - source.source: local
   - source.path: ./.codex/plugins/whatsapp-relay/plugins/whatsapp-relay
   - policy.installation: AVAILABLE
   - policy.authentication: ON_USE
   - category: Productivity
7. Do not create a repo-local marketplace entry.
8. After writing the marketplace file, tell me to restart Codex.
9. After restart, tell me to open /plugins and install WhatsApp Relay.

Do not push or publish anything. Only set up the local personal marketplace install.
```

## After Install

1. Restart Codex.
2. Open `/plugins`.
3. Install `WhatsApp Relay`.
4. Ask Codex to ping you on WhatsApp.

If WhatsApp is not linked yet, Codex should first run the auth flow, wait for you to scan the QR code, verify the session, and then send the ping. If you want phone control, ask Codex to enable it. If you use the same WhatsApp account on your phone, `Message yourself` can be used as the control surface.

## How It Works

```text
Your phone <-> WhatsApp Relay <-> Codex thread
```

1. Link a local WhatsApp session by scanning the QR shown in Codex output.
2. Codex can inspect chats, read cached messages, sync history, and send replies through MCP tools.
3. If you enable phone control, allowed direct chats continue a persistent `codex app-server` thread from WhatsApp.

## Try It

- "Link my WhatsApp account and verify the auth status."
- "Show my unread WhatsApp chats."
- "Send a WhatsApp message to Alice saying I'll be there in 10 minutes."
- "Allow my number and start WhatsApp Relay so I can control Codex from WhatsApp."

## Phone Commands

Once the controller bridge is running, allowed direct chats can send:

- plain text to continue the current Codex session
- `/new` to start a fresh session
- `/status` to inspect the active session
- `/stop` to cancel the in-flight Codex run
- `/help` to see command help

## What It Does

- links WhatsApp with a QR shown in Codex output
- lets Codex inspect recent chats and messages
- lets Codex send WhatsApp messages
- can sync older history on demand
- can expose Codex through WhatsApp for allowed phone numbers

## CLI Fallback

If you need to test outside Codex:

```bash
npm run whatsapp:auth
npm run whatsapp:controller
npm run whatsapp:status
```
