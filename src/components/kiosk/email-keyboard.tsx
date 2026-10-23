"use client";

import { Delete } from "lucide-react";

const ROWS = ["1234567890", "qwertyuiop", "asdfghjkl-", "zxcvbnm_."];
const DOMAINS = ["@gmail.com", "@yahoo.com", "@icloud.com", "@outlook.com"];
const MAX_LENGTH = 254;

/** Edits the address directly without emitting hardware keyboard shortcut events. */
export function EmailKeyboard({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const type = (text: string) => onChange((value + text).slice(0, MAX_LENGTH));
  const addDomain = (domain: string) =>
    onChange((value.split("@")[0] + domain).slice(0, MAX_LENGTH));

  return (
    <div
      className="kiosk-keyboard"
      role="group"
      aria-label="On-screen email keyboard"
      data-ip-shortcut-ignore
      onPointerDown={(event) => event.preventDefault()}
    >
      <div className="kiosk-keyboard-domains">
        {DOMAINS.map((domain) => (
          <button
            key={domain}
            type="button"
            onClick={() => addDomain(domain)}
            disabled={disabled}
          >
            {domain}
          </button>
        ))}
      </div>
      {ROWS.map((row, rowIndex) => (
        <div className="kiosk-keyboard-row" key={row}>
          {row.split("").map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => type(key)}
              disabled={disabled}
            >
              {key}
            </button>
          ))}
          {rowIndex === ROWS.length - 1 && (
            <button
              type="button"
              className="is-wide is-muted"
              aria-label="Delete one character"
              onClick={() => onChange(value.slice(0, -1))}
              disabled={disabled || !value}
            >
              <Delete size={40} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
      <div className="kiosk-keyboard-row">
        <button
          type="button"
          className="is-wide is-accent"
          onClick={() => type("@")}
          disabled={disabled}
        >
          @
        </button>
        <button
          type="button"
          className="is-wide is-accent"
          onClick={() => type(".com")}
          disabled={disabled}
        >
          .com
        </button>
        <button
          type="button"
          className="is-wide is-muted"
          onClick={() => onChange("")}
          disabled={disabled || !value}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
