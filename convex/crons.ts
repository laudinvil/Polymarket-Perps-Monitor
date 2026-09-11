import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "watchdog github monitor",
  { minutes: 1 },
  internal.github_watchdog.ensureMonitorRunning,
  {},
);

crons.interval(
  "prune old monitor data",
  { hours: 6 },
  internal.monitor.pruneOldData,
  {},
);

// Permanent launcher: Convex checks every minute and dispatches monitor-health when no current run exists.
export default crons;
