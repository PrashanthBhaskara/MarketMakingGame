#!/usr/bin/env python3
"""Dependency-free multiplayer server for the market-maker card game."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import mimetypes
import os
import random
import secrets
import struct
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
HOST = os.environ.get("MM_HOST", "0.0.0.0")
PORT = int(os.environ.get("MM_PORT", "8765"))
TICK = 0.25
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
RANKS = [
    {"rank": "2", "value": 2},
    {"rank": "3", "value": 3},
    {"rank": "4", "value": 4},
    {"rank": "5", "value": 5},
    {"rank": "6", "value": 6},
    {"rank": "7", "value": 7},
    {"rank": "8", "value": 8},
    {"rank": "9", "value": 9},
    {"rank": "10", "value": 10},
    {"rank": "J", "value": 11},
    {"rank": "Q", "value": 12},
    {"rank": "K", "value": 13},
    {"rank": "A", "value": 14},
]
BOT_NAMES = ["NorthBot", "EastBot", "WestBot", "SouthBot"]
BOT_STYLES = ["balanced", "patient", "aggressive", "balanced"]
BOT_RISKS = [0.42, 0.52, 0.36, 0.46]


@dataclass
class Player:
    seat: int
    name: str
    client_id: str | None = None
    is_bot: bool = False
    connected: bool = True
    card: dict[str, Any] | None = None
    cash: float = 0.0
    position: int = 0
    risk: float = 0.45
    style: str = "balanced"


@dataclass
class Client:
    client_id: str
    writer: asyncio.StreamWriter
    room_code: str | None = None
    seat: int | None = None
    name: str = ""


class Room:
    def __init__(self, code: str, host_id: str, settings: dict[str, Any]):
        self.code = code
        self.host_id = host_id
        self.players: list[Player | None] = [None, None, None, None]
        self.settings = normalize_settings(settings)
        self.status = "lobby"
        self.phase = "lobby"
        self.board: list[dict[str, Any]] = []
        self.revealed_count = 0
        self.market_in_stage = 0
        self.market_number = 0
        self.auction: dict[str, Any] | None = None
        self.active_stage: dict[str, Any] | None = None
        self.active_market: dict[str, Any] | None = None
        self.quote: dict[str, Any] | None = None
        self.deadline_ms: int | None = None
        self.countdown_mode: str | None = None
        self.human_abstained: set[int] = set()
        self.pending_bot_action_seats: set[int] = set()
        self.true_value: float | None = None
        self.log: list[str] = []
        self.tasks: list[asyncio.Task[Any]] = []


CLIENTS: dict[str, Client] = {}
ROOMS: dict[str, Room] = {}


def now_ms() -> int:
    return int(time.time() * 1000)


def clamp(value: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, value))


def clamp_int(value: Any, lo: int, hi: int) -> int:
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        number = lo
    return int(clamp(number, lo, hi))


def round_to_tick(value: float) -> float:
    return round(value / TICK) * TICK


def fmt(value: float | int | None) -> str:
    if value is None:
        return "0"
    rounded = round(float(value), 2)
    if rounded == int(rounded):
        return str(int(rounded))
    return f"{rounded:.2f}".rstrip("0").rstrip(".")


def clean_name(value: Any) -> str:
    name = str(value or "").strip()
    if not name:
        return "Player"
    return name[:24]


def normalize_settings(settings: dict[str, Any]) -> dict[str, Any]:
    fees = settings.get("stageFees") or settings.get("stage_fees") or [2, 2, 2]
    if not isinstance(fees, list):
        fees = [2, 2, 2]
    fees = (fees + [2, 2, 2])[:3]
    return {
        "marketsPerStage": clamp_int(settings.get("marketsPerStage", 5), 1, 10),
        "responseSeconds": clamp(float(settings.get("responseSeconds", 3) or 3), 1, 30),
        "stageFees": [clamp(float(fee or 0), 0, 50) for fee in fees],
        "fillBots": bool(settings.get("fillBots", True)),
        "practiceMode": bool(settings.get("practiceMode", False)),
    }


def make_room_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(5))
        if code not in ROOMS:
            return code


def card_public(card: dict[str, Any] | None) -> dict[str, Any] | None:
    if not card:
        return None
    return {"rank": card["rank"], "value": card["value"]}


def current_maker_fee(room: Room) -> float:
    index = min(room.revealed_count, 2)
    return float(room.settings["stageFees"][index])


def response_ms(room: Room) -> int:
    return int(max(1, float(room.settings["responseSeconds"])) * 1000)


def active_players(room: Room) -> list[Player]:
    return [player for player in room.players if player is not None]


def human_players(room: Room) -> list[Player]:
    return [player for player in active_players(room) if not player.is_bot and player.client_id]


def add_log(room: Room, message: str) -> None:
    room.log.append(message)
    if len(room.log) > 180:
        room.log = room.log[-180:]


def cancel_room_tasks(room: Room) -> None:
    current = asyncio.current_task()
    for task in room.tasks:
        if task is not current and not task.done():
            task.cancel()
    room.tasks = []
    room.deadline_ms = None
    room.countdown_mode = None


def schedule_room_task(room: Room, delay_seconds: float, coro_func, *args) -> None:
    async def runner() -> None:
        try:
            await asyncio.sleep(delay_seconds)
            await coro_func(*args)
        except asyncio.CancelledError:
            return

    task = asyncio.create_task(runner())
    room.tasks.append(task)


async def send_json(client: Client, payload: dict[str, Any]) -> None:
    try:
        await ws_send(client.writer, json.dumps(payload, separators=(",", ":")))
    except (ConnectionError, RuntimeError, OSError):
        await disconnect_client(client.client_id)


async def send_error(client: Client, message: str) -> None:
    await send_json(client, {"type": "error", "message": message})


async def broadcast_room(room: Room) -> None:
    for player in active_players(room):
        if player.is_bot or not player.client_id:
            continue
        client = CLIENTS.get(player.client_id)
        if client:
            await send_json(client, snapshot_for(room, player.seat))


def snapshot_for(room: Room, viewer_seat: int) -> dict[str, Any]:
    viewer = room.players[viewer_seat] if viewer_seat is not None else None
    finished = room.phase == "finished"
    hide_aids = room.settings["practiceMode"] and not finished
    players = []
    for player in room.players:
        if player is None:
            players.append(None)
            continue
        can_see_card = finished or player.seat == viewer_seat
        item = {
            "seat": player.seat,
            "name": player.name,
            "isBot": player.is_bot,
            "connected": player.connected,
            "isYou": player.seat == viewer_seat,
            "card": card_public(player.card) if can_see_card else None,
        }
        if not hide_aids:
            item["cash"] = player.cash
            item["position"] = player.position
        if finished and room.true_value is not None:
            item["cash"] = player.cash
            item["position"] = player.position
            item["finalPnl"] = player.cash + player.position * room.true_value
        players.append(item)

    board = []
    for index, card in enumerate(room.board):
        if finished or index < room.revealed_count:
            board.append({"hidden": False, **card_public(card)})
        else:
            board.append({"hidden": True})

    auction = None
    if room.auction:
        auction = {
            "leader": room.auction.get("leader"),
            "width": room.auction.get("width"),
            "history": list(room.auction.get("history", []))[-8:],
            "passed": sorted(room.auction.get("passed", set())),
        }

    return {
        "type": "state",
        "room": {
            "code": room.code,
            "status": room.status,
            "phase": room.phase,
            "settings": room.settings,
            "hostSeat": seat_for_client(room, room.host_id),
        },
        "you": {
            "seat": viewer_seat,
            "name": viewer.name if viewer else "",
            "isHost": viewer.client_id == room.host_id if viewer else False,
        },
        "players": players,
        "board": board,
        "revealedCount": room.revealed_count,
        "marketNumber": room.market_number,
        "marketInStage": room.market_in_stage,
        "activeStage": room.active_stage,
        "activeMarket": room.active_market,
        "auction": auction,
        "quote": room.quote,
        "deadlineMs": room.deadline_ms,
        "countdownMode": room.countdown_mode,
        "humanAbstained": sorted(room.human_abstained),
        "trueValue": room.true_value if finished else None,
        "log": room.log[-100:],
    }


def seat_for_client(room: Room, client_id: str | None) -> int | None:
    if not client_id:
        return None
    for player in active_players(room):
        if player.client_id == client_id:
            return player.seat
    return None


async def handle_message(client: Client, payload: dict[str, Any]) -> None:
    message_type = payload.get("type")
    if message_type == "create_room":
        await create_room(client, payload)
    elif message_type == "join_room":
        await join_room(client, payload)
    elif message_type == "set_settings":
        await set_settings(client, payload)
    elif message_type == "start_game":
        await start_game(client)
    elif message_type == "auction_bid":
        await submit_auction_bid(client, payload)
    elif message_type == "auction_pass":
        await pass_auction(client)
    elif message_type == "post_quote":
        await post_human_quote(client, payload)
    elif message_type == "take":
        await human_take(client, payload)
    else:
        await send_error(client, "Unknown action.")


async def create_room(client: Client, payload: dict[str, Any]) -> None:
    if client.room_code:
        await send_error(client, "You are already in a room.")
        return
    code = make_room_code()
    room = Room(code, client.client_id, payload.get("settings") or {})
    name = clean_name(payload.get("name"))
    player = Player(seat=0, name=name, client_id=client.client_id, is_bot=False, connected=True)
    room.players[0] = player
    ROOMS[code] = room
    client.room_code = code
    client.seat = 0
    client.name = name
    add_log(room, f"{name} created room {code}.")
    await broadcast_room(room)


async def join_room(client: Client, payload: dict[str, Any]) -> None:
    if client.room_code:
        await send_error(client, "You are already in a room.")
        return
    code = str(payload.get("code", "")).strip().upper()
    room = ROOMS.get(code)
    if not room:
        await send_error(client, "Room not found.")
        return
    if room.status != "lobby":
        await send_error(client, "That game has already started.")
        return

    seat = next((idx for idx, player in enumerate(room.players) if player is None), None)
    if seat is None:
        await send_error(client, "Room is full.")
        return

    name = clean_name(payload.get("name"))
    player = Player(seat=seat, name=name, client_id=client.client_id, is_bot=False, connected=True)
    room.players[seat] = player
    client.room_code = code
    client.seat = seat
    client.name = name
    add_log(room, f"{name} joined seat {seat + 1}.")
    await broadcast_room(room)


async def set_settings(client: Client, payload: dict[str, Any]) -> None:
    room = room_for_client(client)
    if not room:
        await send_error(client, "Join a room first.")
        return
    if client.client_id != room.host_id:
        await send_error(client, "Only the host can change settings.")
        return
    if room.status != "lobby":
        await send_error(client, "Settings can only be changed in the lobby.")
        return
    room.settings = normalize_settings(payload.get("settings") or {})
    add_log(room, "Host updated the room settings.")
    await broadcast_room(room)


async def start_game(client: Client) -> None:
    room = room_for_client(client)
    if not room:
        await send_error(client, "Join a room first.")
        return
    if client.client_id != room.host_id:
        await send_error(client, "Only the host can start the game.")
        return
    if room.status != "lobby":
        await send_error(client, "The game is already running.")
        return
    if not room.settings["fillBots"] and len(human_players(room)) < 4:
        await send_error(client, "Four human players are required unless empty seats are filled with bots.")
        return

    for seat in range(4):
        if room.players[seat] is None:
            room.players[seat] = make_bot_player(seat)

    deck = [dict(card) for card in RANKS]
    random.shuffle(deck)
    for seat, player in enumerate(active_players(room)):
        player.card = deck[seat]
        player.cash = 0.0
        player.position = 0
        player.connected = True if player.is_bot else player.connected
    room.board = deck[4:7]
    room.revealed_count = 0
    room.market_in_stage = 0
    room.market_number = 0
    room.true_value = None
    room.quote = None
    room.active_market = None
    room.active_stage = None
    room.auction = None
    room.human_abstained = set()
    room.pending_bot_action_seats = set()
    room.status = "playing"
    add_log(room, "The deck was shuffled and private cards were dealt.")
    await start_stage_auction(room)


def make_bot_player(seat: int) -> Player:
    return Player(
        seat=seat,
        name=BOT_NAMES[seat % len(BOT_NAMES)],
        is_bot=True,
        connected=True,
        risk=BOT_RISKS[seat % len(BOT_RISKS)],
        style=BOT_STYLES[seat % len(BOT_STYLES)],
    )


async def start_stage_auction(room: Room) -> None:
    cancel_room_tasks(room)
    room.phase = "auction"
    room.quote = None
    room.active_market = None
    room.deadline_ms = None
    room.countdown_mode = None
    room.active_stage = {
        "stage": room.revealed_count,
        "maker": None,
        "width": None,
        "fee": current_maker_fee(room),
    }
    room.auction = {
        "leader": None,
        "width": None,
        "history": [],
        "passed": set(),
        "botProfiles": {},
    }

    for player in active_players(room):
        if player.is_bot:
            room.auction["botProfiles"][player.seat] = make_bot_auction_profile(room, player.seat)

    bot_openers = [
        (seat, profile["opener"], profile["reserve"])
        for seat, profile in room.auction["botProfiles"].items()
    ]
    if bot_openers:
        seat, width, _reserve = sorted(bot_openers, key=lambda item: (item[1], item[2]))[0]
        room.auction["leader"] = seat
        room.auction["width"] = width
        room.auction["history"].append(f"{player_name(room, seat)} opens at {fmt(width)} wide.")

    add_log(room, f"Stage {room.revealed_count + 1} auction started.")
    await maybe_elect_market_maker(room)
    await broadcast_room(room)


async def submit_auction_bid(client: Client, payload: dict[str, Any]) -> None:
    room = room_for_client(client)
    if not room or room.phase != "auction" or not room.auction:
        await send_error(client, "There is no active auction.")
        return
    seat = client.seat
    if seat is None:
        await send_error(client, "You do not have a seat.")
        return
    width = round_to_tick(float(payload.get("width", 0) or 0))
    current_width = room.auction.get("width")
    if width < TICK:
        await send_error(client, "Width must be positive.")
        return
    if current_width is not None and width >= current_width:
        await send_error(client, f"Bid tighter than {fmt(current_width)}.")
        return

    room.auction["leader"] = seat
    room.auction["width"] = width
    room.auction["passed"].discard(seat)
    room.auction["history"].append(f"{player_name(room, seat)} bids {fmt(width)} wide.")
    add_log(room, f"{player_name(room, seat)} bids {fmt(width)} wide.")
    settle_bot_auction(room)
    await maybe_elect_market_maker(room)
    await broadcast_room(room)


async def pass_auction(client: Client) -> None:
    room = room_for_client(client)
    if not room or room.phase != "auction" or not room.auction:
        await send_error(client, "There is no active auction.")
        return
    seat = client.seat
    if seat is None:
        await send_error(client, "You do not have a seat.")
        return
    if room.auction.get("leader") is None:
        await send_error(client, "A width must be posted before passing.")
        return
    if room.auction.get("leader") == seat:
        await send_error(client, "You are currently leading the auction.")
        return
    room.auction["passed"].add(seat)
    room.auction["history"].append(f"{player_name(room, seat)} passes.")
    add_log(room, f"{player_name(room, seat)} passes the auction.")
    await maybe_elect_market_maker(room)
    await broadcast_room(room)


def settle_bot_auction(room: Room) -> None:
    if not room.auction or room.auction.get("width") is None:
        return

    guard = 0
    while guard < 80:
        guard += 1
        current_width = room.auction["width"]
        current_leader = room.auction["leader"]
        candidates = []
        for seat, profile in room.auction["botProfiles"].items():
            if seat == current_leader:
                continue
            if profile["reserve"] <= current_width - TICK:
                candidates.append((profile["reserve"], seat, profile))
        if not candidates:
            return
        _reserve, seat, profile = sorted(candidates)[0]
        pressure = profile["pressure"]
        step = TICK * (1 + random.randrange(pressure + 1))
        width = max(profile["reserve"], current_width - step)
        width = round_to_tick(min(current_width - TICK, width))
        room.auction["leader"] = seat
        room.auction["width"] = width
        room.auction["history"].append(f"{player_name(room, seat)} undercuts to {fmt(width)} wide.")
        add_log(room, f"{player_name(room, seat)} undercuts to {fmt(width)} wide.")


async def maybe_elect_market_maker(room: Room) -> None:
    if not room.auction or room.auction.get("leader") is None:
        return

    settle_bot_auction(room)
    leader = room.auction["leader"]
    human_nonleaders = [
        player.seat for player in human_players(room)
        if player.seat != leader
    ]
    if not all(seat in room.auction["passed"] for seat in human_nonleaders):
        return

    maker = leader
    width = room.auction["width"]
    fee = current_maker_fee(room)
    assert room.active_stage is not None
    room.active_stage["maker"] = maker
    room.active_stage["width"] = width
    room.active_stage["fee"] = fee
    player = room.players[maker]
    if player:
        player.cash += fee
    add_log(room, f"{player_name(room, maker)} wins the stage auction at {fmt(width)} wide and earns {fmt(fee)}.")
    await begin_stage_market(room)


async def begin_stage_market(room: Room) -> None:
    cancel_room_tasks(room)
    assert room.active_stage is not None
    maker = room.active_stage["maker"]
    max_width = room.active_stage["width"]
    room.quote = None
    room.human_abstained = set()
    room.pending_bot_action_seats = set()
    room.active_market = {
        "number": room.market_number + 1,
        "stage": room.revealed_count,
        "marketInStage": room.market_in_stage + 1,
        "maker": maker,
        "maxWidth": max_width,
        "width": max_width,
    }
    room.phase = "quote"

    player = room.players[maker] if maker is not None else None
    if player and player.is_bot:
        await post_bot_quote(room, maker)
        return

    room.countdown_mode = "quote"
    room.deadline_ms = now_ms() + response_ms(room)
    schedule_room_task(room, response_ms(room) / 1000, auto_post_human_quote, room.code)
    await broadcast_room(room)


async def post_bot_quote(room: Room, maker: int) -> None:
    assert room.active_stage is not None
    quote = build_bot_quote(room, maker, room.active_stage["width"])
    await apply_quote(room, quote, f"{player_name(room, maker)} posts {fmt(quote['bid'])} bid / {fmt(quote['ask'])} ask.")


async def post_human_quote(client: Client, payload: dict[str, Any]) -> None:
    room = room_for_client(client)
    if not room or room.phase != "quote" or not room.active_stage:
        await send_error(client, "There is no quote to post.")
        return
    if client.seat != room.active_stage["maker"]:
        await send_error(client, "You are not the market maker.")
        return

    try:
        mid = float(payload.get("mid"))
        width = round_to_tick(float(payload.get("width")))
    except (TypeError, ValueError):
        await send_error(client, "Enter a valid midpoint and width.")
        return

    max_width = room.active_stage["width"]
    if width < TICK:
        await send_error(client, "Width must be positive.")
        return
    if width > max_width:
        await send_error(client, f"Quote {fmt(max_width)} wide or tighter.")
        return

    bid = round_to_tick(mid - width / 2)
    ask = round_to_tick(mid + width / 2)
    if ask <= bid:
        await send_error(client, "Ask must be above bid.")
        return
    quote = {
        "maker": client.seat,
        "bid": bid,
        "ask": ask,
        "width": ask - bid,
        "mid": round_to_tick(mid),
    }
    await apply_quote(room, quote, f"{player_name(room, client.seat)} posts {fmt(bid)} bid / {fmt(ask)} ask.")


async def auto_post_human_quote(room_code: str) -> None:
    room = ROOMS.get(room_code)
    if not room or room.phase != "quote" or not room.active_stage:
        return
    maker = room.active_stage["maker"]
    if maker is None:
        return
    max_width = room.active_stage["width"]
    mid = default_quote_mid(room, maker)
    bid = round_to_tick(mid - max_width / 2)
    ask = round_to_tick(mid + max_width / 2)
    quote = {
        "maker": maker,
        "bid": bid,
        "ask": ask,
        "width": ask - bid,
        "mid": round_to_tick(mid),
    }
    await apply_quote(room, quote, f"Timer expired. {player_name(room, maker)} auto-posts {fmt(bid)} bid / {fmt(ask)} ask.")


async def apply_quote(room: Room, quote: dict[str, Any], log_message: str) -> None:
    cancel_room_tasks(room)
    room.quote = quote
    if room.active_market:
        room.active_market["width"] = quote["width"]
    add_log(room, log_message)
    await start_taker_race(room)


async def start_taker_race(room: Room) -> None:
    cancel_room_tasks(room)
    if not room.quote:
        return
    room.phase = "take"
    room.countdown_mode = "take"
    room.deadline_ms = now_ms() + response_ms(room)
    room.human_abstained = set()
    maker = room.quote["maker"]
    plans = []
    for player in active_players(room):
        if not player.is_bot or player.seat == maker:
            continue
        plan = make_bot_take_plan(room, player.seat, room.quote)
        if plan["action"] != "abstain":
            plans.append(plan)

    room.pending_bot_action_seats = {plan["seat"] for plan in plans}
    for plan in plans:
        schedule_room_task(room, plan["delayMs"] / 1000, resolve_trade, room.code, plan["seat"], plan["action"])

    schedule_room_task(room, response_ms(room) / 1000, resolve_no_trade, room.code, "No one hit the market.")
    await broadcast_room(room)


async def human_take(client: Client, payload: dict[str, Any]) -> None:
    room = room_for_client(client)
    if not room or room.phase != "take" or not room.quote:
        await send_error(client, "There is no active quote.")
        return
    seat = client.seat
    if seat is None:
        await send_error(client, "You do not have a seat.")
        return
    if seat == room.quote["maker"]:
        await send_error(client, "The market maker cannot take their own quote.")
        return

    action = payload.get("action")
    if action in ("buy", "sell"):
        await resolve_trade(room.code, seat, action)
        return
    if action == "abstain":
        room.human_abstained.add(seat)
        add_log(room, f"{player_name(room, seat)} abstains.")
        active_human_takers = [
            player.seat for player in human_players(room)
            if player.seat != room.quote["maker"]
        ]
        if all(taker in room.human_abstained for taker in active_human_takers) and not room.pending_bot_action_seats:
            await resolve_no_trade(room.code, "All human takers abstained.")
            return
        await broadcast_room(room)
        return

    await send_error(client, "Choose buy, sell, or abstain.")


async def resolve_trade(room_code: str, taker: int, action: str) -> None:
    room = ROOMS.get(room_code)
    if not room or room.phase != "take" or not room.quote:
        return
    cancel_room_tasks(room)
    maker = room.quote["maker"]
    price = room.quote["ask"] if action == "buy" else room.quote["bid"]
    taker_player = room.players[taker]
    maker_player = room.players[maker]
    if not taker_player or not maker_player:
        return

    if action == "buy":
        taker_player.position += 1
        taker_player.cash -= price
        maker_player.position -= 1
        maker_player.cash += price
        side = "buys at the ask"
    else:
        taker_player.position -= 1
        taker_player.cash += price
        maker_player.position += 1
        maker_player.cash -= price
        side = "sells to the bid"

    add_log(room, f"{player_name(room, taker)} {side} for {fmt(price)} against {player_name(room, maker)}.")
    room.phase = "between"
    room.deadline_ms = None
    room.countdown_mode = None
    await broadcast_room(room)
    schedule_room_task(room, 0.65, advance_market, room.code)


async def resolve_no_trade(room_code: str, reason: str) -> None:
    room = ROOMS.get(room_code)
    if not room or room.phase != "take":
        return
    cancel_room_tasks(room)
    add_log(room, f"No trade: {reason}")
    room.phase = "between"
    room.deadline_ms = None
    room.countdown_mode = None
    await broadcast_room(room)
    schedule_room_task(room, 0.65, advance_market, room.code)


async def advance_market(room_code: str) -> None:
    room = ROOMS.get(room_code)
    if not room or room.phase not in ("between", "take"):
        return
    cancel_room_tasks(room)
    room.market_number += 1
    room.market_in_stage += 1

    if room.market_in_stage >= room.settings["marketsPerStage"]:
        room.market_in_stage = 0
        if room.revealed_count < 3:
            card = room.board[room.revealed_count]
            room.revealed_count += 1
            add_log(room, f"Board reveal: {card['rank']} flips up.")
            if room.revealed_count == 3:
                await settle_game(room)
                return
        await start_stage_auction(room)
        return

    await begin_stage_market(room)


async def settle_game(room: Room) -> None:
    cancel_room_tasks(room)
    room.phase = "finished"
    room.status = "finished"
    room.true_value = sum(player.card["value"] for player in active_players(room) if player.card) + sum(card["value"] for card in room.board)
    add_log(room, f"Settlement: true contract value is {fmt(room.true_value)}.")
    await broadcast_room(room)


def make_bot_auction_profile(room: Room, seat: int) -> dict[str, float | int]:
    est = estimate_for_player(room, seat)
    player = room.players[seat]
    assert player is not None
    fee = current_maker_fee(room)
    inv_penalty = abs(player.position) * (0.45 + est["sigma"] * 0.03)
    style_offset = -0.6 if player.style == "aggressive" else 0.45 if player.style == "patient" else 0
    fee_credit = fee * (0.55 + (0.08 if player.style == "aggressive" else 0))
    risk_base = est["sigma"] * (0.52 + player.risk * 0.18)
    reserve = clamp(round_to_tick(risk_base + inv_penalty - fee_credit + style_offset), TICK, 14)
    opener_pad = 0.75 + random.random() * 1.5 + (0.5 if player.style == "patient" else 0)
    pressure = 3 if player.style == "aggressive" else 2 if player.style == "balanced" else 1
    return {
        "reserve": round_to_tick(reserve),
        "opener": round_to_tick(clamp(reserve + opener_pad, TICK * 2, 18)),
        "pressure": pressure,
    }


def build_bot_quote(room: Room, maker: int, max_width: float) -> dict[str, Any]:
    est = estimate_for_player(room, maker)
    player = room.players[maker]
    assert player is not None
    width = choose_bot_quote_width(room, maker, max_width, est)
    inventory_skew = player.position * (0.35 + est["sigma"] * 0.035)
    uncertainty_skew = 0.12 * (est["mean"] - public_naive_estimate(room)) if player.style == "aggressive" else 0
    mid = est["mean"] - inventory_skew + uncertainty_skew
    bid = round_to_tick(mid - width / 2)
    ask = round_to_tick(mid + width / 2)
    if ask <= bid:
        ask = bid + TICK
    return {
        "maker": maker,
        "bid": bid,
        "ask": ask,
        "width": ask - bid,
        "mid": round_to_tick(mid),
    }


def choose_bot_quote_width(room: Room, maker: int, max_width: float, est: dict[str, float]) -> float:
    player = room.players[maker]
    assert player is not None
    inventory_cost = abs(player.position) * 0.3
    target = est["sigma"] * (0.48 + player.risk * 0.14) + inventory_cost
    style_tighten = 0.35 if player.style == "aggressive" else -0.15 if player.style == "patient" else 0.1
    desired = round_to_tick(target - style_tighten)
    return round_to_tick(clamp(desired, TICK, max_width))


def make_bot_take_plan(room: Room, seat: int, quote: dict[str, Any]) -> dict[str, Any]:
    est = estimate_for_player(room, seat)
    player = room.players[seat]
    assert player is not None
    current_inv = player.position
    risk_unit = player.risk * (0.16 + est["sigma"] * 0.035)
    buy_inv_penalty = risk_unit * ((current_inv + 1) ** 2 - current_inv ** 2)
    sell_inv_penalty = risk_unit * ((current_inv - 1) ** 2 - current_inv ** 2)
    buy_score = est["mean"] - quote["ask"] - buy_inv_penalty
    sell_score = quote["bid"] - est["mean"] - sell_inv_penalty
    threshold = 0.25 + est["sigma"] * 0.035 + (0.35 if player.style == "patient" else 0)

    action = "abstain"
    score = threshold
    if buy_score > threshold or sell_score > threshold:
        if buy_score >= sell_score:
            action = "buy"
            score = buy_score
        else:
            action = "sell"
            score = sell_score

    urgency = max(0.0, score - threshold)
    window_ms = response_ms(room)
    style_factor = 0.46 if player.style == "aggressive" else 0.72 if player.style == "patient" else 0.58
    base_delay = window_ms * style_factor
    latest = max(350, window_ms - 120)
    delay = clamp(base_delay - urgency * 220 + random.random() * min(550, window_ms * 0.18), 180, latest)
    return {"seat": seat, "action": action, "score": score, "delayMs": int(delay)}


def default_quote_mid(room: Room, seat: int) -> float:
    est = estimate_for_player(room, seat)
    player = room.players[seat]
    assert player is not None
    return round_to_tick(est["mean"] - player.position * 0.45)


def estimate_for_player(room: Room, seat: int) -> dict[str, float]:
    player = room.players[seat]
    if not player or not player.card:
        return {"mean": 56.0, "sigma": 5.0, "min": 0.0, "max": 0.0}
    revealed = room.board[:room.revealed_count]
    visible_values = [player.card["value"], *[card["value"] for card in revealed]]
    visible_set = set(visible_values)
    candidates = [card["value"] for card in RANKS if card["value"] not in visible_set]
    unknown_cards = 3 + (3 - room.revealed_count)
    known_sum = sum(visible_values)
    dist = sum_distribution(candidates, unknown_cards)
    total = sum(dist.values())
    mean_unknown = sum(total_sum * count for total_sum, count in dist.items()) / total
    variance = sum(((total_sum - mean_unknown) ** 2) * count for total_sum, count in dist.items()) / total
    return {
        "mean": known_sum + mean_unknown,
        "sigma": math.sqrt(variance),
        "min": known_sum + min(dist),
        "max": known_sum + max(dist),
    }


def sum_distribution(values: list[int], picks: int) -> dict[int, int]:
    dp: list[dict[int, int]] = [dict() for _ in range(picks + 1)]
    dp[0][0] = 1
    for value in values:
        for count in range(picks - 1, -1, -1):
            for total, ways in list(dp[count].items()):
                dp[count + 1][total + value] = dp[count + 1].get(total + value, 0) + ways
    return dp[picks]


def public_naive_estimate(room: Room) -> float:
    public_values = [card["value"] for card in room.board[:room.revealed_count]]
    public_set = set(public_values)
    candidates = [card["value"] for card in RANKS if card["value"] not in public_set]
    unknown_count = 4 + (3 - room.revealed_count)
    return sum(public_values) + (sum(candidates) / len(candidates)) * unknown_count


def player_name(room: Room, seat: int | None) -> str:
    if seat is None:
        return "Pending"
    player = room.players[seat]
    return player.name if player else f"Seat {seat + 1}"


def room_for_client(client: Client) -> Room | None:
    return ROOMS.get(client.room_code or "")


async def disconnect_client(client_id: str) -> None:
    client = CLIENTS.pop(client_id, None)
    if not client or not client.room_code:
        return
    room = ROOMS.get(client.room_code)
    if not room or client.seat is None:
        return
    player = room.players[client.seat]
    if not player:
        return

    if room.status == "lobby":
        add_log(room, f"{player.name} left the lobby.")
        room.players[client.seat] = None
        if client_id == room.host_id:
            replacement = next((p for p in active_players(room) if not p.is_bot and p.client_id), None)
            if replacement:
                room.host_id = replacement.client_id or room.host_id
            else:
                ROOMS.pop(room.code, None)
                return
    else:
        add_log(room, f"{player.name} disconnected. A bot is taking over that seat.")
        player.connected = True
        player.is_bot = True
        player.client_id = None
        player.name = f"{player.name} Bot"
        player.style = BOT_STYLES[player.seat % len(BOT_STYLES)]
        player.risk = BOT_RISKS[player.seat % len(BOT_RISKS)]
        if room.phase == "quote" and room.active_stage and room.active_stage.get("maker") == player.seat:
            await post_bot_quote(room, player.seat)
            return
        if room.phase == "auction" and room.auction:
            room.auction["botProfiles"][player.seat] = make_bot_auction_profile(room, player.seat)
            settle_bot_auction(room)
            await maybe_elect_market_maker(room)
    await broadcast_room(room)


async def handle_connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        request = await read_http_request(reader)
        if not request:
            writer.close()
            await writer.wait_closed()
            return
        method, raw_path, headers = request
        if headers.get("upgrade", "").lower() == "websocket":
            await handle_websocket(reader, writer, headers)
            return
        await serve_static(writer, method, raw_path)
    except Exception as exc:  # noqa: BLE001
        try:
            body = f"Server error: {exc}".encode("utf-8")
            writer.write(b"HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\n")
            writer.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()


async def read_http_request(reader: asyncio.StreamReader) -> tuple[str, str, dict[str, str]] | None:
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = await reader.read(4096)
        if not chunk:
            return None
        data += chunk
        if len(data) > 65536:
            return None
    header_text = data.split(b"\r\n\r\n", 1)[0].decode("iso-8859-1")
    lines = header_text.split("\r\n")
    method, path, _version = lines[0].split(" ", 2)
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            key, value = line.split(":", 1)
            headers[key.strip().lower()] = value.strip()
    return method, path, headers


async def serve_static(writer: asyncio.StreamWriter, method: str, raw_path: str) -> None:
    parsed = urlparse(raw_path)
    path = unquote(parsed.path)
    if path == "/":
        path = "/index.html"
    file_path = (ROOT / path.lstrip("/")).resolve()
    if not str(file_path).startswith(str(ROOT)) or not file_path.is_file():
        body = b"Not found"
        writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n")
        writer.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body)
        await writer.drain()
        writer.close()
        await writer.wait_closed()
        return
    body = b"" if method == "HEAD" else file_path.read_bytes()
    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    headers = [
        "HTTP/1.1 200 OK",
        f"Content-Type: {content_type}",
        "Cache-Control: no-store",
        f"Content-Length: {len(body)}",
        "Connection: close",
        "",
        "",
    ]
    writer.write("\r\n".join(headers).encode("ascii") + body)
    await writer.drain()
    writer.close()
    await writer.wait_closed()


async def handle_websocket(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, headers: dict[str, str]) -> None:
    key = headers.get("sec-websocket-key")
    if not key:
        writer.close()
        await writer.wait_closed()
        return
    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
    )
    writer.write(response.encode("ascii"))
    await writer.drain()

    client_id = secrets.token_urlsafe(16)
    client = Client(client_id=client_id, writer=writer)
    CLIENTS[client_id] = client
    await send_json(client, {"type": "hello", "clientId": client_id})

    try:
        while True:
            frame = await ws_read_frame(reader)
            if frame is None:
                break
            opcode, payload = frame
            if opcode == 0x8:
                break
            if opcode == 0x9:
                await ws_send_raw(writer, b"", opcode=0xA)
                continue
            if opcode != 0x1:
                continue
            try:
                message = json.loads(payload.decode("utf-8"))
            except json.JSONDecodeError:
                await send_error(client, "Invalid JSON.")
                continue
            await handle_message(client, message)
    except (asyncio.IncompleteReadError, ConnectionError, OSError):
        pass
    finally:
        await disconnect_client(client_id)
        writer.close()
        try:
            await writer.wait_closed()
        except OSError:
            pass


async def ws_read_frame(reader: asyncio.StreamReader) -> tuple[int, bytes] | None:
    header = await reader.readexactly(2)
    first, second = header
    opcode = first & 0x0F
    masked = second & 0x80
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", await reader.readexactly(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", await reader.readexactly(8))[0]
    mask = await reader.readexactly(4) if masked else b""
    payload = await reader.readexactly(length) if length else b""
    if masked:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return opcode, payload


async def ws_send(writer: asyncio.StreamWriter, text: str) -> None:
    await ws_send_raw(writer, text.encode("utf-8"), opcode=0x1)


async def ws_send_raw(writer: asyncio.StreamWriter, payload: bytes, opcode: int = 0x1) -> None:
    first = 0x80 | opcode
    length = len(payload)
    if length < 126:
        header = struct.pack("!BB", first, length)
    elif length < 65536:
        header = struct.pack("!BBH", first, 126, length)
    else:
        header = struct.pack("!BBQ", first, 127, length)
    writer.write(header + payload)
    await writer.drain()


async def main() -> None:
    server = await asyncio.start_server(handle_connection, HOST, PORT)
    sockets = ", ".join(str(sock.getsockname()) for sock in server.sockets or [])
    print(f"MM multiplayer server running on http://127.0.0.1:{PORT}")
    print(f"Listening on {sockets}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nServer stopped.")
