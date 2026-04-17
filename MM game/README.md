# Market Maker Card Game

A self-contained browser game for the four-player market-making card game.

## Rules implemented

- Deck: one card of each rank from 2 through A. J, Q, K, and A are worth 11, 12, 13, and 14.
- Deal: each player gets one private card. Three board cards are dealt face down.
- Contract: the settlement value is the sum of all four private cards and all three board cards.
- Market-maker auction: each reveal stage starts with one width auction. The narrowest width wins.
- Maker obligation: the elected market maker quotes the next configured number of markets using that width or a tighter width.
- Maker reward: the elected market maker receives the configured payment once for that reveal stage.
- Quote: each market has a timed response window chosen in setup.
- Human market maker: the same timer applies when entering your quote. If it expires, an automatic quote is posted.
- Trading: one taker may buy from the ask, sell to the bid, or abstain. Bots can hit first.
- Reveal schedule: play the configured number of markets, reveal one board card, repeat. The game settles after the third board card is revealed.
- Final PNL: cash plus position times the true contract value.
- Practice mode: optionally hides live cash, position, fair value, and market-state aids until settlement.

## Run

Open `index.html` in a browser.

The game has no build step and no external dependencies.
