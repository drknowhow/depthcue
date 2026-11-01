// The 60-second demo as a Kinescript scene, written as code so the colors, the fonts' paths, the JSON on screen and
// the terminal text are read from the repository and cannot drift from it. `buildScene` is a pure function: the same
// inputs give the same scene, and tools/demo.test.mjs checks the committed docs/demo/demo.json against it.
//
// The scene sits in docs/demo/, so every path in it is relative to that folder.

const W = 1920;
const H = 1080;

/** Where each part starts and ends, in seconds. A part's layers are cued from these, so changing one moves it. */
export const PARTS = {
  title: [0, 6],
  format: [6, 14],
  agent: [14, 26],
  render: [26, 36],
  human: [36, 43],
  handoff: [43, 50],
  deliver: [50, 57],
  end: [57, 60],
};

/** The part of the player's control bar that tools/capture-demo.mjs crops, in the page's CSS pixels. */
export const CONTROLS = { x: 1180, y: 1010, w: 740, h: 70 };

const FONTS = {
  display: "../../brand/fonts/InstrumentSerif-Regular.ttf",
  ui: "../../brand/fonts/SpaceGrotesk-Medium.ttf",
  mono: "../../brand/fonts/IBMPlexMono-Regular.ttf",
};

// The words are in the left column and what they describe is on the right. Both end inside the 5 percent margin.
const LEFT = 120;
const COLUMN = 680;
const RIGHT = 860;
const RIGHT_W = 960;
const SHOT = RIGHT_W / 1920; // how much a 1920 pixel capture is reduced to fit the right-hand area

/** Breaks text into lines of at most `columns` characters, at spaces, keeping runs of spaces and a leading indent. */
export function wrap(text, columns) {
  const lines = [];
  for (const paragraph of text.split("\n")) {
    const [first, ...rest] = paragraph.split(" ");
    let line = first;
    for (const word of rest) {
      if (line.trim() && `${line} ${word}`.length > columns) {
        lines.push(line);
        line = word;
      } else {
        line = `${line} ${word}`;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** The demand scene's JSON, trimmed to what fits on screen, laid out the way the fixture lays it out. */
export function excerpt(scene) {
  const block = scene.blocks[0];
  return [
    "{",
    `  "id": ${JSON.stringify(scene.id)},`,
    `  "lead": ${JSON.stringify(scene.lead)},`,
    `  "summary": {`,
    `    "id": ${JSON.stringify(scene.summary.id)},`,
    `    "text": ${JSON.stringify(scene.summary.text)},`,
    `    "evidenceIds": ${JSON.stringify(scene.summary.evidenceIds)}`,
    "  },",
    `  "blocks": [`,
    `    { "id": ${JSON.stringify(block.id)}, "type": ${JSON.stringify(block.type)} }`,
    "  ]",
    "}",
  ];
}

export function buildScene({ tokens, transcript, demand }) {
  const ink = Object.fromEntries(
    Object.entries(tokens.color.theme.ink).map(([name, token]) => [name, token.$value]),
  );
  const color = ink;
  const layers = [];
  const add = (...made) => layers.push(...made.flat());

  const span = (part, delay = 0, trim = 0) => ({ at: PARTS[part][0] + delay, until: PARTS[part][1] - trim });
  const fadeOut = { name: "fade", dur: 0.3 };

  /** The kicker, headline and supporting lines of a part, in the left column. */
  const words = (part, { kicker, headline, support }) => [
    {
      id: `${part}-kicker`,
      type: "text",
      text: kicker,
      x: LEFT,
      y: 300,
      anchor: "topleft",
      align: "left",
      font: FONTS.mono,
      size: 26,
      letterSpacing: 4,
      case: "upper",
      fill: color.action,
      ...span(part, 0.2),
      enter: "fade",
      exit: fadeOut,
    },
    {
      id: `${part}-headline`,
      type: "text",
      text: headline,
      x: LEFT,
      y: 350,
      anchor: "topleft",
      align: "left",
      font: FONTS.display,
      weight: 400,
      size: 84,
      lineHeight: 1.04,
      maxWidth: COLUMN,
      fill: color.text,
      split: "words",
      ...span(part, 0.35),
      enter: { name: "rise", dur: 0.5, stagger: 0.07 },
      exit: fadeOut,
    },
    ...support.map((line, index) => ({
      id: `${part}-support${support.length > 1 ? `-${index + 1}` : ""}`,
      type: "text",
      text: line.text,
      x: LEFT,
      y: 575,
      anchor: "topleft",
      align: "left",
      font: FONTS.ui,
      size: 34,
      lineHeight: 1.32,
      maxWidth: 640,
      fill: color.muted,
      at: PARTS[part][0] + (line.at ?? 1),
      until: line.until === undefined ? PARTS[part][1] : PARTS[part][0] + line.until,
      enter: "fade",
      exit: fadeOut,
    })),
  ];

  /** A picture of the product, tilted in from the side and lifted off the page by a shadow. */
  const picture = (id, src, { x = RIGHT, y, w = RIGHT_W, at, until, tilt = true, ...rest }) => ({
    id,
    type: "image",
    src,
    x,
    y,
    w,
    anchor: "topleft",
    radius: 18,
    shadow: { x: 0, y: 26, blur: 56, color: "#000000b3" },
    ...(tilt
      ? {
          rotateY: [
            [0, -14],
            [0.9, 0, "outCubic"],
          ],
        }
      : {}),
    at,
    until,
    enter: { name: "rise", dur: 0.6 },
    exit: fadeOut,
    ...rest,
  });

  /**
   * Pictures that take each other's place. Each fades in over the one before it, which stays until it is covered, so
   * the screen never dips toward the background in between.
   */
  const sequence = (...pictures) =>
    pictures.map((next, index) =>
      index === pictures.length - 1 ? next : { ...next, until: pictures[index + 1].at + 0.5, exit: "none" },
    );

  /** A window for code or a terminal: a rounded panel with three dots and a name. */
  const panel = (id, { x, y, w, h, name, at, until }) => [
    {
      id,
      type: "rect",
      x,
      y,
      w,
      h,
      anchor: "topleft",
      radius: 24,
      fill: color.surface,
      stroke: color.line,
      strokeWidth: 2,
      at,
      until,
      enter: { name: "rise", dur: 0.5 },
      exit: fadeOut,
    },
    ...[0, 1, 2].map((index) => ({
      id: `${id}-dot-${index + 1}`,
      type: "circle",
      x: x + 38 + index * 26,
      y: y + 38,
      r: 7,
      fill: color.line,
      at: at + 0.2,
      until,
      enter: "fade",
      exit: fadeOut,
    })),
    {
      id: `${id}-name`,
      type: "text",
      text: name,
      x: x + 140,
      y: y + 38,
      anchor: "left",
      align: "left",
      font: FONTS.mono,
      size: 24,
      fill: color.muted,
      at: at + 0.2,
      until,
      enter: "fade",
      exit: fadeOut,
    },
  ];

  /**
   * Terminal lines typed one after another. A command types out and the output after it appears at once, as it does
   * in a real terminal. Long lines are broken to fit the panel.
   */
  const terminal = (id, { x, y, columns, size = 25, rowHeight = 38, start, until, lines }) => {
    const made = [];
    let clock = start;
    let row = 0;
    lines.forEach(({ text, kind }, index) => {
      if (kind === "cmd" && index > 0) row += 0.4;
      const typed = kind === "cmd";
      wrap(typed ? `$ ${text}` : text, columns).forEach((piece, part) => {
        const dur = typed ? Math.max(0.5, piece.length * 0.024) : 0.2;
        const shown = typed ? piece.replace(/^\$/, "**$**") : piece;
        made.push({
          id: `${id}-line-${made.length + 1}`,
          type: "text",
          text: part > 0 ? `  ${shown}` : shown,
          x: x + 40,
          y: y + 90 + row * rowHeight,
          anchor: "left",
          align: "left",
          font: FONTS.mono,
          size,
          fill: { cmd: color.text, out: color.muted, ok: color.state, bad: color.action }[kind],
          emph: color.action,
          at: clock,
          until,
          enter: typed ? { name: "type", dur } : { name: "fade", dur },
          exit: fadeOut,
        });
        clock += dur + (typed ? 0.3 : 0.12);
        row += 1;
      });
    });
    return made;
  };

  /** A ring and a short label, drawn on top of a picture. */
  const ring = (id, { x, y, w, h, label, labelAt = "right", at, until }) => {
    const place = {
      right: { x: x + w + 18, y: y + h / 2, anchor: "left", align: "left" },
      left: { x: x - 18, y: y + h / 2, anchor: "right", align: "right" },
      below: { x: x + w / 2, y: y + h + 18, anchor: "top", align: "center" },
    }[labelAt];
    return [
      {
        id: `${id}-ring`,
        type: "rect",
        x,
        y,
        w,
        h,
        anchor: "topleft",
        radius: 10,
        stroke: color.action,
        strokeWidth: 4,
        at,
        until,
        enter: "pop",
        exit: fadeOut,
      },
      {
        id: `${id}-label`,
        type: "text",
        text: label,
        ...place,
        font: FONTS.mono,
        size: 24,
        fill: color.text,
        box: { fill: `${color.bg}e6`, pad: [8, 14], radius: 8 },
        at: at + 0.15,
        until,
        enter: "fade",
        exit: fadeOut,
      },
    ];
  };

  // ---- the whole video: a dark ground, the progress bar and the small mark that stays from part to part
  add({ id: "ground", type: "rect", x: 0, y: 0, anchor: "topleft", w: "100%", h: "100%", fill: color.bg });
  add({
    id: "mark-small",
    type: "image",
    src: "assets/mark.png",
    x: LEFT,
    y: 70,
    w: 60,
    anchor: "topleft",
    at: PARTS.format[0],
    until: PARTS.deliver[1],
    enter: "fade",
    exit: fadeOut,
  });
  add({
    id: "wordmark-small",
    type: "text",
    text: "Depthcue",
    x: LEFT + 80,
    y: 100,
    anchor: "left",
    align: "left",
    font: FONTS.display,
    weight: 400,
    size: 48,
    fill: color.text,
    at: PARTS.format[0],
    until: PARTS.deliver[1],
    enter: "fade",
    exit: fadeOut,
  });

  // ---- title
  add(
    {
      id: "title-mark",
      type: "image",
      src: "assets/mark.png",
      x: "50%",
      y: 300,
      w: 300,
      ...span("title", 0.2),
      rotateY: [
        [0, -50],
        [1.1, 0, "outCubic"],
      ],
      enter: { name: "pop", dur: 0.7 },
      exit: fadeOut,
    },
    {
      id: "title-wordmark",
      type: "text",
      text: "Depthcue",
      x: "50%",
      y: 610,
      font: FONTS.display,
      weight: 400,
      size: 200,
      fill: color.text,
      split: "chars",
      ...span("title", 0.9),
      enter: { name: "rise", dur: 0.5, stagger: 0.05 },
      exit: fadeOut,
    },
    {
      id: "title-tagline",
      type: "text",
      text: "Explanations an agent can write, a person can repair, and both can present.",
      x: "50%",
      y: 830,
      font: FONTS.ui,
      size: 40,
      lineHeight: 1.3,
      maxWidth: 1100,
      fill: color.muted,
      ...span("title", 1.4),
      enter: "fade",
      exit: fadeOut,
    },
  );

  // ---- 01 the format
  add(
    words("format", {
      kicker: "01 · The format",
      headline: "A deck is typed JSON with stable ids.",
      support: [{ text: "Generate it, review it in a pull request, diff it." }],
    }),
    panel("format-code", {
      x: RIGHT,
      y: 220,
      w: RIGHT_W,
      h: 620,
      name: "scenes/demand.json",
      ...span("format", 0.3),
    }),
  );
  const code = excerpt(demand)
    .map((line) =>
      line.replace(
        /("(?:id|text)": ")([^"]+)(")/,
        (_whole, open, value, close) => `${open}**${value}**${close}`,
      ),
    )
    .join("\n");
  add({
    id: "format-json",
    type: "text",
    text: code,
    x: RIGHT + 48,
    y: 290,
    anchor: "topleft",
    align: "left",
    font: FONTS.mono,
    size: 28,
    lineHeight: 1.45,
    fill: color.muted,
    emph: color.action,
    at: PARTS.format[0] + 0.5,
    until: PARTS.format[1],
    enter: { name: "type", dur: 3.2 },
    exit: fadeOut,
  });

  // ---- 02 an agent edits it
  add(
    words("agent", {
      kicker: "02 · An agent edits it",
      headline: "An edit is one transaction.",
      support: [
        { text: "It names a revision. If the deck has moved on, the edit is rejected, never merged." },
      ],
    }),
    panel("agent-terminal", {
      x: RIGHT,
      y: 190,
      w: RIGHT_W,
      h: 690,
      name: "terminal",
      ...span("agent", 0.4),
    }),
  );
  const agentLines = [
    { kind: "cmd", text: "depthcue rev demo" },
    { kind: "out", text: transcript.before },
    { kind: "cmd", text: `depthcue apply demo ops.json --base-rev ${transcript.before}` },
    ...transcript.applied
      .split("\n")
      .map((text) => ({ kind: text.startsWith("Applied") ? "ok" : "out", text })),
    { kind: "cmd", text: `depthcue apply demo ops.json --base-rev ${transcript.before}` },
    ...transcript.stale
      .split("\n")
      .map((text) => ({ kind: text.startsWith("Rejected") ? "bad" : "out", text })),
  ];
  add(
    terminal("agent", {
      x: RIGHT,
      y: 190,
      columns: 58,
      start: PARTS.agent[0] + 1.2,
      until: PARTS.agent[1],
      lines: agentLines,
    }),
  );

  // ---- 03 render and interact
  const rendered = picture("render-slide", "assets/demand.png", {
    y: 170,
    at: PARTS.render[0] + 0.3,
    until: PARTS.render[0] + 5,
  });
  const playing = picture("player-slide", "assets/player-demand.png", {
    y: 170,
    at: PARTS.render[0] + 5,
    until: PARTS.render[0] + 7.6,
    tilt: false,
    enter: { name: "fade", dur: 0.4 },
  });
  const sorted = picture("player-sorted", "assets/player-sorted.png", {
    y: 170,
    at: PARTS.render[0] + 7.6,
    until: PARTS.render[1],
    tilt: false,
    enter: { name: "fade", dur: 0.2 },
  });
  add(
    words("render", {
      kicker: "03 · Check and present",
      headline: "Every scene is drawn and checked.",
      support: [
        { text: "Overflow, clipping, overlap, small text and low contrast are reported.", at: 1, until: 5.2 },
        { text: "Blocks respond in the room. This one sorts.", at: 5.4 },
      ],
    }),
    sequence(rendered, playing, sorted),
    panel("render-terminal", {
      x: RIGHT,
      y: 750,
      w: RIGHT_W,
      h: 170,
      name: "terminal",
      at: PARTS.render[0] + 1.2,
      until: PARTS.render[1],
    }),
    terminal("render", {
      x: RIGHT,
      y: 750,
      columns: 58,
      start: PARTS.render[0] + 1.9,
      until: PARTS.render[1],
      lines: [
        { kind: "cmd", text: "depthcue render demo" },
        { kind: "ok", text: transcript.render.split("\n").at(-1) },
      ],
    }),
    // The Sort button is at x 1008 to 1186 and y 582 to 621 in the 1920 by 1080 capture.
    ring("sort", {
      x: RIGHT + 1008 * SHOT - 6,
      y: 170 + 582 * SHOT - 6,
      w: 178 * SHOT + 12,
      h: 39 * SHOT + 12,
      label: "click",
      at: PARTS.render[0] + 6.4,
      until: PARTS.render[0] + 8.6,
    }),
  );

  // ---- 04 a person repairs it
  add(
    words("human", {
      kicker: "04 · A person repairs it",
      headline: "The editor makes the same edits.",
      support: [{ text: "Each scene says who leads, a person or an agent. Changes save by themselves." }],
    }),
    picture("human-editor", "assets/editor.png", { y: 170, at: PARTS.human[0] + 0.3, until: PARTS.human[1] }),
    // The Human, Agent and Shared buttons of the top bar are at x 843 to 1055 and y 9 to 45 in the capture.
    ring("lead", {
      x: RIGHT + 843 * SHOT - 4,
      y: 170 + 9 * SHOT - 4,
      w: 212 * SHOT + 8,
      h: 36 * SHOT + 8,
      label: "who leads",
      labelAt: "below",
      at: PARTS.human[0] + 2.4,
      until: PARTS.human[1],
    }),
  );

  // ---- 05 handing a scene to an agent
  const bar = { w: RIGHT_W, h: Math.round((RIGHT_W * CONTROLS.h) / CONTROLS.w) };
  const barY = 770;
  const person = picture("controls-person", "assets/controls-person.png", {
    y: barY,
    ...bar,
    at: PARTS.handoff[0] + 1.2,
    until: PARTS.handoff[0] + 3.2,
    tilt: false,
    enter: { name: "fade", dur: 0.4 },
  });
  const agent = picture("controls-agent", "assets/controls-agent.png", {
    y: barY,
    ...bar,
    at: PARTS.handoff[0] + 3.2,
    until: PARTS.handoff[1],
    tilt: false,
    enter: { name: "fade", dur: 0.3 },
  });
  const barScale = bar.w / CONTROLS.w;
  add(
    words("handoff", {
      kicker: "05 · Hand over",
      headline: "Give a scene\nto an agent.",
      support: [{ text: "Take it back with Escape. The deck stays where it was." }],
    }),
    picture("handoff-slide", "assets/player-sorted.png", {
      y: 170,
      at: PARTS.handoff[0] + 0.3,
      until: PARTS.handoff[1],
    }),
    sequence(person, agent),
    // The chip that names who is presenting, and the button that takes control back, in the cropped control bar.
    ring("chip", {
      x: RIGHT + (1314 - CONTROLS.x) * barScale - 8,
      y: barY + (1038 - CONTROLS.y) * barScale - 6,
      w: 160 * barScale + 16,
      h: 24 * barScale + 12,
      label: "agent presenting",
      labelAt: "below",
      at: PARTS.handoff[0] + 3.6,
      until: PARTS.handoff[1],
    }),
  );

  // ---- 06 delivering a folder
  add(
    words("deliver", {
      kicker: "06 · Deliver",
      headline: "Deliver a folder.",
      support: [{ text: "Double-click index.html. No server, no network." }],
    }),
    panel("deliver-terminal", {
      x: RIGHT,
      y: 150,
      w: RIGHT_W,
      h: 260,
      name: "terminal",
      ...span("deliver", 0.4),
    }),
    terminal("deliver", {
      x: RIGHT,
      y: 150,
      columns: 58,
      start: PARTS.deliver[0] + 1.0,
      until: PARTS.deliver[1],
      lines: [
        { kind: "cmd", text: "depthcue export demo --out demo-export" },
        ...transcript.delivery.split("\n").map((text, index) => ({ kind: index === 0 ? "ok" : "out", text })),
      ],
    }),
    picture("deliver-page", "assets/exported.png", {
      x: RIGHT + 140,
      y: 460,
      w: 680,
      at: PARTS.deliver[0] + 3.2,
      until: PARTS.deliver[1],
    }),
    {
      id: "deliver-caption",
      type: "text",
      text: "index.html, opened from the disk",
      x: RIGHT + RIGHT_W / 2,
      y: 910,
      font: FONTS.mono,
      size: 24,
      fill: color.muted,
      at: PARTS.deliver[0] + 3.7,
      until: PARTS.deliver[1],
      enter: "fade",
      exit: fadeOut,
    },
  );

  // ---- the close
  add(
    {
      id: "end-mark",
      type: "image",
      src: "assets/mark.png",
      x: "50%",
      y: 380,
      w: 220,
      ...span("end", 0.1),
      enter: { name: "pop", dur: 0.6 },
    },
    {
      id: "end-wordmark",
      type: "text",
      text: "Depthcue",
      x: "50%",
      y: 600,
      font: FONTS.display,
      weight: 400,
      size: 150,
      fill: color.text,
      ...span("end", 0.3),
      enter: "fade",
    },
    {
      id: "end-line",
      type: "text",
      text: "Decks that agents write and people present.",
      x: "50%",
      y: 770,
      font: FONTS.ui,
      size: 36,
      maxWidth: 1100,
      fill: color.muted,
      ...span("end", 0.3),
      enter: "fade",
    },
  );

  add({ use: "progress", id: "progress", color: color.action, h: 6 });

  return {
    canvas: { w: W, h: H, fps: 30, bg: color.bg, duration: PARTS.end[1] },
    layers,
  };
}
