import type { Block, Op, Session } from "@depthcue/core";
import { unitText } from "@depthcue/player";

type Chart = Extract<Block, { type: "bar-chart" }>;
export type ChartRow = Chart["data"][number];

/** The most rows a chart holds and the longest label. The schema says so too; the core exports neither. */
export const CHART_ROWS_MAX = 24;
export const CHART_LABEL_MAX = 40;

export const addedRow = (rows: readonly ChartRow[]): ChartRow[] => [
  ...rows,
  { label: `Item ${rows.length + 1}`, value: 0 },
];

/** Largest first; when it already is, smallest first. */
export function sortedRows(rows: readonly ChartRow[]): ChartRow[] {
  const down = [...rows].sort((a, b) => b.value - a.value);
  return JSON.stringify(down) === JSON.stringify(rows) ? down.reverse() : down;
}

const whole = (n: number) => Math.abs(n - Math.round(n)) < 1e-9;

/**
 * How far a value moves. `places` is the precision the chart already uses, up to three decimals, so a chart of whole
 * numbers stays whole. `nudge` is what an arrow key adds: about a hundredth of the largest value, as 1, 2 or 5
 * times a power of ten, and never finer than the chart's own precision.
 */
export function stepsOf(rows: readonly ChartRow[]): { places: number; nudge: number } {
  let places = 0;
  while (places < 3 && rows.some((row) => !whole(row.value * 10 ** places))) places += 1;
  const base = 10 ** -places;
  const raw = Math.max(0, ...rows.map((row) => row.value)) / 100;
  if (raw <= base) return { places, nudge: base };
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const lead = raw / magnitude;
  return { places, nudge: (lead >= 5 ? 5 : lead >= 2 ? 2 : 1) * magnitude };
}

/** A value kept at the chart's precision and never below nothing, which a bar cannot show. */
export const snapped = (value: number, places: number) => Math.max(0, Number(value.toFixed(places)));

/** What the chart's bars need from the canvas they are drawn in. */
export interface BarHooks {
  session: Session;
  sceneId: string;
  /** Applies a change without the canvas being redrawn under the pointer or the keyboard. */
  quietly(change: () => void): void;
  /** The chart was chosen by focusing or dragging one of its bars. */
  select(id: string): void;
  /** Escape was pressed on a bar. */
  deselect?: (() => void) | undefined;
}

/** The bar's width as a share of the largest value, which the player's stylesheet turns into a width. */
const WIDTH_OF_LARGEST = 0.76;

let visits = 0;

/**
 * Turns each bar of a chart drawn in the editor into a slider. Dragging a bar, or pressing arrow keys on it,
 * changes that row's value. Each drag and each visit of the keyboard joins into one undo step. The bars and their
 * readouts are brought up to date in place, because redrawing the chart would end a drag.
 */
export function wireBars(figure: HTMLElement, id: string, hooks: BarHooks): void {
  const { session, sceneId } = hooks;
  const bars = [...figure.querySelectorAll<HTMLElement>(".dc-bar")];
  const readouts = [...figure.querySelectorAll<HTMLElement>(".dc-value")];
  const chart = (): Chart | undefined => {
    const block = session.doc.scenes[sceneId]?.blocks.find((candidate) => candidate.id === id);
    return block?.type === "bar-chart" ? block : undefined;
  };
  const rows = (): readonly ChartRow[] => chart()?.data ?? [];
  const largestOf = (list: readonly ChartRow[]) => Math.max(0, ...list.map((row) => row.value));

  /** Shows the document's values. `scale` is the value a full-size bar stands for. */
  function paint(scale = largestOf(rows())) {
    const unit = unitText(chart()?.unit);
    rows().forEach((row, index) => {
      const bar = bars[index];
      const readout = readouts[index];
      if (!bar || !readout) return;
      bar.style.setProperty("--w", String(scale > 0 ? Math.max(0, row.value) / scale : 0));
      bar.setAttribute("aria-valuemax", String(Math.max(scale, row.value)));
      bar.setAttribute("aria-valuenow", String(row.value));
      bar.setAttribute("aria-valuetext", `${row.value}${unit}`);
      readout.textContent = `${row.value}${unit}`;
    });
  }

  function commit(row: number, value: number, coalesce: string): boolean {
    const live = rows();
    if (!live[row] || live[row].value === value) return false;
    const data = live.map((entry, index) => (index === row ? { ...entry, value } : entry));
    const op: Op = { op: "block.set", scene: sceneId, id, set: { data } };
    let done = false;
    hooks.quietly(() => {
      done = session.apply([op], { coalesce }).ok;
    });
    return done;
  }

  bars.forEach((bar, row) => {
    const label = rows()[row]?.label ?? "";
    const startup = rows()[row]?.value ?? 0;
    bar.dataset.slider = "";
    bar.dataset.row = String(row);
    bar.removeAttribute("aria-hidden");
    bar.setAttribute("role", "slider");
    bar.setAttribute("aria-label", label);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-orientation", "horizontal");
    bar.tabIndex = 0;
    bar.setAttribute("aria-valuenow", String(startup));
    let visit = 0;
    const key = () => `chart:${id}:${row}:${visit}`;

    bar.addEventListener("focus", () => {
      visit = ++visits;
      hooks.select(id);
    });

    bar.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") {
        bar.blur();
        hooks.deselect?.();
        return;
      }
      const live = rows();
      const here = live[row]?.value;
      if (here === undefined) return;
      const { places, nudge } = stepsOf(live);
      const step = nudge * (event.shiftKey ? 5 : 1);
      const next = (
        {
          ArrowRight: here + step,
          ArrowUp: here + step,
          ArrowLeft: here - step,
          ArrowDown: here - step,
          Home: 0,
          End: largestOf(live),
        } as Record<string, number | undefined>
      )[event.key];
      if (next === undefined) return;
      event.preventDefault();
      if (commit(row, snapped(next, places), key())) paint();
    });

    bar.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      hooks.select(id);
      bar.focus();
      visit = ++visits;
      const start = rows();
      const from = start[row]?.value;
      if (from === undefined) return;
      const { places } = stepsOf(start);
      const largest = largestOf(start);
      // A bar holds still while it is dragged and the rest scale to it afterwards, so the one under the pointer
      // follows the pointer. With every bar at nothing, a full bar stands for one hundred.
      const scale = largest > 0 ? largest : 100;
      const widest = Math.max(0, ...bars.map((candidate) => candidate.offsetWidth));
      const cell = bar.parentElement?.clientWidth ?? 0;
      const perUnit = largest > 0 && widest > 0 ? widest / largest : (cell * WIDTH_OF_LARGEST) / scale;
      if (!(perUnit > 0)) return;
      const x0 = event.clientX;
      bar.setPointerCapture(event.pointerId);
      bar.dataset.sliding = "";

      const move = (at: PointerEvent) => {
        if (commit(row, snapped(from + (at.clientX - x0) / perUnit, places), key())) paint(scale);
      };
      const end = () => {
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", end);
        bar.removeEventListener("pointercancel", end);
        bar.removeEventListener("lostpointercapture", end);
        delete bar.dataset.sliding;
        paint();
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", end);
      bar.addEventListener("pointercancel", end);
      bar.addEventListener("lostpointercapture", end);
    });
  });
  paint();
}
