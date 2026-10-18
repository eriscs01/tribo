import { useId, type InputHTMLAttributes } from 'react';

/** Zone names the browser knows, offered as suggestions; the server decides what is valid. */
const ZONES = Intl.supportedValuesOf('timeZone');

type TimeZoneInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'list' | 'onChange'> & {
  value: string;
  onChange: (zone: string) => void;
};

/** A free-text IANA zone field with the browser's zones as suggestions. */
export function TimeZoneInput({ onChange, ...input }: TimeZoneInputProps) {
  const listId = useId();
  return (
    <>
      <input
        {...input}
        list={listId}
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
      <datalist id={listId}>
        {ZONES.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
    </>
  );
}
