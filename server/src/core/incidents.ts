import type { IncidentView, Severity, UserPrefs, WorldEvent } from '@berrie/shared';
import { DEFAULT_NOTIFICATIONS, inMaintenance } from '@berrie/shared';
import type { AppConfig } from '../config.js';
import type { EntityRow, Repo } from '../db/repo.js';
import type { IncidentRow } from '../db/ops.js';
import type { UserRow } from '../db/users.js';
import { causeHypotheses, impactOf } from './impact.js';
import { ownFailure } from './topology.js';
import type { World } from './world.js';

const FAILURE_EVENTS = new Set(['service.unhealthy', 'service.unreachable', 'host.offline']);
const RECOVERY_EVENTS = new Set(['service.recovered', 'service.healthy', 'host.online']);
const SEV_RANK: Record<Severity, number> = { info: 0, notice: 1, warning: 2, critical: 3 };

/** May this user see this entity? Same rule as the API (admins and all-server users see everything). */
export function userCanSee(u: UserRow, e: { hostId: string | null }): boolean {
  return u.role === 'admin' || u.hostScope === 'all' || e.hostId === null || u.hosts.includes(e.hostId);
}

/**
 * Turns real failure events into incidents:
 * - groups related failures (same host, or connected through known dependencies) into one incident
 * - suggests a cause only as a labelled hypothesis
 * - respects maintenance windows (no incident/notification; raw health untouched)
 * - moves to "monitoring" when everything recovered; a person confirms recovery to resolve
 */
export class IncidentEngine {
  private activeWindows = new Set<string>();

  constructor(private readonly cfg: AppConfig, private readonly repo: Repo, private readonly world: World) {
    world.subscribe({ event: (ev) => this.onEvent(ev) });
  }

  view(i: IncidentRow): IncidentView {
    const assignee = i.assignee ? this.repo.users.get(i.assignee) : undefined;
    return {
      id: i.id, title: i.title, status: i.status, severity: i.severity, rootEntityId: i.rootEntityId, hypothesis: i.hypothesis,
      hypothesisEntityId: i.hypothesisEntityId, hypothesisVerified: i.hypothesisVerified,
      assignee: assignee ? { id: assignee.id, name: assignee.status === 'deleted' ? '(removed user)' : assignee.displayName } : null,
      createdBy: i.createdBy, openedAt: i.openedAt, recoveredAt: i.recoveredAt, resolvedAt: i.resolvedAt, resolvedBy: i.resolvedBy,
      entities: this.repo.ops.incidentEntities(i.id),
    };
  }

  push(id: string): void {
    const i = this.repo.ops.incident(id);
    if (i) this.world.publishOps({ t: 'incident', data: this.view(i) });
  }

  private name(id: string | null): string {
    if (!id) return 'unknown';
    const e = this.repo.getEntity(id);
    return e?.displayName ?? e?.name ?? id;
  }

  private onEvent(ev: WorldEvent): void {
    try {
      if (ev.entityId && FAILURE_EVENTS.has(ev.type)) this.failure(ev.entityId, ev);
      else if (ev.entityId && RECOVERY_EVENTS.has(ev.type)) this.recovery(ev.entityId);
    } catch {
      /* incident bookkeeping must never break discovery */
    }
  }

  private failure(entityId: string, ev: WorldEvent): void {
    const e = this.repo.getEntity(entityId);
    if (!e || e.kind === 'project' || e.lifecycle === 'removed' || e.lifecycle === 'archived') return;
    const w = inMaintenance(this.repo.ops.maintenance(), e);
    if (w?.suppress) return; // planned work: no incident or notification (the health change itself is still recorded)
    const active = this.repo.ops.activeFor(e.id);
    if (active.length) {
      for (const i of active.filter((x) => x.status === 'monitoring')) {
        this.repo.ops.updateIncident(i.id, { status: 'open', recoveredAt: null });
        this.repo.ops.addTimeline(i.id, 'regressed', 'system', null, `${this.name(e.id)} failed again (${ev.details.to ?? ev.type})`);
        this.push(i.id);
      }
      return;
    }
    const group = this.findGroup(e);
    if (group) {
      this.repo.ops.addIncidentEntity(group.id, e.id, 'affected');
      this.repo.ops.addTimeline(group.id, 'added', 'system', null, `${this.name(e.id)} is also failing: ${ev.details.reason ?? ev.details.to ?? ev.type}`);
      if (SEV_RANK[ev.severity] > SEV_RANK[group.severity]) this.repo.ops.updateIncident(group.id, { severity: ev.severity });
      this.refreshHypothesis(group.id);
      this.push(group.id);
      return;
    }
    const severity: Severity = ev.type === 'host.offline' ? 'critical' : 'warning';
    const what = ev.type === 'host.offline' ? 'is offline' : ev.type === 'service.unreachable' ? 'is unreachable' : 'is unhealthy';
    const inc = this.repo.ops.createIncident({ title: `${this.name(e.id)} ${what}`, status: 'open', severity, rootEntityId: e.id, hypothesis: null, hypothesisEntityId: null, assignee: null, createdBy: 'system' });
    this.repo.ops.addIncidentEntity(inc.id, e.id, 'affected');
    this.repo.ops.addTimeline(inc.id, 'opened', 'system', null, `${this.name(e.id)} ${what}: ${ev.details.reason ?? ''}`.trim(), { event: ev.id });
    this.refreshHypothesis(inc.id);
    this.world.emit({ type: 'incident.opened', entityId: e.id, source: 'incidents', severity, details: { incident: inc.id, title: inc.title } });
    this.push(inc.id);
    this.notify(inc.id, severity, `Incident: ${inc.title}`, String(ev.details.reason ?? ''), e);
  }

  /** An open incident this failure belongs to: same host outage, or connected through known reliance. */
  private findGroup(e: EntityRow): IncidentRow | null {
    const open = this.repo.ops.incidents({ status: ['open', 'monitoring'] });
    for (const i of open) {
      const ids = this.repo.ops.incidentEntities(i.id).map((x) => x.entityId);
      if (e.hostId && ids.includes(e.hostId)) return i; // host incident absorbs its services
      for (const id of ids) {
        const affected = this.repo.getEntity(id);
        if (affected?.kind === 'host' && e.hostId === affected.id) return i;
        if (impactOf(this.cfg, this.repo, id, true).items.some((x) => x.entityId === e.id)) return i; // e relies on something already failing
        if (impactOf(this.cfg, this.repo, e.id, true).items.some((x) => x.entityId === id)) return i; // something failing relies on e
      }
    }
    return null;
  }

  private refreshHypothesis(id: string): void {
    const inc = this.repo.ops.incident(id);
    if (!inc || inc.hypothesisVerified) return; // a person confirmed the cause; do not overwrite it
    const failing = this.repo.ops.incidentEntities(id).map((x) => x.entityId).filter((x) => { const e = this.repo.getEntity(x); return e && ownFailure(e, this.repo); });
    const best = causeHypotheses(this.cfg, this.repo, failing)[0];
    if (!best || failing.length < 2 || best.entityId === inc.hypothesisEntityId) return;
    this.repo.ops.updateIncident(id, { hypothesis: best.reasoning, hypothesisEntityId: best.entityId });
    this.repo.ops.addIncidentEntity(id, best.entityId, 'suspected');
    this.repo.ops.addTimeline(id, 'hypothesis', 'system', null, `Hypothesis (not verified): ${best.reasoning}`, { entity: best.entityId });
  }

  private recovery(entityId: string): void {
    for (const i of this.repo.ops.activeFor(entityId)) this.checkRecovered(i);
  }

  private checkRecovered(i: IncidentRow): void {
    if (i.status !== 'open') return;
    const ids = this.repo.ops.incidentEntities(i.id).filter((x) => x.role === 'affected').map((x) => x.entityId);
    const still = ids.filter((id) => { const e = this.repo.getEntity(id); return e && e.lifecycle !== 'removed' && e.lifecycle !== 'archived' && ownFailure(e, this.repo); });
    if (still.length) return;
    this.repo.ops.updateIncident(i.id, { status: 'monitoring', recoveredAt: this.repo.now() });
    this.repo.ops.addTimeline(i.id, 'recovered', 'system', null, 'All affected items report healthy again — waiting for someone to confirm recovery');
    this.world.emit({ type: 'incident.recovered', entityId: i.rootEntityId, source: 'incidents', severity: 'notice', details: { incident: i.id, title: i.title } });
    this.push(i.id);
    const root = i.rootEntityId ? this.repo.getEntity(i.rootEntityId) : undefined;
    if (root) this.notify(i.id, 'notice', `Recovered: ${i.title}`, 'Confirm recovery to resolve the incident.', root);
  }

  /** Periodic pass: catch recoveries without an event and maintenance start/end. */
  tick(): void {
    for (const i of this.repo.ops.incidents({ status: ['open'] })) this.checkRecovered(i);
    const now = Date.now();
    for (const w of this.repo.ops.maintenance(true)) {
      const active = !w.cancelledAt && Date.parse(w.startsAt) <= now && now < Date.parse(w.endsAt);
      if (active && !this.activeWindows.has(w.id)) {
        this.activeWindows.add(w.id);
        this.world.emit({ type: 'maintenance.started', entityId: w.entityIds[0] ?? null, source: 'maintenance', severity: 'info', details: { window: w.id, title: w.title } });
        this.world.publishOps({ t: 'maintenance', data: w });
      } else if (!active && this.activeWindows.has(w.id)) {
        this.activeWindows.delete(w.id);
        this.world.emit({ type: 'maintenance.ended', entityId: w.entityIds[0] ?? null, source: 'maintenance', severity: 'info', details: { window: w.id, title: w.title } });
        this.world.publishOps({ t: 'maintenance', data: w });
      }
    }
  }

  /** Personal notifications, per the user's own preferences and only for what they may see. */
  private notify(incidentId: string, severity: Severity, title: string, text: string, e: EntityRow): void {
    for (const u of this.repo.users.list()) {
      if (u.status !== 'active' || !userCanSee(u, e)) continue;
      const prefs = (this.repo.users.getPrefs(u.id) as UserPrefs).notifications ?? DEFAULT_NOTIFICATIONS;
      if (!prefs.inApp || SEV_RANK[severity] < SEV_RANK[prefs.minSeverity]) continue;
      if (prefs.favoritesOnly) {
        const fav = this.repo.users.favorites(u.id);
        if (!fav.includes(e.id) && !(e.hostId && fav.includes(e.hostId))) continue;
      }
      const n = this.repo.ops.notify(u.id, { severity, title, text: text || null, entityId: e.id, incidentId });
      this.world.publishOps({ t: 'notification', data: n, userId: u.id });
    }
  }
}
