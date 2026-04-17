# MM Game Multiplayer

This is a separate multiplayer version of the market-maker card game. It does not modify the single-player `MM game` folder.

## What this version does

- Runs an authoritative server for room state, hidden cards, timers, trades, and bot decisions.
- Uses browser-native WebSockets. No Node, npm, or Python packages are required.
- Supports room creation and joining by room code.
- Lets the host configure markets per reveal, response timer, maker pay by stage, bot-filled empty seats, and practice mode.
- Sends each player a personalized view: your browser receives your private card and revealed board cards, but not other private cards or hidden board cards.
- Supports 1 to 4 humans. Empty seats can be filled with server-side bots.
- Converts disconnected in-game seats to bots so a game can continue.

## Run

From this folder:

```bash
python3 server.py
```

Then open:

```text
http://127.0.0.1:8765
```

For other players on the same Wi-Fi, give them your computer's local network URL:

```text
http://YOUR_LOCAL_IP:8765
```

You can find your local IP on macOS with:

```bash
ipconfig getifaddr en0
```

If you need a different port:

```bash
MM_PORT=9000 python3 server.py
```
