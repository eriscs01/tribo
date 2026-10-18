import { problemMessage } from './problem';

/** A form- or page-level error, announced when it appears. */
export function ErrorNotice({ error, message }: { error?: unknown; message?: string }) {
  if (error === undefined && message === undefined) return null;
  return (
    <p role="alert" className="notice notice-error">
      {message ?? problemMessage(error)}
    </p>
  );
}
