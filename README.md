# Market Maker Card Game

This project contains two browser versions of the same four-player market-making card game:

- `MM game`: local single-player version where you play against 3 bots.
- `MMgamemultiplayer`: multiplayer version with room codes, WebSockets, server-side hidden information, timers, and bots for empty seats.

## Folder Layout

```text
MMGame/
  MM game/
    index.html
    game.js
    styles.css
    README.md

  MMgamemultiplayer/
    index.html
    client.js
    server.py
    styles.css
    README.md
```

## Quick Start: Single-Player

The single-player version does not need a server.

Open this file in a browser:

```bash
open "/Users/prashanth/Desktop/MMGame/MM game/index.html"
```

Use this version when you want to practice against 3 strategy bots on your own computer.

## Quick Start: Multiplayer

The multiplayer version needs the Python server because the server owns the deck, hidden cards, timers, trades, and room state.

Start the server:

```bash
cd "/Users/prashanth/Desktop/MMGame/MMgamemultiplayer"
python3 server.py
```

Then open:

```text
http://127.0.0.1:8765
```

To let other people on the same Wi-Fi join, give them your local network URL. On macOS, find your local IP with:

```bash
ipconfig getifaddr en0
```

If that returns `10.0.0.9`, other players should open:

```text
http://10.0.0.9:8765
```

If port `8765` is already in use:

```bash
cd "/Users/prashanth/Desktop/MMGame/MMgamemultiplayer"
MM_PORT=9000 python3 server.py
```

Then open:

```text
http://127.0.0.1:9000
```

## Multiplayer Room Flow

1. One player opens the multiplayer page and clicks `Create room`.
2. The page shows a room code.
3. Other players open the same site, enter their name and the room code, then click `Join room`.
4. The host chooses the game settings.
5. The host clicks `Start game`.
6. If `Fill empty seats with bots` is enabled, open seats become bots.

The game supports 1 to 4 human players. If someone disconnects during a game, their seat turns into a bot so the game can continue.

## Game Objective

You are trading a contract whose final value is the sum of all cards in play.

Cards in play:

- 4 private player cards, one per player.
- 3 board cards, initially face down.

The final contract value is:

```text
sum(all 4 private cards) + sum(all 3 board cards)
```

Your goal is to finish with the highest PNL.

Final PNL is:

```text
cash + position * true contract value
```

Example:

```text
Final true value = 55
Your cash = -110
Your position = +3
Final PNL = -110 + 3 * 55 = 55
```

## Deck

The deck has one card of each rank from `2` through `A`.

Card values:

```text
2  = 2
3  = 3
4  = 4
5  = 5
6  = 6
7  = 7
8  = 8
9  = 9
10 = 10
J  = 11
Q  = 12
K  = 13
A  = 14
```

There are no suits in this game.

## Deal

At the start of the game:

1. The deck is shuffled.
2. Each of the 4 players gets 1 private card.
3. Three board cards are placed face down.

You can see:

- Your own private card.
- Any board cards that have been revealed.
- Public market information.

You cannot see:

- Other players' private cards.
- Unrevealed board cards.

In the multiplayer version, hidden information is protected by the server. Your browser is not sent the hidden board cards or other private cards before settlement.

## Reveal Stages

The game is played in stages.

Each stage has:

1. One market-maker auction.
2. A fixed number of quoted markets.
3. A board-card reveal.

The setting `Markets before each reveal` controls how many markets happen before the next board card flips.

Default:

```text
Markets before each reveal = 5
```

That means:

```text
Stage 1: auction, 5 markets, reveal board card 1
Stage 2: auction, 5 markets, reveal board card 2
Stage 3: auction, 5 markets, reveal board card 3, settle game
```

With the default setting, the full game has 15 markets.

If you set `Markets before each reveal` to `3`, the full game has 9 markets.

## Market-Maker Auction

At the start of each reveal stage, players compete to become the market maker.

Each player can post a width. The narrowest width wins.

Example:

```text
North posts 6 wide
You post 5 wide
East posts 4.5 wide
West passes
You pass
East wins
```

The winning market maker must quote the next stage's markets at the winning width or tighter.

Example:

```text
East wins at 4.5 wide
East may quote 4.5 wide, 4 wide, 3 wide, etc.
East may not quote 5 wide
```

The market maker earns the configured maker payment once for that stage.

## Quoting a Market

The market maker posts a bid and ask.

Example:

```text
Bid = 52
Ask = 56
Width = 4
```

Other players can:

- Buy from the ask.
- Sell to the bid.
- Abstain.

Only one player can trade on a market. Whoever acts first gets the trade.

If nobody trades before the timer expires, the market closes with no trade.

## Buying and Selling

If you buy from the ask:

```text
position increases by 1
cash decreases by ask price
```

Example:

```text
You buy at 56
position +1
cash -56
```

If you sell to the bid:

```text
position decreases by 1
cash increases by bid price
```

Example:

```text
You sell at 52
position -1
cash +52
```

The market maker takes the other side of the trade.

## Quote Timer

The setting `Quote response seconds` controls the timer.

It applies to:

- How long takers have to buy, sell, or abstain.
- How long a human market maker has to post a quote.

If a human market maker does not post a quote before the timer expires, the game posts an automatic quote so play can continue.

## Settings

### Markets Before Each Reveal

Number of markets quoted before the next board card is revealed.

Default:

```text
5
```

### Quote Response Seconds

Number of seconds players have to act on a quote. This also applies when a human market maker is entering a quote.

Default:

```text
3
```

### Maker Pay Before First Reveal

Points paid to the market maker for winning the stage before any board card has been revealed.

### Maker Pay After One Reveal

Points paid to the market maker for winning the stage after one board card has been revealed.

### Maker Pay After Two Reveals

Points paid to the market maker for winning the stage after two board cards have been revealed.

### Practice Mode

Practice mode hides live aids so you can practice tracking the game in your head.

It hides:

- Live cash.
- Live position.
- Fair value estimate.
- Market-state aid panel.

At settlement, final cards and PNL are shown.

### Fill Empty Seats With Bots

Multiplayer-only setting.

If enabled, any empty seats become bots when the host starts the game.

If disabled, the room needs 4 human players before the host can start.

## Single-Player Bots

The single-player version always uses 3 bots.

The bots:

- Estimate fair value from the cards they can see.
- Account for unknown-card distributions.
- Adjust quotes based on inventory.
- Decide whether to buy, sell, or abstain based on expected value and risk.
- Compete in the market-maker width auction.

## Multiplayer Bots

The multiplayer version runs bots on the server.

Bots can appear when:

- The host starts with empty seats and `Fill empty seats with bots` is enabled.
- A human disconnects during an active game.

Server-side bots are important because all game state stays authoritative on the server.

## Strategy Notes

The game is about pricing hidden information quickly.

Things to track:

- Your private card.
- Revealed board cards.
- Approximate fair value of the remaining unknown cards.
- Your cash.
- Your position.
- Who is making markets.
- Whether the market maker may be skewing quotes because of inventory.

As a taker:

- Buy when the ask is below your estimate of fair value.
- Sell when the bid is above your estimate of fair value.
- Abstain when the edge is not worth the risk.

As a market maker:

- Quote around your estimate of fair value.
- Use your width limit or tighter.
- Skew your midpoint to reduce dangerous inventory.
- Remember that tighter markets win auctions but create more risk.

## Troubleshooting

### The single-player page does not open

Use:

```bash
open "/Users/prashanth/Desktop/MMGame/MM game/index.html"
```

### The multiplayer page does not work

Make sure the server is running:

```bash
cd "/Users/prashanth/Desktop/MMGame/MMgamemultiplayer"
python3 server.py
```

Then open:

```text
http://127.0.0.1:8765
```

### Other players cannot connect

Check these:

- Everyone is on the same Wi-Fi.
- They are using your local IP, not `127.0.0.1`.
- The server is still running.
- macOS firewall is not blocking incoming connections.

Find your local IP:

```bash
ipconfig getifaddr en0
```

### The port is already in use

Run on a different port:

```bash
cd "/Users/prashanth/Desktop/MMGame/MMgamemultiplayer"
MM_PORT=9000 python3 server.py
```

Then open:

```text
http://127.0.0.1:9000
```

### I want to reset a multiplayer game

Stop the server with `Ctrl+C`, then start it again:

```bash
python3 server.py
```

This clears active rooms because rooms are kept in server memory.
