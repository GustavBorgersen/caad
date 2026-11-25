"""A plate sized by the project's shared parameters (params.py)."""
from build123d import *
from params import plate_d, plate_w, wall

with BuildPart() as plate:
    Box(plate_w, plate_d, wall, align=(Align.CENTER, Align.CENTER, Align.MIN))
    fillet(plate.edges().filter_by(Axis.Z), radius=wall)
