/** Every route, in one array. The server and the spec both read from here. */

import { registerMaskable } from "../auth/masks";
import type { Capability } from "../auth/roles";
import { json } from "../lib/http";
import { peopleStats } from "../store/people";
import { accountRoutes, adminRoutes } from "./admin";
import { campusRoutes } from "./campus";
import { catalogRoutes } from "./catalog";
import { examRoutes } from "./exams";
import { factRoutes } from "./facts";
import { historyRoutes } from "./history";
import { majorRoutes } from "./majors";
import { oauthRoutes } from "./oauth";
import { peopleRoutes } from "./people";
import { statsRoutes } from "./stats";
import { syncRoutes } from "./sync";
import type { RouteDef } from "./types";

const started = Date.now();

const healthRoute: RouteDef = {
  method: "GET",
  path: "/health",
  tag: "engine",
  summary: "Liveness, and enough of a count to tell an empty database from a full one",
  open: true,
  handler: () => {
    const stats = peopleStats();
    return json({
      ok: true,
      uptimeSeconds: Math.round((Date.now() - started) / 1000),
      people: stats.people,
      lastSweep: stats.lastSweep,
    });
  },
};

/** Give every route in a group its capability, unless the route names a stricter one. */
const grant = (access: Capability, group: RouteDef[]): RouteDef[] =>
  group.map((route) => ({ ...route, access: route.access ?? access }));

export const routes: RouteDef[] = [
  healthRoute,
  ...oauthRoutes,
  ...grant("people", peopleRoutes),
  ...grant("people", factRoutes),
  ...grant("people", majorRoutes),
  ...grant("people", historyRoutes),
  ...grant("catalog", catalogRoutes),
  ...grant("catalog", examRoutes),
  ...grant("catalog", campusRoutes),
  ...grant("sync", syncRoutes),
  ...grant("admin", statsRoutes),
  ...grant("admin", adminRoutes),
  ...grant("catalog", accountRoutes),
];

// Only person routes can be masked; hiding the catalog would hide nothing private.
registerMaskable(routes.filter((route) => route.access === "people"));
