import { Fragment, useEffect, useState } from 'react';
import type { Biome, DiscoveryMethod, Fact, HostRegistration } from '@berrie/shared';
import { BIOMES, FACT_LABEL } from '@berrie/shared';
import { useStore } from '../state/store';
import { api } from '../state/api';
import { Icon } from './Icon';
import { HEALTH_COLOR, timeAgo } from './status';

type Listed = HostRegistration & { health: string | null; healthReason: string | null; lifecycle: string | null; services: number };
interface Preview { ok: boolean; steps: { step: string; ok: boolean; detail: string }[]; facts?: Record<string, Fact<unknown>>; containers?: { id: string; name: string; project: string | null; state: string; health: string }[] }

const METHOD_INFO: Record<DiscoveryMethod, { title: string; icon: string; text: string }> = {
  ssh: { title: 'SSH', icon: 'lock', text: 'Berrie World connects out to the server, runs one fixed read-only collector and (optionally) reads Docker through a forwarded socket. Host key pinned; credential encrypted.' },
  agent: { title: 'Agent', icon: 'activity', text: 'A tiny shell script on the server pushes facts every minute with its own token. No inbound access to the server needed.' },
  docker: { title: 'Docker API', icon: 'server', text: 'Read containers from a read-only docker-socket-proxy URL reachable from Berrie World. No host metrics (unless you also add an agent).' },
  manual: { title: 'Manual', icon: 'edit', text: 'Just an island with a name — for devices you cannot or do not want to scan. Optional reachability probe.' },
};

const emptyForm = () => ({
  id: '', name: '', tags: '', biome: 'meadow' as Biome, method: 'ssh' as DiscoveryMethod,
  address: '', port: 22, username: 'berrie', authMethod: 'generated' as 'generated' | 'key' | 'password', privateKey: '', passphrase: '', password: '',
  docker: 'none' as 'none' | 'socket' | 'tcp', dockerSocket: '/var/run/docker.sock', dockerTcpPort: 2375, dockerUrl: '', intervalSeconds: 60, probe: false, description: '',
});

function FactsPreview({ facts }: { facts: Record<string, Fact<unknown>> }) {
  const v = (k: string) => facts[k]?.value as Record<string, unknown> | null;
  const line = (k: string): string => {
    const f = facts[k];
    if (!f || f.status !== 'confirmed') return `${f?.status ?? 'unknown'}${f?.error ? ` — ${f.error}` : ''}`;
    const x = v(k)!;
    switch (k) {
      case 'identity': return String(x.hostname);
      case 'os': return `${x.name}${x.kernel ? ` · kernel ${x.kernel}` : ''}`;
      case 'cpu': return `${x.cores} cores${x.model ? ` · ${x.model}` : ''}${x.usagePct != null ? ` · ${x.usagePct}% busy` : ''}`;
      case 'memory': return x.usedPct != null ? `${x.usedPct}% of ${(Number(x.totalBytes) / 1e9).toFixed(1)} GB used` : `${(Number(x.totalBytes) / 1e9).toFixed(1)} GB`;
      case 'storage': return (x.filesystems as { mount: string; usedPct: number }[]).slice(0, 4).map((f) => `${f.mount} ${f.usedPct}%`).join(' · ');
      case 'network': return (x.interfaces as { name: string }[]).map((i) => i.name).join(', ') || 'no physical interfaces';
      case 'uptime': return `up ${Math.round(Number(x.seconds) / 3600)} h · load ${x.load1}`;
      case 'containers': return `${x.running} running, ${x.stopped} stopped`;
      default: return '';
    }
  };
  return (
    <dl className="facts">
      {Object.keys(FACT_LABEL).map((k) => <Fragment key={k}><dt>{FACT_LABEL[k as keyof typeof FACT_LABEL]}</dt><dd className={facts[k]?.status !== 'confirmed' ? 'muted' : ''}>{line(k)}</dd></Fragment>)}
    </dl>
  );
}

function AgentInstall({ token, onClose }: { token: string; onClose: () => void }) {
  const [assets, setAssets] = useState<{ script: string; units: string } | null>(null);
  useEffect(() => { api<{ script: string; units: string }>('/api/harbor/agent-script').then(setAssets).catch(() => undefined); }, []);
  const env = `BERRIE_URL=${location.origin}\nBERRIE_TOKEN=${token}\nBERRIE_DOCKER=0\n# BERRIE_DOCKER_URL=http://127.0.0.1:2375`;
  const copy = (t: string) => void navigator.clipboard?.writeText(t);
  return (
    <div className="card agent-install">
      <h3><Icon name="activity" /> Install the agent</h3>
      <p className="banner bad">This token is shown <b>once</b>. Store it only in the agent's env file on that server.</p>
      <ol className="steps">
        <li>Create an unprivileged user: <code>sudo useradd --system --no-create-home --shell /usr/sbin/nologin berrie-agent</code></li>
        <li>Save the script below as <code>/usr/local/bin/berrie-agent</code> and run <code>sudo chmod 755 /usr/local/bin/berrie-agent</code>. It only reads <code>/proc</code>, <code>df</code> and status commands.</li>
        <li>Create <code>/etc/berrie-agent.env</code> (owner <code>berrie-agent</code>, mode <code>600</code>):
          <pre className="code">{env}</pre><button onClick={() => copy(env)}><Icon name="copy" /> Copy env file</button></li>
        <li>Install the systemd service and timer below, then <code>sudo systemctl daemon-reload && sudo systemctl enable --now berrie-agent.timer</code>.</li>
        <li>Container reporting is off by default. To enable it, run a read-only <code>docker-socket-proxy</code> on <code>127.0.0.1:2375</code> and set <code>BERRIE_DOCKER=1</code> and <code>BERRIE_DOCKER_URL</code> — do not add the agent user to the <code>docker</code> group (that is root-equivalent).</li>
      </ol>
      {assets && (
        <>
          <details><summary>Agent script</summary><pre className="code">{assets.script}</pre><button onClick={() => copy(assets.script)}><Icon name="copy" /> Copy script</button></details>
          <details><summary>systemd units</summary><pre className="code">{assets.units}</pre><button onClick={() => copy(assets.units)}><Icon name="copy" /> Copy units</button></details>
        </>
      )}
      <button className="primary" onClick={onClose}>Done</button>
    </div>
  );
}

export function HarborView() {
  const select = useStore((s) => s.select);
  const setView = useStore((s) => s.setView);
  const [hosts, setHosts] = useState<Listed[]>([]);
  const [collector, setCollector] = useState('');
  const [editing, setEditing] = useState<Listed | 'new' | null>(null);
  const [f, setF] = useState(emptyForm());
  const [hostKey, setHostKey] = useState<{ hostKey: string; fingerprint: string; type: string } | null>(null);
  const [keyOk, setKeyOk] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [agentToken, setAgentToken] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<Listed | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState('');
  const [genKey, setGenKey] = useState<{ keyId: string; publicKey: string } | null>(null);

  const load = () => api<{ hosts: Listed[]; collector: string }>('/api/harbor/hosts').then((r) => { setHosts(r.hosts); setCollector(r.collector); }).catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  useEffect(() => { void load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);

  const set = <K extends keyof ReturnType<typeof emptyForm>>(k: K, v: ReturnType<typeof emptyForm>[K]) => { setF({ ...f, [k]: v }); setPreview(null); };
  const run = async (fn: () => Promise<void>) => { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); } };

  const startNew = () => { setEditing('new'); setF(emptyForm()); setHostKey(null); setKeyOk(false); setPreview(null); setForce(false); setGenKey(null); };
  const startEdit = (h: Listed) => {
    setEditing(h); setHostKey(h.hostKeyFingerprint ? { hostKey: '', fingerprint: h.hostKeyFingerprint, type: '' } : null); setKeyOk(!!h.hostKeyFingerprint); setPreview(null); setForce(false);
    setF({ ...emptyForm(), id: h.id, name: h.name, tags: h.tags.join(', '), biome: h.appearance.biome ?? 'meadow', method: h.method, ...h.settings,
      port: h.settings.port ?? 22, username: h.settings.username ?? 'berrie', docker: h.settings.docker ?? 'none', dockerSocket: h.settings.dockerSocket ?? '/var/run/docker.sock',
      dockerTcpPort: h.settings.dockerTcpPort ?? 2375, dockerUrl: h.settings.dockerUrl ?? '', intervalSeconds: h.settings.intervalSeconds ?? 60, probe: !!h.settings.probe, description: h.settings.description ?? '',
      authMethod: h.settings.authMethod ?? 'key' } as ReturnType<typeof emptyForm>);
    setGenKey(null);
  };
  const isNew = editing === 'new';
  const editingConfig = editing !== 'new' && editing?.source === 'config';

  const settings = () => {
    const s: Record<string, unknown> = { intervalSeconds: f.intervalSeconds, description: f.description || undefined };
    if (f.method === 'ssh') Object.assign(s, { address: f.address, port: f.port, username: f.username, docker: f.docker, ...(f.docker === 'socket' ? { dockerSocket: f.dockerSocket } : {}), ...(f.docker === 'tcp' ? { dockerTcpPort: f.dockerTcpPort } : {}) });
    if (f.method === 'docker') s.dockerUrl = f.dockerUrl;
    if (f.method === 'manual' && f.probe) Object.assign(s, { address: f.address, port: f.port, probe: true });
    return s;
  };
  const credential = () => {
    if (f.method !== 'ssh') return undefined;
    if (f.authMethod === 'generated') return genKey ? { kind: 'generated', keyId: genKey.keyId } : undefined;
    if (f.authMethod === 'key') return f.privateKey ? { kind: 'key', privateKey: f.privateKey, passphrase: f.passphrase || undefined } : undefined;
    return f.password ? { kind: 'password', password: f.password } : undefined;
  };
  const restrictions = f.docker === 'tcp' ? `restrict,port-forwarding,permitopen="127.0.0.1:${f.dockerTcpPort}"` : f.docker === 'socket' ? 'no-pty,no-X11-forwarding,no-agent-forwarding' : 'restrict';
  const authorizedLine = `${restrictions} ${genKey?.publicKey ?? 'ssh-ed25519 AAAA… berrie-world'}`;

  const fetchKey = () => run(async () => { setHostKey(await api('/api/harbor/probe-key', { method: 'POST', json: { address: f.address, port: f.port } })); setKeyOk(false); });
  const test = () => run(async () => {
    setPreview(await api<Preview>('/api/harbor/test', { method: 'POST', json: { method: f.method, settings: settings(), credential: credential(), hostKey: hostKey?.hostKey || undefined, existingId: isNew ? undefined : f.id } }));
  });
  const save = () => run(async () => {
    const appearance = { biome: f.biome };
    const tags = f.tags.split(',').map((t) => t.trim()).filter(Boolean);
    if (isNew) {
      const r = await api<{ agentToken: string | null }>('/api/harbor/hosts', { method: 'POST', json: { id: f.id, name: f.name || f.id, method: f.method, tags, settings: settings(), credential: credential(), hostKey: hostKey?.hostKey || undefined, hostKeyConfirmed: keyOk, appearance } });
      if (r.agentToken) setAgentToken(r.agentToken);
      setMsg({ ok: true, text: `${f.name || f.id} registered. Its island appears after the first discovery.` });
    } else {
      const body: Record<string, unknown> = { name: f.name, tags, appearance };
      if (!editingConfig) { body.settings = settings(); const c = credential(); if (c) body.credential = c; if (hostKey?.hostKey) { body.hostKey = hostKey.hostKey; body.hostKeyConfirmed = keyOk; } }
      await api(`/api/harbor/hosts/${f.id}`, { method: 'PATCH', json: body });
      setMsg({ ok: true, text: `${f.name} updated.` });
    }
    setEditing(null);
    await load();
  });

  const needsTest = isNew && (f.method === 'ssh' || f.method === 'docker');
  const canSave = !busy && (f.method !== 'ssh' || !isNew || (keyOk && !!hostKey)) && (!needsTest || preview?.ok || (preview && force));

  return (
    <div className="page harbor">
      <div className="page-head">
        <h1><Icon name="anchor" /> Server Harbor</h1>
        <span className="muted">{hosts.filter((h) => h.status !== 'archived').length} server(s) · every registered server gets its own island</span>
        <button className="primary right" onClick={startNew}><Icon name="plus" /> Add server</button>
      </div>
      {msg && <div className={`banner ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</div>}
      {agentToken && <AgentInstall token={agentToken} onClose={() => setAgentToken(null)} />}

      {editing && (
        <section className="card wizard">
          <h3>{editing === 'new' ? 'Add a server' : `Edit ${editing.name}`}</h3>
          <div className="wiz-grid">
            <div className="form">
              <label>Id (permanent, lowercase)<input value={f.id} disabled={!isNew} onChange={(e) => set('id', e.target.value.toLowerCase())} placeholder="srv02" maxLength={32} /></label>
              <label>Display name<input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Basement NAS" maxLength={60} /></label>
              <label>Tags (comma-separated)<input value={f.tags} onChange={(e) => set('tags', e.target.value)} placeholder="home, storage" /></label>
              <label>Island biome
                <select value={f.biome} onChange={(e) => set('biome', e.target.value as Biome)}>{BIOMES.map((b) => <option key={b} value={b}>{b}</option>)}</select>
              </label>
            </div>
            {!editingConfig && (
              <div>
                <div className="method-cards">
                  {(Object.keys(METHOD_INFO) as DiscoveryMethod[]).map((m) => (
                    <button key={m} type="button" disabled={!isNew} className={`method${f.method === m ? ' on' : ''}`} onClick={() => set('method', m)}>
                      <b><Icon name={METHOD_INFO[m].icon} /> {METHOD_INFO[m].title}</b><span>{METHOD_INFO[m].text}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {!editingConfig && f.method === 'ssh' && (
            <div className="wiz-grid">
              <div className="form">
                <div className="row3">
                  <label>Address<input value={f.address} onChange={(e) => { set('address', e.target.value); setHostKey(null); setKeyOk(false); }} placeholder="srv02.tailnet.ts.net or 10.0.0.5" /></label>
                  <label>Port<input type="number" value={f.port} onChange={(e) => set('port', Number(e.target.value))} /></label>
                  <label>User<input value={f.username} onChange={(e) => set('username', e.target.value)} /></label>
                </div>
                <label>Authentication
                  <select value={f.authMethod} onChange={(e) => set('authMethod', e.target.value as 'generated')}>
                    <option value="generated">Generate a dedicated key for this server (recommended)</option>
                    <option value="key">Paste an existing private key</option>
                    <option value="password">Password</option>
                  </select>
                </label>
                {f.authMethod === 'generated' ? (
                  <div className="genkey">
                    {!genKey ? <button type="button" onClick={() => void run(async () => setGenKey(await api('/api/harbor/keypair', { method: 'POST' })))}><Icon name="lock" /> Generate key</button> : (
                      <>
                        <p className="small">Add this line to <code>~{f.username || 'berrie'}/.ssh/authorized_keys</code> on the server. The private key never leaves Berrie World.</p>
                        <pre className="code">{authorizedLine}</pre>
                        <button type="button" onClick={() => void navigator.clipboard?.writeText(authorizedLine)}><Icon name="copy" /> Copy line</button>
                      </>
                    )}
                  </div>
                ) : f.authMethod === 'key'
                  ? <><label>Private key {!isNew && '(leave empty to keep the stored one)'}<textarea rows={4} value={f.privateKey} onChange={(e) => set('privateKey', e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} /></label>
                    <label>Key passphrase (optional)<input type="password" value={f.passphrase} onChange={(e) => set('passphrase', e.target.value)} /></label></>
                  : <label>Password {!isNew && '(leave empty to keep)'}<input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} /></label>}
                <p className="small muted">Encrypted at rest with the master key, never shown again, never logged.</p>
                <label>Docker access
                  <select value={f.docker} onChange={(e) => set('docker', e.target.value as 'none')}>
                    <option value="none">None — host metrics only</option>
                    <option value="tcp">Read-only socket proxy on the server (recommended)</option>
                    <option value="socket">Docker socket (needs docker group: root-equivalent)</option>
                  </select>
                </label>
                {f.docker === 'tcp' && <label>Proxy port on the server's 127.0.0.1<input type="number" value={f.dockerTcpPort} onChange={(e) => set('dockerTcpPort', Number(e.target.value))} /></label>}
                {f.docker === 'socket' && <label>Socket path<input value={f.dockerSocket} onChange={(e) => set('dockerSocket', e.target.value)} /></label>}
                <label>Collect every (seconds)<input type="number" min={30} max={3600} value={f.intervalSeconds} onChange={(e) => set('intervalSeconds', Number(e.target.value))} /></label>
              </div>
              <div>
                <div className="callout gray">
                  <b>Least privilege</b>
                  <p>Use a dedicated user without sudo: <code>sudo useradd -m -s /bin/sh berrie</code>. Restrict its key in <code>authorized_keys</code> to exactly what Berrie World needs:</p>
                  <pre className="code">{restrictions} &lt;public key&gt;</pre>
                  {f.docker === 'tcp' && <p>Run <code>tecnativa/docker-socket-proxy</code> with only <code>CONTAINERS=1 EVENTS=1 INFO=1</code>, published on <code>127.0.0.1:{f.dockerTcpPort}</code>.</p>}
                </div>
                <div className={`callout ${keyOk ? 'gray' : 'amber'}`}>
                  <b>Host key {keyOk ? '— verified' : '— verify before connecting'}</b>
                  {hostKey ? (
                    <>
                      <p className="mono">{hostKey.type} {hostKey.fingerprint}</p>
                      <p>On the server, run <code>ssh-keygen -lf /etc/ssh/ssh_host_{hostKey.type.includes('ed25519') ? 'ed25519' : hostKey.type.includes('ecdsa') ? 'ecdsa' : 'rsa'}_key.pub</code> and compare. Only confirm if it matches exactly.</p>
                      <label className="check"><input type="checkbox" checked={keyOk} onChange={(e) => setKeyOk(e.target.checked)} disabled={!hostKey.hostKey} /> I compared the fingerprint and it matches</label>
                    </>
                  ) : <p>Berrie World never connects without a pinned host key.</p>}
                  <button type="button" disabled={!f.address || busy} onClick={() => void fetchKey()}>{hostKey ? 'Fetch again' : 'Fetch host key'}</button>
                </div>
              </div>
            </div>
          )}

          {!editingConfig && f.method === 'docker' && (
            <div className="form">
              <label>Read-only Docker API URL<input value={f.dockerUrl} onChange={(e) => set('dockerUrl', e.target.value)} placeholder="http://10.0.0.7:2375" /></label>
              <p className="small muted">Point this at a docker-socket-proxy that allows only GET on containers/events/info — never at an unrestricted Docker socket.</p>
            </div>
          )}
          {!editingConfig && f.method === 'manual' && (
            <div className="form">
              <label>Description<input value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={300} /></label>
              <label className="check"><input type="checkbox" checked={f.probe} onChange={(e) => set('probe', e.target.checked)} /> Check reachability with a TCP probe</label>
              {f.probe && <div className="row3"><label>Address<input value={f.address} onChange={(e) => set('address', e.target.value)} /></label><label>Port<input type="number" value={f.port} onChange={(e) => set('port', Number(e.target.value))} /></label></div>}
            </div>
          )}
          {!editingConfig && f.method === 'agent' && isNew && <p className="muted">After registering, you get a one-time agent token and installation steps.</p>}

          {preview && (
            <div className="preview">
              <h4>Discovery preview — nothing has been imported yet</h4>
              <ul className="steps-result">{preview.steps.map((s) => <li key={s.step} className={s.ok ? 'ok' : 'bad'}><Icon name={s.ok ? 'check' : 'x'} /> <b>{s.step}</b> — {s.detail}</li>)}</ul>
              {preview.facts && <FactsPreview facts={preview.facts} />}
              {preview.containers && (
                <details open={preview.containers.length <= 12}><summary>{preview.containers.length} containers would appear as buildings</summary>
                  <ul className="mini-list">{preview.containers.map((c) => <li key={c.id}><span className="dot" style={{ background: HEALTH_COLOR[c.health as keyof typeof HEALTH_COLOR] ?? '#888' }} />{c.project ? `${c.project}/` : ''}{c.name} <small>{c.state}</small></li>)}</ul>
                </details>
              )}
              {!preview.ok && isNew && <label className="check"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Import anyway (failing parts will show as unavailable)</label>}
            </div>
          )}

          <div className="row wiz-actions">
            {(f.method === 'ssh' || f.method === 'docker') && !editingConfig && <button disabled={busy || (f.method === 'ssh' && !keyOk)} onClick={() => void test()}><Icon name="activity" /> Test & preview</button>}
            <button className="primary" disabled={!canSave} onClick={() => void save()}>{isNew ? 'Register server' : 'Save changes'}</button>
            <button onClick={() => setEditing(null)}>Cancel</button>
            {needsTest && !preview && <span className="small muted">Run a test first — you will see exactly what would be imported.</span>}
          </div>
        </section>
      )}

      {archiving && (
        <section className="card danger-zone">
          <h3><Icon name="archive" /> Archive {archiving.name}?</h3>
          <p>Monitoring stops, the stored credential and agent token are deleted, and the island leaves the map. Its {archiving.services} service(s), events and history stay available in the archive. Nothing on the server itself is touched.</p>
          <label>Type <code>{archiving.id}</code> to confirm<input value={archiveConfirm} onChange={(e) => setArchiveConfirm(e.target.value)} /></label>
          <div className="row">
            <button className="danger" disabled={archiveConfirm !== archiving.id || busy} onClick={() => void run(async () => { await api(`/api/harbor/hosts/${archiving.id}/archive`, { method: 'POST', json: { confirm: archiveConfirm } }); setArchiving(null); setArchiveConfirm(''); setMsg({ ok: true, text: `${archiving.name} archived.` }); await load(); })}>Archive server</button>
            <button onClick={() => { setArchiving(null); setArchiveConfirm(''); }}>Cancel</button>
          </div>
        </section>
      )}

      <section className="card">
        <table className="table">
          <thead><tr><th>Server</th><th>Discovery</th><th>Status</th><th>Services</th><th>Last contact</th><th /></tr></thead>
          <tbody>
            {hosts.map((h) => (
              <tr key={h.id} className={h.status === 'archived' ? 'dim' : ''} onClick={() => { if (h.status !== 'archived') { setView('world'); select(h.entityId, true); } }}>
                <td>{h.name}<small className="mono">{h.id}{h.tags.length ? ` · ${h.tags.join(', ')}` : ''}</small></td>
                <td>{METHOD_INFO[h.method].title}{h.source === 'config' && <small>config file{h.agentConfigured ? ' + agent' : ''}</small>}{h.source === 'harbor' && h.agentConfigured && h.method !== 'agent' && <small>+ agent</small>}{h.hostKeyFingerprint && <small className="mono" title="Pinned SSH host key">{h.hostKeyFingerprint.slice(0, 22)}…</small>}</td>
                <td>
                  {h.status === 'active' && h.health && <span className="pill" style={{ '--c': HEALTH_COLOR[h.health as keyof typeof HEALTH_COLOR] } as React.CSSProperties}><span className="dot" />{h.health.replace('_', ' ')}</span>}
                  {h.status !== 'active' && <span className="inv incomplete">{h.status}</span>}
                  {h.lastError && h.status === 'active' && <small>{h.lastError}</small>}
                </td>
                <td>{h.services}</td>
                <td>{timeAgo(h.lastContactAt)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {h.status !== 'archived' && (
                    <div className="actions">
                      <button onClick={() => startEdit(h)}><Icon name="edit" /> Edit</button>
                      {h.status === 'active' && <button title="Re-run discovery now" onClick={() => void run(async () => { const r = await api<{ ok: boolean; error?: string }>(`/api/harbor/hosts/${h.id}/discover`, { method: 'POST' }); setMsg({ ok: r.ok, text: r.ok ? `Discovery for ${h.name} done.` : `Discovery failed: ${r.error}` }); await load(); })}><Icon name="restart" /></button>}
                      <button onClick={() => void run(async () => { await api(`/api/harbor/hosts/${h.id}/suspend`, { method: 'POST', json: { suspend: h.status === 'active' } }); await load(); })}>{h.status === 'active' ? 'Suspend' : 'Resume'}</button>
                      <button title={h.agentConfigured ? 'Rotate the agent token (the old one stops working)' : 'Add a push agent to this server'} onClick={() => { if (!h.agentConfigured || confirm(`Rotate the agent token for ${h.name}? The current agent stops working until you update its env file.`)) void run(async () => { const r = await api<{ token: string }>(`/api/harbor/hosts/${h.id}/agent-token`, { method: 'POST' }); setAgentToken(r.token); await load(); }); }}><Icon name="activity" /> {h.agentConfigured ? 'Rotate agent token' : 'Add agent'}</button>
                      {h.source === 'harbor' && <button className="danger" onClick={() => { setArchiving(h); setArchiveConfirm(''); }}><Icon name="archive" /></button>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <details className="card collector">
        <summary>Exactly what the collector runs (SSH and agent)</summary>
        <p className="small muted">Read-only, no root needed. Nothing you type is ever inserted into it.</p>
        <pre className="code">{collector}</pre>
      </details>
    </div>
  );
}
