import type { RecordRef } from './refs.js';

export const SIGNAL_SEVERITIES = ['info', 'warn', 'risk'] as const;
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];

/** A fact computed from records. The score reads these. The model explains them. */
export interface Signal {
  key: string;
  value: number | string | boolean | null;
  unit?: string;
  severity: SignalSeverity;
  evidence: RecordRef[];
  explanation: string;
}

export const SIGNAL_KEYS = {
  daysSinceLastTouch: 'days_since_last_touch',
  daysToRenewal: 'days_to_renewal',
  openHighTickets: 'open_high_tickets',
  openMediumTickets: 'open_medium_tickets',
  openLowTickets: 'open_low_tickets',
  ticketTrendRatio: 'ticket_trend_ratio',
  usageRatio: 'usage_ratio',
  missingUsageData: 'missing_usage_data',
  championLeft: 'champion_left',
  budgetRiskLanguage: 'budget_risk_language',
  negativeSentiment: 'negative_sentiment',
  meetingBooked: 'meeting_booked',
  dealStageRegression: 'deal_stage_regression',
  highUsageQuietOk: 'high_usage_quiet_ok',
} as const;

export function signalMap(signals: Signal[]): Map<string, Signal> {
  return new Map(signals.map((signal) => [signal.key, signal]));
}
