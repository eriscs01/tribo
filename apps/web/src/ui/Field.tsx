import { useId, type ReactNode } from 'react';
import { m } from '../messages.js';

interface FieldProps {
  label: string;
  hint?: string;
  error?: string | undefined;
  optional?: boolean;
  /** Renders the control with the ids its label, hint and error point at. */
  children: (control: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: true;
  }) => ReactNode;
}

/** A labelled control with its hint and error wired up for assistive technology. */
export function Field({ label, hint, error, optional = false, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {optional ? <span className="muted"> {m.optional}</span> : null}
      </label>
      {hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
      {children({
        id,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true as const } : {}),
      })}
      {error ? (
        <p id={errorId} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
