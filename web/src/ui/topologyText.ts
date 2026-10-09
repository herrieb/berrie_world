import type { ImpactClass, Verification } from '@berrie/shared';

export const VERIFICATION_TEXT: Record<Verification, { label: string; help: string }> = {
  verified: { label: 'verified', help: 'Confirmed by a source that observes the real network state.' },
  configured: { label: 'configured', help: 'Declared in configuration (compose, gateway routes, config file); not measured.' },
  observed: { label: 'observed', help: 'Real traffic was reported between the two.' },
  inferred: { label: 'inferred', help: 'Plausible but not confirmed.' },
  unverified: { label: 'unverified', help: 'Not confirmed by any source.' },
};

export const IMPACT_TEXT: Record<ImpactClass, { label: string; color: string }> = {
  confirmed: { label: 'Confirmed failing', color: '#ef4b4b' },
  likely: { label: 'Likely affected', color: '#f2913d' },
  unknown: { label: 'Impact unknown', color: '#9aa3b5' },
  unaffected: { label: 'Verified fine', color: '#3fd17a' },
};
