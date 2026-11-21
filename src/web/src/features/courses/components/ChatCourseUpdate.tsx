import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActionLabel, Header, useViewActive } from "@/app/Header";
import type { SpaceView } from "@/app/api";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { relativeTime } from "@/lib/platform";
import { visibleCourses } from "../lib/selection";
import { whenText } from "../lib/sites";
import type { LmsConnection } from "../lib/types";
import { useCourses } from "../store";
import { ConnectDialog } from "./ConnectDialog";
import { ImportRun } from "./ImportRun";

const STALE_AFTER = 24 * 60 * 60 * 1000;

/** Stay in chat throughout a Canvas update. Only courses this space can use are included. */
export function ChatCourseUpdate({ space, title, children }: { space: SpaceView; title: string; children: ReactNode }) {
  const active = useViewActive();
  const connections = useCourses((s) => s.connections.data);
  const access = useCourses((s) => s.access.data);
  const loadConnections = useCourses((s) => s.loadConnections);
  const loadAccess = useCourses((s) => s.loadAccess);
  const run = useCourses((s) => s.run);
  const startUpdate = useCourses((s) => s.startUpdate);
  const [again, setAgain] = useState<LmsConnection | null>(null);
  const [now, setNow] = useState(Date.now);
  const [dismissedAt, setDismissedAt] = useState<number>();
  const courses = useMemo(() => {
    if (!access || !connections || !space.educationEnabled) return [];
    const canvas = new Set(connections.filter((c) => c.kind === "canvas").map((c) => c.id));
    return visibleCourses(access, space.id).filter((c) => canvas.has(c.connection));
  }, [access, connections, space.id, space.educationEnabled]);
  const hasCourses = courses.length > 0;

  useEffect(() => {
    if (!active || !space.educationEnabled) return;
    void loadConnections();
    void loadAccess();
  }, [active, loadAccess, loadConnections, space.educationEnabled]);

  useEffect(() => {
    if (!active || !hasCourses) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, [active, hasCourses]);

  if (!active || !hasCourses) return <Header title={title} actions={children} />;

  // The oldest snapshot is the most recent time we can say all of these
  // courses were up to date, even if a newer run refreshed only some of them.
  const updated = Math.min(...courses.map((c) => c.partial ? 0 : c.updated ?? 0));
  const missed = updated ? now - updated >= STALE_AFTER : true;
  const stale = missed && (dismissedAt === undefined || now - dismissedAt >= STALE_AFTER);
  const time = relativeTime(updated, now).replace(/^(Just now|Yesterday)$/, (text) => text.toLowerCase());
  const status = updated ? `Canvas updated ${time}` : "Canvas update time unknown";
  const timestamp = updated ? `Oldest course update · ${whenText(updated, now)}` : status;
  const busy = run?.status === "running";
  const canvasRun = run?.update && run.space === space.id && run.courses.every((row) => courses.some((c) => c.key === row.id)) ? run : null;
  const reconnect = connections?.find((c) => c.id === canvasRun?.signInConnection);
  const update = () => startUpdate(space.id, courses);

  return (
    <>
      <Header title={title} actions={
        <>
          <span className="mr-1 text-subtle-foreground text-xs tabular-nums @max-3xl/header:hidden" title={timestamp}>{status}</span>
          <Button size="sm" variant="outline" disabled={busy} onClick={update} title={timestamp}>
            {busy && canvasRun ? <Spinner size="sm" /> : <Icon icon={icons.reload} />}
            <ActionLabel>{busy && canvasRun ? "Updating…" : "Update Canvas"}</ActionLabel>
          </Button>
          {children}
        </>
      } />
      {canvasRun || (stale && !busy) ? (
        <div className="ml-auto w-full max-w-lg shrink-0 px-4 pt-3">
          {canvasRun ? (
            <ImportRun run={canvasRun} onSignInAgain={() => reconnect && setAgain(reconnect)} compact />
          ) : (
            <Alert variant="warning" surface="glass" controlAlignment="first-line">
              <Icon icon={icons.warning} />
              <AlertTitle>Update your Canvas courses?</AlertTitle>
              <AlertDescription>{updated ? `Last updated ${whenText(updated, now)}` : "Some courses have no recorded update time."}</AlertDescription>
              <AlertAction>
                <Button size="xs" variant="outline" onClick={update}>Update</Button>
                <Button size="icon-xs" variant="ghost-muted" aria-label="Dismiss Canvas reminder" onClick={() => setDismissedAt(Date.now())}>
                  <Icon icon={icons.close} />
                </Button>
              </AlertAction>
            </Alert>
          )}
        </div>
      ) : null}
      <ConnectDialog open={!!again} again={again} onOpenChange={(o) => !o && setAgain(null)} onConnected={() => useCourses.getState().dismissRun()} />
    </>
  );
}
