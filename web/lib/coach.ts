// Guided-walkaround segments. Order and timestamps feed vehicle-relative
// localization in Workflow V ("driver-side rear quarter"), so ids are stable
// API surface — don't rename casually.

export interface CoachSegment {
  id: string;
  label: string;
  hint: string;
  /** Minimum dwell before "Next" unlocks, in ms. */
  minMs: number;
}

export const COACH_SEGMENTS: CoachSegment[] = [
  {
    id: "full-car",
    label: "Frame the whole car",
    hint: "Stand back so the entire car fits in frame — this still identifies the vehicle.",
    minMs: 4000,
  },
  {
    id: "front",
    label: "Front",
    hint: "Walk in slowly. Bumper, hood, windshield, both headlights.",
    minMs: 6000,
  },
  {
    id: "front-left",
    label: "Front-left corner",
    hint: "Corner of the bumper, left headlight, wheel and arch.",
    minMs: 6000,
  },
  {
    id: "driver-side",
    label: "Driver side",
    hint: "Move slowly along both doors. Keep the panels filling the frame.",
    minMs: 6000,
  },
  {
    id: "rear-left",
    label: "Rear-left corner",
    hint: "Rear quarter panel, tail light, corner of the bumper.",
    minMs: 6000,
  },
  {
    id: "rear",
    label: "Rear",
    hint: "Trunk, rear bumper, both tail lights, rear window.",
    minMs: 6000,
  },
  {
    id: "rear-right",
    label: "Rear-right corner",
    hint: "Rear quarter panel, tail light, corner of the bumper.",
    minMs: 6000,
  },
  {
    id: "passenger-side",
    label: "Passenger side",
    hint: "Move slowly along both doors. Keep the panels filling the frame.",
    minMs: 6000,
  },
  {
    id: "front-right",
    label: "Front-right corner",
    hint: "Corner of the bumper, right headlight, wheel and arch.",
    minMs: 6000,
  },
];

/** Warn below this total duration (plan: <45 s is a rushed walkaround). */
export const MIN_WALKAROUND_MS = 45_000;
/** Warn below this vertical resolution. */
export const MIN_HEIGHT_PX = 720;
