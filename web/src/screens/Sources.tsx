import { useState } from 'react';
import { useMe } from '../state/auth';
import { useMySources } from '../state/data';
import { AddByUrl, CatalogBrowser, MySourcesList, useSourceLimit } from '../components/Sources';
import { Icon } from '../components/Icon';
import { PageHeader, UsageMeter } from '../components/ui';

export function Sources() {
  const mine = useMySources();
  const limit = useSourceLimit();
  const me = useMe();
  const [err, setErr] = useState<string | null>(null);
  const used = mine.data?.length ?? 0;
  return (
    <div className="page page-sources">
      <PageHeader title="Sources" kicker="What goes into your bulletins" />
      {mine.data && <UsageMeter used={used} max={limit} label={`sources on the ${me.plan === 'free' ? 'Free' : 'Pro'} plan`} />}

      {err && (
        <p className="note note-error" role="alert">
          <Icon name="alert" size={18} /> <span>{err}</span>
        </p>
      )}

      <section className="section" aria-labelledby="mine-h">
        <div className="section-head">
          <h2 id="mine-h" className="section-title">
            Your sources
          </h2>
          <p className="section-sub">Priority decides whose stories lead. “Lead with” sources open the bulletin.</p>
        </div>
        <MySourcesList onError={setErr} />
      </section>

      <section className="section" aria-labelledby="url-h">
        <h2 id="url-h" className="visually-hidden">
          Add a feed by URL
        </h2>
        <div className="card">
          <AddByUrl disabled={used >= limit} />
        </div>
      </section>

      <section className="section" aria-labelledby="cat-h">
        <div className="section-head">
          <h2 id="cat-h" className="section-title">
            Catalog
          </h2>
          <p className="section-sub">Hand-picked outlets that work well read aloud.</p>
        </div>
        <CatalogBrowser onError={setErr} />
      </section>
    </div>
  );
}
