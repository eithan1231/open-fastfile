"""Which entities become gameplay nodes, what they are tagged, and what they point at.

`gameplay.world` (from the metadata alone) and `volumes.world` (from the clipmap)
are written by different runs, yet a `target` in either may name a tag the other
carries. So both read these rules, and each computes the whole world's tag set
from the entity lump the same way, rather than one file trusting the other to be
current. A `target` naming a tag no node will carry is dropped and reported:
the DSL would only warn, and the link would find nothing
(docs/cod/reference.md#zombies-entities).
"""

import collections
import functools
import math
import re

from . import gameobjects
from .brushmodels import SOLID_CLASSES, dynamic_path

#: A node carries at most this many tags (dsl/schema.ts `tag`).
MAX_TAGS = 8

#: The keys a CoD script finds an entity by, in the order they become tags: its
#: group, its kind, and a qualifier (a zombie spawner's riser or chaser).
TAG_KEYS = ("targetname", "script_noteworthy", "script_string")

#: How a usable trigger is reached, by class (reverse/t5-zombies/README.md#4-the-use-rule).
USE_BY_CLASS = {"trigger_use": "near", "trigger_use_touch": "touch"}

#: Trigger classes whose volume is a radius (and usually a height) on the entity itself.
RADIUS_TRIGGERS = ("trigger_radius",)

#: A named one of these is a position a script finds by name.
POINT_CLASSES = ("script_struct", "script_origin")

_BRUSH_MODEL = re.compile(r"\*\d+")


def quote(value):
    """A DSL string literal."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def strings(values):
    """Several DSL strings, space-separated: `"a" "b"`."""
    return " ".join(quote(v) for v in values)


def tags_of(entity):
    """The entity's tags: its `TAG_KEYS` values in order, each once, at most `MAX_TAGS`."""
    out = []
    for key in TAG_KEYS:
        value = (entity.get(key) or "").strip()
        if value and value not in out:
            out.append(value)
    return out[:MAX_TAGS]


def is_volume_class(cls):
    return cls == "info_volume" or cls.startswith("trigger")


def is_radius_trigger(entity):
    return entity.get("classname") in RADIUS_TRIGGERS and "radius" in entity and "at" in entity


def is_brush_volume(entity):
    """A trigger or `info_volume` whose volume is brush model `*N`: one box per brush, in volumes.world."""
    return (
        is_volume_class(entity.get("classname", ""))
        and not is_radius_trigger(entity)
        and bool(_BRUSH_MODEL.fullmatch(str(entity.get("model", ""))))
        and "at" in entity
    )


def is_audio_emitter(entity):
    """A Black Ops ambience struct: a `script_sound` the client's `_audio.csc` plays by its `script_label`.

    No server script reads one, and the looping ones are `sound.world`'s already
    (metadata.t5_sound_emitters), so they are not points.
    """
    return entity.get("classname") == "script_struct" and bool(entity.get("script_sound")) and bool(entity.get("script_label"))


def is_point(entity):
    """An AI spawner, or a named struct or origin: a position a script finds by its tags."""
    if "at" not in entity:
        return False
    cls = entity.get("classname", "")
    if cls.startswith("actor_"):
        return True
    return cls in POINT_CLASSES and bool(entity.get("targetname")) and not is_audio_emitter(entity)


def is_part(entity, modes_of):
    """A solid brush model that can be absent: `brushmodels.part_of`, read off the entity."""
    return (
        entity.get("classname") in SOLID_CLASSES
        and bool(_BRUSH_MODEL.fullmatch(str(entity.get("model", ""))))
        and "at" in entity
        and (modes_of(entity) is not None or dynamic_path(entity))
    )


def parts(entities, modes_of):
    """{"*N": entity} for every part, the last entity placing it winning as `brushmodels.load`'s does."""
    out = {}
    for e in entities:
        if is_part(e, modes_of):
            out[e["model"]] = e
    return out


def world_tags(entities, modes_of):
    """Every tag a node of the exported world carries: points, triggers of both kinds, solids."""
    tags = set()
    for e in entities:
        if is_point(e) or is_brush_volume(e) or is_radius_trigger(e):
            tags.update(tags_of(e))
    for e in parts(entities, modes_of).values():
        tags.update(tags_of(e))
    return tags


class Targets:
    """Resolves each entity's `target` against the world's tags, and remembers what it dropped."""

    def __init__(self, entities, modes_of):
        self.tags = world_tags(entities, modes_of)
        self.classes = {}
        for e in entities:
            if e.get("targetname"):
                self.classes.setdefault(e["targetname"], e.get("classname", "?"))
        self.dropped = collections.Counter()

    def of(self, entity):
        """The entity's target when some node carries it, else None (counted by what it named)."""
        target = (entity.get("target") or "").strip()
        if not target:
            return None
        if target in self.tags:
            return target
        self.dropped[self.classes.get(target, "nothing in the map")] += 1
        return None

    def report(self):
        """One line, or '' when nothing was dropped."""
        if not self.dropped:
            return ""
        detail = ", ".join(
            f"{n} naming a {cls}" if cls != "nothing in the map" else f"{n} naming {cls}" for cls, n in self.dropped.most_common()
        )
        return f"{sum(self.dropped.values())} target(s) dropped, no node carrying the tag: {detail}"


def modes_function(game, map_name, entities, facts=None):
    """`modes_of(entity)` for this map: its mode keys, or None when it is in every mode."""
    if game not in gameobjects.ALLOWED_BY_GAME:
        return lambda entity: None
    facts = facts or gameobjects.MapFacts.from_entities(map_name, entities)
    return functools.partial(gameobjects.modes_of, game, facts=facts)


def look_at(entity):
    """A point one metre along the entity's `angles` (pitch, yaw), engine space, from its `at`.

    CoD's forward is (cos p cos y, cos p sin y, -sin p); engine axes are
    (x, z, -y). No angles is yaw 0, which faces CoD +X, not the DSL's north.
    """
    try:
        pitch, yaw = (math.radians(float(v)) for v in (entity.get("angles") or "0 0 0").split()[:2])
    except ValueError:
        pitch = yaw = 0.0
    forward = (math.cos(pitch) * math.cos(yaw), -math.sin(pitch), -math.cos(pitch) * math.sin(yaw))
    return [round(entity["at"][i] + forward[i], 3) for i in range(3)]
