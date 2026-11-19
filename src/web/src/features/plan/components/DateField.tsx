import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { SelectButton } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { shortDay } from "../lib/days";

const WEEK = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "YYYY-MM-DD" for a UTC year, month and day. */
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const parts = (day: string) => day.split("-").map(Number) as [number, number, number];

/**
 * A date written the app's way ("Wed 18 Nov") that opens a month of days to
 * pick from, in place of the browser's own date input. Arrow keys move a day
 * or a week; Enter picks.
 */
export function DateField({ id, value, today, invalid, onChange }: { id?: string; value: string; today: string; invalid?: boolean; onChange: (day: string) => void }) {
  const [open, setOpen] = useState(false);
  const start = parts(value || today);
  const [month, setMonth] = useState<[number, number]>([start[0], start[1] - 1]);
  const [focus, setFocus] = useState(value || today);
  const grid = useRef<HTMLDivElement>(null);
  const moving = useRef(false);
  useLayoutEffect(() => {
    if (!open || !moving.current) return;
    moving.current = false;
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus();
  }, [focus, open]);
  const [y, m] = month;
  const lead = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const length = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cells = [...Array.from({ length: lead }, () => null), ...Array.from({ length }, (_, i) => iso(y, m, i + 1))];
  const shift = (n: number) => {
    const next = new Date(Date.UTC(y, m + n, 1));
    const yy = next.getUTCFullYear();
    const mm = next.getUTCMonth();
    const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
    setMonth([yy, mm]);
    // Keep one date in the displayed month in the Tab order, including short months.
    setFocus(iso(yy, mm, Math.min(parts(focus)[2], last)));
  };

  const onOpenChange = (o: boolean) => {
    if (o) {
      const p = parts(value || today);
      setMonth([p[0], p[1] - 1]);
      setFocus(value || today);
    }
    setOpen(o);
  };
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!step) return;
    e.preventDefault();
    const [fy, fm, fd] = parts(focus);
    const next = iso(fy, fm - 1, fd + step);
    const [ny, nm] = parts(next);
    // Move focus after React commits the days, including when the month changes.
    moving.current = true;
    setFocus(next);
    setMonth([ny, nm - 1]);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<SelectButton id={id} aria-invalid={invalid || undefined} className="tabular-nums" />}>
        <span className="flex min-w-0 items-center gap-2">
          <Icon icon={icons.plan} className="size-4 shrink-0 text-muted-foreground" />
          <span className={cn("truncate", !value && "text-muted-foreground")}>{value ? shortDay(value) : "Pick a day"}</span>
        </span>
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-68">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1">
            <span className="flex-1 pl-1 font-medium text-sm tabular-nums">
              {MONTHS[m]} {y}
            </span>
            <Button size="icon-xs" variant="ghost-muted" aria-label="Previous month" onClick={() => shift(-1)}>
              <Icon icon={icons.chevronLeft} />
            </Button>
            <Button size="icon-xs" variant="ghost-muted" aria-label="Next month" onClick={() => shift(1)}>
              <Icon icon={icons.chevronRight} />
            </Button>
          </div>
          <div className="grid grid-cols-7 text-center text-2xs text-subtle-foreground">
            {WEEK.map((w, i) => (
              <span key={i} className="flex h-6 items-center justify-center">
                {w}
              </span>
            ))}
          </div>
          <div ref={grid} role="group" aria-label={`${MONTHS[m]} ${y}`} className="grid grid-cols-7 gap-y-0.5" onKeyDown={move}>
            {cells.map((day, i) =>
              day ? (
                <button
                  key={day}
                  type="button"
                  data-day={day}
                  tabIndex={day === focus ? 0 : -1}
                  aria-pressed={day === value}
                  aria-label={shortDay(day)}
                  onClick={() => {
                    onChange(day);
                    setOpen(false);
                  }}
                  className={cn(
                    "mx-auto flex size-8 items-center justify-center rounded-full text-sm tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    day === value ? "bg-primary text-primary-foreground" : day === today ? "font-medium text-primary hover:bg-accent" : "hover:bg-accent",
                  )}
                >
                  {parts(day)[2]}
                </button>
              ) : (
                <span key={`pad-${i}`} />
              ),
            )}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
