import { useCallback, useId, useMemo, useState, type FormEvent } from 'react';
import { LIMITS } from '@shared/constants';
import type { MySourceDto, SourceDto } from '@shared/contracts';
import { api, errorMessage } from '../lib/api';
import { hostOf } from '../lib/format';
import { mutateResource } from '../lib/resource';
import { useMe } from '../state/auth';
import { useCatalog, useMySources } from '../state/data';
import { Icon } from './Icon';
import { ErrorNote, Loading, Segmented, Spinner } from './ui';

export const WEIGHTS = [
  { value: 1, label: 'Normal', hint: 'Mixed in with everything else' },
  { value: 2, label: 'Prefer', hint: 'Picked more often' },
  { value: 3, label: 'Lead with', hint: 'Top stories come from here first' },
];

export function useSourceLimit() {
  const me = useMe();
  return LIMITS.plans[me.plan].maxSources;
}

/** Optimistic add/remove/weight on the shared `mySources` cache. */
export function useSourceActions() {
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const mark = (id: string, on: boolean) =>
    setBusy((b) => {
      const n = new Set(b);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const addFromCatalog = useCallback(async (s: SourceDto) => {
    mark(s.id, true);
    try {
      const added = await api.addSource({ sourceId: s.id });
      mutateResource<MySourceDto[]>('mySources', (prev) => [...(prev ?? []).filter((x) => x.id !== added.id), added]);
      return added;
    } finally {
      mark(s.id, false);
    }
  }, []);

  const addByUrl = useCallback(async (url: string) => {
    const added = await api.addSource({ url });
    mutateResource<MySourceDto[]>('mySources', (prev) => [...(prev ?? []).filter((x) => x.id !== added.id), added]);
    return added;
  }, []);

  const remove = useCallback(async (s: MySourceDto) => {
    let prev: MySourceDto[] | undefined;
    mutateResource<MySourceDto[]>('mySources', (p) => {
      prev = p;
      return (p ?? []).filter((x) => x.id !== s.id);
    });
    try {
      await api.removeSource(s.id);
    } catch (e) {
      if (prev) mutateResource('mySources', prev);
      throw e;
    }
  }, []);

  const setWeight = useCallback(async (s: MySourceDto, weight: number) => {
    const apply = (w: number) =>
      mutateResource<MySourceDto[]>('mySources', (p) => (p ?? []).map((x) => (x.id === s.id ? { ...x, weight: w } : x)));
    apply(weight);
    try {
      await api.updateSource(s.id, weight);
    } catch (e) {
      apply(s.weight);
      throw e;
    }
  }, []);

  return { busy, addFromCatalog, addByUrl, remove, setWeight };
}

export function MySourcesList({ onError }: { onError: (msg: string | null) => void }) {
  const { data, error, loading, reload } = useMySources();
  const actions = useSourceActions();
  if (loading) return <Loading label="Loading your sources" />;
  if (error) return <ErrorNote error={error} onRetry={reload} />;
  if (!data?.length)
    return (
      <div className="empty-inline">
        <p>
          <strong>No sources yet.</strong> Add a few from the catalog below — four or five is a good start.
        </p>
      </div>
    );
  const sorted = [...data].sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title));
  return (
    <ul className="my-sources">
      {sorted.map((s) => (
        <li key={s.id} className={`my-source${s.unhealthy ? ' is-unhealthy' : ''}`}>
          <div className="my-source-head">
            <div className="my-source-text">
              <span className="my-source-title">{s.title}</span>
              <span className="my-source-meta">
                {s.category} · {hostOf(s.siteUrl ?? s.url)}
              </span>
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove ${s.title}`}
              onClick={() => {
                onError(null);
                actions.remove(s).catch((e: unknown) => onError(errorMessage(e)));
              }}
            >
              <Icon name="trash" size={20} />
            </button>
          </div>
          {s.unhealthy && (
            <p className="flag" role="note">
              <Icon name="alert" size={16} /> This feed hasn’t responded lately. Its stories may be missing until it recovers.
            </p>
          )}
          <Segmented
            size="sm"
            label={`Priority for ${s.title}`}
            value={s.weight}
            options={WEIGHTS}
            onChange={(w) => {
              onError(null);
              actions.setWeight(s, w).catch((e: unknown) => onError(errorMessage(e)));
            }}
          />
        </li>
      ))}
    </ul>
  );
}

export function AddByUrl({ disabled }: { disabled?: boolean }) {
  const { addByUrl } = useSourceActions();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const id = useId();
  const errId = useId();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let value = url.trim();
    if (!value) return;
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
    setBusy(true);
    setError(null);
    setAdded(null);
    try {
      const s = await addByUrl(value);
      setUrl('');
      setAdded(s.title);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="add-url" onSubmit={submit}>
      <label htmlFor={id}>Add any RSS or Atom feed</label>
      <div className="add-url-row">
        <input
          id={id}
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://example.com/feed.xml"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-invalid={!!error}
          aria-describedby={error ? errId : undefined}
          disabled={disabled}
        />
        <button type="submit" className="btn btn-secondary" disabled={busy || disabled || !url.trim()}>
          {busy ? <Spinner size={16} /> : <Icon name="plus" size={18} />}
          Add
        </button>
      </div>
      {error && (
        <p className="field-error" id={errId} role="alert">
          <Icon name="alert" size={16} /> {error}
        </p>
      )}
      {added && (
        <p className="field-ok" role="status">
          <Icon name="check" size={16} /> Added {added}.
        </p>
      )}
    </form>
  );
}

export function CatalogBrowser({ onError }: { onError: (msg: string | null) => void }) {
  const catalog = useCatalog();
  const mine = useMySources();
  const limit = useSourceLimit();
  const { busy, addFromCatalog, remove } = useSourceActions();
  const [q, setQ] = useState('');
  const searchId = useId();

  const mineIds = useMemo(() => new Set((mine.data ?? []).map((s) => s.id)), [mine.data]);
  const atLimit = (mine.data?.length ?? 0) >= limit;

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (catalog.data ?? []).filter(
      (s) => !needle || s.title.toLowerCase().includes(needle) || s.category.toLowerCase().includes(needle) || hostOf(s.siteUrl ?? s.url).includes(needle),
    );
    const map = new Map<string, SourceDto[]>();
    for (const s of list) {
      const arr = map.get(s.category) ?? [];
      arr.push(s);
      map.set(s.category, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [catalog.data, q]);

  if (catalog.loading) return <Loading label="Loading the catalog" />;
  if (catalog.error) return <ErrorNote error={catalog.error} onRetry={catalog.reload} />;

  return (
    <div className="catalog">
      <div className="search">
        <label htmlFor={searchId} className="visually-hidden">
          Search the catalog
        </label>
        <Icon name="search" size={20} />
        <input id={searchId} type="search" placeholder="Search outlets or topics" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {atLimit && (
        <p className="note note-info" role="status">
          You’re using all {limit} sources on your plan. Remove one to add another.
        </p>
      )}
      {groups.length === 0 && <p className="muted">Nothing matches “{q}”. Try a broader word, or add the feed by URL.</p>}
      {groups.map(([cat, items]) => (
        <section key={cat} className="catalog-group" aria-label={cat}>
          <h3>{cat}</h3>
          <ul>
            {items.map((s) => {
              const added = mineIds.has(s.id);
              const isBusy = busy.has(s.id);
              return (
                <li key={s.id} className="catalog-item">
                  <span className="catalog-text">
                    <span className="catalog-title">{s.title}</span>
                    <span className="catalog-host">{hostOf(s.siteUrl ?? s.url)}</span>
                  </span>
                  <button
                    type="button"
                    className={`chip-btn${added ? ' is-added' : ''}`}
                    aria-pressed={added}
                    aria-label={added ? `${s.title} added. Tap to remove.` : `Add ${s.title}`}
                    disabled={isBusy || (!added && atLimit)}
                    onClick={() => {
                      onError(null);
                      const mineSrc = mine.data?.find((m) => m.id === s.id);
                      const p = added && mineSrc ? remove(mineSrc) : addFromCatalog(s);
                      p.catch((e: unknown) => onError(errorMessage(e)));
                    }}
                  >
                    {isBusy ? <Spinner size={16} /> : <Icon name={added ? 'check' : 'plus'} size={18} />}
                    <span>{added ? 'Added' : 'Add'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
