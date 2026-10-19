import { m } from '../messages';
import { problemMessage, problemReference } from './problem';

/** A form- or page-level error, announced when it appears, with the reference to quote. */
export function ErrorNotice({ error, message }: { error?: unknown; message?: string }) {
  if (error === undefined && message === undefined) return null;
  const reference = problemReference(error);
  return (
    <p role="alert" className="notice notice-error">
      {message ?? problemMessage(error)}
      {reference === undefined ? null : (
        <>
          {' '}
          <span className="notice-reference">{m.errors.reference(reference)}</span>
        </>
      )}
    </p>
  );
}
