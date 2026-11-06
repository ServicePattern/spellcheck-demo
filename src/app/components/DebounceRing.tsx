export function DebounceRing({ durationMs }: { durationMs: number }) {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg aria-hidden="true" viewBox="0 0 14 14" className="size-3.5 -rotate-90">
      <circle cx="7" cy="7" r={radius} fill="none" className="stroke-slate-200" strokeWidth="2" />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        className="stroke-slate-400"
        strokeWidth="2"
        strokeDasharray={circumference}
        style={{ strokeDashoffset: circumference, animation: `debounce-ring ${durationMs}ms linear forwards` }}
      />
    </svg>
  );
}
