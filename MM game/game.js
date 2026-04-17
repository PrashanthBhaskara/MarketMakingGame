"use strict";

const RANKS = [
  ["2", 2],
  ["3", 3],
  ["4", 4],
  ["5", 5],
  ["6", 6],
  ["7", 7],
  ["8", 8],
  ["9", 9],
  ["10", 10],
  ["J", 11],
  ["Q", 12],
  ["K", 13],
  ["A", 14],
].map(([rank, value]) => ({ rank, value }));

const PLAYER_NAMES = ["You", "North", "East", "West"];
const HUMAN = 0;
const TICK = 0.25;
const BOT_SEATS = [1, 2, 3];

const els = {};
const state = {
  started: false,
  players: [],
  board: [],
  revealedCount: 0,
  marketsPerStage: 5,
  responseSeconds: 3,
  hideLiveAids: false,
  marketInStage: 0,
  marketNumber: 0,
  stageFees: [2, 2, 2],
  phase: "setup",
  auction: null,
  activeStage: null,
  quote: null,
  activeMarket: null,
  timers: [],
  countdownTimer: null,
  countdownEndsAt: 0,
  countdownMode: null,
  pendingBotPlans: [],
  humanAbstained: false,
  log: [],
  trueValue: 0,
};

document.addEventListener("DOMContentLoaded", () => {
  bindElements();
  bindStaticEvents();
  render();
});

function bindElements() {
  [
    "setupPanel",
    "gamePanel",
    "showdownPanel",
    "startButton",
    "resetButton",
    "clearLogButton",
    "marketsPerStageInput",
    "responseSecondsInput",
    "hideAidsInput",
    "feeStage0Input",
    "feeStage1Input",
    "feeStage2Input",
    "opponentRow",
    "boardCards",
    "stageBadge",
    "humanSeat",
    "marketSummary",
    "phaseControls",
    "eventLog",
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function bindStaticEvents() {
  els.startButton.addEventListener("click", startGame);
  els.resetButton.addEventListener("click", startGame);
  els.clearLogButton.addEventListener("click", () => {
    state.log = [];
    renderLog();
  });
}

function startGame() {
  clearAllTimers();

  state.started = true;
  state.marketsPerStage = clampInt(readNumber(els.marketsPerStageInput, 5), 1, 10);
  state.responseSeconds = clamp(readNumber(els.responseSecondsInput, 3), 1, 30);
  state.hideLiveAids = Boolean(els.hideAidsInput.checked);
  state.stageFees = [
    clamp(readNumber(els.feeStage0Input, 2), 0, 50),
    clamp(readNumber(els.feeStage1Input, 2), 0, 50),
    clamp(readNumber(els.feeStage2Input, 2), 0, 50),
  ];
  state.revealedCount = 0;
  state.marketInStage = 0;
  state.marketNumber = 0;
  state.phase = "auction";
  state.auction = null;
  state.activeStage = null;
  state.quote = null;
  state.activeMarket = null;
  state.log = [];
  state.trueValue = 0;

  const deck = shuffle(RANKS.map((card) => ({ ...card })));
  state.players = PLAYER_NAMES.map((name, index) => ({
    name,
    index,
    isHuman: index === HUMAN,
    card: deck[index],
    cash: 0,
    position: 0,
    risk: index === 1 ? 0.42 : index === 2 ? 0.52 : 0.36,
    style: index === 1 ? "balanced" : index === 2 ? "patient" : "aggressive",
  }));
  state.board = deck.slice(4, 7);

  addLog(`<strong>Deal:</strong> your private card is ${state.players[HUMAN].card.rank}.`);
  addLog(`<strong>Opening stage:</strong> ${state.marketsPerStage} markets before the first board reveal.`);
  els.setupPanel.hidden = true;
  els.gamePanel.hidden = false;
  els.showdownPanel.hidden = true;

  startStageAuction();
}

function showSetup() {
  clearAllTimers();
  state.started = false;
  state.phase = "setup";
  state.auction = null;
  state.activeStage = null;
  state.quote = null;
  state.activeMarket = null;
  render();
}

function startStageAuction() {
  clearAllTimers();
  state.phase = "auction";
  state.quote = null;
  state.activeMarket = null;
  state.activeStage = {
    stage: state.revealedCount,
    maker: null,
    width: null,
    fee: currentMakerFee(),
  };

  const botProfiles = {};
  BOT_SEATS.forEach((seat) => {
    botProfiles[seat] = makeBotAuctionProfile(seat);
  });

  const opening = BOT_SEATS
    .map((seat) => ({ seat, width: botProfiles[seat].opener }))
    .sort((a, b) => a.width - b.width || botProfiles[a.seat].reserve - botProfiles[b.seat].reserve)[0];

  state.auction = {
    leader: opening.seat,
    width: opening.width,
    botProfiles,
    humanPassed: false,
    history: [`${playerName(opening.seat)} opens at ${fmt(opening.width)} wide.`],
  };

  addLog(`<strong>Stage ${state.revealedCount + 1} auction:</strong> ${playerName(opening.seat)} leads at ${fmt(opening.width)} wide.`);
  render();
}

function submitHumanWidth() {
  const widthInput = document.getElementById("auctionWidthInput");
  const error = document.getElementById("auctionError");
  const width = roundToTick(readNumber(widthInput, NaN));

  if (!Number.isFinite(width) || width < TICK) {
    error.textContent = "Enter a positive width.";
    return;
  }
  if (width >= state.auction.width) {
    error.textContent = `Bid below the current ${fmt(state.auction.width)} width.`;
    return;
  }

  state.auction.leader = HUMAN;
  state.auction.width = width;
  state.auction.history.push(`You undercut to ${fmt(width)} wide.`);
  addLog(`<strong>Auction:</strong> you bid ${fmt(width)} wide.`);

  const botMove = findBotUndercut();
  if (botMove) {
    applyBotUndercut(botMove);
    addLog(`<strong>Auction:</strong> ${playerName(botMove.seat)} undercuts to ${fmt(state.auction.width)} wide.`);
    render();
    return;
  }

  electMarketMaker();
}

function passHumanAuction() {
  state.auction.humanPassed = true;
  state.auction.history.push("You pass.");
  addLog("<strong>Auction:</strong> you pass.");

  let guard = 0;
  while (guard < 60) {
    const botMove = findBotUndercut();
    if (!botMove) break;
    applyBotUndercut(botMove, true);
    guard += 1;
  }

  electMarketMaker();
}

function findBotUndercut() {
  const currentWidth = state.auction.width;
  const currentLeader = state.auction.leader;
  const candidates = BOT_SEATS
    .filter((seat) => seat !== currentLeader)
    .map((seat) => ({ seat, profile: state.auction.botProfiles[seat] }))
    .filter(({ profile }) => profile.reserve <= currentWidth - TICK)
    .sort((a, b) => a.profile.reserve - b.profile.reserve);

  if (!candidates.length) return null;

  const best = candidates[0];
  const reserve = best.profile.reserve;
  const pressure = best.profile.pressure;
  const step = TICK * (1 + Math.floor(Math.random() * (pressure + 1)));
  const width = Math.max(reserve, currentWidth - step);

  return {
    seat: best.seat,
    width: roundToTick(Math.min(currentWidth - TICK, width)),
  };
}

function applyBotUndercut(move, settling = false) {
  state.auction.leader = move.seat;
  state.auction.width = move.width;
  state.auction.history.push(`${playerName(move.seat)} ${settling ? "moves" : "undercuts"} to ${fmt(move.width)} wide.`);
}

function electMarketMaker() {
  clearAllTimers();
  const maker = state.auction.leader;
  const width = state.auction.width;
  const fee = currentMakerFee();

  state.activeStage.maker = maker;
  state.activeStage.width = width;
  state.activeStage.fee = fee;
  state.players[maker].cash += fee;

  addLog(`<strong>Stage maker elected:</strong> ${playerName(maker)} earns ${fmt(fee)} and must quote ${fmt(width)} wide or tighter for the next ${state.marketsPerStage} markets.`);
  beginStageMarket();
}

function beginStageMarket() {
  clearAllTimers();
  const maker = state.activeStage.maker;
  const maxWidth = state.activeStage.width;
  state.quote = null;
  state.activeMarket = {
    number: state.marketNumber + 1,
    stage: state.revealedCount,
    marketInStage: state.marketInStage + 1,
    maker,
    maxWidth,
    width: maxWidth,
  };
  state.phase = "quote";

  if (maker === HUMAN) {
    render();
    startQuoteEntryTimer();
    return;
  }

  postBotQuote(maker);
}

function postBotQuote(maker) {
  const quote = buildBotQuote(maker, state.activeStage.width);
  state.activeMarket.width = quote.width;
  state.quote = quote;
  state.phase = "take";
  addLog(`<strong>Quote:</strong> ${playerName(maker)} posts ${fmt(quote.bid)} bid / ${fmt(quote.ask)} ask.`);
  render();
  startTakerRace();
}

function submitHumanQuote() {
  const result = buildHumanQuoteFromInputs(false);
  const error = document.getElementById("quoteError");

  if (result.error) {
    error.textContent = result.error;
    return;
  }

  applyHumanQuote(result.quote, false);
}

function autoPostHumanQuote() {
  if (state.phase !== "quote" || !state.activeStage || state.activeStage.maker !== HUMAN) {
    return;
  }

  const result = buildHumanQuoteFromInputs(true);
  applyHumanQuote(result.quote, true);
}

function buildHumanQuoteFromInputs(allowFallback) {
  const midInput = document.getElementById("quoteMidInput");
  const widthInput = document.getElementById("quoteWidthInput");
  const fallbackMid = defaultHumanQuoteMid();
  const maxWidth = state.activeStage.width;
  let mid = readNumber(midInput, NaN);
  let width = roundToTick(readNumber(widthInput, NaN));

  if (!Number.isFinite(mid)) {
    if (!allowFallback) {
      return { error: "Enter a midpoint." };
    }
    mid = fallbackMid;
  }
  if (!Number.isFinite(width) || width < TICK) {
    if (!allowFallback) {
      return { error: "Enter a positive width." };
    }
    width = maxWidth;
  }
  if (width > maxWidth) {
    if (!allowFallback) {
      return { error: `Quote at ${fmt(maxWidth)} wide or tighter.` };
    }
    width = maxWidth;
  }

  width = roundToTick(clamp(width, TICK, maxWidth));
  const bid = roundToTick(mid - width / 2);
  const ask = roundToTick(mid + width / 2);
  if (ask <= bid) {
    return { error: "Ask must be above bid." };
  }

  return {
    quote: {
      maker: HUMAN,
      bid,
      ask,
      width: ask - bid,
      mid: roundToTick(mid),
    },
  };
}

function applyHumanQuote(quote, wasAutomatic) {
  state.quote = quote;
  state.activeMarket.width = state.quote.width;
  state.phase = "take";
  addLog(wasAutomatic
    ? `<strong>Auto quote:</strong> timer expired, posting ${fmt(quote.bid)} bid / ${fmt(quote.ask)} ask.`
    : `<strong>Quote:</strong> you post ${fmt(quote.bid)} bid / ${fmt(quote.ask)} ask.`);
  render();
  startTakerRace();
}

function startQuoteEntryTimer() {
  const responseMs = quoteResponseMs();
  state.countdownMode = "quote";
  state.countdownEndsAt = Date.now() + responseMs;
  state.countdownTimer = window.setInterval(renderCountdown, 200);
  state.timers.push(window.setTimeout(autoPostHumanQuote, responseMs));
  renderCountdown();
}

function startTakerRace() {
  clearAllTimers();
  const maker = state.quote.maker;
  const responseMs = quoteResponseMs();
  const botTakers = BOT_SEATS.filter((seat) => seat !== maker);
  const botPlans = botTakers
    .map((seat) => makeBotTakePlan(seat, state.quote))
    .filter((plan) => plan.action !== "abstain")
    .sort((a, b) => a.delay - b.delay);

  state.pendingBotPlans = botPlans;
  state.countdownMode = "take";
  state.countdownEndsAt = Date.now() + responseMs;
  state.countdownTimer = window.setInterval(renderCountdown, 200);

  botPlans.forEach((plan) => {
    state.timers.push(window.setTimeout(() => resolveTrade(plan.seat, plan.action, "bot"), plan.delay));
  });

  state.timers.push(window.setTimeout(() => {
    resolveNoTrade(maker === HUMAN ? "All bots pass." : "No one hits the market.");
  }, responseMs));
  renderCountdown();
}

function humanTake(action) {
  if (!state.quote || state.quote.maker === HUMAN) return;

  if (action === "abstain") {
    const remaining = state.pendingBotPlans || [];
    if (!remaining.length) {
      resolveNoTrade("You pass and the bots pass.");
      return;
    }
    state.humanAbstained = true;
    addLog("<strong>Decision:</strong> you abstain.");
    render();
    return;
  }

  resolveTrade(HUMAN, action, "human");
}

function resolveTrade(taker, action, source) {
  if (!state.quote || state.phase !== "take") return;
  clearAllTimers();

  const maker = state.quote.maker;
  const price = action === "buy" ? state.quote.ask : state.quote.bid;
  const takerPlayer = state.players[taker];
  const makerPlayer = state.players[maker];

  if (action === "buy") {
    takerPlayer.position += 1;
    takerPlayer.cash -= price;
    makerPlayer.position -= 1;
    makerPlayer.cash += price;
  } else {
    takerPlayer.position -= 1;
    takerPlayer.cash += price;
    makerPlayer.position += 1;
    makerPlayer.cash -= price;
  }

  const actor = source === "human" ? "you" : playerName(taker);
  const side = action === "buy" ? "buys at the ask" : "sells at the bid";
  addLog(`<strong>Trade:</strong> ${actor} ${side} for ${fmt(price)} against ${playerName(maker)}.`);

  state.phase = "betweenMarkets";
  render();
  scheduleNextMarket();
}

function resolveNoTrade(reason) {
  if (!state.quote || state.phase !== "take") return;
  clearAllTimers();
  addLog(`<strong>No trade:</strong> ${reason}`);
  state.phase = "betweenMarkets";
  render();
  scheduleNextMarket();
}

function scheduleNextMarket() {
  state.timers.push(window.setTimeout(advanceMarket, 450));
}

function advanceMarket() {
  clearAllTimers();
  state.marketNumber += 1;
  state.marketInStage += 1;

  if (state.marketInStage >= state.marketsPerStage) {
    state.marketInStage = 0;
    if (state.revealedCount < 3) {
      const revealedCard = state.board[state.revealedCount];
      state.revealedCount += 1;
      addLog(`<strong>Board reveal:</strong> ${revealedCard.rank} is flipped up.`);
      if (state.revealedCount === 3) {
        settleGame();
        return;
      }
    }
    startStageAuction();
    return;
  }

  beginStageMarket();
}

function settleGame() {
  clearAllTimers();
  state.phase = "finished";
  state.trueValue = [...state.players.map((player) => player.card), ...state.board]
    .reduce((sum, card) => sum + card.value, 0);
  addLog(`<strong>Settlement:</strong> true contract value is ${fmt(state.trueValue)}.`);
  render();
}

function makeBotAuctionProfile(seat) {
  const est = estimateForPlayer(seat);
  const player = state.players[seat];
  const fee = currentMakerFee();
  const invPenalty = Math.abs(player.position) * (0.45 + est.sigma * 0.03);
  const styleOffset = player.style === "aggressive" ? -0.6 : player.style === "patient" ? 0.45 : 0;
  const feeCredit = fee * (0.55 + (player.style === "aggressive" ? 0.08 : 0));
  const riskBase = est.sigma * (0.52 + player.risk * 0.18);
  const reserve = clamp(roundToTick(riskBase + invPenalty - feeCredit + styleOffset), TICK, 14);
  const openerPad = 0.75 + Math.random() * 1.5 + (player.style === "patient" ? 0.5 : 0);
  const pressure = player.style === "aggressive" ? 3 : player.style === "balanced" ? 2 : 1;

  return {
    reserve: roundToTick(reserve),
    opener: roundToTick(clamp(reserve + openerPad, TICK * 2, 18)),
    pressure,
  };
}

function buildBotQuote(maker, maxWidth) {
  const est = estimateForPlayer(maker);
  const player = state.players[maker];
  const width = chooseBotQuoteWidth(maker, maxWidth, est);
  const inventorySkew = player.position * (0.35 + est.sigma * 0.035);
  const uncertaintySkew = player.style === "aggressive" ? 0.12 * (est.mean - publicNaiveEstimate()) : 0;
  const mid = est.mean - inventorySkew + uncertaintySkew;
  let bid = roundToTick(mid - width / 2);
  let ask = roundToTick(mid + width / 2);

  if (ask <= bid) {
    ask = bid + TICK;
  }

  return {
    maker,
    bid,
    ask,
    width: ask - bid,
    mid: roundToTick(mid),
  };
}

function chooseBotQuoteWidth(maker, maxWidth, est) {
  const player = state.players[maker];
  const inventoryCost = Math.abs(player.position) * 0.3;
  const target = est.sigma * (0.48 + player.risk * 0.14) + inventoryCost;
  const styleTighten = player.style === "aggressive" ? 0.35 : player.style === "patient" ? -0.15 : 0.1;
  const desired = roundToTick(target - styleTighten);
  return roundToTick(clamp(desired, TICK, maxWidth));
}

function makeBotTakePlan(seat, quote) {
  const est = estimateForPlayer(seat);
  const player = state.players[seat];
  const currentInv = player.position;
  const riskUnit = player.risk * (0.16 + est.sigma * 0.035);
  const buyInvPenalty = riskUnit * ((currentInv + 1) ** 2 - currentInv ** 2);
  const sellInvPenalty = riskUnit * ((currentInv - 1) ** 2 - currentInv ** 2);
  const buyScore = est.mean - quote.ask - buyInvPenalty;
  const sellScore = quote.bid - est.mean - sellInvPenalty;
  const threshold = 0.25 + est.sigma * 0.035 + (player.style === "patient" ? 0.35 : 0);

  let action = "abstain";
  let score = threshold;
  if (buyScore > threshold || sellScore > threshold) {
    if (buyScore >= sellScore) {
      action = "buy";
      score = buyScore;
    } else {
      action = "sell";
      score = sellScore;
    }
  }

  const urgency = Math.max(0, score - threshold);
  const responseMs = quoteResponseMs();
  const baseDelay = responseMs * (player.style === "aggressive" ? 0.46 : player.style === "patient" ? 0.72 : 0.58);
  const latest = Math.max(350, responseMs - 120);
  const delay = clampInt(baseDelay - urgency * 220 + Math.random() * Math.min(550, responseMs * 0.18), 180, latest);

  return { seat, action, score, delay };
}

function estimateForPlayer(seat) {
  const ownCard = state.players[seat].card;
  const revealedBoard = state.board.slice(0, state.revealedCount);
  const visibleValues = [ownCard, ...revealedBoard].map((card) => card.value);
  const visibleSet = new Set(visibleValues);
  const candidates = RANKS
    .map((card) => card.value)
    .filter((value) => !visibleSet.has(value));
  const unknownCardsInContract = (state.players.length - 1) + (3 - state.revealedCount);
  const knownSum = visibleValues.reduce((sum, value) => sum + value, 0);
  const dist = sumDistribution(candidates, unknownCardsInContract);
  const totalCount = [...dist.values()].reduce((sum, count) => sum + count, 0);
  let meanUnknown = 0;
  for (const [sum, count] of dist.entries()) {
    meanUnknown += sum * count;
  }
  meanUnknown /= totalCount;

  let variance = 0;
  for (const [sum, count] of dist.entries()) {
    variance += ((sum - meanUnknown) ** 2) * count;
  }
  variance /= totalCount;

  const minUnknown = Math.min(...dist.keys());
  const maxUnknown = Math.max(...dist.keys());

  return {
    mean: knownSum + meanUnknown,
    sigma: Math.sqrt(variance),
    min: knownSum + minUnknown,
    max: knownSum + maxUnknown,
    knownSum,
    unknownCardsInContract,
  };
}

function sumDistribution(values, picks) {
  const dp = Array.from({ length: picks + 1 }, () => new Map());
  dp[0].set(0, 1);

  values.forEach((value) => {
    for (let count = picks - 1; count >= 0; count -= 1) {
      for (const [sum, ways] of dp[count].entries()) {
        const next = sum + value;
        dp[count + 1].set(next, (dp[count + 1].get(next) || 0) + ways);
      }
    }
  });

  return dp[picks];
}

function publicNaiveEstimate() {
  const publicValues = state.board.slice(0, state.revealedCount).map((card) => card.value);
  const publicSet = new Set(publicValues);
  const candidates = RANKS.map((card) => card.value).filter((value) => !publicSet.has(value));
  const unknownCount = 4 + (3 - state.revealedCount);
  const mean = average(candidates);
  return publicValues.reduce((sum, value) => sum + value, 0) + mean * unknownCount;
}

function render() {
  els.setupPanel.hidden = state.phase !== "setup";
  els.gamePanel.hidden = state.phase === "setup";
  els.showdownPanel.hidden = state.phase !== "finished";

  if (state.phase === "setup") {
    return;
  }

  renderPlayers();
  renderBoard();
  renderSummary();
  renderControls();
  renderLog();
  renderShowdown();
}

function renderPlayers() {
  const maker = state.activeStage && state.activeStage.maker !== null ? state.activeStage.maker : null;
  const leader = state.auction ? state.auction.leader : null;

  els.opponentRow.innerHTML = BOT_SEATS.map((seat) => {
    const player = state.players[seat];
    const revealPrivate = state.phase === "finished";
    return `
      <article class="player-panel">
        <div class="player-heading">
          <span class="player-name">${player.name}</span>
          <span>${seat === maker ? '<span class="maker-chip">Maker</span>' : ""}${seat === leader && state.phase === "auction" ? '<span class="leader-chip">Best width</span>' : ""}</span>
        </div>
        <div class="card-row">${cardHtml(player.card, !revealPrivate, true)}</div>
        ${statsHtml(player)}
      </article>
    `;
  }).join("");

  const human = state.players[HUMAN];
  els.humanSeat.innerHTML = `
    <div class="player-heading">
      <span class="player-name">Your seat</span>
      <span><span class="you-chip">Private card visible</span>${HUMAN === maker ? '<span class="maker-chip">Maker</span>' : ""}${HUMAN === leader && state.phase === "auction" ? '<span class="leader-chip">Best width</span>' : ""}</span>
    </div>
    <div class="card-row">${cardHtml(human.card, false, false)}</div>
    ${statsHtml(human)}
  `;
}

function statsHtml(player) {
  const finalValue = state.phase === "finished" ? player.cash + player.position * state.trueValue : null;

  if (state.hideLiveAids && state.phase !== "finished") {
    return `
      <div class="stat-row">
        <div class="stat hidden-stat"><span>Live cash and position</span><strong>Hidden</strong></div>
      </div>
    `;
  }

  return `
    <div class="stat-row">
      <div class="stat"><span>Cash</span><strong>${fmt(player.cash)}</strong></div>
      <div class="stat"><span>Position</span><strong>${fmt(player.position)}</strong></div>
      ${finalValue === null ? "" : `<div class="stat"><span>Final PNL</span><strong>${fmt(finalValue)}</strong></div>`}
    </div>
  `;
}

function renderBoard() {
  els.boardCards.innerHTML = state.board.map((card, index) => {
    const hidden = state.phase !== "finished" && index >= state.revealedCount;
    return cardHtml(card, hidden, false);
  }).join("");

  const marketsLeft = state.marketsPerStage - state.marketInStage;
  const revealText = state.revealedCount === 3
    ? "Settlement"
    : `${marketsLeft} market${marketsLeft === 1 ? "" : "s"} to next reveal`;
  els.stageBadge.innerHTML = `
    <span>Board cards revealed</span>
    <strong>${state.revealedCount} / 3</strong>
    <span>${revealText}</span>
  `;
}

function renderSummary() {
  if (state.hideLiveAids && state.phase !== "finished") {
    els.marketSummary.innerHTML = `
      <h2>Practice mode</h2>
      <p class="hidden-note">Live market state, fair value, cash, and position are hidden until settlement.</p>
    `;
    return;
  }

  const humanEstimate = estimateForPlayer(HUMAN);
  const currentFee = currentMakerFee();
  const marketLabel = state.phase === "finished" ? "Complete" : `${state.marketNumber + 1}`;
  const stageMarketLabel = state.phase === "finished"
    ? "Complete"
    : `${Math.min(state.marketInStage + 1, state.marketsPerStage)} / ${state.marketsPerStage}`;
  const stageMaker = state.activeStage && state.activeStage.maker !== null ? playerName(state.activeStage.maker) : "Pending";
  const maxWidth = state.activeStage && state.activeStage.width !== null ? fmt(state.activeStage.width) : "Pending";
  const quoteWidth = state.activeMarket && state.activeMarket.width !== null ? fmt(state.activeMarket.width) : "Pending";

  els.marketSummary.innerHTML = `
    <h2>Market state</h2>
    <div class="summary-grid">
      <div class="summary-item"><span>Market</span><strong>${marketLabel}</strong></div>
      <div class="summary-item"><span>Stage market</span><strong>${stageMarketLabel}</strong></div>
      <div class="summary-item"><span>Stage maker</span><strong>${stageMaker}</strong></div>
      <div class="summary-item"><span>Max width</span><strong>${maxWidth}</strong></div>
      <div class="summary-item"><span>Quote width</span><strong>${quoteWidth}</strong></div>
      <div class="summary-item"><span>Response time</span><strong>${fmt(state.responseSeconds)}s</strong></div>
      <div class="summary-item"><span>Stage maker pay</span><strong>${fmt(currentFee)}</strong></div>
      <div class="summary-item"><span>Your fair value</span><strong>${fmt(humanEstimate.mean)}</strong></div>
      <div class="summary-item"><span>Your range</span><strong>${fmt(humanEstimate.min)} to ${fmt(humanEstimate.max)}</strong></div>
    </div>
  `;
}

function renderControls() {
  if (state.phase === "auction") {
    renderAuctionControls();
  } else if (state.phase === "quote") {
    renderQuoteControls();
  } else if (state.phase === "take") {
    renderTakeControls();
  } else if (state.phase === "betweenMarkets") {
    renderBetweenMarketsControls();
  } else if (state.phase === "finished") {
    els.phaseControls.innerHTML = `
      <h2>Game settled</h2>
      <p>Final PNL is cash plus position times the true contract value.</p>
      <div class="button-row">
        <button class="primary-button" type="button" data-action="new">Play another deal</button>
        <button class="secondary-button" type="button" data-action="setup">Change settings</button>
      </div>
    `;
    els.phaseControls.querySelector('[data-action="new"]').addEventListener("click", startGame);
    els.phaseControls.querySelector('[data-action="setup"]').addEventListener("click", showSetup);
  }
}

function renderAuctionControls() {
  const auction = state.auction;
  const maxBid = Math.max(TICK, auction.width - TICK);
  els.phaseControls.innerHTML = `
    <h2>Market-maker auction</h2>
    <p>${playerName(auction.leader)} leads at ${fmt(auction.width)} wide. Bid tighter to make the next ${state.marketsPerStage} markets for this reveal stage, or pass and let the bots finish the auction.</p>
    <div class="control-grid">
      <label>
        Your width
        <input id="auctionWidthInput" type="number" min="${TICK}" max="${maxBid}" step="${TICK}" value="${fmt(maxBid)}">
      </label>
      <div id="auctionError" class="error-text"></div>
      <div class="button-row">
        <button class="primary-button" type="button" data-action="bid">Bid tighter</button>
        <button class="secondary-button" type="button" data-action="pass">Pass</button>
      </div>
    </div>
    <div class="quote-box">
      <h3>Auction tape</h3>
      <p>${auction.history.slice(-4).join("<br>")}</p>
    </div>
  `;
  els.phaseControls.querySelector('[data-action="bid"]').addEventListener("click", submitHumanWidth);
  els.phaseControls.querySelector('[data-action="pass"]').addEventListener("click", passHumanAuction);
}

function renderQuoteControls() {
  const maxWidth = state.activeStage.width;
  const width = Math.min(maxWidth, Math.max(TICK, state.activeMarket.width));
  const suggestedMid = defaultHumanQuoteMid();
  const showSuggestedMid = !state.hideLiveAids;
  const previewBid = showSuggestedMid ? fmt(roundToTick(suggestedMid - width / 2)) : "--";
  const previewAsk = showSuggestedMid ? fmt(roundToTick(suggestedMid + width / 2)) : "--";
  const midValue = showSuggestedMid ? `value="${fmt(suggestedMid)}"` : "";

  els.phaseControls.innerHTML = `
    <h2>Post your market</h2>
    <p>You are making market ${state.activeMarket.marketInStage} of ${state.marketsPerStage} this stage. Quote ${fmt(maxWidth)} wide or tighter before the timer expires.</p>
    <div class="quote-box">
      <div class="quote-prices">
        <div class="price-tile bid"><span>Bid preview</span><strong id="bidPreview">${previewBid}</strong></div>
        <div class="price-tile ask"><span>Ask preview</span><strong id="askPreview">${previewAsk}</strong></div>
      </div>
      <div id="countdown" class="countdown"></div>
      <label>
        Quote width
        <input id="quoteWidthInput" type="number" min="${TICK}" max="${fmt(maxWidth)}" step="${TICK}" value="${fmt(width)}">
      </label>
      <label>
        Midpoint
        <input id="quoteMidInput" type="number" step="${TICK}" ${midValue} placeholder="Enter midpoint">
      </label>
      <div id="quoteError" class="error-text"></div>
      <button class="primary-button" type="button" data-action="postQuote">Post quote</button>
    </div>
  `;

  const midInput = document.getElementById("quoteMidInput");
  const widthInput = document.getElementById("quoteWidthInput");
  const updatePreview = () => {
    const mid = readNumber(midInput, NaN);
    if (!Number.isFinite(mid)) {
      document.getElementById("bidPreview").textContent = "--";
      document.getElementById("askPreview").textContent = "--";
      return;
    }
    const quoteWidth = Math.min(maxWidth, Math.max(TICK, roundToTick(readNumber(widthInput, width))));
    document.getElementById("bidPreview").textContent = fmt(roundToTick(mid - quoteWidth / 2));
    document.getElementById("askPreview").textContent = fmt(roundToTick(mid + quoteWidth / 2));
  };
  midInput.addEventListener("input", updatePreview);
  widthInput.addEventListener("input", updatePreview);
  els.phaseControls.querySelector('[data-action="postQuote"]').addEventListener("click", submitHumanQuote);
}

function renderTakeControls() {
  const quote = state.quote;
  const maker = quote.maker;
  const canHumanAct = maker !== HUMAN;
  const humanWaiting = canHumanAct && state.humanAbstained;
  const title = maker === HUMAN ? "Bots are trading your quote" : `${playerName(maker)} is making the market`;

  els.phaseControls.innerHTML = `
    <h2>${title}</h2>
    <div class="quote-box">
      <div class="quote-prices">
        <div class="price-tile bid"><span>Sell to bid</span><strong>${fmt(quote.bid)}</strong></div>
        <div class="price-tile ask"><span>Buy from ask</span><strong>${fmt(quote.ask)}</strong></div>
      </div>
      <div id="countdown" class="countdown"></div>
      ${canHumanAct ? "" : `<p>Bots have ${fmt(state.responseSeconds)} seconds to buy, sell, or pass.</p>`}
      ${humanWaiting ? "<p>You abstained. The quote closes when the bots act or the timer expires.</p>" : ""}
      ${canHumanAct && !humanWaiting ? `
        <div class="button-row">
          <button class="danger-button" type="button" data-action="sell">Sell</button>
          <button class="primary-button" type="button" data-action="buy">Buy</button>
          <button class="secondary-button" type="button" data-action="abstain">Abstain</button>
        </div>
      ` : ""}
    </div>
  `;

  if (canHumanAct && !humanWaiting) {
    els.phaseControls.querySelector('[data-action="sell"]').addEventListener("click", () => humanTake("sell"));
    els.phaseControls.querySelector('[data-action="buy"]').addEventListener("click", () => humanTake("buy"));
    els.phaseControls.querySelector('[data-action="abstain"]').addEventListener("click", () => humanTake("abstain"));
    renderCountdown();
  }
  renderCountdown();
}

function renderBetweenMarketsControls() {
  const atRevealBoundary = state.marketInStage + 1 >= state.marketsPerStage;
  const nextText = atRevealBoundary
    ? state.revealedCount === 2
      ? "Revealing the final board card..."
      : "Revealing the next board card..."
    : "Quoting the next market...";
  els.phaseControls.innerHTML = `
    <h2>Market complete</h2>
    <p>${nextText}</p>
  `;
}

function renderCountdown() {
  const node = document.getElementById("countdown");
  if (!node || !state.countdownEndsAt) return;
  const msLeft = Math.max(0, state.countdownEndsAt - Date.now());
  const seconds = (msLeft / 1000).toFixed(1);

  if (state.countdownMode === "quote") {
    node.textContent = `${seconds}s to post your quote. An automatic quote posts if time expires.`;
    return;
  }

  if (state.quote && state.quote.maker === HUMAN) {
    node.textContent = `${seconds}s before bots pass or trade.`;
    return;
  }

  node.textContent = `${seconds}s before the quote closes. Bots can still hit first.`;
}

function renderLog() {
  els.eventLog.innerHTML = state.log
    .slice(-80)
    .map((entry) => `<li>${entry}</li>`)
    .reverse()
    .join("");
}

function renderShowdown() {
  if (state.phase !== "finished") {
    els.showdownPanel.innerHTML = "";
    return;
  }

  const results = state.players
    .map((player) => ({
      ...player,
      pnl: player.cash + player.position * state.trueValue,
    }))
    .sort((a, b) => b.pnl - a.pnl);
  const winner = results[0];
  const privateCards = state.players.map((player) => `${player.name}: ${player.card.rank}`).join(" | ");
  const boardCards = state.board.map((card) => card.rank).join(", ");

  els.showdownPanel.innerHTML = `
    <h2>Showdown</h2>
    <p>True value: <strong>${fmt(state.trueValue)}</strong>. Private cards: ${privateCards}. Board: ${boardCards}.</p>
    <p><strong>${winner.name}</strong> wins the deal.</p>
    <table class="results-table">
      <thead>
        <tr>
          <th>Player</th>
          <th>Private</th>
          <th>Cash</th>
          <th>Position</th>
          <th>Final PNL</th>
        </tr>
      </thead>
      <tbody>
        ${results.map((player, index) => `
          <tr class="${index === 0 ? "winner-row" : ""}">
            <td>${player.name}</td>
            <td>${player.card.rank}</td>
            <td>${fmt(player.cash)}</td>
            <td>${fmt(player.position)}</td>
            <td>${fmt(player.pnl)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function cardHtml(card, hidden, small) {
  const classes = ["playing-card"];
  if (hidden) classes.push("back");
  if (small) classes.push("small");

  if (hidden) {
    return `
      <div class="${classes.join(" ")}">
        <span class="card-label">MM</span>
        <span class="card-rank">?</span>
        <span class="card-label">SUM</span>
      </div>
    `;
  }

  return `
    <div class="${classes.join(" ")}">
      <span class="card-label">Rank</span>
      <span class="card-rank">${card.rank}</span>
      <span class="card-label">Value ${card.value}</span>
    </div>
  `;
}

function currentMakerFee() {
  return state.stageFees[Math.min(state.revealedCount, state.stageFees.length - 1)] || 0;
}

function quoteResponseMs() {
  return Math.max(1, state.responseSeconds) * 1000;
}

function defaultHumanQuoteMid() {
  const estimate = estimateForPlayer(HUMAN);
  return roundToTick(estimate.mean - state.players[HUMAN].position * 0.45);
}

function playerName(seat) {
  return state.players[seat] ? state.players[seat].name : PLAYER_NAMES[seat];
}

function addLog(message) {
  state.log.push(message);
  if (state.log.length > 160) {
    state.log.shift();
  }
}

function clearAllTimers() {
  state.timers.forEach((timer) => window.clearTimeout(timer));
  state.timers = [];
  if (state.countdownTimer) {
    window.clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }
  state.countdownEndsAt = 0;
  state.countdownMode = null;
  state.pendingBotPlans = [];
  state.humanAbstained = false;
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function readNumber(input, fallback) {
  if (!input || input.value === "") return fallback;
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function roundToTick(value) {
  return Math.round(value / TICK) * TICK;
}

function fmt(value) {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0$/, "");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value, min, max) {
  return Math.trunc(clamp(value, min, max));
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
