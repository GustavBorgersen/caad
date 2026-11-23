"""Spike 2 (Python): the same sketch with PlaneGCS's Python bindings."""
import json, time
import planegcs
s = planegcs.Sketch()
p1 = s.add_point(0, 0); s.fix_point(p1, 0, 0)
p2 = s.add_point(55, 3); p3 = s.add_point(52, 38); p4 = s.add_point(-2, 41)
l1, l2, l3, l4 = s.add_line(p1, p2), s.add_line(p2, p3), s.add_line(p3, p4), s.add_line(p4, p1)
s.horizontal(l1); s.horizontal(l3); s.vertical(l2); s.vertical(l4)
s.set_p2p_distance(p1, p2, 60); s.set_p2p_distance(p2, p3, 40)
c = s.add_point(20, 22)
circ = s.add_circle(c, s.add_param(7))
s.set_circle_radius(circ, 5)
s.set_p2p_distance(p1, c, 25); s.set_p2p_distance(p2, c, 45)
t = time.perf_counter(); status = s.solve(); ms = (time.perf_counter() - t) * 1000
pt = lambda p: [round(v, 6) for v in s.get_point(p)]
circle = s.get_circle(circ)
radius = circle.radius if not isinstance(circle.radius, int) else s.get_param(circle.radius)
print(json.dumps({"status": str(status), "ms": round(ms, 2), "p1": pt(p1), "p2": pt(p2), "p3": pt(p3), "p4": pt(p4), "c": pt(c), "circ": round(radius, 6)}))
