export function WardaIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-label="Warda logo"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Warda</title>
      {/* A bounded shield: authority with a ceiling, which is the whole idea. */}
      <path d="M12 3 4 6v6c0 4 3.4 7.4 8 9 4.6-1.6 8-5 8-9V6l-8-3Z" />
      <path d="M8 12h8" />
    </svg>
  );
}
