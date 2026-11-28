"""Peristaltic pump body from MiniBrewery (simplified)."""
from build123d import *

outer_r = 50
height = 35
bore_r = 35
bolt_circle = 45

with BuildPart() as pump_body:
    Cylinder(outer_r, height, align=(Align.CENTER, Align.CENTER, Align.MIN))

    Cylinder(bore_r, height, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)

    with Locations((0, 0, 18)):
        Cylinder(39.5, 17, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)

    with Locations((-33.5, 25, 26.5), (33.5, 25, 26.5)):
        Box(13, 50, 17, mode=Mode.SUBTRACT)

    with PolarLocations(bolt_circle, 4):
        Cylinder(2.25, height, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)

    fillet(pump_body.edges().filter_by(GeomType.CIRCLE).group_by(Axis.Z)[0].sort_by(SortBy.RADIUS)[-1:], radius=1)
