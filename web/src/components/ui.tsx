import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '../lib/api';
import { Icon } from './Icon';

export function Spinner({ size = 18, label }: { size?: number; label?: string }) {
  return (
    <span className="spinner" style={{ width: size, height: size }} role={label ? 'status' : undefined} aria-label={label}>
      <span aria-hidden="true" />
    </span>
  );
}

export function PageHeader({ title, kicker, actions }: { title: string; kicker?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        {kicker && <p className="kicker">{kicker}</p>}
        <h1>{title}</h1>
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="note note-error" role="alert">
      <Icon name="alert" size={20} />
      <span>{errorMessage(error)}</span>
      {onRetry && (
        <button type="button" className="btn btn-quiet btn-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading-block">
      <Spinner size={22} label={label} />
    </div>
  );
}

export type SaveState = { state: 'idle' | 'saving' | 'saved' | 'error'; message?: string };

/** Runs saves and exposes a status for <SaveIndicator>. */
export function useSaveStatus() {
  const [status, setStatus] = useState<SaveState>({ state: 'idle' });
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    window.clearTimeout(timer.current);
    setStatus({ state: 'saving' });
    try {
      const r = await fn();
      setStatus({ state: 'saved' });
      timer.current = window.setTimeout(() => setStatus({ state: 'idle' }), 2200);
      return r;
    } catch (e) {
      setStatus({ state: 'error', message: errorMessage(e) });
      return undefined;
    }
  }, []);
  return { status, run };
}

export function SaveIndicator({ status }: { status: SaveState }) {
  return (
    <div className={`save-indicator save-${status.state}`} role="status" aria-live="polite">
      {status.state === 'saving' && (
        <>
          <Spinner size={14} /> Saving…
        </>
      )}
      {status.state === 'saved' && (
        <>
          <Icon name="check" size={16} /> Saved
        </>
      )}
      {status.state === 'error' && (
        <>
          <Icon name="alert" size={16} /> {status.message ?? 'Not saved'}
        </>
      )}
    </div>
  );
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  size,
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; hint?: string }[];
  onChange: (v: T) => void;
  size?: 'sm';
}) {
  return (
    <div className={`segmented${size ? ` segmented-${size}` : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.hint}
          className={o.value === value ? 'is-on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="switch-row"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        {description && <span className="switch-desc">{description}</span>}
      </span>
      <span className={`switch${checked ? ' is-on' : ''}`} aria-hidden="true">
        <span />
      </span>
    </button>
  );
}

export function UsageMeter({ used, max, label }: { used: number; max: number; label: string }) {
  const pct = Math.min(100, Math.round((used / Math.max(1, max)) * 100));
  return (
    <div className={`usage${used >= max ? ' is-full' : ''}`}>
      <div className="usage-text">
        <strong>
          {used} of {max}
        </strong>{' '}
        {label}
      </div>
      <div className="usage-bar" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
