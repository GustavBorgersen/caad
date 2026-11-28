"""An L-bracket: sketch, extrude, hole, fillet."""
from build123d import *

width = 60
depth = 40
thickness = 8
hole_d = 10

with BuildPart() as bracket:
    with BuildSketch() as base:
        Rectangle(width, depth)

    extrude(amount=thickness)

    with BuildSketch(bracket.faces().sort_by(Axis.Y)[-1]) as wall:
        with Locations((0, -20)):
            Rectangle(width, 40)

    extrude(amount=-thickness)

    with Locations((0, -6, thickness)):
        Hole(hole_d / 2)

    fillet(bracket.edges().filter_by(Axis.Z).group_by(Axis.Y)[0], radius=5)
