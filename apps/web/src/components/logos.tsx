/**
 * Provider marks, inline so the page ships no external assets and renders
 * identically offline. Each is a simplified rendering of the provider's
 * mark in its brand colours, used only to identify the integration.
 */

type MarkProps = { size?: number; title?: string };

export function GmailMark({ size = 24, title = "Gmail" }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 36"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M3.3 36h7.6V17.5L0 9.4v23.3A3.3 3.3 0 0 0 3.3 36z" fill="#4285F4" />
      <path d="M37.1 36h7.6a3.3 3.3 0 0 0 3.3-3.3V9.4l-10.9 8.1z" fill="#34A853" />
      <path d="M37.1 3.3v14.2L48 9.4V4.9c0-4.1-4.7-6.4-8-3.9z" fill="#FBBC04" />
      <path d="M10.9 17.5V3.3L24 13.1 37.1 3.3v14.2L24 27.3z" fill="#EA4335" />
      <path d="M0 4.9v4.5l10.9 8.1V3.3L8 1C4.7-1.5 0 .8 0 4.9z" fill="#C5221F" />
    </svg>
  );
}

export function SalesforceMark({ size = 24, title = "Salesforce" }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 45"
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M26.6 4.9c2.1-2.2 5-3.5 8.2-3.5 4.3 0 8 2.4 10 5.9a13.1 13.1 0 0 1 5.4-1.2c7.3 0 13.3 6 13.3 13.4S57.5 33 50.2 33c-.9 0-1.8-.1-2.6-.3a9.8 9.8 0 0 1-8.5 5 9.7 9.7 0 0 1-4.2-1 11.2 11.2 0 0 1-20.8-.5 10.1 10.1 0 0 1-2.1.2C5.4 36.4 0 31 0 24.4c0-4.4 2.4-8.3 5.9-10.4a12.2 12.2 0 0 1-1-4.9C4.9 3.9 9.9 0 15.6 0c3.6 0 6.9 1.7 8.9 4.4z"
        fill="#00A1E0"
      />
    </svg>
  );
}
