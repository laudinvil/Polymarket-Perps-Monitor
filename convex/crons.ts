import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "watchdog github monitor",
  { minutes: 1 },
  internal.githubWatchdog.ensureMonitorRunning,
  {},
);

crons.interval(
  "prune old monitor data",
  { hours: 6 },
  internal.monitor.pruneOldData,
  {},
);

export default crons;
