"""One set of schemas for validation, defaults, and editor assistance."""
from copy import deepcopy
import json
from pathlib import Path


def obj(properties, **kwargs):
    return {"type": "object", "properties": properties, "additionalProperties": False, **kwargs}


def field(kind, default, **kwargs):
    return {"type": kind, "default": default, **kwargs}


BOOL = lambda default=False: field("boolean", default)
TEXT = lambda default="": field("string", default)
USER_FIELDS = obj({
    "ghosts": obj({"enabled": BOOL()}),
    "uploads": obj({"zwift": obj({"enabled": BOOL()}),
                    "strava": obj({"method": field("string", "paid", enum=["paid", "free"])})}),
    "devices": obj({"zwift_click": obj({"enabled": BOOL()})}),
    "workouts": obj({"trainingpeaks": obj({"bridge_folder": TEXT()})}),
})
META = {"$schema": {"type": "string"}}
USER = obj({**META, "settings_version": {"const": 1, "default": 1}, **USER_FIELDS["properties"]}, required=["settings_version"])
SERVER = obj({
    **META, "config_version": {"const": 1, "default": 1},
    "server": obj({"advertised_ip": TEXT("127.0.0.1")}),
    "accounts": obj({"allow_self_registration": BOOL(True)}),
    "bots": obj({"enabled": BOOL(), "multiplier": field("integer", 1, minimum=1, maximum=100), "riders_file": TEXT()}),
    "proxy": obj({"mode": field("string", "auto", enum=["auto", "enabled", "disabled"])}),
    "dns": obj({"enabled": BOOL()}),
    "leaderboards": obj({"all_time": BOOL()}),
    "equipment": obj({"unlock_entitlements": BOOL(), "unlock_all": BOOL()}),
    "ghosts": obj({"profile_file": TEXT()}),
    "integrations": obj({
        "garmin": obj({"domain": TEXT("garmin.com")}),
        "discord": obj({"enabled": BOOL(), "credentials_file": TEXT(), "channel": field("integer", 0, minimum=0),
                        "welcome_message": TEXT(), "help_message": TEXT(), "announce_players": BOOL()}),
    }),
    "logging": obj({"level": field("string", "INFO", enum=["DEBUG", "INFO", "WARNING", "WARN", "ERROR", "CRITICAL", "NOTSET"])}),
    "network": obj({
        "host": TEXT(),
        **{name: obj({"host": {"type": ["string", "null"], "default": None},
                      "port": field("integer", port, minimum=1, maximum=65535),
                      **({"use_cert": BOOL(True)} if name == "api" else {})})
           for name, port in (("cdn", 80), ("tcp", 3025), ("udp", 3024), ("api", 443))},
    }),
    "user_defaults": deepcopy(USER_FIELDS),
}, required=["config_version"])


def defaults(schema):
    if "default" in schema:
        return deepcopy(schema["default"])
    if schema.get("type") == "object":
        return {k: defaults(v) for k, v in schema["properties"].items() if k != "$schema"}
    return None


def generated():
    return {name: {"$schema": "https://json-schema.org/draft/2020-12/schema", **schema}
            for name, schema in (("config.schema.json", SERVER), ("user-settings.schema.json", USER),
                                 ("peloton.schema.json", PELOTON), ("solo-blob.schema.json", SOLO_BLOB))}


def write_schemas(directory=None):
    directory = Path(directory or Path(__file__).with_name("schemas"))
    directory.mkdir(parents=True, exist_ok=True)
    for name, schema in generated().items():
        (directory / name).write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")


PELOTON_DEFAULTS = {
    'bots': 20,                 # number of followers
    'columns': 0,               # max group width (0 = automatic)
    'row_gap': 2.2,             # meters between rows
    'lateral_spacing': 65000,   # lateral spacing in roadPosition units (100000 = 1 m)
    'beside_pacer': 2,          # bots riding alongside the pacer
    'dynamics': 1.0,            # 0 = rigid formation, 1 = normal, 2 = very lively
    'shuffle_interval': 30,     # average seconds between position changes
    'draft': 0.7,               # fraction of power used by a bot on a wheel
    'climb_stretch': 1.0,       # how much the group stretches on climbs
    'max_drop': 40,             # max meters a weak bot can drop back
    'riders': [],               # custom bots (name, country, equipment, position, strength...)
}


SOLO_DEFAULTS = {
    'enabled': False,
    'riders': 8,
    'row_gap': 1.8,                 # meters between rows (staggered, a bike is ~1.8 m long)
    'tail_gap': 4.0,                # the group tries to stay within this many meters behind you
    'lateral_spacing': 0.95,          # meters between riders side to side
    'lead_gap': 1.6,                 # meters a lead rider sits in front of you
    'lead_lateral': 0.8,             # meters the lead riders sit to the side of you (alternating)
    'columns': 0,                    # max group width (0 = automatic)
    'shuffle_interval': 25,          # average seconds between position changes
    'rotate': True,                  # false = nobody takes the front on their own (gestures still work)
    'pull_interval': 60,             # average seconds between front rotations
    'lead_spread': 1,                # the number of riders in front changes by up to this many at once (0 = fixed)
    'full_range': False,              # true = anything from nobody in front (you lead) to everybody in front (you are last)
    'max_lead': 8,                 # meters: the whole group in front is squeezed into this distance ahead of you
    'diag_interval': 0,             # seconds between diagnostic log lines (0 = off)
    'latency_comp': 0,               # seconds your packets are old when sent (the group then rides that much
                                     # further ahead of the last packet), or "auto" = use the measured
                                     # packet_lag from the diag log line. Matters most at speed (descents).
    'formation_interval': 45,        # average seconds between changes in the formation in front of you
    'turn_interval': 1200,            # every this many seconds YOU take a turn at the front (0 = never)
    'rotation_rate': 0.7,            # m/s the riders move up or back when the line rotates
    'pull_duration': 18,             # seconds a pull lasts
    'pass_time': 18,                 # seconds an overtaking rider needs to get past the leader
    'climb_stretch': 1.0,            # how much the group stretches on climbs
    'max_drop': 30,                  # max meters behind you a rider can sit
    'hammer_time': 180,              # seconds the HAMMER gesture drives a hard pace
    'toast_time': 120,               # seconds the TOAST gesture makes everyone ease off
    'lead_time': 120,                # seconds the BELL gesture keeps you at the front
    'wander_gap': 0.3,               # meters: riders behind you drift randomly this far along the road around
                                     # their slot (0 = off, 0.6-0.9 looks like a real peloton)
    'wander_lateral': 0.15,           # meters: the same sideways (0 = off, 0.25-0.35 is plenty)
    'bot_gestures': True,            # riders of the group give hand signals now and then (elbow flick, toast, nice, bell, ride on)
    'gesture_interval': 75,          # seconds between two random "Ride On" gestures of the group (0 = none)
    'gesture_chance': 1.0,           # scales the chance of every other signal (0 = none, 2 = twice as often)
    'wander_time': 7,                # seconds a drift takes to change direction (higher = slower, calmer)
    'ragged_rows': False,            # true = rows behind you differ in width, spacing and stagger
    'lateral_via': 'both',             # how the sideways offset reaches the game: 'xz' = world position only (the game
                                     # flattens a wide group), 'both' = world position AND roadPosition (like the
                                     # peloton option, recommended), 'road' = roadPosition only
    'lateral_scale': 1.0,            # multiplies every sideways offset on the way out (a last resort if the game still
                                     # shows the group narrower than it is)
    'road_half_width': 3.0,          # meters: half the width of the drivable road around its centre (0 = off). Nobody is ever
                                    # placed outside it: when you ride near an edge the whole group slides sideways (max 0.5 m/s)
                                    # and every single rider is clamped to the road, also while he sidesteps another one.
                                    # 3.0 fits a narrow bridge. Everything below about the axis needs this to be > 0
    'road_limits': 'auto',           # 'auto' = the road centre line is a wall and the side you may ride on depends on your direction
                                    # of travel (forward = + side, the other way = - side); the outer edge comes from real recorded
                                    # rides (data/road_limits.txt, scripts/gen_road_limits.py), road_half_width is the fallback
                                    # for roads that are not in the table. 'off' = the fixed zone below (road_axis_limit/side)
    'max_road_shift': 4.0,          # (road_limits 'auto') meters: the most the whole group may slide sideways off you to stay on the road.
                                    # Ride in the middle and the shift is 0; ride at an edge (or next to the invisible wall by the centre
                                    # line) and the group slides just far enough that its outermost rider is in line with you.
                                    # 0 = never slide: the group is squeezed on that side instead
    'road_axis_limit': 1.5,         # (road_limits 'off' only) meters from the road centre (roadPosition 10,000,000) to the road AXIS (the centre line
                                    # you must not cross), measured towards the side given by road_axis_side. Riders beyond it
                                    # get pulled back by the game, which looks like an invisible wall, so the group keeps
                                    # (this - 0.25 m) from it. 0 = no axis, that side ends at road_half_width like the other
    'road_axis_side': -1,           # which side of the road centre the axis is on: -1 = lower roadPosition (default),
                                    # +1 = higher roadPosition. Riders on that side of the group still veer towards the axis?
                                    # then flip it
    'only_kitted': True,            # true = draw the riders only from bot.txt entries that have a team kit
                                    # (the others would ride in a random kit)
    'scatter': True,                # true = riders behind you are scattered over the width of the road
                                    # (blue-noise layout) instead of sitting in rows; ignores columns/tail_gap
    'scatter_width': 3.0,           # meters: how wide the scattered group may spread
    'scatter_gap': 1.75,            # meters along the road between riders of the same lane when scattered
    'scatter_side': 1.0,            # meters: riders that sit level with each other are at least this far apart sideways
                                    # (not shoulder to shoulder; anyone closer sideways is further apart along the road)
    'scatter_beside': 1.0,          # meters sideways at which scattered riders may ride right beside you
    'keep_apart_long': 1.75,        # meters along the road between the centres of two riders (their ellipse, with keep_apart)
    'keep_apart': 0.85,             # meters of sideways clearance riders behind you keep from each other
                                    # (0 = off, 0.8-0.9 = nobody rides through anybody: they go around or wait; a sidestep
                                    # never goes past the road edge or axis, it goes the other way or waits instead)
}


def inferred(value):
    kind = "boolean" if isinstance(value, bool) else "number" if isinstance(value, (int, float)) else "string"
    return field(kind, value)


# Protobuf profile properties used by both custom rider catalogues and pelotons.
RIDER = obj({**{key: {"type": "integer"} for key in (
    "country_code", "bike_frame", "bike_frame_colour", "bike_wheel_front", "bike_wheel_rear", "glasses_type",
    "ride_jersey", "ride_helmet_type", "ride_shoes_type", "ride_socks_type", "run_shirt_type", "run_shorts_type", "run_shoes_type")},
    "first_name": {"type": "string"}, "last_name": {"type": "string"}, "is_male": {"type": "boolean"},
    "position": {"enum": ["front", "middle", "back", "any"]},
    **{key: {"type": "number"} for key in ("strength", "weight", "height", "cadence", "max_heart_rate")},
})
PELOTON_ENTRY = obj({**{k: inferred(v) for k, v in PELOTON_DEFAULTS.items() if k != "riders"},
    "pacer": {"type": ["integer", "string"]}, "enabled": BOOL(True),
    "riders": {"type": "array", "items": RIDER, "default": []},
}, required=["pacer"])
PELOTON = obj({**META, "pelotons": {"type": "array", "items": PELOTON_ENTRY, "default": []}})
SOLO_BLOB = obj({**META, **{k: inferred(v) for k, v in SOLO_DEFAULTS.items()},
    "player_id": field("integer", 1, minimum=1), "record": BOOL(),
})
# Fail malformed geometry early instead of raising halfway through a simulation tick.
for schema in (PELOTON_ENTRY, SOLO_BLOB):
    for key in ("row_gap", "lateral_spacing", "rotation_rate", "pass_time"):
        if key in schema["properties"]:
            schema["properties"][key]["exclusiveMinimum"] = 0
    for key in ("bots", "riders", "columns", "beside_pacer"):
        if key in schema["properties"] and schema["properties"][key].get("type") in ("integer", "number"):
            schema["properties"][key].update(type="integer", minimum=0)
SOLO_BLOB["properties"]["riders"]["maximum"] = 30
SOLO_BLOB["properties"]["diag_interval"]["minimum"] = 0
SOLO_BLOB["properties"]["latency_comp"] = {"type": ["number", "string"], "default": 0}
PELOTON_ENTRY["properties"]["bots"]["maximum"] = 200

if __name__ == "__main__":
    write_schemas()
