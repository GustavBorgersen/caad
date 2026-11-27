"""The part shown in the style mock-ups: a mounting hub (render.mjs turns it into SVG)."""
from build123d import *

radius = 22
height = 14
bolt_r = 2.5

with BuildPart() as hub:
    with BuildSketch(Plane.XZ, mode=Mode.PRIVATE) as sk1:
        with Locations((radius / 2, height / 2)):
            Rectangle(radius, height)
    revolve(sk1.sketch, axis=Axis.Z)
    with Locations((radius + 9, 0, 3)):
        Box(20, 16, 6)
    mirror(about=Plane.YZ)
    with Locations((0, 0, height)):
        Hole(8)
    with Locations((radius + 12, 0, 6), (-radius - 12, 0, 6)):
        CounterBoreHole(radius=bolt_r, counter_bore_radius=2 * bolt_r, counter_bore_depth=2)
    fillet(hub.edges().filter_by(GeomType.CIRCLE).filter_by_position(Axis.Z, height - 0.1, height + 0.1).sort_by(SortBy.RADIUS)[-1:], radius=3)
    fillet(hub.edges().filter_by(Axis.Z).filter_by_position(Axis.X, radius + 10, radius + 30), radius=4)
    fillet(hub.edges().filter_by(Axis.Z).filter_by_position(Axis.X, -radius - 30, -radius - 10), radius=4)
