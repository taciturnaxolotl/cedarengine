/** Every route, in one array. The server and the spec both read from here. */

import { json } from "../lib/http";
import { peopleStats } from "../store/people";
import { campusRoutes } from "./campus";
import { catalogRoutes } from "./catalog";
import { factRoutes } from "./facts";
import { historyRoutes } from "./history";
import { majorRoutes } from "./majors";
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

export const routes: RouteDef[] = [
  healthRoute,
  ...peopleRoutes,
  ...factRoutes,
  ...catalogRoutes,
  ...majorRoutes,
  ...campusRoutes,
  ...historyRoutes,
  ...syncRoutes,
  ...statsRoutes,
];
