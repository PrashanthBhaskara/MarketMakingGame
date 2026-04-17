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

const TICK = 0.25;
const app = {
  ws: null,
  state: null,
  clientId: null,
  countdownTimer: null,
};

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  bindElements();
  bindEvents();
  app.countdownTimer = window.setInterval(updateCountdown, 100);
});

function bindElements() {
  [
    "connectionStatus",
    "connectPanel",
    "lobbyPanel",
    "gamePanel",
    "showdownPanel",
    "playerNameInput",
    "roomCodeInput",
    "marketsPerStageInput",
    "responseSecondsInput",
    "feeStage0Input",
    "feeStage1Input",
    "feeStage2Input",
    "fillBotsInput",
    "practiceModeInput",
    "createRoomButton",
    "joinRoomButton",
    "connectError",
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

function bindEvents() {
  els.createRoomButton.addEventListener("click", () => {
    withSocket(() => send({
      type: "create_room",
      name: localPlayerName(),
      settings: readSettings(),
    }));
  });

  els.joinRoomButton.addEventListener("click", () => {
    withSocket(() => send({
      type: "join_room",
      name: localPlayerName(),
      code: els.roomCodeInput.value.trim().toUpperCase(),
    }));
  });
}

function withSocket(onOpen) {
  clearError();
  if (app.ws && app.ws.readyState === WebSocket.OPEN) {
    onOpen();
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  app.ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
  setConnection("Connecting...");

  app.ws.addEventListener("open", () => {
    setConnection("Connected", true);
    onOpen();
  }, { once: true });

  app.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    handleMessage(message);
  });

  app.ws.addEventListener("close", () => {
    setConnection("Disconnected");
    showError("Connection closed. Refresh to reconnect.");
  });

  app.ws.addEventListener("error", () => {
    setConnection("Connection error");
    showError("Could not connect to the multiplayer server.");
  });
}

function handleMessage(message) {
  if (message.type === "hello") {
    app.clientId = message.clientId;
    return;
  }
  if (message.type === "error") {
    showError(message.message);
    return;
  }
  if (message.type === "state") {
    app.state = message;
    clearError();
    render();
  }
}

function send(payload) {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN) {
    showError("Socket is not connected.");
    return;
  }
  app.ws.send(JSON.stringify(payload));
}

function render() {
  const state = app.state;
  if (!state) {
    return;
  }

  els.connectPanel.hidden = true;
  els.lobbyPanel.hidden = state.room.status !== "lobby";
  els.gamePanel.hidden = state.room.status === "lobby";
  els.showdownPanel.hidden = state.room.phase !== "finished";

  if (state.room.status === "lobby") {
    renderLobby();
    return;
  }

  renderPlayers();
  renderBoard();
  renderSummary();
  renderControls();
  renderLog();
  renderShowdown();
  updateCountdown();
}

function renderLobby() {
  const state = app.state;
  const settings = state.room.settings;
  const isHost = state.you.isHost;
  const seats = state.players.map((player, index) => {
    if (!player) {
      return `<div class="seat-item"><span>Seat ${index + 1}</span><strong>Open</strong></div>`;
    }
    const tags = [player.isYou ? "You" : "", player.isBot ? "Bot" : "Human"].filter(Boolean).join(" / ");
    return `<div class="seat-item"><span>Seat ${index + 1}: ${esc(player.name)}</span><strong>${esc(tags)}</strong></div>`;
  }).join("");

  els.lobbyPanel.innerHTML = `
    <div class="setup-copy">
      <h2>Room <span class="room-code">${esc(state.room.code)}</span></h2>
      <p>Share this code with other players. The host starts the game when the seats are ready.</p>
    </div>
    <div class="lobby-grid">
      <div class="seat-list">${seats}</div>
      <div class="control-grid">
        ${settingsFormHtml(settings, isHost)}
        ${isHost ? `
          <div class="button-row">
            <button class="secondary-button" type="button" data-action="updateSettings">Update settings</button>
            <button class="primary-button" type="button" data-action="startGame">Start game</button>
          </div>
        ` : "<p>Waiting for the host to start the game.</p>"}
      </div>
    </div>
  `;

  if (isHost) {
    els.lobbyPanel.querySelector('[data-action="updateSettings"]').addEventListener("click", () => {
      send({ type: "set_settings", settings: readLobbySettings() });
    });
    els.lobbyPanel.querySelector('[data-action="startGame"]').addEventListener("click", () => {
      send({ type: "start_game" });
    });
  }
}

function settingsFormHtml(settings, enabled) {
  const disabled = enabled ? "" : "disabled";
  return `
    <div class="settings-grid">
      <label>Markets before each reveal
        <input id="lobbyMarketsInput" type="number" min="1" max="10" step="1" value="${esc(settings.marketsPerStage)}" ${disabled}>
      </label>
      <label>Quote response seconds
        <input id="lobbyResponseInput" type="number" min="1" max="30" step="0.5" value="${esc(settings.responseSeconds)}" ${disabled}>
      </label>
      <label>Maker pay before first reveal
        <input id="lobbyFee0Input" type="number" min="0" max="50" step="0.25" value="${esc(settings.stageFees[0])}" ${disabled}>
      </label>
      <label>Maker pay after one reveal
        <input id="lobbyFee1Input" type="number" min="0" max="50" step="0.25" value="${esc(settings.stageFees[1])}" ${disabled}>
      </label>
      <label>Maker pay after two reveals
        <input id="lobbyFee2Input" type="number" min="0" max="50" step="0.25" value="${esc(settings.stageFees[2])}" ${disabled}>
      </label>
      <label class="toggle-label">
        <input id="lobbyFillBotsInput" type="checkbox" ${settings.fillBots ? "checked" : ""} ${disabled}>
        <span>Fill empty seats with bots</span>
      </label>
      <label class="toggle-label">
        <input id="lobbyPracticeInput" type="checkbox" ${settings.practiceMode ? "checked" : ""} ${disabled}>
        <span>Practice mode</span>
      </label>
    </div>
  `;
}

function renderPlayers() {
  const state = app.state;
  const mySeat = state.you.seat;
  const otherPlayers = state.players.filter((player) => player && player.seat !== mySeat);
  els.opponentRow.innerHTML = otherPlayers.map((player) => playerPanelHtml(player, true)).join("");

  const me = state.players[mySeat];
  els.humanSeat.innerHTML = playerPanelInnerHtml(me, false);
}

function playerPanelHtml(player, smallCard) {
  return `<article class="player-panel">${playerPanelInnerHtml(player, smallCard)}</article>`;
}

function playerPanelInnerHtml(player, smallCard) {
  if (!player) return "";
  const maker = app.state.activeStage && app.state.activeStage.maker === player.seat;
  const leader = app.state.auction && app.state.auction.leader === player.seat && app.state.room.phase === "auction";
  const chips = [
    player.isYou ? '<span class="you-chip">You</span>' : "",
    player.isBot ? '<span class="bot-chip">Bot</span>' : "",
    maker ? '<span class="maker-chip">Maker</span>' : "",
    leader ? '<span class="leader-chip">Best width</span>' : "",
    !player.connected ? '<span class="offline-chip">Offline</span>' : "",
  ].join("");

  return `
    <div class="player-heading">
      <span class="player-name">${esc(player.name)}</span>
      <span class="chip-row">${chips}</span>
    </div>
    <div class="card-row">${cardHtml(player.card, !player.card, smallCard)}</div>
    ${statsHtml(player)}
  `;
}

function statsHtml(player) {
  if (player.cash === undefined || player.position === undefined) {
    return `
      <div class="stat-row">
        <div class="stat hidden-stat"><span>Live cash and position</span><strong>Hidden</strong></div>
      </div>
    `;
  }
  const final = player.finalPnl === undefined ? "" : `<div class="stat"><span>Final PNL</span><strong>${fmt(player.finalPnl)}</strong></div>`;
  return `
    <div class="stat-row">
      <div class="stat"><span>Cash</span><strong>${fmt(player.cash)}</strong></div>
      <div class="stat"><span>Position</span><strong>${fmt(player.position)}</strong></div>
      ${final}
    </div>
  `;
}

function renderBoard() {
  const state = app.state;
  els.boardCards.innerHTML = state.board.map((card) => cardHtml(card.hidden ? null : card, card.hidden, false)).join("");

  const marketsLeft = state.room.phase === "finished"
    ? 0
    : state.room.settings.marketsPerStage - state.marketInStage;
  const revealText = state.room.phase === "finished"
    ? "Settlement"
    : `${marketsLeft} market${marketsLeft === 1 ? "" : "s"} to next reveal`;
  els.stageBadge.innerHTML = `
    <span>Board cards revealed</span>
    <strong>${state.revealedCount} / 3</strong>
    <span>${revealText}</span>
  `;
}

function renderSummary() {
  const state = app.state;
  const practiceHidden = state.room.settings.practiceMode && state.room.phase !== "finished";
  if (practiceHidden) {
    els.marketSummary.innerHTML = `
      <h2>Practice mode</h2>
      <p class="hidden-note">Live market state, fair value, cash, and position are hidden until settlement.</p>
    `;
    return;
  }

  const estimate = estimateFromVisibleCards();
  const stageMaker = state.activeStage && state.activeStage.maker !== null
    ? seatName(state.activeStage.maker)
    : "Pending";
  const maxWidth = state.activeStage && state.activeStage.width !== null ? fmt(state.activeStage.width) : "Pending";
  const quoteWidth = state.activeMarket && state.activeMarket.width !== null ? fmt(state.activeMarket.width) : "Pending";
  const marketLabel = state.room.phase === "finished" ? "Complete" : String(state.marketNumber + 1);
  const stageMarket = state.room.phase === "finished"
    ? "Complete"
    : `${Math.min(state.marketInStage + 1, state.room.settings.marketsPerStage)} / ${state.room.settings.marketsPerStage}`;

  els.marketSummary.innerHTML = `
    <h2>Market state</h2>
    <div class="summary-grid">
      <div class="summary-item"><span>Market</span><strong>${esc(marketLabel)}</strong></div>
      <div class="summary-item"><span>Stage market</span><strong>${esc(stageMarket)}</strong></div>
      <div class="summary-item"><span>Stage maker</span><strong>${esc(stageMaker)}</strong></div>
      <div class="summary-item"><span>Max width</span><strong>${esc(maxWidth)}</strong></div>
      <div class="summary-item"><span>Quote width</span><strong>${esc(quoteWidth)}</strong></div>
      <div class="summary-item"><span>Response time</span><strong>${fmt(state.room.settings.responseSeconds)}s</strong></div>
      ${estimate ? `<div class="summary-item"><span>Your fair value</span><strong>${fmt(estimate.mean)}</strong></div>` : ""}
      ${estimate ? `<div class="summary-item"><span>Your range</span><strong>${fmt(estimate.min)} to ${fmt(estimate.max)}</strong></div>` : ""}
    </div>
  `;
}

function renderControls() {
  const phase = app.state.room.phase;
  if (phase === "auction") {
    renderAuctionControls();
  } else if (phase === "quote") {
    renderQuoteControls();
  } else if (phase === "take") {
    renderTakeControls();
  } else if (phase === "between") {
    els.phaseControls.innerHTML = `<h2>Market complete</h2><p>Next market or reveal is coming up.</p>`;
  } else if (phase === "finished") {
    els.phaseControls.innerHTML = `<h2>Game settled</h2><p>Final PNL is cash plus position times the true value.</p>`;
  }
}

function renderAuctionControls() {
  const state = app.state;
  const auction = state.auction;
  const you = state.you.seat;
  const leader = auction ? auction.leader : null;
  const width = auction ? auction.width : null;
  const passed = auction && auction.passed.includes(you);
  const youLead = leader === you;
  const currentText = width === null
    ? "No width has been posted yet."
    : `${seatName(leader)} leads at ${fmt(width)} wide.`;
  const maxBid = width === null ? "" : Math.max(TICK, width - TICK);
  const inputValue = width === null ? "" : fmt(maxBid);

  els.phaseControls.innerHTML = `
    <h2>Stage auction</h2>
    <p>${esc(currentText)} The winner makes the next ${state.room.settings.marketsPerStage} markets at that width or tighter.</p>
    <div class="control-grid">
      <label>
        ${width === null ? "Opening width" : "Your tighter width"}
        <input id="auctionWidthInput" type="number" min="${TICK}" step="${TICK}" value="${esc(inputValue)}" ${youLead || passed ? "disabled" : ""}>
      </label>
      <div class="button-row">
        <button class="primary-button" type="button" data-action="bid" ${youLead || passed ? "disabled" : ""}>${width === null ? "Post width" : "Bid tighter"}</button>
        <button class="secondary-button" type="button" data-action="pass" ${width === null || youLead || passed ? "disabled" : ""}>Pass</button>
      </div>
      <p>${youLead ? "You are currently leading." : passed ? "You passed this auction." : ""}</p>
    </div>
    <div class="quote-box">
      <h3>Auction tape</h3>
      <p>${auction && auction.history.length ? auction.history.map(esc).join("<br>") : "Waiting for the first width."}</p>
    </div>
  `;
  const bidButton = els.phaseControls.querySelector('[data-action="bid"]');
  const passButton = els.phaseControls.querySelector('[data-action="pass"]');
  bidButton.addEventListener("click", () => {
    const input = document.getElementById("auctionWidthInput");
    send({ type: "auction_bid", width: Number(input.value) });
  });
  passButton.addEventListener("click", () => send({ type: "auction_pass" }));
}

function renderQuoteControls() {
  const state = app.state;
  const maker = state.activeStage ? state.activeStage.maker : null;
  const youMake = maker === state.you.seat;
  if (!youMake) {
    els.phaseControls.innerHTML = `
      <h2>${esc(seatName(maker))} is posting a quote</h2>
      <div id="countdown" class="countdown"></div>
      <p>The market maker must quote before the timer expires.</p>
    `;
    updateCountdown();
    return;
  }

  const maxWidth = state.activeStage.width;
  const practice = state.room.settings.practiceMode;
  const estimate = estimateFromVisibleCards();
  const defaultMid = !practice && estimate ? roundToTick(estimate.mean - currentPosition() * 0.45) : "";
  const width = maxWidth;
  const bidPreview = defaultMid === "" ? "--" : fmt(roundToTick(defaultMid - width / 2));
  const askPreview = defaultMid === "" ? "--" : fmt(roundToTick(defaultMid + width / 2));

  els.phaseControls.innerHTML = `
    <h2>Post your market</h2>
    <p>You are making market ${state.activeMarket.marketInStage} of ${state.room.settings.marketsPerStage}. Quote ${fmt(maxWidth)} wide or tighter.</p>
    <div class="quote-box">
      <div class="quote-prices">
        <div class="price-tile bid"><span>Bid preview</span><strong id="bidPreview">${esc(bidPreview)}</strong></div>
        <div class="price-tile ask"><span>Ask preview</span><strong id="askPreview">${esc(askPreview)}</strong></div>
      </div>
      <div id="countdown" class="countdown"></div>
      <label>
        Quote width
        <input id="quoteWidthInput" type="number" min="${TICK}" max="${fmt(maxWidth)}" step="${TICK}" value="${fmt(width)}">
      </label>
      <label>
        Midpoint
        <input id="quoteMidInput" type="number" step="${TICK}" value="${esc(defaultMid)}" placeholder="Enter midpoint">
      </label>
      <button class="primary-button" type="button" data-action="postQuote">Post quote</button>
    </div>
  `;

  const midInput = document.getElementById("quoteMidInput");
  const widthInput = document.getElementById("quoteWidthInput");
  const updatePreview = () => {
    const mid = Number(midInput.value);
    if (!Number.isFinite(mid)) {
      document.getElementById("bidPreview").textContent = "--";
      document.getElementById("askPreview").textContent = "--";
      return;
    }
    const quoteWidth = Math.min(maxWidth, Math.max(TICK, roundToTick(Number(widthInput.value) || maxWidth)));
    document.getElementById("bidPreview").textContent = fmt(roundToTick(mid - quoteWidth / 2));
    document.getElementById("askPreview").textContent = fmt(roundToTick(mid + quoteWidth / 2));
  };
  midInput.addEventListener("input", updatePreview);
  widthInput.addEventListener("input", updatePreview);
  els.phaseControls.querySelector('[data-action="postQuote"]').addEventListener("click", () => {
    send({ type: "post_quote", mid: Number(midInput.value), width: Number(widthInput.value) });
  });
  updateCountdown();
}

function renderTakeControls() {
  const state = app.state;
  const quote = state.quote;
  const you = state.you.seat;
  const youMake = quote.maker === you;
  const abstained = state.humanAbstained.includes(you);

  els.phaseControls.innerHTML = `
    <h2>${youMake ? "Your quote is live" : `${esc(seatName(quote.maker))} is making the market`}</h2>
    <div class="quote-box">
      <div class="quote-prices">
        <div class="price-tile bid"><span>Sell to bid</span><strong>${fmt(quote.bid)}</strong></div>
        <div class="price-tile ask"><span>Buy from ask</span><strong>${fmt(quote.ask)}</strong></div>
      </div>
      <div id="countdown" class="countdown"></div>
      ${youMake ? "<p>Waiting for takers.</p>" : abstained ? "<p>You abstained. Waiting for the quote to close.</p>" : `
        <div class="button-row">
          <button class="danger-button" type="button" data-action="sell">Sell</button>
          <button class="primary-button" type="button" data-action="buy">Buy</button>
          <button class="secondary-button" type="button" data-action="abstain">Abstain</button>
        </div>
      `}
    </div>
  `;

  if (!youMake && !abstained) {
    els.phaseControls.querySelector('[data-action="sell"]').addEventListener("click", () => send({ type: "take", action: "sell" }));
    els.phaseControls.querySelector('[data-action="buy"]').addEventListener("click", () => send({ type: "take", action: "buy" }));
    els.phaseControls.querySelector('[data-action="abstain"]').addEventListener("click", () => send({ type: "take", action: "abstain" }));
  }
  updateCountdown();
}

function renderLog() {
  els.eventLog.innerHTML = app.state.log
    .slice(-100)
    .reverse()
    .map((entry) => `<li>${esc(entry)}</li>`)
    .join("");
}

function renderShowdown() {
  if (app.state.room.phase !== "finished") {
    els.showdownPanel.innerHTML = "";
    return;
  }
  const rows = app.state.players
    .filter(Boolean)
    .map((player) => ({ ...player }))
    .sort((a, b) => b.finalPnl - a.finalPnl);
  const winner = rows[0];
  els.showdownPanel.innerHTML = `
    <h2>Showdown</h2>
    <p>True value: <strong>${fmt(app.state.trueValue)}</strong>. <strong>${esc(winner.name)}</strong> wins.</p>
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
        ${rows.map((player, index) => `
          <tr class="${index === 0 ? "winner-row" : ""}">
            <td>${esc(player.name)}</td>
            <td>${esc(player.card.rank)}</td>
            <td>${fmt(player.cash)}</td>
            <td>${fmt(player.position)}</td>
            <td>${fmt(player.finalPnl)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function updateCountdown() {
  const node = document.getElementById("countdown");
  if (!node || !app.state || !app.state.deadlineMs) return;
  const msLeft = Math.max(0, app.state.deadlineMs - Date.now());
  const seconds = (msLeft / 1000).toFixed(1);
  if (app.state.countdownMode === "quote") {
    node.textContent = `${seconds}s to post the quote. Auto-quote if time expires.`;
  } else if (app.state.quote && app.state.quote.maker === app.state.you.seat) {
    node.textContent = `${seconds}s before takers pass or trade.`;
  } else {
    node.textContent = `${seconds}s before the quote closes.`;
  }
}

function cardHtml(card, hidden, small) {
  const classes = ["playing-card"];
  if (hidden) classes.push("back");
  if (small) classes.push("small");
  if (hidden || !card) {
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
      <span class="card-rank">${esc(card.rank)}</span>
      <span class="card-label">Value ${esc(card.value)}</span>
    </div>
  `;
}

function estimateFromVisibleCards() {
  const me = app.state.players[app.state.you.seat];
  if (!me || !me.card) return null;
  const revealed = app.state.board.filter((card) => !card.hidden);
  const visibleValues = [me.card.value, ...revealed.map((card) => card.value)];
  const visibleSet = new Set(visibleValues);
  const candidates = RANKS.map((card) => card.value).filter((value) => !visibleSet.has(value));
  const picks = 3 + (3 - app.state.revealedCount);
  const dist = sumDistribution(candidates, picks);
  const entries = Array.from(dist.entries());
  const totalCount = entries.reduce((sum, [, count]) => sum + count, 0);
  const meanUnknown = entries.reduce((sum, [total, count]) => sum + total * count, 0) / totalCount;
  const knownSum = visibleValues.reduce((sum, value) => sum + value, 0);
  return {
    mean: knownSum + meanUnknown,
    min: knownSum + Math.min(...dist.keys()),
    max: knownSum + Math.max(...dist.keys()),
  };
}

function sumDistribution(values, picks) {
  const dp = Array.from({ length: picks + 1 }, () => new Map());
  dp[0].set(0, 1);
  values.forEach((value) => {
    for (let count = picks - 1; count >= 0; count -= 1) {
      for (const [total, ways] of dp[count].entries()) {
        dp[count + 1].set(total + value, (dp[count + 1].get(total + value) || 0) + ways);
      }
    }
  });
  return dp[picks];
}

function currentPosition() {
  const me = app.state.players[app.state.you.seat];
  return me && typeof me.position === "number" ? me.position : 0;
}

function seatName(seat) {
  const player = app.state.players[seat];
  return player ? player.name : "Pending";
}

function readSettings() {
  return {
    marketsPerStage: Number(els.marketsPerStageInput.value),
    responseSeconds: Number(els.responseSecondsInput.value),
    stageFees: [
      Number(els.feeStage0Input.value),
      Number(els.feeStage1Input.value),
      Number(els.feeStage2Input.value),
    ],
    fillBots: els.fillBotsInput.checked,
    practiceMode: els.practiceModeInput.checked,
  };
}

function readLobbySettings() {
  return {
    marketsPerStage: Number(document.getElementById("lobbyMarketsInput").value),
    responseSeconds: Number(document.getElementById("lobbyResponseInput").value),
    stageFees: [
      Number(document.getElementById("lobbyFee0Input").value),
      Number(document.getElementById("lobbyFee1Input").value),
      Number(document.getElementById("lobbyFee2Input").value),
    ],
    fillBots: document.getElementById("lobbyFillBotsInput").checked,
    practiceMode: document.getElementById("lobbyPracticeInput").checked,
  };
}

function localPlayerName() {
  return els.playerNameInput.value.trim() || "Player";
}

function setConnection(text, connected = false) {
  els.connectionStatus.textContent = text;
  els.connectionStatus.classList.toggle("connected", connected);
}

function showError(message) {
  els.connectError.textContent = message;
}

function clearError() {
  els.connectError.textContent = "";
}

function fmt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  const rounded = Math.round(number * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0$/, "");
}

function roundToTick(value) {
  return Math.round(value / TICK) * TICK;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
